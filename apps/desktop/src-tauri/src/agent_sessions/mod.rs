mod cache;
pub mod commands;
mod live_status;
mod read_model;
mod reentry;
mod refresh;
mod scope;
mod sources;
pub mod types;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cache::AgentSessionsReadCache;
use cache::AgentSessionsSourceScanLocks;
use refresh::AgentSessionsReadCoordinator;

#[derive(Clone)]
pub struct AgentSessionsState {
    pub(crate) home_dir: PathBuf,
    pub(crate) cache: Arc<Mutex<AgentSessionsReadCache>>,
    pub(crate) reads: AgentSessionsReadCoordinator,
    pub(crate) source_scan_locks: Arc<AgentSessionsSourceScanLocks>,
}

impl AgentSessionsState {
    pub fn new() -> Self {
        Self::with_home(default_home_dir())
    }

    pub(crate) fn with_home(home_dir: PathBuf) -> Self {
        Self {
            home_dir,
            cache: Arc::new(Mutex::new(AgentSessionsReadCache::default())),
            reads: AgentSessionsReadCoordinator::default(),
            source_scan_locks: Arc::new(AgentSessionsSourceScanLocks::default()),
        }
    }
}

impl Default for AgentSessionsState {
    fn default() -> Self {
        Self::new()
    }
}

fn default_home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
