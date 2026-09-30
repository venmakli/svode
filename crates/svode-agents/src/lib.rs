//! Runtime of external agents, free of Tauri and windows: the runtime plane
//! of the adapter registry, the ACP client, connections, session runtime
//! and the activity projection its hosts deliver. Desktop is one host; a
//! headless host drives the same library.

mod acp;
pub mod activity;
mod error;
pub mod identity;
pub mod interaction;
mod process;
mod projection;
pub mod registry;
mod runtime;
pub mod status;

pub use error::AgentRuntimeError;
pub use runtime::{
    AcpLaunch, AgentCapabilities, AgentInfo, AgentRuntime, ConnectionId, ConnectionStatus,
    RuntimeConfig, SessionSubscription,
};
