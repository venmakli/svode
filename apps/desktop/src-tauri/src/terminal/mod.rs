pub mod commands;
mod process_tree;
mod pty_ready;

use std::collections::HashMap;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use svode_core::agent_adapters::{AgentAdapterKind, AgentId};

use chrono::{SecondsFormat, Utc};
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::agent_sessions::terminal_outcomes::{SavedTerminalOutcome, save_terminal_outcome};
use crate::agent_sessions::types::{
    AgentSessionResumeCommand, native_writer_key, terminal_resume_argv,
};
use crate::error::AppError;
use svode_agents::status::{InteractionKind, SessionState, StatusConfidence, StopReason};
use svode_agents::writer::{
    ExternalLiveness, UnknownLiveness, Writer, WriterClaim, WriterRegistry, WriterTarget,
};
use svode_core::system_path;

pub(crate) use process_tree::PtyProcess;
use pty_ready::PtyReady;

const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";
const ERROR_EVENT: &str = "terminal:error";
const DEFAULT_AGENT_TERMINAL_COLS: u16 = 120;
const DEFAULT_AGENT_TERMINAL_ROWS: u16 = 30;
/// How long a forced stop at exit waits for the terminal state lock.
const FORCED_STOP_LOCK_WAIT: Duration = Duration::from_millis(100);
/// How long a write into a PTY that takes no input waits before it checks
/// again that its terminal is still open.
const INPUT_WAIT_SLICE: Duration = Duration::from_millis(100);

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
    /// The project the terminal is opened from, given to its shell.
    mcp_project_path: Option<String>,
    shell_kind: TerminalShellKind,
    child: Box<dyn PtyChild + Send>,
    master: Box<dyn MasterPty + Send>,
    input: TerminalInput,
}

/// The result of one write to a terminal, given to whoever queued it.
type WriteDone = Box<dyn FnOnce(Result<(), AppError>) + Send>;

/// One queued write of input to a terminal.
struct InputWrite {
    data: String,
    done: WriteDone,
}

/// The input side of a terminal: writes go in queue order to a thread that
/// owns the PTY writer, so a PTY that does not read holds that thread alone,
/// never the caller or the `sessions` lock (DF-365 R2).
struct TerminalInput {
    queue: mpsc::Sender<InputWrite>,
    open: Arc<AtomicBool>,
}

impl TerminalInput {
    /// `ready` waits on the PTY whose master does not block (Unix); without
    /// it `writer` blocks until the PTY takes the input.
    fn start(
        pty_id: &str,
        mut writer: Box<dyn Write + Send>,
        ready: Option<PtyReady>,
        agent_surfaces: Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    ) -> Result<Self, AppError> {
        let (queue, writes) = mpsc::channel::<InputWrite>();
        let open = Arc::new(AtomicBool::new(true));
        let still_open = open.clone();
        let pty_id = pty_id.to_string();
        thread::Builder::new()
            .name(format!("terminal-writer-{pty_id}"))
            .spawn(move || {
                // Ends once the terminal is gone and its queue is drained;
                // the writer drops here too, off the caller's thread.
                for write in writes {
                    let result = if still_open.load(Ordering::Acquire) {
                        write_input(
                            &mut *writer,
                            write.data.as_bytes(),
                            ready.as_ref(),
                            &still_open,
                        )
                        .map_err(|error| error.unwrap_or_else(|| session_not_found(&pty_id)))
                        .map(|()| record_input(&agent_surfaces, &pty_id))
                    } else {
                        Err(session_not_found(&pty_id))
                    };
                    (write.done)(result);
                }
            })
            .map_err(|e| {
                AppError::General(format!("Failed to spawn terminal writer thread: {e}"))
            })?;
        Ok(Self { queue, open })
    }

    /// Queues `data` behind the earlier writes; `done` gets its result.
    fn send(&self, pty_id: &str, data: String, done: WriteDone) -> Result<(), AppError> {
        self.queue
            .send(InputWrite { data, done })
            .map_err(|_| session_not_found(pty_id))
    }

    /// The writes still queued fail as for a terminal that is gone.
    fn close(&self) {
        self.open.store(false, Ordering::Release);
    }
}

impl Drop for TerminalInput {
    fn drop(&mut self) {
        self.close();
    }
}

/// Writes all of `data` into the PTY. While a PTY that does not block takes
/// no more input, it waits on `ready` in slices and stops once `open` is
/// cleared (`Err(None)`) or no program can read the PTY any more. The error
/// of the write itself comes as `Err(Some(_))`.
fn write_input(
    writer: &mut dyn Write,
    mut data: &[u8],
    ready: Option<&PtyReady>,
    open: &AtomicBool,
) -> Result<(), Option<AppError>> {
    while !data.is_empty() {
        match writer.write(data) {
            Ok(0) => {
                return Err(Some(
                    std::io::Error::from(std::io::ErrorKind::WriteZero).into(),
                ));
            }
            Ok(written) => data = &data[written..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let Some(ready) = ready else {
                    return Err(Some(error.into()));
                };
                if !open.load(Ordering::Acquire) {
                    return Err(None);
                }
                ready
                    .wait_writable(INPUT_WAIT_SLICE)
                    .map_err(|error| Some(error.into()))?;
            }
            Err(error) => return Err(Some(error.into())),
        }
    }
    writer.flush().map_err(|error| Some(error.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // PowerShell/cmd are constructed only by Windows builds.
enum TerminalShellKind {
    Posix,
    PowerShell,
    Cmd,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResourcePath {
    pub version: u8,
    pub kind: String,
    pub project_path: String,
    pub space_path: String,
    pub relative_path: String,
}

#[derive(Clone)]
pub(crate) struct AgentTerminalSpawn {
    pub agent_session_id: String,
    pub title: Option<String>,
    pub source: AgentId,
    pub source_session_id: String,
    pub command: AgentSessionResumeCommand,
    pub cwd: String,
    pub mcp_project_path: Option<String>,
}

/// How the agent command of a managed terminal ended, in the session status
/// vocabulary: always a stopped turn or unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentTerminalOutcomeEvidence {
    state: SessionState,
    exit_code: Option<i32>,
    reason: String,
    observed_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalSurface {
    pub pty_id: String,
    pub agent_session_id: String,
    #[serde(skip)]
    pub(crate) mcp_project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub source: AgentId,
    pub source_session_id: String,
    pub live: bool,
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
    /// The surface follows its session by the approximate source of Codex
    /// (DF-163 R7), not by an exact record of its process.
    #[serde(skip)]
    pub(crate) approximate_binding: bool,
}

/// A live PTY with the running processes under its shell, the shell first
/// and nearer processes before deeper ones (DF-163 R2).
pub(crate) struct LivePtyProcesses {
    pub pty_id: String,
    /// The directory the shell was started in.
    pub cwd: String,
    pub processes: Vec<PtyProcess>,
}

/// The session the agent process in a live PTY runs now, by the native
/// evidence of that process (DF-163 R2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CurrentPtySession {
    pub pty_id: String,
    pub agent_session_id: String,
    pub source: AgentId,
    pub source_session_id: String,
    /// Told by the approximate source of Codex (DF-163 R7).
    pub approximate: bool,
}

/// Status evidence of a managed PTY: an exit code is exact, a request
/// recognized in the terminal text is approximate.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalStatusEvidence {
    pub state: SessionState,
    pub confidence: StatusConfidence,
    pub reason: String,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentTerminalStatusSignal {
    request: InteractionKind,
    reason: &'static str,
}

type WriterClaims = Arc<Mutex<HashMap<String, WriterClaim>>>;

#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    agent_surfaces: Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    /// The writer registry of the agent runtime; a managed agent PTY holds
    /// its session's writer slot while the terminal lives.
    writers: WriterRegistry,
    writer_claims: WriterClaims,
}

impl TerminalManager {
    pub fn new(writers: WriterRegistry) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            agent_surfaces: Arc::new(Mutex::new(HashMap::new())),
            writers,
            writer_claims: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn writers(&self) -> &WriterRegistry {
        &self.writers
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        cwd: String,
        mcp_project_path: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSession, AppError> {
        self.spawn_with_mcp_context(app, cwd, mcp_project_path, None, cols, rows)
    }

    /// A shell terminal that runs `program` with `args` as its first input,
    /// so the user sees and answers the command as if typed by hand.
    pub(crate) fn spawn_command_shell(
        &self,
        app: AppHandle,
        cwd: String,
        program: &str,
        args: &[String],
    ) -> Result<TerminalSession, AppError> {
        let session = self.spawn(
            app,
            cwd,
            None,
            DEFAULT_AGENT_TERMINAL_COLS,
            DEFAULT_AGENT_TERMINAL_ROWS,
        )?;
        if let Err(error) = self.write(&session.pty_id, &agent_initial_shell_input(program, args)) {
            let _ = self.kill(&session.pty_id);
            return Err(error);
        }
        Ok(session)
    }

    fn spawn_with_mcp_context(
        &self,
        app: AppHandle,
        cwd: String,
        mcp_project_path: Option<String>,
        writer_claim: Option<WriterClaim>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSession, AppError> {
        let cwd_path = canonical_cwd(&cwd)?;
        let cwd_display = system_path::user_facing_path(&cwd_path);
        let mcp_project_path = mcp_project_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(canonical_cwd)
            .transpose()?;
        let size = pty_size(cols, rows);
        let shell = default_shell();

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| AppError::General(format!("Failed to open terminal PTY: {e}")))?;

        let mut cmd = shell_command(&shell, &cwd_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Ok(discovery_path) = crate::mcp::ipc::discovery_path_for_app(&app) {
            cmd.env(
                svode_mcp::MCP_DISCOVERY_ENV,
                system_path::user_facing_path(&discovery_path),
            );
        }
        let mcp_project_path = mcp_project_path.map(|path| system_path::user_facing_path(&path));
        if let Some(path) = &mcp_project_path {
            cmd.env(svode_mcp::MCP_PROJECT_PATH_ENV, path);
        }

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
        let input = master_ready(&*pair.master).and_then(|(read_ready, write_ready)| {
            let input =
                TerminalInput::start(&pty_id, writer, write_ready, self.agent_surfaces.clone())?;
            Ok((input, read_ready))
        });
        let (input, read_ready) = match input {
            Ok(input) => input,
            Err(error) => {
                let mut child = child;
                let _ = child.kill();
                return Err(error);
            }
        };
        let session = TerminalSession {
            pty_id: pty_id.clone(),
            cwd: cwd_display,
            shell: shell.display(),
            cols: size.cols,
            rows: size.rows,
        };

        let process = TerminalProcess {
            session: session.clone(),
            mcp_project_path,
            shell_kind: shell.kind,
            child,
            master: pair.master,
            input,
        };

        self.sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .insert(pty_id.clone(), process);
        // Held before the reader loop starts, which releases it on exit.
        if let Some(claim) = writer_claim {
            self.writer_claims
                .lock()
                .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
                .insert(pty_id.clone(), claim);
        }

        if let Err(e) = spawn_reader_loop(
            app,
            self.sessions.clone(),
            self.agent_surfaces.clone(),
            self.writer_claims.clone(),
            pty_id.clone(),
            reader,
            read_ready,
        ) {
            if let Some(mut process) = self
                .sessions
                .lock()
                .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
                .remove(&pty_id)
            {
                let _ = process.child.kill();
            }
            release_writer(&self.writer_claims, &pty_id);
            return Err(e);
        }

        Ok(session)
    }

    /// Starts the agent CLI in a managed PTY that holds `writer_claim`,
    /// taken by the caller before the start.
    pub(crate) fn spawn_agent_shell_session(
        &self,
        app: AppHandle,
        spawn: AgentTerminalSpawn,
        writer_claim: WriterClaim,
    ) -> Result<TerminalSession, AppError> {
        let session = self.spawn_with_mcp_context(
            app,
            spawn.cwd.clone(),
            spawn.mcp_project_path.clone(),
            Some(writer_claim),
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

    pub(crate) fn register_existing_agent_session(
        &self,
        pty_id: String,
        agent_session_id: String,
        title: Option<String>,
        source: AgentId,
        source_session_id: String,
        shell_cwd: Option<String>,
        created_at: Option<String>,
    ) -> Result<(), AppError> {
        let (session_cwd, mcp_project_path) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
            let process = sessions.get(&pty_id).ok_or_else(|| {
                AppError::General(format!("Terminal session not found: {pty_id}"))
            })?;
            (
                process.session.cwd.clone(),
                process.mcp_project_path.clone(),
            )
        };

        self.hold_existing_session_writer(&pty_id, &source, &source_session_id)?;

        let surface = agent_surface_from_existing_session(
            pty_id,
            agent_session_id,
            title,
            source,
            source_session_id,
            mcp_project_path,
            shell_cwd.unwrap_or(session_cwd),
            created_at.unwrap_or_else(now_rfc3339),
        );

        self.register_agent_surface(surface)
    }

    /// A shell tab where the user started the agent CLI becomes the writer
    /// of the session it is linked to. The CLI already runs in this PTY, so
    /// the only evidence at hand about other processes is none.
    fn hold_existing_session_writer(
        &self,
        pty_id: &str,
        source: &AgentId,
        source_session_id: &str,
    ) -> Result<(), AppError> {
        let key = native_writer_key(source, source_session_id);
        let mut claims = self
            .writer_claims
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        if claims
            .get(pty_id)
            .is_some_and(|claim| claim.target() == &WriterTarget::Session(key.clone()))
        {
            return Ok(());
        }
        claims.remove(pty_id);
        let claim = self
            .writers
            .claim(
                &key,
                Writer::Pty,
                ExternalLiveness::Unknown,
                UnknownLiveness::NotConfirmed,
            )
            .map_err(|refusal| svode_agents::AgentRuntimeError::WriterRefused { refusal })?;
        claims.insert(pty_id.to_string(), claim);
        Ok(())
    }

    /// Queues `data` for the PTY of `pty_id` behind the earlier writes and
    /// returns at once; `done` gets the result of the write. The `sessions`
    /// lock is held only to queue it (DF-365 R2).
    fn queue_write(
        &self,
        pty_id: &str,
        data: String,
        done: impl FnOnce(Result<(), AppError>) + Send + 'static,
    ) -> Result<(), AppError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        let process = sessions
            .get(pty_id)
            .ok_or_else(|| session_not_found(pty_id))?;
        process.input.send(pty_id, data, Box::new(done))
    }

    /// Queues `data` in call order and gives the result of its write as a
    /// future, which waits without holding a thread; for `terminal_write`.
    pub(crate) fn write_queued(
        &self,
        pty_id: &str,
        data: String,
    ) -> Result<impl Future<Output = Result<(), AppError>> + Send + use<>, AppError> {
        let (done, written) = tokio::sync::oneshot::channel();
        self.queue_write(pty_id, data, move |result| {
            let _ = done.send(result);
        })?;
        let pty_id = pty_id.to_string();
        Ok(async move {
            written
                .await
                .unwrap_or_else(|_| Err(session_not_found(&pty_id)))
        })
    }

    /// Writes `data` and waits for its result, for a caller off the main
    /// thread that goes on only after its input is in the PTY.
    pub fn write(&self, pty_id: &str, data: &str) -> Result<(), AppError> {
        let (done, written) = mpsc::sync_channel(1);
        self.queue_write(pty_id, data.to_string(), move |result| {
            let _ = done.send(result);
        })?;
        written
            .recv()
            .unwrap_or_else(|_| Err(session_not_found(pty_id)))
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
            process.input.close();
            let result = process
                .child
                .kill()
                .map_err(|e| AppError::General(format!("Failed to kill terminal: {e}")));
            let _ = process.child.wait();
            result
        } else {
            Ok(())
        };
        self.finish_surface(
            pty_id,
            INTERRUPTED,
            None,
            "managed terminal stopped by user",
        );
        release_writer(&self.writer_claims, pty_id);

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
        let pty_ids = self
            .agent_surfaces
            .lock()
            .map(|surfaces| surfaces.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for pty_id in pty_ids {
            self.finish_surface(
                &pty_id,
                INTERRUPTED,
                None,
                "managed terminal stopped during application shutdown",
            );
        }
        if let Ok(mut claims) = self.writer_claims.lock() {
            claims.clear();
        }
    }

    /// Signals every terminal process still here to stop and returns at
    /// once, for a host that exits without waiting for `kill_all` (DF-365 R3
    /// step 3, R4). It sends the signal `kill` starts with (SIGHUP to the
    /// shell, which hangs up its jobs; termination on Windows) without the
    /// grace sleep, `wait` or recorded outcome, and leaves the terminals
    /// listed. It waits for the state lock only a bounded moment, so a PTY
    /// write that does not progress under that lock cannot hold the exit.
    pub(crate) fn force_stop_all(&self) {
        let Some(sessions) = lock_within(&self.sessions, FORCED_STOP_LOCK_WAIT) else {
            tracing::warn!("terminals were not signalled at exit: their state stayed locked");
            return;
        };
        for process in sessions.values() {
            if let Err(error) = process.child.clone_killer().kill() {
                tracing::warn!(
                    "Failed to signal terminal {}: {error}",
                    process.session.pty_id
                );
            }
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

    pub fn prepare_paths(&self, pty_id: &str, paths: Vec<String>) -> Result<String, AppError> {
        let shell_kind = self.shell_kind(pty_id)?;
        prepare_terminal_paths(shell_kind, paths)
    }

    pub fn prepare_resource_paths(
        &self,
        pty_id: &str,
        resources: Vec<TerminalResourcePath>,
    ) -> Result<String, AppError> {
        let shell_kind = self.shell_kind(pty_id)?;
        let paths = resources
            .into_iter()
            .map(resolve_terminal_resource_path)
            .collect::<Result<Vec<_>, _>>()?;
        prepare_terminal_paths(shell_kind, paths)
    }

    fn shell_kind(&self, pty_id: &str) -> Result<TerminalShellKind, AppError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
        sessions
            .get(pty_id)
            .map(|process| process.shell_kind)
            .ok_or_else(|| AppError::General(format!("Terminal session not found: {pty_id}")))
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

    /// The live PTYs with the running processes under their shells
    /// (DF-163 R2); the process table is read only when a PTY lives.
    pub(crate) fn live_pty_processes(&self) -> Result<Vec<LivePtyProcesses>, AppError> {
        let shells = self
            .sessions
            .lock()
            .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?
            .iter()
            .filter_map(|(pty_id, process)| {
                Some((
                    pty_id.clone(),
                    process.session.cwd.clone(),
                    process.child.process_id()?,
                ))
            })
            .collect::<Vec<_>>();
        let pids = shells.iter().map(|(_, _, pid)| *pid).collect::<Vec<_>>();
        let mut trees = process_tree::descendants(&pids);
        Ok(shells
            .into_iter()
            .map(|(pty_id, cwd, pid)| LivePtyProcesses {
                pty_id,
                cwd,
                processes: trees.remove(&pid).unwrap_or_default(),
            })
            .collect())
    }

    /// Moves each live PTY to the session its agent process runs now
    /// (DF-163 R3): the surface takes the session's keys and drops the
    /// approximate evidence read from the text of the session it leaves; its
    /// writer claim leaves the previous key and takes the new one. A PTY
    /// without a surface becomes the surface of that session, as a shell tab
    /// linked to its session does. A key another writer of Svode holds stays
    /// with it, and the surface moves all the same: the process already runs
    /// that session (R6). A finished agent command keeps its outcome, and a
    /// launch whose canonical session is not known yet moves by its launch id
    /// (R5).
    pub(crate) fn follow_current_sessions(
        &self,
        current: &[CurrentPtySession],
    ) -> Result<(), AppError> {
        for current in current {
            // Held until the claim is taken: the reader of an exiting PTY
            // removes it here before it releases the writer.
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
            let Some(process) = sessions.get(&current.pty_id) else {
                continue;
            };
            {
                let mut surfaces = self
                    .agent_surfaces
                    .lock()
                    .map_err(|_| AppError::General("Terminal state lock poisoned".to_string()))?;
                match surfaces.get_mut(&current.pty_id) {
                    Some(surface) => {
                        if surface.finished_at.is_some()
                            || (surface.source == current.source
                                && surface.source_session_id == current.source_session_id)
                        {
                            continue;
                        }
                        tracing::info!(
                            pty_id = current.pty_id,
                            from = surface.agent_session_id,
                            to = current.agent_session_id,
                            "managed terminal follows the session its agent process runs"
                        );
                        surface.agent_session_id = current.agent_session_id.clone();
                        surface.source = current.source.clone();
                        surface.source_session_id = current.source_session_id.clone();
                        surface.title = None;
                        surface.status_evidence = None;
                        surface.approximate_binding = current.approximate;
                    }
                    None => {
                        surfaces.insert(
                            current.pty_id.clone(),
                            agent_surface_from_existing_session(
                                current.pty_id.clone(),
                                current.agent_session_id.clone(),
                                None,
                                current.source.clone(),
                                current.source_session_id.clone(),
                                process.mcp_project_path.clone(),
                                process.session.cwd.clone(),
                                now_rfc3339(),
                            ),
                        );
                    }
                }
            }
            if let Err(error) = self.hold_existing_session_writer(
                &current.pty_id,
                &current.source,
                &current.source_session_id,
            ) {
                tracing::warn!(
                    pty_id = current.pty_id,
                    agent_session_id = current.agent_session_id,
                    "managed terminal runs a session another writer holds: {error}"
                );
            }
            drop(sessions);
        }
        Ok(())
    }

    /// The surface stays with its exact outcome while the app runs
    /// (DF-169 R2); the writer goes with the process.
    fn finish_surface(
        &self,
        pty_id: &str,
        state: SessionState,
        exit_code: Option<i32>,
        reason: &str,
    ) {
        let observed_at = now_rfc3339();
        let outcome = AgentTerminalOutcomeEvidence {
            state,
            exit_code,
            reason: reason.to_string(),
            observed_at: observed_at.clone(),
        };
        let finished = self.agent_surfaces.lock().ok().and_then(|mut surfaces| {
            let surface = surfaces.get_mut(pty_id)?;
            surface.live = false;
            if surface.finished_at.is_some() {
                return None;
            }
            surface.finished_at = Some(observed_at.clone());
            surface.exit_code = exit_code;
            surface.failure_reason = Some(reason.to_string());
            surface.status_evidence = Some(outcome_status_evidence(
                state,
                reason.to_string(),
                observed_at.clone(),
            ));
            saved_outcome(surface, &outcome)
        });
        if let Some((project, saved)) = finished {
            save_terminal_outcome(&project, &saved);
        }
    }

    #[cfg(test)]
    pub(crate) fn insert_agent_surface_for_test(&self, surface: AgentTerminalSurface) {
        self.agent_surfaces
            .lock()
            .expect("agent surfaces lock")
            .insert(surface.pty_id.clone(), surface);
    }

    /// A live shell in a PTY as `terminal_spawn` starts it for a tab of the
    /// project at `cwd`, without the app-bound environment and output reader.
    #[cfg(test)]
    pub(crate) fn insert_shell_for_test(&self, pty_id: &str, cwd: &Path) {
        self.insert_program_for_test(pty_id, cwd, default_shell());
    }

    /// The terminal `pty_id` running `shell` in a PTY, without the app-bound
    /// environment and output reader.
    #[cfg(test)]
    fn insert_program_for_test(&self, pty_id: &str, cwd: &Path, shell: ShellCommand) {
        let size = pty_size(80, 24);
        let pair = native_pty_system().openpty(size).expect("open PTY");
        let child = pair
            .slave
            .spawn_command(shell_command(&shell, cwd))
            .expect("spawn shell");
        let writer = pair.master.take_writer().expect("PTY writer");
        let (_, write_ready) = master_ready(&*pair.master).expect("PTY readiness");
        let input = TerminalInput::start(pty_id, writer, write_ready, self.agent_surfaces.clone())
            .expect("terminal writer");
        let process = TerminalProcess {
            session: TerminalSession {
                pty_id: pty_id.to_string(),
                cwd: system_path::user_facing_path(cwd),
                shell: shell.display(),
                cols: size.cols,
                rows: size.rows,
            },
            mcp_project_path: Some(system_path::user_facing_path(cwd)),
            shell_kind: shell.kind,
            child,
            master: pair.master,
            input,
        };
        self.sessions
            .lock()
            .expect("terminal sessions lock")
            .insert(pty_id.to_string(), process);
    }
}

fn spawn_reader_loop(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    agent_surfaces: Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    writer_claims: WriterClaims,
    pty_id: String,
    mut reader: Box<dyn Read + Send>,
    ready: Option<PtyReady>,
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
                        // A master that does not block has no output yet.
                        let e = match &ready {
                            Some(ready) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                match ready.wait_readable() {
                                    Ok(()) => continue,
                                    Err(e) => e,
                                }
                            }
                            _ => e,
                        };
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
            finish_reader_surface(&agent_surfaces, &pty_id);
            release_writer(&writer_claims, &pty_id);
            crate::git::turns::terminal_exited(&app, &pty_id);

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

/// Makes the master of a new terminal non-blocking where its reader and
/// writer must wait on it (Unix) and gives one waiter to each of them.
#[cfg(unix)]
fn master_ready(master: &dyn MasterPty) -> Result<(Option<PtyReady>, Option<PtyReady>), AppError> {
    Ok((Some(PtyReady::of(master)?), Some(PtyReady::of(master)?)))
}

/// The ConPTY pipes stay blocking: nothing to wait on.
#[cfg(not(unix))]
fn master_ready(_master: &dyn MasterPty) -> Result<(Option<PtyReady>, Option<PtyReady>), AppError> {
    Ok((None, None))
}

/// Takes `mutex` if it frees up within `wait`; a poisoned lock is taken too.
fn lock_within<T>(mutex: &Mutex<T>, wait: Duration) -> Option<MutexGuard<'_, T>> {
    let deadline = Instant::now() + wait;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

fn session_not_found(pty_id: &str) -> AppError {
    AppError::General(format!("Terminal session not found: {pty_id}"))
}

/// Input reached the PTY of `pty_id`: an agent waiting for it goes on.
fn record_input(agent_surfaces: &Arc<Mutex<HashMap<String, AgentTerminalSurface>>>, pty_id: &str) {
    let Ok(mut surfaces) = agent_surfaces.lock() else {
        tracing::warn!("Failed to record terminal input: state lock poisoned");
        return;
    };
    if let Some(surface) = surfaces.get_mut(pty_id) {
        surface.last_input_at = Some(now_rfc3339());
        clear_waiting_status_after_input(surface);
    }
}

/// The terminal is gone, and with it the writer of its session.
fn release_writer(writer_claims: &WriterClaims, pty_id: &str) {
    if let Ok(mut claims) = writer_claims.lock() {
        claims.remove(pty_id);
    }
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
    if let Some(signal) = classify_agent_terminal_output(&surface.source, data) {
        surface.status_evidence = Some(AgentTerminalStatusEvidence {
            state: SessionState::RequiresAction {
                request: signal.request,
            },
            confidence: StatusConfidence::Approximate,
            reason: signal.reason.to_string(),
            observed_at,
        });
    }
}

fn finish_reader_surface(
    agent_surfaces: &Arc<Mutex<HashMap<String, AgentTerminalSurface>>>,
    pty_id: &str,
) {
    let observed_at = now_rfc3339();
    let outcome = agent_surfaces.lock().ok().and_then(|mut surfaces| {
        let surface = surfaces.get_mut(pty_id)?;
        surface.live = false;
        if surface.finished_at.is_some() {
            return None;
        }
        let reason =
            "managed terminal shell exited before terminal outcome was observed".to_string();
        surface.finished_at = Some(observed_at.clone());
        surface.failure_reason = Some(reason.clone());
        surface.status_evidence = Some(outcome_status_evidence(
            INTERRUPTED,
            reason.clone(),
            observed_at.clone(),
        ));
        let outcome = AgentTerminalOutcomeEvidence {
            state: INTERRUPTED,
            exit_code: None,
            reason,
            observed_at: observed_at.clone(),
        };
        saved_outcome(surface, &outcome)
    });
    if let Some((project, saved)) = outcome {
        save_terminal_outcome(&project, &saved);
    }
}

/// The outcome as the catalogue saves it in the project the terminal is
/// opened from; a terminal without a project keeps it in memory alone
/// (DF-164 R2).
fn saved_outcome(
    surface: &AgentTerminalSurface,
    outcome: &AgentTerminalOutcomeEvidence,
) -> Option<(PathBuf, SavedTerminalOutcome)> {
    let project = surface.mcp_project_path.as_deref()?;
    Some((
        PathBuf::from(project),
        SavedTerminalOutcome {
            agent_session_id: surface.agent_session_id.clone(),
            source: surface.source.clone(),
            source_session_id: surface.source_session_id.clone(),
            launch_id: None,
            state: outcome.state,
            exit_code: outcome.exit_code,
            reason: outcome.reason.clone(),
            observed_at: outcome.observed_at.clone(),
        },
    ))
}

/// The agent process ended without a turn result: stopped by the user, by the
/// application exit, or together with its shell.
const INTERRUPTED: SessionState = SessionState::Idle {
    stop_reason: Some(StopReason::Interrupted),
};

/// The process ended: Svode observed it, so the evidence is exact.
fn outcome_status_evidence(
    state: SessionState,
    reason: String,
    observed_at: String,
) -> AgentTerminalStatusEvidence {
    AgentTerminalStatusEvidence {
        state,
        confidence: StatusConfidence::Exact,
        reason,
        observed_at,
    }
}

/// An exit code says only that the process ended: no stop reason on success,
/// `error` on any non-zero code.
pub(crate) fn agent_exit_outcome(exit_code: i32) -> (SessionState, String) {
    if exit_code == 0 {
        (
            SessionState::Idle { stop_reason: None },
            "initial agent command exited successfully".to_string(),
        )
    } else {
        (
            SessionState::Idle {
                stop_reason: Some(StopReason::Error),
            },
            format!("initial agent command exited with code {exit_code}"),
        )
    }
}

fn clear_waiting_status_after_input(surface: &mut AgentTerminalSurface) {
    let should_clear = surface
        .status_evidence
        .as_ref()
        .is_some_and(|evidence| matches!(evidence.state, SessionState::RequiresAction { .. }));
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
        mcp_project_path: spawn.mcp_project_path,
        title: spawn.title,
        source: spawn.source,
        source_session_id: spawn.source_session_id,
        live: true,
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
        approximate_binding: false,
    }
}

fn agent_surface_from_existing_session(
    pty_id: String,
    agent_session_id: String,
    title: Option<String>,
    source: AgentId,
    source_session_id: String,
    mcp_project_path: Option<String>,
    shell_cwd: String,
    created_at: String,
) -> AgentTerminalSurface {
    AgentTerminalSurface {
        pty_id,
        agent_session_id,
        mcp_project_path,
        title,
        initial_agent_argv: terminal_resume_argv(&source, &source_session_id, None)
            .unwrap_or_default(),
        source,
        source_session_id: source_session_id.clone(),
        live: true,
        initial_agent_cwd: None,
        shell_cwd,
        created_at,
        last_output_at: None,
        last_input_at: None,
        finished_at: None,
        exit_code: None,
        failure_reason: None,
        status_evidence: None,
        approximate_binding: false,
    }
}

fn agent_initial_shell_input(program: &str, args: &[String]) -> String {
    format!(
        "{}{}",
        quote_agent_shell_command(program, args),
        shell_submit_sequence()
    )
}

#[cfg(windows)]
fn shell_submit_sequence() -> &'static str {
    // ConPTY receives keyboard input rather than a redirected command stream.
    // PowerShell treats LF as a multiline line-feed, while CR is the Enter key.
    "\r"
}

#[cfg(not(windows))]
fn shell_submit_sequence() -> &'static str {
    "\n"
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
    source: &AgentId,
    data: &str,
) -> Option<AgentTerminalStatusSignal> {
    let normalized = normalize_terminal_text(data);
    if normalized.trim().is_empty() {
        return None;
    }

    // Terminal heuristics exist only for the agents Svode starts in a
    // managed PTY.
    match source.builtin() {
        Some(AgentAdapterKind::Codex) => classify_codex_terminal_output(&normalized),
        Some(AgentAdapterKind::ClaudeCode) => classify_claude_terminal_output(&normalized),
        _ => None,
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
            request: InteractionKind::Permission,
            reason: "codex approval prompt",
        });
    }

    if text.contains("waiting for user input")
        || text.contains("waiting on user input")
        || text.contains("please enter your response")
        || text.contains("please respond in the terminal")
    {
        return Some(AgentTerminalStatusSignal {
            request: InteractionKind::Question,
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
            request: InteractionKind::Permission,
            reason: "claude approval prompt",
        });
    }

    if text.contains("waiting for your input")
        || text.contains("waiting on your input")
        || text.contains("please enter your response")
        || text.contains("please respond in the terminal")
    {
        return Some(AgentTerminalStatusSignal {
            request: InteractionKind::Question,
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
    kind: TerminalShellKind,
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

/// The shell of a terminal in `cwd` with the app's environment, except the
/// Secret overrides, which a terminal Svode starts does not inherit.
fn shell_command(shell: &ShellCommand, cwd: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell.program.clone());
    for arg in &shell.args {
        command.arg(arg);
    }
    command.cwd(cwd);
    for key in svode_core::variables::inherited_secret_environment() {
        command.env_remove(key);
    }
    command
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
                kind: TerminalShellKind::PowerShell,
            };
        }
    }
    ShellCommand {
        program: "cmd.exe".to_string(),
        args: Vec::new(),
        kind: TerminalShellKind::Cmd,
    }
}

#[cfg(not(windows))]
fn default_shell() -> ShellCommand {
    ShellCommand {
        program: crate::process::shell::login_shell(),
        args: vec!["-l".to_string()],
        kind: TerminalShellKind::Posix,
    }
}

fn prepare_terminal_paths(
    shell_kind: TerminalShellKind,
    paths: Vec<String>,
) -> Result<String, AppError> {
    if paths.is_empty() {
        return Err(AppError::General("No terminal paths supplied".to_string()));
    }

    paths
        .into_iter()
        .map(|path| {
            validate_terminal_path(&path)?;
            Ok(quote_terminal_path(shell_kind, &path))
        })
        .collect::<Result<Vec<_>, AppError>>()
        .map(|tokens| tokens.join(" "))
}

fn validate_terminal_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err(AppError::General(
            "Terminal path contains unsupported characters".to_string(),
        ));
    }
    // A network share is not looked at: even its metadata reaches the server
    // (Stage 10 `08` security).
    let candidate = Path::new(path);
    if system_path::is_network_path(path) || !candidate.is_absolute() || !candidate.exists() {
        return Err(AppError::General(
            "Terminal path is not accessible".to_string(),
        ));
    }
    Ok(())
}

fn resolve_terminal_resource_path(resource: TerminalResourcePath) -> Result<String, AppError> {
    if resource.version != 1
        || !matches!(resource.kind.as_str(), "file" | "folder" | "collection")
        || resource.relative_path.is_empty()
        || resource.relative_path.chars().any(char::is_control)
    {
        return Err(AppError::General(
            "Invalid terminal resource payload".to_string(),
        ));
    }

    let relative = Path::new(&resource.relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::General(
            "Terminal resource escapes its scope".to_string(),
        ));
    }

    let project = Path::new(&resource.project_path)
        .canonicalize()
        .map_err(|_| {
            AppError::General("Terminal resource project is not accessible".to_string())
        })?;
    let space = Path::new(&resource.space_path)
        .canonicalize()
        .map_err(|_| AppError::General("Terminal resource scope is not accessible".to_string()))?;
    if !space.starts_with(&project) {
        return Err(AppError::General(
            "Terminal resource escapes its project".to_string(),
        ));
    }

    let resolved = space
        .join(relative)
        .canonicalize()
        .map_err(|_| AppError::General("Terminal resource is not accessible".to_string()))?;
    if !resolved.starts_with(&space) {
        return Err(AppError::General(
            "Terminal resource escapes its scope".to_string(),
        ));
    }

    Ok(system_path::user_facing_path(&resolved))
}

fn quote_terminal_path(shell_kind: TerminalShellKind, path: &str) -> String {
    match shell_kind {
        TerminalShellKind::Posix => format!("'{}'", path.replace('\'', "'\"'\"'")),
        TerminalShellKind::PowerShell => format!("'{}'", path.replace('\'', "''")),
        TerminalShellKind::Cmd => quote_cmd_terminal_path(path),
    }
}

fn quote_cmd_terminal_path(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len());
    for ch in path.chars() {
        if matches!(
            ch,
            ' ' | '\t' | '&' | '<' | '>' | '|' | '(' | ')' | '^' | '!' | '%' | '\''
        ) {
            quoted.push('^');
        }
        quoted.push(ch);
    }
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R9 of DF-367: the shell of a terminal, and so an agent started in
    /// it, gets no `SVODE_SECRET_*` of the app; other variables stay.
    #[test]
    fn a_terminal_shell_does_not_inherit_secret_overrides() {
        const CHILD: &str = "SVODE_TERMINAL_SECRET_ENV_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let command = shell_command(&default_shell(), Path::new("/"));
            assert_eq!(command.get_env("SVODE_SECRET_LEAK"), None);
            assert_eq!(
                command.get_env("SVODE_VISIBLE"),
                Some(std::ffi::OsStr::new("visible"))
            );
            assert!(
                command
                    .iter_full_env_as_str()
                    .all(|(key, _)| !key.starts_with("SVODE_SECRET_"))
            );
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "terminal::tests::a_terminal_shell_does_not_inherit_secret_overrides",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("SVODE_SECRET_LEAK", "leak")
            .env("SVODE_VISIBLE", "visible")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("1 passed;"), "{stdout}");
    }

    fn test_surface() -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: "pty-agent".to_string(),
            agent_session_id: "codex:session".to_string(),
            mcp_project_path: None,
            title: Some("Test session".to_string()),
            source: AgentAdapterKind::Codex.id(),
            source_session_id: "session".to_string(),
            live: true,
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
            approximate_binding: false,
        }
    }

    fn test_spawn() -> AgentTerminalSpawn {
        AgentTerminalSpawn {
            agent_session_id: "codex:session".to_string(),
            title: Some("Test session".to_string()),
            source: AgentAdapterKind::Codex.id(),
            source_session_id: "session".to_string(),
            command: AgentSessionResumeCommand {
                display: "codex resume session".to_string(),
                program: "/usr/local/bin/codex".to_string(),
                args: vec!["resume".to_string(), "session".to_string()],
                cwd: Some("/tmp/project".to_string()),
            },
            cwd: "/tmp/project".to_string(),
            mcp_project_path: Some("/tmp/project".to_string()),
        }
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
                kind: TerminalShellKind::PowerShell,
            }
        );
    }

    #[test]
    fn terminal_paths_are_quoted_for_each_shell() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("кириллица & it's 100%.md");
        std::fs::write(&path, "test").expect("write path");
        let display = system_path::user_facing_path(&path);

        assert_eq!(
            prepare_terminal_paths(TerminalShellKind::Posix, vec![display.clone()])
                .expect("posix path"),
            format!("'{}'", display.replace('\'', "'\"'\"'"))
        );
        assert_eq!(
            prepare_terminal_paths(TerminalShellKind::PowerShell, vec![display.clone()])
                .expect("powershell path"),
            format!("'{}'", display.replace('\'', "''"))
        );
        assert_eq!(
            prepare_terminal_paths(TerminalShellKind::Cmd, vec![display.clone()])
                .expect("cmd path"),
            display
                .chars()
                .flat_map(|ch| {
                    if matches!(
                        ch,
                        ' ' | '\t' | '&' | '<' | '>' | '|' | '(' | ')' | '^' | '!' | '%' | '\''
                    ) {
                        vec!['^', ch]
                    } else {
                        vec![ch]
                    }
                })
                .collect::<String>()
        );
    }

    #[test]
    fn terminal_paths_keep_multiple_paths_as_separate_tokens() {
        let temp = tempfile::tempdir().expect("temp dir");
        let first = temp.path().join("first file.md");
        let second = temp.path().join("second.md");
        std::fs::write(&first, "one").expect("write first");
        std::fs::write(&second, "two").expect("write second");

        let prepared = prepare_terminal_paths(
            TerminalShellKind::Posix,
            vec![
                system_path::user_facing_path(&first),
                system_path::user_facing_path(&second),
            ],
        )
        .expect("multiple paths");

        assert!(prepared.contains("' '"));
        assert!(!prepared.contains('\n'));
        assert!(!prepared.contains('\r'));
    }

    #[test]
    fn terminal_paths_reject_control_characters() {
        let error = prepare_terminal_paths(
            TerminalShellKind::Posix,
            vec![format!("{}\nunsafe", std::env::temp_dir().display())],
        )
        .expect_err("control character should fail");

        assert!(error.to_string().contains("unsupported characters"));
    }

    #[test]
    fn terminal_paths_reject_a_network_share_unread() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "notes").unwrap();
        let mut paths = vec![
            r"\\server\share\a.md".to_string(),
            "//server/share/a.md".to_string(),
        ];
        // On Unix the same file through two separators.
        if cfg!(unix) {
            paths.push(format!("/{}", file.display()));
        }
        for path in paths {
            assert!(
                prepare_terminal_paths(TerminalShellKind::Posix, vec![path.clone()]).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn terminal_resource_path_resolves_inside_scope() {
        let project = tempfile::tempdir().expect("project");
        let space = project.path().join("space");
        std::fs::create_dir(&space).expect("create space");
        let document = space.join("docs").join("note.md");
        std::fs::create_dir(space.join("docs")).expect("create docs");
        std::fs::write(&document, "note").expect("write document");

        let resolved = resolve_terminal_resource_path(TerminalResourcePath {
            version: 1,
            kind: "file".to_string(),
            project_path: system_path::user_facing_path(project.path()),
            space_path: system_path::user_facing_path(&space),
            relative_path: "docs/note.md".to_string(),
        })
        .expect("resource path");

        assert_eq!(
            resolved,
            system_path::user_facing_path(&document.canonicalize().expect("canonical document"))
        );
    }

    #[test]
    fn terminal_resource_path_rejects_scope_traversal() {
        let project = tempfile::tempdir().expect("project");
        let space = project.path().join("space");
        std::fs::create_dir(&space).expect("create space");
        std::fs::write(project.path().join("outside.md"), "outside").expect("write outside");

        let error = resolve_terminal_resource_path(TerminalResourcePath {
            version: 1,
            kind: "file".to_string(),
            project_path: system_path::user_facing_path(project.path()),
            space_path: system_path::user_facing_path(&space),
            relative_path: "../outside.md".to_string(),
        })
        .expect_err("traversal should fail");

        assert!(error.to_string().contains("escapes its scope"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_resource_path_rejects_symlink_traversal() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().expect("project");
        let space = project.path().join("space");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::create_dir(&space).expect("create space");
        std::fs::write(outside.path().join("secret.md"), "secret").expect("write outside");
        symlink(outside.path(), space.join("escape")).expect("create symlink");

        let error = resolve_terminal_resource_path(TerminalResourcePath {
            version: 1,
            kind: "file".to_string(),
            project_path: system_path::user_facing_path(project.path()),
            space_path: system_path::user_facing_path(&space),
            relative_path: "escape/secret.md".to_string(),
        })
        .expect_err("symlink traversal should fail");

        assert!(error.to_string().contains("escapes its scope"));
    }

    #[test]
    fn terminal_prepare_paths_rejects_unknown_or_exited_session() {
        let manager = TerminalManager::new(WriterRegistry::default());
        let error = manager
            .prepare_paths(
                "missing-pty",
                vec![std::env::temp_dir().display().to_string()],
            )
            .expect_err("unknown session should fail");

        assert!(error.to_string().contains("Terminal session not found"));
    }

    #[test]
    fn terminal_agent_classifier_detects_codex_approval_prompt() {
        let signal = classify_agent_terminal_output(
            &AgentAdapterKind::Codex.id(),
            "\u{1b}[33mApproval required: approve command?\u{1b}[0m",
        )
        .expect("approval signal");

        assert_eq!(signal.request, InteractionKind::Permission);
    }

    #[test]
    fn terminal_agent_classifier_detects_claude_user_input_prompt() {
        let signal = classify_agent_terminal_output(
            &AgentAdapterKind::ClaudeCode.id(),
            "Claude is waiting for your input. Please enter your response.",
        )
        .expect("input signal");

        assert_eq!(signal.request, InteractionKind::Question);
    }

    #[test]
    fn terminal_agent_classifier_ignores_weak_waiting_hints() {
        assert!(
            classify_agent_terminal_output(
                &AgentAdapterKind::Codex.id(),
                "The task may require approval later, continuing for now.",
            )
            .is_none()
        );
        assert!(
            classify_agent_terminal_output(
                &AgentAdapterKind::ClaudeCode.id(),
                "Waiting can happen when a tool asks permission.",
            )
            .is_none()
        );
    }

    fn codex_key(session_id: &str) -> svode_agents::identity::SessionKey {
        native_writer_key(&AgentAdapterKind::Codex.id(), session_id)
    }

    #[test]
    fn a_linked_agent_terminal_holds_its_session_writer_until_it_is_killed() {
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        manager
            .hold_existing_session_writer("pty-a", &AgentAdapterKind::Codex.id(), "s1")
            .expect("first terminal");
        // Linking the same terminal again keeps its claim.
        manager
            .hold_existing_session_writer("pty-a", &AgentAdapterKind::Codex.id(), "s1")
            .expect("same terminal");
        assert_eq!(writers.writer(&codex_key("s1")), Some(Writer::Pty));
        assert!(
            manager
                .hold_existing_session_writer("pty-b", &AgentAdapterKind::Codex.id(), "s1")
                .is_err()
        );
        assert_eq!(
            writers
                .claim(
                    &codex_key("s1"),
                    Writer::Acp,
                    ExternalLiveness::Free,
                    UnknownLiveness::NotConfirmed
                )
                .err(),
            Some(svode_agents::writer::WriterRefusal::WriterActive {
                writer: Writer::Pty
            })
        );

        manager.kill("pty-a").expect("kill");
        assert_eq!(writers.writer(&codex_key("s1")), None);
        manager
            .hold_existing_session_writer("pty-b", &AgentAdapterKind::Codex.id(), "s1")
            .expect("the slot is free again");
    }

    #[test]
    fn a_new_session_terminal_registered_to_its_session_writes_it_and_keeps_its_outcome() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        manager.insert_shell_for_test("pty-new", cwd.path());

        manager
            .register_existing_agent_session(
                "pty-new".to_string(),
                "codex:s1".to_string(),
                Some("Started in the terminal".to_string()),
                AgentAdapterKind::Codex.id(),
                "s1".to_string(),
                None,
                Some("2026-10-18T10:00:00Z".to_string()),
            )
            .expect("the terminal becomes the surface of its session");

        let surface = manager.list_agent_surfaces().unwrap().pop().unwrap();
        assert_eq!(surface.pty_id, "pty-new");
        assert_eq!(surface.agent_session_id, "codex:s1");
        assert!(surface.live);
        assert_eq!(writers.writer(&codex_key("s1")), Some(Writer::Pty));
        // Continuing the session in the chat is refused while the PTY lives.
        assert_eq!(
            writers
                .claim(
                    &codex_key("s1"),
                    Writer::Acp,
                    ExternalLiveness::Free,
                    UnknownLiveness::NotConfirmed
                )
                .err(),
            Some(svode_agents::writer::WriterRefusal::WriterActive {
                writer: Writer::Pty
            })
        );

        manager.kill("pty-new").unwrap();

        let retained = manager.list_agent_surfaces().unwrap().pop().unwrap();
        assert!(!retained.live);
        let evidence = retained.status_evidence.expect("terminal outcome");
        assert_eq!(evidence.state, INTERRUPTED);
        assert_eq!(evidence.confidence, StatusConfidence::Exact);
        assert_eq!(writers.writer(&codex_key("s1")), None);
    }

    fn claude_key(session_id: &str) -> svode_agents::identity::SessionKey {
        native_writer_key(&AgentAdapterKind::ClaudeCode.id(), session_id)
    }

    fn claude_now(pty_id: &str, session_id: &str) -> CurrentPtySession {
        CurrentPtySession {
            pty_id: pty_id.to_string(),
            agent_session_id: format!("claude-code:{session_id}"),
            source: AgentAdapterKind::ClaudeCode.id(),
            source_session_id: session_id.to_string(),
            approximate: false,
        }
    }

    fn acp_claim(
        writers: &WriterRegistry,
        session_id: &str,
    ) -> Result<WriterClaim, svode_agents::writer::WriterRefusal> {
        writers.claim(
            &claude_key(session_id),
            Writer::Acp,
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        )
    }

    fn surface_of(manager: &TerminalManager, pty_id: &str) -> AgentTerminalSurface {
        manager
            .list_agent_surfaces()
            .unwrap()
            .into_iter()
            .find(|surface| surface.pty_id == pty_id)
            .expect("surface")
    }

    fn register_claude(manager: &TerminalManager, pty_id: &str, session_id: &str) {
        manager
            .register_existing_agent_session(
                pty_id.to_string(),
                format!("claude-code:{session_id}"),
                Some(format!("Session {session_id}")),
                AgentAdapterKind::ClaudeCode.id(),
                session_id.to_string(),
                None,
                None,
            )
            .expect("register the terminal");
    }

    #[test]
    fn a_terminal_moves_with_its_writer_and_outcome_to_the_session_its_process_runs_now() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        manager.insert_shell_for_test("pty-a", cwd.path());
        register_claude(&manager, "pty-a", "s1");
        manager
            .agent_surfaces
            .lock()
            .unwrap()
            .get_mut("pty-a")
            .unwrap()
            .status_evidence = Some(AgentTerminalStatusEvidence {
            state: SessionState::RequiresAction {
                request: InteractionKind::Permission,
            },
            confidence: StatusConfidence::Approximate,
            reason: "approval prompt of the session it leaves".to_string(),
            observed_at: now_rfc3339(),
        });

        manager
            .follow_current_sessions(&[claude_now("pty-a", "s2")])
            .unwrap();
        // The next boundary finds the same session: nothing moves.
        manager
            .follow_current_sessions(&[claude_now("pty-a", "s2")])
            .unwrap();

        let moved = surface_of(&manager, "pty-a");
        assert_eq!(moved.agent_session_id, "claude-code:s2");
        assert_eq!(moved.source_session_id, "s2");
        assert!(moved.live);
        assert!(moved.title.is_none());
        assert!(moved.status_evidence.is_none(), "evidence of s1 is dropped");
        assert_eq!(writers.writer(&claude_key("s2")), Some(Writer::Pty));
        assert_eq!(writers.writer(&claude_key("s1")), None);
        assert_eq!(
            acp_claim(&writers, "s2").err(),
            Some(svode_agents::writer::WriterRefusal::WriterActive {
                writer: Writer::Pty
            }),
            "continuing the new session in the chat is refused while the PTY lives"
        );
        drop(acp_claim(&writers, "s1").expect("the previous session continues"));

        manager.kill("pty-a").unwrap();
        let closed = surface_of(&manager, "pty-a");
        assert_eq!(closed.agent_session_id, "claude-code:s2");
        assert_eq!(
            closed.status_evidence.expect("terminal outcome").state,
            INTERRUPTED
        );
        assert_eq!(writers.writer(&claude_key("s2")), None);
    }

    #[test]
    fn a_terminal_moves_to_a_session_the_chat_writes_and_leaves_the_key_to_it() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        manager.insert_shell_for_test("pty-a", cwd.path());
        register_claude(&manager, "pty-a", "s1");
        let chat = acp_claim(&writers, "s2").expect("the chat writes s2");

        manager
            .follow_current_sessions(&[claude_now("pty-a", "s2")])
            .unwrap();

        assert_eq!(
            surface_of(&manager, "pty-a").agent_session_id,
            "claude-code:s2"
        );
        assert_eq!(writers.writer(&claude_key("s2")), Some(Writer::Acp));
        assert_eq!(writers.writer(&claude_key("s1")), None, "s1 is released");
        drop(chat);
        assert_eq!(writers.writer(&claude_key("s2")), None);
        manager.kill("pty-a").unwrap();
    }

    #[test]
    fn a_plain_terminal_becomes_the_surface_of_the_session_its_process_runs() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        manager.insert_shell_for_test("pty-tab", cwd.path());

        manager
            .follow_current_sessions(&[claude_now("pty-tab", "s1"), claude_now("pty-gone", "s9")])
            .unwrap();

        let surfaces = manager.list_agent_surfaces().unwrap();
        assert_eq!(surfaces.len(), 1, "a PTY that no longer lives gets none");
        let surface = &surfaces[0];
        assert_eq!(surface.agent_session_id, "claude-code:s1");
        assert!(surface.live);
        assert_eq!(writers.writer(&claude_key("s1")), Some(Writer::Pty));
        assert_eq!(writers.writer(&claude_key("s9")), None);
        manager.kill("pty-tab").unwrap();
    }

    #[test]
    fn the_processes_of_a_live_terminal_start_with_its_shell() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_shell_for_test("pty-a", cwd.path());
        let shell = manager
            .sessions
            .lock()
            .unwrap()
            .get("pty-a")
            .and_then(|process| process.child.process_id())
            .expect("shell pid");

        let ptys = manager.live_pty_processes().unwrap();
        manager.kill("pty-a").unwrap();

        assert_eq!(ptys.len(), 1);
        assert_eq!(ptys[0].pty_id, "pty-a");
        let first = ptys[0].processes.first().expect("the shell runs");
        assert_eq!((first.pid, first.depth), (shell, 0));
        assert!(manager.live_pty_processes().unwrap().is_empty());
    }

    #[test]
    fn a_session_continued_over_acp_is_not_linked_to_a_terminal() {
        let writers = WriterRegistry::default();
        let manager = TerminalManager::new(writers.clone());
        let _acp = writers
            .claim(
                &codex_key("s1"),
                Writer::Acp,
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .unwrap();
        let error = manager
            .hold_existing_session_writer("pty-a", &AgentAdapterKind::Codex.id(), "s1")
            .expect_err("ACP writes the session");
        assert_eq!(error.kind(), "agent_runtime");
    }

    #[test]
    fn terminal_agent_surfaces_do_not_change_generic_terminal_list() {
        let manager = TerminalManager::new(WriterRegistry::default());
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
            state: SessionState::RequiresAction {
                request: InteractionKind::Question,
            },
            confidence: StatusConfidence::Approximate,
            reason: "input prompt".to_string(),
            observed_at: "2026-07-04T10:01:00Z".to_string(),
        });

        clear_waiting_status_after_input(&mut surface);

        assert!(surface.status_evidence.is_none());
    }

    #[test]
    fn terminal_agent_exit_maps_any_non_zero_code_to_error() {
        for exit_code in [1, 130, 143] {
            let (state, reason) = agent_exit_outcome(exit_code);

            assert_eq!(
                state,
                SessionState::Idle {
                    stop_reason: Some(StopReason::Error)
                }
            );
            assert!(reason.contains(&exit_code.to_string()));
        }
        assert_eq!(
            agent_exit_outcome(0).0,
            SessionState::Idle { stop_reason: None }
        );
    }

    /// Whether the shell of `pty_id` exits within a few seconds; the
    /// terminal stays listed, so nothing else reaps it meanwhile.
    fn shell_exits(manager: &TerminalManager, pty_id: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let exited = manager
                .sessions
                .lock()
                .unwrap()
                .get_mut(pty_id)
                .expect("the terminal stays listed")
                .child
                .try_wait()
                .expect("try_wait")
                .is_some();
            if exited {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_forced_stop_signals_every_terminal_and_then_its_shell_exits() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_shell_for_test("pty-a", cwd.path());
        manager.insert_shell_for_test("pty-b", cwd.path());

        manager.force_stop_all();

        assert!(shell_exits(&manager, "pty-a"));
        assert!(shell_exits(&manager, "pty-b"));
    }

    #[test]
    fn a_forced_stop_returns_while_a_stuck_write_holds_the_terminal_state() {
        let manager = TerminalManager::new(WriterRegistry::default());
        let held = manager.sessions.clone();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = thread::spawn(move || {
            let _sessions = held.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        locked_rx.recv().unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let stopping = manager.clone();
        thread::spawn(move || {
            stopping.force_stop_all();
            let _ = done_tx.send(());
        });

        let returned = done_rx.recv_timeout(Duration::from_secs(5));

        release_tx.send(()).unwrap();
        holder.join().unwrap();
        returned.expect("the forced stop returns instead of waiting for the lock");
    }

    /// Runs `body` on its own thread and fails if it does not return within
    /// `limit`, so a call that waits for a PTY fails the test, not hangs it.
    fn within<T: Send + 'static>(limit: Duration, body: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, result) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(body());
        });
        result
            .recv_timeout(limit)
            .expect("the call returns instead of waiting for the PTY")
    }

    /// The terminal `pty_id` running `script` under `sh` with its PTY in raw
    /// mode without echo, once the script has started (`ready` exists).
    #[cfg(unix)]
    fn insert_raw_script(manager: &TerminalManager, pty_id: &str, cwd: &Path, script: &str) {
        let ready = cwd.join(format!("{pty_id}.ready"));
        manager.insert_program_for_test(
            pty_id,
            cwd,
            ShellCommand {
                program: "/bin/sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    format!("stty raw -echo && touch '{}' && {script}", ready.display()),
                ],
                kind: TerminalShellKind::Posix,
            },
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "the script of {pty_id} starts");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_write_a_program_does_not_read_holds_no_caller_and_no_other_terminal_command() {
        // DF-365 acceptance 3(a): the write waits only in the terminal's
        // writer; the old write under the `sessions` lock fails here by time.
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let manager = TerminalManager::new(WriterRegistry::default());
        // Programs that print nothing: no reader drains these PTYs, and a
        // process whose output stays undrained cannot finish exiting.
        insert_raw_script(&manager, "pty-stuck", cwd.path(), "exec sleep 600");
        insert_raw_script(&manager, "pty-other", cwd.path(), "exec sleep 600");

        within(Duration::from_secs(10), move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("current-thread runtime");
            runtime.block_on(async move {
                let write = tokio::spawn(
                    manager
                        .write_queued("pty-stuck", "x".repeat(1 << 20))
                        .expect("the write is queued"),
                );
                // Another task of the only runtime thread goes on meanwhile.
                tokio::time::sleep(Duration::from_millis(300)).await;
                assert!(!write.is_finished(), "the PTY takes no more input");

                for pty_id in ["pty-stuck", "pty-other"] {
                    manager.resize(pty_id, 100, 40).expect("resize");
                }
                assert_eq!(manager.list().expect("list").len(), 2);
                manager.kill("pty-other").expect("kill the other terminal");
                manager
                    .kill("pty-stuck")
                    .expect("kill the terminal of the write");
                assert!(manager.list().expect("list").is_empty());
                // Its call still gets its result: the stop ends the write.
                let written = tokio::time::timeout(Duration::from_secs(5), write)
                    .await
                    .expect("the stop ends the write")
                    .expect("write task");
                assert!(written.is_err(), "the write into the stopped PTY fails");
            })
        });
    }

    #[cfg(unix)]
    #[test]
    fn writes_queued_without_waiting_reach_the_program_in_call_order() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let out = cwd.path().join("out");
        let manager = TerminalManager::new(WriterRegistry::default());
        insert_raw_script(
            &manager,
            "pty-cat",
            cwd.path(),
            &format!("exec cat > '{}'", out.display()),
        );
        let expected = (0..500).map(|n| format!("{n:04}\n")).collect::<String>();

        let writes = (0..500)
            .map(|n| {
                manager
                    .write_queued("pty-cat", format!("{n:04}\n"))
                    .expect("the write is queued")
            })
            .collect::<Vec<_>>();
        let results = within(Duration::from_secs(10), move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("current-thread runtime")
                .block_on(async move {
                    let mut results = Vec::new();
                    for write in writes {
                        results.push(write.await);
                    }
                    results
                })
        });
        assert!(
            results.iter().all(Result::is_ok),
            "every write gets its result"
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut received = String::new();
        while Instant::now() < deadline {
            received = std::fs::read_to_string(&out).unwrap_or_default();
            if received.len() >= expected.len() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(received, expected);
        manager.kill("pty-cat").expect("kill");
    }

    #[cfg(unix)]
    #[test]
    fn a_write_to_a_closed_terminal_returns_its_error() {
        let cwd = tempfile::tempdir().expect("terminal cwd");
        let manager = TerminalManager::new(WriterRegistry::default());
        insert_raw_script(&manager, "pty-closed", cwd.path(), "exec cat > /dev/null");
        manager
            .write("pty-closed", "true\n")
            .expect("a live terminal takes input");
        manager.kill("pty-closed").expect("kill");

        let not_found = "Terminal session not found: pty-closed";
        let error = manager.write("pty-closed", "x").expect_err("closed");
        assert!(error.to_string().contains(not_found), "{error}");
        let error = manager
            .write_queued("pty-closed", "x".to_string())
            .err()
            .expect("closed");
        assert!(error.to_string().contains(not_found), "{error}");
    }

    #[test]
    fn writes_still_queued_when_the_terminal_closes_fail_as_for_a_closed_terminal() {
        let manager = TerminalManager::new(WriterRegistry::default());
        let (started, start) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let writer = HeldWriter {
            started,
            released: Some(released),
        };
        let input = TerminalInput::start(
            "pty-held",
            Box::new(writer),
            None,
            manager.agent_surfaces.clone(),
        )
        .expect("terminal writer");
        let (done, results) = std::sync::mpsc::channel();
        for data in ["first", "second"] {
            let done = done.clone();
            input
                .send(
                    "pty-held",
                    data.to_string(),
                    Box::new(move |result| {
                        let _ = done.send(result);
                    }),
                )
                .expect("queued");
        }
        start.recv().expect("the first write starts");

        drop(input);
        release.send(()).expect("release the first write");

        assert!(results.recv().expect("first result").is_ok());
        let error = results.recv().expect("second result").expect_err("closed");
        assert!(
            error
                .to_string()
                .contains("Terminal session not found: pty-held")
        );
    }

    /// A PTY writer whose first write waits for the test.
    struct HeldWriter {
        started: std::sync::mpsc::Sender<()>,
        released: Option<std::sync::mpsc::Receiver<()>>,
    }

    impl Write for HeldWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if let Some(released) = self.released.take() {
                let _ = self.started.send(());
                let _ = released.recv();
            }
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn killing_a_managed_agent_terminal_interrupts_its_session() {
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_agent_surface_for_test(test_surface());

        manager.kill("pty-agent").unwrap();

        let evidence = manager
            .list_agent_surfaces()
            .unwrap()
            .pop()
            .unwrap()
            .status_evidence
            .unwrap();
        assert_eq!(evidence.state, INTERRUPTED);
        assert_eq!(evidence.confidence, StatusConfidence::Exact);
    }

    #[test]
    fn killing_a_session_terminal_keeps_its_interrupted_outcome_and_frees_its_writer() {
        for source in [
            AgentAdapterKind::ClaudeCode.id(),
            AgentAdapterKind::Codex.id(),
        ] {
            let writers = WriterRegistry::default();
            let manager = TerminalManager::new(writers.clone());
            let mut surface = test_surface();
            surface.source = source.clone();
            manager.insert_agent_surface_for_test(surface);
            manager
                .hold_existing_session_writer("pty-agent", &source, "session")
                .expect("the terminal writes the session");

            manager.kill("pty-agent").unwrap();

            let retained = manager
                .list_agent_surfaces()
                .unwrap()
                .pop()
                .expect("the surface of a session outside Routines stays");
            assert!(!retained.live);
            let evidence = retained.status_evidence.expect("terminal outcome");
            assert_eq!(evidence.state, INTERRUPTED);
            assert_eq!(evidence.confidence, StatusConfidence::Exact);
            assert_eq!(writers.writer(&native_writer_key(&source, "session")), None);
        }
    }

    #[test]
    fn a_session_shell_that_exits_or_stops_with_the_app_keeps_its_outcome() {
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_agent_surface_for_test(test_surface());
        let mut stopped = test_surface();
        stopped.pty_id = "pty-stopped".to_string();
        manager.insert_agent_surface_for_test(stopped);

        finish_reader_surface(&manager.agent_surfaces, "pty-agent");
        manager.kill_all();

        let surfaces = manager.list_agent_surfaces().unwrap();
        assert_eq!(surfaces.len(), 2);
        for surface in surfaces {
            assert!(!surface.live);
            let evidence = surface.status_evidence.expect("terminal outcome");
            assert_eq!(evidence.state, INTERRUPTED);
            assert_eq!(evidence.confidence, StatusConfidence::Exact);
            let reason = if surface.pty_id == "pty-agent" {
                "managed terminal shell exited before terminal outcome was observed"
            } else {
                "managed terminal stopped during application shutdown"
            };
            assert_eq!(evidence.reason, reason);
        }
    }

    #[test]
    fn closing_a_shell_after_its_agent_command_ended_keeps_that_outcome() {
        let manager = TerminalManager::new(WriterRegistry::default());
        let mut surface = test_surface();
        surface.finished_at = Some("2026-08-07T10:00:00Z".to_string());
        surface.exit_code = Some(0);
        surface.status_evidence = Some(AgentTerminalStatusEvidence {
            state: SessionState::Idle { stop_reason: None },
            confidence: StatusConfidence::Exact,
            reason: "initial agent command exited successfully".to_string(),
            observed_at: "2026-08-07T10:00:00Z".to_string(),
        });
        manager.insert_agent_surface_for_test(surface);

        manager.finish_surface(
            "pty-agent",
            INTERRUPTED,
            None,
            "managed terminal stopped by user",
        );

        let retained = manager.list_agent_surfaces().unwrap().pop().unwrap();
        assert!(!retained.live);
        assert_eq!(retained.exit_code, Some(0));
        assert_eq!(
            retained.status_evidence.unwrap().state,
            SessionState::Idle { stop_reason: None }
        );
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

    #[cfg(not(windows))]
    #[test]
    fn terminal_agent_shell_resume_input_does_not_exec_initial_command() {
        let input =
            agent_initial_shell_input("codex", &["resume".to_string(), "session".to_string()]);

        assert_eq!(input, "codex resume session\n");
        assert!(!input.starts_with("exec "));
    }

    #[cfg(windows)]
    #[test]
    fn terminal_agent_shell_resume_input_submits_with_conpty_enter() {
        let input =
            agent_initial_shell_input("codex", &["resume".to_string(), "session".to_string()]);

        assert_eq!(input, "codex resume session\r");
        assert!(!input.contains('\n'));
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

    /// A Svode project the terminal is opened from.
    fn svode_project() -> tempfile::TempDir {
        let project = tempfile::tempdir().expect("project");
        std::fs::create_dir_all(project.path().join(".svode")).expect(".svode");
        project
    }

    /// The surface of a session terminal opened from `project`; a Routine
    /// launch also carries its run and launch.
    fn project_surface(
        project: &Path,
        pty_id: &str,
        source: &AgentId,
        session_id: &str,
    ) -> AgentTerminalSurface {
        let mut surface = test_surface();
        surface.pty_id = pty_id.to_string();
        surface.agent_session_id = format!("{}:{session_id}", source.as_str());
        surface.source = source.clone();
        surface.source_session_id = session_id.to_string();
        surface.mcp_project_path = Some(system_path::user_facing_path(project));
        surface
    }

    /// What a later start of the app reads from the project.
    fn saved_after_restart(project: &Path) -> Vec<SavedTerminalOutcome> {
        crate::agent_sessions::terminal_outcomes::SavedTerminalOutcomes::default()
            .of_project(project)
    }

    /// DF-164 acceptance 2: the outcome of a closed terminal, of the app
    /// exit and of a shell exit is saved in the terminal's project for
    /// sessions of Claude Code and Codex, as the same observation the surface
    /// keeps.
    #[test]
    fn every_outcome_of_a_session_terminal_is_saved_in_its_project() {
        for source in [
            AgentAdapterKind::ClaudeCode.id(),
            AgentAdapterKind::Codex.id(),
        ] {
            let project = svode_project();
            let manager = TerminalManager::new(WriterRegistry::default());
            for (pty_id, session_id) in [
                ("pty-closed", "s-closed"),
                ("pty-shell", "s-shell"),
                ("pty-quit", "s-quit"),
            ] {
                manager.insert_agent_surface_for_test(project_surface(
                    project.path(),
                    pty_id,
                    &source,
                    session_id,
                ));
            }

            manager.kill("pty-closed").unwrap();
            finish_reader_surface(&manager.agent_surfaces, "pty-shell");
            manager.kill_all();

            let saved = saved_after_restart(project.path());
            assert_eq!(saved.len(), 3, "{source:?}");
            for surface in manager.list_agent_surfaces().unwrap() {
                let outcome = saved
                    .iter()
                    .find(|outcome| outcome.agent_session_id == surface.agent_session_id)
                    .unwrap_or_else(|| panic!("no saved outcome of {}", surface.pty_id));
                let evidence = surface.status_evidence.expect("terminal outcome");
                assert_eq!(outcome.source, source);
                assert_eq!(outcome.source_session_id, surface.source_session_id);
                assert_eq!(outcome.launch_id, None);
                assert_eq!(outcome.state, evidence.state, "{}", surface.pty_id);
                assert_eq!(outcome.reason, evidence.reason, "{}", surface.pty_id);
                assert_eq!(outcome.observed_at, evidence.observed_at);
                assert_eq!(outcome.exit_code, surface.exit_code);
            }
            let quit = saved
                .iter()
                .find(|outcome| outcome.source_session_id == "s-quit")
                .unwrap();
            assert_eq!(quit.state, INTERRUPTED);
            assert_eq!(
                quit.reason,
                "managed terminal stopped during application shutdown"
            );
        }
    }

    /// A tab where the user started the agent CLI saves the outcome of its
    /// session in the project the tab is opened from.
    #[test]
    fn a_tab_linked_to_a_session_saves_its_outcome_in_its_project() {
        let project = svode_project();
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_shell_for_test("pty-tab", project.path());
        manager
            .register_existing_agent_session(
                "pty-tab".to_string(),
                "claude-code:c1".to_string(),
                None,
                AgentAdapterKind::ClaudeCode.id(),
                "c1".to_string(),
                None,
                None,
            )
            .unwrap();

        manager.kill("pty-tab").unwrap();

        let saved = saved_after_restart(project.path());
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].agent_session_id, "claude-code:c1");
        assert_eq!(saved[0].source_session_id, "c1");
        assert_eq!(saved[0].state, INTERRUPTED);
        assert_eq!(saved[0].reason, "managed terminal stopped by user");
    }

    /// The last outcome of a session replaces the saved one.
    #[test]
    fn a_newer_outcome_of_a_session_replaces_the_saved_one() {
        let project = svode_project();
        let source = AgentAdapterKind::Codex.id();
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_agent_surface_for_test(project_surface(
            project.path(),
            "pty-first",
            &source,
            "s1",
        ));
        manager.kill("pty-first").unwrap();
        manager.insert_agent_surface_for_test(project_surface(
            project.path(),
            "pty-resumed",
            &source,
            "s1",
        ));
        manager.kill_all();
        manager.insert_agent_surface_for_test(project_surface(
            project.path(),
            "pty-other",
            &source,
            "s2",
        ));
        manager.kill("pty-other").unwrap();

        let saved = saved_after_restart(project.path());
        assert_eq!(saved.len(), 2);
        let s1 = saved
            .iter()
            .find(|outcome| outcome.agent_session_id == "codex:s1")
            .expect("the newer outcome of the session");
        assert_eq!(
            s1.reason,
            "managed terminal stopped during application shutdown"
        );
        assert!(
            saved
                .iter()
                .any(|outcome| outcome.agent_session_id == "codex:s2")
        );
    }

    /// DF-163 R3 with DF-164 R2: a terminal closed after its process moved
    /// to another session saves the outcome of that session alone, without
    /// the launch it was started for.
    #[test]
    fn a_terminal_closed_after_a_re_bind_saves_the_outcome_of_its_new_session_alone() {
        let project = svode_project();
        let manager = TerminalManager::new(WriterRegistry::default());
        manager.insert_shell_for_test("pty-tab", project.path());
        register_claude(&manager, "pty-tab", "s1");
        manager.insert_shell_for_test("pty-launch", project.path());
        manager.insert_agent_surface_for_test(project_surface(
            project.path(),
            "pty-launch",
            &AgentAdapterKind::ClaudeCode.id(),
            "s3",
        ));

        manager
            .follow_current_sessions(&[claude_now("pty-tab", "s2"), claude_now("pty-launch", "s4")])
            .unwrap();
        manager.kill("pty-tab").unwrap();
        manager.kill("pty-launch").unwrap();

        let mut saved = saved_after_restart(project.path());
        saved.sort_by(|a, b| a.agent_session_id.cmp(&b.agent_session_id));
        let sessions = saved
            .iter()
            .map(|outcome| {
                (
                    outcome.agent_session_id.as_str(),
                    outcome.launch_id.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            sessions,
            [("claude-code:s2", None), ("claude-code:s4", None)]
        );
        assert!(saved.iter().all(|outcome| outcome.state == INTERRUPTED));
    }

    /// A terminal without a known Svode project keeps its outcome in memory
    /// alone and creates nothing on disk.
    #[test]
    fn a_terminal_without_a_project_saves_no_outcome() {
        let project = svode_project();
        let plain = tempfile::tempdir().expect("plain directory");
        let manager = TerminalManager::new(WriterRegistry::default());
        let mut unknown = project_surface(
            project.path(),
            "pty-unknown",
            &AgentAdapterKind::Codex.id(),
            "s1",
        );
        unknown.mcp_project_path = None;
        manager.insert_agent_surface_for_test(unknown);
        manager.insert_agent_surface_for_test(project_surface(
            plain.path(),
            "pty-plain",
            &AgentAdapterKind::Codex.id(),
            "s2",
        ));

        manager.kill_all();

        assert!(
            manager
                .list_agent_surfaces()
                .unwrap()
                .iter()
                .all(|surface| surface.status_evidence.is_some())
        );
        assert!(!project.path().join(".svode/agent-sessions.db").exists());
        assert_eq!(std::fs::read_dir(plain.path()).unwrap().count(), 0);
    }

    #[test]
    fn terminal_existing_agent_session_metadata_uses_source_resume_argv() {
        let surface = agent_surface_from_existing_session(
            "pty-existing".to_string(),
            "codex:session".to_string(),
            Some("Existing session".to_string()),
            AgentAdapterKind::Codex.id(),
            "session".to_string(),
            None,
            "/tmp/project".to_string(),
            "2026-07-04T10:00:00Z".to_string(),
        );

        assert_eq!(surface.pty_id, "pty-existing");
        assert_eq!(surface.agent_session_id, "codex:session");
        assert_eq!(surface.title.as_deref(), Some("Existing session"));
        assert_eq!(
            surface.initial_agent_argv,
            vec![
                "codex".to_string(),
                "resume".to_string(),
                "session".to_string()
            ]
        );
        assert_eq!(surface.initial_agent_cwd, None);
        assert_eq!(surface.shell_cwd, "/tmp/project");
    }
}
