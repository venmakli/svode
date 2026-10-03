//! The connection manager: gives agents the Svode tools of the plugin
//! payload in the stable location `~/.svode` (Claude Code, Codex, opencode,
//! Qwen Code and pi get a part of their own; Grok Build reads the shared
//! skill only), keeps connected clients complete, disconnects them, removes
//! the shared skill on request and reports their status.
//!
//! It is the only owner of Svode's artifacts in client configs. The desktop
//! app (Settings and reconcile at every start), `svode integration` and the
//! `svode-mcp install | remove | print-config | doctor` subcommands all call
//! this library. Configs refer only to the stable location, never into an
//! app bundle, so a new version reaches a new agent session through the
//! same paths. The manager grants no permission: it writes no approval mode
//! and no `allowed-tools`.

mod agent_mcp;
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
pub use manager::{connect, disconnect, reconcile, remove_shared_skill};
pub use status::{
    ArtifactStatus, BridgeProbe, ClientStatus, DoctorReport, Issue, ManualConfig, RESTART_NOTICE,
    RuntimeInfo, SharedSkillStatus, Status, client_statuses, doctor, manual_config,
    manual_config_text, runtime_info, shared_skill_status,
};

/// Status of the runtime, every client and the shared skill with the manual
/// config and a doctor report. `failed` carries what a reconcile just before could not
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
        shared_skill: shared_skill_status(machine),
    }
}

#[cfg(all(test, unix))]
mod tests;
