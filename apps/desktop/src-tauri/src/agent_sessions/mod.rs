pub mod commands;
mod read_model;
mod sources;
pub mod types;

use std::path::PathBuf;
use std::sync::Mutex;

use read_model::AgentSessionsReadCache;

pub struct AgentSessionsState {
    pub(crate) home_dir: PathBuf,
    pub(crate) cache: Mutex<AgentSessionsReadCache>,
}

impl AgentSessionsState {
    pub fn new() -> Self {
        Self::with_home(default_home_dir())
    }

    pub(crate) fn with_home(home_dir: PathBuf) -> Self {
        Self {
            home_dir,
            cache: Mutex::new(AgentSessionsReadCache::default()),
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
