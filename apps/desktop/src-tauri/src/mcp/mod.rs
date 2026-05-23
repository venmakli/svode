pub mod active;
pub mod cli;
pub mod commands;
pub mod config;
pub mod error;
pub mod ipc;
pub mod path;
pub mod protocol;
pub mod service;
pub mod tools;

pub const MCP_VERSION: &str = env!("CARGO_PKG_VERSION");
