mod acp_list;
mod cache;
pub mod chat;
pub mod commands;
mod live_status;
mod native_catalog;
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
use native_catalog::{CatalogRoots, NativeCatalogSources, cursor_chats};
use native_status::NativeStatusReader;
use native_status::hermes;

/// Where an agent's store lives, found when the store is read: it may depend
/// on the environment of the agent (Stage 10 `07` N7).
pub(crate) type StoreRoot = Arc<dyn Fn() -> PathBuf + Send + Sync>;
use refresh::AgentSessionsReadCoordinator;

/// The Sessions catalogue: each agent's ACP list, the native catalogue
/// sources of agents that list their sessions from their store, the lists
/// saved per project for the time before a source is read, and the native
/// status reader of the listed sessions.
#[derive(Clone)]
pub struct AgentSessionsState {
    pub(crate) home_dir: PathBuf,
    pub(crate) reads: AgentSessionsReadCoordinator,
    pub(crate) acp_lists: Arc<AcpListSources>,
    pub(crate) native_catalogs: Arc<NativeCatalogSources>,
    pub(crate) snapshots: Arc<CatalogSnapshots>,
    pub(crate) native_status: Arc<NativeStatusReader>,
}

impl AgentSessionsState {
    /// The stores of this device: `HERMES_HOME` and, on Windows,
    /// `LOCALAPPDATA` of the agent's environment place the Hermes home,
    /// `CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME` the Cursor CLI config
    /// directory, found when a store is read.
    pub fn new() -> Self {
        let home_dir = default_home_dir();
        let home = home_dir.clone();
        let hermes_home: StoreRoot =
            Arc::new(move || hermes::store_root(&home, native_status::agent_variable));
        let home = home_dir.clone();
        let cursor_config: StoreRoot =
            Arc::new(move || cursor_chats::config_dir(&home, native_status::agent_variable));
        Self::with_stores(
            home_dir,
            CatalogRoots {
                hermes_home,
                cursor_config,
            },
        )
    }

    /// The stores under `home_dir` alone.
    #[cfg(test)]
    pub(crate) fn with_home(home_dir: PathBuf) -> Self {
        let (hermes, cursor) = (home_dir.join(".hermes"), home_dir.join(".cursor"));
        Self::with_stores(
            home_dir,
            CatalogRoots {
                hermes_home: Arc::new(move || hermes.clone()),
                cursor_config: Arc::new(move || cursor.clone()),
            },
        )
    }

    fn with_stores(home_dir: PathBuf, roots: CatalogRoots) -> Self {
        Self {
            native_status: Arc::new(NativeStatusReader::with_stores(
                home_dir.clone(),
                roots.hermes_home.clone(),
            )),
            native_catalogs: Arc::new(NativeCatalogSources::new(roots)),
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
