//! The connection manager: connects the Svode plugin payload of the stable
//! location `~/.svode` to Claude Code and Codex, keeps connected clients
//! complete, disconnects them and reports their status.
//!
//! It is the only owner of Svode's artifacts in client configs. The desktop
//! app (Settings and reconcile at every start), `svode integration` and the
//! `svode-mcp install | remove | print-config | doctor` subcommands all call
//! this library. Configs refer only to the stable location, never into an
//! app bundle, so a new version reaches a new agent session through the
//! same paths. The manager grants no permission: it writes no approval mode
//! and no `allowed-tools`.

mod entry;
mod error;
mod link;
mod machine;
mod manager;
mod policy;
mod status;

pub use entry::{MARKER, MARKER_ENV};
pub use error::ConnectError;
pub use machine::{ActiveRuntime, Client, Machine};
pub use manager::{connect, disconnect, reconcile};
pub use status::{
    ArtifactStatus, BridgeProbe, ClientStatus, DoctorReport, Issue, ManualConfig, RESTART_NOTICE,
    RuntimeInfo, Status, client_statuses, doctor, manual_config, manual_config_text, runtime_info,
};

/// Status of the runtime and every client with the manual config and a
/// doctor report. `failed` carries what a reconcile just before could not
/// repair.
pub fn status(
    machine: &Machine,
    failed: &[(Client, ConnectError)],
    bridge: Option<&BridgeProbe>,
) -> Status {
    let clients = client_statuses(machine, failed);
    Status {
        server: runtime_info(machine),
        doctor: status::doctor_with(machine, bridge, &clients),
        manual_config: manual_config(machine),
        clients,
    }
}

#[cfg(all(test, unix))]
mod tests;
