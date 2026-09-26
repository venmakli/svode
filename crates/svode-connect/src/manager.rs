//! Connect, reconcile and disconnect. A client is connected when at least
//! one of its artifacts carries the Svode marker; a connected client always
//! gets the complete set, and disconnecting removes only marked artifacts.
//!
//! | Client      | Skill, CLI and MCP                                              |
//! |-------------|-----------------------------------------------------------------|
//! | Claude Code | `~/.claude/skills/svode` → payload: skill, `bin/` and plugin MCP |
//! | Codex       | `~/.agents/skills/svode` → payload skill; `[mcp_servers.svode]` |
//!
//! Claude Code gets its MCP server from the plugin, so a user entry Svode
//! wrote earlier is removed once the plugin link is in place; Codex keeps a
//! managed entry that starts the stable launcher.

use std::path::PathBuf;

use crate::entry::{self, Entry};
use crate::error::ConnectError;
use crate::link::{self, Link};
use crate::machine::{Client, Machine, Stable};

/// What one client has on this machine.
#[derive(Debug, Clone)]
pub(crate) struct Inspection {
    pub skill: Link,
    pub entry: Entry,
    /// A project or local entry that overrides the user entry.
    pub higher: Result<Option<PathBuf>, ConnectError>,
}

impl Inspection {
    pub fn connected(&self) -> bool {
        self.skill == Link::Managed || self.entry.is_svode()
    }
}

pub(crate) fn inspect(machine: &Machine, client: Client) -> Inspection {
    let skill = match &machine.stable {
        Some(stable) => link::state(
            &machine.skill_link(client),
            &Machine::skill_target(stable, client),
        ),
        None => Link::Absent,
    };
    Inspection {
        skill,
        entry: entry::read(machine, client),
        higher: entry::higher_precedence(machine, client),
    }
}

/// The complete set is in place.
pub(crate) fn complete(machine: &Machine, client: Client, inspection: &Inspection) -> bool {
    let Some(stable) = &machine.stable else {
        return false;
    };
    inspection.skill == Link::Managed
        && match client {
            Client::ClaudeCode => !inspection.entry.is_svode(),
            Client::Codex => entry::is_canonical(&inspection.entry, &stable.launcher_mcp),
        }
}

fn stable(machine: &Machine) -> Result<&Stable, ConnectError> {
    machine.stable.as_ref().ok_or_else(|| {
        ConnectError::new(
            "STABLE_LOCATION_UNSUPPORTED",
            "connecting agent clients through ~/.svode is supported on macOS and Linux only",
        )
    })
}

fn installed(machine: &Machine) -> Result<&Stable, ConnectError> {
    let stable = stable(machine)?;
    if !stable.installed() {
        return Err(ConnectError::new(
            "RUNTIME_UNAVAILABLE",
            format!(
                "the Svode runtime is not installed in {}: start Svode Desktop once or run the standalone Svode installer",
                stable
                    .launcher_mcp
                    .parent()
                    .and_then(|bin| bin.parent())
                    .unwrap_or(&stable.launcher_mcp)
                    .display()
            ),
        ));
    }
    Ok(stable)
}

/// Connects `client` completely: its skill, `svode` for the agent and the
/// MCP server. Every conflict is checked before the first write, so a
/// refused connection writes nothing. Returns whether anything changed.
pub fn connect(machine: &Machine, client: Client) -> Result<bool, ConnectError> {
    let stable = installed(machine)?;
    if stable.runtime.is_none() {
        return Err(ConnectError::new(
            "RUNTIME_UNAVAILABLE",
            "the Svode runtime in ~/.svode does not start: reinstall Svode Desktop and start it once, or run the standalone Svode installer",
        ));
    }
    let inspection = inspect(machine, client);
    if let Some(path) = inspection.higher.clone()? {
        return Err(ConnectError::new(
            "HIGHER_PRECEDENCE_CONFLICT",
            format!(
                "{} has a project or local svode MCP entry in {} that overrides the user one",
                client.name(),
                path.display()
            ),
        ));
    }
    if inspection.skill == Link::Foreign {
        return Err(link::conflict(&machine.skill_link(client)));
    }
    match &inspection.entry {
        Entry::Custom => return Err(custom_conflict(machine, client)),
        Entry::Unreadable(message) => {
            return Err(ConnectError::new("CONFIG_UNREADABLE", message.clone()));
        }
        _ => {}
    }
    let (changed, result) = apply(machine, stable, client, &inspection);
    result.map(|()| changed)
}

/// Brings every connected client to the complete set: a managed MCP entry
/// of a previous desktop app becomes a full connection, and a set with a
/// missing artifact is repaired. Clients that are not connected are left
/// alone. Returns whether anything changed and what could not be repaired.
pub fn reconcile(machine: &Machine) -> (bool, Vec<(Client, ConnectError)>) {
    let mut changed = false;
    let mut errors = Vec::new();
    for client in Client::ALL {
        let inspection = inspect(machine, client);
        if !inspection.connected() || complete(machine, client, &inspection) {
            continue;
        }
        let result = match installed(machine) {
            Ok(stable) => {
                let (wrote, result) = apply(machine, stable, client, &inspection);
                changed |= wrote;
                result
            }
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            errors.push((client, error));
        }
    }
    (changed, errors)
}

/// Writes what is missing and returns whether it wrote, also when a step
/// failed. Claude Code loses its user MCP entry only after its plugin link
/// is in place, so it never ends up without MCP.
fn apply(
    machine: &Machine,
    stable: &Stable,
    client: Client,
    inspection: &Inspection,
) -> (bool, Result<(), ConnectError>) {
    let link = machine.skill_link(client);
    let linked = link::ensure(&link, &Machine::skill_target(stable, client));
    let mut changed = *linked.as_ref().unwrap_or(&false);
    let entry = match (client, &inspection.entry) {
        (_, Entry::Custom) => Err(custom_conflict(machine, client)),
        (_, Entry::Unreadable(message)) => {
            Err(ConnectError::new("CONFIG_UNREADABLE", message.clone()))
        }
        (Client::ClaudeCode, current) if current.is_svode() && linked.is_ok() => {
            entry::remove(machine, client).map(|()| true)
        }
        (Client::ClaudeCode, _) => Ok(false),
        (Client::Codex, current) if entry::is_canonical(current, &stable.launcher_mcp) => Ok(false),
        (Client::Codex, _) => entry::write_codex(machine, &stable.launcher_mcp).map(|()| true),
    };
    changed |= *entry.as_ref().unwrap_or(&false);
    (changed, linked.and(entry).map(|_| ()))
}

/// Removes the marked artifacts of `client`; custom entries and foreign
/// skills stay. The shared skill goes with the last client that reads it.
/// Returns whether anything changed.
pub fn disconnect(machine: &Machine, client: Client) -> Result<bool, ConnectError> {
    let mut changed = false;
    let entry = entry::read(machine, client);
    if let Entry::Unreadable(message) = &entry {
        return Err(ConnectError::new("CONFIG_UNREADABLE", message.clone()));
    }
    if entry.is_svode() {
        entry::remove(machine, client)?;
        changed = true;
    }
    if let Some(stable) = &machine.stable {
        let shared_by_another = client.uses_shared_skill()
            && Client::ALL.into_iter().any(|other| {
                other != client && other.uses_shared_skill() && inspect(machine, other).connected()
            });
        if !shared_by_another {
            changed |= link::remove(
                &machine.skill_link(client),
                &Machine::skill_target(stable, client),
            )?;
        }
    }
    Ok(changed)
}

fn custom_conflict(machine: &Machine, client: Client) -> ConnectError {
    ConnectError::new(
        "CUSTOM_CONFIG_CONFLICT",
        format!(
            "{} already has a custom svode MCP entry in {}; Svode did not replace it",
            client.name(),
            machine.mcp_config(client).display()
        ),
    )
}
