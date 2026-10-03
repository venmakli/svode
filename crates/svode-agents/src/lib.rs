//! Runtime of external agents, free of Tauri and windows: the runtime plane
//! of the adapter registry, the ACP client, connections, session runtime
//! and the activity projection its hosts deliver. Desktop is one host; a
//! headless host drives the same library.

mod acp;
pub mod activity;
pub mod adapters;
pub mod catalog;
pub mod custom;
mod error;
pub mod identity;
pub mod interaction;
mod process;
mod projection;
pub mod registry;
mod runtime;
pub mod status;
pub mod writer;

pub use error::{AgentRuntimeError, SettingRefusal};
pub use runtime::{
    AcpLaunch, AgentCapabilities, AgentCheck, AgentInfo, AgentRuntime, ConnectionId,
    ConnectionLease, ConnectionStatus, LaunchEnvironment, Retention, RuntimeConfig,
    SessionSubscription, SettingValue,
};
