//! Announcements without a started session (Stage 11 `03`): what an agent's
//! recorded evidence allows for a session created without a prompt, the
//! agent's last declarations per model and the draft sessions still to
//! delete. The runtime owns the rules; a host keeps the device-local state
//! through [`DraftHost`].

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::activity::{SessionSetting, SettingCategory};

/// What the recorded evidence of an agent allows for a session it creates
/// without a prompt (Stage 11 `03`, E6). An agent without evidence gets no
/// draft session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftSession {
    /// No draft session: it would stay in the agent's list, or nothing is
    /// recorded.
    #[default]
    Unsupported,
    /// The session leaves nothing in the agent's list or store, and its
    /// values change before the first prompt.
    Traceless,
    /// The session is in the agent's list until ACP `session/delete`, which
    /// its release sends unless a prompt went to it.
    Deleted,
    /// The session leaves nothing until one of its values changes, so the
    /// values chosen before the first prompt apply only with it.
    FixedValues,
}

impl DraftSession {
    pub fn opens(self) -> bool {
        self != Self::Unsupported
    }

    /// Values change in the draft session before its first prompt.
    pub fn changes_values(self) -> bool {
        matches!(self, Self::Traceless | Self::Deleted)
    }

    pub fn deletes(self) -> bool {
        self == Self::Deleted
    }
}

/// The draft session an agent's registry description records: what it
/// allows, with the evidence and the agent version it was observed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DraftSessionEvidence {
    pub session: DraftSession,
    pub evidence: &'static str,
}

/// The settings an agent declared in one of its sessions on this device for
/// one model, with when and by which version of the agent (Stage 11 `03`,
/// last declarations). They show the agent's values without a draft session;
/// they never allow a launch nor check a value at launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeclaration {
    pub agent: String,
    /// The value of the agent's model setting they were declared with; none
    /// for an agent that declares no model.
    pub model: Option<String>,
    pub settings: Vec<SessionSetting>,
    /// Milliseconds since the Unix epoch.
    pub declared_at: u64,
    pub agent_version: Option<String>,
}

/// A draft session to delete once its agent connects again: its release
/// did not delete it, or the app ended first.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletion {
    pub agent: String,
    /// The agent's ACP session id.
    pub session_id: String,
}

/// What a host keeps for the runtime on the device, outside projects: each
/// call carries the whole current state.
pub trait DraftHost: Send + Sync {
    fn declarations_changed(&self, declarations: &[AgentDeclaration]);
    fn pending_deletions_changed(&self, pending: &[PendingDeletion]);
}

/// Declarations kept per agent beyond which the oldest model's go.
const DECLARATIONS_PER_AGENT: usize = 64;

/// The last declarations per agent and model.
#[derive(Default)]
pub(crate) struct LastDeclarations {
    by_model: HashMap<(String, Option<String>), AgentDeclaration>,
}

impl LastDeclarations {
    pub(crate) fn restore(&mut self, declarations: Vec<AgentDeclaration>) {
        self.by_model = declarations
            .into_iter()
            .map(|declaration| {
                (
                    (declaration.agent.clone(), declaration.model.clone()),
                    declaration,
                )
            })
            .collect();
    }

    /// Records what `agent` declares now; `false` when nothing changed, so
    /// the host does not write the same state again.
    pub(crate) fn record(
        &mut self,
        agent: &str,
        settings: &[SessionSetting],
        agent_version: Option<&str>,
        at: SystemTime,
    ) -> bool {
        if settings.is_empty() {
            return false;
        }
        let model = settings
            .iter()
            .find(|setting| setting.category == SettingCategory::Model)
            .map(|setting| setting.current_value.clone());
        let key = (agent.to_string(), model.clone());
        if self.by_model.get(&key).is_some_and(|known| {
            known.settings == settings && known.agent_version.as_deref() == agent_version
        }) {
            return false;
        }
        self.by_model.insert(
            key,
            AgentDeclaration {
                agent: agent.to_string(),
                model,
                settings: settings.to_vec(),
                declared_at: millis(at),
                agent_version: agent_version.map(str::to_string),
            },
        );
        let mut kept: Vec<_> = self
            .by_model
            .iter()
            .filter(|((known, _), _)| known == agent)
            .map(|(key, declaration)| (declaration.declared_at, key.clone()))
            .collect();
        if kept.len() > DECLARATIONS_PER_AGENT {
            kept.sort();
            for (_, key) in kept.iter().take(kept.len() - DECLARATIONS_PER_AGENT) {
                self.by_model.remove(key);
            }
        }
        true
    }

    /// The agent's declarations, the latest first.
    pub(crate) fn of(&self, agent: &str) -> Vec<AgentDeclaration> {
        let mut declarations: Vec<_> = self
            .by_model
            .values()
            .filter(|declaration| declaration.agent == agent)
            .cloned()
            .collect();
        declarations.sort_by_key(|declaration| {
            (
                std::cmp::Reverse(declaration.declared_at),
                declaration.model.clone(),
            )
        });
        declarations
    }

    pub(crate) fn all(&self) -> Vec<AgentDeclaration> {
        let mut declarations: Vec<_> = self.by_model.values().cloned().collect();
        declarations
            .sort_by_key(|declaration| (declaration.agent.clone(), declaration.model.clone()));
        declarations
    }
}

fn millis(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::activity::SettingOption;

    fn setting(id: &str, category: SettingCategory, value: &str) -> SessionSetting {
        SessionSetting {
            id: id.into(),
            name: id.into(),
            description: None,
            category,
            current_value: value.into(),
            options: vec![SettingOption {
                value: value.into(),
                name: value.into(),
                description: None,
            }],
        }
    }

    #[test]
    fn declarations_are_kept_per_agent_and_model() {
        let mut last = LastDeclarations::default();
        let at = UNIX_EPOCH + Duration::from_secs(10);
        let luna = vec![setting("model", SettingCategory::Model, "luna")];
        let sol = vec![
            setting("model", SettingCategory::Model, "sol"),
            setting("reasoning_effort", SettingCategory::ThoughtLevel, "ultra"),
        ];
        assert!(last.record("codex", &luna, Some("0.163.0"), at));
        assert!(last.record("codex", &sol, Some("0.163.0"), at + Duration::from_secs(1)));
        assert!(!last.record("codex", &sol, Some("0.163.0"), at + Duration::from_secs(2)));
        // A new version of the agent is a new declaration.
        assert!(last.record("codex", &sol, Some("0.164.0"), at + Duration::from_secs(3)));
        assert!(!last.record("codex", &[], None, at));

        let codex = last.of("codex");
        assert_eq!(codex.len(), 2);
        assert_eq!(codex[0].model.as_deref(), Some("sol"));
        assert_eq!(codex[0].agent_version.as_deref(), Some("0.164.0"));
        assert_eq!(codex[0].declared_at, 13_000);
        assert_eq!(codex[1].model.as_deref(), Some("luna"));
        assert!(last.of("qwen-code").is_empty());

        // An agent without a model setting keeps one declaration.
        let modes = vec![setting("mode", SettingCategory::Mode, "default")];
        assert!(last.record("grok-build", &modes, None, at));
        assert_eq!(last.of("grok-build")[0].model, None);
    }

    #[test]
    fn the_oldest_models_of_an_agent_go_beyond_the_bound() {
        let mut last = LastDeclarations::default();
        for index in 0..DECLARATIONS_PER_AGENT + 2 {
            let model = format!("m{index}");
            last.record(
                "cursor",
                &[setting("model", SettingCategory::Model, &model)],
                None,
                UNIX_EPOCH + Duration::from_secs(index as u64),
            );
        }
        let kept = last.of("cursor");
        assert_eq!(kept.len(), DECLARATIONS_PER_AGENT);
        assert!(
            !kept
                .iter()
                .any(|known| known.model.as_deref() == Some("m0"))
        );
        assert!(
            !kept
                .iter()
                .any(|known| known.model.as_deref() == Some("m1"))
        );
    }
}
