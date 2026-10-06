use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use super::*;
use crate::activity::{
    Change, DetailBlock, FieldInput, HistorySource, HistoryState, ItemKind, ItemStatus,
    MessageSegment, ToolKind, TurnPhase, UnavailableReason,
};
use crate::identity::IdentityNamespace;
use crate::interaction::FieldValue;
use crate::prompt::PromptPart;
use crate::status::{SessionState, SessionStatus};
use crate::writer::WriterRefusal;

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
        self.open_session_declaring(
            json!({ "loadSession": true, "sessionCapabilities": { "list": {} } }),
        )
        .await;
    }

    async fn open_session_declaring(&mut self, agent_capabilities: Value) {
        self.initialize(agent_capabilities).await;
        let new_session = self.expect("session/new").await;
        self.reply(&new_session, json!({ "sessionId": "s1" })).await;
    }

    async fn initialize(&mut self, agent_capabilities: Value) {
        let initialize = self.expect("initialize").await;
        let capabilities = &initialize["params"]["clientCapabilities"];
        assert_eq!(capabilities["elicitation"], json!({ "form": {} }));
        self.reply(
            &initialize,
            json!({
                "protocolVersion": 1,
                "agentCapabilities": agent_capabilities,
                "agentInfo": { "name": "scripted", "version": "1.0.0" }
            }),
        )
        .await;
    }

    /// Nothing reaches the agent for a while.
    async fn silent(&mut self) {
        let next = tokio::time::timeout(Duration::from_millis(100), self.lines.next_line()).await;
        assert!(next.is_err(), "unexpected message {next:?}");
    }
}

fn launch() -> AcpLaunch {
    AcpLaunch {
        agent: "scripted".into(),
        program: PathBuf::from("scripted"),
        args: Vec::new(),
        environment: None,
        env: BTreeMap::new(),
        cwd: PathBuf::from("/project"),
        acp_id_is_native: false,
        lists_catalog: false,
        read_only_open: false,
        writer_refusal: None,
        session_per_connection: false,
        draft_session: false,
    }
}

fn attached(runtime: &AgentRuntime) -> (ConnectionId, ScriptedAgent) {
    attached_with(runtime, &launch())
}

fn attached_with(runtime: &AgentRuntime, launch: &AcpLaunch) -> (ConnectionId, ScriptedAgent) {
    let (client, agent) = tokio::io::duplex(4 * 1024 * 1024);
    let (client_read, client_write) = tokio::io::split(client);
    let (agent_read, agent_write) = tokio::io::split(agent);
    let id = runtime.attach(launch, client_read, client_write, None);
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
                .new_session(id, Path::new("/project"), &[])
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
    let turn = runtime
        .prompt(&key, &[PromptPart::text("Say hello")])
        .unwrap();
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
    assert_eq!(
        items[0].kind,
        ItemKind::UserMessage {
            segments: Vec::new()
        }
    );
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
    let plan = items
        .iter()
        .find(|item| item.id == format!("plan:{turn}"))
        .unwrap();
    assert!(matches!(&plan.kind, ItemKind::Plan { entries } if entries.len() == 1));
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
    runtime.prompt(&key, &[PromptPart::text("first")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    assert_eq!(
        runtime.prompt(&key, &[PromptPart::text("second")]),
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
    runtime.prompt(&key, &[PromptPart::text("third")]).unwrap();
    let next = agent.expect("session/prompt").await;
    assert_eq!(next["params"]["prompt"][0]["text"], "third");
}

#[tokio::test]
async fn cancel_answers_the_pending_permission_and_waits_for_the_agent() {
    let runtime = AgentRuntime::default();
    let (_, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("edit")]).unwrap();
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
        ..RuntimeConfig::default()
    });
    let (_, healthy_key, mut healthy) = session(&runtime).await;
    let (failing, mut agent) = attached(&runtime);

    let (result, ()) = tokio::join!(
        runtime.new_session(failing, Path::new("/project"), &[]),
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
            .send(json!({ "jsonrpc": "2.0", "id": new_session["id"], "error": { "code": -32603, "message": "Internal error", "data": { "details": "boom" } } }))
            .await;
        }
    );
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
        runtime.new_session(failing, Path::new("/project"), &[]),
        agent.expect("session/new")
    );
    assert_eq!(result, Err(AgentRuntimeError::Timeout));
    assert_eq!(
        runtime.connection_status(failing).unwrap().state,
        ConnectionState::Degraded
    );

    runtime
        .prompt(&healthy_key, &[PromptPart::text("still fine")])
        .unwrap();
    let prompt = healthy.expect("session/prompt").await;
    healthy
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let mut subscription = runtime.subscribe(&healthy_key).unwrap();
    follow(&mut subscription, idle).await;
    assert_eq!(subscription.snapshot.connection, ConnectionState::Ready);

    let (result, ()) = tokio::join!(
        runtime.new_session(failing, Path::new("/project"), &[]),
        async {
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s2" }))
                .await;
        }
    );
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
        runtime.new_session(connection, Path::new("/project"), &[]),
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
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
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
            .any(|item| matches!(item.kind, ItemKind::Interrupted { .. }))
    );
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
    assert_eq!(
        runtime.prompt(&key, &[PromptPart::text("again")]),
        Err(AgentRuntimeError::ConnectionClosed)
    );
}

#[tokio::test]
async fn a_diff_beyond_the_item_limit_is_too_large_and_client_methods_are_refused() {
    let runtime = AgentRuntime::default();
    let (_, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("big")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    agent
        .send(json!({ "jsonrpc": "2.0", "id": 9, "method": "fs/read_text_file", "params": { "sessionId": "s1", "path": "/etc/hosts" } }))
        .await;
    let refused = agent.recv().await;
    assert_eq!(refused["id"], 9);
    assert_eq!(refused["error"]["code"], -32601);

    let huge = "x".repeat(Retention::default().item_detail + 1);
    agent
        .update("s1", json!({ "sessionUpdate": "tool_call", "toolCallId": "big", "title": "Rewrite", "content": [{ "type": "diff", "path": "big.txt", "oldText": null, "newText": huge }] }))
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

#[tokio::test]
async fn long_live_text_keeps_its_head_and_follows_its_tail() {
    let runtime = runtime_with(Retention {
        item_detail: 16,
        ..Retention::default()
    });
    let (_, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("log")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    let excerpt = |head: &str, omitted_chars: u64, tail: &str| DetailOutcome::Available {
        blocks: vec![DetailBlock::Excerpt {
            head: head.into(),
            omitted_chars,
            tail: tail.into(),
        }],
    };

    agent
        .update("s1", json!({ "sessionUpdate": "tool_call", "toolCallId": "log", "title": "Build", "status": "in_progress", "content": [{ "type": "content", "content": { "type": "text", "text": "0123456789abcdefXYZ" } }] }))
        .await;
    follow(&mut subscription, |snapshot| {
        snapshot.items.iter().any(|item| item.id == "log")
    })
    .await;
    assert_eq!(
        runtime.detail(&key, "log"),
        excerpt("01234567", 3, "bcdefXYZ")
    );

    agent
        .update("s1", json!({ "sessionUpdate": "tool_call_update", "toolCallId": "log", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "0123456789abcdefXYZ-error" } }] }))
        .await;
    for chunk in ["0123456789", "abcdefXYZ", "-error"] {
        agent.update("s1", agent_chunk(chunk)).await;
    }
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;

    assert_eq!(
        runtime.detail(&key, "log"),
        excerpt("01234567", 9, "YZ-error")
    );
    let message = subscription
        .snapshot
        .items
        .iter()
        .find(|item| item.kind == ItemKind::AgentMessage)
        .unwrap();
    assert_eq!(message.summary, "01234567");
    assert!(message.has_detail);
    assert_eq!(
        runtime.detail(&key, &message.id),
        excerpt("01234567", 9, "YZ-error")
    );
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
        ..RuntimeConfig::default()
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

fn permission(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/request_permission",
        "params": {
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "title": "Run npm test" },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
            ]
        }
    })
}

/// A Codex `request_user_input` as `codex-acp` sends it: keys out of
/// alphabetical order, a choice with an "other" note field.
fn question(id: Value) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"elicitation/create","params":{{"sessionId":"s1","toolCallId":"t2","mode":"form","message":"Codex needs your input to continue.","requestedSchema":{{"type":"object","properties":{{"target":{{"type":"string","title":"Which branch?","oneOf":[{{"const":"main","title":"main"}},{{"const":"dev","title":"dev","description":"Integration"}}]}},"target_note":{{"type":"string","title":"Additional answer or note","maxLength":20}},"force":{{"type":"boolean","title":"Force push?","default":false}}}},"required":["target","force"]}}}}}}"#
    )
}

async fn start_turn(
    runtime: &AgentRuntime,
) -> (SessionKey, ScriptedAgent, SessionSubscription, Value) {
    let (_, key, mut agent) = session(runtime).await;
    let subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    (key, agent, subscription, prompt)
}

/// Follows until a request is pending and the status shows it.
async fn until_pending(subscription: &mut SessionSubscription) -> PendingInteraction {
    follow(subscription, |snapshot| {
        snapshot.pending.is_some()
            && matches!(
                snapshot.turn.status.state,
                SessionState::RequiresAction { .. }
            )
    })
    .await;
    subscription.snapshot.pending.clone().unwrap()
}

fn option(id: &str) -> InteractionAnswer {
    InteractionAnswer::Option {
        option_id: id.into(),
    }
}

#[tokio::test]
async fn a_permission_is_answered_once_and_later_answers_are_not_pending() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, prompt) = start_turn(&runtime).await;
    agent.send(permission(json!("perm-1"))).await;
    let pending = until_pending(&mut subscription).await;
    assert_eq!(pending.kind, InteractionKind::Permission);
    assert_eq!(pending.title, "Run npm test");

    assert!(matches!(
        runtime.answer(&key, &pending.id, option("maybe")),
        Err(AgentRuntimeError::InvalidAnswer { .. })
    ));
    assert!(matches!(
        runtime.answer(&key, &pending.id, InteractionAnswer::Decline),
        Err(AgentRuntimeError::InvalidAnswer { .. })
    ));
    assert_eq!(
        runtime.answer(&key, "interaction:99", option("allow")),
        Ok(AnswerOutcome::NotPending { state: None })
    );
    assert_eq!(
        runtime.subscribe(&key).unwrap().snapshot.pending,
        Some(pending.clone()),
        "a refused answer leaves the request pending"
    );

    assert_eq!(
        runtime.answer(&key, &pending.id, option("allow")),
        Ok(AnswerOutcome::Accepted)
    );
    let answer = agent.recv().await;
    assert_eq!(answer["id"], "perm-1");
    assert_eq!(
        answer["result"],
        json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })
    );
    let deltas = follow(&mut subscription, |snapshot| {
        snapshot.pending.is_none() && snapshot.turn.status.state == SessionState::Running
    })
    .await;
    assert!(deltas.iter().any(|delta| matches!(
        &delta.change,
        Change::Pending(resolved) if resolved.state == InteractionState::Answered
    )));

    // A repeat and a surface reloaded after the answer both see the outcome.
    let reloaded = runtime.subscribe(&key).unwrap();
    assert_eq!(reloaded.snapshot.pending, None);
    for _ in 0..2 {
        assert_eq!(
            runtime.answer(&key, &pending.id, option("reject")),
            Ok(AnswerOutcome::NotPending {
                state: Some(InteractionState::Answered)
            })
        );
    }

    // Nothing more reaches the agent: its next message is the turn end.
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;
    agent.send(permission(json!("perm-2"))).await;
    follow(&mut subscription, |snapshot| snapshot.pending.is_some()).await;
    let next = subscription.snapshot.pending.clone().unwrap();
    assert_ne!(next.id, pending.id, "ids are unique within the session");
}

#[tokio::test]
async fn a_question_form_keeps_the_agent_order_and_takes_valid_values_only() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _) = start_turn(&runtime).await;
    agent
        .output
        .write_all(format!("{}\n", question(json!(21))).as_bytes())
        .await
        .unwrap();
    let pending = until_pending(&mut subscription).await;
    assert_eq!(pending.kind, InteractionKind::Question);
    assert_eq!(pending.title, "Codex needs your input to continue.");
    assert!(pending.options.is_empty());
    let ids: Vec<_> = pending
        .fields
        .iter()
        .map(|field| field.id.as_str())
        .collect();
    assert_eq!(ids, ["target", "target_note", "force"]);
    assert!(pending.fields[0].required && !pending.fields[1].required);
    assert_eq!(pending.fields[0].title, "Which branch?");
    let FieldInput::SingleChoice { options, .. } = &pending.fields[0].input else {
        panic!("expected a single choice");
    };
    assert_eq!(options[1].description.as_deref(), Some("Integration"));
    assert_eq!(
        pending.fields[2].input,
        FieldInput::Boolean {
            default: Some(false)
        }
    );
    assert_eq!(
        subscription.snapshot.turn.status.state,
        SessionState::RequiresAction {
            request: InteractionKind::Question
        }
    );

    let form = |values: Vec<(&str, FieldValue)>| InteractionAnswer::Form {
        values: values
            .into_iter()
            .map(|(id, value)| (id.to_string(), value))
            .collect(),
    };
    for invalid in [
        form(vec![("target", FieldValue::Text("main".into()))]),
        form(vec![
            ("target", FieldValue::Text("prod".into())),
            ("force", FieldValue::Boolean(true)),
        ]),
        form(vec![
            ("target", FieldValue::Text("main".into())),
            ("force", FieldValue::Text("yes".into())),
        ]),
        option("main"),
    ] {
        assert!(
            matches!(
                runtime.answer(&key, &pending.id, invalid),
                Err(AgentRuntimeError::InvalidAnswer { .. })
            ),
            "invalid answers are refused"
        );
    }
    assert_eq!(
        runtime.answer(
            &key,
            &pending.id,
            form(vec![
                ("target", FieldValue::Text("dev".into())),
                ("target_note", FieldValue::Text("after review".into())),
                ("force", FieldValue::Boolean(false)),
            ])
        ),
        Ok(AnswerOutcome::Accepted)
    );
    let answer = agent.recv().await;
    assert_eq!(answer["id"], 21);
    assert_eq!(
        answer["result"],
        json!({
            "action": "accept",
            "content": { "target": "dev", "target_note": "after review", "force": false }
        })
    );
    assert_eq!(
        runtime.answer(&key, &pending.id, InteractionAnswer::Decline),
        Ok(AnswerOutcome::NotPending {
            state: Some(InteractionState::Answered)
        })
    );
}

#[tokio::test]
async fn a_declined_question_answers_decline() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _) = start_turn(&runtime).await;
    agent
        .output
        .write_all(format!("{}\n", question(json!(3))).as_bytes())
        .await
        .unwrap();
    let pending = until_pending(&mut subscription).await;
    assert_eq!(
        runtime.answer(&key, &pending.id, InteractionAnswer::Decline),
        Ok(AnswerOutcome::Accepted)
    );
    assert_eq!(agent.recv().await["result"], json!({ "action": "decline" }));
}

#[tokio::test]
async fn cancel_answers_a_pending_question_cancel_and_later_answers_are_not_pending() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, prompt) = start_turn(&runtime).await;
    agent
        .output
        .write_all(format!("{}\n", question(json!("q-1"))).as_bytes())
        .await
        .unwrap();
    let pending = until_pending(&mut subscription).await;

    runtime.cancel(&key).unwrap();
    let answer = agent.recv().await;
    assert_eq!(answer["id"], "q-1");
    assert_eq!(answer["result"], json!({ "action": "cancel" }));
    agent.expect("session/cancel").await;
    assert_eq!(
        runtime.answer(&key, &pending.id, InteractionAnswer::Decline),
        Ok(AnswerOutcome::NotPending {
            state: Some(InteractionState::Cancelled)
        })
    );
    agent
        .reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    follow(&mut subscription, idle).await;
    assert_eq!(
        runtime.answer(&key, &pending.id, InteractionAnswer::Decline),
        Ok(AnswerOutcome::NotPending {
            state: Some(InteractionState::Cancelled)
        })
    );
}

#[tokio::test]
async fn a_lost_connection_expires_the_pending_request_for_later_answers() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _) = start_turn(&runtime).await;
    agent.send(permission(json!(5))).await;
    let pending = until_pending(&mut subscription).await;
    drop(agent);
    follow(&mut subscription, idle).await;
    assert_eq!(
        runtime.answer(&key, &pending.id, option("allow")),
        Ok(AnswerOutcome::NotPending {
            state: Some(InteractionState::Expired)
        })
    );
}

#[tokio::test]
async fn questions_the_model_does_not_express_are_cancelled_with_a_diagnostic() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _) = start_turn(&runtime).await;
    let requests = [
        json!({ "sessionId": "s1", "mode": "url", "message": "Sign in", "url": "https://example.com", "elicitationId": "e1" }),
        json!({ "sessionId": "s1", "mode": "form", "message": "Pick", "requestedSchema": { "type": "object", "properties": { "x": { "type": "_custom" } } } }),
        json!({ "sessionId": "s1", "mode": "form", "message": "Pick", "requestedSchema": { "type": "object", "properties": { "x": { "type": "array", "items": { "type": "_custom" } } } } }),
        json!({ "requestId": 1, "mode": "form", "message": "Pick", "requestedSchema": { "type": "object", "properties": {} } }),
        json!({ "sessionId": "other", "mode": "form", "message": "Pick", "requestedSchema": { "type": "object", "properties": {} } }),
    ];
    for (index, params) in requests.into_iter().enumerate() {
        agent
            .send(json!({ "jsonrpc": "2.0", "id": index, "method": "elicitation/create", "params": params }))
            .await;
        let answer = agent.recv().await;
        assert_eq!(answer["id"], index);
        assert_eq!(answer["result"], json!({ "action": "cancel" }));
    }
    let diagnostics = follow(&mut subscription, |snapshot| {
        snapshot
            .items
            .iter()
            .filter(|item| matches!(item.kind, ItemKind::Generic { .. }))
            .count()
            == 3
    })
    .await;
    assert!(diagnostics.iter().any(|delta| matches!(
        &delta.change,
        Change::Item(item) if item.kind == ItemKind::Generic { label: "url question".into() }
    )));
    assert!(runtime.subscribe(&key).unwrap().snapshot.pending.is_none());
}

#[tokio::test]
async fn a_second_concurrent_request_is_cancelled_by_its_own_kind() {
    let runtime = AgentRuntime::default();
    let (_, mut agent, mut subscription, _) = start_turn(&runtime).await;
    agent.send(permission(json!(1))).await;
    until_pending(&mut subscription).await;
    agent
        .output
        .write_all(format!("{}\n", question(json!(2))).as_bytes())
        .await
        .unwrap();
    let answer = agent.recv().await;
    assert_eq!(answer["id"], 2);
    assert_eq!(answer["result"], json!({ "action": "cancel" }));
    assert_eq!(
        subscription.snapshot.pending.as_ref().unwrap().kind,
        InteractionKind::Permission
    );
}

#[tokio::test]
async fn a_new_session_holds_the_acp_writer_until_its_connection_closes() {
    let runtime = AgentRuntime::default();
    let writers = runtime.writers();
    let (_connection, key, agent) = session(&runtime).await;
    assert_eq!(writers.writer(&key), Some(Writer::Acp));
    assert_eq!(
        writers
            .claim(
                &key,
                Writer::Pty,
                ExternalLiveness::Unknown,
                UnknownLiveness::NotConfirmed
            )
            .err(),
        Some(WriterRefusal::WriterActive {
            writer: Writer::Acp
        })
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    assert_eq!(subscription.snapshot.writer, WriterState::Acp);

    drop(agent);
    follow(&mut subscription, |snapshot| {
        snapshot.writer == WriterState::None
    })
    .await;
    assert_eq!(writers.writer(&key), None);
}

#[tokio::test]
async fn acp_does_not_take_a_session_a_managed_pty_writes() {
    let runtime = AgentRuntime::default();
    let native = SessionKey::from_acp("scripted", "s1", true);
    let _pty = runtime
        .writers()
        .claim(
            &native,
            Writer::Pty,
            ExternalLiveness::Unknown,
            UnknownLiveness::NotConfirmed,
        )
        .unwrap();
    let (id, mut agent) = attached_with(
        &runtime,
        &AcpLaunch {
            acp_id_is_native: true,
            ..launch()
        },
    );
    let (created, ()) = tokio::join!(
        runtime.new_session(id, Path::new("/project"), &[]),
        agent.open_session()
    );
    assert_eq!(
        created,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::WriterActive {
                writer: Writer::Pty
            }
        })
    );
    assert!(runtime.subscribe(&native).is_err());
    assert_eq!(runtime.writers().writer(&native), Some(Writer::Pty));
}

#[tokio::test]
async fn releasing_a_session_between_turns_closes_it_and_frees_its_writer() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        agent.open_session_declaring(
            json!({ "loadSession": true, "sessionCapabilities": { "close": {} } })
        )
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    assert_eq!(
        runtime.release_session(&key).await,
        Err(AgentRuntimeError::TurnActive)
    );
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;

    let (released, ()) = tokio::join!(runtime.release_session(&key), async {
        let close = agent.expect("session/close").await;
        assert_eq!(close["params"]["sessionId"], "s1");
        agent.reply(&close, json!({})).await;
    });
    released.unwrap();
    follow(&mut subscription, |snapshot| {
        snapshot.writer == WriterState::None
    })
    .await;
    assert_eq!(
        subscription.snapshot.turn.last_outcome,
        Some(StopReason::EndTurn)
    );
    assert!(runtime.sessions().is_empty());
    assert!(
        runtime
            .writers()
            .claim(
                &key,
                Writer::Pty,
                ExternalLiveness::Unknown,
                UnknownLiveness::NotConfirmed
            )
            .is_ok()
    );

    // Nothing is left to release.
    runtime.release_session(&key).await.unwrap();
    agent.silent().await;
}

#[tokio::test]
async fn a_refused_opening_leaves_the_connection_to_the_next_session() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(
        &runtime,
        &AcpLaunch {
            session_per_connection: true,
            draft_session: false,
            ..launch()
        },
    );
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Unknown,
            UnknownLiveness::NotConfirmed,
        ),
        agent.initialize(json!({ "loadSession": true }))
    );
    assert_eq!(
        opened,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::ConfirmationRequired
        })
    );
    let (created, ()) = tokio::join!(runtime.new_session(id, Path::new("/project"), &[]), async {
        let new_session = agent.expect("session/new").await;
        agent
            .reply(&new_session, json!({ "sessionId": "s1" }))
            .await;
    });
    created.unwrap();
}

#[tokio::test]
async fn leaving_the_surface_does_not_stop_the_turn() {
    let runtime = AgentRuntime::default();
    let (_connection, key, mut agent) = session(&runtime).await;
    let subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    drop(subscription);

    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let mut again = runtime.subscribe(&key).unwrap();
    follow(&mut again, idle).await;
    assert_eq!(again.snapshot.turn.last_outcome, Some(StopReason::EndTurn));
    assert_eq!(again.snapshot.writer, WriterState::Acp);
}

#[tokio::test]
async fn shutdown_cancels_live_turns_then_closes_sessions_then_ends_the_agent() {
    let runtime = AgentRuntime::default();
    let (connection, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(connection, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        agent.open_session_declaring(json!({ "sessionCapabilities": { "close": {} } }))
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
    let prompt = agent.expect("session/prompt").await;

    let agent_side = async {
        agent.expect("session/cancel").await;
        agent
            .reply(&prompt, json!({ "stopReason": "cancelled" }))
            .await;
        let close = agent.expect("session/close").await;
        assert_eq!(close["params"]["sessionId"], "s1");
        agent.reply(&close, json!({})).await;
        agent
    };
    let ((), _agent) = tokio::join!(runtime.shutdown(), agent_side);

    follow(&mut subscription, |snapshot| {
        snapshot.connection == ConnectionState::Closed
    })
    .await;
    assert_eq!(
        subscription.snapshot.turn.last_outcome,
        Some(StopReason::Cancelled)
    );
    assert_eq!(subscription.snapshot.writer, WriterState::None);
    assert_eq!(runtime.writers().writer(&key), None);
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
}

#[tokio::test]
async fn shutdown_stops_waiting_for_an_agent_that_ignores_cancel_at_its_budget() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        shutdown_budget: Duration::from_millis(200),
        ..RuntimeConfig::default()
    });
    let (_connection, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("work")]).unwrap();
    agent.expect("session/prompt").await;

    let started = std::time::Instant::now();
    runtime.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(2));
    agent.expect("session/cancel").await;
    follow(&mut subscription, |snapshot| {
        idle(snapshot) && snapshot.writer == WriterState::None
    })
    .await;
    assert_eq!(
        subscription.snapshot.turn.last_outcome,
        Some(StopReason::Interrupted)
    );
    assert_eq!(subscription.snapshot.writer, WriterState::None);
}

fn user_chunk(text: &str) -> Value {
    json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": text } })
}

fn agent_chunk(text: &str) -> Value {
    json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } })
}

fn tool_call(id: &str, output: &str) -> Value {
    json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": "Read file",
        "kind": "read",
        "status": "completed",
        "content": [{ "type": "content", "content": { "type": "text", "text": output } }]
    })
}

fn runtime_with(retention: Retention) -> AgentRuntime {
    AgentRuntime::new(RuntimeConfig {
        retention,
        ..RuntimeConfig::default()
    })
}

fn agent_launch(agent: &str) -> AcpLaunch {
    AcpLaunch {
        agent: agent.into(),
        ..launch()
    }
}

/// Opens `key` on a new connection of `launch`; the agent answers
/// `session/load` after replaying `replay`.
async fn reopened(
    runtime: &AgentRuntime,
    launch: &AcpLaunch,
    key: &SessionKey,
    replay: Vec<Value>,
) -> ScriptedAgent {
    let (id, mut agent) = attached_with(runtime, launch);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            key,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        async {
            agent
                .initialize(json!({ "loadSession": true, "sessionCapabilities": { "close": {} } }))
                .await;
            let load = agent.expect("session/load").await;
            assert_eq!(load["params"]["sessionId"], key.session_id.as_str());
            assert_eq!(load["params"]["cwd"], "/project");
            for update in replay {
                agent.update(&key.session_id, update).await;
            }
            agent.reply(&load, json!({})).await;
        }
    );
    opened.unwrap();
    agent
}

fn turn_of(snapshot: &SessionSnapshot, id: &str) -> Option<String> {
    snapshot
        .items
        .iter()
        .find(|item| item.id == id)
        .and_then(|item| item.turn_id.clone())
}

async fn released(runtime: &AgentRuntime, key: &SessionKey) {
    for _ in 0..500 {
        if runtime.subscribe(key).is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the session is released");
}

#[tokio::test]
async fn a_session_reopened_after_reconnect_is_restored_from_its_replay_without_a_prompt() {
    let runtime = AgentRuntime::default();
    let (_first, key, agent) = session(&runtime).await;
    let mut before = runtime.subscribe(&key).unwrap();
    drop(agent);
    follow(&mut before, |snapshot| {
        snapshot.connection == ConnectionState::Closed
    })
    .await;
    drop(before);

    let mut agent = reopened(
        &runtime,
        &launch(),
        &key,
        vec![
            user_chunk("Read the plan"),
            agent_chunk("Reading"),
            tool_call("t1", "plan body"),
            agent_chunk("Done"),
            user_chunk("Thanks"),
            agent_chunk("You are welcome"),
        ],
    )
    .await;
    agent.silent().await;

    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.connection, ConnectionState::Ready);
    assert_eq!(snapshot.writer, WriterState::Acp);
    assert_eq!(runtime.writers().writer(&key), Some(Writer::Acp));
    assert_eq!(
        snapshot.history,
        HistoryState {
            source: HistorySource::Replay,
            available: true,
            truncated_items: None
        }
    );
    assert_eq!(snapshot.turn.phase, TurnPhase::None);
    let kinds: Vec<_> = snapshot
        .items
        .iter()
        .map(|item| {
            (
                item.kind.clone(),
                item.turn_id.clone().unwrap(),
                item.summary.clone(),
            )
        })
        .collect();
    let replay = |turn: &str| turn.to_string();
    assert_eq!(
        kinds,
        vec![
            (
                ItemKind::UserMessage {
                    segments: Vec::new()
                },
                replay("replay:1"),
                "Read the plan".into()
            ),
            (ItemKind::AgentMessage, replay("replay:1"), "Reading".into()),
            (
                ItemKind::ToolCall {
                    tool: crate::activity::ToolKind::Read
                },
                replay("replay:1"),
                "Read file".into()
            ),
            (ItemKind::AgentMessage, replay("replay:1"), "Done".into()),
            (
                ItemKind::UserMessage {
                    segments: Vec::new()
                },
                replay("replay:2"),
                "Thanks".into()
            ),
            (
                ItemKind::AgentMessage,
                replay("replay:2"),
                "You are welcome".into()
            ),
        ]
    );
    assert_eq!(
        runtime.detail(&key, "t1"),
        DetailOutcome::Available {
            blocks: vec![DetailBlock::Text {
                text: "plan body".into()
            }]
        }
    );

    // The reopened session continues the same native session.
    let turn = runtime.prompt(&key, &[PromptPart::text("Next")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    assert_eq!(prompt["params"]["sessionId"], "s1");
    agent.update("s1", agent_chunk("Live")).await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    follow(&mut subscription, |snapshot| {
        snapshot.turn.turn_id.as_deref() == Some(turn.as_str())
            && snapshot.turn.phase == TurnPhase::None
    })
    .await;
    let live = subscription.snapshot.items.last().unwrap();
    assert_eq!(live.turn_id.as_deref(), Some(turn.as_str()));
}

#[tokio::test]
async fn a_resume_only_agent_continues_the_session_without_history() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (id, mut agent) = attached(&runtime);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "resume": {} } }))
                .await;
            let resume = agent.expect("session/resume").await;
            assert_eq!(resume["params"]["sessionId"], "s7");
            agent.reply(&resume, json!({})).await;
        }
    );
    opened.unwrap();
    agent.silent().await;
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(
        snapshot.history,
        HistoryState {
            source: HistorySource::None,
            available: false,
            truncated_items: None
        }
    );
    assert!(snapshot.items.is_empty());
    assert_eq!(runtime.writers().writer(&key), Some(Writer::Acp));
}

#[tokio::test]
async fn opening_is_refused_without_load_or_resume_and_without_a_free_writer() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (id, mut agent) = attached(&runtime);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        agent.initialize(json!({}))
    );
    assert_eq!(opened, Err(AgentRuntimeError::OpenUnsupported));

    let (id, mut agent) = attached(&runtime);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Unknown,
            UnknownLiveness::NotConfirmed,
        ),
        agent.initialize(json!({ "loadSession": true }))
    );
    assert_eq!(
        opened,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::ConfirmationRequired
        })
    );
    agent.silent().await;
    assert!(runtime.subscribe(&key).is_err());
    assert_eq!(runtime.writers().writer(&key), None);

    let other = SessionKey::from_acp("another", "s7", false);
    assert_eq!(
        runtime
            .open_session(
                id,
                &other,
                Path::new("/project"),
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .await,
        Err(AgentRuntimeError::SessionNotFound)
    );
}

#[tokio::test]
async fn a_failed_load_leaves_no_session_and_frees_the_writer() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "gone", false);
    let (id, mut agent) = attached(&runtime);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        async {
            agent.initialize(json!({ "loadSession": true })).await;
            let load = agent.expect("session/load").await;
            agent.update("gone", user_chunk("partial")).await;
            agent
                .send(json!({
                    "jsonrpc": "2.0",
                    "id": load["id"],
                    "error": { "code": -32002, "message": "Resource not found" }
                }))
                .await;
        }
    );
    assert!(matches!(opened, Err(AgentRuntimeError::Agent { .. })));
    assert!(runtime.subscribe(&key).is_err());
    assert_eq!(runtime.writers().writer(&key), None);
    assert_eq!(runtime.inner.detail_bytes.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn a_large_replay_keeps_the_newest_whole_turns_and_marks_the_truncation() {
    let runtime = runtime_with(Retention {
        session_items: 10,
        item_detail: 1024,
        ..Retention::default()
    });
    let mut replay = Vec::new();
    for turn in 1..=500 {
        replay.push(user_chunk(&format!("question {turn}")));
        replay.push(agent_chunk(&format!("answer {turn}")));
        replay.push(tool_call(&format!("t{turn}"), &"o".repeat(100)));
    }
    replay.push(tool_call("huge", &"x".repeat(2048)));
    let key = SessionKey::from_acp("scripted", "big", false);
    let _agent = reopened(&runtime, &launch(), &key, replay).await;

    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert!(snapshot.items.len() <= 10, "{} items", snapshot.items.len());
    let kept = snapshot.items.len() as u64;
    assert_eq!(snapshot.history.truncated_items, Some(1501 - kept));
    assert_eq!(snapshot.history.source, HistorySource::Replay);
    // Only whole turns are evicted: every kept turn has all its items.
    let turns: std::collections::BTreeSet<_> = snapshot
        .items
        .iter()
        .map(|item| item.turn_id.clone().unwrap())
        .collect();
    for turn in &turns {
        let count = snapshot
            .items
            .iter()
            .filter(|item| item.turn_id.as_ref() == Some(turn))
            .count();
        let expected = if turn == "replay:500" { 4 } else { 3 };
        assert_eq!(count, expected, "turn {turn}");
    }
    assert_eq!(turn_of(&snapshot, "huge").as_deref(), Some("replay:500"));
    assert_eq!(
        runtime.detail(&key, "huge"),
        DetailOutcome::Available {
            blocks: vec![DetailBlock::Excerpt {
                head: "x".repeat(512),
                omitted_chars: 1024,
                tail: "x".repeat(512),
            }]
        }
    );
    assert!(matches!(
        runtime.detail(&key, "t1"),
        DetailOutcome::Error { .. }
    ));
    // Evicted items no longer hold detail.
    let held = runtime.inner.detail_bytes.load(Ordering::Relaxed);
    assert!(held <= 1024 + 10 * 100, "{held} detail bytes held");
}

#[tokio::test]
async fn other_sessions_answer_while_a_replay_streams() {
    let runtime = AgentRuntime::default();
    let (_connection, other, _other_agent) = session(&runtime).await;
    let key = SessionKey::from_acp("big", "b1", false);
    let (id, mut agent) = attached_with(&runtime, &agent_launch("big"));
    let open = tokio::spawn({
        let runtime = runtime.clone();
        let key = key.clone();
        async move {
            runtime
                .open_session(
                    id,
                    &key,
                    Path::new("/project"),
                    ExternalLiveness::Free,
                    UnknownLiveness::NotConfirmed,
                )
                .await
        }
    });
    agent.initialize(json!({ "loadSession": true })).await;
    let load = agent.expect("session/load").await;
    for turn in 0..2_000 {
        agent.update("b1", user_chunk(&format!("q{turn}"))).await;
        agent.update("b1", agent_chunk(&"a".repeat(512))).await;
    }
    // Mid-replay: the other session and the connection answer at once,
    // and the replaying session is not served before it is complete.
    let started = std::time::Instant::now();
    assert!(runtime.subscribe(&other).is_ok());
    assert!(runtime.connection_status(id).is_some());
    assert!(runtime.subscribe(&key).is_err());
    assert!(started.elapsed() < Duration::from_millis(50));

    agent.reply(&load, json!({})).await;
    open.await.unwrap().unwrap();
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.items.len(), 2_000);
    assert_eq!(snapshot.history.truncated_items, Some(2_000));
}

#[tokio::test]
async fn live_turns_past_the_bound_evict_the_oldest_turn_for_subscribers_too() {
    let runtime = runtime_with(Retention {
        session_items: 4,
        ..Retention::default()
    });
    let (_connection, key, mut agent) = session(&runtime).await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    let mut turns = Vec::new();
    for text in ["first", "second"] {
        let turn = runtime.prompt(&key, &[PromptPart::text(text)]).unwrap();
        let prompt = agent.expect("session/prompt").await;
        agent.update("s1", agent_chunk("ok")).await;
        agent
            .reply(&prompt, json!({ "stopReason": "end_turn" }))
            .await;
        follow(&mut subscription, |snapshot| {
            snapshot.turn.turn_id.as_deref() == Some(turn.as_str())
                && snapshot.turn.phase == TurnPhase::None
        })
        .await;
        turns.push(turn);
    }
    let fresh = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(
        subscription.snapshot, fresh,
        "snapshot + deltas = runtime state"
    );
    assert_eq!(fresh.history.truncated_items, Some(3));
    assert!(
        fresh
            .items
            .iter()
            .all(|item| item.turn_id.as_ref() == Some(&turns[1]))
    );
}

#[tokio::test]
async fn the_process_detail_bound_releases_the_least_recently_opened_session_first() {
    let runtime = runtime_with(Retention {
        process_detail: 2_500,
        ..Retention::default()
    });
    let older = SessionKey::from_acp("a", "s1", false);
    let _a = reopened(
        &runtime,
        &agent_launch("a"),
        &older,
        vec![
            user_chunk("q1"),
            tool_call("t1", &"1".repeat(1000)),
            user_chunk("q2"),
            tool_call("t2", &"2".repeat(1000)),
        ],
    )
    .await;
    let newer = SessionKey::from_acp("b", "s1", false);
    let _b = reopened(
        &runtime,
        &agent_launch("b"),
        &newer,
        vec![user_chunk("q"), tool_call("t1", &"3".repeat(1000))],
    )
    .await;

    assert_eq!(
        runtime.detail(&older, "t1"),
        DetailOutcome::Unavailable {
            reason: UnavailableReason::Released
        }
    );
    assert!(matches!(
        runtime.detail(&older, "t2"),
        DetailOutcome::Available { .. }
    ));
    assert!(matches!(
        runtime.detail(&newer, "t1"),
        DetailOutcome::Available { .. }
    ));
    let older_items = runtime.subscribe(&older).unwrap().snapshot.items;
    let t1 = older_items.iter().find(|item| item.id == "t1").unwrap();
    assert_eq!(t1.summary, "Read file", "the summary stays");
    assert!(runtime.inner.detail_bytes.load(Ordering::Relaxed) <= 2_500);
}

#[tokio::test]
async fn an_idle_session_is_released_and_opens_again_with_a_new_replay() {
    let runtime = runtime_with(Retention {
        idle_release: Duration::from_millis(40),
        ..Retention::default()
    });
    let key = SessionKey::from_acp("scripted", "s1", false);
    let agent = reopened(&runtime, &launch(), &key, vec![user_chunk("hello")]).await;
    // The managed writer holds the session however long it is idle.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let subscription = runtime.subscribe(&key).unwrap();

    drop(agent);
    let mut subscription = subscription;
    follow(&mut subscription, |snapshot| {
        snapshot.writer == WriterState::None
    })
    .await;
    // A subscriber holds it too.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(runtime.subscribe(&key).is_ok());
    drop(subscription);
    released(&runtime, &key).await;
    assert_eq!(runtime.inner.detail_bytes.load(Ordering::Relaxed), 0);

    let _again = reopened(&runtime, &launch(), &key, vec![user_chunk("hello")]).await;
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.history.source, HistorySource::Replay);
}

fn listing(agent: &str) -> AcpLaunch {
    AcpLaunch {
        agent: agent.into(),
        lists_catalog: true,
        ..launch()
    }
}

fn listed_entry(id: &str, cwd: &str) -> Value {
    json!({ "sessionId": id, "cwd": cwd, "updatedAt": "2026-09-30T10:00:00Z" })
}

fn list_runtime(list: ListBounds) -> AgentRuntime {
    AgentRuntime::new(RuntimeConfig {
        list,
        ..RuntimeConfig::default()
    })
}

#[tokio::test]
async fn a_folder_list_sends_its_cwd_on_every_page() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &listing("qwen-code"));
    let (list, ()) = tokio::join!(
        runtime.list_folder_sessions(id, Path::new("/work/app")),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "list": {} } }))
                .await;
            let first = agent.expect("session/list").await;
            assert_eq!(first["params"], json!({ "cwd": "/work/app" }));
            agent
                .reply(
                    &first,
                    json!({ "sessions": [listed_entry("s1", "/work/app")], "nextCursor": "p2" }),
                )
                .await;
            let second = agent.expect("session/list").await;
            assert_eq!(
                second["params"],
                json!({ "cursor": "p2", "cwd": "/work/app" })
            );
            agent
                .reply(
                    &second,
                    json!({ "sessions": [listed_entry("s2", "/work/app")] }),
                )
                .await;
        }
    );
    assert_eq!(list.unwrap().sessions.len(), 2);
}

#[tokio::test]
async fn the_session_list_reads_every_page_into_bounded_entries_without_status() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &listing("hermes"));
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent
            .initialize(json!({ "sessionCapabilities": { "list": {} } }))
            .await;
        let first = agent.expect("session/list").await;
        assert_eq!(first["params"], json!({}), "no cwd filter, no cursor");
        agent
            .reply(
                &first,
                json!({
                    "sessions": [
                        { "sessionId": "s1", "cwd": "/work/app", "title": "Fix build", "_meta": { "messageCount": 12 } },
                        listed_entry("s2", "/work/app/docs"),
                    ],
                    "nextCursor": "page-2"
                }),
            )
            .await;
        let second = agent.expect("session/list").await;
        assert_eq!(second["params"], json!({ "cursor": "page-2" }));
        agent
            .reply(
                &second,
                json!({
                    "sessions": [
                        listed_entry("s3", "/elsewhere"),
                        listed_entry("s1", "/work/app"),
                        listed_entry("s4", "relative"),
                        { "cwd": "/no-id" },
                    ]
                }),
            )
            .await;
    });
    let list = list.unwrap();
    let ids: Vec<_> = list
        .sessions
        .iter()
        .map(|session| session.key.session_id.as_str())
        .collect();
    assert_eq!(ids, ["s1", "s2", "s3"]);
    assert!(!list.truncated);
    // A repeated id, a relative cwd and an entry without an id.
    assert_eq!(list.skipped, 3);
    let first = &list.sessions[0];
    assert_eq!(first.key.agent, "hermes");
    assert_eq!(first.key.namespace, IdentityNamespace::Acp);
    assert_eq!(first.title.as_deref(), Some("Fix build"));
    assert_eq!(first.updated_at, None);
    assert_eq!(
        list.sessions[1].updated_at.as_deref(),
        Some("2026-09-30T10:00:00Z")
    );
    assert_eq!(
        runtime.connection_status(id).unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn acp_ids_join_the_native_namespace_only_for_a_launch_with_evidence() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(
        &runtime,
        &AcpLaunch {
            acp_id_is_native: true,
            ..listing("codex")
        },
    );
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent
            .initialize(json!({ "sessionCapabilities": { "list": {} } }))
            .await;
        let request = agent.expect("session/list").await;
        agent
            .reply(
                &request,
                json!({ "sessions": [listed_entry("t1", "/work")] }),
            )
            .await;
    });
    let key = &list.unwrap().sessions[0].key;
    assert_eq!(key.namespace, IdentityNamespace::Native);
    assert_eq!(key.agent, "codex");
}

#[tokio::test]
async fn the_list_stops_at_its_bounds_and_marks_the_truncation() {
    let runtime = list_runtime(ListBounds {
        sessions: 2,
        ..ListBounds::default()
    });
    let (id, mut agent) = attached_with(&runtime, &listing("a"));
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent
            .initialize(json!({ "sessionCapabilities": { "list": {} } }))
            .await;
        let request = agent.expect("session/list").await;
        agent
            .reply(
                &request,
                json!({
                    "sessions": [listed_entry("s1", "/w"), listed_entry("s2", "/w"), listed_entry("s3", "/w")],
                    "nextCursor": "more"
                }),
            )
            .await;
        agent.silent().await;
    });
    let list = list.unwrap();
    assert_eq!(list.sessions.len(), 2);
    assert!(list.truncated);

    // A cursor the agent repeats would page forever.
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &listing("a"));
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent
            .initialize(json!({ "sessionCapabilities": { "list": {} } }))
            .await;
        for _ in 0..2 {
            let request = agent.expect("session/list").await;
            agent
                .reply(&request, json!({ "sessions": [], "nextCursor": "same" }))
                .await;
        }
        agent.silent().await;
    });
    assert!(list.unwrap().truncated);
}

#[tokio::test]
async fn an_agent_without_session_list_is_not_asked() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &listing("a"));
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent.initialize(json!({ "loadSession": true })).await;
        agent.silent().await;
    });
    assert_eq!(list.unwrap_err(), AgentRuntimeError::ListUnsupported);
}

#[tokio::test]
async fn a_slow_list_times_out_within_its_bound_and_degrades_only_its_connection() {
    let runtime = list_runtime(ListBounds {
        timeout: Duration::from_millis(150),
        ..ListBounds::default()
    });
    let (slow, mut slow_agent) = attached_with(&runtime, &listing("slow"));
    let (other, mut other_agent) = attached_with(&runtime, &listing("other"));
    let started = Instant::now();
    let (slow_list, other_list, (), ()) = tokio::join!(
        runtime.list_sessions(slow),
        runtime.list_sessions(other),
        async {
            slow_agent
                .initialize(json!({ "sessionCapabilities": { "list": {} } }))
                .await;
            slow_agent.expect("session/list").await;
        },
        async {
            other_agent
                .initialize(json!({ "sessionCapabilities": { "list": {} } }))
                .await;
            let request = other_agent.expect("session/list").await;
            other_agent
                .reply(&request, json!({ "sessions": [listed_entry("o1", "/w")] }))
                .await;
        }
    );
    assert_eq!(slow_list.unwrap_err(), AgentRuntimeError::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        runtime.connection_status(slow).unwrap().state,
        ConnectionState::Degraded
    );
    assert_eq!(other_list.unwrap().sessions.len(), 1);
    assert_eq!(
        runtime.connection_status(other).unwrap().state,
        ConnectionState::Ready
    );
}

#[tokio::test]
async fn catalog_connections_offer_one_open_listing_connection_per_agent() {
    let runtime = AgentRuntime::default();
    let (first, _first_agent) = attached_with(&runtime, &listing("hermes"));
    let (_second, _second_agent) = attached_with(&runtime, &listing("hermes"));
    let (_scanner, _scanner_agent) = attached_with(&runtime, &launch());
    let (closed, closed_agent) = attached_with(&runtime, &listing("gone"));
    drop(closed_agent);
    runtime.close_connection(closed).await.unwrap();

    assert_eq!(
        runtime.catalog_connections(),
        vec![CatalogConnection {
            connection: first,
            agent: "hermes".into()
        }]
    );
}

#[tokio::test]
async fn a_connection_of_an_agent_with_one_session_per_connection_serves_one_session() {
    let runtime = AgentRuntime::default();
    let launch = AcpLaunch {
        session_per_connection: true,
        draft_session: false,
        ..listing("pi")
    };
    let (id, mut agent) = attached_with(&runtime, &launch);
    assert_eq!(runtime.catalog_connections().len(), 1);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        agent.open_session()
    );
    // Its list now has only the session's directory.
    assert!(runtime.catalog_connections().is_empty());
    assert_eq!(
        runtime
            .new_session(id, Path::new("/project"), &[])
            .await
            .unwrap_err(),
        AgentRuntimeError::ConnectionTaken
    );
    let other = SessionKey::from_acp("pi", "s2", false);
    assert_eq!(
        runtime
            .open_session(
                id,
                &other,
                Path::new("/project"),
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .await
            .unwrap_err(),
        AgentRuntimeError::ConnectionTaken
    );
    agent.silent().await;
    assert!(runtime.subscribe(&key).is_ok());
}

#[tokio::test]
async fn an_agent_that_declares_no_list_is_no_catalogue_and_its_declaration_is_kept() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &listing("custom-agent"));
    assert_eq!(runtime.declared("custom-agent"), None);
    assert_eq!(
        runtime.catalog_connections().len(),
        1,
        "not initialized yet"
    );
    let (list, ()) = tokio::join!(runtime.list_sessions(id), async {
        agent.initialize(json!({ "loadSession": true })).await;
    });
    assert_eq!(list.unwrap_err(), AgentRuntimeError::ListUnsupported);
    assert!(runtime.catalog_connections().is_empty());

    let declared = runtime.declared("custom-agent").unwrap();
    assert_eq!(declared.name.as_deref(), Some("scripted"));
    assert!(declared.capabilities.load_session);
    assert!(!declared.capabilities.list_sessions);
    // The declaration outlives the connection until the agent changes.
    drop(agent);
    runtime.close_connection(id).await.unwrap();
    assert!(runtime.declared("custom-agent").is_some());
    runtime.forget_declared("custom-agent");
    assert_eq!(runtime.declared("custom-agent"), None);
}

#[tokio::test]
async fn a_new_session_and_a_finished_turn_announce_a_catalog_change() {
    let runtime = AgentRuntime::default();
    let mut changes = runtime.catalog_changes();
    let (_id, key, mut agent) = session(&runtime).await;
    assert_eq!(changes.recv().await.unwrap().agent, "scripted");

    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, &[PromptPart::text("hi")]).unwrap();
    let request = agent.expect("session/prompt").await;
    agent
        .reply(&request, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;
    let change = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.agent, "scripted");
}

/// Config option `mode` and the same values as legacy modes, as Codex and
/// Claude Code declare them.
fn mode_settings(current: &str) -> Value {
    json!({
        "sessionId": "s1",
        "configOptions": [
            {
                "id": "mode", "name": "Approval Preset", "category": "mode", "type": "select",
                "currentValue": current,
                "options": [
                    { "value": "read-only", "name": "Read Only" },
                    { "value": "workspace-write", "name": "Default", "description": "User review" },
                    { "value": "agent", "name": "Auto review" }
                ]
            },
            {
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": "gpt",
                "options": [{ "group": "OpenAI", "options": [{ "value": "gpt", "name": "GPT" }] }]
            },
            { "id": "fast-mode", "name": "Fast", "type": "boolean", "currentValue": false }
        ],
        "modes": {
            "currentModeId": current,
            "availableModes": [{ "id": "agent", "name": "Auto review" }]
        }
    })
}

fn approval(value: &str) -> SettingValue {
    SettingValue {
        setting: "mode".into(),
        value: value.into(),
    }
}

#[tokio::test]
async fn a_new_session_applies_the_mode_before_it_is_handed_out() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[approval("workspace-write")])
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let set = agent.expect("session/set_config_option").await;
            assert_eq!(
                set["params"],
                json!({ "sessionId": "s1", "configId": "mode", "value": "workspace-write" })
            );
            let mut confirmed = mode_settings("workspace-write");
            confirmed.as_object_mut().unwrap().remove("sessionId");
            confirmed.as_object_mut().unwrap().remove("modes");
            agent.reply(&set, confirmed).await;
        }
    );
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    let ids: Vec<_> = snapshot.settings.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["mode", "model"], "boolean options are not modelled");
    let mode = &snapshot.settings[0];
    assert_eq!(mode.category, crate::activity::SettingCategory::Mode);
    assert_eq!(mode.current_value, "workspace-write");
    assert_eq!(mode.options[1].description.as_deref(), Some("User review"));
    assert_eq!(snapshot.settings[1].options[0].value, "gpt");
    agent.silent().await;
}

#[tokio::test]
async fn an_undeclared_mode_closes_the_new_session_without_a_prompt() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let settings = [approval("agent-full-access")];
    let (created, ()) = tokio::join!(
        runtime.new_session(id, Path::new("/project"), &settings),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let close = agent.expect("session/close").await;
            assert_eq!(close["params"], json!({ "sessionId": "s1" }));
            agent.reply(&close, json!({})).await;
        }
    );
    assert_eq!(
        created,
        Err(AgentRuntimeError::SettingRefused {
            setting: "mode".into(),
            value: "agent-full-access".into(),
            reason: SettingRefusal::NotDeclared,
        })
    );
    let key = SessionKey::from_acp("scripted", "s1", false);
    assert!(runtime.subscribe(&key).is_err());
    assert_eq!(runtime.writers().writer(&key), None);
    agent.silent().await;
}

#[tokio::test]
async fn a_mode_the_agent_refuses_closes_the_new_session() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let settings = [approval("workspace-write")];
    let (created, ()) = tokio::join!(
        runtime.new_session(id, Path::new("/project"), &settings),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let set = agent.expect("session/set_config_option").await;
            agent
                .send(json!({
                    "jsonrpc": "2.0", "id": set["id"],
                    "error": { "code": -32602, "message": "not allowed" }
                }))
                .await;
            let close = agent.expect("session/close").await;
            agent.reply(&close, json!({})).await;
        }
    );
    assert_eq!(
        created,
        Err(AgentRuntimeError::SettingRefused {
            setting: "mode".into(),
            value: "workspace-write".into(),
            reason: SettingRefusal::Agent {
                message: "not allowed".into()
            },
        })
    );
    agent.silent().await;
}

#[tokio::test]
async fn an_unconfirmed_mode_is_refused() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let settings = [approval("workspace-write")];
    let (created, ()) = tokio::join!(
        runtime.new_session(id, Path::new("/project"), &settings),
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let set = agent.expect("session/set_config_option").await;
            agent.reply(&set, mode_settings("agent")).await;
        }
    );
    assert!(matches!(
        created,
        Err(AgentRuntimeError::SettingRefused {
            reason: SettingRefusal::Agent { .. },
            ..
        })
    ));
    // Without a declared `close` the agent keeps the session idle; the
    // runtime does not hand it out.
    let key = SessionKey::from_acp("scripted", "s1", false);
    assert!(runtime.subscribe(&key).is_err());
    assert_eq!(runtime.writers().writer(&key), None);
    agent.silent().await;
}

#[tokio::test]
async fn a_launch_session_moves_the_launch_claim_to_its_canonical_key() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let writers = runtime.writers();
    let claim = writers.claim_launch("launch-one", Writer::Acp).unwrap();
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_launch_session(
                    id,
                    Path::new("/project"),
                    &[approval("workspace-write")],
                    claim,
                )
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let set = agent.expect("session/set_config_option").await;
            let mut confirmed = mode_settings("workspace-write");
            confirmed.as_object_mut().unwrap().remove("sessionId");
            confirmed.as_object_mut().unwrap().remove("modes");
            agent.reply(&set, confirmed).await;
        }
    );
    assert_eq!(writers.writer(&key), Some(Writer::Acp));
    // The launch id no longer holds a slot: the claim moved, not doubled.
    drop(writers.claim_launch("launch-one", Writer::Pty).unwrap());
    assert_eq!(
        writers
            .claim(
                &key,
                Writer::Pty,
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed
            )
            .err(),
        Some(WriterRefusal::WriterActive {
            writer: Writer::Acp
        })
    );
    assert_eq!(
        runtime.watch(&key).unwrap().snapshot.writer,
        crate::activity::WriterState::Acp
    );
    agent.silent().await;
}

#[tokio::test]
async fn a_refused_launch_setting_frees_the_launch_for_its_terminal() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let writers = runtime.writers();
    let claim = writers.claim_launch("launch-one", Writer::Acp).unwrap();
    let settings = [approval("agent-full-access")];
    let (created, ()) = tokio::join!(
        runtime.new_launch_session(id, Path::new("/project"), &settings, claim),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
            let close = agent.expect("session/close").await;
            agent.reply(&close, json!({})).await;
        }
    );
    assert!(matches!(
        created,
        Err(AgentRuntimeError::SettingRefused {
            reason: SettingRefusal::NotDeclared,
            ..
        })
    ));
    let key = SessionKey::from_acp("scripted", "s1", false);
    assert_eq!(writers.writer(&key), None);
    // The terminal of the same binding claims the same launch.
    assert!(writers.claim_launch("launch-one", Writer::Pty).is_ok());
    agent.silent().await;
}

#[tokio::test]
async fn legacy_modes_are_one_mode_setting_changed_by_set_mode() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[approval("plan")])
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(
                    &new_session,
                    json!({
                        "sessionId": "s1",
                        "modes": {
                            "currentModeId": "default",
                            "availableModes": [
                                { "id": "default", "name": "Manual" },
                                { "id": "plan", "name": "Plan", "description": "Plan first" }
                            ]
                        }
                    }),
                )
                .await;
            let set = agent.expect("session/set_mode").await;
            assert_eq!(
                set["params"],
                json!({ "sessionId": "s1", "modeId": "plan" })
            );
            agent.reply(&set, json!({})).await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    let mode = &subscription.snapshot.settings[0];
    assert_eq!(
        (mode.id.as_str(), mode.current_value.as_str()),
        ("mode", "plan")
    );
    assert_eq!(mode.options.len(), 2);

    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "current_mode_update", "currentModeId": "default" }),
        )
        .await;
    follow(&mut subscription, |snapshot| {
        snapshot.settings[0].current_value == "default"
    })
    .await;
}

#[tokio::test]
async fn a_config_option_update_replaces_the_session_settings() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    assert_eq!(subscription.snapshot.settings[0].current_value, "agent");
    let mut update = mode_settings("read-only");
    let options = update["configOptions"].take();
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "config_option_update", "configOptions": options }),
        )
        .await;
    let deltas = follow(&mut subscription, |snapshot| {
        snapshot.settings[0].current_value == "read-only"
    })
    .await;
    assert!(
        deltas
            .iter()
            .any(|delta| matches!(delta.change, Change::Settings(_)))
    );
}

#[tokio::test]
async fn a_setting_changes_once_the_agent_confirms_it_and_a_refusal_keeps_the_value() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
        }
    );
    let confirmed = |current: &str| {
        let mut settings = mode_settings(current);
        settings.as_object_mut().unwrap().remove("sessionId");
        settings.as_object_mut().unwrap().remove("modes");
        settings
    };

    let read_only = approval("read-only");
    let (changed, ()) = tokio::join!(runtime.set_setting(&key, &read_only), async {
        let set = agent.expect("session/set_config_option").await;
        assert_eq!(
            set["params"],
            json!({ "sessionId": "s1", "configId": "mode", "value": "read-only" })
        );
        agent.reply(&set, confirmed("read-only")).await;
    });
    assert_eq!(changed, Ok(()));
    let current = |runtime: &AgentRuntime| {
        runtime.subscribe(&key).unwrap().snapshot.settings[0]
            .current_value
            .clone()
    };
    assert_eq!(current(&runtime), "read-only");

    // A value the session does not declare never reaches the agent.
    assert_eq!(
        runtime
            .set_setting(&key, &approval("agent-full-access"))
            .await,
        Err(AgentRuntimeError::SettingRefused {
            setting: "mode".into(),
            value: "agent-full-access".into(),
            reason: SettingRefusal::NotDeclared,
        })
    );
    agent.silent().await;

    let workspace_write = approval("workspace-write");
    let (refused, ()) = tokio::join!(runtime.set_setting(&key, &workspace_write), async {
        let set = agent.expect("session/set_config_option").await;
        agent
            .send(json!({
                "jsonrpc": "2.0", "id": set["id"],
                "error": { "code": -32602, "message": "not allowed" }
            }))
            .await;
    });
    assert!(matches!(
        refused,
        Err(AgentRuntimeError::SettingRefused {
            reason: SettingRefusal::Agent { .. },
            ..
        })
    ));
    assert_eq!(current(&runtime), "read-only", "a refusal keeps the value");

    // A session the runtime no longer drives does not change.
    let ((), ()) = tokio::join!(
        async { runtime.release_session(&key).await.unwrap() },
        async {
            let close = agent.expect("session/close").await;
            agent.reply(&close, json!({})).await;
        }
    );
    assert_eq!(
        runtime.set_setting(&key, &approval("agent")).await,
        Err(AgentRuntimeError::WriterRequired)
    );
    agent.silent().await;
}

#[tokio::test]
async fn commands_and_usage_reach_the_snapshot_as_session_controls() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    assert!(subscription.snapshot.commands.is_empty());
    assert_eq!(subscription.snapshot.usage, None);
    agent
        .update(
            "s1",
            json!({
                "sessionUpdate": "available_commands_update",
                "availableCommands": [
                    { "name": "review", "description": "Review changes", "input": { "hint": "focus" } },
                    { "name": "init", "description": "Create AGENTS.md", "input": null },
                    { "name": "two words", "description": "not a command name" },
                    { "description": "no name" }
                ]
            }),
        )
        .await;
    agent
        .update(
            "s1",
            json!({
                "sessionUpdate": "usage_update", "used": 53000, "size": 200000,
                "cost": { "amount": 0.045, "currency": "USD" }
            }),
        )
        .await;
    let deltas = follow(&mut subscription, |snapshot| snapshot.usage.is_some()).await;
    let snapshot = &subscription.snapshot;
    let commands: Vec<_> = snapshot
        .commands
        .iter()
        .map(|command| (command.name.as_str(), command.hint.as_deref()))
        .collect();
    assert_eq!(commands, [("review", Some("focus")), ("init", None)]);
    let usage = snapshot.usage.as_ref().unwrap();
    assert_eq!((usage.used, usage.size), (53000, 200000));
    let cost = usage.cost.as_ref().unwrap();
    assert_eq!((cost.amount, cost.currency.as_str()), (0.045, "USD"));
    assert!(snapshot.items.is_empty(), "usage is not a timeline item");
    assert!(
        deltas
            .iter()
            .any(|delta| matches!(delta.change, Change::Commands(_)))
    );

    // Usage without a cost replaces the last report.
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "usage_update", "used": 60000, "size": 200000 }),
        )
        .await;
    follow(&mut subscription, |snapshot| {
        snapshot
            .usage
            .as_ref()
            .is_some_and(|usage| usage.used == 60000)
    })
    .await;
    assert_eq!(subscription.snapshot.usage.as_ref().unwrap().cost, None);
}

#[tokio::test]
async fn an_opened_session_reports_its_settings_and_keeps_replayed_ones() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s1", false);
    let mut options = mode_settings("read-only");
    let options = options["configOptions"].take();
    reopened(
        &runtime,
        &launch(),
        &key,
        vec![json!({ "sessionUpdate": "config_option_update", "configOptions": options })],
    )
    .await;
    // The load answer declares nothing: the replayed settings stay.
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.settings[0].current_value, "read-only");

    let (id, mut agent) = attached(&runtime);
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        async {
            agent.initialize(json!({ "loadSession": true })).await;
            let load = agent.expect("session/load").await;
            let mut declared = mode_settings("agent");
            declared.as_object_mut().unwrap().remove("sessionId");
            agent.reply(&load, declared).await;
        }
    );
    opened.unwrap();
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.settings[0].current_value, "agent");
}

fn reading(writer_refusal: Option<&str>) -> AcpLaunch {
    AcpLaunch {
        read_only_open: true,
        writer_refusal: writer_refusal.map(str::to_string),
        session_per_connection: false,
        draft_session: false,
        ..launch()
    }
}

/// Reads `key` on connection `id`; the agent answers `session/load` after
/// replaying `replay` and then `session/close` where it declares `close`.
async fn read(
    runtime: &AgentRuntime,
    id: ConnectionId,
    agent: &mut ScriptedAgent,
    key: &SessionKey,
    replay: Vec<Value>,
    close: bool,
) -> Result<(), AgentRuntimeError> {
    let (read, ()) = tokio::join!(
        runtime.read_session(id, key, Path::new("/project")),
        async {
            let load = agent.expect("session/load").await;
            assert_eq!(load["params"]["sessionId"], key.session_id.as_str());
            for update in replay {
                agent.update(&key.session_id, update).await;
            }
            agent.reply(&load, json!({})).await;
            if close {
                let close = agent.expect("session/close").await;
                assert_eq!(close["params"]["sessionId"], key.session_id.as_str());
                agent.reply(&close, json!({})).await;
            }
        }
    );
    read
}

fn messages(snapshot: &SessionSnapshot) -> Vec<String> {
    snapshot
        .items
        .iter()
        .map(|item| item.summary.clone())
        .collect()
}

#[tokio::test]
async fn reading_replays_the_history_then_closes_the_session_without_a_writer() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (id, mut agent) = attached_with(&runtime, &reading(None));
    let (initialized, ()) = tokio::join!(
        runtime.read_session(id, &key, Path::new("/project")),
        async {
            agent
                .initialize(json!({ "loadSession": true, "sessionCapabilities": { "close": {} } }))
                .await;
            let load = agent.expect("session/load").await;
            agent.update("s7", user_chunk("Read the plan")).await;
            agent.update("s7", agent_chunk("Done")).await;
            agent.reply(&load, json!({})).await;
            let close = agent.expect("session/close").await;
            agent.reply(&close, json!({})).await;
        }
    );
    initialized.unwrap();

    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(messages(&snapshot), vec!["Read the plan", "Done"]);
    assert_eq!(
        snapshot.history,
        HistoryState {
            source: HistorySource::Replay,
            available: true,
            truncated_items: None
        }
    );
    assert_eq!(snapshot.writer, WriterState::None);
    assert_eq!(runtime.writers().writer(&key), None);

    // The snapshot does not follow the session, and no prompt reaches it.
    agent.update("s7", agent_chunk("Later")).await;
    assert_eq!(
        runtime.prompt(&key, &[PromptPart::text("Next")]),
        Err(AgentRuntimeError::WriterRequired)
    );
    agent.silent().await;
    assert_eq!(runtime.subscribe(&key).unwrap().snapshot, snapshot);

    // Reading again replays the session anew.
    read(
        &runtime,
        id,
        &mut agent,
        &key,
        vec![
            user_chunk("Read the plan"),
            agent_chunk("Done"),
            user_chunk("Thanks"),
        ],
        true,
    )
    .await
    .unwrap();
    let again = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(messages(&again), vec!["Read the plan", "Done", "Thanks"]);
    assert_eq!(again.writer, WriterState::None);
    agent.silent().await;
}

#[tokio::test]
async fn an_agent_without_close_keeps_the_read_session_attached_and_idle() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (id, mut agent) = attached_with(&runtime, &reading(None));
    let (initialized, ()) = tokio::join!(
        runtime.read_session(id, &key, Path::new("/project")),
        async {
            agent.initialize(json!({ "loadSession": true })).await;
            let load = agent.expect("session/load").await;
            agent.update("s7", user_chunk("Hello")).await;
            agent.reply(&load, json!({})).await;
        }
    );
    initialized.unwrap();
    agent.silent().await;
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(messages(&snapshot), vec!["Hello"]);
    assert_eq!(runtime.writers().writer(&key), None);
}

#[tokio::test]
async fn reading_goes_on_while_another_process_writes_unless_the_agent_refuses() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let _pty = runtime
        .writers()
        .claim(
            &key,
            Writer::Pty,
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        )
        .unwrap();
    let (id, mut agent) = attached_with(&runtime, &reading(None));
    agent_initialized(&runtime, id, &mut agent).await;
    read(
        &runtime,
        id,
        &mut agent,
        &key,
        vec![user_chunk("Hello")],
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        messages(&runtime.subscribe(&key).unwrap().snapshot),
        vec!["Hello"]
    );
    assert_eq!(runtime.writers().writer(&key), Some(Writer::Pty));

    // An agent that refuses a session another of its clients writes to.
    let other = SessionKey::from_acp("scripted", "s8", false);
    let (id, mut agent) = attached_with(&runtime, &reading(Some("thread_active_writer")));
    agent_initialized(&runtime, id, &mut agent).await;
    let (refused, ()) = tokio::join!(
        runtime.read_session(id, &other, Path::new("/project")),
        async {
            let load = agent.expect("session/load").await;
            agent
            .send(json!({
                "jsonrpc": "2.0",
                "id": load["id"],
                "error": {
                    "code": -32600,
                    "message": "Invalid request: This Codex session is in use by another Codex client",
                    "data": { "reason": "thread_active_writer", "threadId": "s8" }
                }
            }))
            .await;
        }
    );
    assert_eq!(
        refused,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::ExternalActive
        })
    );
    assert!(runtime.subscribe(&other).is_err());
    agent.silent().await;
    assert_eq!(
        runtime.connection_status(id).unwrap().state,
        ConnectionState::Ready
    );

    // Opening with a writer gets the same refusal and frees the slot.
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &other,
            Path::new("/project"),
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        async {
            let load = agent.expect("session/load").await;
            agent
                .send(json!({
                    "jsonrpc": "2.0",
                    "id": load["id"],
                    "error": { "code": -32600, "message": "in use", "data": { "reason": "thread_active_writer" } }
                }))
                .await;
        }
    );
    assert_eq!(
        opened,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::ExternalActive
        })
    );
    assert_eq!(runtime.writers().writer(&other), None);
}

/// Initializes the connection through a read of a session the agent does
/// not have; nothing is registered.
async fn agent_initialized(runtime: &AgentRuntime, id: ConnectionId, agent: &mut ScriptedAgent) {
    let missing = SessionKey::from_acp("scripted", "missing", false);
    let (read, ()) = tokio::join!(
        runtime.read_session(id, &missing, Path::new("/project")),
        async {
            agent
                .initialize(json!({ "loadSession": true, "sessionCapabilities": { "close": {} } }))
                .await;
            let load = agent.expect("session/load").await;
            agent
                .send(json!({
                    "jsonrpc": "2.0",
                    "id": load["id"],
                    "error": { "code": -32002, "message": "Resource not found" }
                }))
                .await;
        }
    );
    assert!(matches!(read, Err(AgentRuntimeError::Agent { .. })));
    assert!(runtime.subscribe(&missing).is_err());
}

#[tokio::test]
async fn without_read_only_evidence_the_history_is_not_read_and_an_external_writer_refuses_opening()
{
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "s7", false);
    let (id, mut agent) = attached(&runtime);
    assert_eq!(
        runtime.read_session(id, &key, Path::new("/project")).await,
        Err(AgentRuntimeError::ReadOnlyUnsupported)
    );
    let (opened, ()) = tokio::join!(
        runtime.open_session(
            id,
            &key,
            Path::new("/project"),
            ExternalLiveness::ExternalActive,
            UnknownLiveness::Confirmed,
        ),
        agent.initialize(json!({ "loadSession": true }))
    );
    assert_eq!(
        opened,
        Err(AgentRuntimeError::WriterRefused {
            refusal: WriterRefusal::ExternalActive
        })
    );
    agent.silent().await;
    assert!(runtime.subscribe(&key).is_err());

    // An agent that does not replay history is not read either.
    let (id, mut agent) = attached_with(&runtime, &reading(None));
    let (read, ()) = tokio::join!(
        runtime.read_session(id, &key, Path::new("/project")),
        agent.initialize(json!({ "sessionCapabilities": { "resume": {} } }))
    );
    assert_eq!(read, Err(AgentRuntimeError::ReadOnlyUnsupported));
    agent.silent().await;
}

#[tokio::test]
async fn a_session_the_runtime_drives_is_not_read_again() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &reading(None));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(id, Path::new("/project"), &[])
                .await
                .unwrap()
        },
        agent.open_session()
    );
    runtime
        .read_session(id, &key, Path::new("/project"))
        .await
        .unwrap();
    agent.silent().await;
    assert_eq!(runtime.writers().writer(&key), Some(Writer::Acp));
    assert_eq!(
        runtime.subscribe(&key).unwrap().snapshot.writer,
        WriterState::Acp
    );
}

/// A `/bin/sh` ACP agent that answers `initialize` with the agent version
/// `<$SVODE_PROBE or ->|<home when $HOME is set>` and an empty
/// `session/list`, so a test sees the environment of the process.
#[cfg(unix)]
fn sh_agent(env: &[(&str, &str)]) -> AcpLaunch {
    const SCRIPT: &str = r#"while IFS= read -r line; do
  id=${line#'{"id":'}; id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"list":{}}},"agentInfo":{"name":"sh","version":"%s|%s"}}}\n' "$id" "${SVODE_PROBE:--}" "${HOME:+home}";;
    *'"method":"session/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessions":[]}}\n' "$id";;
    *'"method":"session/new"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s1"}}\n' "$id";;
  esac
done"#;
    AcpLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), SCRIPT.into()],
        env: env
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect(),
        cwd: std::env::temp_dir(),
        ..launch()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_launch_plan_with_one_session_per_connection_starts_another_after_a_session() {
    let runtime = AgentRuntime::default();
    let plan = AcpLaunch {
        agent: "pi".into(),
        lists_catalog: true,
        session_per_connection: true,
        draft_session: false,
        ..sh_agent(&[])
    };
    let catalog = runtime.acquire(plan.clone()).await.unwrap();
    runtime
        .new_session(catalog.connection(), Path::new("/project"), &[])
        .await
        .unwrap();
    let next = runtime.acquire(plan.clone()).await.unwrap();
    assert_ne!(next.connection(), catalog.connection());
    assert_eq!(
        runtime.catalog_connections(),
        vec![CatalogConnection {
            connection: next.connection(),
            agent: "pi".into()
        }]
    );
    // An agent without the rule keeps sharing its connection.
    let shared = runtime.acquire(sh_agent(&[])).await.unwrap();
    runtime
        .new_session(shared.connection(), Path::new("/project"), &[])
        .await
        .unwrap();
    let again = runtime.acquire(sh_agent(&[])).await.unwrap();
    assert_eq!(again.connection(), shared.connection());
    runtime.shutdown().await;
}

#[cfg(unix)]
fn version(runtime: &AgentRuntime, lease: &ConnectionLease) -> String {
    runtime
        .connection_status(lease.connection())
        .unwrap()
        .agent
        .unwrap()
        .version
        .unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn one_launch_plan_shares_its_connection_and_another_provenance_gets_its_own() {
    let runtime = AgentRuntime::default();
    let shared = runtime.acquire(sh_agent(&[])).await.unwrap();
    let again = runtime.acquire(sh_agent(&[])).await.unwrap();
    assert_eq!(shared.connection(), again.connection());

    // A Routine caller token is part of its launch plan.
    let first = runtime
        .acquire(sh_agent(&[("SVODE_PROBE", "token-a")]))
        .await
        .unwrap();
    let second = runtime
        .acquire(sh_agent(&[("SVODE_PROBE", "token-b")]))
        .await
        .unwrap();
    let connections = [shared.connection(), first.connection(), second.connection()];
    assert_eq!(
        connections.iter().collect::<HashSet<_>>().len(),
        3,
        "{connections:?}"
    );
    assert!(version(&runtime, &shared).starts_with("-|"));
    assert!(version(&runtime, &first).starts_with("token-a|"));
    assert!(version(&runtime, &second).starts_with("token-b|"));
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn the_hosts_environment_replaces_the_inherited_one() {
    let runtime = AgentRuntime::default();
    let inherited = runtime.acquire(sh_agent(&[])).await.unwrap();
    assert_eq!(version(&runtime, &inherited), "-|home");

    let lease = runtime
        .acquire(AcpLaunch {
            environment: Some(LaunchEnvironment::new([(
                OsString::from("SVODE_PROBE"),
                OsString::from("login-shell"),
            )])),
            ..sh_agent(&[])
        })
        .await
        .unwrap();
    // HOME of the test process does not reach the agent.
    assert_eq!(version(&runtime, &lease), "login-shell|");
    assert_eq!(
        format!(
            "{:?}",
            LaunchEnvironment::new([(OsString::from("KEY"), OsString::from("secret"))])
        ),
        "LaunchEnvironment(1 variables)"
    );
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_connection_closes_after_idle_once_no_lease_holds_it() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        connection_idle: Duration::from_millis(60),
        ..RuntimeConfig::default()
    });
    let lease = runtime.acquire(sh_agent(&[])).await.unwrap();
    let id = lease.connection();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(lease.is_open());

    drop(lease);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        runtime.connection_status(id).unwrap().state,
        ConnectionState::Closed
    );
    // The next boundary starts the agent again.
    let lease = runtime.acquire(sh_agent(&[])).await.unwrap();
    assert_ne!(lease.connection(), id);
    assert!(lease.is_open());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_session_open_in_a_surface_keeps_its_connection_past_idle() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        connection_idle: Duration::from_millis(60),
        ..RuntimeConfig::default()
    });
    let (id, key, _agent) = session(&runtime).await;
    let subscription = runtime.subscribe(&key).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        runtime.connection_status(id).unwrap().state,
        ConnectionState::Ready
    );

    drop(subscription);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        runtime.connection_status(id).unwrap().state,
        ConnectionState::Closed
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_check_closes_the_connection_it_started_and_keeps_one_still_needed() {
    let runtime = AgentRuntime::default();
    let AgentCheck::Ready { agent } = runtime.check(sh_agent(&[])).await else {
        panic!("the agent starts");
    };
    assert_eq!(agent.name.as_deref(), Some("sh"));
    assert!(agent.capabilities.list_sessions);
    assert!(runtime.catalog_connections().is_empty());
    assert!(
        runtime
            .inner
            .connections
            .lock()
            .unwrap()
            .values()
            .all(|connection| !connection.is_open())
    );

    let lease = runtime.acquire(sh_agent(&[])).await.unwrap();
    assert!(matches!(
        runtime.check(sh_agent(&[])).await,
        AgentCheck::Ready { .. }
    ));
    assert!(lease.is_open());
    runtime.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_start_is_a_check_outcome_and_leaves_no_process() {
    let runtime = AgentRuntime::new(RuntimeConfig {
        request_timeout: Duration::from_millis(200),
        ..RuntimeConfig::default()
    });
    let exiting = AcpLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), "echo 'adapter crashed' >&2; exit 3".into()],
        cwd: std::env::temp_dir(),
        ..launch()
    };
    let AgentCheck::FailedToStart { message } = runtime.check(exiting).await else {
        panic!("the agent fails to start");
    };
    assert!(message.contains("adapter crashed"), "{message}");

    let hung = AcpLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), "cat > /dev/null".into()],
        cwd: std::env::temp_dir(),
        ..launch()
    };
    let error = runtime.acquire(hung).await.unwrap_err();
    let AgentRuntimeError::Initialize { connection, .. } = error else {
        panic!("expected an initialize failure, got {error:?}");
    };
    assert_eq!(
        runtime.connection_status(connection).unwrap().state,
        ConnectionState::Closed
    );
}

/// Claude Code `ExitPlanMode` in the shape `claude-agent-acp` 0.85.0 sends
/// to a client that is not AIR (`permissions/presentation.js`,
/// `tool-calls/reporters/interaction.js`, `permissions/options/tools.js`): the
/// whole tool call again with the plan as its content.
fn plan_approval(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/request_permission",
        "params": {
            "sessionId": "s1",
            "toolCall": {
                "toolCallId": "toolu_plan",
                "name": "ExitPlanMode",
                "status": "pending",
                "rawInput": { "plan": "1. Add the test\n2. Fix the bug" },
                "title": "Approve Plan",
                "kind": "switch_mode",
                "content": [{ "type": "content", "content": { "type": "text", "text": "1. Add the test\n2. Fix the bug" } }]
            },
            "options": [
                { "optionId": "exit-plan-clear-auto", "name": "Yes, clear context (12% used) and use auto mode", "kind": "allow_always" },
                { "optionId": "exit-plan-auto", "name": "Yes, and use auto mode", "kind": "allow_always" },
                { "optionId": "exit-plan-default", "name": "Yes, manually approve edits", "kind": "allow_once" },
                { "optionId": "reject", "name": "No, keep planning", "kind": "reject_once" }
            ]
        }
    })
}

#[tokio::test]
async fn a_permission_names_its_tool_call_and_its_fields_merge_into_that_item() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _prompt) = start_turn(&runtime).await;
    agent.send(plan_approval(json!("perm-plan"))).await;
    let pending = until_pending(&mut subscription).await;
    assert_eq!(pending.tool_call_id.as_deref(), Some("toolu_plan"));
    assert_eq!(pending.title, "Approve Plan");

    // The request created the item of its tool call, carrying the subject.
    let item = subscription
        .snapshot
        .items
        .iter()
        .find(|item| item.id == "toolu_plan")
        .unwrap();
    assert_eq!(
        item.kind,
        ItemKind::ToolCall {
            tool: ToolKind::SwitchMode
        }
    );
    assert_eq!(item.summary, "Approve Plan");
    assert_eq!(
        runtime.detail(&key, "toolu_plan"),
        DetailOutcome::Available {
            blocks: vec![DetailBlock::Text {
                text: "1. Add the test\n2. Fix the bug".into()
            }]
        }
    );
    let at = subscription
        .snapshot
        .items
        .iter()
        .position(|item| item.id == "toolu_plan")
        .unwrap();

    // A later update of the call lands in the same item.
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_plan", "status": "completed" }),
        )
        .await;
    runtime
        .answer(&key, &pending.id, option("exit-plan-default"))
        .unwrap();
    agent.recv().await;
    follow(&mut subscription, |snapshot| {
        snapshot
            .items
            .iter()
            .any(|item| item.id == "toolu_plan" && item.status == Some(ItemStatus::Completed))
            && snapshot.items.iter().any(|item| item.id == pending.id)
    })
    .await;
    let items = &subscription.snapshot.items;
    assert_eq!(items[at].id, "toolu_plan");
    assert_eq!(
        items.iter().filter(|item| item.id == "toolu_plan").count(),
        1
    );
}

/// Codex plan review in the shape `codex-acp` 2.1.1 sends
/// (`PlanReviewReporter`): a new tool call of its own without content; the
/// plan itself came as an agent message.
#[tokio::test]
async fn a_permission_for_a_new_tool_call_creates_its_item() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, _prompt) = start_turn(&runtime).await;
    agent
        .send(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "plan-review:item_7",
                    "kind": "switch_mode",
                    "status": "pending",
                    "title": "Implement this plan?",
                    "rawInput": { "plan": "1. Add the test" }
                },
                "options": [
                    { "optionId": "implement_plan", "name": "Yes, implement this plan", "kind": "allow_once" },
                    { "optionId": "revise_plan", "name": "No, and tell Codex what to do differently", "kind": "reject_once" }
                ]
            }
        }))
        .await;
    let pending = until_pending(&mut subscription).await;
    assert_eq!(pending.tool_call_id.as_deref(), Some("plan-review:item_7"));
    let item = subscription
        .snapshot
        .items
        .iter()
        .find(|item| item.id == "plan-review:item_7")
        .unwrap();
    assert_eq!(item.summary, "Implement this plan?");
    assert_eq!(item.status, Some(ItemStatus::Pending));
    assert_eq!(
        runtime.detail(&key, "plan-review:item_7"),
        DetailOutcome::Unavailable {
            reason: UnavailableReason::NotProvided
        }
    );
}

#[tokio::test]
async fn resolved_requests_stay_in_the_timeline_with_their_outcome() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, prompt) = start_turn(&runtime).await;
    agent.send(permission(json!("perm-1"))).await;
    let answered = until_pending(&mut subscription).await;
    runtime.answer(&key, &answered.id, option("allow")).unwrap();
    agent.recv().await;

    agent.send(json!({
        "jsonrpc": "2.0",
        "id": "q-1",
        "method": "elicitation/create",
        "params": {
            "sessionId": "s1",
            "mode": "form",
            "message": "Which branch?",
            "requestedSchema": { "type": "object", "properties": { "branch": { "type": "string" } } }
        }
    }))
    .await;
    follow(&mut subscription, |snapshot| {
        snapshot
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id != answered.id)
    })
    .await;
    let declined = subscription.snapshot.pending.clone().unwrap();
    runtime
        .answer(&key, &declined.id, InteractionAnswer::Decline)
        .unwrap();
    agent.recv().await;

    agent.send(permission(json!("perm-2"))).await;
    follow(&mut subscription, |snapshot| {
        snapshot
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id != declined.id)
    })
    .await;
    let cancelled = subscription.snapshot.pending.clone().unwrap();
    runtime.cancel(&key).unwrap();
    agent.recv().await;
    agent.expect("session/cancel").await;
    agent
        .reply(&prompt, json!({ "stopReason": "cancelled" }))
        .await;
    follow(&mut subscription, idle).await;

    let record = |id: &str| {
        subscription
            .snapshot
            .items
            .iter()
            .find(|item| item.id == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        record(&answered.id).kind,
        ItemKind::Interaction {
            request: InteractionKind::Permission,
            state: InteractionState::Answered,
            tool_call_id: Some("t1".into()),
            option: Some("Allow".into()),
            declined: false,
        }
    );
    assert_eq!(record(&answered.id).summary, "Run npm test");
    assert_eq!(
        record(&declined.id).kind,
        ItemKind::Interaction {
            request: InteractionKind::Question,
            state: InteractionState::Answered,
            tool_call_id: None,
            option: None,
            declined: true,
        }
    );
    assert!(matches!(
        record(&cancelled.id).kind,
        ItemKind::Interaction {
            state: InteractionState::Cancelled,
            ..
        }
    ));
    // After a reload the records are there and nothing is pending.
    let reloaded = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(reloaded.pending, None);
    assert_eq!(reloaded.items, subscription.snapshot.items);
}

#[tokio::test]
async fn a_finished_turn_carries_its_duration_and_each_turn_its_own_plan() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, prompt) = start_turn(&runtime).await;
    let first = subscription.snapshot.turn.turn_id.clone();
    let first = match first {
        Some(turn) => turn,
        None => {
            follow(&mut subscription, |snapshot| {
                snapshot.turn.turn_id.is_some()
            })
            .await;
            subscription.snapshot.turn.turn_id.clone().unwrap()
        }
    };
    let plan = |status: &str| json!({ "sessionUpdate": "plan", "entries": [{ "content": "Step", "priority": "high", "status": status }] });
    agent.update("s1", plan("pending")).await;
    agent.update("s1", agent_chunk("working")).await;
    agent.update("s1", plan("completed")).await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;

    let items = subscription.snapshot.items.clone();
    let plans: Vec<_> = items
        .iter()
        .filter(|item| matches!(item.kind, ItemKind::Plan { .. }))
        .collect();
    assert_eq!(
        plans.len(),
        1,
        "a later plan replaces the turn's plan in place"
    );
    assert!(matches!(
        &plans[0].kind,
        ItemKind::Plan { entries } if entries[0].status == crate::activity::PlanEntryStatus::Completed
    ));
    let plan_at = items
        .iter()
        .position(|item| item.id == format!("plan:{first}"));
    let message_at = items
        .iter()
        .position(|item| item.kind == ItemKind::AgentMessage);
    assert!(plan_at < message_at, "the plan keeps its first place");
    assert!(items.iter().any(|item| matches!(
        item.kind,
        ItemKind::TurnOutcome {
            reason: StopReason::EndTurn,
            duration_ms: Some(_)
        }
    )));

    runtime.prompt(&key, &[PromptPart::text("again")]).unwrap();
    let prompt = agent.expect("session/prompt").await;
    agent.update("s1", plan("in_progress")).await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, |snapshot| {
        idle(snapshot)
            && snapshot
                .items
                .iter()
                .filter(|item| matches!(item.kind, ItemKind::Plan { .. }))
                .count()
                == 2
    })
    .await;
}

#[tokio::test]
async fn a_created_session_is_listed_from_its_first_prompt_while_the_runtime_drives_it() {
    let runtime = AgentRuntime::default();
    let (connection, key, mut agent) = session(&runtime).await;
    let mut changes = runtime.catalog_changes();
    assert!(
        runtime.sessions().is_empty(),
        "a session without a prompt is not in the catalogue"
    );

    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime
        .prompt(
            &key,
            &[PromptPart::text("\n  Fix the login bug\nthen run tests")],
        )
        .unwrap();
    assert_eq!(changes.recv().await.unwrap().agent, "scripted");
    let listed = runtime.sessions();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].key, key);
    assert_eq!(listed[0].cwd, PathBuf::from("/project"));
    assert_eq!(listed[0].title.as_deref(), Some("Fix the login bug"));
    assert_eq!(listed[0].status.state, SessionState::Running);

    let prompt = agent.expect("session/prompt").await;
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "session_info_update", "title": "Login bug" }),
        )
        .await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, |snapshot| {
        idle(snapshot) && snapshot.title.as_deref() == Some("Login bug")
    })
    .await;
    let listed = runtime.sessions();
    assert_eq!(listed[0].title.as_deref(), Some("Login bug"));
    assert_eq!(
        listed[0].status.state,
        SessionState::Idle {
            stop_reason: Some(StopReason::EndTurn)
        }
    );

    runtime.close_connection(connection).await.unwrap();
    assert!(
        runtime.sessions().is_empty(),
        "a session the runtime no longer drives leaves the runtime catalogue"
    );
}

#[tokio::test]
async fn updates_sent_before_the_answer_land_in_the_turn_before_it_ends() {
    let runtime = AgentRuntime::default();
    let (key, mut agent, mut subscription, prompt) = start_turn(&runtime).await;
    let turn = subscription.snapshot.turn.turn_id.clone();
    for index in 0..200 {
        agent.update("s1", agent_chunk(&format!("{index} "))).await;
    }
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "session_info_update", "title": "Counting" }),
        )
        .await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    let deltas = follow(&mut subscription, idle).await;
    let ended = deltas
        .iter()
        .position(
            |delta| matches!(&delta.change, Change::Turn(state) if state.phase == TurnPhase::None),
        )
        .unwrap();
    assert!(
        deltas[ended..]
            .iter()
            .all(|delta| !matches!(delta.change, Change::Item(_) | Change::Title(_))),
        "nothing of the turn arrives after it ended"
    );
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert_eq!(snapshot.title.as_deref(), Some("Counting"));
    let message = snapshot
        .items
        .iter()
        .find(|item| item.kind == ItemKind::AgentMessage)
        .unwrap();
    assert!(message.summary.ends_with("199 "));
    assert_eq!(message.turn_id, turn.or(snapshot.turn.turn_id.clone()));
}

#[tokio::test]
async fn a_prompt_sends_text_and_links_in_order_and_an_image_only_to_an_agent_declaring_images() {
    let dir = tempfile::tempdir().unwrap();
    let note = dir.path().join("note.md");
    let shot = dir.path().join("shot.png");
    std::fs::write(&note, "# Note").unwrap();
    std::fs::write(&shot, [137, 80, 78, 71]).unwrap();
    let parts = [
        PromptPart::text("Compare "),
        PromptPart::File {
            path: note.clone(),
            name: "note.md".into(),
        },
        PromptPart::text(" with "),
        PromptPart::File {
            path: shot.clone(),
            name: "shot.png".into(),
        },
    ];
    for images in [true, false] {
        let runtime = AgentRuntime::default();
        let (id, mut agent) = attached(&runtime);
        let (key, ()) = tokio::join!(
            async {
                runtime
                    .new_session(id, Path::new("/project"), &[])
                    .await
                    .unwrap()
            },
            agent.open_session_declaring(json!({ "promptCapabilities": { "image": images } }))
        );
        let turn = runtime.prompt(&key, &parts).unwrap();
        let prompt = agent.expect("session/prompt").await;
        let types: Vec<&str> = prompt["params"]["prompt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect();
        let shot_uri = crate::prompt::file_uri(&shot);
        if images {
            assert_eq!(
                types,
                ["text", "resource_link", "text", "resource_link", "image"]
            );
            assert_eq!(
                prompt["params"]["prompt"][4],
                json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw==", "uri": shot_uri })
            );
        } else {
            assert_eq!(types, ["text", "resource_link", "text", "resource_link"]);
        }
        assert_eq!(
            prompt["params"]["prompt"][1],
            json!({ "type": "resource_link", "uri": crate::prompt::file_uri(&note), "name": "note.md" })
        );
        assert_eq!(
            prompt["params"]["prompt"][3],
            json!({ "type": "resource_link", "uri": shot_uri, "name": "shot.png", "mimeType": "image/png" })
        );

        let snapshot = runtime.subscribe(&key).unwrap().snapshot;
        let message = snapshot
            .items
            .iter()
            .find(|item| item.id == format!("user:{turn}"))
            .unwrap();
        assert_eq!(message.summary, "Compare @note.md with @shot.png");
        assert_eq!(
            message.kind,
            ItemKind::UserMessage {
                segments: vec![
                    MessageSegment::Text {
                        text: "Compare ".into()
                    },
                    MessageSegment::Link {
                        uri: crate::prompt::file_uri(&note),
                        name: "note.md".into()
                    },
                    MessageSegment::Text {
                        text: " with ".into()
                    },
                    MessageSegment::Link {
                        uri: shot_uri,
                        name: "shot.png".into()
                    },
                ]
            }
        );
    }
}

#[tokio::test]
async fn a_prompt_linking_a_missing_file_is_refused_without_a_prompt_or_a_turn() {
    let runtime = AgentRuntime::default();
    let (_id, key, mut agent) = session(&runtime).await;
    let missing = std::env::temp_dir().join("svode-missing-attachment.md");
    let refused = runtime.prompt(
        &key,
        &[
            PromptPart::text("Read "),
            PromptPart::File {
                path: missing.clone(),
                name: "gone.md".into(),
            },
        ],
    );
    assert_eq!(
        refused,
        Err(AgentRuntimeError::FileUnavailable {
            path: missing.display().to_string()
        })
    );
    agent.silent().await;
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    assert!(snapshot.items.is_empty());
    assert_eq!(snapshot.turn.phase, TurnPhase::None);
    assert!(runtime.sessions().is_empty(), "nothing is listed");
}

#[tokio::test]
async fn a_replayed_user_message_keeps_its_links_and_images_in_order() {
    let runtime = AgentRuntime::default();
    let key = SessionKey::from_acp("scripted", "links", false);
    let _agent = reopened(
        &runtime,
        &launch(),
        &key,
        vec![
            user_chunk("Look at "),
            json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "resource_link", "uri": "file:///p/a.md", "name": "a.md" } }),
            json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "image", "mimeType": "image/png", "data": "iVBORw==" } }),
            user_chunk(" please"),
            agent_chunk("Done"),
            user_chunk("[@b.md](file:///p/b.md) only text"),
        ],
    )
    .await;

    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    let users: Vec<_> = snapshot
        .items
        .iter()
        .filter(|item| matches!(item.kind, ItemKind::UserMessage { .. }))
        .collect();
    assert_eq!(users.len(), 2);
    assert_eq!(users[0].summary, "Look at @a.md please");
    assert_eq!(
        users[0].kind,
        ItemKind::UserMessage {
            segments: vec![
                MessageSegment::Text {
                    text: "Look at ".into()
                },
                MessageSegment::Link {
                    uri: "file:///p/a.md".into(),
                    name: "a.md".into()
                },
                MessageSegment::Image {
                    uri: None,
                    name: None
                },
                MessageSegment::Text {
                    text: " please".into()
                },
            ]
        }
    );
    assert_eq!(
        users[1].kind,
        ItemKind::UserMessage {
            segments: Vec::new()
        },
        "links the adapter replays as text stay text for the chat to read"
    );
}
