use serde::Serialize;

use crate::runtime::ConnectionId;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AgentRuntimeError {
    #[error("agent process could not start: {message}")]
    Spawn { message: String },
    /// The process runs but `initialize` failed; the connection stays
    /// registered in its resulting state.
    #[error("agent did not initialize: {message}")]
    Initialize {
        connection: ConnectionId,
        message: String,
    },
    #[error("agent connection not found")]
    ConnectionNotFound,
    #[error("agent connection is closed")]
    ConnectionClosed,
    #[error("agent session not found")]
    SessionNotFound,
    /// A prompt while a turn is active; there is no queue.
    #[error("a turn is already active in this session")]
    TurnActive,
    /// The agent needs its own sign-in; recovery runs the agent's auth.
    #[error("agent requires authentication: {message}")]
    AuthRequired { message: String },
    #[error("agent call timed out")]
    Timeout,
    #[error("agent call failed: {message}")]
    Agent { message: String },
    #[error("agent sent an invalid response: {message}")]
    Protocol { message: String },
}
