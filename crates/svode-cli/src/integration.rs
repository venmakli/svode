//! `svode integration`: the connection manager shared with the desktop app,
//! for a machine with or without it. It reads and writes client configs
//! only and opens no Project.

use serde_json::{Map, json};
use svode_connect::{Client, ClientStatus, ConnectError, Machine, RESTART_NOTICE};
use svode_tools::target::project_for_cwd;

use crate::error::CliError;
use crate::grammar::{ClientName, IntegrationVerb};
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
            let client = client_of(client);
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
            Ok(result(human, changed, &statuses))
        }
        IntegrationVerb::Disconnect { client, all } => {
            let clients = match (client, all) {
                (Some(client), _) => vec![client_of(client)],
                (None, _) => Client::ALL.to_vec(),
            };
            let mut changed = false;
            let mut human = String::new();
            for client in clients {
                let removed = svode_connect::disconnect(&machine, client).map_err(failure)?;
                changed |= removed;
                human.push_str(&if removed {
                    format!("Disconnected {} from Svode.\n", client.name())
                } else {
                    format!("{} was not connected to Svode.\n", client.name())
                });
            }
            let statuses = svode_connect::client_statuses(&machine, &[]);
            Ok(result(human, changed, &statuses))
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
            Ok(Outcome {
                human,
                envelope: envelope(
                    Map::new(),
                    json!({ "runtime": status.server, "clients": status.clients }),
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
            Ok(result(human, changed, &statuses))
        }
    }
}

fn result(mut human: String, changed: bool, statuses: &[ClientStatus]) -> Outcome {
    human.push_str(&clients_human(statuses));
    Outcome {
        human,
        envelope: envelope(
            Map::new(),
            json!({ "changed": changed, "clients": statuses }),
        ),
        warnings: Vec::new(),
    }
}

fn clients_human(statuses: &[ClientStatus]) -> String {
    let mut out = String::new();
    for status in statuses {
        let state = match (status.installed, status.found) {
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
        for issue in &status.issues {
            out.push_str(&format!("  ! {}: {}\n", issue.code, issue.message));
        }
    }
    out
}

fn client_of(name: ClientName) -> Client {
    match name {
        ClientName::ClaudeCode => Client::ClaudeCode,
        ClientName::Codex => Client::Codex,
    }
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
