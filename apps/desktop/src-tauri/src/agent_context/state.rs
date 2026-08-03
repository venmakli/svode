use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::AppError;

use super::model::{AgentContextSnapshot, AgentContextSnapshotContent};

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
            adapters: Vec::new(),
            instructions: Vec::new(),
            skills: Vec::new(),
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
