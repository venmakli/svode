//! Announcements without a started session (Stage 11 `03`): unstable
//! session models, draft sessions by evidence with their deletion, and the
//! agents' last declarations.

use std::sync::Mutex as StdMutex;

use super::*;
use crate::activity::SettingCategory;
use crate::drafts::{AgentDeclaration, DraftHost, DraftSession, PendingDeletion};

#[derive(Default)]
struct RecordingHost {
    declarations: StdMutex<Vec<AgentDeclaration>>,
    pending: StdMutex<Vec<Vec<PendingDeletion>>>,
}

impl DraftHost for RecordingHost {
    fn declarations_changed(&self, declarations: &[AgentDeclaration]) {
        *self.declarations.lock().unwrap() = declarations.to_vec();
    }

    fn pending_deletions_changed(&self, pending: &[PendingDeletion]) {
        self.pending.lock().unwrap().push(pending.to_vec());
    }
}

impl RecordingHost {
    fn last_pending(&self) -> Vec<PendingDeletion> {
        self.pending
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

fn hosted(runtime: &AgentRuntime, pending: Vec<PendingDeletion>) -> Arc<RecordingHost> {
    let host = Arc::new(RecordingHost::default());
    runtime.host_drafts(host.clone(), Vec::new(), pending);
    host
}

fn drafting(draft_session: DraftSession) -> AcpLaunch {
    AcpLaunch {
        draft_session,
        ..launch()
    }
}

fn pending(session_id: &str) -> PendingDeletion {
    PendingDeletion {
        agent: "scripted".into(),
        session_id: session_id.into(),
    }
}

/// Hermes declares its models only in the unstable session model state.
fn hermes_settings(current_model: &str) -> Value {
    json!({
        "sessionId": "s1",
        "models": {
            "currentModelId": current_model,
            "availableModels": [
                { "modelId": "openai-codex:gpt-6", "name": "gpt-6", "description": "Codex" },
                { "modelId": "nous:hermes-5", "name": "hermes-5" }
            ]
        },
        "modes": {
            "currentModeId": "default",
            "availableModes": [
                { "id": "default", "name": "Default" },
                { "id": "accept_edits", "name": "Accept edits" }
            ]
        }
    })
}

fn value(setting: &str, value: &str) -> SettingValue {
    SettingValue {
        setting: setting.into(),
        value: value.into(),
    }
}

#[tokio::test]
async fn unstable_models_are_the_model_setting_changed_by_set_model() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_session(
                    id,
                    Path::new("/project"),
                    &[value("model", "nous:hermes-5")],
                )
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, hermes_settings("openai-codex:gpt-6"))
                .await;
            let set = agent.expect("session/set_model").await;
            assert_eq!(
                set["params"],
                json!({ "sessionId": "s1", "modelId": "nous:hermes-5" })
            );
            // The agent answers without the new state.
            agent.reply(&set, json!({})).await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    let settings = &subscription.snapshot.settings;
    let ids: Vec<_> = settings.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["model", "mode"]);
    assert_eq!(settings[0].category, SettingCategory::Model);
    assert_eq!(settings[0].current_value, "nous:hermes-5");
    assert_eq!(settings[0].options[0].description.as_deref(), Some("Codex"));
    // An ordinary session's declarations are kept per model too, the first
    // one and the one after the change.
    let models: Vec<_> = runtime
        .last_declarations("scripted")
        .into_iter()
        .map(|declared| declared.model)
        .collect();
    assert_eq!(models.len(), 2);
    assert!(models.contains(&Some("openai-codex:gpt-6".into())));
    assert!(models.contains(&Some("nous:hermes-5".into())));

    // The legacy mode still changes through `session/set_mode`.
    let mode = value("mode", "accept_edits");
    let (changed, ()) = tokio::join!(runtime.set_setting(&key, &mode), async {
        let set = agent.expect("session/set_mode").await;
        assert_eq!(set["params"]["modeId"], "accept_edits");
        agent.reply(&set, json!({})).await;
    });
    changed.unwrap();
    follow(&mut subscription, |snapshot| {
        snapshot.settings[1].current_value == "accept_edits"
            && snapshot.settings[0].current_value == "nous:hermes-5"
    })
    .await;
}

#[tokio::test]
async fn a_model_of_the_config_options_takes_precedence_over_unstable_models() {
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
            let mut declared = hermes_settings("openai-codex:gpt-6");
            declared["configOptions"] = json!([{
                "id": "llm", "name": "Model", "category": "model", "type": "select",
                "currentValue": "a",
                "options": [{ "value": "a", "name": "A" }, { "value": "b", "name": "B" }]
            }]);
            agent.reply(&new_session, declared).await;
        }
    );
    let snapshot = runtime.subscribe(&key).unwrap().snapshot;
    let ids: Vec<_> = snapshot.settings.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["llm"]);
    // The unstable model is not declared any more.
    assert_eq!(
        runtime
            .set_setting(&key, &value("model", "nous:hermes-5"))
            .await,
        Err(AgentRuntimeError::SettingRefused {
            setting: "model".into(),
            value: "nous:hermes-5".into(),
            reason: SettingRefusal::NotDeclared,
        })
    );
    agent.silent().await;
}

#[tokio::test]
async fn a_config_option_update_keeps_the_unstable_model() {
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
            let mut declared = hermes_settings("nous:hermes-5");
            declared.as_object_mut().unwrap().remove("modes");
            agent.reply(&new_session, declared).await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "config_option_update", "configOptions": [{
                "id": "fast", "name": "Fast", "type": "select", "currentValue": "off",
                "options": [{ "value": "off", "name": "Off" }, { "value": "on", "name": "On" }]
            }] }),
        )
        .await;
    follow(&mut subscription, |snapshot| {
        let ids: Vec<_> = snapshot.settings.iter().map(|s| s.id.as_str()).collect();
        ids == ["model", "fast"]
    })
    .await;
}

#[tokio::test]
async fn an_agent_without_draft_evidence_gets_no_draft_session() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached(&runtime);
    let (draft, ()) = tokio::join!(
        runtime.new_draft_session(id, Path::new("/project")),
        agent.initialize(json!({}))
    );
    assert_eq!(draft, Err(AgentRuntimeError::DraftUnsupported));
    agent.silent().await;

    // A draft that must be deleted needs the agent's `session/delete`.
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (draft, ()) = tokio::join!(
        runtime.new_draft_session(id, Path::new("/project")),
        agent.initialize(json!({ "sessionCapabilities": { "close": {} } }))
    );
    assert_eq!(draft, Err(AgentRuntimeError::DraftUnsupported));
    agent.silent().await;
}

#[tokio::test]
async fn a_draft_without_a_prompt_is_deleted_on_release() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "close": {}, "delete": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
        }
    );
    // Kept until deleted, in case the app ends first.
    assert_eq!(host.last_pending(), [pending("s1")]);
    let (released, ()) = tokio::join!(runtime.release_session(&key), async {
        let close = agent.expect("session/close").await;
        agent.reply(&close, json!({})).await;
        let delete = agent.expect("session/delete").await;
        assert_eq!(delete["params"], json!({ "sessionId": "s1" }));
        agent.reply(&delete, json!({})).await;
    });
    released.unwrap();
    assert!(host.last_pending().is_empty());
    agent.silent().await;
}

#[tokio::test]
async fn a_failed_deletion_stays_pending() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
        }
    );
    let (released, ()) = tokio::join!(runtime.release_session(&key), async {
        let delete = agent.expect("session/delete").await;
        // The agent's process is gone before it answers.
        drop(delete);
        agent.output.shutdown().await.unwrap();
    });
    released.unwrap();
    assert_eq!(host.last_pending(), [pending("s1")]);
}

#[tokio::test]
async fn a_prompted_draft_is_the_users_session_and_is_not_deleted() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
        }
    );
    let mut subscription = runtime.subscribe(&key).unwrap();
    runtime
        .prompt(&key, &[PromptPart::Text { text: "hi".into() }])
        .unwrap();
    assert!(host.last_pending().is_empty());
    let prompt = agent.expect("session/prompt").await;
    agent
        .reply(&prompt, json!({ "stopReason": "end_turn" }))
        .await;
    follow(&mut subscription, idle).await;
    runtime.release_session(&key).await.unwrap();
    agent.silent().await;
}

#[tokio::test]
async fn pending_deletions_run_when_the_agent_connects_again() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, vec![pending("old"), pending("gone")]);
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (checked, ()) = tokio::join!(runtime.new_session(id, Path::new("/project"), &[]), async {
        agent
            .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
            .await;
        // The deletions run beside the connection's own work.
        let mut deleted = Vec::new();
        let mut new_session = None;
        while deleted.len() < 2 || new_session.is_none() {
            let message = agent.recv().await;
            match message["method"].as_str() {
                Some("session/delete") => {
                    let id = message["params"]["sessionId"].as_str().unwrap().to_string();
                    if id == "gone" {
                        // The agent no longer knows it: it leaves the list too.
                        agent
                            .send(json!({
                                "jsonrpc": "2.0", "id": message["id"],
                                "error": { "code": -32602, "message": "unknown session" }
                            }))
                            .await;
                    } else {
                        agent.reply(&message, json!({})).await;
                    }
                    deleted.push(id);
                }
                Some("session/new") => {
                    agent.reply(&message, json!({ "sessionId": "s1" })).await;
                    new_session = Some(());
                }
                other => panic!("unexpected message {other:?}"),
            }
        }
        deleted.sort();
        assert_eq!(deleted, ["gone", "old"]);
    });
    checked.unwrap();
    for _ in 0..50 {
        if host.last_pending().is_empty() && !host.pending.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(host.last_pending().is_empty());
}

#[tokio::test]
async fn a_draft_this_runtime_serves_is_not_deleted_by_another_connection() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (_key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
        }
    );
    assert_eq!(host.last_pending(), [pending("s1")]);
    // A Routine launch connects the same agent meanwhile.
    let (other, mut second) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let (listed, ()) = tokio::join!(
        runtime.new_session(other, Path::new("/project"), &[]),
        async {
            second
                .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
                .await;
            let new_session = second.expect("session/new").await;
            second
                .reply(&new_session, json!({ "sessionId": "s2" }))
                .await;
        }
    );
    listed.unwrap();
    second.silent().await;
    assert_eq!(host.last_pending(), [pending("s1")]);
}

#[tokio::test]
async fn a_refused_value_deletes_the_new_session_of_an_agent_with_deleted_drafts() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Deleted));
    let missing = [value("model", "missing")];
    let (created, ()) = tokio::join!(
        runtime.new_session(id, Path::new("/project"), &missing),
        async {
            agent
                .initialize(json!({ "sessionCapabilities": { "delete": {} } }))
                .await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, json!({ "sessionId": "s1" }))
                .await;
            let delete = agent.expect("session/delete").await;
            assert_eq!(delete["params"], json!({ "sessionId": "s1" }));
            agent.reply(&delete, json!({})).await;
        }
    );
    assert!(matches!(
        created,
        Err(AgentRuntimeError::SettingRefused { .. })
    ));
    assert!(host.last_pending().is_empty());
}

#[tokio::test]
async fn a_draft_with_fixed_values_takes_them_only_with_the_first_prompt() {
    let runtime = AgentRuntime::default();
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::FixedValues));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent.reply(&new_session, mode_settings("agent")).await;
        }
    );
    // Any change before the prompt would list the session in the agent.
    assert_eq!(
        runtime.set_setting(&key, &approval("read-only")).await,
        Err(AgentRuntimeError::SettingRefused {
            setting: "mode".into(),
            value: "read-only".into(),
            reason: SettingRefusal::BeforeFirstPrompt,
        })
    );
    agent.silent().await;
    let values = [approval("agent"), approval("read-only")];
    let (applied, ()) = tokio::join!(
        runtime.apply_before_first_prompt(&key, &values[1..]),
        async {
            let set = agent.expect("session/set_config_option").await;
            assert_eq!(set["params"]["value"], "read-only");
            let mut confirmed = mode_settings("read-only");
            confirmed.as_object_mut().unwrap().remove("sessionId");
            agent.reply(&set, confirmed).await;
        }
    );
    applied.unwrap();
    // A value the session already has is not sent again.
    runtime
        .apply_before_first_prompt(&key, &[approval("read-only")])
        .await
        .unwrap();
    agent.silent().await;
}

#[tokio::test]
async fn every_declaration_is_kept_per_agent_and_model() {
    let runtime = AgentRuntime::default();
    let host = hosted(&runtime, Vec::new());
    let (id, mut agent) = attached_with(&runtime, &drafting(DraftSession::Traceless));
    let (key, ()) = tokio::join!(
        async {
            runtime
                .new_draft_session(id, Path::new("/project"))
                .await
                .unwrap()
        },
        async {
            agent.initialize(json!({})).await;
            let new_session = agent.expect("session/new").await;
            agent
                .reply(&new_session, hermes_settings("openai-codex:gpt-6"))
                .await;
        }
    );
    let declared = runtime.last_declarations("scripted");
    assert_eq!(declared.len(), 1);
    assert_eq!(declared[0].model.as_deref(), Some("openai-codex:gpt-6"));
    assert_eq!(declared[0].agent_version.as_deref(), Some("1.0.0"));
    assert_eq!(declared[0].settings.len(), 2);

    // The draft applies another model: its declaration is kept too.
    let model = value("model", "nous:hermes-5");
    let (changed, ()) = tokio::join!(runtime.set_setting(&key, &model), async {
        let set = agent.expect("session/set_model").await;
        agent.reply(&set, json!({})).await;
    });
    changed.unwrap();
    let declared = runtime.last_declarations("scripted");
    let models: Vec<_> = declared.iter().map(|d| d.model.as_deref()).collect();
    assert_eq!(models.len(), 2);
    assert!(models.contains(&Some("nous:hermes-5")));
    assert_eq!(host.declarations.lock().unwrap().len(), 2);

    // An update the agent sends in any session is a declaration as well.
    agent
        .update(
            "s1",
            json!({ "sessionUpdate": "current_mode_update", "currentModeId": "accept_edits" }),
        )
        .await;
    let mut subscription = runtime.subscribe(&key).unwrap();
    follow(&mut subscription, |snapshot| {
        snapshot.settings[1].current_value == "accept_edits"
    })
    .await;
    for _ in 0..50 {
        let kept = runtime
            .last_declarations("scripted")
            .into_iter()
            .any(|declared| {
                declared.model.as_deref() == Some("nous:hermes-5")
                    && declared.settings[1].current_value == "accept_edits"
            });
        if kept {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the mode update was not kept");
}
