use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use super::AgentSessionsState;
use super::live_status::external_liveness;
use super::read_model;
use super::types::{
    AgentSession, AgentSessionReentryError, AgentSessionReentryErrorCode, AgentSessionReentryMode,
    AgentSessionReentryResult, AgentSessionResumeCommand, AgentSessionScopeKind,
    AgentSessionScopeStatus, native_writer_key,
};
use crate::error::AppError;
use crate::terminal::{AgentTerminalSpawn, AgentTerminalSurface, quote_agent_shell_command};
use svode_agents::writer::{UnknownLiveness, Writer, WriterClaim, WriterRefusal, WriterRegistry};
use svode_core::agent_adapters::{AgentId, resolve_space_executable};
use svode_core::system_path;

pub(crate) fn reenter_session<ResolveCli, SpawnShell>(
    state: &AgentSessionsState,
    project_path: String,
    session_id: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    writers: &WriterRegistry,
    resolve_cli: ResolveCli,
    spawn_shell: SpawnShell,
) -> Result<AgentSessionReentryResult, AppError>
where
    ResolveCli: FnMut(&AgentSession, &Path) -> Option<String>,
    SpawnShell: FnMut(AgentTerminalSpawn, WriterClaim) -> Result<String, AppError>,
{
    let list = match read_model::list_sessions(state, project_path, terminal_surfaces, Vec::new()) {
        Ok(list) => list,
        Err(AppError::PathNotAccessible(path)) => {
            return Ok(error_result(
                session_id,
                AgentSessionReentryErrorCode::CwdNotAccessible,
                format!("Project path is not accessible: {path}"),
                None,
                Some(path),
            ));
        }
        Err(error) => return Err(error),
    };
    let project = PathBuf::from(&list.project_path);
    let Some(session) = list
        .sessions
        .iter()
        .find(|session| session.is_addressed_by(&session_id))
    else {
        return Ok(error_result(
            session_id.clone(),
            AgentSessionReentryErrorCode::ResumeUnavailable,
            format!("Agent session is not scoped to current project: {session_id}"),
            None,
            None,
        ));
    };

    reenter_scoped_session(session, &project, writers, resolve_cli, spawn_shell)
}

pub(crate) fn terminal_unavailable_result(
    session_id: String,
    message: impl Into<String>,
) -> AgentSessionReentryResult {
    error_result(
        session_id,
        AgentSessionReentryErrorCode::TerminalUnavailable,
        message,
        None,
        None,
    )
}

pub(crate) fn resolve_agent_cli_binary(
    source: &AgentId,
    scope_dir: &Path,
    home_dir: &Path,
    search_path: Option<&OsStr>,
) -> Option<String> {
    let path = resolve_space_executable(source.builtin()?, scope_dir, home_dir, search_path)?;
    let canonical = fs::canonicalize(&path).unwrap_or(path);
    Some(system_path::user_facing_path(&canonical))
}

fn reenter_scoped_session<ResolveCli, SpawnShell>(
    session: &AgentSession,
    project: &Path,
    writers: &WriterRegistry,
    mut resolve_cli: ResolveCli,
    mut spawn_shell: SpawnShell,
) -> Result<AgentSessionReentryResult, AppError>
where
    ResolveCli: FnMut(&AgentSession, &Path) -> Option<String>,
    SpawnShell: FnMut(AgentTerminalSpawn, WriterClaim) -> Result<String, AppError>,
{
    if let Some(pty_id) = live_managed_pty_id(session) {
        return Ok(AgentSessionReentryResult {
            mode: AgentSessionReentryMode::FocusedManagedPty,
            session_id: session.id.clone(),
            pty_id: Some(pty_id),
            command: None,
            cwd: None,
            error: None,
        });
    }

    // The record's command continues the session where its agent does: the
    // tip of a Hermes chain in its profile (`07` N6).
    let resume = session
        .resume_command
        .as_ref()
        .filter(|_| session.capabilities.can_resume && !session.resume_id().trim().is_empty());
    let Some((resume_program, resume_args)) =
        resume.map(|command| (command.program.as_str(), command.args.as_slice()))
    else {
        return Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::ResumeUnavailable,
            "Agent session cannot be resumed by its source CLI",
            None,
            None,
        ));
    };

    let cwd = match resolve_safe_cwd(session, project) {
        Ok(cwd) => cwd,
        Err(raw_cwd) => {
            let command = resume_command(resume_program, resume_args, raw_cwd.clone());
            return Ok(error_result(
                session.id.clone(),
                AgentSessionReentryErrorCode::CwdNotAccessible,
                "Agent session cwd is not accessible",
                Some(command),
                raw_cwd,
            ));
        }
    };
    let scope_dir = scope_config_dir(session, project);
    let Some(program) = resolve_cli(session, &scope_dir) else {
        let command = resume_command(resume_program, resume_args, Some(cwd.clone()));
        return Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::CliNotFound,
            format!("{resume_program} CLI binary was not found"),
            Some(command),
            Some(cwd),
        ));
    };
    let command = resume_command(&program, resume_args, Some(cwd.clone()));
    // Terminal resume under unknown liveness keeps today's behaviour: it is
    // the native CLI the user would start by hand, with its own guards.
    let claim = match writers.claim(
        &native_writer_key(&session.source, session.resume_id()),
        Writer::Pty,
        external_liveness(session),
        UnknownLiveness::NotConfirmed,
    ) {
        Ok(claim) => claim,
        Err(refusal) => {
            let (code, message) = writer_refusal(refusal);
            return Ok(error_result(
                session.id.clone(),
                code,
                message,
                Some(command),
                Some(cwd),
            ));
        }
    };

    let spawn = AgentTerminalSpawn {
        agent_session_id: session.id.clone(),
        title: Some(session.title.clone()),
        source: session.source.clone(),
        source_session_id: session.source_session_id.clone(),
        command: command.clone(),
        cwd: cwd.clone(),
        mcp_project_path: Some(system_path::user_facing_path(project)),
        launch_id: None,
        routine_run_id: None,
        lifecycle_sink: None,
    };
    match spawn_shell(spawn, claim) {
        Ok(pty_id) => Ok(AgentSessionReentryResult {
            mode: AgentSessionReentryMode::SpawnedResumePty,
            session_id: session.id.clone(),
            pty_id: Some(pty_id),
            command: Some(command),
            cwd: Some(cwd),
            error: None,
        }),
        Err(AppError::PathNotAccessible(path)) => Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::CwdNotAccessible,
            format!("Agent session cwd is not accessible: {path}"),
            Some(command),
            Some(path),
        )),
        Err(error) => Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::TerminalUnavailable,
            format!("Failed to open managed terminal: {error}"),
            Some(command),
            Some(cwd),
        )),
    }
}

/// Why the session cannot take a terminal writer; the resume command stays
/// as the manual fallback.
fn writer_refusal(refusal: WriterRefusal) -> (AgentSessionReentryErrorCode, &'static str) {
    match refusal {
        WriterRefusal::WriterActive {
            writer: Writer::Acp,
        } => (
            AgentSessionReentryErrorCode::WriterActive,
            "Agent session is being continued in Svode; open it there",
        ),
        WriterRefusal::WriterActive {
            writer: Writer::Pty,
        } => (
            AgentSessionReentryErrorCode::WriterActive,
            "Agent session already runs in a managed terminal",
        ),
        WriterRefusal::ExternalActive => (
            AgentSessionReentryErrorCode::ExternalActive,
            "Agent session is running in another process; continue it there or resume it yourself once it stops",
        ),
        WriterRefusal::ConfirmationRequired => (
            AgentSessionReentryErrorCode::Unknown,
            "Agent session needs confirmation before it continues",
        ),
    }
}

fn live_managed_pty_id(session: &AgentSession) -> Option<String> {
    session
        .runtime
        .as_ref()
        .filter(|runtime| runtime.live)
        .and_then(|runtime| runtime.pty_id.clone())
}

fn resume_command(
    program: &str,
    args: &[String],
    cwd: Option<String>,
) -> AgentSessionResumeCommand {
    AgentSessionResumeCommand {
        display: quote_agent_shell_command(program, args),
        program: program.to_string(),
        args: args.to_vec(),
        cwd,
    }
}

fn error_result(
    session_id: String,
    code: AgentSessionReentryErrorCode,
    message: impl Into<String>,
    command: Option<AgentSessionResumeCommand>,
    cwd: Option<String>,
) -> AgentSessionReentryResult {
    AgentSessionReentryResult {
        mode: AgentSessionReentryMode::Error,
        session_id,
        pty_id: None,
        command,
        cwd,
        error: Some(AgentSessionReentryError {
            code,
            message: message.into(),
        }),
    }
}

pub(super) fn resolve_safe_cwd(
    session: &AgentSession,
    project: &Path,
) -> Result<String, Option<String>> {
    let raw_candidates = cwd_candidates(session);
    for raw in &raw_candidates {
        if let Some(cwd) = canonical_existing_dir(raw, project) {
            return Ok(cwd);
        }
    }

    if matches!(session.scope_status, AgentSessionScopeStatus::Ready) {
        if let Ok(project) = fs::canonicalize(project)
            && project.is_dir()
        {
            return Ok(system_path::user_facing_path(&project));
        }
    }

    Err(raw_candidates.into_iter().next())
}

fn cwd_candidates(session: &AgentSession) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(cwd) = session
        .resume_command
        .as_ref()
        .and_then(|command| command.cwd.clone())
    {
        out.push(cwd);
    }
    if let Some(cwd) = &session.cwd
        && !out.iter().any(|existing| existing == cwd)
    {
        out.push(cwd.clone());
    }
    out
}

fn canonical_existing_dir(raw: &str, project: &Path) -> Option<String> {
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        project.join(path)
    };
    let canonical = fs::canonicalize(path).ok()?;
    canonical
        .is_dir()
        .then(|| system_path::user_facing_path(&canonical))
}

fn scope_config_dir(session: &AgentSession, project: &Path) -> PathBuf {
    if matches!(session.scope_kind, AgentSessionScopeKind::Space)
        && let Some(space_path) = &session.space_path
    {
        return PathBuf::from(space_path);
    }
    project.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::terminal::AgentTerminalSurface;
    use svode_core::agent_adapters::AgentAdapterKind;

    // An empty search PATH keeps the developer's own CLIs out of the tests.
    fn no_search_path() -> Option<&'static OsStr> {
        Some(OsStr::new(""))
    }

    fn write_executable(path: &Path) {
        write(path, "");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
    }

    /// The session as Codex lists it over ACP.
    fn listed(state: &AgentSessionsState, source_session_id: &str, cwd: &Path) {
        let list = svode_agents::catalog::SessionList {
            sessions: vec![svode_agents::catalog::ListedSession {
                key: svode_agents::identity::SessionKey::from_acp("codex", source_session_id, true),
                cwd: cwd.to_path_buf(),
                title: Some(source_session_id.to_string()),
                updated_at: Some("2023-11-14T22:13:20Z".to_string()),
            }],
            ..Default::default()
        };
        state.acp_lists.apply("codex", Ok(list), 1);
    }

    fn write_root_config(project: &Path, spaces: Vec<serde_json::Value>) {
        write(
            &project.join(".svode/config.json"),
            &serde_json::json!({
                "name": "Project",
                "spaces": spaces,
            })
            .to_string(),
        );
    }

    fn canonical_display(path: &Path) -> String {
        system_path::user_facing_path(&fs::canonicalize(path).expect("canonical path"))
    }

    fn live_surface(pty_id: &str, source_session_id: &str) -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: pty_id.to_string(),
            agent_session_id: format!("codex:{source_session_id}"),
            launch_id: None,
            routine_run_id: None,
            mcp_project_path: None,
            mcp_routine_caller_token: None,
            title: Some(format!("Session {source_session_id}")),
            source: AgentAdapterKind::Codex.id(),
            source_session_id: source_session_id.to_string(),
            live: true,
            initial_agent_argv: vec![
                "codex".to_string(),
                "resume".to_string(),
                source_session_id.to_string(),
            ],
            initial_agent_cwd: Some("/tmp/project".to_string()),
            shell_cwd: "/tmp/project".to_string(),
            created_at: "2026-07-04T10:00:00Z".to_string(),
            last_output_at: None,
            last_input_at: None,
            finished_at: None,
            exit_code: None,
            failure_reason: None,
            status_evidence: None,
            exit_marker_buffer: String::new(),
        }
    }

    #[test]
    fn agent_sessions_reentry_focuses_existing_live_managed_pty() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");

        let state = AgentSessionsState::with_home(home);
        listed(&state, "live", &project);
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:live".to_string(),
            vec![live_surface("pty-live", "live")],
            &WriterRegistry::default(),
            |_, _| panic!("cli resolution should not run for focused PTY"),
            |_, _| panic!("spawn should not run for focused PTY"),
        )
        .expect("reenter");

        assert_eq!(result.mode, AgentSessionReentryMode::FocusedManagedPty);
        assert_eq!(result.pty_id.as_deref(), Some("pty-live"));
    }

    #[test]
    fn agent_sessions_reentry_spawns_done_session_resume_shell() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let bin = project.join("bin/codex");
        fs::create_dir_all(&project).expect("project");
        write_executable(&bin);
        write(
            &project.join(".svode/local.json"),
            &serde_json::json!({
                "agent": {
                    "cliPaths": {
                        "codex": bin.to_string_lossy()
                    }
                }
            })
            .to_string(),
        );

        let state = AgentSessionsState::with_home(home.clone());
        listed(&state, "done", &project);
        // No liveness evidence: terminal resume runs without a confirmation.
        let writers = WriterRegistry::default();
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:done".to_string(),
            Vec::new(),
            &writers,
            move |session, scope_dir| {
                resolve_agent_cli_binary(&session.source, scope_dir, &home, no_search_path())
            },
            |spawn, claim| {
                assert_eq!(claim.writer(), Writer::Pty);
                assert_eq!(spawn.agent_session_id, "codex:done");
                assert_eq!(spawn.command.program, canonical_display(&bin));
                assert_eq!(spawn.command.args, vec!["resume", "done"]);
                assert_eq!(spawn.cwd, canonical_display(&project));
                Ok("pty-spawned".to_string())
            },
        )
        .expect("reenter");

        assert_eq!(result.mode, AgentSessionReentryMode::SpawnedResumePty);
        assert_eq!(result.pty_id.as_deref(), Some("pty-spawned"));
        assert_eq!(
            result.command.as_ref().expect("command").program,
            canonical_display(&bin)
        );
    }

    const ELSEWHERE: &str = "0199a1b2-0000-7000-8000-000000000001";

    fn write_active_codex_rollout(home: &Path, source_session_id: &str) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        write(
            &home.join(".codex/sessions/2026/07/04").join(format!(
                "rollout-2026-07-04T10-00-00-{source_session_id}.jsonl"
            )),
            &serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_started" },
                "timestamp": now
            })
            .to_string(),
        );
    }

    #[test]
    fn agent_sessions_reentry_leaves_a_session_running_elsewhere_to_manual_resume() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_active_codex_rollout(&home, ELSEWHERE);

        let state = AgentSessionsState::with_home(home);
        listed(&state, ELSEWHERE, &project);
        let writers = WriterRegistry::default();
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            format!("codex:{ELSEWHERE}"),
            Vec::new(),
            &writers,
            |_, _| Some("codex".to_string()),
            |_, _| panic!("spawn should not run while another process writes"),
        )
        .expect("reenter");

        assert_eq!(result.mode, AgentSessionReentryMode::Error);
        assert_eq!(
            result.error.as_ref().expect("error").code,
            AgentSessionReentryErrorCode::ExternalActive
        );
        assert_eq!(
            result.command.as_ref().expect("manual fallback").args,
            vec!["resume", ELSEWHERE]
        );
        assert_eq!(
            writers.writer(&native_writer_key(&AgentAdapterKind::Codex.id(), ELSEWHERE)),
            None
        );
    }

    #[test]
    fn agent_sessions_reentry_does_not_start_a_terminal_for_a_session_svode_continues() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");

        let state = AgentSessionsState::with_home(home);
        listed(&state, "in-svode", &project);
        let writers = WriterRegistry::default();
        let _acp = writers
            .claim(
                &native_writer_key(&AgentAdapterKind::Codex.id(), "in-svode"),
                Writer::Acp,
                svode_agents::writer::ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .expect("acp writer");
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:in-svode".to_string(),
            Vec::new(),
            &writers,
            |_, _| Some("codex".to_string()),
            |_, _| panic!("spawn should not run while ACP writes"),
        )
        .expect("reenter");

        assert_eq!(
            result.error.as_ref().expect("error").code,
            AgentSessionReentryErrorCode::WriterActive
        );
        assert!(result.command.is_some());
    }

    #[test]
    fn agent_sessions_reentry_returns_cwd_not_accessible_for_missing_scope_cwd() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(
            &project,
            vec![serde_json::json!({
                "id": "missing-space",
                "path": "missing",
                "repo": "https://example.com/missing.git",
            })],
        );

        let state = AgentSessionsState::with_home(home);
        listed(&state, "missing", &project.join("missing/sub"));
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:missing".to_string(),
            Vec::new(),
            &WriterRegistry::default(),
            |_, _| panic!("cli resolution should not run without cwd"),
            |_, _| panic!("spawn should not run without cwd"),
        )
        .expect("reenter");

        assert_eq!(result.mode, AgentSessionReentryMode::Error);
        assert_eq!(
            result.error.as_ref().expect("error").code,
            AgentSessionReentryErrorCode::CwdNotAccessible
        );
        assert_eq!(
            result.command.as_ref().expect("command").args,
            vec!["resume", "missing"]
        );
    }

    #[test]
    fn agent_sessions_reentry_returns_cli_not_found_before_spawn() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");

        let state = AgentSessionsState::with_home(home);
        listed(&state, "no-cli", &project);
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:no-cli".to_string(),
            Vec::new(),
            &WriterRegistry::default(),
            |_, _| None,
            |_, _| panic!("spawn should not run without cli"),
        )
        .expect("reenter");

        assert_eq!(result.mode, AgentSessionReentryMode::Error);
        assert_eq!(
            result.error.as_ref().expect("error").code,
            AgentSessionReentryErrorCode::CliNotFound
        );
        assert_eq!(result.command.as_ref().expect("command").program, "codex");
    }

    #[test]
    fn agent_sessions_reentry_resolves_common_codex_path_from_discovery_home() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let home = temp.path().join("home");
        let codex = home.join(".local/bin/codex");
        fs::create_dir_all(&project).expect("project");
        write_executable(&codex);

        let resolved = resolve_agent_cli_binary(
            &AgentAdapterKind::Codex.id(),
            &project,
            &home,
            no_search_path(),
        )
        .expect("codex path");

        assert_eq!(resolved, canonical_display(&codex));
    }

    #[test]
    fn agent_sessions_reentry_supports_claude_code_custom_path_keys() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let claude = project.join("bin/claude");
        fs::create_dir_all(&project).expect("project");
        write_executable(&claude);
        write(
            &project.join(".svode/local.json"),
            &serde_json::json!({
                "agent": {
                    "cliPaths": {
                        "claude-code": claude.to_string_lossy()
                    }
                }
            })
            .to_string(),
        );

        let resolved = resolve_agent_cli_binary(
            &AgentAdapterKind::ClaudeCode.id(),
            &project,
            temp.path(),
            no_search_path(),
        )
        .expect("claude path");

        assert_eq!(resolved, canonical_display(&claude));
    }

    #[test]
    fn a_hermes_conversation_continues_at_its_tip_in_its_profile() {
        use crate::agent_sessions::native_status::hermes::tests::{session, store};

        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let cwd = project.to_string_lossy();
        store(
            &home.join(".hermes/profiles/work/state.db"),
            &[
                session("r", "cli", Some(&cwd), "end_reason = 'compression'"),
                session(
                    "t",
                    "cli",
                    Some(&cwd),
                    "parent_session_id = 'r', started_at = 1800000200",
                ),
            ]
            .concat(),
        );
        store(&home.join(".hermes/state.db"), "");
        let state = AgentSessionsState::with_home(home);
        let reads = state.native_catalogs.refresh(&[AgentAdapterKind::Hermes]);
        tauri::async_runtime::block_on(async {
            for read in reads {
                read.await.expect("read");
            }
        });

        let writers = WriterRegistry::default();
        let tip = native_writer_key(&AgentAdapterKind::Hermes.id(), "t");
        // A key saved with the tip's id addresses the conversation.
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "hermes:t".to_string(),
            Vec::new(),
            &writers,
            |_, _| Some("/bin/hermes".to_string()),
            |spawn, _claim| {
                assert_eq!(spawn.agent_session_id, "hermes:r");
                assert_eq!(spawn.source_session_id, "r");
                assert_eq!(spawn.command.program, "/bin/hermes");
                assert_eq!(spawn.command.args, ["-p", "work", "--resume", "t"]);
                assert_eq!(writers.writer(&tip), Some(Writer::Pty));
                Ok("pty-hermes".to_string())
            },
        )
        .expect("reenter");
        assert_eq!(result.mode, AgentSessionReentryMode::SpawnedResumePty);
        assert_eq!(result.session_id, "hermes:r");
    }
}
