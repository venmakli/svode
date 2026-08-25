use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::ResolvedRoutineOwner;
use super::model::{
    CollectionEvent, EventMatch, MissedRuns, RoutineAction, RoutineActionTarget,
    RoutineCatalogSnapshot, RoutineDefinition, RoutineDiagnostic, RoutineNameConflictProjection,
    RoutineOwnerKind, RoutineRow, RoutineTrigger,
};

pub(crate) const MAX_ROUTINE_BYTES: u64 = 1024 * 1024;
const MAX_ROUTINES_PER_OWNER: usize = 512;
const MAX_DIAGNOSTICS: usize = 128;
const MAX_DIAGNOSTIC_MESSAGE_CHARS: usize = 512;

#[derive(Debug, Clone)]
pub(crate) struct ParsedRoutine {
    pub definition: Option<RoutineDefinition>,
    pub portable_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub diagnostics: Vec<RoutineDiagnostic>,
}

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredRoutineFile {
    pub filename: String,
    pub fingerprint: String,
    pub parsed: ParsedRoutine,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutineDirectoryScan {
    pub files: Vec<DiscoveredRoutineFile>,
    pub diagnostics: Vec<RoutineDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoutineFrontmatter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    trigger: PortableRoutineTrigger,
    action: PortableRoutineAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum PortableRoutineTrigger {
    Manual,
    Schedule {
        cron: String,
        timezone: String,
        missed_runs: MissedRuns,
    },
    Event {
        event: CollectionEvent,
        #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
        match_: Option<EventMatch>,
    },
}

impl From<PortableRoutineTrigger> for RoutineTrigger {
    fn from(value: PortableRoutineTrigger) -> Self {
        match value {
            PortableRoutineTrigger::Manual => Self::Manual,
            PortableRoutineTrigger::Schedule {
                cron,
                timezone,
                missed_runs,
            } => Self::Schedule {
                cron,
                timezone,
                missed_runs,
            },
            PortableRoutineTrigger::Event { event, match_ } => Self::Event { event, match_ },
        }
    }
}

impl From<&RoutineTrigger> for PortableRoutineTrigger {
    fn from(value: &RoutineTrigger) -> Self {
        match value {
            RoutineTrigger::Manual => Self::Manual,
            RoutineTrigger::Schedule {
                cron,
                timezone,
                missed_runs,
            } => Self::Schedule {
                cron: cron.clone(),
                timezone: timezone.clone(),
                missed_runs: *missed_runs,
            },
            RoutineTrigger::Event { event, match_ } => Self::Event {
                event: *event,
                match_: match_.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum PortableRoutineAction {
    RunAgent {
        executor: String,
    },
    UpdateProperties {
        target: RoutineActionTarget,
        set: BTreeMap<String, serde_json::Value>,
    },
}

impl From<PortableRoutineAction> for RoutineAction {
    fn from(value: PortableRoutineAction) -> Self {
        match value {
            PortableRoutineAction::RunAgent { executor } => Self::RunAgent { executor },
            PortableRoutineAction::UpdateProperties { target, set } => {
                Self::UpdateProperties { target, set }
            }
        }
    }
}

impl From<&RoutineAction> for PortableRoutineAction {
    fn from(value: &RoutineAction) -> Self {
        match value {
            RoutineAction::RunAgent { executor } => Self::RunAgent {
                executor: executor.clone(),
            },
            RoutineAction::UpdateProperties { target, set } => Self::UpdateProperties {
                target: *target,
                set: set.clone(),
            },
        }
    }
}

pub(crate) fn parse_routine(
    raw: &str,
    filename: &str,
    owner_kind: RoutineOwnerKind,
) -> ParsedRoutine {
    let fallback = filename.strip_suffix(".md").unwrap_or(filename).to_string();
    let (yaml, body) = match split_frontmatter(raw) {
        Ok(parts) => parts,
        Err(diagnostic) => {
            return ParsedRoutine {
                definition: None,
                portable_id: None,
                name: fallback,
                description: None,
                diagnostics: vec![diagnostic],
            };
        }
    };

    let frontmatter: RoutineFrontmatter = match serde_yml::from_str(yaml) {
        Ok(frontmatter) => frontmatter,
        Err(error) => {
            return ParsedRoutine {
                definition: None,
                portable_id: None,
                name: fallback,
                description: None,
                diagnostics: vec![RoutineDiagnostic::new(
                    "routine_frontmatter_invalid",
                    bounded_message(format!("invalid routine YAML/frontmatter shape: {error}")),
                )],
            };
        }
    };

    let portable_id = frontmatter.id.filter(|id| is_lowercase_ulid(id));
    let definition = RoutineDefinition {
        name: frontmatter.name,
        description: frontmatter.description,
        enabled: frontmatter.enabled,
        trigger: frontmatter.trigger.into(),
        action: frontmatter.action.into(),
        body: body.to_string(),
    };
    let name = definition
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&fallback)
        .to_string();
    let description = definition.description.clone();
    let mut diagnostics = validate_definition(&definition, owner_kind);
    if portable_id.is_none() {
        diagnostics.push(
            RoutineDiagnostic::new("routine_id_invalid", "id must be a lowercase ULID").field("id"),
        );
    }
    ParsedRoutine {
        definition: Some(definition),
        portable_id,
        name,
        description,
        diagnostics,
    }
}

pub(crate) fn validate_definition(
    definition: &RoutineDefinition,
    owner_kind: RoutineOwnerKind,
) -> Vec<RoutineDiagnostic> {
    let mut diagnostics = Vec::new();
    if definition
        .name
        .as_ref()
        .is_some_and(|name| name.trim().is_empty() || name.chars().count() > 240)
    {
        diagnostics.push(
            RoutineDiagnostic::new(
                "routine_name_invalid",
                "name must be non-empty when supplied and at most 240 characters",
            )
            .field("name"),
        );
    }
    if definition
        .description
        .as_ref()
        .is_some_and(|description| description.chars().count() > 2_000)
    {
        diagnostics.push(
            RoutineDiagnostic::new(
                "routine_description_too_long",
                "description must be at most 2000 characters",
            )
            .field("description"),
        );
    }
    if definition.body.len() as u64 > MAX_ROUTINE_BYTES {
        diagnostics.push(
            RoutineDiagnostic::new(
                "routine_body_too_large",
                "routine Markdown body exceeds the 1 MiB definition limit",
            )
            .field("body"),
        );
    }

    match &definition.trigger {
        RoutineTrigger::Manual => {
            if definition.enabled.is_some() {
                diagnostics.push(
                    RoutineDiagnostic::new(
                        "routine_enabled_not_applicable",
                        "enabled is only supported for schedule and event triggers",
                    )
                    .field("enabled"),
                );
            }
            if !matches!(definition.action, RoutineAction::RunAgent { .. }) {
                diagnostics.push(incompatible_action("manual", "run_agent"));
            }
        }
        RoutineTrigger::Schedule { cron, timezone, .. } => {
            if let Err(message) = super::schedule::validate_cron(cron) {
                diagnostics.push(
                    RoutineDiagnostic::new("routine_cron_invalid", message).field("trigger.cron"),
                );
            }
            if let Err(message) = super::schedule::validate_timezone(timezone) {
                diagnostics.push(
                    RoutineDiagnostic::new("routine_timezone_invalid", message)
                        .field("trigger.timezone"),
                );
            }
            if !matches!(definition.action, RoutineAction::RunAgent { .. }) {
                diagnostics.push(incompatible_action("schedule", "run_agent"));
            }
        }
        RoutineTrigger::Event { event, match_ } => {
            if owner_kind != RoutineOwnerKind::Collection {
                diagnostics.push(
                    RoutineDiagnostic::new(
                        "routine_event_owner_invalid",
                        "event triggers require a Collection owner",
                    )
                    .field("trigger.type"),
                );
            }
            match event {
                CollectionEvent::FieldChanged => {
                    if match_
                        .as_ref()
                        .is_none_or(|matcher| matcher.field.trim().is_empty())
                    {
                        diagnostics.push(
                            RoutineDiagnostic::new(
                                "routine_event_match_field_required",
                                "collection.field_changed requires match.field",
                            )
                            .field("trigger.match.field"),
                        );
                    }
                }
                CollectionEvent::EntryCreated | CollectionEvent::EntryDeleted => {
                    if match_.is_some() {
                        diagnostics.push(
                            RoutineDiagnostic::new(
                                "routine_event_match_not_applicable",
                                "match is only supported for collection.field_changed",
                            )
                            .field("trigger.match"),
                        );
                    }
                }
            }
            match (&definition.action, event) {
                (RoutineAction::RunAgent { .. }, _) => {}
                (RoutineAction::UpdateProperties { .. }, CollectionEvent::EntryCreated)
                | (RoutineAction::UpdateProperties { .. }, CollectionEvent::FieldChanged) => {}
                (RoutineAction::UpdateProperties { .. }, CollectionEvent::EntryDeleted) => {
                    diagnostics.push(incompatible_action("collection.entry_deleted", "run_agent"));
                }
            }
        }
    }

    match &definition.action {
        RoutineAction::RunAgent { executor } => {
            if !valid_executor(executor) {
                diagnostics.push(
                    RoutineDiagnostic::new(
                        "routine_executor_invalid",
                        "run_agent requires executor agent:<lowercase-ulid>",
                    )
                    .field("action.executor"),
                );
            }
        }
        RoutineAction::UpdateProperties { set, .. } => {
            if set.is_empty() {
                diagnostics.push(
                    RoutineDiagnostic::new(
                        "routine_property_set_empty",
                        "update_properties.set must contain at least one property",
                    )
                    .field("action.set"),
                );
            }
            for field in set.keys() {
                if field.trim().is_empty() {
                    diagnostics.push(
                        RoutineDiagnostic::new(
                            "routine_property_key_invalid",
                            "update_properties.set keys must be non-empty",
                        )
                        .field("action.set"),
                    );
                }
            }
        }
    }

    diagnostics.truncate(MAX_DIAGNOSTICS);
    diagnostics
}

fn incompatible_action(trigger: &str, allowed: &str) -> RoutineDiagnostic {
    RoutineDiagnostic::new(
        "routine_trigger_action_incompatible",
        format!("{trigger} trigger only supports {allowed}"),
    )
    .field("action.type")
}

fn valid_executor(value: &str) -> bool {
    let Some(id) = value.strip_prefix("agent:") else {
        return false;
    };
    id.len() == 26
        && id == id.to_ascii_lowercase()
        && ulid::Ulid::from_string(&id.to_ascii_uppercase()).is_ok()
}

pub(crate) fn scan_routine_directory(
    owner_root: &Path,
    owner_kind: RoutineOwnerKind,
) -> RoutineDirectoryScan {
    let directory = owner_root.join(".routines");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RoutineDirectoryScan::default();
        }
        Err(error) => {
            return RoutineDirectoryScan {
                files: Vec::new(),
                diagnostics: vec![
                    RoutineDiagnostic::new(
                        "routine_catalog_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(".routines"),
                ],
            };
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return RoutineDirectoryScan {
            files: Vec::new(),
            diagnostics: vec![
                RoutineDiagnostic::new(
                    "routine_catalog_unsafe",
                    ".routines must be a regular directory, not a symlink",
                )
                .path(".routines"),
            ],
        };
    }
    let canonical_owner = match fs::canonicalize(owner_root) {
        Ok(path) => path,
        Err(error) => {
            return RoutineDirectoryScan {
                files: Vec::new(),
                diagnostics: vec![RoutineDiagnostic::new(
                    "routine_owner_unavailable",
                    bounded_message(error.to_string()),
                )],
            };
        }
    };
    let canonical_directory = match fs::canonicalize(&directory) {
        Ok(path) if path.starts_with(&canonical_owner) => path,
        Ok(_) => {
            return RoutineDirectoryScan {
                files: Vec::new(),
                diagnostics: vec![
                    RoutineDiagnostic::new(
                        "routine_catalog_unsafe",
                        ".routines resolves outside its owner",
                    )
                    .path(".routines"),
                ],
            };
        }
        Err(error) => {
            return RoutineDirectoryScan {
                files: Vec::new(),
                diagnostics: vec![
                    RoutineDiagnostic::new(
                        "routine_catalog_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(".routines"),
                ],
            };
        }
    };
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => {
            return RoutineDirectoryScan {
                files: Vec::new(),
                diagnostics: vec![
                    RoutineDiagnostic::new(
                        "routine_catalog_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(".routines"),
                ],
            };
        }
    };

    let mut scan = RoutineDirectoryScan::default();
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(".routines"),
                );
                continue;
            }
        };
        let Some(filename) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            push_diagnostic(
                &mut scan.diagnostics,
                RoutineDiagnostic::new(
                    "routine_filename_invalid",
                    "routine filenames must be valid UTF-8",
                )
                .path(".routines"),
            );
            continue;
        };
        if !filename.ends_with(".md") {
            continue;
        }
        candidates.push((filename, entry.path()));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    if candidates.len() > MAX_ROUTINES_PER_OWNER {
        push_diagnostic(
            &mut scan.diagnostics,
            RoutineDiagnostic::new(
                "routine_catalog_limit_exceeded",
                format!(
                    "only the first {MAX_ROUTINES_PER_OWNER} sorted routine definitions are read"
                ),
            )
            .path(".routines"),
        );
        candidates.truncate(MAX_ROUTINES_PER_OWNER);
    }

    for (filename, path) in candidates {
        let rel_path = format!(".routines/{filename}");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(rel_path),
                );
                continue;
            }
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_ROUTINE_BYTES
        {
            push_diagnostic(
                &mut scan.diagnostics,
                RoutineDiagnostic::new(
                    "routine_file_unsafe",
                    "routine must be a non-symlink regular UTF-8 file no larger than 1 MiB",
                )
                .path(rel_path),
            );
            continue;
        }
        let canonical = match fs::canonicalize(&path) {
            Ok(canonical) if canonical.starts_with(&canonical_directory) => canonical,
            Ok(_) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_unsafe",
                        "routine resolves outside its .routines directory",
                    )
                    .path(rel_path),
                );
                continue;
            }
            Err(error) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(rel_path),
                );
                continue;
            }
        };
        let bytes = match fs::read(&canonical) {
            Ok(bytes) => bytes,
            Err(error) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_unavailable",
                        bounded_message(error.to_string()),
                    )
                    .path(rel_path),
                );
                continue;
            }
        };
        let raw = match std::str::from_utf8(&bytes) {
            Ok(raw) => raw,
            Err(error) => {
                push_diagnostic(
                    &mut scan.diagnostics,
                    RoutineDiagnostic::new(
                        "routine_file_not_utf8",
                        bounded_message(error.to_string()),
                    )
                    .path(rel_path),
                );
                continue;
            }
        };
        scan.files.push(DiscoveredRoutineFile {
            filename: filename.clone(),
            fingerprint: fingerprint(&bytes),
            parsed: parse_routine(raw, &filename, owner_kind),
        });
    }
    scan
}

pub(crate) fn discover_owner(owner: &ResolvedRoutineOwner) -> RoutineCatalogSnapshot {
    let scan = scan_routine_directory(&owner.owner_root, owner.descriptor.kind);
    let mut routines = scan
        .files
        .into_iter()
        .map(|file| row_from_file(owner, file))
        .collect::<Vec<_>>();
    let id_counts = routines
        .iter()
        .filter_map(|row| row.portable_id.clone())
        .fold(HashMap::<String, usize>::new(), |mut counts, id| {
            *counts.entry(id).or_default() += 1;
            counts
        });
    for row in &mut routines {
        if row
            .portable_id
            .as_deref()
            .is_some_and(|id| id_counts.get(id).copied().unwrap_or_default() > 1)
        {
            row.routine_id = None;
            row.diagnostics.push(
                RoutineDiagnostic::new(
                    "routine_id_duplicate",
                    "id must be unique inside the exact Routine owner",
                )
                .field("id")
                .path(row.path.clone()),
            );
        }
    }
    let name_groups = routines.iter().enumerate().fold(
        BTreeMap::<String, Vec<usize>>::new(),
        |mut groups, (index, row)| {
            groups
                .entry(crate::files::naming::display_name_key(&row.name))
                .or_default()
                .push(index);
            groups
        },
    );
    for indices in name_groups.values().filter(|indices| indices.len() > 1) {
        let paths = indices
            .iter()
            .map(|index| routines[*index].path.clone())
            .collect::<Vec<_>>();
        for index in indices {
            let current_path = &routines[*index].path;
            routines[*index].name_conflict = Some(RoutineNameConflictProjection {
                conflicting_paths: paths
                    .iter()
                    .filter(|path| *path != current_path)
                    .cloned()
                    .collect(),
            });
        }
    }
    let catalog_fingerprint = catalog_fingerprint(&routines, &scan.diagnostics);
    RoutineCatalogSnapshot {
        owner: owner.descriptor.clone(),
        routines,
        diagnostics: scan.diagnostics,
        catalog_fingerprint,
        refreshed_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn row_from_file(owner: &ResolvedRoutineOwner, file: DiscoveredRoutineFile) -> RoutineRow {
    let routine_id = file
        .parsed
        .portable_id
        .as_deref()
        .map(|portable_id| routine_id(&owner.identity(), portable_id));
    let owner_path = &owner.descriptor.owner_path;
    let path = if owner_path == "." {
        format!(".routines/{}", file.filename)
    } else {
        format!("{owner_path}/.routines/{}", file.filename)
    };
    let definition = file.parsed.definition;
    let execution_fingerprint = definition
        .as_ref()
        .map(execution_fingerprint)
        .unwrap_or_else(|| file.fingerprint.clone());
    let (enabled, trigger_type, trigger_summary, action_type, action_summary, executor) =
        definition
            .as_ref()
            .map(|definition| {
                let enabled = match definition.trigger {
                    RoutineTrigger::Manual => None,
                    RoutineTrigger::Schedule { .. } | RoutineTrigger::Event { .. } => {
                        Some(definition.enabled.unwrap_or(false))
                    }
                };
                (
                    enabled,
                    Some(definition.trigger.kind()),
                    Some(trigger_summary(&definition.trigger)),
                    Some(definition.action.kind()),
                    Some(action_summary(&definition.action)),
                    definition.action.executor().map(ToOwned::to_owned),
                )
            })
            .unwrap_or((None, None, None, None, None, None));
    RoutineRow {
        routine_id,
        portable_id: file.parsed.portable_id,
        filename: file.filename,
        path: path.clone(),
        name: file.parsed.name,
        name_conflict: None,
        description: file.parsed.description,
        enabled,
        trigger_type,
        trigger_summary,
        action_type,
        action_summary,
        executor,
        last_run_at: None,
        last_run_origin: None,
        next_run_at: None,
        last_run: None,
        fingerprint: file.fingerprint,
        execution_fingerprint,
        definition,
        diagnostics: file
            .parsed
            .diagnostics
            .into_iter()
            .map(|diagnostic| diagnostic.path(path.clone()))
            .collect(),
    }
}

fn trigger_summary(trigger: &RoutineTrigger) -> String {
    match trigger {
        RoutineTrigger::Manual => "manual".to_string(),
        RoutineTrigger::Schedule { cron, timezone, .. } => format!("schedule: {cron} ({timezone})"),
        RoutineTrigger::Event { event, .. } => event.as_str().to_string(),
    }
}

fn action_summary(action: &RoutineAction) -> String {
    match action {
        RoutineAction::RunAgent { .. } => "run_agent".to_string(),
        RoutineAction::UpdateProperties { set, .. } => {
            format!("update_properties: {} fields", set.len())
        }
    }
}

pub(crate) fn serialize_definition(
    definition: &RoutineDefinition,
    portable_id: &str,
) -> Result<String, String> {
    let frontmatter = RoutineFrontmatter {
        id: Some(portable_id.to_string()),
        name: definition.name.clone(),
        description: definition.description.clone(),
        enabled: definition.enabled,
        trigger: PortableRoutineTrigger::from(&definition.trigger),
        action: PortableRoutineAction::from(&definition.action),
    };
    let yaml = serde_yml::to_string(&frontmatter).map_err(|error| error.to_string())?;
    Ok(format!("---\n{yaml}---\n{}", definition.body))
}

fn split_frontmatter(raw: &str) -> Result<(&str, &str), RoutineDiagnostic> {
    let bytes = raw.as_bytes();
    let first_newline = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| {
            RoutineDiagnostic::new(
                "routine_frontmatter_missing",
                "routine must start with YAML frontmatter",
            )
        })?;
    if raw[..first_newline].trim_end_matches('\r') != "---" {
        return Err(RoutineDiagnostic::new(
            "routine_frontmatter_missing",
            "routine must start with YAML frontmatter",
        ));
    }
    let yaml_start = first_newline + 1;
    let mut line_start = yaml_start;
    while line_start <= raw.len() {
        let line_end = raw[line_start..]
            .find('\n')
            .map(|offset| line_start + offset)
            .unwrap_or(raw.len());
        if raw[line_start..line_end].trim_end_matches('\r') == "---" {
            let body_start = if line_end < raw.len() {
                line_end + 1
            } else {
                line_end
            };
            return Ok((&raw[yaml_start..line_start], &raw[body_start..]));
        }
        if line_end == raw.len() {
            break;
        }
        line_start = line_end + 1;
    }
    Err(RoutineDiagnostic::new(
        "routine_frontmatter_malformed",
        "missing closing YAML frontmatter delimiter",
    ))
}

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    format!(
        "{:016x}",
        bytes.iter().fold(0xcbf29ce484222325u64, |hash, byte| (hash
            ^ u64::from(*byte))
        .wrapping_mul(0x100000001b3))
    )
}

fn routine_id(owner_identity: &str, portable_id: &str) -> String {
    let value = format!("{owner_identity}\0{portable_id}");
    format!("routine:{}", fingerprint(value.as_bytes()))
}

pub(crate) fn execution_fingerprint(definition: &RoutineDefinition) -> String {
    #[derive(Serialize)]
    struct ExecutionDefinition<'a> {
        enabled: Option<bool>,
        trigger: &'a super::model::RoutineTrigger,
        action: &'a super::model::RoutineAction,
        body: &'a str,
    }

    let bytes = serde_json::to_vec(&ExecutionDefinition {
        enabled: definition.enabled,
        trigger: &definition.trigger,
        action: &definition.action,
        body: &definition.body,
    })
    .expect("Routine execution definition is serializable");
    fingerprint(&bytes)
}

fn is_lowercase_ulid(value: &str) -> bool {
    value.len() == 26
        && value == value.to_ascii_lowercase()
        && ulid::Ulid::from_string(&value.to_ascii_uppercase()).is_ok()
}

pub(crate) fn catalog_fingerprint(
    rows: &[RoutineRow],
    diagnostics: &[RoutineDiagnostic],
) -> String {
    let mut value = String::new();
    for row in rows {
        value.push_str(row.routine_id.as_deref().unwrap_or_default());
        value.push('\0');
        value.push_str(&row.path);
        value.push('\0');
        value.push_str(&row.fingerprint);
        value.push('\0');
    }
    for diagnostic in diagnostics {
        value.push_str(&diagnostic.code);
        value.push('\0');
        value.push_str(diagnostic.path.as_deref().unwrap_or_default());
        value.push('\0');
    }
    fingerprint(value.as_bytes())
}

fn bounded_message(message: impl AsRef<str>) -> String {
    message
        .as_ref()
        .chars()
        .take(MAX_DIAGNOSTIC_MESSAGE_CHARS)
        .collect()
}

fn push_diagnostic(diagnostics: &mut Vec<RoutineDiagnostic>, diagnostic: RoutineDiagnostic) {
    if diagnostics.len() < MAX_DIAGNOSTICS {
        diagnostics.push(diagnostic);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexKey;
    use crate::routines::model::RoutineOwnerDescriptor;

    const ACTOR: &str = "agent:01arz3ndektsv4rrffq69g5fav";
    const ID: &str = "01arz3ndektsv4rrffq69g5fav";

    fn valid_manual() -> String {
        format!(
            "---\nid: {ID}\nname: Test\ntrigger:\n  type: manual\naction:\n  type: run_agent\n  executor: {ACTOR}\n---\nBody\n"
        )
    }

    fn owner(root: &Path) -> ResolvedRoutineOwner {
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root".into(),
                owner_path: ".".into(),
            },
            project_path: root.into(),
            space_path: root.into(),
            owner_root: root.into(),
            index_key: IndexKey::Root(root.into()),
        }
    }

    #[test]
    fn parses_formats_and_preserves_markdown_body() {
        let parsed = parse_routine(&valid_manual(), "same.md", RoutineOwnerKind::Space);
        let definition = parsed.definition.expect("typed definition");
        assert_eq!(definition.name.as_deref(), Some("Test"));
        assert_eq!(definition.body, "Body\n");
        assert!(parsed.diagnostics.is_empty());
    }

    #[test]
    fn missing_and_malformed_frontmatter_are_discoverable() {
        let missing = parse_routine("Body", "fallback.md", RoutineOwnerKind::Space);
        assert!(missing.definition.is_none());
        assert_eq!(missing.name, "fallback");
        assert_eq!(missing.diagnostics[0].code, "routine_frontmatter_missing");

        let malformed = parse_routine("---\ntrigger: [\n---\n", "bad.md", RoutineOwnerKind::Space);
        assert!(malformed.definition.is_none());
        assert_eq!(malformed.diagnostics[0].code, "routine_frontmatter_invalid");
    }

    #[test]
    fn validates_trigger_action_matrix_and_event_owner() {
        let raw = format!(
            "---\nid: {ID}\nname: Test\ntrigger:\n  type: event\n  event: collection.entry_deleted\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    done: true\n---\n"
        );
        let parsed = parse_routine(&raw, "bad.md", RoutineOwnerKind::Space);
        assert!(parsed.definition.is_some());
        let codes = parsed
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"routine_event_owner_invalid"));
        assert!(codes.contains(&"routine_trigger_action_incompatible"));
    }

    #[test]
    fn validates_schedule_shape_and_explicit_executor() {
        let raw = format!(
            "---\nid: {ID}\nname: Test\ntrigger:\n  type: schedule\n  cron: '* * *'\n  timezone: local\n  missed_runs: skip\naction:\n  type: run_agent\n  executor: ''\n---\n"
        );
        let parsed = parse_routine(&raw, "schedule.md", RoutineOwnerKind::Space);
        assert!(parsed.definition.is_some());
        assert_eq!(parsed.diagnostics.len(), 3);
    }

    #[test]
    fn portable_yaml_and_ipc_use_their_respective_field_conventions() {
        let raw = format!(
            "---\nid: {ID}\nname: Schedule\ntrigger:\n  type: schedule\n  cron: '0 9 * * 1-5'\n  timezone: Europe/Paris\n  missed_runs: run_once\naction:\n  type: run_agent\n  executor: {ACTOR}\n---\n"
        );
        let definition = parse_routine(&raw, "schedule.md", RoutineOwnerKind::Space)
            .definition
            .expect("typed definition");
        let yaml = serialize_definition(&definition, ID).unwrap();
        assert!(yaml.contains(ID));
        assert!(yaml.contains("name: Schedule"));
        assert!(yaml.contains("missed_runs: run_once"));
        assert!(!yaml.contains("missedRuns"));

        let ipc = serde_json::to_value(&definition).unwrap();
        assert_eq!(ipc["trigger"]["missedRuns"], "run_once");
        assert!(ipc["trigger"].get("missed_runs").is_none());
    }

    #[test]
    fn property_values_preserve_json_compatible_structures() {
        let raw = format!(
            "---\nid: {ID}\nname: Properties\ntrigger:\n  type: event\n  event: collection.entry_created\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    labels: [one, two]\n    metadata:\n      source: routine\n---\n"
        );
        let definition = parse_routine(&raw, "properties.md", RoutineOwnerKind::Collection)
            .definition
            .expect("typed definition");
        let RoutineAction::UpdateProperties { set, .. } = definition.action else {
            panic!("expected update_properties");
        };
        assert_eq!(set["labels"], serde_json::json!(["one", "two"]));
        assert_eq!(set["metadata"], serde_json::json!({"source": "routine"}));
    }

    #[test]
    fn bounded_scan_rejects_symlink_and_oversized_md() {
        let temp = tempfile::tempdir().unwrap();
        let routines = temp.path().join(".routines");
        fs::create_dir_all(&routines).unwrap();
        fs::write(
            routines.join("large.md"),
            vec![b'x'; MAX_ROUTINE_BYTES as usize + 1],
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(routines.join("large.md"), routines.join("link.md")).unwrap();

        let scan = scan_routine_directory(temp.path(), RoutineOwnerKind::Space);
        assert!(scan.files.is_empty());
        assert!(
            scan.diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code == "routine_file_unsafe")
        );
    }

    #[test]
    fn portable_identity_is_required_unique_and_independent_of_filename() {
        let temp = tempfile::tempdir().unwrap();
        let routines = temp.path().join(".routines");
        fs::create_dir_all(&routines).unwrap();
        fs::write(routines.join("first.md"), valid_manual()).unwrap();

        let first = discover_owner(&owner(temp.path()));
        let first_row = &first.routines[0];
        assert!(first_row.routine_id.is_some());
        let routine_id = first_row.routine_id.clone();
        fs::rename(routines.join("first.md"), routines.join("renamed.md")).unwrap();
        let renamed = discover_owner(&owner(temp.path()));
        assert_eq!(renamed.routines[0].routine_id, routine_id);

        fs::write(routines.join("duplicate.md"), valid_manual()).unwrap();
        let duplicate = discover_owner(&owner(temp.path()));
        assert!(
            duplicate
                .routines
                .iter()
                .all(|row| row.routine_id.is_none())
        );
        assert!(duplicate.routines.iter().all(|row| {
            row.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "routine_id_duplicate"
                    && diagnostic.path.as_deref() == Some(row.path.as_str())
            })
        }));
    }

    #[test]
    fn equivalent_external_names_publish_lossless_conflict_projection() {
        let temp = tempfile::tempdir().unwrap();
        let routines = temp.path().join(".routines");
        fs::create_dir_all(&routines).unwrap();
        let first = valid_manual().replace("name: Test", "name: Quarterly Review");
        let second = valid_manual()
            .replace(ID, "01arz3ndektsv4rrffq69g5faw")
            .replace("name: Test", "name: ＱＵＡＲＴＥＲＬＹ\u{2003}review");
        fs::write(routines.join("first.md"), first).unwrap();
        fs::write(routines.join("second.md"), second).unwrap();

        let conflicted = discover_owner(&owner(temp.path()));
        assert_eq!(conflicted.routines.len(), 2);
        assert!(conflicted.routines.iter().all(|row| {
            row.routine_id.is_some()
                && row.name_conflict.as_ref().is_some_and(|conflict| {
                    conflict.conflicting_paths.len() == 1
                        && conflict.conflicting_paths[0] != row.path
                })
        }));
        let first_identity = conflicted.routines[0].routine_id.clone();
        let first_execution = conflicted.routines[0].execution_fingerprint.clone();

        fs::write(
            routines.join("second.md"),
            valid_manual()
                .replace(ID, "01arz3ndektsv4rrffq69g5faw")
                .replace("name: Test", "name: Different"),
        )
        .unwrap();
        let recovered = discover_owner(&owner(temp.path()));
        assert!(
            recovered
                .routines
                .iter()
                .all(|row| row.name_conflict.is_none())
        );
        assert_eq!(recovered.routines[0].routine_id, first_identity);
        assert_eq!(recovered.routines[0].execution_fingerprint, first_execution);
    }

    #[test]
    fn malformed_identity_and_legacy_title_fail_closed_without_aliasing() {
        let missing = parse_routine(
            &valid_manual().replace(&format!("id: {ID}\n"), ""),
            "missing.md",
            RoutineOwnerKind::Space,
        );
        assert!(missing.portable_id.is_none());
        assert!(
            missing
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "routine_id_invalid")
        );

        let legacy = valid_manual().replace("name: Test", "title: Legacy");
        let legacy = parse_routine(&legacy, "legacy.md", RoutineOwnerKind::Space);
        assert!(legacy.definition.is_none());
        assert!(
            legacy
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "routine_frontmatter_invalid")
        );
    }

    #[test]
    fn display_edits_change_source_but_not_execution_fingerprint() {
        let first = parse_routine(&valid_manual(), "first.md", RoutineOwnerKind::Space)
            .definition
            .unwrap();
        let renamed = RoutineDefinition {
            name: Some("Renamed".into()),
            description: Some("Updated description".into()),
            ..first.clone()
        };
        assert_eq!(
            execution_fingerprint(&first),
            execution_fingerprint(&renamed)
        );
        assert_ne!(
            fingerprint(serialize_definition(&first, ID).unwrap().as_bytes()),
            fingerprint(serialize_definition(&renamed, ID).unwrap().as_bytes())
        );

        let changed_body = RoutineDefinition {
            body: "Different body".into(),
            ..first
        };
        assert_ne!(
            execution_fingerprint(&renamed),
            execution_fingerprint(&changed_body)
        );
    }
}
