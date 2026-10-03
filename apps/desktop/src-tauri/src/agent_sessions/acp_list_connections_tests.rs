use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use svode_agents::activity::ConnectionState;
use svode_agents::adapters::LaunchUnavailable;
use svode_agents::catalog::ListBounds;
use svode_agents::{AcpLaunch, AgentCheck, AgentRuntime, RuntimeConfig};
use svode_core::agent_adapters::AgentAdapterKind;
use tauri::async_runtime::JoinHandle;

use super::*;
use crate::agent_runtime::connections::{AgentConnections, LaunchPlanner, PlanFuture};

/// A `/bin/sh` ACP agent that declares `session/list` and answers it by
/// `$SVODE_LIST`: `ok` with one session, `error`, or `hang`; with `none` it
/// declares no list.
fn scripted(agent: &str, list: &str) -> AcpLaunch {
    const SCRIPT: &str = r#"while IFS= read -r line; do
  id=${line#'{"id":'}; id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*) caps='{"sessionCapabilities":{"list":{}}}'; [ "$SVODE_LIST" = none ] && caps='{}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":%s,"agentInfo":{"name":"scripted","version":"1.0.0"}}}\n' "$id" "$caps";;
    *'"method":"session/list"'*) case "$SVODE_LIST" in
      ok) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessions":[{"sessionId":"s1","cwd":"/work","title":"first","updatedAt":"2026-10-02T10:00:00Z"}]}}\n' "$id";;
      error) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"list failed"}}\n' "$id";;
    esac;;
  esac
done"#;
    AcpLaunch {
        agent: agent.into(),
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), SCRIPT.into()],
        environment: None,
        env: BTreeMap::from([("SVODE_LIST".into(), list.into())]),
        cwd: std::env::temp_dir(),
        acp_id_is_native: false,
        lists_catalog: true,
        read_only_open: false,
        writer_refusal: None,
    }
}

struct ScriptedPlanner(Vec<(&'static str, Result<AcpLaunch, LaunchUnavailable>)>);

impl LaunchPlanner for ScriptedPlanner {
    fn catalog_agents(&self) -> Vec<String> {
        self.0.iter().map(|(agent, _)| agent.to_string()).collect()
    }

    fn plan<'a>(&'a self, agent: &'a str) -> PlanFuture<'a> {
        let plan = self
            .0
            .iter()
            .find(|(known, _)| *known == agent)
            .map(|(_, plan)| plan.clone())
            .unwrap_or(Err(LaunchUnavailable::NotSupported));
        Box::pin(async move { plan })
    }

    fn plan_draft<'a>(
        &'a self,
        agent: Option<&'a str>,
        _definition: svode_agents::custom::CustomAgentDefinition,
    ) -> PlanFuture<'a> {
        self.plan(agent.unwrap_or("draft"))
    }
}

fn runtime() -> AgentRuntime {
    AgentRuntime::new(RuntimeConfig {
        request_timeout: Duration::from_secs(2),
        connection_idle: Duration::from_millis(100),
        list: ListBounds {
            timeout: Duration::from_millis(300),
            ..ListBounds::default()
        },
        ..RuntimeConfig::default()
    })
}

fn owner(
    runtime: &AgentRuntime,
    plans: Vec<(&'static str, Result<AcpLaunch, LaunchUnavailable>)>,
) -> (Arc<AgentConnections>, Arc<AcpListSources>) {
    (
        Arc::new(AgentConnections::new(
            runtime.clone(),
            ScriptedPlanner(plans),
        )),
        Arc::new(AcpListSources::default()),
    )
}

async fn settle(tasks: Vec<JoinHandle<()>>) {
    for task in tasks {
        task.await.unwrap();
    }
}

fn open_agents(runtime: &AgentRuntime) -> Vec<String> {
    runtime
        .catalog_connections()
        .into_iter()
        .map(|connection| connection.agent)
        .collect()
}

fn status(sources: &AcpListSources, source: AgentId) -> (AgentSessionSourceStatus, usize) {
    let read = sources
        .reads()
        .into_iter()
        .find(|read| read.source == source)
        .expect("the agent's list was read");
    (read.report.status, read.sessions.len())
}

#[tokio::test]
async fn an_open_collection_starts_its_agents_and_after_it_closes_they_idle_out() {
    let runtime = runtime();
    let (connections, sources) = owner(&runtime, vec![("codex", Ok(scripted("codex", "ok")))]);

    // Without an open collection a refresh starts nothing.
    settle(sources.raise(&connections, &runtime)).await;
    assert!(open_agents(&runtime).is_empty());

    let hold = connections.hold_catalog("main");
    settle(sources.raise(&connections, &runtime)).await;
    assert_eq!(open_agents(&runtime), ["codex"]);
    assert_eq!(
        status(&sources, AgentAdapterKind::Codex.id()),
        (AgentSessionSourceStatus::Ok, 1)
    );

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        open_agents(&runtime),
        ["codex"],
        "an open collection keeps it"
    );

    connections.release_catalog(hold);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(open_agents(&runtime).is_empty());
    // Closing an idle connection is normal: the last list stays, not stale.
    assert_eq!(
        status(&sources, AgentAdapterKind::Codex.id()),
        (AgentSessionSourceStatus::Ok, 1)
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn only_a_boundary_with_an_open_collection_restarts_a_lost_connection() {
    let runtime = runtime();
    let (connections, sources) = owner(&runtime, vec![("codex", Ok(scripted("codex", "ok")))]);
    let hold = connections.hold_catalog("main");
    settle(sources.raise(&connections, &runtime)).await;
    let lost = runtime.catalog_connections()[0].connection;
    runtime.close_connection(lost).await.unwrap();

    // A poll reads live connections only.
    settle(sources.refresh(&runtime)).await;
    assert!(open_agents(&runtime).is_empty());

    // Refresh or the window's return to the foreground with the collection open.
    settle(sources.raise(&connections, &runtime)).await;
    assert_eq!(open_agents(&runtime), ["codex"]);
    assert_ne!(runtime.catalog_connections()[0].connection, lost);

    connections.release_catalog(hold);
    let reopened = runtime.catalog_connections()[0].connection;
    runtime.close_connection(reopened).await.unwrap();
    settle(sources.raise(&connections, &runtime)).await;
    assert!(open_agents(&runtime).is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_failing_or_slow_list_marks_only_its_own_source_stale() {
    for failing in ["error", "hang"] {
        let runtime = runtime();
        let (connections, sources) = owner(
            &runtime,
            vec![
                ("codex", Ok(scripted("codex", failing))),
                ("claude-code", Ok(scripted("claude-code", "ok"))),
            ],
        );
        connections.hold_catalog("main");
        settle(sources.raise(&connections, &runtime)).await;

        assert_eq!(
            status(&sources, AgentAdapterKind::Codex.id()),
            (AgentSessionSourceStatus::Stale, 0),
            "{failing}"
        );
        assert_eq!(
            status(&sources, AgentAdapterKind::ClaudeCode.id()),
            (AgentSessionSourceStatus::Ok, 1),
            "{failing}"
        );
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn an_unavailable_agent_is_never_started() {
    let runtime = runtime();
    let (connections, sources) = owner(
        &runtime,
        vec![
            ("codex", Err(LaunchUnavailable::Disabled)),
            ("claude-code", Err(LaunchUnavailable::AdapterNotInstalled)),
        ],
    );
    connections.hold_catalog("main");
    settle(sources.raise(&connections, &runtime)).await;
    assert!(open_agents(&runtime).is_empty());
    assert!(sources.reads().is_empty());
    assert_eq!(
        connections.check("codex").await,
        AgentCheck::Unavailable {
            reason: LaunchUnavailable::Disabled
        }
    );
}

#[tokio::test]
async fn a_check_starts_initializes_and_closes_unless_a_collection_keeps_the_agent() {
    let runtime = runtime();
    let (connections, sources) = owner(&runtime, vec![("codex", Ok(scripted("codex", "ok")))]);

    let AgentCheck::Ready { agent } = connections.check("codex").await else {
        panic!("the agent starts");
    };
    assert_eq!(agent.name.as_deref(), Some("scripted"));
    assert!(open_agents(&runtime).is_empty(), "closed right after");

    connections.hold_catalog("main");
    settle(sources.raise(&connections, &runtime)).await;
    let open = runtime.catalog_connections()[0].connection;
    assert!(matches!(
        connections.check("codex").await,
        AgentCheck::Ready { .. }
    ));
    assert_eq!(
        runtime.connection_status(open).unwrap().state,
        ConnectionState::Ready
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_reloading_webview_releases_only_its_own_collections() {
    let runtime = runtime();
    let (connections, sources) = owner(&runtime, vec![("codex", Ok(scripted("codex", "ok")))]);
    connections.hold_catalog("main");
    connections.hold_catalog("project-2");
    settle(sources.raise(&connections, &runtime)).await;

    connections.release_webview("main");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(open_agents(&runtime), ["codex"]);

    connections.release_webview("project-2");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(open_agents(&runtime).is_empty());
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_custom_agent_lists_under_its_own_id_and_one_without_a_list_starts_once() {
    let runtime = runtime();
    let (connections, sources) = owner(
        &runtime,
        vec![
            ("custom-lister", Ok(scripted("custom-lister", "ok"))),
            ("custom-plain", Ok(scripted("custom-plain", "none"))),
        ],
    );
    connections.hold_catalog("main");
    settle(sources.raise(&connections, &runtime)).await;

    let lister = AgentId::parse("custom-lister").unwrap();
    assert_eq!(
        status(&sources, lister.clone()),
        (AgentSessionSourceStatus::Ok, 1)
    );
    let read = sources
        .reads()
        .into_iter()
        .find(|read| read.source == lister)
        .unwrap();
    assert_eq!(
        read.sessions[0].key,
        svode_agents::identity::SessionKey::from_acp("custom-lister", "s1", false),
        "its own namespace, never merged with a built-in agent"
    );
    // Without a declared list the agent is no source, not stale, and an
    // open collection does not start it again.
    assert!(
        sources
            .reads()
            .iter()
            .all(|read| read.source.as_str() != "custom-plain")
    );
    assert_eq!(connections.held_catalog_agents(), ["custom-lister"]);

    // A removed agent is neither read nor shown while its connection lives,
    // and is read again once added back under the same id.
    sources.forget("custom-lister");
    settle(sources.refresh(&runtime)).await;
    assert!(sources.reads().is_empty());
    sources.remember("custom-lister");
    settle(sources.refresh(&runtime)).await;
    assert_eq!(status(&sources, lister), (AgentSessionSourceStatus::Ok, 1));
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_draft_check_starts_the_command_and_reports_what_it_declares() {
    let runtime = runtime();
    let (connections, _) = owner(
        &runtime,
        vec![("custom-draft", Ok(scripted("custom-draft", "none")))],
    );
    let definition = svode_agents::custom::CustomAgentDefinition {
        name: "Draft".into(),
        command: "/bin/sh".into(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    let AgentCheck::Ready { agent } = connections
        .check_draft(Some("custom-draft"), definition)
        .await
    else {
        panic!("the draft starts");
    };
    assert!(!agent.capabilities.list_sessions);
    assert!(open_agents(&runtime).is_empty(), "closed right after");
    assert_eq!(
        runtime
            .declared("custom-draft")
            .map(|info| info.capabilities.list_sessions),
        Some(false)
    );
}

#[test]
fn an_open_collection_keeps_codex_and_claude_code_for_their_acp_lists() {
    let dir = tempfile::tempdir().unwrap();
    let setup = crate::agent_setup::AgentSetupState::new(dir.path(), dir.path().to_path_buf());
    assert_eq!(setup.catalog_agents(), ["codex", "claude-code"]);
}

#[tokio::test]
async fn the_desktop_planner_refuses_a_disabled_or_unknown_agent() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("agents.json"),
        r#"{"agents":{"codex":{"enabled":false}}}"#,
    )
    .unwrap();
    let setup = crate::agent_setup::AgentSetupState::new(dir.path(), dir.path().to_path_buf());
    assert_eq!(setup.plan("codex").await, Err(LaunchUnavailable::Disabled));
    assert_eq!(
        setup.plan("future-agent").await,
        Err(LaunchUnavailable::NotSupported)
    );
}

/// Live acceptance of slice 2.8 on the user's real stores: an open
/// collection starts Codex and Claude Code with the pinned adapters and the
/// user's CLIs; the catalogue of the project in `SVODE_LIVE_PROJECT` is their
/// ACP lists alone, one session per key, with status from the native reader;
/// a new app process shows the saved lists before any connection opens; no
/// adapter process is left. Lists only: no session is created, loaded or
/// prompted.
#[tokio::test]
#[ignore = "live: downloads the pinned adapters from npm and lists the user's Codex and Claude Code sessions"]
async fn live_the_acp_lists_are_the_catalogue_with_native_status() {
    use std::collections::{BTreeMap, HashSet};

    use crate::agent_sessions::read_model::list_sessions;
    use crate::agent_sessions::types::AgentSessionsCacheMode;

    let project = std::env::var("SVODE_LIVE_PROJECT").expect("SVODE_LIVE_PROJECT");
    let cache = crate::agent_sessions::cache::cache_db_path(&PathBuf::from(&project));
    let cache_existed = cache.exists();
    let dir = tempfile::tempdir().unwrap();
    let setup = crate::agent_setup::live_setup_with_pinned_adapters(dir.path()).await;
    let runtime = AgentRuntime::default();
    let connections = Arc::new(AgentConnections::new(runtime.clone(), setup));
    let state = crate::agent_sessions::AgentSessionsState::new();

    connections.hold_catalog("live");
    let started = std::time::Instant::now();
    settle(state.acp_lists.raise(&connections, &runtime)).await;
    println!("raise and list: {:?}", started.elapsed());

    let list = |state: &crate::agent_sessions::AgentSessionsState| {
        let (state, project) = (state.clone(), project.clone());
        async move {
            let started = std::time::Instant::now();
            let result =
                tokio::task::spawn_blocking(move || list_sessions(&state, project, Vec::new()))
                    .await
                    .unwrap()
                    .unwrap();
            (result, started.elapsed())
        }
    };
    let (cold, cold_took) = list(&state).await;
    let (warm, warm_took) = list(&state).await;
    println!("catalogue with native status: cold {cold_took:?}, warm {warm_took:?}");

    let mut ids = HashSet::new();
    for session in &warm.sessions {
        assert!(ids.insert(&session.id), "duplicate {}", session.id);
        assert!(
            !session.id.contains(":acp:"),
            "listed ids join the native namespace"
        );
    }
    for source in [
        AgentAdapterKind::Codex.id(),
        AgentAdapterKind::ClaudeCode.id(),
    ] {
        let report = warm
            .sources
            .iter()
            .find(|report| report.source == source)
            .expect("the agent's ACP list was read");
        assert_eq!(report.status, AgentSessionSourceStatus::Ok);
        let mut states = BTreeMap::new();
        for session in warm
            .sessions
            .iter()
            .filter(|session| session.source == source)
        {
            *states
                .entry(format!(
                    "{:?}/{:?}",
                    session.status.state, session.status.source
                ))
                .or_insert(0usize) += 1;
        }
        println!(
            "{source:?}: listed {} in {} ms, returned {}, unresolved {}; status {states:?}",
            report.counts.candidates,
            report.duration_ms.unwrap_or_default(),
            report.counts.returned_sessions,
            report.counts.unresolved_candidates,
        );
        assert!(report.counts.returned_sessions > 0);
    }
    println!("sessions of the project: {}", warm.sessions.len());
    assert_eq!(cold.sessions.len(), warm.sessions.len());

    let restarted = crate::agent_sessions::AgentSessionsState::new();
    let (saved, saved_took) = list(&restarted).await;
    println!("new process before any connection: {saved_took:?}");
    assert_eq!(saved.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
    assert_eq!(saved.sessions.len(), warm.sessions.len());

    connections.release_webview("live");
    runtime.shutdown().await;
    if !cache_existed {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", cache.display()));
        }
        // Only an empty `.svode` this run created goes.
        let _ = std::fs::remove_dir(cache.parent().unwrap());
    }
    let left = std::process::Command::new("pgrep")
        .args(["-f", &dir.path().to_string_lossy()])
        .output()
        .unwrap();
    assert!(
        left.stdout.is_empty(),
        "adapter processes left: {}",
        String::from_utf8_lossy(&left.stdout)
    );
}
