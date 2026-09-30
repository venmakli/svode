use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use super::*;
use crate::activity::{Change, DetailBlock, ItemKind, ItemStatus, TurnPhase, UnavailableReason};
use crate::status::{SessionState, SessionStatus};

/// The agent end of an in-memory ACP transport, driven step by step.
struct ScriptedAgent {
    lines: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
    output: WriteHalf<DuplexStream>,
}

impl ScriptedAgent {
    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("agent waits for a message")
            .unwrap()
            .expect("client stream is open");
        serde_json::from_str(&line).unwrap()
    }

    /// Next message must be a request or notification with this method.
    async fn expect(&mut self, method: &str) -> Value {
        let message = self.recv().await;
        assert_eq!(message["method"], method, "unexpected message {message}");
        message
    }

    async fn send(&mut self, message: Value) {
        self.output
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn reply(&mut self, request: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }))
            .await;
    }

    async fn update(&mut self, session: &str, update: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session, "update": update }
        }))
        .await;
    }

    /// Answers `initialize` and `session/new` with session id `s1`.
    async fn open_session(&mut self) {
        let initialize = self.expect("initialize").await;
        self.reply(
            &initialize,
            json!({
                "protocolVersion": 1,
                "agentCapabilities": { "loadSession": true, "sessionCapabilities": { "list": {} } },
                "agentInfo": { "name": "scripted", "version": "1.0.0" }
            }),
        )
        .await;
        let new_session = self.expect("session/new").await;
        self.reply(&new_session, json!({ "sessionId": "s1" })).await;
    }
}

fn launch() -> AcpLaunch {
    AcpLaunch {
        agent: "scripted".into(),
        program: PathBuf::from("scripted"),
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: PathBuf::from("/project"),
        acp_id_is_native: false,
    }
}

fn attached(runtime: &AgentRuntime) -> (ConnectionId, ScriptedAgent) {
    let (client, agent) = tokio::io::duplex(4 * 1024 * 1024);
    let (client_read, client_write) = tokio::io::split(client);
    let (agent_read, agent_write) = tokio::io::split(agent);
    let id = runtime.attach(&launch(), client_read, client_write, None);
    (
        id,
        ScriptedAgent {
            lines: BufReader::new(agent_read).lines(),
            output: agent_write,
        },
    )
}

async fn session(runtime: &AgentRuntime) -> (ConnectionId, SessionKey, ScriptedAgent) {
    let (id, mut agent) = attached(runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        agent.open_session()
    );
    (id, key, agent)
}

/// Collects deltas until `done` holds for the snapshot they build.
async fn follow(
    subscription: &mut SessionSubscription,
    done: impl Fn(&SessionSnapshot) -> bool,
) -> Vec<SessionDelta> {
    let mut deltas = Vec::new();
    while !done(&subscription.snapshot) {
        let delta = tokio::time::timeout(Duration::from_secs(5), subscription.deltas.recv())
            .await
            .expect("runtime delivers the next delta")
            .unwrap();
        assert!(
            subscription.snapshot.apply(&delta),
            "seq must be monotonic without gaps"
        );
        deltas.push(delta);
    }
    deltas
}

fn idle(snapshot: &SessionSnapshot) -> bool {
    snapshot.turn.phase == TurnPhase::None && snapshot.turn.turn_id.is_some()
}

#[tokio::test]
async fn a_turn_streams_ordered_deltas_and_ends_with_the_agent_stop_reason() {
    let runtime = AgentRuntime::default();
    let (connection, key, mut agent) = session(&runtime).await;
    assert_eq!(key.namespace, crate::identity::IdentityNamespace::Acp);
    let status = runtime.connection_status(connection).unwrap();
    assert_eq!(status.state, ConnectionState::Ready);
    assert!(status.agent.unwrap().capabilities.list_sessions);

    let mut subscription = runtime.subscribe(&key).unwrap();
    let turn = runtime.prompt(&key, "Say hello").unwrap();
    let prompt = agent.expect("session/prompt").await;
    assert_eq!(prompt["params"]["prompt"][0]["text"], "Say hello");
    agent
        .update("s1", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello" } }))
        .await;
    agent
        .update("s1", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": " world" } }))
        .await;
    agent
        .update("s1", json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read file", "kind": "read", "status": "in_progress" }))
        .await;
    agent
        .update("s1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "file body" } }] }))
        .await;
    agent
        .update("s1", json!({ "sessionUpdate": "plan", "entries": [{ "content": "Step", "priority": "high", "status": "completed" }] }))
        .await;
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "future_update", "anything": true }),
        )
        .await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;

    follow(&mut subscription, idle).await;
    let fresh = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(
        subscription.snapshot, fresh,
        "snapshot + deltas = runtime state"
    );

    let items = &fresh.items;
    assert_eq!(items[0].kind, ItemKind::UserMessage);
    assert_eq!(items[0].turn_id.as_deref(), Some(turn.as_str()));
    let message = items
        .iter()
        .find(|item| item.kind == ItemKind::AgentMessage)
        .unwrap();
    assert_eq!(message.summary, "Hello world");
    let tool = items.iter().find(|item| item.id == "t1").unwrap();
    assert_eq!(tool.summary, "Read file");
    assert_eq!(tool.status, Some(ItemStatus::Completed));
    assert!(tool.has_detail);
    assert_eq!(
        runtime.detail(&key, "t1"),
        DetailOutcome::Available {
            blocks: vec![DetailBlock::Text {
                text: "file body".into()
            }]
        }
    );
    assert!(items.iter().any(|item| item.kind
        == ItemKind::Generic {
            label: "future_update".into()
        }));
    assert_eq!(fresh.plan.unwrap().entries.len(), 1);
    assert_eq!(
        fresh.turn.status,
        SessionStatus::runtime(SessionState::Idle {
            stop_reason: Some(StopReason::EndTurn)
        })
    );
}

#[tokio::test]
async fn a_prompt_during_an_active_turn_is_rejected_without_a_queue() {
    let runtime = AgentRuntime::default();
    let (_, key, mut agent) = session(&runtime).await;
    runtime.prompt(&key, "first").unwrap();
    let prompt = agent.expect("session/prompt").await;
    assert_eq!(
        runtime.prompt(&key, "second"),
        Err(AgentRuntimeError::TurnActive)
    );
    assert_eq!(
        runtime.subscribe(&key).unwrap().snapshot.turn.status.state,
        SessionState::Running
    );
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    follow(&mut subscription, idle).await;
    runtime.prompt(&key, "third").unwrap();
    let next = agent.expect("session/prompt").await;
    assert_eq!(next["params"]["prompt"][0]["text"], "third");
}

#[tokio::test]
async fn cancel_answers_the_pending_permission_and_waits_for_the_agent() {
    let runtime = AgentRuntime::default();
    let (_, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, "edit").unwrap();
    let prompt = agent.expect("session/prompt").await;
    agent
        .send(json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": { "toolCallId": "t1", "title": "Write a.md" },
                "options": [
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                ]
            }
        }))
        .await;
    follow(&mut subscription, |snapshot| {
        matches!(
            snapshot.turn.status.state,
            SessionState::RequiresAction { .. }
        )
    })
    .await;
    let pending = subscription.snapshot.pending.clone().unwrap();
    assert_eq!(pending.title, "Write a.md");
    assert_eq!(pending.options.len(), 2);
    assert_eq!(
        subscription.snapshot.turn.status.state,
        SessionState::RequiresAction {
            request: InteractionKind::Permission
        }
    );

    runtime.cancel(&key).unwrap();
    let answer = agent.recv().await;
    assert_eq!(answer["id"], "perm-1");
    assert_eq!(answer["result"]["outcome"]["outcome"], "cancelled");
    agent.expect("session/cancel").await;
    let deltas = follow(&mut subscription, |snapshot| {
        snapshot.pending.is_none() && snapshot.turn.phase == TurnPhase::Cancelling
    })
    .await;
    assert!(deltas.iter().any(|delta| matches!(
        &delta.change,
        Change::Pending(pending) if pending.state == InteractionState::Cancelled
    )));

    agent
        .update("s1", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "late" } }))
        .await;
    agent
        .reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    follow(&mut subscription, idle).await;
    assert_eq!(
        subscription.snapshot.turn.last_outcome,
        Some(StopReason::Cancelled)
    );
    assert!(
        subscription
            .snapshot
            .items
            .iter()
            .any(|item| item.summary == "late")
    );
}

#[tokio::test]
async fn agent_errors_and_timeouts_degrade_only_their_own_connection() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        request_timeout: Duration::from_millis(200),
    });
    let (_, healthy_key, mut healthy) = session(&runtime).await;
    let (failing, mut agent) = attached(&runtime);

    let (result, ()) = tokio::join!(runtime.new_session(failing, Path::new("/project")), async {
        let initialize = agent.expect("initialize").await;
        agent
            .reply(
                &initialize,
                json!({ "protocolVersion": 1, "agentCapabilities": {} }),
            )
            .await;
        let new_session = agent.expect("session/new").await;
        agent
            .send(json!({ "jsonrpc": "2.0", "id": new_session["id"], "error": { "code": -32603, "message": "Internal error", "data": { "details": "boom" } } }))
            .await;
    });
    assert_eq!(
        result,
        Err(AgentRuntimeError::Agent {
            message: "Internal error: boom".into()
        })
    );
    assert_eq!(
        runtime.connection_status(failing).unwrap().state,
        ConnectionState::Degraded
    );

    let (result, _) = tokio::join!(
        runtime.new_session(failing, Path::new("/project")),
        agent.expect("session/new")
    );
    assert_eq!(result, Err(AgentRuntimeError::Timeout));
    assert_eq!(
        runtime.connection_status(failing).unwrap().state,
        ConnectionState::Degraded
    );

    runtime.prompt(&healthy_key, "still fine").unwrap();
    let prompt = healthy.expect("session/prompt").await;
    healthy
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let mut subscription = runtime.subscribe(&healthy_key).unwrap();
    follow(&mut subscription, idle).await;
    assert_eq!(subscription.snapshot.connection, ConnectionState::Ready);

    let (result, ()) = tokio::join!(runtime.new_session(failing, Path::new("/project")), async {
        let new_session = agent.expect("session/new").await;
        agent
            .reply(&new_session, json!({ "sessionId": "s2" }))
            .await;
    });
    assert!(result.is_ok(), "the next lifecycle boundary retries");
    assert_eq!(
        runtime.connection_status(failing).unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn auth_required_is_a_recovery_outcome_not_a_degraded_connection() {
    let runtime = AgentRuntime::default();
    let (connection, mut agent) = attached(&runtime);
    let (result, ()) = tokio::join!(
        runtime.new_session(connection, Path::new("/project")),
        async {
            let initialize = agent.expect("initialize").await;
            agent
                .reply(
                    &initialize,
                    json!({ "protocolVersion": 1, "agentCapabilities": {} }),
                )
                .await;
            let new_session = agent.expect("session/new").await;
            agent
            .send(json!({ "jsonrpc": "2.0", "id": new_session["id"], "error": { "code": -32000, "message": "Authentication required" } }))
            .await;
        }
    );
    assert_eq!(
        result,
        Err(AgentRuntimeError::AuthRequired {
            message: "Authentication required".into()
        })
    );
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn agent_exit_interrupts_the_turn_and_expires_the_pending_request() {
    let runtime = AgentRuntime::default();
    let (connection, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, "work").unwrap();
    agent.expect("session/prompt").await;
    agent
        .send(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": { "toolCallId": "t1" },
                "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]
            }
        }))
        .await;
    follow(&mut subscription, |snapshot| snapshot.pending.is_some()).await;
    drop(agent);

    let deltas = follow(&mut subscription, idle).await;
    assert!(deltas.iter().any(|delta| matches!(
        &delta.change,
        Change::Pending(pending) if pending.state == InteractionState::Expired
    )));
    assert_eq!(subscription.snapshot.connection, ConnectionState::Closed);
    assert_eq!(
        subscription.snapshot.turn.last_outcome,
        Some(StopReason::Interrupted)
    );
    assert!(
        subscription
            .snapshot
            .items
            .iter()
            .any(|item| item.kind == ItemKind::Interrupted)
    );
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
    assert_eq!(
        runtime.prompt(&key, "again"),
        Err(AgentRuntimeError::ConnectionClosed)
    );
}

#[tokio::test]
async fn detail_beyond_the_item_limit_is_too_large_and_client_methods_are_refused() {
    let runtime = AgentRuntime::default();
    let (_, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, "big").unwrap();
    let prompt = agent.expect("session/prompt").await;
    agent
        .send(json!({ "jsonrpc": "2.0", "id": 9, "method": "fs/read_text_file", "params": { "sessionId": "s1", "path": "/etc/hosts" } }))
        .await;
    let refused = agent.recv().await;
    assert_eq!(refused["id"], 9);
    assert_eq!(refused["error"]["code"], -32601);

    let huge = "x".repeat(crate::projection::DETAIL_LIMIT + 1);
    agent
        .update("s1", json!({ "sessionUpdate": "tool_call", "toolCallId": "big", "title": "Dump", "content": [{ "type": "content", "content": { "type": "text", "text": huge } }] }))
        .await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;

    assert_eq!(
        runtime.detail(&key, "big"),
        DetailOutcome::Unavailable {
            reason: UnavailableReason::TooLarge
        }
    );
    assert!(matches!(
        runtime.detail(&key, "missing"),
        DetailOutcome::Error { .. }
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_that_exits_during_initialize_reports_its_stderr_and_closes() {
    let runtime = AgentRuntime::default();
    let error = runtime
        .connect(AcpLaunch {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), "echo 'auth required' >&2; exit 3".into()],
            cwd: std::env::temp_dir(),
            ..launch()
        })
        .await
        .unwrap_err();
    let AgentRuntimeError::Initialize {
        connection,
        message,
    } = error
    else {
        panic!("expected an initialize failure, got {error:?}");
    };
    assert!(message.contains("auth required"), "{message}");
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_hung_agent_times_out_into_degraded_and_can_be_stopped() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        request_timeout: Duration::from_millis(200),
    });
    let error = runtime
        .connect(AcpLaunch {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), "cat > /dev/null".into()],
            cwd: std::env::temp_dir(),
            ..launch()
        })
        .await
        .unwrap_err();
    let AgentRuntimeError::Initialize { connection, .. } = error else {
        panic!("expected an initialize failure, got {error:?}");
    };
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Degraded
    );
    runtime.close_connection(connection).await.unwrap();
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
}
