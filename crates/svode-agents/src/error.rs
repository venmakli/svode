use serde::Serialize;

use crate::runtime::ConnectionId;
use crate::writer::WriterRefusal;

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
    /// The agent declares neither `session/load` nor `session/resume`.
    #[error("the agent cannot open existing sessions")]
    OpenUnsupported,
    /// A prompt while a turn is active; there is no queue.
    #[error("a turn is already active in this session")]
    TurnActive,
    /// The answer does not fit what the agent asked; the request stays
    /// pending.
    #[error("the answer does not fit the request: {message}")]
    InvalidAnswer { message: String },
    /// The agent needs its own sign-in; recovery runs the agent's auth.
    #[error("agent requires authentication: {message}")]
    AuthRequired { message: String },
    /// The session has another managed writer, an external process writes
    /// to it, or unknown liveness needs the user's confirmation.
    #[error("the session cannot take this writer: {refusal:?}")]
    WriterRefused { refusal: WriterRefusal },
    #[error("agent call timed out")]
    Timeout,
    #[error("agent call failed: {message}")]
    Agent { message: String },
    #[error("agent sent an invalid response: {message}")]
    Protocol { message: String },
}
