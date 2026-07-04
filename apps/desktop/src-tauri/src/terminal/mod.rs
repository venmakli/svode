pub mod commands;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use chrono::{SecondsFormat, Utc};
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent_sessions::types::{
    AgentSessionActiveFlag, AgentSessionResumeCommand, AgentSessionSource, AgentSessionStatus,
};
use crate::error::AppError;
use crate::system_path;

const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";
const ERROR_EVENT: &str = "terminal:error";
const DEFAULT_AGENT_TERMINAL_COLS: u16 = 120;
const DEFAULT_AGENT_TERMINAL_ROWS: u16 = 30;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub pty_id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    pty_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    pty_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalErrorEvent {
    pty_id: String,
    message: String,
}

struct TerminalProcess {
    session: TerminalSession,
    child: Box<dyn PtyChild + Send>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentTerminalSpawn {
    pub agent_session_id: String,
    pub source: AgentSessionSource,
    pub source_session_id: String,
    pub command: AgentSessionResumeCommand,
    pub cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalSurface {
    pub pty_id: String,
    pub agent_session_id: String,
    pub source: AgentSessionSource,
    pub source_session_id: String,
    pub initial_agent_argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_agent_cwd: Option<String>,
    pub shell_cwd: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_input_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_evidence: Option<AgentTerminalStatusEvidence>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalStatusEvidence {
    pub status: AgentSessionStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_flags: Vec<AgentSessionActiveFlag>,
    pub reason: String,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentTerminalStatusSignal {
    active_flags: Vec<AgentSessionActiveFlag>,
    reason: &'static str,
}

#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    agent_surfaces: Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            agent_surfaces: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSession, AppError> {
        let cwd_path = canonical_cwd(&cwd)?;
        let cwd_display = system_path::user_facing_path(&cwd_path);
        let size = pty_size(cols, rows);
        let shell = default_shell();

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| AppError::General(format!("Failed to open terminal PTY: {e}")))?;

        let mut cmd = CommandBuilder::new(shell.program.clone());
        for arg in &shell.args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::General(format!("Failed to spawn terminal shell: {e}")))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::General(format!("Failed to create terminal reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::General(format!("Failed to create terminal writer: {e}")))?;

        let pty_id = ulid::Ulid::new().to_string().to_lowercase();
        let session = TerminalSession {
            pty_id: pty_id.clone(),
            cwd: cwd_display,
            shell: shell.display(),
            cols: size.cols,
            rows: size.rows,
        };

        let process = TerminalProcess {
            session: session.clone(),
            child,
            master: pair.master,
            writer,
        };

        self.sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .insert(pty_id.clone(), process);

        if let Err(e) = spawn_reader_loop(
            app,
            self.sessions.clone(),
            self.agent_surfaces.clone(),
            pty_id.clone(),
            reader,
        ) {
            if let Some(mut process) = self
                .sessions
                .lock()
                .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
                .remove(&pty_id)
            {
                let _ = process.child.kill();
            }
            return Err(e);
        }

        Ok(session)
    }

    pub(crate) fn spawn_agent_shell_session(
        &self,
        app: AppHandle,
        spawn: AgentTerminalSpawn,
    ) -> Result<TerminalSession, AppError> {
        let session = self.spawn(
            app,
            spawn.cwd.clone(),
            DEFAULT_AGENT_TERMINAL_COLS,
            DEFAULT_AGENT_TERMINAL_ROWS,
        )?;
        let surface = agent_surface_from_spawn(
            session.pty_id.clone(),
            session.cwd.clone(),
            spawn.clone(),
            now_rfc3339(),
        );

        if let Err(error) = self.register_agent_surface(surface) {
            let _ = self.kill(&session.pty_id);
            return Err(error);
        }

        if let Err(error) = self.write(
            &session.pty_id,
            &agent_initial_shell_input(&spawn.command.program, &spawn.command.args),
        ) {
            let _ = self.kill(&session.pty_id);
            return Err(error);
        }

        Ok(session)
    }

    pub fn write(&self, pty_id: &str, data: &str) -> Result<(), AppError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        let process = sessions
            .get_mut(pty_id)
            .ok_or_else(|| AppError::General(format!("Terminal session not found: {pty_id}")))?;

        process.writer.write_all(data.as_bytes())?;
        process.writer.flush()?;
        if let Some(surface) = self
            .agent_surfaces
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .get_mut(pty_id)
        {
            surface.last_input_at = Some(now_rfc3339());
            clear_waiting_status_after_input(surface);
        }
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let size = pty_size(cols, rows);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        let process = sessions
            .get_mut(pty_id)
            .ok_or_else(|| AppError::General(format!("Terminal session not found: {pty_id}")))?;

        process
            .master
            .resize(size)
            .map_err(|e| AppError::General(format!("Failed to resize terminal: {e}")))?;
        process.session.cols = size.cols;
        process.session.rows = size.rows;
        Ok(())
    }

    pub fn kill(&self, pty_id: &str) -> Result<(), AppError> {
        let process = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .remove(pty_id);

        let kill_result = if let Some(mut process) = process {
            let result = process
                .child
                .kill()
                .map_err(|e| AppError::General(format!("Failed to kill terminal: {e}")));
            let _ = process.child.wait();
            result
        } else {
            Ok(())
        };
        if let Ok(mut surfaces) = self.agent_surfaces.lock() {
            surfaces.remove(pty_id);
        }

        kill_result
    }

    pub fn kill_all(&self) {
        let processes = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .drain()
                .map(|(_, process)| process)
                .collect::<Vec<_>>(),
            Err(_) => {
                tracing::error!("Failed to kill terminal sessions: state lock poisoned");
                return;
            }
        };

        for mut process in processes {
            if let Err(e) = process.child.kill() {
                tracing::warn!("Failed to kill terminal {}: {e}", process.session.pty_id);
            }
            let _ = process.child.wait();
        }
        if let Ok(mut surfaces) = self.agent_surfaces.lock() {
            surfaces.clear();
        }
    }

    pub fn list(&self) -> Result<Vec<TerminalSession>, AppError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;

        Ok(sessions
            .values()
            .map(|process| process.session.clone())
            .collect())
    }

    #[allow(dead_code)]
    pub(crate) fn register_agent_surface(
        &self,
        surface: AgentTerminalSurface,
    ) -> Result<(), AppError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        if !sessions.contains_key(&surface.pty_id) {
            return Err(AppError::General(format!(
                "Terminal session not found: {}",
                surface.pty_id
            )));
        }
        drop(sessions);

        self.agent_surfaces
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .insert(surface.pty_id.clone(), surface);
        Ok(())
    }

    pub(crate) fn list_agent_surfaces(&self) -> Result<Vec<AgentTerminalSurface>, AppError> {
        let surfaces = self
            .agent_surfaces
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;

        Ok(surfaces.values().cloned().collect())
    }

    #[cfg(test)]
    pub(crate) fn insert_agent_surface_for_test(&self, surface: AgentTerminalSurface) {
        self.agent_surfaces
            .lock()
            .expect("agent surfaces lock")
            .insert(surface.pty_id.clone(), surface);
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_reader_loop(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    agent_surfaces: Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    pty_id: String,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), AppError> {
    let thread_name = format!("terminal-reader-{pty_id}");
    thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            let mut buffer = [0_u8; 8192];

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        update_agent_surface_output(&agent_surfaces, &pty_id, &data);
                        let payload = TerminalOutputEvent {
                            pty_id: pty_id.clone(),
                            data,
                        };
                        if let Err(e) = app.emit(OUTPUT_EVENT, payload) {
                            tracing::warn!("Failed to emit terminal output for {pty_id}: {e}");
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        let payload = TerminalErrorEvent {
                            pty_id: pty_id.clone(),
                            message: e.to_string(),
                        };
                        let _ = app.emit(ERROR_EVENT, payload);
                        break;
                    }
                }
            }

            let process = sessions
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&pty_id));
            if let Some(mut process) = process {
                let _ = process.child.wait();
            }
            if let Ok(mut surfaces) = agent_surfaces.lock() {
                surfaces.remove(&pty_id);
            }

            let _ = app.emit(
                EXIT_EVENT,
                TerminalExitEvent {
                    pty_id: pty_id.clone(),
                },
            );
        })
        .map(|_| ())
        .map_err(|e| AppError::General(format!("Failed to spawn terminal reader thread: {e}")))
}

fn update_agent_surface_output(
    agent_surfaces: &Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    pty_id: &str,
    data: &str,
) {
    let observed_at = now_rfc3339();
    let mut surfaces = match agent_surfaces.lock() {
        Ok(surfaces) => surfaces,
        Err(_) => {
            tracing::warn!("Failed to update agent terminal surface: state lock poisoned");
            return;
        }
    };
    let Some(surface) = surfaces.get_mut(pty_id) else {
        return;
    };

    surface.last_output_at = Some(observed_at.clone());
    if let Some(signal) = classify_agent_terminal_output(surface.source, data) {
        surface.status_evidence = Some(AgentTerminalStatusEvidence {
            status: AgentSessionStatus::Active,
            active_flags: signal.active_flags,
            reason: signal.reason.to_string(),
            observed_at,
        });
    }
}

fn clear_waiting_status_after_input(surface: &mut AgentTerminalSurface) {
    let should_clear = surface
        .status_evidence
        .as_ref()
        .map(|evidence| {
            matches!(evidence.status, AgentSessionStatus::Active)
                && !evidence.active_flags.is_empty()
        })
        .unwrap_or(false);
    if should_clear {
        surface.status_evidence = None;
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn agent_surface_from_spawn(
    pty_id: String,
    shell_cwd: String,
    spawn: AgentTerminalSpawn,
    created_at: String,
) -> AgentTerminalSurface {
    let mut initial_agent_argv = vec![spawn.command.program.clone()];
    initial_agent_argv.extend(spawn.command.args.clone());

    AgentTerminalSurface {
        pty_id,
        agent_session_id: spawn.agent_session_id,
        source: spawn.source,
        source_session_id: spawn.source_session_id,
        initial_agent_argv,
        initial_agent_cwd: spawn.command.cwd,
        shell_cwd,
        created_at,
        last_output_at: None,
        last_input_at: None,
        finished_at: None,
        exit_code: None,
        failure_reason: None,
        status_evidence: None,
    }
}

fn agent_initial_shell_input(program: &str, args: &[String]) -> String {
    format!("{}\n", quote_agent_shell_command(program, args))
}

pub(crate) fn quote_agent_shell_command(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(not(windows))]
fn shell_quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }
    if arg.bytes().all(is_safe_unix_shell_byte) {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\"'\"'"))
}

#[cfg(not(windows))]
fn is_safe_unix_shell_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'_'
            | b'@'
            | b'%'
            | b'+'
            | b'='
            | b':'
            | b','
            | b'.'
            | b'/'
            | b'-'
    )
}

#[cfg(windows)]
fn shell_quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if arg.bytes().all(is_safe_windows_shell_byte) {
        return arg.to_string();
    }

    let mut quoted = String::from("\"");
    for ch in arg.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(windows)]
fn is_safe_windows_shell_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'_'
            | b'@'
            | b'%'
            | b'+'
            | b'='
            | b':'
            | b','
            | b'.'
            | b'/'
            | b'\\'
            | b'-'
    )
}

fn classify_agent_terminal_output(
    source: AgentSessionSource,
    data: &str,
) -> Option<AgentTerminalStatusSignal> {
    let normalized = normalize_terminal_text(data);
    if normalized.trim().is_empty() {
        return None;
    }

    match source {
        AgentSessionSource::Codex => classify_codex_terminal_output(&normalized),
        AgentSessionSource::ClaudeCode => classify_claude_terminal_output(&normalized),
    }
}

fn classify_codex_terminal_output(text: &str) -> Option<AgentTerminalStatusSignal> {
    if text.contains("approval required")
        || text.contains("requires approval")
        || text.contains("approve command")
        || text.contains("allow this command")
        || (text.contains("do you want to allow")
            && (text.contains("command") || text.contains("operation")))
    {
        return Some(AgentTerminalStatusSignal {
            active_flags: vec![AgentSessionActiveFlag::WaitingOnApproval],
            reason: "codex approval prompt",
        });
    }

    if text.contains("waiting for user input")
        || text.contains("waiting on user input")
        || text.contains("please enter your response")
        || text.contains("please respond in the terminal")
    {
        return Some(AgentTerminalStatusSignal {
            active_flags: vec![AgentSessionActiveFlag::WaitingOnUserInput],
            reason: "codex user input prompt",
        });
    }

    None
}

fn classify_claude_terminal_output(text: &str) -> Option<AgentTerminalStatusSignal> {
    if text.contains("permission required")
        || text.contains("allow this tool")
        || text.contains("approve tool")
        || text.contains("do you want to proceed")
    {
        return Some(AgentTerminalStatusSignal {
            active_flags: vec![AgentSessionActiveFlag::WaitingOnApproval],
            reason: "claude approval prompt",
        });
    }

    if text.contains("waiting for your input")
        || text.contains("waiting on your input")
        || text.contains("please enter your response")
        || text.contains("please respond in the terminal")
    {
        return Some(AgentTerminalStatusSignal {
            active_flags: vec![AgentSessionActiveFlag::WaitingOnUserInput],
            reason: "claude user input prompt",
        });
    }

    None
}

fn normalize_terminal_text(data: &str) -> String {
    let mut out = String::new();
    let mut chars = data.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out.to_ascii_lowercase()
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn canonical_cwd(cwd: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(cwd);
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::PathNotAccessible(cwd.to_string()))?;

    if !canonical.is_dir() {
        return Err(AppError::PathNotAccessible(cwd.to_string()));
    }

    Ok(PathBuf::from(system_path::user_facing_path(&canonical)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellCommand {
    program: String,
    args: Vec<String>,
}

impl ShellCommand {
    fn display(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

#[cfg(windows)]
fn default_shell() -> ShellCommand {
    select_windows_shell(|candidate| {
        which::which(candidate)
            .ok()
            .map(|path| path.to_string_lossy().to_string())
    })
}

#[cfg(windows)]
fn select_windows_shell(mut resolve: impl FnMut(&str) -> Option<String>) -> ShellCommand {
    for candidate in ["pwsh", "powershell"] {
        if let Some(program) = resolve(candidate) {
            return ShellCommand {
                program,
                args: Vec::new(),
            };
        }
    }
    ShellCommand {
        program: "cmd.exe".to_string(),
        args: Vec::new(),
    }
}

#[cfg(not(windows))]
fn default_shell() -> ShellCommand {
    select_unix_shell(std::env::var("SHELL").ok().as_deref(), command_exists)
}

#[cfg(not(windows))]
fn select_unix_shell(env_shell: Option<&str>, exists: impl Fn(&str) -> bool) -> ShellCommand {
    if let Some(shell) = env_shell {
        if !shell.trim().is_empty() && exists(shell) {
            return ShellCommand {
                program: shell.to_string(),
                args: vec!["-l".to_string()],
            };
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if exists(candidate) {
            return ShellCommand {
                program: candidate.to_string(),
                args: vec!["-l".to_string()],
            };
        }
    }

    ShellCommand {
        program: "/bin/sh".to_string(),
        args: vec!["-l".to_string()],
    }
}

#[cfg(not(windows))]
fn command_exists(command: &str) -> bool {
    let path = std::path::Path::new(command);
    if path.is_absolute() {
        path.exists()
    } else {
        which::which(command).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_surface() -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: "pty-agent".to_string(),
            agent_session_id: "codex:session".to_string(),
            source: AgentSessionSource::Codex,
            source_session_id: "session".to_string(),
            initial_agent_argv: vec![
                "codex".to_string(),
                "resume".to_string(),
                "session".to_string(),
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

    fn test_spawn() -> AgentTerminalSpawn {
        AgentTerminalSpawn {
            agent_session_id: "codex:session".to_string(),
            source: AgentSessionSource::Codex,
            source_session_id: "session".to_string(),
            command: AgentSessionResumeCommand {
                display: "codex resume session".to_string(),
                program: "/usr/local/bin/codex".to_string(),
                args: vec!["resume".to_string(), "session".to_string()],
                cwd: Some("/tmp/project".to_string()),
            },
            cwd: "/tmp/project".to_string(),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_shell_prefers_valid_shell_env() {
        let shell = select_unix_shell(Some("/custom/zsh"), |candidate| candidate == "/custom/zsh");

        assert_eq!(
            shell,
            ShellCommand {
                program: "/custom/zsh".to_string(),
                args: vec!["-l".to_string()],
            }
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_shell_falls_back_to_standard_shells() {
        let shell = select_unix_shell(Some("/missing/shell"), |candidate| candidate == "/bin/bash");

        assert_eq!(
            shell,
            ShellCommand {
                program: "/bin/bash".to_string(),
                args: vec!["-l".to_string()],
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_prefers_powershell_core() {
        let shell = select_windows_shell(|candidate| {
            (candidate == "pwsh").then(|| "C:\\Program Files\\PowerShell\\pwsh.exe".to_string())
        });

        assert_eq!(
            shell,
            ShellCommand {
                program: "C:\\Program Files\\PowerShell\\pwsh.exe".to_string(),
                args: Vec::new(),
            }
        );
    }

    #[test]
    fn terminal_agent_classifier_detects_codex_approval_prompt() {
        let signal = classify_agent_terminal_output(
            AgentSessionSource::Codex,
            "\u{1b}[33mApproval required: approve command?\u{1b}[0m",
        )
        .expect("approval signal");

        assert_eq!(
            signal.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );
    }

    #[test]
    fn terminal_agent_classifier_detects_claude_user_input_prompt() {
        let signal = classify_agent_terminal_output(
            AgentSessionSource::ClaudeCode,
            "Claude is waiting for your input. Please enter your response.",
        )
        .expect("input signal");

        assert_eq!(
            signal.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnUserInput]
        );
    }

    #[test]
    fn terminal_agent_classifier_ignores_weak_waiting_hints() {
        assert!(
            classify_agent_terminal_output(
                AgentSessionSource::Codex,
                "The task may require approval later, continuing for now.",
            )
            .is_none()
        );
        assert!(
            classify_agent_terminal_output(
                AgentSessionSource::ClaudeCode,
                "Waiting can happen when a tool asks permission.",
            )
            .is_none()
        );
    }

    #[test]
    fn terminal_agent_surfaces_do_not_change_generic_terminal_list() {
        let manager = TerminalManager::new();
        manager.insert_agent_surface_for_test(test_surface());

        assert!(manager.list().expect("list terminals").is_empty());
        assert_eq!(
            manager
                .list_agent_surfaces()
                .expect("list agent surfaces")
                .len(),
            1
        );
    }

    #[test]
    fn terminal_agent_input_clears_waiting_status_evidence() {
        let mut surface = test_surface();
        surface.status_evidence = Some(AgentTerminalStatusEvidence {
            status: AgentSessionStatus::Active,
            active_flags: vec![AgentSessionActiveFlag::WaitingOnUserInput],
            reason: "input prompt".to_string(),
            observed_at: "2026-07-04T10:01:00Z".to_string(),
        });

        clear_waiting_status_after_input(&mut surface);

        assert!(surface.status_evidence.is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn terminal_agent_shell_input_quotes_structured_resume_command() {
        let input = agent_initial_shell_input(
            "/tmp/my codex",
            &[
                "resume".to_string(),
                "session with spaces".to_string(),
                "quote'and;separator".to_string(),
            ],
        );

        assert_eq!(
            input,
            "'/tmp/my codex' resume 'session with spaces' 'quote'\"'\"'and;separator'\n"
        );
    }

    #[test]
    fn terminal_agent_shell_resume_input_does_not_exec_initial_command() {
        let input =
            agent_initial_shell_input("codex", &["resume".to_string(), "session".to_string()]);

        assert_eq!(input, "codex resume session\n");
        assert!(!input.starts_with("exec "));
    }

    #[test]
    fn terminal_agent_spawn_metadata_includes_initial_command_and_shell_cwd() {
        let surface = agent_surface_from_spawn(
            "pty-spawn".to_string(),
            "/tmp/project".to_string(),
            test_spawn(),
            "2026-07-04T10:00:00Z".to_string(),
        );

        assert_eq!(surface.pty_id, "pty-spawn");
        assert_eq!(surface.agent_session_id, "codex:session");
        assert_eq!(
            surface.initial_agent_argv,
            vec!["/usr/local/bin/codex", "resume", "session"]
        );
        assert_eq!(surface.initial_agent_cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(surface.shell_cwd, "/tmp/project");
        assert!(surface.finished_at.is_none());
    }
}
