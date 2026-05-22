pub mod commands;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";
const ERROR_EVENT: &str = "terminal:error";

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

#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
        let cwd_display = cwd_path.to_string_lossy().to_string();
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

        if let Err(e) = spawn_reader_loop(app, self.sessions.clone(), pty_id.clone(), reader) {
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

        if let Some(mut process) = process {
            process
                .child
                .kill()
                .map_err(|e| AppError::General(format!("Failed to kill terminal: {e}")))?;
            let _ = process.child.wait();
        }

        Ok(())
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
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_reader_loop(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
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

    Ok(canonical)
}

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
    for candidate in ["pwsh", "powershell"] {
        if let Ok(path) = which::which(candidate) {
            return ShellCommand {
                program: path.to_string_lossy().to_string(),
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
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() && command_exists(&shell) {
            return ShellCommand {
                program: shell,
                args: vec!["-l".to_string()],
            };
        }
    }

    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(candidate).exists() {
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
    let path = Path::new(command);
    if path.is_absolute() {
        path.exists()
    } else {
        which::which(command).is_ok()
    }
}
