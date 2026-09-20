pub mod access;
pub mod cli;
pub mod clone;
pub mod commands;
pub mod dates;
pub mod delivery;
pub mod inspection;
pub mod inspection_stats;
#[cfg(test)]
mod inspection_tests;
mod state;

pub use delivery::GitHostState;
pub use state::GitState;

pub(crate) fn require_cli(state: &GitState) -> Result<cli::GitCli, crate::AppError> {
    state.require_cli()
}
