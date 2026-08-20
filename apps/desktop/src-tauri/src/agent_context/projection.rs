use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::agent_adapters::system_source_registry_environment;
use crate::error::AppError;
use crate::repo_path::{RootMode, repo_relative_from_base};

use super::model::{
    AgentContextSnapshotContent, InstructionOwnerKind, InstructionSourceKind, SkillScope,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeReference {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectKnowledgeArtifact {
    pub owner_scope: String,
    pub kind: String,
    pub source_path: String,
    pub canonical_source_path: String,
    pub title: String,
    pub text: String,
    pub source_updated_at: String,
    pub aliases: Vec<String>,
    pub support: Vec<String>,
    pub resolution: Vec<String>,
    pub health: Vec<String>,
    pub health_reasons: Vec<String>,
    pub effective_applicability: bool,
    pub discovery: Vec<String>,
    pub references: Vec<ProjectKnowledgeReference>,
    pub truncated: bool,
}

impl ProjectKnowledgeArtifact {
    /// A canonical source is effective for the target when at least one
    /// client-native discovery path is selected or included by deterministic
    /// source policy. Health is retained independently as fidelity metadata.
    pub fn is_effectively_applicable(&self) -> bool {
        self.effective_applicability
    }
}

/// Prepared, target-specific Agent Context projection. This is called only by
/// existing index write paths; Knowledge reads consume the materialized rows.
pub async fn target_knowledge_projection(
    project_root: &Path,
    target_root: &Path,
) -> Result<Vec<ProjectKnowledgeArtifact>, AppError> {
    let environment = system_source_registry_environment()?;
    let project = project_root.to_path_buf();
    let target = target_root.to_path_buf();
    let scan_project = project.clone();
    let scan_target = target.clone();
    let content = tokio::task::spawn_blocking(move || {
        super::scanner::scan(&scan_project, &scan_target, &environment)
    })
    .await
    .map_err(|error| {
        AppError::General(format!("agent context projection task failed: {error}"))
    })??;
    normalize_project_snapshot(&project, &target, &content)
}

fn normalize_project_snapshot(
    project_root: &Path,
    target_root: &Path,
    content: &AgentContextSnapshotContent,
) -> Result<Vec<ProjectKnowledgeArtifact>, AppError> {
    let canonical_project = project_root.canonicalize().map_err(|error| {
        AppError::General(format!(
            "could not canonicalize Agent Context projection root {}: {error}",
            project_root.display()
        ))
    })?;
    let canonical_target = target_root.canonicalize().map_err(|error| {
        AppError::General(format!(
            "could not canonicalize Agent Context projection target {}: {error}",
            target_root.display()
        ))
    })?;
    let mut rows = BTreeMap::<(String, String, String), Accumulator>::new();

    for instruction in &content.instructions {
        if instruction.owner.kind != InstructionOwnerKind::TargetSpace
            || !matches!(
                instruction.source_kind,
                InstructionSourceKind::Project | InstructionSourceKind::Recognized
            )
        {
            continue;
        }
        let Some(canonical_path) = instruction.canonical_path.as_deref() else {
            continue;
        };
        let Some((owner_scope, owner_root, source_path)) = projection_location(
            &canonical_project,
            &canonical_target,
            Path::new(canonical_path),
        ) else {
            continue;
        };
        let Some(preview) = instruction.preview.as_ref() else {
            continue;
        };
        let key = (
            owner_scope.to_string(),
            "agent_instruction".to_string(),
            source_path.clone(),
        );
        let row = rows.entry(key).or_insert_with(|| Accumulator {
            owner_scope: owner_scope.to_string(),
            kind: "agent_instruction".to_string(),
            source_path: source_path.clone(),
            canonical_source_path: source_path.clone(),
            title: instruction.name.clone(),
            text: preview.markdown.clone(),
            source_updated_at: modified_at(Path::new(canonical_path)),
            aliases: BTreeSet::new(),
            support: BTreeSet::new(),
            resolution: BTreeSet::new(),
            health: BTreeSet::new(),
            health_reasons: BTreeSet::new(),
            effective_applicability: false,
            discovery: BTreeSet::new(),
            references: BTreeSet::new(),
            truncated: preview.truncated,
        });
        if let Some(alias) = safe_alias_file(owner_root, &instruction.path) {
            row.aliases.insert(alias);
        }
        row.support.insert(enum_value(&instruction.support));
        row.resolution.insert(enum_value(&instruction.resolution));
        row.health.insert(enum_value(&instruction.health));
        row.health_reasons
            .extend(instruction.health_reasons.iter().cloned());
        row.effective_applicability |= instruction.support
            == super::model::SourceSupport::ClientNative
            && matches!(
                instruction.resolution,
                super::model::SourceResolution::Selected | super::model::SourceResolution::Included
            );
        row.discovery.insert(format!(
            "{}:{}:{}:{}",
            instruction
                .adapter_id
                .map(|adapter| adapter.as_str())
                .unwrap_or("recognized"),
            enum_value(&instruction.discovery.policy),
            instruction.discovery.directory_depth,
            instruction.discovery.precedence
        ));
        row.truncated |= preview.truncated;
        for reference in &instruction.references {
            let Some(canonical_reference) = reference.canonical_path.as_deref() else {
                continue;
            };
            let Some(path) = safe_relative_file(owner_root, canonical_reference) else {
                continue;
            };
            row.references.insert((path, enum_value(&reference.status)));
        }
    }

    for skill in &content.skills {
        if skill.owner.kind != InstructionOwnerKind::TargetSpace {
            continue;
        }
        let canonical_manifest = Path::new(&skill.canonical_path).join("SKILL.md");
        let Some((owner_scope, owner_root, source_path)) =
            projection_location(&canonical_project, &canonical_target, &canonical_manifest)
        else {
            continue;
        };
        let project_aliases = skill
            .aliases
            .iter()
            .filter(|alias| alias.scope == SkillScope::Project)
            .filter_map(|alias| {
                safe_alias_path(owner_root, &Path::new(&alias.path).join("SKILL.md"))
            })
            .collect::<Vec<_>>();
        if project_aliases.is_empty() {
            continue;
        }
        let key = (
            owner_scope.to_string(),
            "skill".to_string(),
            source_path.clone(),
        );
        let row = rows.entry(key).or_insert_with(|| Accumulator {
            owner_scope: owner_scope.to_string(),
            kind: "skill".to_string(),
            source_path: source_path.clone(),
            canonical_source_path: source_path.clone(),
            title: skill.name.clone(),
            text: skill.preview.markdown.clone(),
            source_updated_at: modified_at(&canonical_manifest),
            aliases: BTreeSet::new(),
            support: BTreeSet::new(),
            resolution: BTreeSet::new(),
            health: BTreeSet::new(),
            health_reasons: BTreeSet::new(),
            effective_applicability: false,
            discovery: BTreeSet::new(),
            references: BTreeSet::new(),
            truncated: skill.preview.truncated,
        });
        for alias in skill
            .aliases
            .iter()
            .filter(|alias| alias.scope == SkillScope::Project)
        {
            if let Some(path) =
                safe_alias_path(owner_root, &Path::new(&alias.path).join("SKILL.md"))
            {
                row.aliases.insert(path);
            }
            row.support.insert(enum_value(&alias.support));
            row.resolution.insert(enum_value(&alias.resolution));
            row.effective_applicability |= alias.support
                == super::model::SourceSupport::ClientNative
                && matches!(
                    alias.resolution,
                    super::model::SourceResolution::Selected
                        | super::model::SourceResolution::Included
                );
            row.discovery.insert(format!(
                "{}:{}:{}",
                alias.adapter_id.as_str(),
                enum_value(&alias.discovery_kind),
                enum_value(&alias.link_kind)
            ));
        }
        row.health.insert(enum_value(&skill.health));
        row.health_reasons
            .extend(skill.health_reasons.iter().cloned());
    }

    Ok(rows.into_values().map(Accumulator::finish).collect())
}

struct Accumulator {
    owner_scope: String,
    kind: String,
    source_path: String,
    canonical_source_path: String,
    title: String,
    text: String,
    source_updated_at: String,
    aliases: BTreeSet<String>,
    support: BTreeSet<String>,
    resolution: BTreeSet<String>,
    health: BTreeSet<String>,
    health_reasons: BTreeSet<String>,
    effective_applicability: bool,
    discovery: BTreeSet<String>,
    references: BTreeSet<(String, String)>,
    truncated: bool,
}

impl Accumulator {
    fn finish(self) -> ProjectKnowledgeArtifact {
        ProjectKnowledgeArtifact {
            owner_scope: self.owner_scope,
            kind: self.kind,
            source_path: self.source_path,
            canonical_source_path: self.canonical_source_path,
            title: self.title,
            text: self.text,
            source_updated_at: self.source_updated_at,
            aliases: self.aliases.into_iter().collect(),
            support: self.support.into_iter().collect(),
            resolution: self.resolution.into_iter().collect(),
            health: self.health.into_iter().collect(),
            health_reasons: self.health_reasons.into_iter().collect(),
            effective_applicability: self.effective_applicability,
            discovery: self.discovery.into_iter().collect(),
            references: self
                .references
                .into_iter()
                .map(|(path, status)| ProjectKnowledgeReference { path, status })
                .collect(),
            truncated: self.truncated,
        }
    }
}

fn projection_location<'a>(
    project_root: &'a Path,
    target_root: &'a Path,
    path: &Path,
) -> Option<(&'static str, &'a Path, String)> {
    let canonical = path.canonicalize().ok()?;
    if canonical.starts_with(target_root) {
        let relative = repo_relative_from_base(target_root, &canonical, RootMode::Reject).ok()?;
        return Some(("current", target_root, relative));
    }
    if canonical.starts_with(project_root) {
        let relative = repo_relative_from_base(project_root, &canonical, RootMode::Reject).ok()?;
        return Some(("root", project_root, relative));
    }
    None
}

fn safe_relative_file(root: &Path, path: &str) -> Option<String> {
    safe_relative_path(root, Path::new(path)).filter(|relative| root.join(relative).is_file())
}

fn safe_alias_file(root: &Path, path: &str) -> Option<String> {
    safe_alias_path(root, Path::new(path)).filter(|relative| root.join(relative).is_file())
}

fn safe_relative_path(root: &Path, path: &Path) -> Option<String> {
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    repo_relative_from_base(root, &canonical, RootMode::Reject).ok()
}

fn safe_alias_path(root: &Path, path: &Path) -> Option<String> {
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) || !path.starts_with(root) {
        return None;
    }
    repo_relative_from_base(root, path, RootMode::Reject).ok()
}

fn modified_at(path: &Path) -> String {
    let time = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let date: DateTime<Utc> = time.into();
    date.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn enum_value<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_adapters::AgentAdapterKind;
    use crate::agent_context::model::{
        InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner, InstructionRow,
        MarkdownPreview, SourceHealth, SourceResolution, SourceSupport,
    };
    use tempfile::TempDir;

    fn preview(text: &str) -> MarkdownPreview {
        MarkdownPreview {
            markdown: text.to_string(),
            truncated: false,
            bytes_read: text.len(),
            total_bytes: text.len() as u64,
        }
    }

    #[test]
    fn project_projection_excludes_personal_and_dedupes_canonical_instructions() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join("AGENTS.md"), "project").unwrap();
        let canonical = temp.path().join("AGENTS.md").canonicalize().unwrap();
        let row = |adapter_id, source_kind| InstructionRow {
            id: format!("{adapter_id:?}"),
            adapter_id,
            name: "AGENTS.md".to_string(),
            path: canonical.to_string_lossy().to_string(),
            canonical_path: Some(canonical.to_string_lossy().to_string()),
            owner: InstructionOwner {
                kind: if source_kind == InstructionSourceKind::Personal {
                    InstructionOwnerKind::ClientConfiguration
                } else {
                    InstructionOwnerKind::TargetSpace
                },
                root: temp.path().to_string_lossy().to_string(),
            },
            source_kind,
            support: SourceSupport::ClientNative,
            resolution: SourceResolution::Selected,
            health: SourceHealth::Normal,
            health_reasons: Vec::new(),
            discovery: InstructionDiscovery {
                policy: InstructionDiscoveryPolicy::CodexDirectoryPrecedence,
                directory_depth: 0,
                precedence: 0,
            },
            preview: Some(preview("project")),
            references: Vec::new(),
        };
        let content = AgentContextSnapshotContent {
            project_root: temp.path().to_string_lossy().to_string(),
            target_root: temp.path().to_string_lossy().to_string(),
            repository_root: temp.path().to_string_lossy().to_string(),
            adapters: Vec::new(),
            instructions: vec![
                row(
                    Some(AgentAdapterKind::Codex),
                    InstructionSourceKind::Project,
                ),
                row(
                    Some(AgentAdapterKind::ClaudeCode),
                    InstructionSourceKind::Project,
                ),
                row(
                    Some(AgentAdapterKind::Codex),
                    InstructionSourceKind::Personal,
                ),
            ],
            skills: Vec::new(),
            diagnostics: Vec::new(),
            observed_project_paths: Vec::new(),
            observed_personal_paths: Vec::new(),
        };

        let projected = normalize_project_snapshot(temp.path(), temp.path(), &content).unwrap();
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].owner_scope, "current");
        assert_eq!(projected[0].source_path, "AGENTS.md");
        assert_eq!(projected[0].discovery.len(), 2);
        assert!(projected[0].is_effectively_applicable());
        let mut superseded = projected[0].clone();
        superseded.effective_applicability = false;
        assert!(!superseded.is_effectively_applicable());

        let mut native_superseded = row(
            Some(AgentAdapterKind::Codex),
            InstructionSourceKind::Project,
        );
        native_superseded.resolution = SourceResolution::Superseded;
        let mut recognized = row(None, InstructionSourceKind::Recognized);
        recognized.support = SourceSupport::SvodeRecognized;
        recognized.resolution = SourceResolution::Included;
        let mixed = AgentContextSnapshotContent {
            project_root: temp.path().to_string_lossy().to_string(),
            target_root: temp.path().to_string_lossy().to_string(),
            repository_root: temp.path().to_string_lossy().to_string(),
            adapters: Vec::new(),
            instructions: vec![native_superseded, recognized],
            skills: Vec::new(),
            diagnostics: Vec::new(),
            observed_project_paths: Vec::new(),
            observed_personal_paths: Vec::new(),
        };
        let projected = normalize_project_snapshot(temp.path(), temp.path(), &mixed).unwrap();
        assert_eq!(projected.len(), 1);
        assert_eq!(
            projected[0].support,
            vec!["client_native", "svode_recognized"]
        );
        assert_eq!(projected[0].resolution, vec!["included", "superseded"]);
        assert!(!projected[0].is_effectively_applicable());
    }
}
