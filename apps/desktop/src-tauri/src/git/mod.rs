pub mod access;
pub(crate) mod actor_sources;
pub mod auth;
pub mod autocommit;
pub(crate) mod branch;
pub mod cli;
pub mod clone;
pub mod commands;
pub mod dates;
pub mod inspection;
pub mod inspection_stats;
#[cfg(test)]
mod inspection_tests;
pub(crate) mod local_policy;
#[cfg(test)]
mod local_policy_tests;
pub(crate) mod local_repair;
pub(crate) mod manual_save;
pub mod ops;
pub(crate) mod operations;
pub(crate) mod publication;
pub(crate) mod publication_flow;
pub(crate) mod readers;
mod published_pointer;
mod staging;
#[cfg(test)]
mod staging_tests;
pub mod sync;

pub use commands::GitState;
