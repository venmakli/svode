use std::collections::HashSet;

use super::acp_launch::RoutineAcpLaunches;
use crate::AppError;
use crate::terminal::TerminalManager;
use svode_core::routines::model::RoutineLiveEvidence;

/// Live managed PTYs of agents and runs whose ACP session holds its writer.
pub(crate) fn live_evidence(
    terminal_manager: &TerminalManager,
    acp_launches: &RoutineAcpLaunches,
) -> Result<RoutineLiveEvidence, AppError> {
    let live_agent_pty_ids = terminal_manager
        .list_agent_surfaces()?
        .into_iter()
        .filter(|surface| surface.live)
        .map(|surface| surface.pty_id)
        .collect::<HashSet<_>>();
    Ok(RoutineLiveEvidence::new(
        live_agent_pty_ids,
        acp_launches.live_run_ids(),
    ))
}
