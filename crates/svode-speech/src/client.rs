//! The host side of the speech process.
//!
//! A [`Recognizer`] starts the process when a recording begins, so the model
//! loads while the user speaks, keeps it warm for a while after a recognition
//! and stops it when idle or on [`Recognizer::shutdown`]. A recognition is
//! bounded by a limit derived from the recording length. When the process
//! crashes or its backend fails while the GPU was in use, acceleration is
//! refused on this device until the Svode version changes, and the next
//! attempt runs on the CPU.
//!
//! Logs carry facts only (model file, backend, durations, error codes), never
//! audio or recognized text.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, watch};

use crate::protocol::{self, Acceleration, Backend, ErrorCode, Language, Request, Response};

/// How long the process stays warm after its last use.
pub const DEFAULT_IDLE: Duration = Duration::from_secs(5 * 60);

pub struct RecognizerConfig {
    /// The `svode-speech` executable.
    pub program: PathBuf,
    /// Device-local engine state: the refusal of acceleration.
    pub state_file: PathBuf,
    /// The running Svode version; a refusal of acceleration lasts until it
    /// changes.
    pub build_version: String,
    pub idle: Duration,
    pub timeout: TimeoutPolicy,
    /// Extra environment of the process.
    pub env: Vec<(String, String)>,
}

impl RecognizerConfig {
    pub fn new(program: PathBuf, state_file: PathBuf, build_version: impl Into<String>) -> Self {
        Self {
            program,
            state_file,
            build_version: build_version.into(),
            idle: DEFAULT_IDLE,
            timeout: TimeoutPolicy::default(),
            env: Vec::new(),
        }
    }
}

/// The time a recognition may take: `base`, which also covers a model load
/// still in progress and the first shader compile, plus `per_audio` times the
/// recording length (the slowest catalog model on a CPU recognizes about 2.5
/// times faster than real time).
#[derive(Debug, Clone, Copy)]
pub struct TimeoutPolicy {
    pub base: Duration,
    pub per_audio: u32,
}

impl Default for TimeoutPolicy {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(60),
            per_audio: 2,
        }
    }
}

impl TimeoutPolicy {
    pub fn limit(&self, audio: Duration) -> Duration {
        self.base + audio * self.per_audio
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transcription {
    pub text: String,
    pub backend: Backend,
    /// From the request to the text, including a model load still in progress.
    pub elapsed: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum RecognizerError {
    #[error("speech process could not start: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("speech engine refused the request: {0}")]
    Engine(ErrorCode),
    #[error("speech process ended unexpectedly")]
    Crashed,
    #[error("speech recognition took longer than {limit:?}")]
    TimedOut { limit: Duration },
    #[error("speech recognition stopped")]
    Stopped,
}

/// The one owner of the speech process of a host. Clones share it.
#[derive(Clone)]
pub struct Recognizer {
    inner: Arc<Inner>,
}

struct Inner {
    config: RecognizerConfig,
    process: Mutex<Option<Process>>,
    acceleration_refused: AtomicBool,
    /// Bumped by every use, so an idle stop never ends a process in use.
    uses: AtomicU64,
    /// Bumped by `shutdown`, which ends a recognition in progress instead
    /// of waiting for it.
    stops: watch::Sender<u64>,
}

struct Process {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    model: PathBuf,
    acceleration: Acceleration,
    /// Known once the process reported the load.
    backend: Option<Backend>,
    started: Instant,
}

impl Process {
    /// Whether a failure of this process may be a failure of the GPU: it
    /// was allowed one and did not report the CPU.
    fn may_be_accelerated(&self) -> bool {
        self.acceleration == Acceleration::Auto && self.backend.is_none_or(Backend::is_accelerated)
    }
}

enum Exchange {
    Text(String, Backend),
    LoadFailed(ErrorCode),
    Refused(ErrorCode),
}

impl Recognizer {
    pub fn new(config: RecognizerConfig) -> Self {
        let refused = EngineState::read(&config.state_file)
            .acceleration_refused_for
            .is_some_and(|version| version == config.build_version);
        Self {
            inner: Arc::new(Inner {
                config,
                process: Mutex::new(None),
                acceleration_refused: AtomicBool::new(refused),
                uses: AtomicU64::new(0),
                stops: watch::Sender::new(0),
            }),
        }
    }

    /// Whether this device recognizes on the CPU only until the next update.
    pub fn acceleration_refused(&self) -> bool {
        self.inner.acceleration_refused.load(Ordering::SeqCst)
    }

    /// Starts the process with `model`, or keeps the running one, and lets
    /// the model load without waiting for it.
    pub async fn prepare(&self, model: &Path) -> Result<(), RecognizerError> {
        self.inner.uses.fetch_add(1, Ordering::SeqCst);
        let mut slot = self.inner.process.lock().await;
        let result = self.ensure(&mut slot, model).await;
        drop(slot);
        self.schedule_idle_stop();
        result
    }

    /// Recognizes 16 kHz mono `samples` with `model`; `language` `None` is
    /// automatic detection.
    pub async fn transcribe(
        &self,
        model: &Path,
        samples: &[f32],
        language: Option<Language>,
    ) -> Result<Transcription, RecognizerError> {
        self.inner.uses.fetch_add(1, Ordering::SeqCst);
        let mut stops = self.inner.stops.subscribe();
        let audio = Duration::from_secs_f64(samples.len() as f64 / protocol::SAMPLE_RATE as f64);
        let limit = self.inner.config.timeout.limit(audio);
        let started = Instant::now();
        let mut slot = self.inner.process.lock().await;
        self.ensure(&mut slot, model).await?;
        let process = slot.as_mut().expect("ensured above");
        let exchange = tokio::select! {
            exchange = tokio::time::timeout(limit, exchange(process, samples, language)) => Some(exchange),
            _ = stops.changed() => None,
        };
        let outcome = match exchange {
            None => {
                self.stop(slot.take()).await;
                Err(RecognizerError::Stopped)
            }
            Some(Ok(Ok(Exchange::Text(text, backend)))) => {
                let elapsed = started.elapsed();
                tracing::info!(
                    audio_ms = audio.as_millis() as u64,
                    elapsed_ms = elapsed.as_millis() as u64,
                    ?backend,
                    "speech recognized"
                );
                Ok(Transcription {
                    text,
                    backend,
                    elapsed,
                })
            }
            Some(Ok(Ok(Exchange::Refused(error)))) => {
                tracing::warn!(?error, "speech recognition refused");
                if self.backend_failure(process, error) {
                    self.stop(slot.take()).await;
                }
                Err(RecognizerError::Engine(error))
            }
            Some(Ok(Ok(Exchange::LoadFailed(error)))) => {
                tracing::warn!(?error, "speech model load failed");
                self.backend_failure(process, error);
                self.stop(slot.take()).await;
                Err(RecognizerError::Engine(error))
            }
            Some(Ok(Err(_))) => {
                let mut process = slot.take().expect("process in the slot");
                let status = process.child.wait().await.ok();
                tracing::warn!(?status, backend = ?process.backend, "speech process crashed");
                if process.may_be_accelerated() {
                    self.refuse_acceleration();
                }
                Err(RecognizerError::Crashed)
            }
            Some(Err(_)) => {
                tracing::warn!(
                    audio_ms = audio.as_millis() as u64,
                    limit_ms = limit.as_millis() as u64,
                    "speech recognition timed out"
                );
                self.stop(slot.take()).await;
                Err(RecognizerError::TimedOut { limit })
            }
        };
        drop(slot);
        self.schedule_idle_stop();
        outcome
    }

    /// Stops the process, if it runs, ending a recognition in progress.
    pub async fn shutdown(&self) {
        self.inner.uses.fetch_add(1, Ordering::SeqCst);
        self.inner.stops.send_modify(|stops| *stops += 1);
        let process = self.inner.process.lock().await.take();
        self.stop(process).await;
    }

    pub async fn is_running(&self) -> bool {
        let mut slot = self.inner.process.lock().await;
        slot.as_mut()
            .is_some_and(|process| matches!(process.child.try_wait(), Ok(None)))
    }

    async fn ensure(
        &self,
        slot: &mut Option<Process>,
        model: &Path,
    ) -> Result<(), RecognizerError> {
        let acceleration = if self.acceleration_refused() {
            Acceleration::CpuOnly
        } else {
            Acceleration::Auto
        };
        if let Some(process) = slot.as_mut() {
            let current = process.model == model
                && process.acceleration == acceleration
                && matches!(process.child.try_wait(), Ok(None));
            if current {
                return Ok(());
            }
            self.stop(slot.take()).await;
        }
        *slot = Some(self.spawn(model, acceleration).await?);
        Ok(())
    }

    async fn spawn(
        &self,
        model: &Path,
        acceleration: Acceleration,
    ) -> Result<Process, RecognizerError> {
        let config = &self.inner.config;
        let mut command = Command::new(&config.program);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .envs(config.env.iter().map(|(key, value)| (key, value)));
        hide_window(&mut command);
        let mut child = command.spawn().map_err(RecognizerError::Spawn)?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let load = Request::Load {
            model: model.to_path_buf(),
            acceleration,
        };
        if let Err(error) = write_all(&mut stdin, &protocol::line(&load)).await {
            let _ = child.kill().await;
            return Err(RecognizerError::Spawn(error));
        }
        tracing::info!(
            model = %model.file_name().unwrap_or_default().to_string_lossy(),
            ?acceleration,
            "speech process started"
        );
        Ok(Process {
            child,
            stdin,
            stdout,
            model: model.to_path_buf(),
            acceleration,
            backend: None,
            started: Instant::now(),
        })
    }

    async fn stop(&self, process: Option<Process>) {
        if let Some(mut process) = process {
            let _ = process.child.kill().await;
        }
    }

    /// Refuses acceleration when the engine's backend failed or ran out of
    /// memory while the GPU may have been in use. Returns whether it did.
    fn backend_failure(&self, process: &Process, error: ErrorCode) -> bool {
        let gpu_failure = matches!(error, ErrorCode::Backend | ErrorCode::OutOfMemory)
            && process.may_be_accelerated();
        if gpu_failure {
            self.refuse_acceleration();
        }
        gpu_failure
    }

    fn refuse_acceleration(&self) {
        if self.inner.acceleration_refused.swap(true, Ordering::SeqCst) {
            return;
        }
        let config = &self.inner.config;
        tracing::warn!(
            version = %config.build_version,
            "speech acceleration refused until the next Svode update"
        );
        let state = EngineState {
            acceleration_refused_for: Some(config.build_version.clone()),
        };
        if let Err(error) = state.write(&config.state_file) {
            tracing::warn!("failed to record the speech acceleration refusal: {error}");
        }
    }

    fn schedule_idle_stop(&self) {
        let seen = self.inner.uses.load(Ordering::SeqCst);
        let idle = self.inner.config.idle;
        let inner: Weak<Inner> = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            let Some(inner) = inner.upgrade() else {
                return;
            };
            let mut slot = inner.process.lock().await;
            if inner.uses.load(Ordering::SeqCst) != seen {
                return;
            }
            if let Some(mut process) = slot.take() {
                tracing::debug!("speech process stopped after idling");
                let _ = process.child.kill().await;
            }
        });
    }
}

async fn exchange(
    process: &mut Process,
    samples: &[f32],
    language: Option<Language>,
) -> std::io::Result<Exchange> {
    if process.backend.is_none() {
        match read_response(&mut process.stdout).await? {
            Response::Loaded { backend } => {
                tracing::info!(
                    ?backend,
                    load_ms = process.started.elapsed().as_millis() as u64,
                    "speech model loaded"
                );
                process.backend = Some(backend);
            }
            Response::Failed { error } => return Ok(Exchange::LoadFailed(error)),
            Response::Transcript { .. } => return Err(unexpected()),
        }
    }
    let request = Request::Transcribe {
        language,
        samples: samples.len(),
    };
    let mut bytes = protocol::line(&request);
    bytes.extend(protocol::encode_samples(samples));
    write_all(&mut process.stdin, &bytes).await?;
    match read_response(&mut process.stdout).await? {
        Response::Transcript { text } => {
            Ok(Exchange::Text(text, process.backend.expect("loaded above")))
        }
        Response::Failed { error } => Ok(Exchange::Refused(error)),
        Response::Loaded { .. } => Err(unexpected()),
    }
}

async fn read_response(stdout: &mut BufReader<ChildStdout>) -> std::io::Result<Response> {
    let mut line = String::new();
    if stdout.read_line(&mut line).await? == 0 {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    serde_json::from_str(&line).map_err(|_| unexpected())
}

async fn write_all(stdin: &mut ChildStdin, bytes: &[u8]) -> std::io::Result<()> {
    stdin.write_all(bytes).await?;
    stdin.flush().await
}

fn unexpected() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "unexpected speech process response",
    )
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineState {
    acceleration_refused_for: Option<String>,
}

impl EngineState {
    fn read(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, serde_json::to_vec(self)?)?;
        std::fs::rename(&partial, path)
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keeps a console window from flashing up for a child of a GUI host.
fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_grows_with_the_recording() {
        let policy = TimeoutPolicy::default();
        assert_eq!(policy.limit(Duration::ZERO), Duration::from_secs(60));
        assert_eq!(
            policy.limit(Duration::from_secs(120)),
            Duration::from_secs(300)
        );
    }

    #[test]
    fn acceleration_refusal_lasts_until_the_version_changes() {
        let dir = tempfile::tempdir().unwrap();
        let state_file = dir.path().join("speech/engine.json");
        let program = dir.path().join("svode-speech");

        let recognizer = Recognizer::new(RecognizerConfig::new(
            program.clone(),
            state_file.clone(),
            "0.0.9",
        ));
        assert!(!recognizer.acceleration_refused());
        recognizer.refuse_acceleration();
        assert!(recognizer.acceleration_refused());

        let same = Recognizer::new(RecognizerConfig::new(
            program.clone(),
            state_file.clone(),
            "0.0.9",
        ));
        assert!(same.acceleration_refused());

        let updated = Recognizer::new(RecognizerConfig::new(program, state_file, "0.0.10"));
        assert!(!updated.acceleration_refused());
    }
}
