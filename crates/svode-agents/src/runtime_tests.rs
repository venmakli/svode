use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use super::*;
use crate::activity::{
    Change, DetailBlock, FieldInput, HistorySource, HistoryState, ItemKind, ItemStatus, TurnPhase,
    UnavailableReason,
};
use crate::interaction::FieldValue;
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
        env: BTreeMap::new(),
        cwd: PathBuf::from("/project"),
        acp_id_is_native: false,
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
        ..RuntimeConfig::default()
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

    let huge = "x".repeat(Retention::default().item_detail + 1);
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
    runtime.prompt(&key, "work").unwrap();
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
        runtime.new_session(id, Path::new("/project")),
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
async fn leaving_the_surface_does_not_stop_the_turn() {
    let runtime = AgentRuntime::default();
    let (_connection, key, mut agent) = session(&runtime).await;
    let subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, "work").unwrap();
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
                .new_session(connection, Path::new("/project"))
                .await
                .unwrap()
        },
        agent.open_session_declaring(json!({ "sessionCapabilities": { "close": {} } }))
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime.prompt(&key, "work").unwrap();
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
    runtime.prompt(&key, "work").unwrap();
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
                ItemKind::UserMessage,
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
            (ItemKind::UserMessage, replay("replay:2"), "Thanks".into()),
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
    let turn = runtime.prompt(&key, "Next").unwrap();
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
        DetailOutcome::Unavailable {
            reason: UnavailableReason::TooLarge
        }
    );
    assert!(matches!(
        runtime.detail(&key, "t1"),
        DetailOutcome::Error { .. }
    ));
    // Evicted items no longer hold detail.
    let held = runtime.inner.detail_bytes.load(Ordering::Relaxed);
    assert!(held < 1024, "{held} detail bytes held");
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
        let turn = runtime.prompt(&key, text).unwrap();
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
