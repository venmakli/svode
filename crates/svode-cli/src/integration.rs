//! `svode integration`: the connection manager shared with the desktop app,
//! for a machine with or without it. It reads and writes client configs
//! only and opens no Project.

use serde_json::{Map, json};
use svode_connect::{
    Client, ClientStatus, ConnectError, Machine, RESTART_NOTICE, SharedSkillStatus,
};
use svode_tools::target::project_for_cwd;

use crate::error::CliError;
use crate::grammar::IntegrationVerb;
use crate::output::Outcome;
use crate::target::Selectors;
use crate::tools::envelope;

pub fn run(verb: IntegrationVerb, selectors: &Selectors<'_>) -> Result<Outcome, CliError> {
    // The Project whose project and local client entries would override a
    // user entry: the explicit one, else the one around the directory.
    let project = match selectors.project {
        Some(project) => Some(selectors.cwd.join(project)),
        None => project_for_cwd(selectors.cwd).ok(),
    };
    let machine = Machine::user()
        .map_err(failure)?
        .with_project(project.as_deref());
    match verb {
        IntegrationVerb::Connect { client } => {
            let client = Client::parse(&client).map_err(failure)?;
            let changed = svode_connect::connect(&machine, client).map_err(failure)?;
            let statuses = svode_connect::client_statuses(&machine, &[]);
            let status = statuses.iter().find(|status| status.id == client.as_str());
            let version = status
                .and_then(|status| status.version.as_deref())
                .unwrap_or("?");
            let human = if changed {
                format!(
                    "Connected {} to Svode {version}.\n{RESTART_NOTICE}\n",
                    client.name()
                )
            } else {
                format!(
                    "{} is already connected to Svode {version}.\n",
                    client.name()
                )
            };
            Ok(result(human, changed, &statuses, &machine))
        }
        IntegrationVerb::Disconnect {
            client,
            all,
            shared_skill,
        } => {
            let clients = match client {
                Some(client) => vec![Client::parse(&client).map_err(failure)?],
                None if all => Client::all()
                    .into_iter()
                    .filter(|client| client.has_own_part())
                    .collect(),
                None => Vec::new(),
            };
            let before = svode_connect::client_statuses(&machine, &[]);
            let needed_shared = svode_connect::shared_skill_status(&machine).required_by;
            let mut changed = false;
            let mut left_shared = false;
            let mut human = String::new();
            for client in clients {
                let removed = svode_connect::disconnect(&machine, client).map_err(failure)?;
                changed |= removed;
                left_shared |= removed && needed_shared.iter().any(|id| id == client.as_str());
                let part = before
                    .iter()
                    .find(|status| status.id == client.as_str())
                    .and_then(|status| status.own_part.as_ref())
                    .map_or("Svode tools", |part| match part.kind.as_str() {
                        "plugin" => "Svode plugin",
                        "skills-entry" => "shared skill directory entry",
                        _ => "Svode MCP entry",
                    });
                human.push_str(&if removed {
                    format!("Removed the {part} of {}.\n", client.name())
                } else {
                    format!("{} had no {part} to remove.\n", client.name())
                });
            }
            let shared = svode_connect::shared_skill_status(&machine);
            if all || shared_skill {
                let removed = svode_connect::remove_shared_skill(&machine).map_err(failure)?;
                changed |= removed;
                human.push_str(&match (removed, shared.state.as_str()) {
                    (true, _) => format!(
                        "Removed the shared Svode skill {}{}.\n",
                        shared.path,
                        agent_list(", which ", &shared.readers, " read")
                    ),
                    (false, "foreign") => {
                        format!("{} is not the Svode skill; Svode left it.\n", shared.path)
                    }
                    (false, _) => "The shared Svode skill was not installed.\n".to_string(),
                });
            } else if left_shared && shared.state == "managed" {
                human.push_str(&format!(
                    "The shared Svode skill {} stays{}; `svode integration disconnect --shared-skill` removes it.\n",
                    shared.path,
                    agent_list(" for ", &shared.readers, "")
                ));
            }
            let statuses = svode_connect::client_statuses(&machine, &[]);
            Ok(result(human, changed, &statuses, &machine))
        }
        IntegrationVerb::Status => {
            let status = svode_connect::status(&machine, &[], None);
            let mut human = match (&status.server.runtime, &status.server.message) {
                (Some(runtime), _) => format!(
                    "runtime: Svode {} ({}) through {}\n",
                    runtime.version,
                    runtime.kind,
                    status.server.command.as_deref().unwrap_or_default()
                ),
                (None, message) => {
                    format!("runtime: {}\n", message.as_deref().unwrap_or("unavailable"))
                }
            };
            human.push_str(&clients_human(&status.clients));
            human.push_str(&shared_human(&status.shared_skill));
            Ok(Outcome {
                human,
                envelope: envelope(
                    Map::new(),
                    json!({
                        "runtime": status.server,
                        "clients": status.clients,
                        "sharedSkill": status.shared_skill,
                    }),
                ),
                warnings: Vec::new(),
            })
        }
        IntegrationVerb::Sync => {
            let (changed, errors) = svode_connect::reconcile(&machine);
            let statuses = svode_connect::client_statuses(&machine, &errors);
            if !errors.is_empty() {
                let message = errors
                    .iter()
                    .map(|(client, error)| format!("{}: {}", client.name(), error.message))
                    .collect::<Vec<_>>()
                    .join("; ");
                let mut failure = CliError::operation("RECONCILE_FAILED", message);
                failure.evidence.insert(
                    "clients".into(),
                    serde_json::to_value(&statuses).unwrap_or_default(),
                );
                return Err(failure);
            }
            let human = if changed {
                format!("Completed the Svode connections.\n{RESTART_NOTICE}\n")
            } else {
                "The Svode connections are complete.\n".to_string()
            };
            Ok(result(human, changed, &statuses, &machine))
        }
    }
}

fn result(
    mut human: String,
    changed: bool,
    statuses: &[ClientStatus],
    machine: &Machine,
) -> Outcome {
    let shared = svode_connect::shared_skill_status(machine);
    human.push_str(&clients_human(statuses));
    human.push_str(&shared_human(&shared));
    Outcome {
        human,
        envelope: envelope(
            Map::new(),
            json!({ "changed": changed, "clients": statuses, "sharedSkill": shared }),
        ),
        warnings: Vec::new(),
    }
}

/// The shared skill: a part of the machine with the agents that read it
/// and the connected ones that need it.
fn shared_human(shared: &SharedSkillStatus) -> String {
    let state = match shared.state.as_str() {
        "managed" => "installed",
        "foreign" => "not the Svode skill",
        _ => "not installed",
    };
    format!(
        "shared skill {}: {state}{}{}\n",
        shared.path,
        agent_list("; read by ", &shared.readers, ""),
        agent_list("; needed by ", &shared.required_by, "")
    )
}

/// `prefix` and the names of the agents with ids `ids`, then `suffix`;
/// nothing without agents.
fn agent_list(prefix: &str, ids: &[String], suffix: &str) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let names = ids
        .iter()
        .map(|id| Client::parse(id).map_or_else(|_| id.clone(), |client| client.name().to_string()))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{prefix}{names}{suffix}")
}

fn clients_human(statuses: &[ClientStatus]) -> String {
    let mut out = String::new();
    for status in statuses {
        let state = match (status.installed, status.found) {
            (false, true) if status.own_part.is_none() => "reads the shared skill only".to_string(),
            (true, _) => format!(
                "connected{}",
                status
                    .version
                    .as_deref()
                    .map(|version| format!(" ({version})"))
                    .unwrap_or_default()
            ),
            (false, true) => "not connected".to_string(),
            (false, false) => "not found".to_string(),
        };
        out.push_str(&format!("{}: {state}\n", status.name));
        if let Some(limitation) = status.limitation.as_deref().filter(|_| status.found) {
            out.push_str(&format!("  {limitation}\n"));
        }
        for issue in &status.issues {
            out.push_str(&format!("  ! {}: {}\n", issue.code, issue.message));
        }
    }
    out
}

fn failure(error: ConnectError) -> CliError {
    let mut failure = CliError::operation(error.code, error.message);
    if error.code == "RUNTIME_UNAVAILABLE" {
        failure = failure.with_hint(
            "start Svode Desktop once, or install the standalone Svode runtime with its installer",
        );
    }
    failure
}
