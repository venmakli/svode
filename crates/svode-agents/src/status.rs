//! The one session status vocabulary (Stage 10 `02` C10). Names and meaning
//! follow ACP turn states and stop reasons; Svode adds only `error` and
//! `interrupted`. ACP wire types never appear here.

use serde::{Deserialize, Serialize};

/// Why the last known turn stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    /// The call failed or the agent process exited with a non-zero code.
    Error,
    /// The connection broke, or the agent or app exited, without a turn result.
    Interrupted,
}

/// What a blocked turn waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Permission,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionState {
    /// A turn is running.
    Running,
    /// A turn is running but blocked on a request to the user.
    RequiresAction { request: InteractionKind },
    /// No turn is running; the session can continue.
    Idle { stop_reason: Option<StopReason> },
    /// Not enough evidence; never shown as idle.
    Unknown,
}

impl SessionState {
    /// A turn is running, blocked on the user or not.
    pub fn in_turn(self) -> bool {
        matches!(self, Self::Running | Self::RequiresAction { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusSource {
    /// A Svode ACP connection drives the session.
    SvodeRuntime,
    /// A Svode managed PTY runs the agent CLI.
    ManagedPty,
    /// The agent's native store read by a status reader.
    NativeStatusReader,
    /// No evidence.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusConfidence {
    Exact,
    Approximate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    #[serde(flatten)]
    pub state: SessionState,
    pub source: StatusSource,
    pub confidence: StatusConfidence,
}

impl SessionStatus {
    /// Status of a session this runtime drives: exact by construction.
    pub fn runtime(state: SessionState) -> Self {
        Self {
            state,
            source: StatusSource::SvodeRuntime,
            confidence: StatusConfidence::Exact,
        }
    }

    pub fn unknown() -> Self {
        Self {
            state: SessionState::Unknown,
            source: StatusSource::None,
            confidence: StatusConfidence::Approximate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_status_uses_acp_names() {
        let status = SessionStatus::runtime(SessionState::Idle {
            stop_reason: Some(StopReason::EndTurn),
        });
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "state": "idle",
                "stopReason": "end_turn",
                "source": "svode_runtime",
                "confidence": "exact"
            })
        );
        let waiting = SessionStatus::runtime(SessionState::RequiresAction {
            request: InteractionKind::Permission,
        });
        assert_eq!(
            serde_json::to_value(waiting).unwrap()["state"],
            "requires_action"
        );
    }

    #[test]
    fn only_a_running_or_blocked_turn_is_in_turn() {
        assert!(SessionState::Running.in_turn());
        assert!(
            SessionState::RequiresAction {
                request: InteractionKind::Question
            }
            .in_turn()
        );
        assert!(
            !SessionState::Idle {
                stop_reason: Some(StopReason::Interrupted)
            }
            .in_turn()
        );
        assert!(!SessionState::Unknown.in_turn());
    }
}
