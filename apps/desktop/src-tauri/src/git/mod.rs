pub mod access;
pub(crate) mod auth;
pub mod autocommit;
pub(crate) mod branch;
pub mod cli;
pub mod clone;
pub mod commands;
pub mod dates;
pub(crate) mod delivery;
pub mod inspection;
pub mod inspection_stats;
#[cfg(test)]
mod inspection_tests;
pub(crate) mod local_policy;
#[cfg(test)]
mod local_policy_tests;
pub(crate) mod local_repair;
pub(crate) mod manual_save;
pub(crate) mod operations;
pub mod ops;
pub(crate) mod pending;
pub(crate) mod publication;
pub(crate) mod publication_flow;
mod published_pointer;
pub(crate) mod readers;
mod staging;
#[cfg(test)]
mod staging_tests;
mod state;
pub mod sync;

pub use state::GitState;

pub(crate) fn require_cli(state: &GitState) -> Result<cli::GitCli, crate::AppError> {
    state.require_cli()
}
