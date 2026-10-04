mod acp_list;
mod cache;
pub mod chat;
pub mod commands;
mod live_status;
mod native_status;
mod read_model;
mod reentry;
mod refresh;
mod scope;
pub mod types;

use std::path::PathBuf;
use std::sync::Arc;

use acp_list::AcpListSources;
use cache::CatalogSnapshots;
use native_status::NativeStatusReader;
use refresh::AgentSessionsReadCoordinator;

/// The Sessions catalogue: each agent's ACP list, the lists saved per project
/// for the time before an agent connection opens, and the native status
/// reader of the listed sessions.
#[derive(Clone)]
pub struct AgentSessionsState {
    pub(crate) home_dir: PathBuf,
    pub(crate) reads: AgentSessionsReadCoordinator,
    pub(crate) acp_lists: Arc<AcpListSources>,
    pub(crate) snapshots: Arc<CatalogSnapshots>,
    pub(crate) native_status: Arc<NativeStatusReader>,
}

impl AgentSessionsState {
    pub fn new() -> Self {
        Self::with_home(default_home_dir())
    }

    pub(crate) fn with_home(home_dir: PathBuf) -> Self {
        Self {
            native_status: Arc::new(NativeStatusReader::new(home_dir.clone())),
            home_dir,
            reads: AgentSessionsReadCoordinator::default(),
            acp_lists: Arc::new(AcpListSources::default()),
            snapshots: Arc::new(CatalogSnapshots::default()),
        }
    }
}

/// Reads each listing agent's catalogue again whenever the runtime's own
/// work changed it; runs for the life of the app process.
pub fn follow_acp_catalog_changes(state: &AgentSessionsState, runtime: svode_agents::AgentRuntime) {
    tauri::async_runtime::spawn(acp_list::follow_catalog_changes(
        state.acp_lists.clone(),
        runtime,
    ));
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
