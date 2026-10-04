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
    /// The agent keeps one session per connection and this connection
    /// already had one: acquire another connection.
    #[error("the agent connection already serves a session")]
    ConnectionTaken,
    /// The agent declares neither `session/load` nor `session/resume`.
    #[error("the agent cannot open existing sessions")]
    OpenUnsupported,
    /// No recorded evidence that loading and closing a session add no
    /// turns or messages to the agent's conversation, or the agent does
    /// not replay history: open the session with a writer instead.
    #[error("the agent cannot read a session without becoming its writer")]
    ReadOnlyUnsupported,
    /// The session is open read-only; a prompt needs it opened with a
    /// writer first.
    #[error("the session is open read-only")]
    WriterRequired,
    /// The agent does not declare `session/list`.
    #[error("the agent does not list its sessions")]
    ListUnsupported,
    /// A prompt links a file that is not there; nothing was sent.
    #[error("the linked file is unavailable: {path}")]
    FileUnavailable { path: String },
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
    /// A setting value the session was created with did not apply; the
    /// session was closed before any prompt.
    #[error("setting {setting}={value} was refused: {reason}")]
    SettingRefused {
        setting: String,
        value: String,
        reason: SettingRefusal,
    },
    #[error("agent call timed out")]
    Timeout,
    #[error("agent call failed: {message}")]
    Agent { message: String },
    #[error("agent sent an invalid response: {message}")]
    Protocol { message: String },
}

/// Why a session setting value did not apply.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SettingRefusal {
    /// The session does not declare this setting or this value.
    #[error("the agent does not declare it in this session")]
    NotDeclared,
    /// The agent refused the change or did not confirm the value.
    #[error("the agent refused it: {message}")]
    Agent { message: String },
}
