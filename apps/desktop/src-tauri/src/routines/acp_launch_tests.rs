use std::collections::BTreeMap;
use std::time::Duration;

use svode_agents::RuntimeConfig;
use svode_core::agent_adapters::AgentAdapterKind;
use svode_core::routines::model::{
    RoutineLiveEvidence, RoutineRunRecord, RoutineRunTerminalStatus,
};
use svode_core::routines::operational::latest_run_record;
use svode_core::routines::store_state::RoutineStoreState;
use tempfile::{TempDir, tempdir};

use super::*;

/// A `/bin/sh` ACP agent. `$SVODE_MODE` `refuse` refuses every setting;
/// `$SVODE_PROMPT` `end` ends a turn at once, `hang` keeps it running until
/// `session/cancel`.
fn scripted(mode: &str, prompt: &str) -> AcpLaunch {
    const SCRIPT: &str = r#"options='"options":[{"value":"workspace-write","name":"Ask"},{"value":"agent","name":"Auto"}]'
while IFS= read -r line; do
  id=${line#'{"id":'}; id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"scripted","version":"1.0.0"}}}\n' "$id";;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s1","configOptions":[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"agent",%s}]}}\n' "$id" "$options";;
    *'"method":"session/set_config_option"'*)
      value=${line#*'"value":"'}; value=${value%%'"'*}
      if [ "$SVODE_MODE" = refuse ]; then
        printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"mode refused"}}\n' "$id"
      else
        printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"%s",%s}]}}\n' "$id" "$value" "$options"
      fi;;
    *'"method":"session/prompt"'*)
      prompt_id=$id
      [ "$SVODE_PROMPT" = end ] && printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id";;
    *'"method":"session/cancel"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"cancelled"}}\n' "$prompt_id";;
  esac
done"#;
    AcpLaunch {
        agent: "codex".into(),
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), SCRIPT.into()],
        environment: None,
        env: BTreeMap::from([
            ("SVODE_MODE".into(), mode.into()),
            ("SVODE_PROMPT".into(), prompt.into()),
        ]),
        cwd: std::env::temp_dir(),
        acp_id_is_native: true,
        lists_catalog: false,
        read_only_open: false,
        writer_refusal: None,
        session_per_connection: false,
        draft_session: false,
    }
}

struct Fixture {
    temp: TempDir,
    pool: SqlitePool,
    sink: Arc<RoutineRunLifecycleSink>,
    runtime: AgentRuntime,
    launches: RoutineAcpLaunches,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".svode")).unwrap();
        let key = crate::index::IndexKey::Root(temp.path().to_path_buf());
        let store = Arc::new(RoutineStoreState::new());
        let pool = store.get_or_create(&key, temp.path()).await.unwrap();
        let sink = Arc::new(RoutineRunLifecycleSink::new(
            pool.clone(),
            store,
            key,
            temp.path().to_path_buf(),
            "run-one".into(),
        ));
        let runtime = AgentRuntime::new(RuntimeConfig {
            request_timeout: Duration::from_secs(2),
            ..RuntimeConfig::default()
        });
        Self {
            launches: RoutineAcpLaunches::new(runtime.clone()),
            temp,
            pool,
            sink,
            runtime,
        }
    }

    async fn start(
        &self,
        launch: AcpLaunch,
        token: &str,
    ) -> Result<RoutineDispatchResult, AcpStartFailure> {
        self.launches
            .start(AcpRun {
                pool: &self.pool,
                new_run: NewRoutineRun {
                    routine_run_id: "run-one",
                    routine_id: "routine-one",
                    owner_path: ".",
                    trigger_type: "schedule",
                    definition_fingerprint: "fingerprint",
                    definition_json: "{}",
                    launch_id: "launch-one",
                    source: "codex",
                    source_session_id: None,
                    agent_session_id: "",
                    created_at: "2026-10-05T10:00:00Z",
                    launch: &RoutineRunLaunch::Acp,
                },
                source: AgentAdapterKind::Codex.id(),
                launch,
                cwd: self.temp.path(),
                settings: vec![SettingValue {
                    setting: "mode".into(),
                    value: "workspace-write".into(),
                }],
                prompt: "Review the backlog".into(),
                token: token.into(),
                project_path: self.temp.path(),
                sink: self.sink.clone(),
            })
            .await
    }

    async fn run(&self) -> Option<RoutineRunRecord> {
        latest_run_record(&self.pool, ".", "routine-one")
            .await
            .unwrap()
    }

    /// Waits for the run to reach `done` through the watcher.
    async fn run_until(&self, done: impl Fn(&RoutineRunRecord) -> bool) -> RoutineRunRecord {
        for _ in 0..200 {
            if let Some(run) = self.run().await.filter(|run| done(run)) {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the run did not reach the state: {:?}", self.run().await);
    }

    fn connection(&self) -> ConnectionId {
        self.launches.live.lock().unwrap()["run-one"].connection
    }
}

fn before_prompt(result: Result<RoutineDispatchResult, AcpStartFailure>) -> String {
    match result {
        Err(AcpStartFailure::BeforePrompt(detail)) => detail,
        Err(AcpStartFailure::Failed(error)) => panic!("failed: {error}"),
        Ok(result) => panic!("started: {result:?}"),
    }
}

#[tokio::test]
async fn an_acp_launch_records_its_run_and_its_writer_and_token_live_with_the_connection() {
    let fixture = Fixture::new().await;
    let started = fixture
        .start(scripted("ok", "hang"), "token-one")
        .await
        .unwrap_or_else(|_| panic!("the ACP launch did not start"));
    let RoutineDispatchResult::Started {
        agent_session_id,
        source_session_id,
        pty_id,
        ..
    } = started
    else {
        panic!("not started: {started:?}");
    };
    assert_eq!(agent_session_id, "codex:s1");
    assert_eq!(source_session_id.as_deref(), Some("s1"));
    assert_eq!(pty_id, None);

    // The run has the canonical id from the creation of the session.
    let run = fixture
        .run_until(|run| run.session_status.as_deref() == Some("active"))
        .await;
    assert_eq!(run.launch, RoutineRunLaunch::Acp);
    assert_eq!(run.source_session_id.as_deref(), Some("s1"));
    assert_eq!(run.agent_session_id, "codex:s1");
    assert_eq!(run.pty_id, None);

    let session = SessionKey::from_acp("codex", "s1", true);
    assert_eq!(
        fixture.runtime.writers().writer(&session),
        Some(Writer::Acp)
    );
    let live = super::super::runtime::live_evidence(
        &crate::terminal::TerminalManager::new(fixture.runtime.writers()),
        &fixture.launches,
    )
    .unwrap();
    assert!(run.blocks_relaunch(&live));

    let project = fixture.temp.path();
    assert_eq!(
        fixture.launches.resolve_caller("token-one", project),
        Some(svode_tools::host::RoutineCaller::Launch {
            routine_run_id: "run-one".into(),
            launch_id: "launch-one".into(),
            pty_id: None,
        })
    );
    let other_project = tempdir().unwrap();
    assert_eq!(
        fixture
            .launches
            .resolve_caller("token-one", other_project.path()),
        None
    );
    assert_eq!(fixture.launches.resolve_caller("token-two", project), None);
    // The launch's provenance is its own: the agent's plan without it gets
    // another connection.
    let plain = fixture
        .runtime
        .acquire(scripted("ok", "hang"))
        .await
        .unwrap();
    assert_ne!(plain.connection(), fixture.connection());

    // The connection ends after the first prompt: the turn is interrupted,
    // the run stops and nothing starts again.
    fixture
        .runtime
        .close_connection(fixture.connection())
        .await
        .unwrap();
    let run = fixture.run_until(|run| run.terminal_status.is_some()).await;
    assert_eq!(run.terminal_status, Some(RoutineRunTerminalStatus::Stopped));
    assert_eq!(fixture.launches.resolve_caller("token-one", project), None);
    assert!(fixture.launches.live_run_ids().is_empty());
    assert!(!run.blocks_relaunch(&RoutineLiveEvidence::default()));
}

#[tokio::test]
async fn a_finished_turn_is_the_runs_outcome() {
    let fixture = Fixture::new().await;
    assert!(
        fixture
            .start(scripted("ok", "end"), "token-one")
            .await
            .is_ok()
    );
    let run = fixture.run_until(|run| run.terminal_status.is_some()).await;
    assert_eq!(run.terminal_status, Some(RoutineRunTerminalStatus::Done));
    assert_eq!(
        run.terminal_reason.as_deref(),
        Some("ACP turn ended: end_turn")
    );
    assert_eq!(run.session_status, None);
}

#[tokio::test]
async fn a_refused_mode_fails_before_the_prompt_and_frees_the_launch() {
    let fixture = Fixture::new().await;
    let detail = before_prompt(fixture.start(scripted("refuse", "end"), "token-one").await);
    assert!(detail.contains("mode refused"), "{detail}");
    assert!(fixture.run().await.is_none());
    let writers = fixture.runtime.writers();
    assert_eq!(
        writers.writer(&SessionKey::from_acp("codex", "s1", true)),
        None
    );
    // The terminal of the same binding takes the same launch.
    assert!(writers.claim_launch("launch-one", Writer::Pty).is_ok());
    assert_eq!(
        fixture
            .launches
            .resolve_caller("token-one", fixture.temp.path()),
        None
    );
}

#[tokio::test]
async fn a_connection_that_does_not_start_fails_before_the_prompt() {
    let fixture = Fixture::new().await;
    let mut launch = scripted("ok", "end");
    launch.program = PathBuf::from("/nonexistent/agent");
    before_prompt(fixture.start(launch, "token-one").await);
    assert!(fixture.run().await.is_none());
    assert!(
        fixture
            .runtime
            .writers()
            .claim_launch("launch-one", Writer::Pty)
            .is_ok()
    );
}
