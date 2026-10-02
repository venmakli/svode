//! Live acceptance of the runtime without Tauri: start a real ACP agent,
//! send one prompt, stream the turn, stop the agent.
//!
//! cargo run -p svode-agents --example live_turn -- \
//!     --agent hermes --cwd /tmp/probe --prompt "Reply with: ok" -- hermes acp
//!
//! `--env KEY=VALUE` adds to the agent environment, e.g. `CODEX_PATH` for
//! the Codex adapter.
//!
//! Without `--prompt` it stops after `session/new`, without a paid turn.
//!
//! `--setting ID=VALUE` applies a declared session setting at creation, as
//! an ACP launch applies the mode an Actor approval maps to, and prints the
//! settings the session then reports.
//!
//! `--on-pending <option kind | decline | cancel>` answers a permission with
//! its first option of that kind (`allow_once`, `reject_once`, …), declines
//! a question, or cancels the turn; the answer is then repeated to show
//! `not_pending`.
//!
//! `--open <session id>` opens an existing session instead of creating one:
//! `session/load` replays its history, no prompt is sent unless `--prompt`
//! is given. `--reopen` closes the connection after the turn, connects
//! again and opens the same session to compare its replay with the live
//! turn.
//!
//! `--list` only reads the agent's `session/list` as the catalogue source
//! and stops: no session is created or opened, no prompt is sent.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use svode_agents::activity::{ActivityItem, Change, InteractionState, ItemKind, TurnPhase};
use svode_agents::identity::SessionKey;
use svode_agents::interaction::InteractionAnswer;
use svode_agents::status::InteractionKind;
use svode_agents::writer::{ExternalLiveness, UnknownLiveness};
use svode_agents::{AcpLaunch, AgentRuntime, ConnectionId, RuntimeConfig, SettingValue};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut agent = "agent".to_string();
    let mut cwd = std::env::current_dir().unwrap();
    let mut prompt = None;
    let mut on_pending = None;
    let mut open = None;
    let mut reopen = false;
    let mut list = false;
    let mut settings = Vec::new();
    let mut env = BTreeMap::new();
    let mut command = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--agent" => agent = args.next().expect("--agent value"),
            "--cwd" => cwd = PathBuf::from(args.next().expect("--cwd value")),
            "--prompt" => prompt = Some(args.next().expect("--prompt value")),
            "--on-pending" => on_pending = Some(args.next().expect("--on-pending value")),
            "--open" => open = Some(args.next().expect("--open value")),
            "--reopen" => reopen = true,
            "--list" => list = true,
            "--setting" => {
                let pair = args.next().expect("--setting ID=VALUE");
                let (setting, value) = pair.split_once('=').expect("--setting ID=VALUE");
                settings.push(SettingValue {
                    setting: setting.to_string(),
                    value: value.to_string(),
                });
            }
            "--env" => {
                let pair = args.next().expect("--env KEY=VALUE");
                let (key, value) = pair.split_once('=').expect("--env KEY=VALUE");
                env.insert(key.to_string(), value.to_string());
            }
            "--" => command.extend(args.by_ref()),
            other => panic!("unknown argument {other}"),
        }
    }
    let (program, program_args) = command.split_first().expect("agent command after --");

    let runtime = AgentRuntime::new(RuntimeConfig {
        request_timeout: Duration::from_secs(60),
        ..RuntimeConfig::default()
    });
    let started = Instant::now();
    let launch = AcpLaunch {
        agent: agent.clone(),
        program: PathBuf::from(program),
        args: program_args.to_vec(),
        env,
        cwd: cwd.clone(),
        acp_id_is_native: false,
        lists_catalog: list,
    };
    let connection = connect(&runtime, &launch).await;

    if list {
        let offered = runtime.catalog_connections();
        println!("catalog connections: {offered:?}");
        let read = Instant::now();
        match runtime.list_sessions(connection).await {
            Ok(sessions) => {
                println!(
                    "session/list: {} sessions, truncated {}, skipped {} in {:.2}s",
                    sessions.sessions.len(),
                    sessions.truncated,
                    sessions.skipped,
                    read.elapsed().as_secs_f64()
                );
                for session in sessions.sessions.iter().take(5) {
                    println!(
                        "  {} {:?} cwd {} updated {:?} title {:?}",
                        session.key.session_id,
                        session.key.namespace,
                        session.cwd.display(),
                        session.updated_at,
                        session
                            .title
                            .as_deref()
                            .map(|title| title.chars().take(40).collect::<String>())
                    );
                }
            }
            Err(error) => println!("session/list failed: {error}"),
        }
        runtime.close_connection(connection).await.unwrap();
        return;
    }

    let key = match open {
        Some(session_id) => {
            let key = SessionKey::from_acp(&agent, &session_id, false);
            open_existing(&runtime, connection, &key, &cwd).await;
            key
        }
        None => match runtime.new_session(connection, &cwd, &settings).await {
            Ok(key) => {
                for setting in runtime.subscribe(&key).unwrap().snapshot.settings {
                    println!(
                        "setting {} ({:?}) = {} of {:?}",
                        setting.id,
                        setting.category,
                        setting.current_value,
                        setting
                            .options
                            .iter()
                            .map(|option| option.value.as_str())
                            .collect::<Vec<_>>()
                    );
                }
                key
            }
            Err(error) => {
                println!(
                    "session/new failed: {error}; connection {:?}",
                    runtime.connection_status(connection).unwrap().state
                );
                runtime.close_connection(connection).await.unwrap();
                std::process::exit(1);
            }
        },
    };
    println!("session: {}", serde_json::to_string(&key).unwrap());

    if let Some(prompt) = prompt {
        let mut subscription = runtime.subscribe(&key).unwrap();
        let turn = runtime.prompt(&key, &prompt).unwrap();
        println!("turn accepted: {turn}");
        let mut gaps = 0;
        while !(subscription.snapshot.turn.phase == TurnPhase::None
            && subscription.snapshot.turn.turn_id.is_some())
        {
            let delta = tokio::time::timeout(Duration::from_secs(300), subscription.deltas.recv())
                .await
                .expect("turn progresses within 5 minutes")
                .expect("delta stream is open");
            if !subscription.snapshot.apply(&delta) {
                gaps += 1;
            }
            let change = match &delta.change {
                Change::Item(item) => format!(
                    "item {} {} {:?}",
                    item.id,
                    serde_json::to_value(&item.kind).unwrap()["kind"],
                    item.summary.chars().take(80).collect::<String>()
                ),
                Change::Turn(turn) => format!(
                    "turn {:?} {}",
                    turn.phase,
                    serde_json::to_string(&turn.status).unwrap()
                ),
                other => serde_json::to_string(other)
                    .unwrap()
                    .chars()
                    .take(120)
                    .collect(),
            };
            println!("seq {} {change}", delta.seq);
            if let (Change::Pending(pending), Some(action)) = (&delta.change, &on_pending)
                && pending.state == InteractionState::Pending
            {
                if action == "cancel" {
                    runtime.cancel(&key).unwrap();
                    println!("cancel requested");
                    continue;
                }
                let answer = match pending.kind {
                    InteractionKind::Question => InteractionAnswer::Decline,
                    InteractionKind::Permission => InteractionAnswer::Option {
                        option_id: pending
                            .options
                            .iter()
                            .find(|option| {
                                serde_json::to_value(option.kind).unwrap() == action.as_str()
                            })
                            .expect("an option of the requested kind")
                            .id
                            .clone(),
                    },
                };
                for attempt in ["answer", "repeat"] {
                    let outcome = runtime.answer(&key, &pending.id, answer.clone());
                    println!(
                        "{attempt} {}: {}",
                        pending.id,
                        match outcome {
                            Ok(outcome) => serde_json::to_string(&outcome).unwrap(),
                            Err(error) => error.to_string(),
                        }
                    );
                }
            }
        }
        let fresh = runtime.subscribe(&key).unwrap().snapshot;
        println!(
            "turn ended in {:?}: outcome {:?}, seq gaps {gaps}, snapshot+deltas equals runtime state: {}",
            started.elapsed(),
            fresh.turn.last_outcome,
            fresh == subscription.snapshot
        );
    }

    runtime.close_connection(connection).await.unwrap();
    println!(
        "stopped: {:?}",
        runtime.connection_status(connection).unwrap().state
    );

    if reopen {
        let live = messages(&runtime.subscribe(&key).unwrap().snapshot.items);
        let again = connect(&runtime, &launch).await;
        open_existing(&runtime, again, &key, &cwd).await;
        let replayed = messages(&runtime.subscribe(&key).unwrap().snapshot.items);
        println!("live messages:     {live:?}");
        println!("replayed messages: {replayed:?}");
        println!("replay matches the live turn: {}", live == replayed);
        runtime.close_connection(again).await.unwrap();
    }
}

async fn connect(runtime: &AgentRuntime, launch: &AcpLaunch) -> ConnectionId {
    let started = Instant::now();
    match runtime.connect(launch.clone()).await {
        Ok(connection) => {
            let status = runtime.connection_status(connection).unwrap();
            println!(
                "connected in {:?}: {}",
                started.elapsed(),
                serde_json::to_string(&status).unwrap()
            );
            connection
        }
        Err(error) => {
            println!("connect failed: {error}");
            std::process::exit(1);
        }
    }
}

/// Opens an existing session; the user of this example has confirmed that
/// no other process writes to it.
async fn open_existing(
    runtime: &AgentRuntime,
    connection: ConnectionId,
    key: &SessionKey,
    cwd: &std::path::Path,
) {
    let started = Instant::now();
    if let Err(error) = runtime
        .open_session(
            connection,
            key,
            cwd,
            ExternalLiveness::Unknown,
            UnknownLiveness::Confirmed,
        )
        .await
    {
        println!("open failed: {error}");
        runtime.close_connection(connection).await.unwrap();
        std::process::exit(1);
    }
    let snapshot = runtime.subscribe(key).unwrap().snapshot;
    println!(
        "opened in {:?}: history {}, {} items, turn {:?}, writer {:?}",
        started.elapsed(),
        serde_json::to_string(&snapshot.history).unwrap(),
        snapshot.items.len(),
        snapshot.turn.phase,
        snapshot.writer
    );
    for item in &snapshot.items {
        println!(
            "  {} {} {} {:?}",
            item.turn_id.as_deref().unwrap_or("-"),
            item.id,
            serde_json::to_value(&item.kind).unwrap()["kind"],
            item.summary.chars().take(60).collect::<String>()
        );
    }
}

/// The user and agent messages of a session, as text.
fn messages(items: &[ActivityItem]) -> Vec<(String, String)> {
    items
        .iter()
        .filter_map(|item| match item.kind {
            ItemKind::UserMessage => Some(("user".to_string(), item.summary.clone())),
            ItemKind::AgentMessage => Some(("agent".to_string(), item.summary.clone())),
            _ => None,
        })
        .collect()
}
