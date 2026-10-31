//! Turn boundaries of the sessions this runtime drives, for hosts that bind
//! them to effects of their own (Stage 11 1.E «Ходы агентов»): Desktop
//! wraps the turns of a working directory inside a repository in versions
//! of its content. The runtime only reports when a turn starts and ends and
//! what the prompt asked of it; it knows nothing of repositories or
//! versions.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

use crate::identity::SessionKey;

/// What a prompt asks beyond its text, carried by its turn to the hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnMark {
    /// The prompt asks the agent to commit itself: «Зафиксировать с
    /// агентом» (and the resolve requests that also leave the commits to
    /// the agent). A host that wraps turns in versions leaves this turn to
    /// the agent; the following turns of the session are ordinary.
    AgentCommits,
}

/// One turn of a session in its working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnBoundary {
    pub session: SessionKey,
    pub turn_id: String,
    /// The working directory of the session.
    pub cwd: PathBuf,
    pub mark: Option<TurnMark>,
}

pub type TurnFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// A host's view of turn boundaries.
pub trait TurnObserver: Send + Sync {
    /// The turn is accepted; its prompt goes to the agent once the returned
    /// future resolves, so what the host does before a turn happens first.
    fn began(&self, turn: &TurnBoundary) -> TurnFuture;

    /// The turn ended, exactly once per started turn: the agent answered,
    /// the turn was cancelled or failed, or its connection or process was
    /// lost.
    fn ended(&self, turn: &TurnBoundary);
}

/// Reports the end of its turn when the turn's task finishes, however it
/// finishes.
pub(crate) struct TurnEnded {
    pub(crate) observer: std::sync::Arc<dyn TurnObserver>,
    pub(crate) turn: TurnBoundary,
}

impl Drop for TurnEnded {
    fn drop(&mut self) {
        self.observer.ended(&self.turn);
    }
}
