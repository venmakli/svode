use std::fs;
use std::path::{Path, PathBuf};

use super::AgentSessionsState;
use super::read_model;
use super::types::{
    AgentSession, AgentSessionReentryError, AgentSessionReentryErrorCode, AgentSessionReentryMode,
    AgentSessionReentryResult, AgentSessionResumeCommand, AgentSessionScopeKind,
    AgentSessionScopeStatus, AgentSessionSource, AgentSessionStatus, AgentSessionStatusSource,
};
use crate::agent::types::load_space_agent_config;
use crate::error::AppError;
use crate::system_path;
use crate::terminal::{AgentTerminalSpawn, AgentTerminalSurface, quote_agent_shell_command};

pub(crate) fn reenter_session<ResolveCli, SpawnShell>(
    state: &AgentSessionsState,
    project_path: String,
    session_id: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    resolve_cli: ResolveCli,
    spawn_shell: SpawnShell,
) -> Result<AgentSessionReentryResult, AppError>
where
    ResolveCli: FnMut(&AgentSession, &Path) -> Option<String>,
    SpawnShell: FnMut(AgentTerminalSpawn) -> Result<String, AppError>,
{
    let list = match read_model::list_sessions_with_surfaces(
        state,
        project_path,
        false,
        terminal_surfaces,
    ) {
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
        .find(|session| session.id == session_id)
    else {
        return Ok(error_result(
            session_id.clone(),
            AgentSessionReentryErrorCode::ResumeUnavailable,
            format!("Agent session is not scoped to current project: {session_id}"),
            None,
            None,
        ));
    };

    reenter_scoped_session(session, &project, resolve_cli, spawn_shell)
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
    source: AgentSessionSource,
    scope_dir: &Path,
    home_dir: &Path,
) -> Option<String> {
    resolve_agent_cli_binary_with(source, scope_dir, home_dir, |name| which::which(name).ok())
}

fn reenter_scoped_session<ResolveCli, SpawnShell>(
    session: &AgentSession,
    project: &Path,
    mut resolve_cli: ResolveCli,
    mut spawn_shell: SpawnShell,
) -> Result<AgentSessionReentryResult, AppError>
where
    ResolveCli: FnMut(&AgentSession, &Path) -> Option<String>,
    SpawnShell: FnMut(AgentTerminalSpawn) -> Result<String, AppError>,
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

    if !session.capabilities.can_resume || session.source_session_id.trim().is_empty() {
        return Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::ResumeUnavailable,
            "Agent session cannot be resumed by its source CLI",
            None,
            None,
        ));
    }

    let cwd = match resolve_safe_cwd(session, project) {
        Ok(cwd) => cwd,
        Err(raw_cwd) => {
            let command = fallback_resume_command(session, raw_cwd.clone());
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
    if is_external_active_unattachable(session) {
        let command = resolve_cli(session, &scope_dir)
            .map(|program| resolved_resume_command(session, program, cwd.clone()))
            .unwrap_or_else(|| fallback_resume_command(session, Some(cwd.clone())));
        return Ok(AgentSessionReentryResult {
            mode: AgentSessionReentryMode::ExternalActiveUnattachable,
            session_id: session.id.clone(),
            pty_id: None,
            command: Some(command),
            cwd: Some(cwd),
            error: Some(AgentSessionReentryError {
                code: AgentSessionReentryErrorCode::ExternalProcessUnattachable,
                message: "Agent session is active in an external process that Svode cannot attach"
                    .to_string(),
            }),
        });
    }

    let Some(program) = resolve_cli(session, &scope_dir) else {
        let command = fallback_resume_command(session, Some(cwd.clone()));
        return Ok(error_result(
            session.id.clone(),
            AgentSessionReentryErrorCode::CliNotFound,
            format!(
                "{} CLI binary was not found",
                session.source.resume_program()
            ),
            Some(command),
            Some(cwd),
        ));
    };
    let command = resolved_resume_command(session, program, cwd.clone());

    let spawn = AgentTerminalSpawn {
        agent_session_id: session.id.clone(),
        source: session.source,
        source_session_id: session.source_session_id.clone(),
        command: command.clone(),
        cwd: cwd.clone(),
    };
    match spawn_shell(spawn) {
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

fn live_managed_pty_id(session: &AgentSession) -> Option<String> {
    session
        .runtime
        .as_ref()
        .filter(|runtime| runtime.live)
        .and_then(|runtime| runtime.pty_id.clone())
}

fn is_external_active_unattachable(session: &AgentSession) -> bool {
    matches!(session.status, AgentSessionStatus::Active)
        && matches!(session.status_source, AgentSessionStatusSource::ProcessScan)
}

fn resolved_resume_command(
    session: &AgentSession,
    program: String,
    cwd: String,
) -> AgentSessionResumeCommand {
    let args = session.source.resume_args(&session.source_session_id);
    AgentSessionResumeCommand {
        display: quote_agent_shell_command(&program, &args),
        program,
        args,
        cwd: Some(cwd),
    }
}

fn fallback_resume_command(
    session: &AgentSession,
    cwd: Option<String>,
) -> AgentSessionResumeCommand {
    let program = session.source.resume_program().to_string();
    let args = session.source.resume_args(&session.source_session_id);
    AgentSessionResumeCommand {
        display: quote_agent_shell_command(&program, &args),
        program,
        args,
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

fn resolve_safe_cwd(session: &AgentSession, project: &Path) -> Result<String, Option<String>> {
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

fn resolve_agent_cli_binary_with(
    source: AgentSessionSource,
    scope_dir: &Path,
    home_dir: &Path,
    mut find_in_path: impl FnMut(&str) -> Option<PathBuf>,
) -> Option<String> {
    let config = load_space_agent_config(scope_dir);
    for key in cli_path_keys(source) {
        if let Some(path) = config.cli_paths.get(*key)
            && let Some(resolved) = existing_custom_binary(path, scope_dir)
        {
            return Some(resolved);
        }
    }

    let binary_name = source.resume_program();
    if let Some(path) = find_in_path(binary_name) {
        return Some(system_path::user_facing_path(&path));
    }

    common_cli_paths(source, home_dir)
        .into_iter()
        .find_map(|path| existing_file_path(&path))
}

fn cli_path_keys(source: AgentSessionSource) -> &'static [&'static str] {
    match source {
        AgentSessionSource::Codex => &["codex"],
        AgentSessionSource::ClaudeCode => &["claude-code", "claude"],
    }
}

fn existing_custom_binary(raw: &Path, scope_dir: &Path) -> Option<String> {
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        scope_dir.join(raw)
    };
    existing_file_path(&path)
}

fn existing_file_path(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Some(system_path::user_facing_path(&canonical))
}

fn common_cli_paths(source: AgentSessionSource, home_dir: &Path) -> Vec<PathBuf> {
    let binary = source.resume_program();
    vec![
        home_dir.join(".local/bin").join(binary),
        home_dir.join(".npm/bin").join(binary),
        home_dir.join(".bun/bin").join(binary),
        PathBuf::from("/usr/local/bin").join(binary),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::agent_sessions::types::{
        AgentSessionActiveFlag, AgentSessionCapabilities, AgentSessionRuntime,
        AgentSessionScopeConfidence, AgentSessionSourceMeta, AgentSessionStatusConfidence,
        AgentSessionTitleSource,
    };
    use crate::terminal::AgentTerminalSurface;

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
    }

    fn write_codex_history(home: &Path, source_session_id: &str, cwd: &Path) {
        write(
            &home.join(".codex/history.jsonl"),
            &serde_json::json!({
                "sessionId": source_session_id,
                "cwd": cwd.to_string_lossy(),
                "timestamp": 1700000000,
                "text": source_session_id,
            })
            .to_string(),
        );
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
            source: AgentSessionSource::Codex,
            source_session_id: source_session_id.to_string(),
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
        }
    }

    fn base_session(project: &Path) -> AgentSession {
        AgentSession {
            id: "codex:external".to_string(),
            source: AgentSessionSource::Codex,
            source_session_id: "external".to_string(),
            title: "external".to_string(),
            title_source: AgentSessionTitleSource::SessionId,
            status: AgentSessionStatus::Active,
            active_flags: vec![AgentSessionActiveFlag::WaitingOnUserInput],
            status_source: AgentSessionStatusSource::ProcessScan,
            status_confidence: AgentSessionStatusConfidence::Medium,
            status_reason: None,
            runtime: Some(AgentSessionRuntime::default()),
            project_id: None,
            project_path: Some(project.to_string_lossy().into_owned()),
            scope_kind: AgentSessionScopeKind::Project,
            scope_status: AgentSessionScopeStatus::Ready,
            space_id: None,
            space_path: None,
            scope_confidence: AgentSessionScopeConfidence::Exact,
            cwd: Some(project.to_string_lossy().into_owned()),
            started_at: None,
            last_activity_at: "2026-07-04T10:00:00Z".to_string(),
            waiting_since: None,
            duration_ms: None,
            resume_command: Some(AgentSessionResumeCommand {
                display: "codex resume external".to_string(),
                program: "codex".to_string(),
                args: vec!["resume".to_string(), "external".to_string()],
                cwd: Some(project.to_string_lossy().into_owned()),
            }),
            source_file: None,
            counts: None,
            capabilities: AgentSessionCapabilities::default(),
            pinned: false,
            source_meta: AgentSessionSourceMeta::default(),
        }
    }

    #[test]
    fn agent_sessions_reentry_focuses_existing_live_managed_pty() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "live", &project);

        let state = AgentSessionsState::with_home(home);
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:live".to_string(),
            vec![live_surface("pty-live", "live")],
            |_, _| panic!("cli resolution should not run for focused PTY"),
            |_| panic!("spawn should not run for focused PTY"),
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
        write(&bin, "");
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
        write_codex_history(&home, "done", &project);

        let state = AgentSessionsState::with_home(home.clone());
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:done".to_string(),
            Vec::new(),
            move |session, scope_dir| resolve_agent_cli_binary(session.source, scope_dir, &home),
            |spawn| {
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

    #[test]
    fn agent_sessions_reentry_returns_external_active_unattachable() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let session = base_session(&project);

        let result = reenter_scoped_session(
            &session,
            &project,
            |_, _| Some("/usr/local/bin/codex".to_string()),
            |_| panic!("spawn should not run for external process"),
        )
        .expect("reenter");

        assert_eq!(
            result.mode,
            AgentSessionReentryMode::ExternalActiveUnattachable
        );
        assert_eq!(
            result.error.as_ref().expect("error").code,
            AgentSessionReentryErrorCode::ExternalProcessUnattachable
        );
        assert_eq!(
            result.command.as_ref().expect("command").args,
            vec!["resume", "external"]
        );
    }

    #[test]
    fn agent_sessions_reentry_external_active_does_not_require_cli_resolution() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let session = base_session(&project);

        let result = reenter_scoped_session(
            &session,
            &project,
            |_, _| None,
            |_| panic!("spawn should not run for external process"),
        )
        .expect("reenter");

        assert_eq!(
            result.mode,
            AgentSessionReentryMode::ExternalActiveUnattachable
        );
        assert_eq!(result.command.as_ref().expect("command").program, "codex");
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
        write_codex_history(&home, "missing", &project.join("missing/sub"));

        let state = AgentSessionsState::with_home(home);
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:missing".to_string(),
            Vec::new(),
            |_, _| panic!("cli resolution should not run without cwd"),
            |_| panic!("spawn should not run without cwd"),
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
        write_codex_history(&home, "no-cli", &project);

        let state = AgentSessionsState::with_home(home);
        let result = reenter_session(
            &state,
            project.to_string_lossy().into_owned(),
            "codex:no-cli".to_string(),
            Vec::new(),
            |_, _| None,
            |_| panic!("spawn should not run without cli"),
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
        write(&codex, "");

        let resolved =
            resolve_agent_cli_binary_with(AgentSessionSource::Codex, &project, &home, |_| None)
                .expect("codex path");

        assert_eq!(resolved, canonical_display(&codex));
    }

    #[test]
    fn agent_sessions_reentry_supports_claude_code_custom_path_keys() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let claude = project.join("bin/claude");
        fs::create_dir_all(&project).expect("project");
        write(&claude, "");
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

        let resolved = resolve_agent_cli_binary_with(
            AgentSessionSource::ClaudeCode,
            &project,
            temp.path(),
            |_| None,
        )
        .expect("claude path");

        assert_eq!(resolved, canonical_display(&claude));
    }
}
