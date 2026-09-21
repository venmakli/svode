use std::collections::HashSet;

use crate::AppError;
use crate::terminal::TerminalManager;
use svode_core::routines::model::RoutineLiveEvidence;

pub(crate) fn live_evidence(
    terminal_manager: &TerminalManager,
) -> Result<RoutineLiveEvidence, AppError> {
    let live_agent_pty_ids = terminal_manager
        .list_agent_surfaces()?
        .into_iter()
        .filter(|surface| surface.live)
        .map(|surface| surface.pty_id)
        .collect::<HashSet<_>>();
    Ok(RoutineLiveEvidence::new(live_agent_pty_ids))
}
