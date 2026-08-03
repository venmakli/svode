use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

use crate::supported_adapters::{SkillRootKind, SupportedAdapterId, SupportedAdapterSnapshot};

use super::super::model::{
    DiagnosticSeverity, InstructionOwner, InstructionOwnerKind, MarkdownPreview, SkillAvailability,
    SkillDiscoveryAlias, SkillDiscoveryKind, SkillLinkKind, SkillRow, SkillScope,
    SkillValidationStatus,
};
use super::DiscoveryResult;
use super::io::{diagnostic, path_string};

const MAX_ROOT_ENTRIES: usize = 512;
const MAX_SKILL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
struct ParsedSkill {
    name: String,
    description: String,
    license: Option<String>,
    compatibility: Option<String>,
    metadata: Option<serde_json::Value>,
    warnings: Vec<String>,
    preview: MarkdownPreview,
    manifest_path: PathBuf,
}

#[derive(Debug, Clone)]
struct SkillFailure {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct RootSpec<'a> {
    adapter: &'a SupportedAdapterSnapshot,
    scope: SkillScope,
    discovery_kind: SkillDiscoveryKind,
    root: PathBuf,
    owner: InstructionOwner,
}

pub(super) fn discover(
    repository_root: &Path,
    directory_chain: &[PathBuf],
    adapters: &[SupportedAdapterSnapshot],
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let roots = roots(directory_chain, adapters);
    let mut allowed_boundaries = vec![repository_root.to_path_buf()];
    for root in roots
        .iter()
        .filter(|root| root.scope == SkillScope::Personal)
    {
        if let Ok(canonical) = root.root.canonicalize() {
            allowed_boundaries.push(canonical);
        }
    }
    allowed_boundaries.sort();
    allowed_boundaries.dedup();

    let mut parsed_cache: BTreeMap<PathBuf, Result<ParsedSkill, SkillFailure>> = BTreeMap::new();
    let mut rows: BTreeMap<PathBuf, SkillRow> = BTreeMap::new();
    for root in roots {
        observe_root(&root, &mut result);
        scan_root(
            &root,
            &allowed_boundaries,
            &mut parsed_cache,
            &mut rows,
            &mut result,
        );
    }

    let personal_shadows_project = adapters
        .iter()
        .filter(|adapter| {
            adapter.capabilities.skills.policy
                == crate::supported_adapters::SkillDiscoveryPolicy::ClaudePersonalShadowsProject
        })
        .map(|adapter| adapter.id)
        .collect::<BTreeSet<_>>();
    apply_personal_shadowing(&mut rows, &personal_shadows_project);
    for row in rows.values_mut() {
        row.aliases.sort_by(|left, right| {
            left.adapter_id
                .cmp(&right.adapter_id)
                .then_with(|| skill_scope_order(left.scope).cmp(&skill_scope_order(right.scope)))
                .then_with(|| left.path.cmp(&right.path))
                .then_with(|| {
                    discovery_kind_order(left.discovery_kind)
                        .cmp(&discovery_kind_order(right.discovery_kind))
                })
        });
        row.aliases.dedup();
        for warning in &row.warnings {
            result
                .diagnostics
                .push(super::super::model::AgentContextDiagnostic {
                    code: "skill_manifest_warning".to_string(),
                    severity: DiagnosticSeverity::Warning,
                    message: warning.clone(),
                    path: Some(row.path.clone()),
                    adapter_id: None,
                });
        }
    }
    result.skills = rows.into_values().collect();
    result
}

fn roots<'a>(
    directory_chain: &[PathBuf],
    adapters: &'a [SupportedAdapterSnapshot],
) -> Vec<RootSpec<'a>> {
    let mut roots = Vec::new();
    for adapter in adapters {
        let project_relative_root = Path::new(&adapter.capabilities.skills.project_relative_root);
        for directory in directory_chain {
            roots.push(RootSpec {
                adapter,
                scope: SkillScope::Project,
                discovery_kind: match adapter.id {
                    SupportedAdapterId::Codex => SkillDiscoveryKind::CodexProject,
                    SupportedAdapterId::ClaudeCode => SkillDiscoveryKind::ClaudeProject,
                },
                root: directory.join(project_relative_root),
                owner: InstructionOwner {
                    kind: InstructionOwnerKind::TargetSpace,
                    root: path_string(directory),
                },
            });
        }
        for personal_root in &adapter.capabilities.skills.personal_roots {
            roots.push(RootSpec {
                adapter,
                scope: SkillScope::Personal,
                discovery_kind: match (adapter.id, personal_root.kind) {
                    (SupportedAdapterId::Codex, SkillRootKind::StandardPersonal) => {
                        SkillDiscoveryKind::CodexStandardPersonal
                    }
                    (SupportedAdapterId::Codex, SkillRootKind::CompatibilityPersonal) => {
                        SkillDiscoveryKind::CodexCompatibilityPersonal
                    }
                    (SupportedAdapterId::ClaudeCode, _) => SkillDiscoveryKind::ClaudePersonal,
                },
                root: PathBuf::from(&personal_root.path),
                owner: InstructionOwner {
                    kind: InstructionOwnerKind::ClientConfiguration,
                    root: personal_root.path.clone(),
                },
            });
        }
    }
    roots
}

fn observe_root(root: &RootSpec<'_>, result: &mut DiscoveryResult) {
    let observed = path_string(&root.root);
    match root.scope {
        SkillScope::Project => result.observed_project_paths.push(observed),
        SkillScope::Personal => result.observed_personal_paths.push(observed),
    }
}

fn scan_root(
    root: &RootSpec<'_>,
    allowed_boundaries: &[PathBuf],
    parsed_cache: &mut BTreeMap<PathBuf, Result<ParsedSkill, SkillFailure>>,
    rows: &mut BTreeMap<PathBuf, SkillRow>,
    result: &mut DiscoveryResult,
) {
    let root_metadata = match fs::symlink_metadata(&root.root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            push_failure(
                result,
                root.adapter.id,
                &root.root,
                "skill_root_metadata",
                format!(
                    "Could not inspect skill root {}: {error}",
                    root.root.display()
                ),
            );
            return;
        }
    };
    let canonical_root = match root.root.canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            push_failure(
                result,
                root.adapter.id,
                &root.root,
                "skill_root_not_directory",
                format!("Skill root is not a directory: {}", root.root.display()),
            );
            return;
        }
        Err(error) => {
            push_failure(
                result,
                root.adapter.id,
                &root.root,
                "skill_root_alias_unresolved",
                format!(
                    "Could not resolve skill root {}: {error}",
                    root.root.display()
                ),
            );
            return;
        }
    };
    if !allowed_boundaries
        .iter()
        .any(|boundary| canonical_root.starts_with(boundary))
    {
        push_failure(
            result,
            root.adapter.id,
            &root.root,
            "skill_root_outside_boundary",
            format!(
                "Skill root {} resolves outside the project and supported personal roots and was not scanned",
                root.root.display()
            ),
        );
        return;
    }
    if !root_metadata.is_dir() && !root_metadata.file_type().is_symlink() {
        push_failure(
            result,
            root.adapter.id,
            &root.root,
            "skill_root_not_directory",
            format!("Skill root is not a directory: {}", root.root.display()),
        );
        return;
    }

    let entries = match bounded_entries(&root.root) {
        Ok(entries) => entries,
        Err(failure) => {
            push_failure(
                result,
                root.adapter.id,
                &root.root,
                failure.code,
                failure.message,
            );
            return;
        }
    };
    if entries.truncated {
        push_failure(
            result,
            root.adapter.id,
            &root.root,
            "skill_root_entry_limit",
            format!(
                "Skill root {} exceeded the {MAX_ROOT_ENTRIES} direct-entry scan limit",
                root.root.display()
            ),
        );
    }
    for entry in entries.paths {
        scan_entry(
            root,
            &entry,
            &canonical_root,
            root_metadata.file_type().is_symlink()
                || root
                    .root
                    .parent()
                    .and_then(|parent| parent.canonicalize().ok())
                    .zip(root.root.file_name())
                    .is_some_and(|(parent, name)| canonical_root != parent.join(name)),
            allowed_boundaries,
            parsed_cache,
            rows,
            result,
        );
    }
}

struct BoundedEntries {
    paths: Vec<PathBuf>,
    truncated: bool,
}

fn bounded_entries(root: &Path) -> Result<BoundedEntries, SkillFailure> {
    let read_dir = fs::read_dir(root).map_err(|error| SkillFailure {
        code: "skill_root_read",
        message: format!("Could not enumerate skill root {}: {error}", root.display()),
    })?;
    let mut selected = BTreeSet::new();
    let mut seen = 0usize;
    for entry in read_dir {
        let entry = entry.map_err(|error| SkillFailure {
            code: "skill_root_read",
            message: format!("Could not enumerate skill root {}: {error}", root.display()),
        })?;
        seen = seen.saturating_add(1);
        let path = entry.path();
        if selected.len() < MAX_ROOT_ENTRIES {
            selected.insert(path);
            continue;
        }
        if let Some(largest) = selected.last().cloned() {
            if path < largest {
                selected.remove(&largest);
                selected.insert(path);
            }
        }
    }
    Ok(BoundedEntries {
        paths: selected.into_iter().collect(),
        truncated: seen > MAX_ROOT_ENTRIES,
    })
}

#[allow(clippy::too_many_arguments)]
fn scan_entry(
    root: &RootSpec<'_>,
    entry: &Path,
    canonical_root: &Path,
    root_is_alias: bool,
    allowed_boundaries: &[PathBuf],
    parsed_cache: &mut BTreeMap<PathBuf, Result<ParsedSkill, SkillFailure>>,
    rows: &mut BTreeMap<PathBuf, SkillRow>,
    result: &mut DiscoveryResult,
) {
    let Some(entry_name) = entry.file_name().and_then(|name| name.to_str()) else {
        push_failure(
            result,
            root.adapter.id,
            entry,
            "skill_entry_name",
            format!("Skill entry name is not valid UTF-8: {}", entry.display()),
        );
        return;
    };
    if entry_name.starts_with('.') {
        return;
    }
    let metadata = match fs::symlink_metadata(entry) {
        Ok(metadata) => metadata,
        Err(error) => {
            push_failure(
                result,
                root.adapter.id,
                entry,
                "skill_entry_metadata",
                format!("Could not inspect skill entry {}: {error}", entry.display()),
            );
            return;
        }
    };
    if metadata.is_file() {
        push_failure(
            result,
            root.adapter.id,
            entry,
            "skill_materialized_symlink",
            format!(
                "Skill entry {} is a plain file, possibly a materialized Git symlink, and was not followed",
                entry.display()
            ),
        );
        return;
    }
    let canonical_entry = match entry.canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            push_failure(
                result,
                root.adapter.id,
                entry,
                "skill_entry_not_directory",
                format!("Skill entry is not a directory: {}", entry.display()),
            );
            return;
        }
        Err(error) => {
            push_failure(
                result,
                root.adapter.id,
                entry,
                "skill_alias_unresolved",
                format!(
                    "Could not resolve skill alias {} (broken link or cycle): {error}",
                    entry.display()
                ),
            );
            return;
        }
    };
    if !allowed_boundaries
        .iter()
        .any(|boundary| canonical_entry.starts_with(boundary))
    {
        push_failure(
            result,
            root.adapter.id,
            entry,
            "skill_outside_boundary",
            format!(
                "Skill alias {} resolves outside the project and supported personal roots and was not read",
                entry.display()
            ),
        );
        return;
    }
    let link_kind = if metadata.file_type().is_symlink() {
        SkillLinkKind::SymbolicLink
    } else if root_is_alias || canonical_entry != canonical_root.join(entry_name) {
        SkillLinkKind::DirectoryAlias
    } else {
        SkillLinkKind::Direct
    };

    let parsed = parsed_cache
        .entry(canonical_entry.clone())
        .or_insert_with(|| parse_skill(&canonical_entry))
        .clone();
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(failure) => {
            push_failure(
                result,
                root.adapter.id,
                &entry.join("SKILL.md"),
                failure.code,
                failure.message,
            );
            return;
        }
    };
    let (availability, reason) = native_availability(root.adapter, link_kind);
    let alias = SkillDiscoveryAlias {
        adapter_id: root.adapter.id,
        scope: root.scope,
        discovery_kind: root.discovery_kind,
        path: path_string(entry),
        root: path_string(&root.root),
        owner: root.owner.clone(),
        availability,
        reason,
        link_kind,
    };
    if let Some(row) = rows.get_mut(&canonical_entry) {
        row.aliases.push(alias);
        return;
    }
    let validation = if parsed.warnings.is_empty() {
        SkillValidationStatus::Valid
    } else {
        SkillValidationStatus::Warning
    };
    rows.insert(
        canonical_entry.clone(),
        SkillRow {
            id: format!("skill:{}", path_string(&canonical_entry)),
            name: parsed.name,
            description: parsed.description,
            path: path_string(&parsed.manifest_path),
            canonical_path: path_string(&canonical_entry),
            license: parsed.license,
            compatibility: parsed.compatibility,
            metadata: parsed.metadata,
            validation,
            warnings: parsed.warnings,
            preview: parsed.preview,
            aliases: vec![alias],
        },
    );
}

fn parse_skill(canonical_entry: &Path) -> Result<ParsedSkill, SkillFailure> {
    let manifest_path = canonical_entry.join("SKILL.md");
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        let (code, message) = if error.kind() == std::io::ErrorKind::NotFound {
            (
                "skill_manifest_missing",
                format!(
                    "Skill directory {} has no SKILL.md",
                    canonical_entry.display()
                ),
            )
        } else {
            (
                "skill_manifest_metadata",
                format!("Could not inspect {}: {error}", manifest_path.display()),
            )
        };
        SkillFailure { code, message }
    })?;
    if !manifest_metadata.is_file() {
        return Err(SkillFailure {
            code: "skill_manifest_not_file",
            message: format!("Skill manifest is not a file: {}", manifest_path.display()),
        });
    }
    let canonical_manifest = manifest_path.canonicalize().map_err(|error| SkillFailure {
        code: "skill_manifest_alias_unresolved",
        message: format!("Could not resolve {}: {error}", manifest_path.display()),
    })?;
    if !canonical_manifest.starts_with(canonical_entry) {
        return Err(SkillFailure {
            code: "skill_manifest_outside_directory",
            message: format!(
                "Skill manifest {} resolves outside its canonical skill directory",
                manifest_path.display()
            ),
        });
    }
    let raw = read_bounded_stable(&canonical_manifest)?;
    let (frontmatter, body) = split_frontmatter(&raw)?;
    let document: serde_yml::Value =
        serde_yml::from_str(frontmatter).map_err(|error| SkillFailure {
            code: "skill_frontmatter_parse",
            message: format!(
                "Could not parse {} frontmatter: {error}",
                manifest_path.display()
            ),
        })?;
    let mapping = document.as_mapping().ok_or_else(|| SkillFailure {
        code: "skill_frontmatter_mapping",
        message: format!(
            "Skill frontmatter must be a mapping: {}",
            manifest_path.display()
        ),
    })?;
    let name = required_string(mapping, "name", &manifest_path)?;
    let description = required_string(mapping, "description", &manifest_path)?;
    let mut warnings = Vec::new();
    let trimmed_name = name.trim().to_string();
    let trimmed_description = description.trim().to_string();
    if trimmed_name != name {
        warnings.push("Skill name contains surrounding whitespace".to_string());
    }
    if !valid_skill_name(&trimmed_name) {
        warnings.push(
            "Skill name does not follow the lowercase letters, digits, and hyphens convention"
                .to_string(),
        );
    }
    if canonical_entry
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|directory_name| directory_name != trimmed_name)
    {
        warnings.push("Skill name does not match its canonical directory name".to_string());
    }
    if trimmed_description != description {
        warnings.push("Skill description contains surrounding whitespace".to_string());
    }
    if trimmed_description.chars().count() > 1024 {
        warnings
            .push("Skill description exceeds the 1024-character compatibility limit".to_string());
    }
    let license = optional_string(mapping, "license", &mut warnings);
    let compatibility = optional_string(mapping, "compatibility", &mut warnings);
    if compatibility
        .as_ref()
        .is_some_and(|value| value.chars().count() > 500)
    {
        warnings
            .push("Skill compatibility exceeds the 500-character compatibility limit".to_string());
    }
    let metadata = match mapping.get("metadata") {
        Some(value) if value.as_mapping().is_some() => match serde_json::to_value(value) {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(format!("Skill metadata could not be normalized: {error}"));
                None
            }
        },
        Some(_) => {
            warnings.push("Skill metadata is not a mapping".to_string());
            None
        }
        None => None,
    };
    Ok(ParsedSkill {
        name: trimmed_name,
        description: trimmed_description,
        license,
        compatibility,
        metadata,
        warnings,
        preview: MarkdownPreview {
            markdown: body.to_string(),
            truncated: false,
            bytes_read: body.len(),
            total_bytes: body.len() as u64,
        },
        manifest_path: canonical_manifest,
    })
}

fn read_bounded_stable(path: &Path) -> Result<String, SkillFailure> {
    for attempt in 0..2 {
        let before = fs::metadata(path).map_err(|error| SkillFailure {
            code: "skill_manifest_metadata",
            message: format!("Could not read metadata for {}: {error}", path.display()),
        })?;
        if before.len() > MAX_SKILL_BYTES as u64 {
            return Err(SkillFailure {
                code: "skill_manifest_limit",
                message: format!(
                    "Skill manifest {} exceeds the {MAX_SKILL_BYTES}-byte scan limit",
                    path.display()
                ),
            });
        }
        let file = File::open(path).map_err(|error| SkillFailure {
            code: "skill_manifest_read",
            message: format!("Could not read {}: {error}", path.display()),
        })?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        let mut reader: Take<File> = file.take((MAX_SKILL_BYTES + 1) as u64);
        reader
            .read_to_end(&mut bytes)
            .map_err(|error| SkillFailure {
                code: "skill_manifest_read",
                message: format!("Could not read {}: {error}", path.display()),
            })?;
        if bytes.len() > MAX_SKILL_BYTES {
            return Err(SkillFailure {
                code: "skill_manifest_limit",
                message: format!(
                    "Skill manifest {} exceeds the {MAX_SKILL_BYTES}-byte scan limit",
                    path.display()
                ),
            });
        }
        let after = fs::metadata(path).map_err(|error| SkillFailure {
            code: "skill_manifest_metadata",
            message: format!(
                "Could not re-check metadata for {}: {error}",
                path.display()
            ),
        })?;
        if before.len() == after.len() && before.modified().ok() == after.modified().ok() {
            return String::from_utf8(bytes).map_err(|error| SkillFailure {
                code: "skill_manifest_utf8",
                message: format!(
                    "Skill manifest {} is not valid UTF-8: {error}",
                    path.display()
                ),
            });
        }
        if attempt == 1 {
            return Err(SkillFailure {
                code: "skill_manifest_changed",
                message: format!(
                    "Skill manifest {} changed while it was scanned",
                    path.display()
                ),
            });
        }
    }
    unreachable!("bounded retry loop returns")
}

fn split_frontmatter(raw: &str) -> Result<(&str, &str), SkillFailure> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(first_newline) = raw.find('\n') else {
        return Err(frontmatter_failure());
    };
    if raw[..first_newline].trim_end_matches('\r') != "---" {
        return Err(frontmatter_failure());
    }
    let frontmatter_start = first_newline + 1;
    let mut line_start = frontmatter_start;
    loop {
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
            return Ok((&raw[frontmatter_start..line_start], &raw[body_start..]));
        }
        if line_end == raw.len() {
            return Err(frontmatter_failure());
        }
        line_start = line_end + 1;
    }
}

fn frontmatter_failure() -> SkillFailure {
    SkillFailure {
        code: "skill_frontmatter_missing",
        message: "Skill manifest must begin with closed YAML frontmatter".to_string(),
    }
}

fn required_string(
    mapping: &serde_yml::Mapping,
    key: &'static str,
    path: &Path,
) -> Result<String, SkillFailure> {
    let Some(value) = mapping.get(key) else {
        return Err(SkillFailure {
            code: match key {
                "name" => "skill_name_missing",
                _ => "skill_description_missing",
            },
            message: format!("Skill {} is missing required {key}", path.display()),
        });
    };
    let Some(value) = value.as_str() else {
        return Err(SkillFailure {
            code: match key {
                "name" => "skill_name_invalid",
                _ => "skill_description_invalid",
            },
            message: format!("Skill {} has a non-string {key}", path.display()),
        });
    };
    if value.trim().is_empty() {
        return Err(SkillFailure {
            code: match key {
                "name" => "skill_name_invalid",
                _ => "skill_description_invalid",
            },
            message: format!("Skill {} has an empty {key}", path.display()),
        });
    }
    Ok(value.to_string())
}

fn optional_string(
    mapping: &serde_yml::Mapping,
    key: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match mapping.get(key) {
        Some(value) => match value.as_str() {
            Some(value) => Some(value.to_string()),
            None => {
                warnings.push(format!("Skill {key} is not a string"));
                None
            }
        },
        None => None,
    }
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !name.contains("--")
}

fn native_availability(
    adapter: &SupportedAdapterSnapshot,
    link_kind: SkillLinkKind,
) -> (SkillAvailability, Option<String>) {
    let executable_known =
        adapter.executable.path.is_some() && adapter.executable.version.is_some();
    if !executable_known {
        return (
            SkillAvailability::CompatibilityUnknown,
            Some(format!(
                "{} executable or version evidence is unavailable",
                adapter.display_name
            )),
        );
    }
    if adapter.id == SupportedAdapterId::ClaudeCode && link_kind != SkillLinkKind::Direct {
        let version_supported = adapter
            .executable
            .version
            .as_deref()
            .is_some_and(|version| version_at_least(version, [2, 1, 203]));
        if !version_supported || cfg!(windows) {
            return (
                SkillAvailability::CompatibilityUnknown,
                Some(
                    "Claude Code skill alias support is not proven for this version/platform"
                        .to_string(),
                ),
            );
        }
    }
    (SkillAvailability::Available, None)
}

fn version_at_least(raw: &str, required: [u64; 3]) -> bool {
    raw.split(|character: char| !character.is_ascii_digit() && character != '.')
        .find_map(|candidate| {
            let mut parts = candidate.split('.');
            let parsed = [
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
            ];
            Some(parsed >= required)
        })
        .unwrap_or(false)
}

fn apply_personal_shadowing(
    rows: &mut BTreeMap<PathBuf, SkillRow>,
    adapters: &BTreeSet<SupportedAdapterId>,
) {
    let personal_names = rows
        .values()
        .flat_map(|row| {
            row.aliases
                .iter()
                .filter(|alias| {
                    adapters.contains(&alias.adapter_id) && alias.scope == SkillScope::Personal
                })
                .map(|alias| (alias.adapter_id, row.name.clone()))
        })
        .collect::<BTreeSet<_>>();
    for row in rows.values_mut() {
        for alias in &mut row.aliases {
            if alias.scope == SkillScope::Project
                && personal_names.contains(&(alias.adapter_id, row.name.clone()))
            {
                alias.availability = SkillAvailability::Shadowed;
                alias.reason = Some(
                    "A Claude Code personal skill shadows this project invocation name".to_string(),
                );
            }
        }
    }
}

fn push_failure(
    result: &mut DiscoveryResult,
    adapter_id: SupportedAdapterId,
    path: &Path,
    code: &str,
    message: String,
) {
    result
        .diagnostics
        .push(diagnostic(path, Some(adapter_id), code, message));
}

fn skill_scope_order(scope: SkillScope) -> u8 {
    match scope {
        SkillScope::Personal => 0,
        SkillScope::Project => 1,
    }
}

fn discovery_kind_order(kind: SkillDiscoveryKind) -> u8 {
    match kind {
        SkillDiscoveryKind::CodexStandardPersonal => 0,
        SkillDiscoveryKind::CodexCompatibilityPersonal => 1,
        SkillDiscoveryKind::CodexProject => 2,
        SkillDiscoveryKind::ClaudePersonal => 3,
        SkillDiscoveryKind::ClaudeProject => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_context::scanner::scan;
    use crate::supported_adapters::RegistryEnvironment;
    use std::collections::HashSet;
    use tempfile::TempDir;

    fn write_skill(root: &Path, directory: &str, name: &str, description: Option<&str>) -> PathBuf {
        let skill = root.join(directory);
        fs::create_dir_all(&skill).unwrap();
        let description = description
            .map(|value| format!("description: {value}\n"))
            .unwrap_or_default();
        fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: {name}\n{description}---\n# {name}\nbody\n"),
        )
        .unwrap();
        skill
    }

    fn setup() -> (TempDir, TempDir, RegistryEnvironment) {
        let project = TempDir::new().unwrap();
        fs::create_dir(project.path().join(".git")).unwrap();
        let home = TempDir::new().unwrap();
        let environment = RegistryEnvironment::for_tests(home.path().to_path_buf());
        (project, home, environment)
    }

    #[test]
    fn valid_warning_and_unparseable_manifests_are_isolated() {
        let (project, _home, environment) = setup();
        let root = project.path().join(".agents/skills");
        let valid = write_skill(&root, "valid", "valid", Some("Valid skill"));
        fs::write(
            valid.join("SKILL.md"),
            "---\nname: valid\ndescription: Valid skill\nlicense: MIT\ncompatibility: Cross-client\nmetadata:\n  author: Svode\nallowed-tools: Read\n---\n# Valid\nbody\n",
        )
        .unwrap();
        write_skill(&root, "warning", "Warning", Some("Warning skill"));
        write_skill(&root, "missing-description", "missing-description", None);
        let invalid = root.join("invalid");
        fs::create_dir_all(&invalid).unwrap();
        fs::write(invalid.join("SKILL.md"), "not frontmatter").unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();

        assert_eq!(snapshot.skills.len(), 2);
        assert!(
            snapshot.skills.iter().any(|row| {
                row.name == "valid" && row.validation == SkillValidationStatus::Valid
            })
        );
        let valid = snapshot
            .skills
            .iter()
            .find(|row| row.name == "valid")
            .unwrap();
        assert_eq!(valid.license.as_deref(), Some("MIT"));
        assert_eq!(valid.compatibility.as_deref(), Some("Cross-client"));
        assert_eq!(valid.metadata.as_ref().unwrap()["author"], "Svode");
        assert_eq!(valid.preview.markdown, "# Valid\nbody\n");
        assert!(snapshot.skills.iter().any(|row| {
            row.name == "Warning" && row.validation == SkillValidationStatus::Warning
        }));
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "skill_description_missing")
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "skill_frontmatter_missing")
        );
    }

    #[cfg(unix)]
    #[test]
    fn aliases_dedupe_by_canonical_source_but_same_names_do_not() {
        use std::os::unix::fs::symlink;

        let (project, home, environment) = setup();
        let sources = project.path().join("sources");
        let shared = write_skill(&sources, "shared", "shared", Some("Shared"));
        let duplicate_name = write_skill(&sources, "other", "shared", Some("Other"));
        let codex_root = project.path().join(".agents/skills");
        let claude_root = project.path().join(".claude/skills");
        fs::create_dir_all(&codex_root).unwrap();
        fs::create_dir_all(&claude_root).unwrap();
        symlink(&shared, codex_root.join("shared-codex")).unwrap();
        symlink(&shared, claude_root.join("shared-claude")).unwrap();
        symlink(&duplicate_name, codex_root.join("other")).unwrap();
        let standard = home.path().join(".agents/skills");
        let compatibility = home.path().join(".codex/skills");
        fs::create_dir_all(&standard).unwrap();
        fs::create_dir_all(&compatibility).unwrap();
        let personal = write_skill(&standard, "personal", "personal", Some("Personal"));
        symlink(&personal, compatibility.join("personal-compat")).unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let shared_rows = snapshot
            .skills
            .iter()
            .filter(|row| row.name == "shared")
            .collect::<Vec<_>>();

        assert_eq!(shared_rows.len(), 2);
        assert!(shared_rows.iter().any(|row| {
            row.aliases
                .iter()
                .any(|alias| alias.adapter_id == SupportedAdapterId::Codex)
                && row
                    .aliases
                    .iter()
                    .any(|alias| alias.adapter_id == SupportedAdapterId::ClaudeCode)
        }));
        let personal = snapshot
            .skills
            .iter()
            .find(|row| row.name == "personal")
            .unwrap();
        assert_eq!(personal.aliases.len(), 2);
        assert!(
            personal
                .aliases
                .iter()
                .any(|alias| { alias.discovery_kind == SkillDiscoveryKind::CodexStandardPersonal })
        );
        assert!(personal.aliases.iter().any(|alias| {
            alias.discovery_kind == SkillDiscoveryKind::CodexCompatibilityPersonal
        }));
    }

    #[cfg(unix)]
    #[test]
    fn skill_root_alias_keeps_link_provenance_and_client_compatibility() {
        use std::os::unix::fs::symlink;

        let (project, _home, environment) = setup();
        let source_root = project.path().join("sources");
        write_skill(&source_root, "review", "review", Some("Review"));
        fs::create_dir_all(project.path().join(".claude")).unwrap();
        symlink(&source_root, project.path().join(".claude/skills")).unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let row = snapshot
            .skills
            .iter()
            .find(|row| row.name == "review")
            .unwrap();

        assert_eq!(row.aliases.len(), 1);
        assert!(row.aliases.iter().any(|alias| {
            alias.scope == SkillScope::Project
                && alias.link_kind == SkillLinkKind::DirectoryAlias
                && alias.availability == SkillAvailability::CompatibilityUnknown
        }));
    }

    #[test]
    fn claude_personal_skill_shadows_project_name_without_hiding_source() {
        let (project, home, environment) = setup();
        write_skill(
            &project.path().join(".claude/skills"),
            "review",
            "review",
            Some("Project"),
        );
        write_skill(
            &home.path().join(".claude/skills"),
            "review",
            "review",
            Some("Personal"),
        );

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let review = snapshot
            .skills
            .iter()
            .filter(|row| row.name == "review")
            .collect::<Vec<_>>();

        assert_eq!(review.len(), 2);
        assert!(review.iter().any(|row| row.aliases.iter().any(|alias| {
            alias.scope == SkillScope::Project && alias.availability == SkillAvailability::Shadowed
        })));
        assert!(review.iter().any(|row| row.aliases.iter().any(|alias| {
            alias.scope == SkillScope::Personal
                && alias.availability == SkillAvailability::Available
        })));
    }

    #[test]
    fn project_skill_chain_stops_at_independent_repository_boundary() {
        let (project, _home, environment) = setup();
        write_skill(
            &project.path().join(".agents/skills"),
            "root-skill",
            "root-skill",
            Some("Root"),
        );
        let inline = project.path().join("inline");
        fs::create_dir(&inline).unwrap();
        write_skill(
            &inline.join(".agents/skills"),
            "inline-skill",
            "inline-skill",
            Some("Inline"),
        );
        let independent = project.path().join("independent");
        fs::create_dir(&independent).unwrap();
        fs::create_dir(independent.join(".git")).unwrap();
        write_skill(
            &independent.join(".agents/skills"),
            "independent-skill",
            "independent-skill",
            Some("Independent"),
        );

        let root = scan(project.path(), project.path(), &environment).unwrap();
        let inline_snapshot = scan(project.path(), &inline, &environment).unwrap();
        let independent_snapshot = scan(project.path(), &independent, &environment).unwrap();
        let names = |snapshot: &super::super::super::model::AgentContextSnapshotContent| {
            snapshot
                .skills
                .iter()
                .map(|skill| skill.name.clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(names(&root), vec!["root-skill".to_string()]);
        assert_eq!(
            names(&inline_snapshot),
            vec!["inline-skill".to_string(), "root-skill".to_string()]
        );
        assert_eq!(
            names(&independent_snapshot),
            vec!["independent-skill".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn broken_loop_materialized_and_external_aliases_are_bounded_diagnostics() {
        use std::os::unix::fs::symlink;

        let (project, _home, environment) = setup();
        let root = project.path().join(".agents/skills");
        fs::create_dir_all(&root).unwrap();
        symlink(root.join("missing"), root.join("broken")).unwrap();
        symlink(root.join("loop-b"), root.join("loop-a")).unwrap();
        symlink(root.join("loop-a"), root.join("loop-b")).unwrap();
        fs::write(root.join("materialized"), "../source").unwrap();
        let outside = TempDir::new().unwrap();
        let external = write_skill(outside.path(), "external", "external", Some("Secret"));
        symlink(external, root.join("external")).unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();

        assert!(snapshot.skills.is_empty());
        let codes = snapshot
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<HashSet<_>>();
        assert!(codes.contains("skill_alias_unresolved"));
        assert!(codes.contains("skill_materialized_symlink"));
        assert!(codes.contains("skill_outside_boundary"));
        assert!(!format!("{snapshot:?}").contains("Secret"));
    }
}
