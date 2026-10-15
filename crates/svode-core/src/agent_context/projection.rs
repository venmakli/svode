use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use super::AgentContextError;
use crate::agent_adapters::{AgentAdapterKind, system_source_registry_environment};
use crate::git::path::{RootMode, repo_relative_from_base};

use super::model::{
    AgentContextDiscovery, InstructionDiscoveryPolicy, InstructionOwnerKind, InstructionSourceKind,
    SkillDiscoveryAlias, SkillDiscoveryKind, SkillScope,
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

/// The agents whose sources the project Knowledge projection keeps: the
/// Stage 7 input. Sources that only later policies find stay out of it.
pub const KNOWLEDGE_AGENTS: [AgentAdapterKind; 2] =
    [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode];

/// A project skill path of the Stage 7 input. The paths that Codex and Claude
/// Code gained after Stage 7 stay out of it too.
fn in_knowledge(alias: &SkillDiscoveryAlias) -> bool {
    alias.scope == SkillScope::Project
        && KNOWLEDGE_AGENTS.contains(&alias.adapter_id)
        && !matches!(
            alias.discovery_kind,
            SkillDiscoveryKind::CodexProjectConfig | SkillDiscoveryKind::CodexHome
        )
}

/// Prepared, target-specific Agent Context projection. This is called only by
/// existing index write paths; Knowledge reads consume the materialized rows.
pub async fn target_knowledge_projection(
    project_root: &Path,
    target_root: &Path,
) -> Result<Vec<ProjectKnowledgeArtifact>, AgentContextError> {
    let environment = system_source_registry_environment()?;
    let project = project_root.to_path_buf();
    let target = target_root.to_path_buf();
    let scan_project = project.clone();
    let scan_target = target.clone();
    // Knowledge keeps the Stage 7 projection, whichever agents are enabled.
    let content = tokio::task::spawn_blocking(move || {
        super::scanner::discover(&scan_project, &scan_target, &environment, &KNOWLEDGE_AGENTS)
    })
    .await
    .map_err(|error| {
        AgentContextError::General(format!("agent context projection task failed: {error}"))
    })??;
    normalize_project_snapshot(&project, &target, &content)
}

fn normalize_project_snapshot(
    project_root: &Path,
    target_root: &Path,
    content: &AgentContextDiscovery,
) -> Result<Vec<ProjectKnowledgeArtifact>, AgentContextError> {
    let canonical_project = project_root.canonicalize().map_err(|error| {
        AgentContextError::General(format!(
            "could not canonicalize Agent Context projection root {}: {error}",
            project_root.display()
        ))
    })?;
    let canonical_target = target_root.canonicalize().map_err(|error| {
        AgentContextError::General(format!(
            "could not canonicalize Agent Context projection target {}: {error}",
            target_root.display()
        ))
    })?;
    let mut rows = BTreeMap::<(String, String, String), Accumulator>::new();

    for instruction in &content.instructions {
        if instruction
            .adapter_id
            .is_some_and(|agent| !KNOWLEDGE_AGENTS.contains(&agent))
            || instruction.discovery.policy == InstructionDiscoveryPolicy::ClaudeAgentsMd
            || instruction.owner.kind != InstructionOwnerKind::TargetSpace
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
            .filter(|alias| in_knowledge(alias))
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
        for alias in skill.aliases.iter().filter(|alias| in_knowledge(alias)) {
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
    super::items::modified_at(path).unwrap_or_else(|| {
        let date: DateTime<Utc> = SystemTime::UNIX_EPOCH.into();
        date.to_rfc3339_opts(SecondsFormat::Secs, true)
    })
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
        MarkdownPreview, SourceHealth, SourceLinkKind, SourceResolution, SourceSupport,
    };
    use std::fs;
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
            link_kind: SourceLinkKind::Direct,
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
            superseded_by: None,
            preview: Some(preview("project")),
            references: Vec::new(),
        };
        let content = AgentContextDiscovery {
            project_root: temp.path().to_string_lossy().to_string(),
            target_root: temp.path().to_string_lossy().to_string(),
            repository_root: temp.path().to_string_lossy().to_string(),
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
            plugins: Vec::new(),
            mcp_servers: Vec::new(),
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
        let mixed = AgentContextDiscovery {
            project_root: temp.path().to_string_lossy().to_string(),
            target_root: temp.path().to_string_lossy().to_string(),
            repository_root: temp.path().to_string_lossy().to_string(),
            instructions: vec![native_superseded, recognized],
            skills: Vec::new(),
            plugins: Vec::new(),
            mcp_servers: Vec::new(),
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

    #[test]
    fn sources_only_later_policies_read_stay_out_of_the_projection() {
        let project = TempDir::new().unwrap();
        fs::create_dir(project.path().join(".git")).unwrap();
        let write = |relative: &str, text: &str| {
            let path = project.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        let skill = |name: &str| format!("---\nname: {name}\ndescription: {name}\n---\n# {name}\n");
        write("AGENTS.md", "shared");
        write("QWEN.md", "qwen");
        write(".pi/skills/pi-only/SKILL.md", &skill("pi-only"));
        write(".opencode/skills/quick.md", &skill("quick"));
        write(".agents/skills/shared/SKILL.md", &skill("shared"));
        let home = TempDir::new().unwrap();
        let environment =
            crate::agent_adapters::SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
        let discovery = crate::agent_context::scanner::discover(
            project.path(),
            project.path(),
            &environment,
            &KNOWLEDGE_AGENTS,
        )
        .unwrap();

        let projected =
            normalize_project_snapshot(project.path(), project.path(), &discovery).unwrap();

        let mut sources = projected
            .iter()
            .map(|artifact| (artifact.kind.as_str(), artifact.source_path.as_str()))
            .collect::<Vec<_>>();
        sources.sort();
        assert_eq!(
            sources,
            vec![
                ("agent_instruction", "AGENTS.md"),
                ("skill", ".agents/skills/shared/SKILL.md"),
            ]
        );
        let shared = projected
            .iter()
            .find(|artifact| artifact.kind == "skill")
            .unwrap();
        assert!(
            shared
                .discovery
                .iter()
                .all(|discovery| discovery.starts_with("codex:"))
        );
    }

    #[test]
    fn knowledge_leaves_out_sources_that_later_codex_and_claude_policies_add() {
        let project = TempDir::new().unwrap();
        fs::create_dir(project.path().join(".git")).unwrap();
        let write = |relative: &str, text: &str| {
            let path = project.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        let skill = |name: &str| format!("---\nname: {name}\ndescription: {name}\n---\n");
        write("AGENTS.md", "agents");
        write(".agents/skills/stage-seven/SKILL.md", &skill("stage-seven"));
        write(
            ".codex/skills/codex-config/SKILL.md",
            &skill("codex-config"),
        );
        write(".claude/skills/kit/.claude-plugin/plugin.json", "{}");
        write(
            ".claude/skills/kit/skills/plugin-skill/SKILL.md",
            &skill("plugin-skill"),
        );
        let home = TempDir::new().unwrap();
        let environment =
            crate::agent_adapters::SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
        let content = super::super::scanner::discover(
            project.path(),
            project.path(),
            &environment,
            &[AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode],
        )
        .unwrap();

        let projected =
            normalize_project_snapshot(project.path(), project.path(), &content).unwrap();

        let agents = projected
            .iter()
            .find(|artifact| artifact.source_path == "AGENTS.md")
            .unwrap();
        assert!(
            agents
                .discovery
                .iter()
                .all(|discovery| !discovery.starts_with("claude-code:")),
            "{:?}",
            agents.discovery
        );
        // Other agents may still find these paths; the kinds Codex and
        // Claude Code gained after Stage 7 never reach Knowledge.
        let discovery = projected
            .iter()
            .filter(|artifact| artifact.kind == "skill")
            .flat_map(|artifact| &artifact.discovery)
            .collect::<Vec<_>>();
        assert!(
            discovery
                .iter()
                .any(|path| path.starts_with("codex:codex_project:")),
            "{discovery:?}"
        );
        for kind in ["codex_project_config", "codex_home"] {
            assert!(
                discovery.iter().all(|path| !path.contains(kind)),
                "{discovery:?}"
            );
        }
        // Skills of a skills-dir plugin are its components, not skills.
        assert!(
            discovery
                .iter()
                .all(|path| !(path.starts_with("claude-code:") && path.contains("plugin-skill"))),
            "{discovery:?}"
        );
    }
}
