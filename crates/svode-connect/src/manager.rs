//! Connect, reconcile and disconnect (Stage 10 `03` A9). The kit of an
//! agent has its own part, whose presence is the agent's consent, and may
//! need a shared part of the machine:
//!
//! | Client                  | Own part                                               | Shared part              |
//! |-------------------------|--------------------------------------------------------|--------------------------|
//! | Claude Code             | `~/.claude/skills/svode` → payload: skill, `bin/`, MCP | —                        |
//! | Codex                   | `[mcp_servers.svode]` in `~/.codex/config.toml`        | `~/.agents/skills/svode` |
//! | opencode, Qwen Code, pi | the `svode` MCP entry their own `mcp add` writes       | `~/.agents/skills/svode` |
//! | Grok Build              | — (its limitation says why)                            | `~/.agents/skills/svode` |
//!
//! A client is connected when its own part carries the Svode marker; a
//! connected client always gets its complete kit, including a missing shared
//! part. Disconnecting removes only the client's own marked part; the shared
//! skill goes only by an explicit [`remove_shared_skill`].
//!
//! Claude Code gets its MCP server from the plugin, so a user entry Svode
//! wrote earlier is removed once the plugin link is in place; Codex keeps a
//! managed entry that starts the stable launcher.

use std::path::PathBuf;

use crate::agent_mcp;
use crate::entry::{self, Entry};
use crate::error::ConnectError;
use crate::link::{self, Link};
use crate::machine::{Client, Kit, Machine, Stable};

/// What one client has on this machine.
#[derive(Debug, Clone)]
pub(crate) struct Inspection {
    kit: Kit,
    pub skill: Link,
    pub entry: Entry,
    /// A project or local entry that overrides the user entry.
    pub higher: Result<Option<PathBuf>, ConnectError>,
}

impl Inspection {
    /// The own part of the client carries the Svode marker: the plugin link
    /// or an entry of Claude Code, the MCP entry of the others. The shared
    /// skill alone connects nobody.
    pub fn connected(&self) -> bool {
        match self.kit {
            Kit::ClaudePlugin => self.skill == Link::Managed || self.entry.is_svode(),
            Kit::CodexMcp | Kit::CommandMcp(_) => self.entry.is_svode(),
            Kit::SharedSkillOnly => false,
        }
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
        kit: client.kit,
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
        && match client.kit {
            Kit::ClaudePlugin => !inspection.entry.is_svode(),
            Kit::CodexMcp | Kit::CommandMcp(_) => {
                entry::is_canonical(&inspection.entry, &stable.launcher_mcp)
            }
            Kit::SharedSkillOnly => false,
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

/// Connects `client` completely: its own part and the shared part its kit
/// needs, reusing a shared part already in place, so the agent gets the
/// skill, `svode` and the MCP server. Every conflict is checked before the
/// first write, so a refused connection writes nothing. Returns whether
/// anything changed.
pub fn connect(machine: &Machine, client: Client) -> Result<bool, ConnectError> {
    if !client.has_own_part() {
        return Err(ConnectError::new(
            "NO_OWN_PART",
            format!(
                "Svode has no part of its own to add to {}: {}",
                client.name(),
                client
                    .limitation()
                    .unwrap_or("it reads the shared Svode skill")
            ),
        ));
    }
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
    if matches!(client.kit, Kit::CommandMcp(_)) && machine.find(client.agent()).is_none() {
        return Err(agent_mcp::not_found(client.agent()));
    }
    let (changed, result) = apply(machine, stable, client, &inspection);
    result.map(|()| changed)
}

/// Brings every connected client to the complete set: a managed MCP entry
/// of a previous desktop app becomes a full connection, and a set with a
/// missing artifact, the shared skill included, is repaired. Clients without
/// their own part are left alone, also when they read the shared skill.
/// Returns whether anything changed and what could not be repaired.
pub fn reconcile(machine: &Machine) -> (bool, Vec<(Client, ConnectError)>) {
    let mut changed = false;
    let mut errors = Vec::new();
    for client in Client::all() {
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
    let entry = match (client.kit, &inspection.entry) {
        (_, Entry::Custom) => Err(custom_conflict(machine, client)),
        (_, Entry::Unreadable(message)) => {
            Err(ConnectError::new("CONFIG_UNREADABLE", message.clone()))
        }
        (Kit::ClaudePlugin, current) if current.is_svode() && linked.is_ok() => {
            entry::remove(machine, client).map(|()| true)
        }
        (Kit::ClaudePlugin, _) => Ok(false),
        (Kit::CodexMcp | Kit::CommandMcp(_), current)
            if entry::is_canonical(current, &stable.launcher_mcp) =>
        {
            Ok(false)
        }
        (Kit::CodexMcp, _) => entry::write_codex(machine, &stable.launcher_mcp).map(|()| true),
        (Kit::CommandMcp(kind), _) => {
            agent_mcp::write(machine, kind, &stable.launcher_mcp).map(|()| true)
        }
        (Kit::SharedSkillOnly, _) => Ok(false),
    };
    changed |= *entry.as_ref().unwrap_or(&false);
    (changed, linked.and(entry).map(|_| ()))
}

/// Removes the own part of `client` where it carries the Svode marker:
/// the plugin link and any marked entry of Claude Code, the MCP entry of
/// the others; an agent without an own part has nothing to remove.
/// Custom entries, foreign skills and the shared skill stay. Returns
/// whether anything changed.
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
    if let Some(stable) = &machine.stable
        && client.kit == Kit::ClaudePlugin
    {
        changed |= link::remove(
            &machine.skill_link(client),
            &Machine::skill_target(stable, client),
        )?;
    }
    Ok(changed)
}

/// The connected clients whose kit needs the shared skill.
pub(crate) fn shared_skill_required_by(machine: &Machine) -> Vec<Client> {
    Client::all()
        .into_iter()
        .filter(|client| client.uses_shared_skill() && inspect(machine, *client).connected())
        .collect()
}

/// Removes the shared skill while it is Svode's link. Refused while the own
/// part of a connected client needs it: reconcile would restore it.
/// Returns whether anything changed.
pub fn remove_shared_skill(machine: &Machine) -> Result<bool, ConnectError> {
    let Some(stable) = &machine.stable else {
        return Ok(false);
    };
    let required_by = shared_skill_required_by(machine);
    if !required_by.is_empty() {
        let names = required_by
            .iter()
            .map(|client| client.name())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ConnectError::new(
            "SHARED_SKILL_REQUIRED",
            format!(
                "the shared Svode skill {} is part of the Svode tools of {names}; remove their tools first",
                machine.shared_skill_link().display()
            ),
        ));
    }
    link::remove(
        &machine.shared_skill_link(),
        &Machine::shared_skill_target(stable),
    )
}

fn custom_conflict(machine: &Machine, client: Client) -> ConnectError {
    ConnectError::new(
        "CUSTOM_CONFIG_CONFLICT",
        format!(
            "{} already has a custom svode MCP entry in {}; Svode did not replace it",
            client.name(),
            machine
                .mcp_config(client)
                .map_or_else(|| "its config".into(), |path| path.display().to_string())
        ),
    )
}
