//! Desktop binding of turn boundaries to repositories (Stage 11 1.E «Ходы
//! агентов», «Рутины»). The signals come from the ACP runtime of
//! `svode_agents`, from the known status of terminal sessions of the Sessions
//! read-model and from Routine runs; each is bound to the repository of its
//! working directory and reported to `svode_core::git::versions::turns`,
//! which owns closing before a turn, the hold during it and the version of
//! the turn. Keys: `acp:<agent>:<turn>`, `terminal:<pty>`, `routine:<id>`.

use std::path::{Path, PathBuf};

use svode_agents::turns::{TurnBoundary, TurnFuture, TurnMark, TurnObserver};
use svode_core::git::versions::auto::{self, AutoVersions};
use svode_core::git::versions::turns::{self, TurnBegin, TurnEnd, TurnWrap};
use tauri::AppHandle;

use super::auto_versions;
use super::commands::message_language;
use super::delivery::{host, runtime};
use crate::agent_sessions::types::AgentSession;

/// The turn observer of the agent runtime: an ACP turn in a working
/// directory inside a repository is a turn of that repository.
pub(crate) struct AcpTurns {
    app: AppHandle,
}

impl AcpTurns {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn acp_key(turn: &TurnBoundary) -> String {
    format!("acp:{}:{}", turn.session.agent, turn.turn_id)
}

/// How Svode wraps a turn whose prompt carried `mark`.
fn wrap_of(mark: Option<TurnMark>) -> TurnWrap {
    match mark {
        Some(TurnMark::AgentCommits) => TurnWrap::AgentCommits,
        None => TurnWrap::Version,
    }
}

impl TurnObserver for AcpTurns {
    fn began(&self, turn: &TurnBoundary) -> TurnFuture {
        let app = self.app.clone();
        let key = acp_key(turn);
        let cwd = turn.cwd.clone();
        let wrap = wrap_of(turn.mark);
        Box::pin(async move { began(&app, &cwd, &key, wrap).await })
    }

    fn ended(&self, turn: &TurnBoundary) {
        let app = self.app.clone();
        let key = acp_key(turn);
        tauri::async_runtime::spawn(async move { ended(&app, &key).await });
    }
}

/// The turn `key` starts in `cwd`; the groups of its repository close first
/// when it is the first turn there.
pub(crate) async fn began(app: &AppHandle, cwd: &Path, key: &str, wrap: TurnWrap) {
    let Some(repo) = auto::repository_of(cwd) else {
        return;
    };
    let result = turns::begin(
        &runtime(app),
        host(app).as_ref(),
        &repo,
        key,
        wrap,
        message_language(app),
    )
    .await;
    if let TurnBegin::First {
        closed: Some(closed),
    } = result
    {
        // Every group closed: no group plans a later check.
        auto_versions::settle(app, repo, closed);
    }
}

/// The turn `key` ended. After the last turn of a repository its version is
/// made, a sync the turn deferred runs, and the groups left open close by
/// the pause.
pub(crate) async fn ended(app: &AppHandle, key: &str) {
    let TurnEnd::Ended {
        repository,
        version,
        deferred,
    } = turns::end(
        &runtime(app),
        host(app).as_ref(),
        key,
        message_language(app),
    )
    .await
    else {
        return;
    };
    let commits = *version.as_ref().unwrap_or(&0);
    auto_versions::settle(
        app,
        repository.clone(),
        version.map(|commits| AutoVersions::Done {
            commits,
            next: None,
        }),
    );
    // A version already started a sync where auto-sync is on.
    let synced =
        commits > 0 && svode_core::git::policy::effective_user_policy(&repository).auto_sync;
    if deferred && !synced {
        host(app).schedule_auto_sync(&repository);
    }
    auto_versions::touched(app, &repository);
}

/// A Routine run starts in `repository`: a turn of its own, from before the
/// dispatch to its recorded outcome.
pub(crate) async fn routine_began(app: &AppHandle, repository: &Path) -> String {
    let key = format!(
        "routine:{}",
        ulid::Ulid::new().to_string().to_ascii_lowercase()
    );
    began(app, repository, &key, TurnWrap::Version).await;
    key
}

/// The turn `key` ended; a second report is ignored.
pub(crate) fn end_later(app: &AppHandle, key: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { ended(&app, &key).await });
}

fn terminal_key(pty_id: &str) -> String {
    format!("terminal:{pty_id}")
}

/// Whether a session of the read-model runs in a managed terminal of Svode,
/// and if so its turn key and, while a turn of it is known to run, its
/// working directory. A session an ACP connection drives has its turns from
/// the runtime; a status Stage 10 does not know marks no turn.
fn terminal_turn(session: &AgentSession) -> Option<(String, Option<PathBuf>)> {
    let runtime = session.runtime.as_ref()?;
    if runtime.acp_session.is_some() {
        return None;
    }
    let key = terminal_key(runtime.pty_id.as_deref()?);
    let cwd = session
        .cwd
        .as_deref()
        .or(session.space_path.as_deref())
        .map(PathBuf::from);
    let in_turn = runtime.live && session.status.state.in_turn();
    Some((key, cwd.filter(|_| in_turn)))
}

/// A read of the Sessions read-model observed `sessions`: terminal sessions
/// whose known status shows a turn start one, those that stopped showing it
/// end theirs.
pub(crate) fn observe_sessions(app: &AppHandle, sessions: &[AgentSession]) {
    let running = turns::running();
    for (key, cwd) in sessions.iter().filter_map(terminal_turn) {
        match cwd {
            Some(cwd) if !running.contains(&key) => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    began(&app, &cwd, &key, TurnWrap::Version).await
                });
            }
            None if running.contains(&key) => end_later(app, key),
            _ => {}
        }
    }
}

/// The managed terminal `pty_id` exited: its turn ends with its process.
pub(crate) fn terminal_exited(app: &AppHandle, pty_id: &str) {
    let key = terminal_key(pty_id);
    if turns::running().contains(&key) {
        end_later(app, key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::types::AgentSessionRuntime;
    use svode_agents::status::{SessionState, SessionStatus, StatusConfidence, StatusSource};

    fn session(status: SessionStatus, runtime: Option<AgentSessionRuntime>) -> AgentSession {
        let mut session: AgentSession = serde_json::from_value(serde_json::json!({
            "id": "claude:native:s1",
            "source": "claude-code",
            "sourceSessionId": "s1",
            "title": "Work",
            "titleSource": "cli-title",
            "status": { "state": "unknown", "source": "none", "confidence": "approximate" },
            "scopeKind": "space",
            "scopeStatus": "ready",
            "scopeConfidence": "exact",
            "cwd": "/project/Space",
            "lastActivityAt": "2026-10-31T00:00:00Z",
            "capabilities": { "canResume": false }
        }))
        .expect("session");
        session.status = status;
        session.runtime = runtime;
        session
    }

    fn pty(live: bool) -> Option<AgentSessionRuntime> {
        Some(AgentSessionRuntime {
            pty_id: Some("p1".into()),
            pid: None,
            live,
            provisional: false,
            last_output_at: None,
            last_input_at: None,
            acp_session: None,
            approximate_binding: false,
        })
    }

    fn known(state: SessionState) -> SessionStatus {
        SessionStatus {
            state,
            source: StatusSource::NativeStatusReader,
            confidence: StatusConfidence::Approximate,
        }
    }

    #[test]
    fn a_terminal_session_marks_a_turn_only_with_a_known_running_status() {
        let running = session(known(SessionState::Running), pty(true));
        assert_eq!(
            terminal_turn(&running),
            Some((
                "terminal:p1".to_string(),
                Some(PathBuf::from("/project/Space"))
            ))
        );
        // A status Stage 10 does not know defers nothing.
        let unknown = session(SessionStatus::unknown(), pty(true));
        assert_eq!(terminal_turn(&unknown), Some(("terminal:p1".into(), None)));
        // An idle session and a terminal whose process ended end the turn.
        let idle = session(known(SessionState::Idle { stop_reason: None }), pty(true));
        assert_eq!(terminal_turn(&idle), Some(("terminal:p1".into(), None)));
        let exited = session(known(SessionState::Running), pty(false));
        assert_eq!(terminal_turn(&exited), Some(("terminal:p1".into(), None)));
    }

    #[test]
    fn sessions_outside_a_terminal_or_driven_over_acp_are_not_terminal_turns() {
        assert_eq!(
            terminal_turn(&session(known(SessionState::Running), None)),
            None
        );
        let mut acp = pty(true);
        acp.as_mut().unwrap().acp_session = Some(svode_agents::identity::SessionKey::from_acp(
            "claude-code",
            "s1",
            false,
        ));
        assert_eq!(
            terminal_turn(&session(known(SessionState::Running), acp)),
            None
        );
    }

    #[test]
    fn a_prompt_with_the_commit_request_is_left_to_the_agent() {
        assert_eq!(
            wrap_of(Some(TurnMark::AgentCommits)),
            TurnWrap::AgentCommits
        );
        assert_eq!(wrap_of(None), TurnWrap::Version);
    }
}
