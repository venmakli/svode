//! Canonical session identity (Stage 10 `02` C2): the agent's source
//! namespace plus its native session id.

use serde::{Deserialize, Serialize};

/// Which id space a session id belongs to. An ACP `sessionId` joins the
/// agent's native namespace only when the provider matrix records evidence
/// that the two are equal; otherwise ACP sessions form their own namespace
/// and never merge with native rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityNamespace {
    Native,
    Acp,
    /// The ids of an origin the agent's IDE keeps apart from its CLI and
    /// ACP sessions: the chats of the Cursor IDE (Stage 10 `07` N2). Neither
    /// the agent's terminal nor its ACP connection continues them.
    Ide,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    /// Stable agent id (an adapter id for registry agents).
    pub agent: String,
    pub namespace: IdentityNamespace,
    pub session_id: String,
}

impl SessionKey {
    /// Key of a session an ACP connection reported. Equal cwd, title or time
    /// never prove identity; only recorded id-equality evidence does.
    pub fn from_acp(agent: &str, acp_session_id: &str, acp_id_is_native: bool) -> Self {
        Self {
            agent: agent.to_string(),
            namespace: if acp_id_is_native {
                IdentityNamespace::Native
            } else {
                IdentityNamespace::Acp
            },
            session_id: acp_session_id.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_sessions_join_the_native_namespace_only_with_evidence() {
        let native = SessionKey::from_acp("hermes", "s1", true);
        let separate = SessionKey::from_acp("hermes", "s1", false);
        assert_eq!(native.namespace, IdentityNamespace::Native);
        assert_eq!(separate.namespace, IdentityNamespace::Acp);
        assert_ne!(native, separate);
    }
}
