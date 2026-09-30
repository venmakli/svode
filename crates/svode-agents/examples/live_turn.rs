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
//! `--on-pending <option kind | decline | cancel>` answers a permission with
//! its first option of that kind (`allow_once`, `reject_once`, …), declines
//! a question, or cancels the turn; the answer is then repeated to show
//! `not_pending`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use svode_agents::activity::{Change, InteractionState, TurnPhase};
use svode_agents::interaction::InteractionAnswer;
use svode_agents::status::InteractionKind;
use svode_agents::{AcpLaunch, AgentRuntime, RuntimeConfig};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut agent = "agent".to_string();
    let mut cwd = std::env::current_dir().unwrap();
    let mut prompt = None;
    let mut on_pending = None;
    let mut env = BTreeMap::new();
    let mut command = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--agent" => agent = args.next().expect("--agent value"),
            "--cwd" => cwd = PathBuf::from(args.next().expect("--cwd value")),
            "--prompt" => prompt = Some(args.next().expect("--prompt value")),
            "--on-pending" => on_pending = Some(args.next().expect("--on-pending value")),
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
    let connection = match runtime
        .connect(AcpLaunch {
            agent: agent.clone(),
            program: PathBuf::from(program),
            args: program_args.to_vec(),
            env,
            cwd: cwd.clone(),
            acp_id_is_native: false,
        })
        .await
    {
        Ok(connection) => connection,
        Err(error) => {
            println!("connect failed: {error}");
            std::process::exit(1);
        }
    };
    let status = runtime.connection_status(connection).unwrap();
    println!(
        "connected in {:?}: {}",
        started.elapsed(),
        serde_json::to_string(&status).unwrap()
    );

    let key = match runtime.new_session(connection, &cwd).await {
        Ok(key) => key,
        Err(error) => {
            println!(
                "session/new failed: {error}; connection {:?}",
                runtime.connection_status(connection).unwrap().state
            );
            runtime.close_connection(connection).await.unwrap();
            std::process::exit(1);
        }
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
}
