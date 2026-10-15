use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::AppError;

use svode_core::agent_context::model::{
    AgentContextSnapshot, AgentContextSnapshotContent, ContextItemKind,
};

#[derive(Debug, Clone)]
struct PublishedSnapshot {
    generation: u64,
    content: AgentContextSnapshotContent,
}

#[derive(Debug, Default)]
pub struct AgentContextState {
    snapshots: Mutex<HashMap<String, PublishedSnapshot>>,
}

impl AgentContextState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn publish(
        &self,
        key: String,
        content: AgentContextSnapshotContent,
    ) -> Result<AgentContextSnapshot, AppError> {
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| AppError::General("agent context snapshot lock poisoned".to_string()))?;
        let generation = match snapshots.get(&key) {
            Some(current) if current.content == content => current.generation,
            Some(current) => current.generation.saturating_add(1),
            None => 1,
        };
        snapshots.insert(
            key,
            PublishedSnapshot {
                generation,
                content: content.clone(),
            },
        );
        Ok(AgentContextSnapshot {
            generation,
            content,
        })
    }

    /// The folder of a skill some published snapshot holds, a plugin's
    /// skill too: the only folders whose files the Context reads.
    pub fn skill_directory(&self, item_id: &str) -> Option<PathBuf> {
        let snapshots = self.snapshots.lock().ok()?;
        snapshots
            .values()
            .flat_map(|snapshot| &snapshot.content.items)
            .flat_map(|item| std::iter::once(item).chain(&item.components))
            .find(|item| item.id == item_id && item.kind == ContextItemKind::Skill)
            .and_then(|item| item.skill.as_ref())
            .map(|skill| PathBuf::from(&skill.directory))
    }

    pub fn targets_observing_project_path(&self, path: &Path) -> Vec<String> {
        let Ok(snapshots) = self.snapshots.lock() else {
            return Vec::new();
        };
        let mut targets = snapshots
            .values()
            .filter(|snapshot| {
                snapshot
                    .content
                    .observed_project_paths
                    .iter()
                    .any(|candidate| {
                        let candidate = Path::new(candidate);
                        path.starts_with(candidate) || candidate.starts_with(path)
                    })
            })
            .map(|snapshot| snapshot.content.target_root.clone())
            .collect::<Vec<_>>();
        targets.sort();
        targets.dedup();
        targets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content(target: &str) -> AgentContextSnapshotContent {
        AgentContextSnapshotContent {
            project_root: "/project".to_string(),
            target_root: target.to_string(),
            repository_root: "/project".to_string(),
            enabled_agents: Vec::new(),
            items: Vec::new(),
            diagnostics: Vec::new(),
            observed_project_paths: Vec::new(),
            observed_personal_paths: Vec::new(),
        }
    }

    #[test]
    fn generation_is_stable_for_equal_content_and_advances_for_changes() {
        let state = AgentContextState::new();
        let first = state.publish("key".into(), content("/project")).unwrap();
        let same = state.publish("key".into(), content("/project")).unwrap();
        let changed = state
            .publish("key".into(), content("/project/child"))
            .unwrap();

        assert_eq!(first.generation, 1);
        assert_eq!(same.generation, 1);
        assert_eq!(changed.generation, 2);
    }

    #[test]
    fn only_skills_of_published_snapshots_name_a_folder_plugin_skills_too() {
        use svode_core::agent_context::model::{
            ContextItem, ContextLocation, ContextLocationKind, ContextSkillFacts, MarkdownPreview,
            SourceHealth,
        };

        let item = |id: &str, kind, skill| ContextItem {
            id: id.to_string(),
            kind,
            name: "review".to_string(),
            description: None,
            path: "/skills/review/SKILL.md".to_string(),
            owner_root: "/skills".to_string(),
            location: ContextLocation {
                kind: ContextLocationKind::Absolute,
                path: "/skills".to_string(),
            },
            modified_at: None,
            health: SourceHealth::Normal,
            health_reasons: Vec::new(),
            providers: Vec::new(),
            unapplied: None,
            sources: Vec::new(),
            preview: MarkdownPreview {
                markdown: String::new(),
                truncated: false,
                bytes_read: 0,
                total_bytes: 0,
            },
            references: Vec::new(),
            skill,
            plugin: None,
            components: Vec::new(),
            icon: None,
            managed_by_svode: false,
        };
        let state = AgentContextState::new();
        let mut snapshot = content("/project");
        snapshot.items = vec![
            item(
                "skill:/skills/review",
                ContextItemKind::Skill,
                Some(ContextSkillFacts {
                    directory: "/skills/review".to_string(),
                    has_files: true,
                    license: None,
                    compatibility: None,
                    metadata: None,
                    allowed_tools: None,
                }),
            ),
            item("instruction:/AGENTS.md", ContextItemKind::Instruction, None),
        ];
        let mut plugin = item("plugin:/kit", ContextItemKind::Plugin, None);
        plugin.components = vec![item(
            "plugin:/kit#skill:/kit/skills/lint",
            ContextItemKind::Skill,
            Some(ContextSkillFacts {
                directory: "/kit/skills/lint".to_string(),
                has_files: false,
                license: None,
                compatibility: None,
                metadata: None,
                allowed_tools: None,
            }),
        )];
        snapshot.items.push(plugin);
        state.publish("key".into(), snapshot).unwrap();

        assert_eq!(
            state.skill_directory("skill:/skills/review"),
            Some(PathBuf::from("/skills/review"))
        );
        assert_eq!(
            state.skill_directory("plugin:/kit#skill:/kit/skills/lint"),
            Some(PathBuf::from("/kit/skills/lint"))
        );
        assert_eq!(state.skill_directory("plugin:/kit"), None);
        assert_eq!(state.skill_directory("instruction:/AGENTS.md"), None);
        assert_eq!(state.skill_directory("skill:/elsewhere"), None);
    }

    #[test]
    fn observed_parent_source_invalidates_every_inheriting_target() {
        let state = AgentContextState::new();
        let observed = "/project/AGENTS.md";
        for target in ["/project", "/project/inline"] {
            let mut snapshot = content(target);
            snapshot.observed_project_paths.push(observed.to_string());
            state.publish(target.to_string(), snapshot).unwrap();
        }

        assert_eq!(
            state.targets_observing_project_path(Path::new(observed)),
            vec!["/project".to_string(), "/project/inline".to_string()]
        );
    }

    #[test]
    fn observed_skill_root_invalidates_nested_creation_and_parent_creation() {
        let state = AgentContextState::new();
        let mut snapshot = content("/project/inline");
        snapshot
            .observed_project_paths
            .push("/project/.agents/skills".to_string());
        state.publish("inline".to_string(), snapshot).unwrap();

        assert_eq!(
            state.targets_observing_project_path(Path::new(
                "/project/.agents/skills/review/SKILL.md"
            )),
            vec!["/project/inline".to_string()]
        );
        assert_eq!(
            state.targets_observing_project_path(Path::new("/project/.agents")),
            vec!["/project/inline".to_string()]
        );
    }
}
