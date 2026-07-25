use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use tokio::sync::{Mutex, Semaphore, watch};

use super::types::AgentSessionsListResult;
use crate::error::AppError;

const MAX_CONCURRENT_AGENT_SESSION_READS: usize = 1;

type SharedRefreshResult = Result<AgentSessionsListResult, String>;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum AgentSessionsReadKind {
    Discovery,
    FullRefresh,
}

impl AgentSessionsReadKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::FullRefresh => "full-refresh",
        }
    }

    fn is_full_refresh(self) -> bool {
        matches!(self, Self::FullRefresh)
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct RefreshFlightKey {
    project_key: String,
    kind: AgentSessionsReadKind,
}

#[derive(Clone)]
enum RefreshFlightState {
    Pending,
    Finished(SharedRefreshResult),
}

struct RefreshFlight {
    id: u64,
    receiver: watch::Receiver<RefreshFlightState>,
}

struct RefreshCoordinatorInner {
    flights: Mutex<HashMap<RefreshFlightKey, RefreshFlight>>,
    global_permits: Semaphore,
    next_flight_id: AtomicU64,
    active_reads: AtomicUsize,
    active_full_refreshes: AtomicUsize,
    queued_reads: AtomicUsize,
    coalesced_reads: AtomicU64,
}

#[derive(Clone)]
pub(crate) struct AgentSessionsReadCoordinator {
    inner: Arc<RefreshCoordinatorInner>,
}

impl Default for AgentSessionsReadCoordinator {
    fn default() -> Self {
        Self {
            inner: Arc::new(RefreshCoordinatorInner {
                flights: Mutex::new(HashMap::new()),
                global_permits: Semaphore::new(MAX_CONCURRENT_AGENT_SESSION_READS),
                next_flight_id: AtomicU64::new(1),
                active_reads: AtomicUsize::new(0),
                active_full_refreshes: AtomicUsize::new(0),
                queued_reads: AtomicUsize::new(0),
                coalesced_reads: AtomicU64::new(0),
            }),
        }
    }
}

impl AgentSessionsReadCoordinator {
    pub(crate) async fn run<F>(
        &self,
        project_key: String,
        kind: AgentSessionsReadKind,
        reason: &'static str,
        task: F,
    ) -> Result<AgentSessionsListResult, AppError>
    where
        F: FnOnce() -> Result<AgentSessionsListResult, AppError> + Send + 'static,
    {
        let mut task = Some(task);
        let flight_key = RefreshFlightKey { project_key, kind };
        let (mut receiver, worker) = {
            let mut flights = self.inner.flights.lock().await;
            let coalesced_key = if flights.contains_key(&flight_key) {
                Some(flight_key.clone())
            } else if matches!(kind, AgentSessionsReadKind::Discovery) {
                let full_refresh_key = RefreshFlightKey {
                    project_key: flight_key.project_key.clone(),
                    kind: AgentSessionsReadKind::FullRefresh,
                };
                flights
                    .contains_key(&full_refresh_key)
                    .then_some(full_refresh_key)
            } else {
                None
            };

            if let Some(coalesced_key) = coalesced_key {
                let flight = flights.get(&coalesced_key).ok_or_else(|| {
                    AppError::General(
                        "Agent sessions coalesced read flight disappeared".to_string(),
                    )
                })?;
                let coalesced = self.inner.coalesced_reads.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::info!(
                    target: "svode::agent_sessions",
                    event = "agent_sessions_read_coalesced",
                    project_path = %flight_key.project_key,
                    requested_operation = kind.as_str(),
                    joined_operation = coalesced_key.kind.as_str(),
                    flight_id = flight.id,
                    active_agent_session_reads = self.inner.active_reads.load(Ordering::Relaxed),
                    active_full_refreshes = self.inner.active_full_refreshes.load(Ordering::Relaxed),
                    queued_agent_session_reads = self.inner.queued_reads.load(Ordering::Relaxed),
                    coalesced_agent_session_reads = coalesced,
                    reason,
                );
                (flight.receiver.clone(), None)
            } else {
                let flight_id = self.inner.next_flight_id.fetch_add(1, Ordering::Relaxed);
                let (sender, receiver) = watch::channel(RefreshFlightState::Pending);
                let leader_task = task.take().ok_or_else(|| {
                    AppError::General(
                        "Agent sessions read leader has no task to execute".to_string(),
                    )
                })?;
                flights.insert(
                    flight_key.clone(),
                    RefreshFlight {
                        id: flight_id,
                        receiver: receiver.clone(),
                    },
                );
                (receiver, Some((flight_id, sender, leader_task)))
            }
        };

        if let Some((flight_id, sender, task)) = worker {
            self.spawn_worker(flight_key, flight_id, reason, sender, task);
        }

        loop {
            let state = receiver.borrow_and_update().clone();
            match state {
                RefreshFlightState::Pending => {}
                RefreshFlightState::Finished(result) => {
                    return result.map_err(AppError::General);
                }
            }

            if receiver.changed().await.is_err() {
                return Err(AppError::General(
                    "Agent sessions read flight closed without a result".to_string(),
                ));
            }
        }
    }

    fn spawn_worker<F>(
        &self,
        flight_key: RefreshFlightKey,
        flight_id: u64,
        reason: &'static str,
        sender: watch::Sender<RefreshFlightState>,
        task: F,
    ) where
        F: FnOnce() -> Result<AgentSessionsListResult, AppError> + Send + 'static,
    {
        let coordinator = self.clone();
        tokio::spawn(async move {
            let queued = coordinator
                .inner
                .queued_reads
                .fetch_add(1, Ordering::Relaxed)
                + 1;
            tracing::info!(
                target: "svode::agent_sessions",
                event = "agent_sessions_read_queued",
                project_path = %flight_key.project_key,
                operation = flight_key.kind.as_str(),
                flight_id,
                active_agent_session_reads = coordinator.inner.active_reads.load(Ordering::Relaxed),
                active_full_refreshes = coordinator.inner.active_full_refreshes.load(Ordering::Relaxed),
                queued_agent_session_reads = queued,
                coalesced_agent_session_reads = coordinator.inner.coalesced_reads.load(Ordering::Relaxed),
                reason,
            );

            let permit = coordinator.inner.global_permits.acquire().await;
            coordinator
                .inner
                .queued_reads
                .fetch_sub(1, Ordering::Relaxed);
            let result = match permit {
                Ok(_permit) => {
                    let active_reads = coordinator
                        .inner
                        .active_reads
                        .fetch_add(1, Ordering::Relaxed)
                        + 1;
                    let active_full_refreshes = if flight_key.kind.is_full_refresh() {
                        coordinator
                            .inner
                            .active_full_refreshes
                            .fetch_add(1, Ordering::Relaxed)
                            + 1
                    } else {
                        coordinator
                            .inner
                            .active_full_refreshes
                            .load(Ordering::Relaxed)
                    };
                    let started = Instant::now();
                    tracing::info!(
                        target: "svode::agent_sessions",
                        event = "agent_sessions_read_started",
                        project_path = %flight_key.project_key,
                        operation = flight_key.kind.as_str(),
                        flight_id,
                        active_agent_session_reads = active_reads,
                        active_full_refreshes,
                        project_active_reads = 1,
                        queued_agent_session_reads = coordinator.inner.queued_reads.load(Ordering::Relaxed),
                        coalesced_agent_session_reads = coordinator.inner.coalesced_reads.load(Ordering::Relaxed),
                        reason,
                    );

                    let result = tokio::task::spawn_blocking(task)
                        .await
                        .map_err(|error| {
                            AppError::General(format!("Agent sessions task failed: {error}"))
                        })
                        .and_then(|result| result);
                    coordinator
                        .inner
                        .active_reads
                        .fetch_sub(1, Ordering::Relaxed);
                    if flight_key.kind.is_full_refresh() {
                        coordinator
                            .inner
                            .active_full_refreshes
                            .fetch_sub(1, Ordering::Relaxed);
                    }
                    log_read_result(
                        &flight_key,
                        flight_id,
                        reason,
                        started.elapsed().as_millis(),
                        &result,
                        &coordinator,
                    );
                    result
                }
                Err(error) => Err(AppError::General(format!(
                    "Agent sessions read semaphore closed: {error}"
                ))),
            };

            sender.send_replace(RefreshFlightState::Finished(
                result.map_err(|error| error.to_string()),
            ));

            let mut flights = coordinator.inner.flights.lock().await;
            if flights
                .get(&flight_key)
                .is_some_and(|flight| flight.id == flight_id)
            {
                flights.remove(&flight_key);
            }
        });
    }
}

fn log_read_result(
    flight_key: &RefreshFlightKey,
    flight_id: u64,
    reason: &str,
    duration_ms: u128,
    result: &Result<AgentSessionsListResult, AppError>,
    coordinator: &AgentSessionsReadCoordinator,
) {
    match result {
        Ok(result) => {
            let files_scanned = result
                .sources
                .iter()
                .map(|source| source.counts.files_scanned)
                .sum::<usize>();
            let records_read = result
                .sources
                .iter()
                .map(|source| source.counts.records_read)
                .sum::<usize>();
            tracing::info!(
                target: "svode::agent_sessions",
                event = "agent_sessions_read_finished",
                project_path = flight_key.project_key,
                operation = flight_key.kind.as_str(),
                flight_id,
                duration_ms,
                files_scanned,
                records_read,
                returned_sessions = result.sessions.len(),
                malformed_lines = result.summary.malformed_lines,
                source_errors = result.summary.source_errors,
                cache_mode = ?result.cache.mode,
                active_agent_session_reads = coordinator.inner.active_reads.load(Ordering::Relaxed),
                active_full_refreshes = coordinator.inner.active_full_refreshes.load(Ordering::Relaxed),
                queued_agent_session_reads = coordinator.inner.queued_reads.load(Ordering::Relaxed),
                coalesced_agent_session_reads = coordinator.inner.coalesced_reads.load(Ordering::Relaxed),
                reason,
            );
        }
        Err(error) => {
            tracing::warn!(
                target: "svode::agent_sessions",
                event = "agent_sessions_read_failed",
                project_path = flight_key.project_key,
                operation = flight_key.kind.as_str(),
                flight_id,
                duration_ms,
                error_kind = error.kind(),
                error = %error,
                active_agent_session_reads = coordinator.inner.active_reads.load(Ordering::Relaxed),
                active_full_refreshes = coordinator.inner.active_full_refreshes.load(Ordering::Relaxed),
                queued_agent_session_reads = coordinator.inner.queued_reads.load(Ordering::Relaxed),
                coalesced_agent_session_reads = coordinator.inner.coalesced_reads.load(Ordering::Relaxed),
                reason,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::fs;
    use std::io::Write as _;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex as StdMutex};

    use super::*;
    use crate::agent_sessions::types::{
        AgentSessionsCacheMode, AgentSessionsCacheReport, AgentSessionsListStatus,
        AgentSessionsSummary,
    };
    use crate::agent_sessions::{AgentSessionsState, read_model};

    fn empty_result(project_path: &str) -> AgentSessionsListResult {
        AgentSessionsListResult {
            status: AgentSessionsListStatus::Ok,
            generated_at: "2026-07-25T00:00:00Z".to_string(),
            project_path: project_path.to_string(),
            sessions: Vec::new(),
            sources: Vec::new(),
            summary: AgentSessionsSummary::default(),
            cache: AgentSessionsCacheReport {
                mode: AgentSessionsCacheMode::ForceRefresh,
                hit: false,
                source_hits: 0,
                source_misses: 2,
            },
        }
    }

    fn wait_until(predicate: impl Fn() -> bool) {
        for _ in 0..1_000 {
            if predicate() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("condition was not reached before timeout");
    }

    fn wait_for_release(gate: &Arc<(StdMutex<bool>, Condvar)>) {
        let (released, wake) = &**gate;
        let mut released = released.lock().expect("gate lock");
        while !*released {
            released = wake.wait(released).expect("gate wait");
        }
    }

    fn release(gate: &Arc<(StdMutex<bool>, Condvar)>) {
        let (released, wake) = &**gate;
        *released.lock().expect("gate lock") = true;
        wake.notify_all();
    }

    fn write_large_source_fixture(home: &Path, project: &Path, session_count: usize) {
        let mut codex_history = String::new();
        let mut claude_history = String::new();
        for index in 0..session_count {
            writeln!(
                codex_history,
                "{}",
                serde_json::json!({
                    "sessionId": format!("codex-stress-{index}"),
                    "cwd": project.to_string_lossy(),
                    "timestamp": 1_700_000_000 + index,
                    "text": format!("Codex stress session {index}"),
                })
            )
            .expect("format codex fixture");
            writeln!(
                claude_history,
                "{}",
                serde_json::json!({
                    "sessionId": format!("claude-stress-{index}"),
                    "display": format!("Claude stress session {index}"),
                    "project": project.to_string_lossy(),
                    "timestamp": 1_700_000_000 + index,
                })
            )
            .expect("format claude fixture");
        }
        codex_history.push_str("{\"malformed\":\n");
        claude_history.push_str("{\"malformed\":\n");

        let codex_path = home.join(".codex/history.jsonl");
        let claude_path = home.join(".claude/history.jsonl");
        fs::create_dir_all(codex_path.parent().expect("codex parent"))
            .expect("create codex fixture dir");
        fs::create_dir_all(claude_path.parent().expect("claude parent"))
            .expect("create claude fixture dir");
        fs::write(codex_path, codex_history).expect("write codex fixture");
        fs::write(claude_path, claude_history).expect("write claude fixture");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_discovery_reads_for_one_project_share_one_scan() {
        let coordinator = AgentSessionsReadCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));

        let first = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::Discovery,
                        "test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            wait_for_release(&gate);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        wait_until(|| calls.load(Ordering::SeqCst) == 1);

        let second = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::Discovery,
                        "test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release(&gate);
        assert_eq!(
            first
                .await
                .expect("first task")
                .expect("first result")
                .project_path,
            "/project"
        );
        assert_eq!(
            second
                .await
                .expect("second task")
                .expect("second result")
                .project_path,
            "/project"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_refresh_waits_for_discovery_instead_of_reusing_its_result() {
        let coordinator = AgentSessionsReadCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));

        let discovery = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::Discovery,
                        "test-discovery",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            wait_for_release(&gate);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        wait_until(|| calls.load(Ordering::SeqCst) == 1);

        let refresh = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::FullRefresh,
                        "test-refresh",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release(&gate);
        discovery
            .await
            .expect("discovery task")
            .expect("discovery result");
        refresh
            .await
            .expect("refresh task")
            .expect("refresh result");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn discovery_joins_an_active_full_refresh_for_the_same_project() {
        let coordinator = AgentSessionsReadCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));

        let refresh = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::FullRefresh,
                        "test-refresh",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            wait_for_release(&gate);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        wait_until(|| calls.load(Ordering::SeqCst) == 1);

        let discovery = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::Discovery,
                        "test-discovery",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release(&gate);
        refresh
            .await
            .expect("refresh task")
            .expect("refresh result");
        discovery
            .await
            .expect("discovery task")
            .expect("discovery result");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_scans_for_different_projects_use_bounded_global_concurrency() {
        let coordinator = AgentSessionsReadCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));

        let spawn_refresh = |project: &'static str| {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        project.to_string(),
                        AgentSessionsReadKind::FullRefresh,
                        "test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                            max_active.fetch_max(current, Ordering::SeqCst);
                            wait_for_release(&gate);
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(empty_result(project))
                        },
                    )
                    .await
            })
        };

        let first = spawn_refresh("/project-a");
        wait_until(|| calls.load(Ordering::SeqCst) == 1);
        let second = spawn_refresh("/project-b");
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        release(&gate);
        first.await.expect("first task").expect("first result");
        second.await.expect("second task").expect("second result");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_consumer_does_not_cancel_or_duplicate_the_refresh() {
        let coordinator = AgentSessionsReadCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));

        let first = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::FullRefresh,
                        "test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            wait_for_release(&gate);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };
        wait_until(|| calls.load(Ordering::SeqCst) == 1);
        first.abort();

        let second = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .run(
                        "/project".to_string(),
                        AgentSessionsReadKind::FullRefresh,
                        "test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(empty_result("/project"))
                        },
                    )
                    .await
            })
        };

        release(&gate);
        second.await.expect("second task").expect("second result");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn large_malformed_sources_remain_single_flight_during_refresh_storm() {
        const CONSUMERS: usize = 24;
        const SESSIONS_PER_SOURCE: usize = 1_000;

        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("create project");
        write_large_source_fixture(&home, &project, SESSIONS_PER_SOURCE);

        let coordinator = AgentSessionsReadCoordinator::default();
        let state = AgentSessionsState::with_home(home.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((StdMutex::new(false), Condvar::new()));
        let project_path = project.to_string_lossy().into_owned();
        let mut consumers = Vec::new();

        for _ in 0..CONSUMERS {
            let coordinator = coordinator.clone();
            let state = state.clone();
            let calls = calls.clone();
            let gate = gate.clone();
            let project_path = project_path.clone();
            consumers.push(tokio::spawn(async move {
                coordinator
                    .run(
                        project_path.clone(),
                        AgentSessionsReadKind::FullRefresh,
                        "stress-test",
                        move || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            wait_for_release(&gate);
                            read_model::list_sessions(&state, project_path, true)
                        },
                    )
                    .await
            }));
        }
        wait_until(|| calls.load(Ordering::SeqCst) == 1);

        let append_path = home.join(".codex/history.jsonl");
        let append_project = project.clone();
        let append = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1));
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(append_path)
                .expect("open fixture for append");
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "sessionId": "codex-appended-during-scan",
                    "cwd": append_project.to_string_lossy(),
                    "timestamp": 1_700_100_000,
                    "text": "Appended while the shared scan is active",
                })
            )
            .expect("append source row");
        });

        release(&gate);
        for consumer in consumers {
            let result = consumer
                .await
                .expect("consumer task")
                .expect("consumer result");
            assert_eq!(result.cache.mode, AgentSessionsCacheMode::ForceRefresh);
            assert!(matches!(
                result.status,
                AgentSessionsListStatus::Ok | AgentSessionsListStatus::Partial
            ));
            assert!(result.sessions.len() >= SESSIONS_PER_SOURCE * 2);
        }
        append.join().expect("append thread");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
