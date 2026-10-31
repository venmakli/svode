pub mod access;
pub mod auto_versions;
pub mod clone;
pub mod commands;
pub mod dates;
pub mod delivery;
pub mod inspection;
pub mod inspection_stats;
#[cfg(test)]
mod inspection_tests;
mod state;
pub mod sync_rhythm;
pub(crate) mod turns;

pub use delivery::GitHostState;
pub use state::GitState;

pub(crate) fn require_cli(
    state: &GitState,
) -> Result<svode_core::git::cli::GitCli, crate::AppError> {
    state.require_cli()
}
