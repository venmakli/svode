use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, AgentSourcePolicy, FlatSkills, SkillKey, SkillLayout, SkillPlace,
    SkillPrecedence, SourceRegistryEnvironment, SourceSwitch,
};

use super::super::model::{
    DiagnosticSeverity, InstructionOwner, InstructionOwnerKind, MarkdownPreview,
    SkillDiscoveryAlias, SkillDiscoveryKind, SkillLinkKind, SkillMetadataLeaf, SkillMetadataValue,
    SkillRow, SkillScope, SkillValidationStatus, SourceHealth, SourceResolution, SourceSupport,
};
use super::io::{diagnostic, path_string};
use super::{DiscoveryResult, TargetPlaces};

const MAX_ROOT_ENTRIES: usize = 512;
/// Folders of skills followed below one root.
const MAX_SKILL_FOLDERS: usize = 256;
/// Folders of dependencies and builds a walk over folders of skills never
/// enters.
const WALK_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "target",
    "venv",
    "site-packages",
    "__pycache__",
];
const MAX_SKILL_BYTES: usize = 256 * 1024;
/// Claude Code keeps claude.ai synced skills here and never reads it as a
/// skills-dir entry.
const CLAUDE_SYNCED_SKILLS_DIR: &str = "synced";
const CLAUDE_PLUGIN_MANIFEST: &str = ".claude-plugin/plugin.json";

#[derive(Debug, Clone)]
struct ParsedSkill {
    name: String,
    description: String,
    license: Option<String>,
    compatibility: Option<String>,
    metadata: Option<BTreeMap<String, SkillMetadataValue>>,
    allowed_tools: Option<String>,
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
    adapter: &'a AgentSourcePolicy,
    scope: SkillScope,
    discovery_kind: SkillDiscoveryKind,
    layout: SkillLayout,
    root: PathBuf,
    owner: InstructionOwner,
    excluded_names: &'a [String],
    /// The root's place in the agent's precedence by nearness: project roots
    /// by their directory's distance from the target, then rule order.
    nearness: (u8, usize, usize),
}

#[derive(Debug)]
struct CanonicalOwnerBoundary {
    root: PathBuf,
    owner: InstructionOwner,
}

/// A path by which an agent registers a skill, in the agent's order.
struct Registration {
    agent: AgentAdapterKind,
    canonical: PathBuf,
    path: String,
    root: String,
    nearness: (u8, usize, usize),
}

/// What the scans of all roots share.
struct Scan<'a> {
    places: &'a TargetPlaces,
    allowed_boundaries: Vec<PathBuf>,
    personal_owner_boundaries: Vec<CanonicalOwnerBoundary>,
    parsed_cache: BTreeMap<PathBuf, Result<ParsedSkill, SkillFailure>>,
    rows: BTreeMap<PathBuf, SkillRow>,
    registrations: Vec<Registration>,
    result: DiscoveryResult,
}

/// Project roots of every adapter; personal roots and roots outside the
/// repository boundary only of `global_agents`.
pub(super) fn discover(
    places: &TargetPlaces,
    adapters: &[AgentSourcePolicy],
    global_agents: &[AgentAdapterKind],
    environment: &SourceRegistryEnvironment,
    grok_off: &BTreeSet<SourceSwitch>,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let switched_off = adapters
        .iter()
        .flat_map(|adapter| {
            adapter
                .capabilities
                .skills
                .roots
                .iter()
                .filter_map(move |root| Some((adapter.id, root.switch?)))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|(agent, switch)| {
            !switch_on(
                *switch,
                environment,
                places,
                global_agents.contains(agent),
                grok_off,
                &mut result,
            )
        })
        .collect::<BTreeSet<_>>();
    let roots = roots(places, adapters, global_agents, &switched_off);
    let svode_home = &environment.svode_home;
    let mut allowed_boundaries = vec![places.repository_root.clone()];
    let mut personal_owner_boundaries = Vec::new();
    for root in roots
        .iter()
        .filter(|root| root.scope == SkillScope::Personal)
    {
        if let Ok(canonical) = root.root.canonicalize() {
            allowed_boundaries.push(canonical.clone());
            personal_owner_boundaries.push(CanonicalOwnerBoundary {
                root: canonical,
                owner: root.owner.clone(),
            });
        }
    }
    if let Ok(canonical) = svode_home.canonicalize() {
        allowed_boundaries.push(canonical.clone());
        personal_owner_boundaries.push(CanonicalOwnerBoundary {
            root: canonical,
            owner: InstructionOwner {
                kind: InstructionOwnerKind::ClientConfiguration,
                root: path_string(svode_home),
            },
        });
    }
    allowed_boundaries.sort();
    allowed_boundaries.dedup();
    personal_owner_boundaries.sort_by(|left, right| {
        right
            .root
            .components()
            .count()
            .cmp(&left.root.components().count())
            .then_with(|| left.root.cmp(&right.root))
    });
    personal_owner_boundaries.dedup_by(|left, right| left.root == right.root);

    let mut scan = Scan {
        places,
        allowed_boundaries,
        personal_owner_boundaries,
        parsed_cache: BTreeMap::new(),
        rows: BTreeMap::new(),
        registrations: Vec::new(),
        result,
    };
    for root in &roots {
        scan.observe_root(root);
        scan.scan_root(root);
    }
    let Scan {
        mut rows,
        registrations,
        mut result,
        ..
    } = scan;

    let personal_shadows_project = adapters
        .iter()
        .filter(|adapter| {
            adapter.capabilities.skills.precedence == SkillPrecedence::ClaudePersonalShadowsProject
        })
        .map(|adapter| adapter.id)
        .collect::<BTreeSet<_>>();
    apply_personal_shadowing(&mut rows, &personal_shadows_project);
    apply_registration_precedence(&mut rows, adapters, &registrations);
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

/// The skills roots of every agent in its registration order. A walk that
/// passes a personal root of the agent leaves it to its own place.
fn roots<'a>(
    places: &TargetPlaces,
    adapters: &'a [AgentSourcePolicy],
    global_agents: &[AgentAdapterKind],
    switched_off: &BTreeSet<(AgentAdapterKind, SourceSwitch)>,
) -> Vec<RootSpec<'a>> {
    let mut roots = Vec::new();
    for adapter in adapters {
        let global = global_agents.contains(&adapter.id);
        let personal = adapter
            .capabilities
            .skills
            .roots
            .iter()
            .filter_map(|rule| match &rule.place {
                SkillPlace::Personal(path) => Some(canonical_or_self(Path::new(path))),
                SkillPlace::Walk { .. } => None,
            })
            .collect::<Vec<_>>();
        let mut seen = Vec::<PathBuf>::new();
        for (rule_index, rule) in adapter.capabilities.skills.roots.iter().enumerate() {
            if rule
                .switch
                .is_some_and(|switch| switched_off.contains(&(adapter.id, switch)))
            {
                continue;
            }
            let places_of_rule = match &rule.place {
                SkillPlace::Walk { walk, relative } => places
                    .walk(*walk)
                    .into_iter()
                    .filter_map(|directory| {
                        let root = directory.path.join(relative);
                        if personal.contains(&canonical_or_self(&root)) {
                            return None;
                        }
                        let distance = places
                            .target_root
                            .ancestors()
                            .position(|path| path == directory.path)
                            .unwrap_or(0);
                        Some(if directory.inside {
                            (
                                distance,
                                root,
                                SkillScope::Project,
                                InstructionOwner {
                                    kind: InstructionOwnerKind::TargetSpace,
                                    root: path_string(&directory.path),
                                },
                            )
                        } else {
                            let owner = InstructionOwner {
                                kind: InstructionOwnerKind::ClientConfiguration,
                                root: path_string(&root),
                            };
                            (distance, root, SkillScope::Personal, owner)
                        })
                    })
                    .collect::<Vec<_>>(),
                SkillPlace::Personal(path) => vec![(
                    0,
                    PathBuf::from(path),
                    SkillScope::Personal,
                    InstructionOwner {
                        kind: InstructionOwnerKind::ClientConfiguration,
                        root: path.clone(),
                    },
                )],
            };
            for (distance, root, scope, owner) in places_of_rule {
                if (scope == SkillScope::Personal && !global) || seen.contains(&root) {
                    continue;
                }
                seen.push(root.clone());
                roots.push(RootSpec {
                    adapter,
                    scope,
                    discovery_kind: rule.kind,
                    layout: rule.layout,
                    root,
                    owner,
                    excluded_names: &rule.excluded_names,
                    nearness: (
                        u8::from(scope == SkillScope::Personal),
                        distance,
                        rule_index,
                    ),
                });
            }
        }
    }
    roots
}

/// Whether the agent's setting leaves the sources it switches on.
fn switch_on(
    switch: SourceSwitch,
    environment: &SourceRegistryEnvironment,
    places: &TargetPlaces,
    global: bool,
    grok_off: &BTreeSet<SourceSwitch>,
    result: &mut DiscoveryResult,
) -> bool {
    match switch {
        SourceSwitch::GrokCompat(..) => !grok_off.contains(&switch),
        SourceSwitch::HermesProjectPlugins => environment.hermes_project_plugins,
        SourceSwitch::OpencodeCompatibility => super::opencode::built_in_plugin_enabled(
            "opencode.config.compatibility",
            environment,
            places,
            global,
            result,
        ),
    }
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Scan<'_> {
    fn observe_root(&mut self, root: &RootSpec<'_>) {
        let observed = path_string(&root.root);
        match root.scope {
            SkillScope::Project => self.result.observed_project_paths.push(observed),
            SkillScope::Personal => self.result.observed_personal_paths.push(observed),
        }
    }

    fn failure(&mut self, adapter_id: AgentAdapterKind, path: &Path, code: &str, message: String) {
        push_failure(&mut self.result, adapter_id, path, code, message);
    }

    fn inside_allowed_boundary(&self, canonical: &Path) -> bool {
        self.allowed_boundaries
            .iter()
            .any(|boundary| canonical.starts_with(boundary))
    }

    fn scan_root(&mut self, root: &RootSpec<'_>) {
        let root_metadata = match fs::symlink_metadata(&root.root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                self.failure(
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
                self.failure(
                    root.adapter.id,
                    &root.root,
                    "skill_root_not_directory",
                    format!("Skill root is not a directory: {}", root.root.display()),
                );
                return;
            }
            Err(error) => {
                self.failure(
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
        if !self.inside_allowed_boundary(&canonical_root) {
            self.failure(
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
            self.failure(
                root.adapter.id,
                &root.root,
                "skill_root_not_directory",
                format!("Skill root is not a directory: {}", root.root.display()),
            );
            return;
        }
        let root_is_alias = root_metadata.file_type().is_symlink()
            || root
                .root
                .parent()
                .and_then(|parent| parent.canonicalize().ok())
                .zip(root.root.file_name())
                .is_some_and(|(parent, name)| canonical_root != parent.join(name));
        let mut folders = BTreeSet::from([canonical_root.clone()]);
        self.scan_directory(
            root,
            &root.root,
            &canonical_root,
            1,
            root_is_alias,
            &mut folders,
        );
    }

    /// The entries of `directory` at `depth` below the root: skills, flat
    /// skills and, where the layout reaches deeper, folders of skills.
    fn scan_directory(
        &mut self,
        root: &RootSpec<'_>,
        directory: &Path,
        canonical_directory: &Path,
        depth: usize,
        directory_is_alias: bool,
        folders: &mut BTreeSet<PathBuf>,
    ) {
        let entries = match bounded_entries(directory) {
            Ok(entries) => entries,
            Err(failure) => {
                self.failure(root.adapter.id, directory, failure.code, failure.message);
                return;
            }
        };
        if entries.truncated {
            self.failure(
                root.adapter.id,
                directory,
                "skill_root_entry_limit",
                format!(
                    "Skill root {} exceeded the {MAX_ROOT_ENTRIES} direct-entry scan limit",
                    directory.display()
                ),
            );
        }
        for entry in entries.paths {
            self.scan_entry(
                root,
                &entry,
                canonical_directory,
                depth,
                directory_is_alias,
                folders,
            );
        }
    }

    fn scan_entry(
        &mut self,
        root: &RootSpec<'_>,
        entry: &Path,
        canonical_directory: &Path,
        depth: usize,
        directory_is_alias: bool,
        folders: &mut BTreeSet<PathBuf>,
    ) {
        let Some(entry_name) = entry.file_name().and_then(|name| name.to_str()) else {
            self.failure(
                root.adapter.id,
                entry,
                "skill_entry_name",
                format!("Skill entry name is not valid UTF-8: {}", entry.display()),
            );
            return;
        };
        if entry_name.starts_with('.')
            || (depth > 1 && WALK_EXCLUDED_DIRS.contains(&entry_name))
            || (root.discovery_kind == SkillDiscoveryKind::ClaudePersonal
                && entry_name == CLAUDE_SYNCED_SKILLS_DIR)
        {
            return;
        }
        let direct_children = root.layout == SkillLayout::DIRECT_CHILDREN;
        let flat = entry_name.ends_with(".md")
            && match root.layout.flat {
                FlatSkills::None => false,
                FlatSkills::Root => depth == 1,
                FlatSkills::Nested => depth > 1,
            };
        let metadata = match fs::symlink_metadata(entry) {
            Ok(metadata) => metadata,
            Err(error) => {
                self.failure(
                    root.adapter.id,
                    entry,
                    "skill_entry_metadata",
                    format!("Could not inspect skill entry {}: {error}", entry.display()),
                );
                return;
            }
        };
        if metadata.is_file() && !flat {
            // A `*.md` file is a flat skill of other agents reading the
            // same root, not a materialized link.
            if direct_children && !entry_name.ends_with(".md") {
                self.failure(
                    root.adapter.id,
                    entry,
                    "skill_materialized_symlink",
                    format!(
                        "Skill entry {} is a plain file, possibly a materialized Git symlink, and was not followed",
                        entry.display()
                    ),
                );
            }
            return;
        }
        let canonical_entry = match entry.canonicalize() {
            Ok(path) if path.is_dir() || (flat && path.is_file()) => path,
            Ok(_) => {
                if direct_children && !entry_name.ends_with(".md") {
                    self.failure(
                        root.adapter.id,
                        entry,
                        "skill_entry_not_directory",
                        format!("Skill entry is not a directory: {}", entry.display()),
                    );
                }
                return;
            }
            Err(error) => {
                self.failure(
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
        if !self.inside_allowed_boundary(&canonical_entry) {
            self.failure(
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
        let entry_is_alias =
            directory_is_alias || canonical_entry != canonical_directory.join(entry_name);
        let link_kind = if metadata.file_type().is_symlink() {
            SkillLinkKind::SymbolicLink
        } else if entry_is_alias {
            SkillLinkKind::DirectoryAlias
        } else {
            SkillLinkKind::Direct
        };
        if canonical_entry.is_file() {
            let parsed = self
                .parsed_cache
                .entry(canonical_entry.clone())
                .or_insert_with(|| parse_flat_skill(&canonical_entry))
                .clone();
            self.register(root, entry, canonical_entry, link_kind, parsed);
            return;
        }
        let has_manifest = canonical_entry.join("SKILL.md").exists();
        // A skills-dir plugin of Claude Code is a plugin, not a skill; its
        // skills are its components, also for the agents that walk the
        // Claude skills folders deeper.
        if root.root.ends_with(".claude/skills")
            && !has_manifest
            && canonical_entry.join(CLAUDE_PLUGIN_MANIFEST).is_file()
        {
            return;
        }
        if !has_manifest && !direct_children {
            // A folder of skills, followed as deep as the agent does.
            if depth < root.layout.max_depth && folders.insert(canonical_entry.clone()) {
                if folders.len() > MAX_SKILL_FOLDERS {
                    self.failure(
                        root.adapter.id,
                        entry,
                        "skill_root_folder_limit",
                        format!(
                            "Skill root {} exceeded the {MAX_SKILL_FOLDERS}-folder scan limit",
                            root.root.display()
                        ),
                    );
                    return;
                }
                self.scan_directory(
                    root,
                    entry,
                    &canonical_entry,
                    depth + 1,
                    entry_is_alias,
                    folders,
                );
            }
            return;
        }

        let parsed = self
            .parsed_cache
            .entry(canonical_entry.clone())
            .or_insert_with(|| parse_skill(&canonical_entry))
            .clone();
        self.register(root, entry, canonical_entry.clone(), link_kind, parsed);
        // Codex also finds skills inside a skill directory.
        if root.layout.descend_into_skills
            && depth < root.layout.max_depth
            && folders.insert(canonical_entry.clone())
            && folders.len() <= MAX_SKILL_FOLDERS
        {
            self.scan_directory(
                root,
                entry,
                &canonical_entry,
                depth + 1,
                entry_is_alias,
                folders,
            );
        }
    }

    /// A skill the root's agent finds by `entry`: a new row for its canonical
    /// source or one more path of an existing row.
    fn register(
        &mut self,
        root: &RootSpec<'_>,
        entry: &Path,
        canonical_entry: PathBuf,
        link_kind: SkillLinkKind,
        parsed: Result<ParsedSkill, SkillFailure>,
    ) {
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(failure) => {
                let manifest = if canonical_entry.is_file() {
                    entry.to_path_buf()
                } else {
                    entry.join("SKILL.md")
                };
                self.failure(root.adapter.id, &manifest, failure.code, failure.message);
                return;
            }
        };
        if root.excluded_names.contains(&parsed.name) {
            return;
        }
        let Some(owner) = canonical_skill_owner(
            &canonical_entry,
            &self.places.repository_root,
            &self.places.directory_chain,
            &self.personal_owner_boundaries,
        ) else {
            self.failure(
                root.adapter.id,
                entry,
                "skill_owner_unresolved",
                format!(
                    "Could not resolve the canonical owner for skill {}",
                    canonical_entry.display()
                ),
            );
            return;
        };
        let alias = SkillDiscoveryAlias {
            adapter_id: root.adapter.id,
            scope: root.scope,
            discovery_kind: root.discovery_kind,
            path: path_string(entry),
            root: path_string(&root.root),
            owner: root.owner.clone(),
            support: SourceSupport::ClientNative,
            resolution: SourceResolution::Included,
            superseded_by: None,
            link_kind,
        };
        self.registrations.push(Registration {
            agent: root.adapter.id,
            canonical: canonical_entry.clone(),
            path: alias.path.clone(),
            root: alias.root.clone(),
            nearness: root.nearness,
        });
        if let Some(row) = self.rows.get_mut(&canonical_entry) {
            row.aliases.push(alias);
            return;
        }
        let validation = if parsed.warnings.is_empty() {
            SkillValidationStatus::Valid
        } else {
            SkillValidationStatus::Warning
        };
        self.rows.insert(
            canonical_entry.clone(),
            SkillRow {
                id: format!("skill:{}", path_string(&canonical_entry)),
                name: parsed.name,
                description: parsed.description,
                path: path_string(&parsed.manifest_path),
                canonical_path: path_string(&canonical_entry),
                owner,
                license: parsed.license,
                compatibility: parsed.compatibility,
                metadata: parsed.metadata,
                allowed_tools: parsed.allowed_tools,
                validation,
                health: if parsed.warnings.is_empty() {
                    SourceHealth::Normal
                } else {
                    SourceHealth::Degraded
                },
                health_reasons: parsed.warnings.clone(),
                warnings: parsed.warnings,
                preview: parsed.preview,
                aliases: vec![alias],
            },
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

fn canonical_skill_owner(
    canonical_entry: &Path,
    repository_root: &Path,
    directory_chain: &[PathBuf],
    personal_owner_boundaries: &[CanonicalOwnerBoundary],
) -> Option<InstructionOwner> {
    if canonical_entry.starts_with(repository_root) {
        let owner_root = directory_chain
            .iter()
            .rev()
            .find(|candidate| canonical_entry.starts_with(candidate))
            .map_or(repository_root, PathBuf::as_path);
        return Some(InstructionOwner {
            kind: InstructionOwnerKind::TargetSpace,
            root: path_string(owner_root),
        });
    }

    personal_owner_boundaries
        .iter()
        .find(|boundary| canonical_entry.starts_with(&boundary.root))
        .map(|boundary| boundary.owner.clone())
}

/// A skill a plugin brings: its row without discovery paths, which are the
/// plugin's. A failure is a diagnostic code and message.
pub(super) fn plugin_skill(
    canonical_entry: &Path,
    owner: &InstructionOwner,
) -> Result<SkillRow, (&'static str, String)> {
    let parsed = parse_skill(canonical_entry).map_err(|failure| (failure.code, failure.message))?;
    Ok(SkillRow {
        id: format!("skill:{}", path_string(canonical_entry)),
        name: parsed.name,
        description: parsed.description,
        path: path_string(&parsed.manifest_path),
        canonical_path: path_string(canonical_entry),
        owner: owner.clone(),
        license: parsed.license,
        compatibility: parsed.compatibility,
        metadata: parsed.metadata,
        allowed_tools: parsed.allowed_tools,
        validation: if parsed.warnings.is_empty() {
            SkillValidationStatus::Valid
        } else {
            SkillValidationStatus::Warning
        },
        health: if parsed.warnings.is_empty() {
            SourceHealth::Normal
        } else {
            SourceHealth::Degraded
        },
        health_reasons: parsed.warnings.clone(),
        warnings: parsed.warnings,
        preview: parsed.preview,
        aliases: Vec::new(),
    })
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
    let directory_name = canonical_entry.file_name().and_then(|value| value.to_str());
    parse_manifest(
        &canonical_manifest,
        &manifest_path,
        directory_name.map(|name| {
            (
                name,
                "Skill name does not match its canonical directory name",
            )
        }),
    )
}

/// A plain `*.md` file that an agent takes as a skill: its frontmatter is
/// read like `SKILL.md`, and its name should match the file name.
fn parse_flat_skill(canonical_file: &Path) -> Result<ParsedSkill, SkillFailure> {
    let file_name = canonical_file.file_stem().and_then(|value| value.to_str());
    parse_manifest(
        canonical_file,
        canonical_file,
        file_name.map(|name| (name, "Skill name does not match its file name")),
    )
}

/// `expected_name` is the name the skill's place gives it, with the warning
/// when the frontmatter differs.
fn parse_manifest(
    canonical_manifest: &Path,
    manifest_path: &Path,
    expected_name: Option<(&str, &str)>,
) -> Result<ParsedSkill, SkillFailure> {
    let raw = read_bounded_stable(canonical_manifest)?;
    let (frontmatter, body) = split_frontmatter(&raw)?;
    let document: serde_norway::Value =
        serde_norway::from_str(frontmatter).map_err(|error| SkillFailure {
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
    let name = required_string(mapping, "name", manifest_path)?;
    let description = required_string(mapping, "description", manifest_path)?;
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
    if let Some((expected, warning)) = expected_name
        && expected != trimmed_name
    {
        warnings.push(warning.to_string());
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
    let metadata = optional_metadata(mapping, &mut warnings);
    let allowed_tools = optional_string(mapping, "allowed-tools", &mut warnings);
    Ok(ParsedSkill {
        name: trimmed_name,
        description: trimmed_description,
        license,
        compatibility,
        metadata,
        allowed_tools,
        warnings,
        preview: MarkdownPreview {
            markdown: body.to_string(),
            truncated: false,
            bytes_read: body.len(),
            total_bytes: body.len() as u64,
        },
        manifest_path: canonical_manifest.to_path_buf(),
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
    mapping: &serde_norway::Mapping,
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
    mapping: &serde_norway::Mapping,
    key: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match mapping.get(key) {
        Some(value) => match value.as_str() {
            Some(value) if value.trim().is_empty() => {
                warnings.push(format!("Skill {key} is empty"));
                None
            }
            Some(value) => Some(value.to_string()),
            None => {
                warnings.push(format!("Skill {key} is not a string"));
                None
            }
        },
        None => None,
    }
}

/// Keeps `metadata` values a reader can show: scalars as text, lists of
/// scalars and objects of them. Anything else is a warning and is dropped.
fn optional_metadata(
    mapping: &serde_norway::Mapping,
    warnings: &mut Vec<String>,
) -> Option<BTreeMap<String, SkillMetadataValue>> {
    let value = mapping.get("metadata")?;
    let Some(entries) = value.as_mapping() else {
        warnings.push("Skill metadata is not a mapping".to_string());
        return None;
    };
    let mut normalized = BTreeMap::new();
    for (entry_key, entry_value) in entries {
        let Some(entry_key) = entry_key.as_str() else {
            warnings.push("Skill metadata contains a non-string key".to_string());
            continue;
        };
        let Some(entry_value) = metadata_value(entry_value) else {
            warnings.push(format!(
                "Skill metadata value for {entry_key} is not a scalar, a list of scalars or an object of them"
            ));
            continue;
        };
        normalized.insert(entry_key.to_string(), entry_value);
    }
    Some(normalized)
}

fn metadata_value(value: &serde_norway::Value) -> Option<SkillMetadataValue> {
    if let Some(leaf) = metadata_leaf(value) {
        return Some(match leaf {
            SkillMetadataLeaf::Text(text) => SkillMetadataValue::Text(text),
            SkillMetadataLeaf::List(items) => SkillMetadataValue::List(items),
        });
    }
    let entries = value.as_mapping()?;
    let mut object = BTreeMap::new();
    for (key, value) in entries {
        object.insert(key.as_str()?.to_string(), metadata_leaf(value)?);
    }
    Some(SkillMetadataValue::Object(object))
}

fn metadata_leaf(value: &serde_norway::Value) -> Option<SkillMetadataLeaf> {
    if let Some(text) = metadata_scalar(value) {
        return Some(SkillMetadataLeaf::Text(text));
    }
    value
        .as_sequence()?
        .iter()
        .map(metadata_scalar)
        .collect::<Option<Vec<_>>>()
        .map(SkillMetadataLeaf::List)
}

fn metadata_scalar(value: &serde_norway::Value) -> Option<String> {
    match value {
        serde_norway::Value::String(text) => Some(text.clone()),
        serde_norway::Value::Bool(flag) => Some(flag.to_string()),
        serde_norway::Value::Number(number) => Some(number.to_string()),
        _ => None,
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

fn apply_personal_shadowing(
    rows: &mut BTreeMap<PathBuf, SkillRow>,
    adapters: &BTreeSet<AgentAdapterKind>,
) {
    let mut personal_names = BTreeMap::new();
    for row in rows.values() {
        for alias in &row.aliases {
            if adapters.contains(&alias.adapter_id) && alias.scope == SkillScope::Personal {
                personal_names
                    .entry((alias.adapter_id, row.name.clone()))
                    .or_insert_with(|| alias.path.clone());
            }
        }
    }
    for row in rows.values_mut() {
        for alias in &mut row.aliases {
            if alias.scope != SkillScope::Project {
                continue;
            }
            if let Some(personal) = personal_names.get(&(alias.adapter_id, row.name.clone())) {
                alias.resolution = SourceResolution::Superseded;
                alias.superseded_by = Some(personal.clone());
            }
        }
    }
}

/// For agents where one skill of a key wins, every other path the agent
/// registers with that key is shadowed by the winner's path.
fn apply_registration_precedence(
    rows: &mut BTreeMap<PathBuf, SkillRow>,
    adapters: &[AgentSourcePolicy],
    registrations: &[Registration],
) {
    for adapter in adapters {
        let (key, last_wins, nearest) = match adapter.capabilities.skills.precedence {
            SkillPrecedence::FirstWins(key) => (key, false, false),
            SkillPrecedence::LastWins(key) => (key, true, false),
            SkillPrecedence::NearestFirstWins(key) => (key, false, true),
            SkillPrecedence::Coexist | SkillPrecedence::ClaudePersonalShadowsProject => continue,
        };
        let mut keyed = registrations
            .iter()
            .filter(|registration| registration.agent == adapter.id)
            .filter_map(|registration| {
                let row = rows.get(&registration.canonical)?;
                Some((skill_key(key, row, registration), registration))
            })
            .collect::<Vec<_>>();
        if nearest {
            keyed.sort_by_key(|(_, registration)| registration.nearness);
        }
        let mut winners = BTreeMap::<&str, &Registration>::new();
        for (key, registration) in &keyed {
            if last_wins || !winners.contains_key(key.as_str()) {
                winners.insert(key, registration);
            }
        }
        let shadowed = keyed
            .iter()
            .filter_map(|(key, registration)| {
                let winner = winners.get(key.as_str())?;
                (!std::ptr::eq(*winner, *registration)).then(|| {
                    (
                        registration.canonical.clone(),
                        registration.path.clone(),
                        winner.path.clone(),
                    )
                })
            })
            .collect::<Vec<_>>();
        for (canonical, path, winner) in shadowed {
            let Some(row) = rows.get_mut(&canonical) else {
                continue;
            };
            for alias in &mut row.aliases {
                if alias.adapter_id == adapter.id && alias.path == path {
                    alias.resolution = SourceResolution::Superseded;
                    alias.superseded_by = Some(winner.clone());
                }
            }
        }
    }
}

fn skill_key(key: SkillKey, row: &SkillRow, registration: &Registration) -> String {
    let path = registration.path.as_str();
    match key {
        SkillKey::Name => row.name.clone(),
        SkillKey::NameIgnoringCase => row.name.to_lowercase(),
        SkillKey::PathId => {
            let path = Path::new(path);
            let id = if row.path == row.canonical_path {
                path.file_stem()
            } else {
                path.file_name()
            };
            id.map(|id| id.to_string_lossy().into_owned())
                .unwrap_or_default()
        }
        SkillKey::RootParentPath => {
            let root = Path::new(&registration.root);
            let parent = root.parent().and_then(Path::parent).unwrap_or(root);
            let inside = Path::new(path)
                .strip_prefix(root)
                .unwrap_or(Path::new(path));
            format!("{}\0{}", parent.display(), inside.display())
        }
    }
}

fn push_failure(
    result: &mut DiscoveryResult,
    adapter_id: AgentAdapterKind,
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
        SkillDiscoveryKind::CodexHome => 1,
        SkillDiscoveryKind::CodexProject => 2,
        SkillDiscoveryKind::CodexProjectConfig => 3,
        SkillDiscoveryKind::ClaudePersonal => 4,
        SkillDiscoveryKind::ClaudeProject => 5,
        SkillDiscoveryKind::PersonalRoot => 6,
        SkillDiscoveryKind::ProjectRoot => 7,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_adapters::SourceRegistryEnvironment;
    use crate::agent_context::model::AgentContextDiscovery;
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

    fn scan(
        project: &Path,
        space: &Path,
        environment: &SourceRegistryEnvironment,
    ) -> Result<AgentContextDiscovery, crate::agent_context::AgentContextError> {
        crate::agent_context::scanner::discover(project, space, environment, &AgentAdapterKind::ALL)
    }

    /// Paths of Codex and Claude Code: the agents of later policies read
    /// the same roots and add their own.
    fn codex_and_claude(row: &SkillRow) -> Vec<&SkillDiscoveryAlias> {
        row.aliases
            .iter()
            .filter(|alias| {
                matches!(
                    alias.adapter_id,
                    AgentAdapterKind::Codex | AgentAdapterKind::ClaudeCode
                )
            })
            .collect()
    }

    fn setup() -> (TempDir, TempDir, SourceRegistryEnvironment) {
        let project = TempDir::new().unwrap();
        fs::create_dir(project.path().join(".git")).unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
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
        assert_eq!(
            valid.metadata.as_ref().unwrap().get("author"),
            Some(&SkillMetadataValue::Text("Svode".to_string()))
        );
        assert_eq!(valid.allowed_tools.as_deref(), Some("Read"));
        assert_eq!(valid.preview.markdown, "# Valid\nbody\n");
        assert!(snapshot.skills.iter().any(|row| {
            row.name == "Warning" && row.validation == SkillValidationStatus::Warning
        }));
        let warning = snapshot
            .skills
            .iter()
            .find(|row| row.name == "Warning")
            .unwrap();
        assert_eq!(warning.health, SourceHealth::Degraded);
        assert_eq!(warning.health_reasons, warning.warnings);
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

    #[test]
    fn metadata_keeps_scalars_lists_and_objects_and_warns_only_on_deeper_values() {
        let (project, _home, environment) = setup();
        let root = project.path().join(".agents/skills");
        let shaped = write_skill(&root, "shaped", "shaped", Some("Shaped skill"));
        fs::write(
            shaped.join("SKILL.md"),
            "---\nname: shaped\ndescription: Shaped skill\nmetadata:\n  author: Svode\n  stable: true\n  tags:\n    - review\n    - git\n  owner:\n    team: core\n    channels: [desk, mail]\n---\n# Shaped\n",
        )
        .unwrap();
        let deep = write_skill(&root, "deep", "deep", Some("Deep skill"));
        fs::write(
            deep.join("SKILL.md"),
            "---\nname: deep\ndescription: Deep skill\nmetadata:\n  author: Svode\n  nested:\n    inner:\n      level: 3\n  mixed:\n    - plain\n    - key: value\n  empty: ~\n---\n# Deep\n",
        )
        .unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let shaped = snapshot
            .skills
            .iter()
            .find(|row| row.name == "shaped")
            .unwrap();
        assert_eq!(shaped.validation, SkillValidationStatus::Valid);
        assert_eq!(shaped.health, SourceHealth::Normal);
        assert!(shaped.warnings.is_empty());
        let metadata = shaped.metadata.as_ref().unwrap();
        assert_eq!(
            metadata.get("stable"),
            Some(&SkillMetadataValue::Text("true".to_string()))
        );
        assert_eq!(
            metadata.get("tags"),
            Some(&SkillMetadataValue::List(vec![
                "review".to_string(),
                "git".to_string()
            ]))
        );
        assert_eq!(
            metadata.get("owner"),
            Some(&SkillMetadataValue::Object(BTreeMap::from([
                (
                    "channels".to_string(),
                    SkillMetadataLeaf::List(vec!["desk".to_string(), "mail".to_string()])
                ),
                (
                    "team".to_string(),
                    SkillMetadataLeaf::Text("core".to_string())
                ),
            ])))
        );

        let deep = snapshot
            .skills
            .iter()
            .find(|row| row.name == "deep")
            .unwrap();
        assert_eq!(deep.health, SourceHealth::Degraded);
        let metadata = deep.metadata.as_ref().unwrap();
        assert_eq!(metadata.len(), 1);
        assert!(metadata.contains_key("author"));
        for key in ["nested", "mixed", "empty"] {
            assert!(deep.warnings.iter().any(|warning| warning
                == &format!(
                    "Skill metadata value for {key} is not a scalar, a list of scalars or an object of them"
                )));
        }
    }

    #[test]
    fn invalid_optional_frontmatter_isolated_without_losing_safe_values_or_body() {
        let (project, _home, environment) = setup();
        let root = project.path().join(".agents/skills");
        let mixed = write_skill(&root, "mixed", "mixed", Some("Mixed skill"));
        fs::write(
            mixed.join("SKILL.md"),
            "---\nname: mixed\ndescription: Mixed skill\nlicense: MIT\ncompatibility:\n  - desktop\nmetadata:\n  author: Svode\n  retries: 3\n  7: ignored\nallowed-tools:\n  - Read\n---\n# Mixed\nbody remains readable\n",
        )
        .unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let mixed = snapshot
            .skills
            .iter()
            .find(|row| row.name == "mixed")
            .unwrap();

        assert_eq!(mixed.license.as_deref(), Some("MIT"));
        assert_eq!(mixed.compatibility, None);
        assert_eq!(mixed.allowed_tools, None);
        let metadata = mixed.metadata.as_ref().unwrap();
        assert_eq!(
            metadata.get("author"),
            Some(&SkillMetadataValue::Text("Svode".to_string()))
        );
        // A number is a scalar and reads as text.
        assert_eq!(
            metadata.get("retries"),
            Some(&SkillMetadataValue::Text("3".to_string()))
        );
        assert_eq!(metadata.len(), 2);
        assert_eq!(mixed.preview.markdown, "# Mixed\nbody remains readable\n");
        assert_eq!(mixed.validation, SkillValidationStatus::Warning);
        assert_eq!(mixed.health, SourceHealth::Degraded);
        assert!(
            mixed
                .warnings
                .iter()
                .any(|warning| warning == "Skill compatibility is not a string")
        );
        assert!(
            !mixed
                .warnings
                .iter()
                .any(|warning| warning.contains("value for retries"))
        );
        assert!(
            mixed
                .warnings
                .iter()
                .any(|warning| warning == "Skill metadata contains a non-string key")
        );
        assert!(
            mixed
                .warnings
                .iter()
                .any(|warning| warning == "Skill allowed-tools is not a string")
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
        fs::create_dir_all(&standard).unwrap();
        let personal_source = write_skill(&standard, "personal", "personal", Some("Personal"));
        write_skill(
            &home.path().join(".codex/skills"),
            "codex-home",
            "codex-home",
            Some("Codex home root"),
        );

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
                .any(|alias| alias.adapter_id == AgentAdapterKind::Codex)
                && row
                    .aliases
                    .iter()
                    .any(|alias| alias.adapter_id == AgentAdapterKind::ClaudeCode)
        }));
        let personal = snapshot
            .skills
            .iter()
            .find(|row| row.name == "personal")
            .unwrap();
        assert_eq!(codex_and_claude(personal).len(), 1);
        assert!(
            codex_and_claude(personal)
                .iter()
                .any(|alias| { alias.discovery_kind == SkillDiscoveryKind::CodexStandardPersonal })
        );
        assert_eq!(
            personal.canonical_path,
            path_string(&personal_source.canonicalize().unwrap())
        );
        assert_eq!(
            kinds_of(&snapshot, "codex-home"),
            vec![SkillDiscoveryKind::CodexHome]
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_alias_keeps_the_canonical_personal_owner() {
        use std::os::unix::fs::symlink;

        let (project, home, environment) = setup();
        let personal_root = home.path().join(".agents/skills");
        let personal_source = write_skill(
            &personal_root.join(".sources"),
            "personal-only",
            "personal-only",
            Some("Personal only"),
        );
        let project_root = project.path().join(".agents/skills");
        fs::create_dir_all(&project_root).unwrap();
        symlink(&personal_source, project_root.join("personal-link")).unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let row = snapshot
            .skills
            .iter()
            .find(|row| row.name == "personal-only")
            .unwrap();

        assert_eq!(codex_and_claude(row).len(), 1);
        assert_eq!(codex_and_claude(row)[0].scope, SkillScope::Project);
        assert_eq!(row.owner.kind, InstructionOwnerKind::ClientConfiguration);
        assert_eq!(row.owner.root, path_string(&personal_root));
        assert!(
            Path::new(&row.path).starts_with(Path::new(&row.owner.root).canonicalize().unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn personal_alias_keeps_the_canonical_project_owner() {
        use std::os::unix::fs::symlink;

        let (project, home, environment) = setup();
        let project_source = write_skill(
            &project.path().join("sources"),
            "project-only",
            "project-only",
            Some("Project only"),
        );
        let personal_root = home.path().join(".agents/skills");
        fs::create_dir_all(&personal_root).unwrap();
        symlink(&project_source, personal_root.join("project-link")).unwrap();

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let row = snapshot
            .skills
            .iter()
            .find(|row| row.name == "project-only")
            .unwrap();

        assert_eq!(codex_and_claude(row).len(), 1);
        assert_eq!(codex_and_claude(row)[0].scope, SkillScope::Personal);
        assert_eq!(row.owner.kind, InstructionOwnerKind::TargetSpace);
        assert_eq!(
            row.owner.root,
            path_string(&project.path().canonicalize().unwrap())
        );
        assert!(Path::new(&row.path).starts_with(Path::new(&row.owner.root)));
    }

    #[cfg(unix)]
    #[test]
    fn skill_root_alias_keeps_link_provenance_without_degrading_health() {
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

        assert_eq!(codex_and_claude(row).len(), 1);
        assert!(codex_and_claude(row).iter().any(|alias| {
            alias.scope == SkillScope::Project
                && alias.link_kind == SkillLinkKind::DirectoryAlias
                && alias.resolution == SourceResolution::Included
        }));
        assert_eq!(row.health, SourceHealth::Normal);
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
            alias.scope == SkillScope::Project && alias.resolution == SourceResolution::Superseded
        })));
        assert!(review.iter().any(|row| row.aliases.iter().any(|alias| {
            alias.scope == SkillScope::Personal && alias.resolution == SourceResolution::Included
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
        let names = |snapshot: &AgentContextDiscovery| {
            snapshot
                .skills
                .iter()
                .filter(|skill| !codex_and_claude(skill).is_empty())
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
        // opencode walks `.agents/skills` up to the filesystem root, past
        // the independent repository, as a source outside its boundary.
        let root_skill = independent_snapshot
            .skills
            .iter()
            .find(|skill| skill.name == "root-skill")
            .unwrap();
        assert!(root_skill.aliases.iter().all(|alias| {
            alias.adapter_id == AgentAdapterKind::Opencode && alias.scope == SkillScope::Personal
        }));
    }

    #[cfg(unix)]
    #[test]
    fn connected_svode_payload_is_read_through_claude_plugin_and_shared_skill_links() {
        use std::os::unix::fs::symlink;

        let (project, home, environment) = setup();
        let runtime = home.path().join(".svode/runtimes/desktop-1");
        let plugin = runtime.join("plugins/svode");
        fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            "{\"name\":\"svode\"}",
        )
        .unwrap();
        write_skill(
            &plugin.join("skills"),
            "svode",
            "svode",
            Some("Svode payload"),
        );
        symlink("runtimes/desktop-1", home.path().join(".svode/current")).unwrap();
        let stable_plugin = home.path().join(".svode/current/plugins/svode");
        fs::create_dir_all(home.path().join(".claude/skills")).unwrap();
        fs::create_dir_all(home.path().join(".agents/skills")).unwrap();
        symlink(&stable_plugin, home.path().join(".claude/skills/svode")).unwrap();
        symlink(
            stable_plugin.join("skills/svode"),
            home.path().join(".agents/skills/svode"),
        )
        .unwrap();
        write_skill(
            &home.path().join(".claude/skills/synced/bucket"),
            "synced-skill",
            "synced-skill",
            Some("Synced"),
        );
        write_skill(
            &project.path().join(".claude/skills"),
            "svode",
            "svode",
            Some("Project"),
        );

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();

        assert!(
            snapshot.diagnostics.is_empty(),
            "unexpected diagnostics: {:?}",
            snapshot.diagnostics
        );
        let payload = snapshot
            .skills
            .iter()
            .find(|row| row.description == "Svode payload")
            .expect("payload skill row");
        assert!(payload.canonical_path.contains("runtimes/desktop-1"));
        assert_eq!(
            payload.owner.kind,
            InstructionOwnerKind::ClientConfiguration
        );
        assert_eq!(payload.owner.root, path_string(&home.path().join(".svode")));
        // Claude Code reads it through its plugin, a plugin row of its own.
        assert_eq!(codex_and_claude(payload).len(), 1);
        assert!(payload.aliases.iter().any(|alias| {
            alias.adapter_id == AgentAdapterKind::Codex
                && alias.discovery_kind == SkillDiscoveryKind::CodexStandardPersonal
                && alias.link_kind == SkillLinkKind::SymbolicLink
                && alias.resolution == SourceResolution::Included
        }));
        let project_svode = snapshot
            .skills
            .iter()
            .find(|row| row.description == "Project")
            .expect("project skill row");
        assert!(
            codex_and_claude(project_svode)
                .iter()
                .all(|alias| alias.resolution == SourceResolution::Included)
        );
        assert!(
            snapshot
                .skills
                .iter()
                .filter(|row| row.name == "synced-skill")
                .all(|row| codex_and_claude(row).is_empty())
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

    /// Skills of the agents of the `.agents` family in a repository at
    /// `~/work/repo` with an inline target `docs`.
    struct AgentsFixture {
        _home: TempDir,
        environment: SourceRegistryEnvironment,
    }

    impl AgentsFixture {
        fn new() -> Self {
            let home = TempDir::new().unwrap();
            let home_path = home.path().canonicalize().unwrap();
            fs::create_dir_all(home_path.join("work/repo/.git")).unwrap();
            fs::create_dir_all(home_path.join("work/repo/docs")).unwrap();
            Self {
                environment: SourceRegistryEnvironment::for_tests(home_path),
                _home: home,
            }
        }

        fn home(&self) -> &Path {
            &self.environment.home_dir
        }

        fn skill(&self, relative: &str, name: &str) {
            let directory = self.home().join(relative);
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {name} skill\n---\n# {name}\n"),
            )
            .unwrap();
        }

        fn flat(&self, relative: &str, name: &str) {
            let path = self.home().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!("---\nname: {name}\ndescription: {name} skill\n---\n# {name}\n"),
            )
            .unwrap();
        }

        fn discover(&self, target: &str, enabled: &[AgentAdapterKind]) -> AgentContextDiscovery {
            let repo = self.home().join("work/repo");
            crate::agent_context::scanner::discover(
                &repo,
                &repo.join(target),
                &self.environment,
                enabled,
            )
            .unwrap()
        }

        /// The paths by which `agent` finds skills, from `~`, with how it
        /// takes them.
        fn found_by(
            &self,
            discovery: &AgentContextDiscovery,
            agent: AgentAdapterKind,
        ) -> Vec<(String, SourceResolution)> {
            let mut found = discovery
                .skills
                .iter()
                .flat_map(|row| &row.aliases)
                .filter(|alias| alias.adapter_id == agent)
                .map(|alias| {
                    (
                        Path::new(&alias.path)
                            .strip_prefix(self.home())
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        alias.resolution,
                    )
                })
                .collect::<Vec<_>>();
            found.sort_by(|left, right| left.0.cmp(&right.0));
            found
        }
    }

    fn found(entries: &[(&str, SourceResolution)]) -> Vec<(String, SourceResolution)> {
        let mut found = entries
            .iter()
            .map(|(path, resolution)| ((*path).to_string(), *resolution))
            .collect::<Vec<_>>();
        found.sort_by(|left, right| left.0.cmp(&right.0));
        found
    }

    #[test]
    fn opencode_finds_claude_and_agents_skills_up_to_the_filesystem_root_and_the_last_wins() {
        use SourceResolution::{Included, Superseded};
        let fixture = AgentsFixture::new();
        fixture.skill(".claude/skills/claude-only", "claude-only");
        fixture.skill(".agents/skills/review", "review");
        fixture.skill("work/.agents/skills/above", "above");
        fixture.skill("work/repo/.claude/skills/review", "review");
        fixture.flat("work/repo/.agents/skills/notes.md", "notes");
        fixture.flat("work/repo/.agents/skills/group/nested.md", "nested");
        fixture.skill("work/repo/.agents/skills/group/deep", "deep");
        fixture.skill("work/repo/.opencode/skills/review", "review");

        let disabled = fixture.discover("", &[]);
        assert_eq!(
            fixture.found_by(&disabled, AgentAdapterKind::Opencode),
            found(&[
                ("work/repo/.agents/skills/group/deep", Included),
                ("work/repo/.agents/skills/notes.md", Included),
                ("work/repo/.claude/skills/review", Superseded),
                ("work/repo/.opencode/skills/review", Included),
            ])
        );

        let enabled = fixture.discover("", &[AgentAdapterKind::Opencode]);
        assert_eq!(
            fixture.found_by(&enabled, AgentAdapterKind::Opencode),
            found(&[
                (".agents/skills/review", Superseded),
                (".claude/skills/claude-only", Included),
                ("work/.agents/skills/above", Included),
                ("work/repo/.agents/skills/group/deep", Included),
                ("work/repo/.agents/skills/notes.md", Included),
                ("work/repo/.claude/skills/review", Superseded),
                ("work/repo/.opencode/skills/review", Included),
            ])
        );
        let above = enabled
            .skills
            .iter()
            .find(|row| row.name == "above")
            .unwrap();
        assert_eq!(above.aliases[0].scope, SkillScope::Personal);
        let notes = enabled
            .skills
            .iter()
            .find(|row| row.name == "notes")
            .unwrap();
        assert_eq!(notes.path, notes.canonical_path);
        assert!(notes.path.ends_with("notes.md"));
        assert_eq!(notes.preview.markdown, "# notes\n");
        assert!(
            notes
                .aliases
                .iter()
                .all(|alias| alias.adapter_id != AgentAdapterKind::Codex)
        );
    }

    #[test]
    fn pi_takes_flat_skills_by_its_two_modes_and_the_first_of_a_name() {
        use SourceResolution::{Included, Superseded};
        let fixture = AgentsFixture::new();
        fixture.skill(".pi/agent/skills/review", "review");
        fixture.flat(".pi/agent/skills/personal.md", "personal");
        fixture.skill("work/repo/.pi/skills/review", "review");
        fixture.flat("work/repo/.pi/skills/flat.md", "flat");
        fixture.flat("work/repo/.agents/skills/root.md", "root");
        fixture.flat("work/repo/.agents/skills/group/nested.md", "nested");
        fixture.skill("work/.agents/skills/above", "above");

        let enabled = fixture.discover("", &[AgentAdapterKind::Pi]);
        assert_eq!(
            fixture.found_by(&enabled, AgentAdapterKind::Pi),
            found(&[
                (".pi/agent/skills/personal.md", Included),
                (".pi/agent/skills/review", Superseded),
                ("work/repo/.agents/skills/group/nested.md", Included),
                ("work/repo/.pi/skills/flat.md", Included),
                ("work/repo/.pi/skills/review", Included),
            ])
        );
        let nested = enabled
            .skills
            .iter()
            .find(|row| row.name == "nested")
            .unwrap();
        assert!(
            nested
                .aliases
                .iter()
                .all(|alias| alias.adapter_id == AgentAdapterKind::Pi)
        );
    }

    #[test]
    fn qwen_code_finds_skills_only_in_the_target_with_its_own_folder_first() {
        use SourceResolution::{Included, Superseded};
        let fixture = AgentsFixture::new();
        fixture.skill(".qwen/skills/review", "review");
        fixture.skill("work/repo/.agents/skills/root-skill", "root-skill");
        fixture.skill("work/repo/docs/.qwen/skills/review", "review");
        fixture.skill("work/repo/docs/.agents/skills/review", "review");
        fixture.skill("work/repo/docs/.agents/skills/docs-skill", "docs-skill");

        let enabled = fixture.discover("docs", &[AgentAdapterKind::QwenCode]);
        assert_eq!(
            fixture.found_by(&enabled, AgentAdapterKind::QwenCode),
            found(&[
                (".qwen/skills/review", Superseded),
                ("work/repo/docs/.agents/skills/docs-skill", Included),
                ("work/repo/docs/.agents/skills/review", Superseded),
                ("work/repo/docs/.qwen/skills/review", Included),
            ])
        );
    }

    #[test]
    fn kimi_code_finds_skills_of_the_git_root_with_folders_flat_files_and_names_ignoring_case() {
        use SourceResolution::{Included, Superseded};
        let fixture = AgentsFixture::new();
        fixture.skill(".kimi-code/skills/personal", "personal");
        fixture.skill("work/repo/.kimi-code/skills/Review", "Review");
        fixture.flat("work/repo/.kimi-code/skills/quick.md", "quick");
        fixture.skill("work/repo/.kimi-code/skills/category/sub/deep", "deep");
        fixture.skill("work/repo/.agents/skills/review", "review");
        fixture.skill("work/repo/docs/.agents/skills/docs-skill", "docs-skill");

        let disabled = fixture.discover("docs", &[]);
        assert_eq!(
            fixture.found_by(&disabled, AgentAdapterKind::KimiCode),
            found(&[
                ("work/repo/.agents/skills/review", Superseded),
                ("work/repo/.kimi-code/skills/Review", Included),
                ("work/repo/.kimi-code/skills/category/sub/deep", Included),
                ("work/repo/.kimi-code/skills/quick.md", Included),
            ])
        );
        let enabled = fixture.discover("docs", &[AgentAdapterKind::KimiCode]);
        assert!(
            fixture
                .found_by(&enabled, AgentAdapterKind::KimiCode)
                .contains(&(".kimi-code/skills/personal".to_string(), Included))
        );
    }

    #[test]
    fn a_flat_file_without_frontmatter_is_a_diagnostic_only_where_an_agent_takes_it() {
        let fixture = AgentsFixture::new();
        let root = fixture.home().join("work/repo/.agents/skills");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "# Not a skill\n").unwrap();

        let discovery = fixture.discover("", &[]);
        assert!(discovery.skills.is_empty());
        let readme = discovery
            .diagnostics
            .iter()
            .filter(|diagnostic| {
                diagnostic
                    .path
                    .as_deref()
                    .is_some_and(|path| path.ends_with("README.md"))
            })
            .map(|diagnostic| (diagnostic.adapter_id, diagnostic.code.as_str()))
            .collect::<Vec<_>>();
        assert!(readme.contains(&(
            Some(AgentAdapterKind::Opencode),
            "skill_frontmatter_missing"
        )));
        assert!(readme.contains(&(
            Some(AgentAdapterKind::KimiCode),
            "skill_frontmatter_missing"
        )));
        // Agents that take only skill folders ignore it.
        assert!(readme.iter().all(|(agent, _)| matches!(
            agent,
            Some(AgentAdapterKind::Opencode | AgentAdapterKind::KimiCode)
        )));
    }

    #[test]
    fn the_opencode_compatibility_plugin_switches_its_claude_and_agents_skills() {
        use SourceResolution::Included;
        let fixture = AgentsFixture::new();
        fixture.skill(".claude/skills/claude-home", "claude-home");
        fixture.skill("work/repo/.agents/skills/shared", "shared");
        fixture.skill("work/repo/.opencode/skills/own", "own");
        let write = |relative: &str, text: &str| {
            let path = fixture.home().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        write(
            ".config/opencode/opencode.jsonc",
            "{\n  // off\n  \"plugins\": [\"-opencode.config.compatibility\"],\n  \"provider\": { \"x\": { \"options\": { \"apiKey\": \"secret-value\" } } },\n}",
        );
        let opencode = AgentAdapterKind::Opencode;

        let switched_off = fixture.discover("", &[opencode]);
        assert_eq!(
            fixture.found_by(&switched_off, opencode),
            found(&[("work/repo/.opencode/skills/own", Included)])
        );
        assert!(!format!("{switched_off:?}").contains("secret-value"));
        // The global config of a disabled agent is not read.
        assert_eq!(
            fixture.found_by(&fixture.discover("", &[]), opencode),
            found(&[
                ("work/repo/.agents/skills/shared", Included),
                ("work/repo/.opencode/skills/own", Included),
            ])
        );

        // A later config turns it on again.
        write(
            "work/repo/opencode.json",
            "{ \"plugin\": [\"opencode.config.*\"] }",
        );
        assert_eq!(
            fixture.found_by(&fixture.discover("", &[opencode]), opencode),
            found(&[
                (".claude/skills/claude-home", Included),
                ("work/repo/.agents/skills/shared", Included),
                ("work/repo/.opencode/skills/own", Included),
            ])
        );

        // A `.opencode` config of the project weighs more than any direct one.
        write(
            "work/repo/.opencode/opencode.json",
            "{ \"plugins\": [\"-*\"] }",
        );
        assert_eq!(
            fixture.found_by(&fixture.discover("", &[]), opencode),
            found(&[("work/repo/.opencode/skills/own", Included)])
        );
        // Codex reads `.agents/skills` whatever opencode does.
        assert!(
            fixture
                .found_by(&fixture.discover("", &[]), AgentAdapterKind::Codex)
                .contains(&("work/repo/.agents/skills/shared".to_string(), Included))
        );

        write("work/repo/.opencode/opencode.json", "{ \"plugins\": [ ");
        let broken = fixture.discover("", &[]);
        assert!(broken.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "opencode_config_parse" && diagnostic.adapter_id == Some(opencode)
        }));
    }

    fn kinds_of(snapshot: &AgentContextDiscovery, name: &str) -> Vec<SkillDiscoveryKind> {
        snapshot
            .skills
            .iter()
            .filter(|row| row.name == name)
            .flat_map(codex_and_claude)
            .map(|alias| alias.discovery_kind)
            .collect()
    }

    #[test]
    fn codex_reads_codex_project_and_home_roots_and_skills_below_group_folders() {
        let (project, home, environment) = setup();
        let child = project.path().join("child");
        write_skill(
            &project.path().join(".codex/skills"),
            "config",
            "config",
            Some("Config"),
        );
        write_skill(
            &child.join(".codex/skills"),
            "nested-config",
            "nested-config",
            Some("Nested"),
        );
        write_skill(
            &home.path().join(".codex/skills"),
            "home",
            "home",
            Some("Home"),
        );
        write_skill(
            &home.path().join(".codex/skills/.system"),
            "bundled",
            "bundled",
            Some("Bundled"),
        );
        let agents = project.path().join(".agents/skills");
        write_skill(&agents.join("group"), "grouped", "grouped", Some("Grouped"));
        let outer = write_skill(&agents, "outer", "outer", Some("Outer"));
        write_skill(&outer, "inner", "inner", Some("Inner"));
        let mut deep = agents.clone();
        for level in 1..6 {
            deep.push(format!("d{level}"));
        }
        write_skill(&deep, "sixth", "sixth", Some("Sixth level"));
        write_skill(
            &deep.join("d6"),
            "seventh",
            "seventh",
            Some("Seventh level"),
        );
        write_skill(&agents.join(".hidden"), "hidden", "hidden", Some("Hidden"));
        fs::write(
            agents.join("flat.md"),
            "---\nname: flat\ndescription: Flat\n---\n",
        )
        .unwrap();

        let snapshot = scan(project.path(), &child, &environment).unwrap();

        assert_eq!(
            kinds_of(&snapshot, "config"),
            vec![SkillDiscoveryKind::CodexProjectConfig]
        );
        assert_eq!(
            kinds_of(&snapshot, "nested-config"),
            vec![SkillDiscoveryKind::CodexProjectConfig]
        );
        assert_eq!(
            kinds_of(&snapshot, "home"),
            vec![SkillDiscoveryKind::CodexHome]
        );
        for name in ["grouped", "outer", "inner", "sixth"] {
            assert_eq!(
                kinds_of(&snapshot, name),
                vec![SkillDiscoveryKind::CodexProject],
                "{name}"
            );
        }
        for name in ["seventh", "hidden", "flat", "bundled"] {
            assert!(kinds_of(&snapshot, name).is_empty(), "{name}");
        }
        assert!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.adapter_id == Some(AgentAdapterKind::Codex))
                .all(|diagnostic| diagnostic.code != "skill_manifest_missing"),
            "{:#?}",
            snapshot.diagnostics
        );
    }

    #[test]
    fn claude_reads_only_direct_children_of_its_roots() {
        let (project, _home, environment) = setup();
        let claude = project.path().join(".claude/skills");
        write_skill(&claude, "direct", "direct", Some("Direct"));
        write_skill(&claude.join("group"), "grouped", "grouped", Some("Grouped"));
        write_skill(&claude.join("direct"), "inner", "inner", Some("Inner"));

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();

        assert_eq!(
            kinds_of(&snapshot, "direct"),
            vec![SkillDiscoveryKind::ClaudeProject]
        );
        assert!(kinds_of(&snapshot, "grouped").is_empty());
        assert!(kinds_of(&snapshot, "inner").is_empty());
    }

    #[test]
    fn claude_project_skills_dir_plugin_skills_are_no_claude_skills() {
        let (project, home, environment) = setup();
        let plugin = project.path().join(".claude/skills/kit");
        fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            "{\"name\":\"kit\"}",
        )
        .unwrap();
        write_skill(
            &plugin.join("skills"),
            "review",
            "review",
            Some("Plugin review"),
        );
        write_skill(
            &home.path().join(".claude/skills"),
            "review",
            "review",
            Some("Personal"),
        );

        let snapshot = scan(project.path(), project.path(), &environment).unwrap();
        let claude_paths = snapshot
            .skills
            .iter()
            .filter(|row| row.name == "review")
            .flat_map(codex_and_claude)
            .map(|alias| alias.path.clone())
            .collect::<Vec<_>>();

        // The plugin's skill is its component; only the personal one is a
        // skill of Claude Code.
        assert_eq!(
            claude_paths,
            vec![path_string(&home.path().join(".claude/skills/review"))]
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.adapter_id == Some(AgentAdapterKind::ClaudeCode))
                .all(|diagnostic| diagnostic.code != "skill_manifest_missing")
        );
    }
}
