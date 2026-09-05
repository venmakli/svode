use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep};

use super::manifest::{AppCommandRecipe, AppProcessRuntime};
use crate::process::hide_tokio_window;

const MAX_LOG_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppProcessPhase {
    Setup,
    Starting,
    WaitingForUrl,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppProcessLogs {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppProcessSnapshot {
    Launching {
        phase: AppProcessPhase,
        has_setup: bool,
        logs: AppProcessLogs,
    },
    Ready {
        url: String,
        managed: bool,
        has_setup: bool,
        logs: AppProcessLogs,
    },
    Failed {
        reason: &'static str,
        url: String,
        has_setup: bool,
        logs: AppProcessLogs,
    },
    Stopped {
        url: String,
        has_setup: bool,
        logs: AppProcessLogs,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppProcessAction {
    Retry,
    Restart,
    RerunSetup,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct AppProcessKey {
    project_path: PathBuf,
    owner_path: PathBuf,
}

impl AppProcessKey {
    fn new(project_path: &Path, owner_path: &Path) -> Self {
        Self {
            project_path: std::fs::canonicalize(project_path)
                .unwrap_or_else(|_| project_path.to_path_buf()),
            owner_path: std::fs::canonicalize(owner_path)
                .unwrap_or_else(|_| owner_path.to_path_buf()),
        }
    }
}

type SharedChild = Arc<Mutex<Child>>;

struct ProcessEntry {
    declaration_fingerprint: String,
    generation: u64,
    runtime: AppProcessRuntime,
    phase: ProcessPhase,
    logs: ProcessLogBuffers,
    child: Option<SharedChild>,
}

enum ProcessPhase {
    Launching(AppProcessPhase),
    Ready { managed: bool },
    Failed { reason: &'static str },
    Stopped,
}

#[derive(Default)]
struct ProcessLogBuffers {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl ProcessLogBuffers {
    fn snapshot(&self) -> AppProcessLogs {
        AppProcessLogs {
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
        }
    }

    fn append(&mut self, stream: LogStream, bytes: &[u8]) {
        let target = match stream {
            LogStream::Stdout => &mut self.stdout,
            LogStream::Stderr => &mut self.stderr,
        };
        target.extend_from_slice(bytes);
        if target.len() > MAX_LOG_BYTES {
            target.drain(..target.len() - MAX_LOG_BYTES);
        }
    }
}

struct ProcessStateInner {
    entries: HashMap<AppProcessKey, ProcessEntry>,
    setup_cache: HashSet<String>,
    next_generation: u64,
}

#[derive(Clone, Copy)]
struct ProcessRuntimeConfig {
    setup_timeout: Duration,
    readiness_timeout: Duration,
    probe_timeout: Duration,
    poll_interval: Duration,
}

impl Default for ProcessRuntimeConfig {
    fn default() -> Self {
        Self {
            setup_timeout: Duration::from_secs(5 * 60),
            readiness_timeout: Duration::from_secs(45),
            probe_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(250),
        }
    }
}

pub(crate) struct AppProcessState {
    inner: Arc<Mutex<ProcessStateInner>>,
    readiness_probe: Arc<dyn UrlReadinessProbe>,
    config: ProcessRuntimeConfig,
}

trait UrlReadinessProbe: Send + Sync {
    fn is_reachable<'a>(&'a self, url: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

struct HttpUrlReadinessProbe {
    client: reqwest::Client,
}

impl UrlReadinessProbe for HttpUrlReadinessProbe {
    fn is_reachable<'a>(&'a self, url: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.client.get(url).send().await.is_ok() })
    }
}

impl AppProcessState {
    pub(crate) fn new() -> Self {
        Self::with_config(ProcessRuntimeConfig::default())
    }

    fn with_config(config: ProcessRuntimeConfig) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(config.probe_timeout)
            .timeout(config.probe_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Svode-App-Readiness/1")
            .build()
            .expect("failed to build App readiness HTTP client");
        Self::with_probe(config, Arc::new(HttpUrlReadinessProbe { client }))
    }

    fn with_probe(
        config: ProcessRuntimeConfig,
        readiness_probe: Arc<dyn UrlReadinessProbe>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ProcessStateInner {
                entries: HashMap::new(),
                setup_cache: HashSet::new(),
                next_generation: 0,
            })),
            readiness_probe,
            config,
        }
    }

    pub(crate) fn inspect_or_launch(
        &self,
        project_path: &Path,
        owner_path: &Path,
        runtime: AppProcessRuntime,
    ) -> AppProcessSnapshot {
        let key = AppProcessKey::new(project_path, owner_path);
        let fingerprint = declaration_fingerprint(&runtime);
        {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(entry) = inner.entries.get(&key)
                && entry.declaration_fingerprint == fingerprint
            {
                return snapshot(entry);
            }
        }
        self.launch(key, runtime, false)
    }

    pub(crate) fn control(
        &self,
        project_path: &Path,
        owner_path: &Path,
        runtime: AppProcessRuntime,
        action: AppProcessAction,
    ) -> AppProcessSnapshot {
        let key = AppProcessKey::new(project_path, owner_path);
        if action == AppProcessAction::Retry {
            let fingerprint = declaration_fingerprint(&runtime);
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(entry) = inner.entries.get(&key)
                && entry.declaration_fingerprint == fingerprint
                && matches!(
                    entry.phase,
                    ProcessPhase::Launching(_) | ProcessPhase::Ready { .. }
                )
            {
                return snapshot(entry);
            }
        }
        self.launch(key, runtime, action == AppProcessAction::RerunSetup)
    }

    pub(crate) fn stop(
        &self,
        project_path: &Path,
        owner_path: &Path,
    ) -> Option<AppProcessSnapshot> {
        let key = AppProcessKey::new(project_path, owner_path);
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let generation = next_generation(&mut inner);
        let entry = inner.entries.get_mut(&key)?;
        stop_child(entry.child.take());
        entry.generation = generation;
        entry.phase = ProcessPhase::Stopped;
        Some(snapshot(entry))
    }

    pub(crate) fn remove_owner(&self, project_path: &Path, owner_path: &Path) {
        let key = AppProcessKey::new(project_path, owner_path);
        let entry = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entries
            .remove(&key);
        if let Some(entry) = entry {
            stop_child(entry.child);
        }
    }

    pub(crate) fn stop_project(&self, project_path: &Path) {
        let canonical = std::fs::canonicalize(project_path).unwrap_or_else(|_| project_path.into());
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let keys = inner
            .entries
            .keys()
            .filter(|key| key.project_path == canonical)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(entry) = inner.entries.remove(&key) {
                stop_child(entry.child);
            }
        }
    }

    pub(crate) fn kill_all(&self) {
        let entries = std::mem::take(
            &mut self
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .entries,
        );
        for (_, entry) in entries {
            stop_child(entry.child);
        }
    }

    fn launch(
        &self,
        key: AppProcessKey,
        runtime: AppProcessRuntime,
        force_setup: bool,
    ) -> AppProcessSnapshot {
        let declaration_fingerprint = declaration_fingerprint(&runtime);
        let setup_key = setup_cache_key(&runtime, &key.owner_path);
        let (generation, run_setup) = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(previous) = inner.entries.remove(&key) {
                stop_child(previous.child);
            }
            let generation = next_generation(&mut inner);
            let run_setup =
                runtime.setup.is_some() && (force_setup || !inner.setup_cache.contains(&setup_key));
            inner.entries.insert(
                key.clone(),
                ProcessEntry {
                    declaration_fingerprint,
                    generation,
                    runtime: runtime.clone(),
                    phase: ProcessPhase::Launching(if run_setup {
                        AppProcessPhase::Setup
                    } else {
                        AppProcessPhase::Starting
                    }),
                    logs: ProcessLogBuffers::default(),
                    child: None,
                },
            );
            (generation, run_setup)
        };

        let inner = Arc::clone(&self.inner);
        let readiness_probe = Arc::clone(&self.readiness_probe);
        let config = self.config;
        let task_key = key.clone();
        tauri::async_runtime::spawn(async move {
            launch_process_flow(
                inner,
                readiness_probe,
                config,
                task_key,
                generation,
                runtime,
                run_setup,
            )
            .await;
        });

        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        snapshot(inner.entries.get(&key).expect("process entry inserted"))
    }
}

impl Drop for AppProcessState {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn next_generation(inner: &mut ProcessStateInner) -> u64 {
    inner.next_generation = inner.next_generation.wrapping_add(1).max(1);
    inner.next_generation
}

fn snapshot(entry: &ProcessEntry) -> AppProcessSnapshot {
    let has_setup = entry.runtime.setup.is_some();
    let logs = entry.logs.snapshot();
    match entry.phase {
        ProcessPhase::Launching(phase) => AppProcessSnapshot::Launching {
            phase,
            has_setup,
            logs,
        },
        ProcessPhase::Ready { managed } => AppProcessSnapshot::Ready {
            url: entry.runtime.url.clone(),
            managed,
            has_setup,
            logs,
        },
        ProcessPhase::Failed { reason } => AppProcessSnapshot::Failed {
            reason,
            url: entry.runtime.url.clone(),
            has_setup,
            logs,
        },
        ProcessPhase::Stopped => AppProcessSnapshot::Stopped {
            url: entry.runtime.url.clone(),
            has_setup,
            logs,
        },
    }
}

async fn launch_process_flow(
    inner: Arc<Mutex<ProcessStateInner>>,
    readiness_probe: Arc<dyn UrlReadinessProbe>,
    config: ProcessRuntimeConfig,
    key: AppProcessKey,
    generation: u64,
    runtime: AppProcessRuntime,
    run_setup: bool,
) {
    if run_setup {
        let setup = runtime.setup.as_ref().expect("setup is present");
        match run_setup_command(
            Arc::clone(&inner),
            config,
            &key,
            generation,
            setup,
            &runtime.environment,
        )
        .await
        {
            CommandOutcome::Success => {
                let current_setup_key = setup_cache_key(&runtime, &key.owner_path);
                let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
                if !is_active(&state, &key, generation) {
                    return;
                }
                state.setup_cache.insert(current_setup_key);
            }
            CommandOutcome::Failed(reason) => {
                set_failed(&inner, &key, generation, reason);
                return;
            }
            CommandOutcome::Cancelled => return,
        }
    }

    if !set_launch_phase(&inner, &key, generation, AppProcessPhase::Starting) {
        return;
    }
    let child = match spawn_command(
        Arc::clone(&inner),
        &key,
        generation,
        &key.owner_path,
        &runtime.start,
        &runtime.environment,
    ) {
        Ok(child) => child,
        Err(error) => {
            append_system_error(&inner, &key, generation, &error.to_string());
            set_failed(&inner, &key, generation, "start_spawn_failed");
            return;
        }
    };
    if !set_launch_phase(&inner, &key, generation, AppProcessPhase::WaitingForUrl) {
        stop_child(Some(child));
        return;
    }

    wait_for_readiness(
        inner,
        readiness_probe,
        config,
        key,
        generation,
        runtime.url,
        child,
    )
    .await;
}

enum CommandOutcome {
    Success,
    Failed(&'static str),
    Cancelled,
}

async fn run_setup_command(
    inner: Arc<Mutex<ProcessStateInner>>,
    config: ProcessRuntimeConfig,
    key: &AppProcessKey,
    generation: u64,
    recipe: &AppCommandRecipe,
    environment: &BTreeMap<String, String>,
) -> CommandOutcome {
    let child = match spawn_command(
        Arc::clone(&inner),
        key,
        generation,
        &key.owner_path,
        recipe,
        environment,
    ) {
        Ok(child) => child,
        Err(error) => {
            append_system_error(&inner, key, generation, &error.to_string());
            return CommandOutcome::Failed("setup_spawn_failed");
        }
    };
    let deadline = Instant::now() + config.setup_timeout;
    loop {
        if !entry_is_active(&inner, key, generation) {
            return CommandOutcome::Cancelled;
        }
        match try_wait(&child) {
            Ok(Some(status)) => {
                clear_child(&inner, key, generation, &child);
                if status.success() {
                    return CommandOutcome::Success;
                }
                append_exit_status(&inner, key, generation, "setup", status);
                return CommandOutcome::Failed("setup_exit_non_zero");
            }
            Ok(None) => {}
            Err(error) => {
                append_system_error(&inner, key, generation, &error.to_string());
                return CommandOutcome::Failed("setup_wait_failed");
            }
        }
        if Instant::now() >= deadline {
            stop_child(Some(Arc::clone(&child)));
            clear_child(&inner, key, generation, &child);
            append_system_error(&inner, key, generation, "setup command timed out");
            return CommandOutcome::Failed("setup_timeout");
        }
        sleep(config.poll_interval).await;
    }
}

async fn wait_for_readiness(
    inner: Arc<Mutex<ProcessStateInner>>,
    readiness_probe: Arc<dyn UrlReadinessProbe>,
    config: ProcessRuntimeConfig,
    key: AppProcessKey,
    generation: u64,
    url: String,
    child: SharedChild,
) {
    let deadline = Instant::now() + config.readiness_timeout;
    let mut exited_successfully = false;
    loop {
        if !entry_is_active(&inner, &key, generation) {
            return;
        }

        if readiness_probe.is_reachable(&url).await {
            let managed = match try_wait(&child) {
                Ok(Some(_)) => false,
                Ok(None) => true,
                Err(error) => {
                    append_system_error(&inner, &key, generation, &error.to_string());
                    set_failed(&inner, &key, generation, "start_wait_failed");
                    return;
                }
            };
            if !managed {
                clear_child(&inner, &key, generation, &child);
            }
            if !set_ready(&inner, &key, generation, managed) {
                return;
            }
            if managed {
                monitor_ready_child(inner, readiness_probe, config, key, generation, url, child)
                    .await;
            }
            return;
        }

        match try_wait(&child) {
            Ok(Some(status)) => {
                clear_child(&inner, &key, generation, &child);
                if !status.success() {
                    append_exit_status(&inner, &key, generation, "start", status);
                    set_failed(&inner, &key, generation, "start_exit_non_zero");
                    return;
                }
                exited_successfully = true;
            }
            Ok(None) => {}
            Err(error) => {
                append_system_error(&inner, &key, generation, &error.to_string());
                set_failed(&inner, &key, generation, "start_wait_failed");
                return;
            }
        }

        if Instant::now() >= deadline {
            if !exited_successfully {
                stop_child(Some(Arc::clone(&child)));
                clear_child(&inner, &key, generation, &child);
            }
            append_system_error(
                &inner,
                &key,
                generation,
                "declared App URL did not become reachable before the timeout",
            );
            set_failed(&inner, &key, generation, "url_readiness_timeout");
            return;
        }
        sleep(config.poll_interval).await;
    }
}

async fn monitor_ready_child(
    inner: Arc<Mutex<ProcessStateInner>>,
    readiness_probe: Arc<dyn UrlReadinessProbe>,
    config: ProcessRuntimeConfig,
    key: AppProcessKey,
    generation: u64,
    url: String,
    child: SharedChild,
) {
    loop {
        sleep(config.poll_interval).await;
        if !entry_is_active(&inner, &key, generation) {
            return;
        }
        match try_wait(&child) {
            Ok(None) => continue,
            Ok(Some(status)) => {
                clear_child(&inner, &key, generation, &child);
                if readiness_probe.is_reachable(&url).await {
                    let _ = set_ready(&inner, &key, generation, false);
                } else {
                    append_exit_status(&inner, &key, generation, "start", status);
                    set_failed(&inner, &key, generation, "process_exited");
                }
                return;
            }
            Err(error) => {
                append_system_error(&inner, &key, generation, &error.to_string());
                set_failed(&inner, &key, generation, "start_wait_failed");
                return;
            }
        }
    }
}

fn spawn_command(
    inner: Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    owner_path: &Path,
    recipe: &AppCommandRecipe,
    environment: &BTreeMap<String, String>,
) -> std::io::Result<SharedChild> {
    let mut command = Command::new(&recipe.argv[0]);
    command
        .args(&recipe.argv[1..])
        .envs(environment)
        .current_dir(
            recipe
                .cwd
                .as_deref()
                .map_or_else(|| owner_path.to_path_buf(), |cwd| owner_path.join(cwd)),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut command);
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "App process launch was cancelled",
        ));
    };
    if entry.generation != generation {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "App process launch was superseded",
        ));
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    entry.child = Some(Arc::clone(&child));
    drop(state);

    if let Some(stdout) = stdout {
        spawn_log_reader(
            Arc::clone(&inner),
            key.clone(),
            generation,
            LogStream::Stdout,
            stdout,
        );
    }
    if let Some(stderr) = stderr {
        spawn_log_reader(inner, key.clone(), generation, LogStream::Stderr, stderr);
    }
    Ok(child)
}

#[derive(Clone, Copy)]
enum LogStream {
    Stdout,
    Stderr,
}

fn spawn_log_reader<R>(
    inner: Arc<Mutex<ProcessStateInner>>,
    key: AppProcessKey,
    generation: u64,
    stream: LogStream,
    reader: R,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        drain_log(reader, inner, key, generation, stream).await;
    });
}

async fn drain_log<R>(
    mut reader: R,
    inner: Arc<Mutex<ProcessStateInner>>,
    key: AppProcessKey,
    generation: u64,
    stream: LogStream,
) where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 4096];
    loop {
        let Ok(read) = reader.read(&mut chunk).await else {
            return;
        };
        if read == 0 {
            return;
        }
        let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(entry) = state.entries.get_mut(&key) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        entry.logs.append(stream, &chunk[..read]);
    }
}

fn try_wait(child: &SharedChild) -> std::io::Result<Option<ExitStatus>> {
    child
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .try_wait()
}

fn stop_child(child: Option<SharedChild>) {
    if let Some(child) = child {
        let _ = child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .start_kill();
    }
}

fn clear_child(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    child: &SharedChild,
) {
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return;
    };
    if entry.generation == generation
        && entry
            .child
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, child))
    {
        entry.child = None;
    }
}

fn entry_is_active(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
) -> bool {
    let state = inner.lock().unwrap_or_else(|error| error.into_inner());
    is_active(&state, key, generation)
}

fn is_active(state: &ProcessStateInner, key: &AppProcessKey, generation: u64) -> bool {
    state
        .entries
        .get(key)
        .is_some_and(|entry| entry.generation == generation)
}

fn set_launch_phase(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    phase: AppProcessPhase,
) -> bool {
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return false;
    };
    if entry.generation != generation {
        return false;
    }
    entry.phase = ProcessPhase::Launching(phase);
    true
}

fn set_ready(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    managed: bool,
) -> bool {
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return false;
    };
    if entry.generation != generation {
        return false;
    }
    entry.phase = ProcessPhase::Ready { managed };
    true
}

fn set_failed(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    reason: &'static str,
) {
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return;
    };
    if entry.generation != generation {
        return;
    }
    entry.child = None;
    entry.phase = ProcessPhase::Failed { reason };
}

fn append_system_error(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    message: &str,
) {
    let mut text = message.as_bytes().to_vec();
    text.push(b'\n');
    let mut state = inner.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = state.entries.get_mut(key) else {
        return;
    };
    if entry.generation == generation {
        entry.logs.append(LogStream::Stderr, &text);
    }
}

fn append_exit_status(
    inner: &Arc<Mutex<ProcessStateInner>>,
    key: &AppProcessKey,
    generation: u64,
    command: &str,
    status: ExitStatus,
) {
    append_system_error(
        inner,
        key,
        generation,
        &format!("{command} command exited with {status}"),
    );
}

fn declaration_fingerprint(runtime: &AppProcessRuntime) -> String {
    let mut hasher = Sha256::new();
    hash_recipe(&mut hasher, runtime.setup.as_ref());
    hash_recipe(&mut hasher, Some(&runtime.start));
    hash_text(&mut hasher, &runtime.url);
    for (name, value) in &runtime.environment_declaration {
        hash_text(&mut hasher, name);
        hash_text(&mut hasher, value);
    }
    hex_digest(hasher.finalize())
}

fn setup_cache_key(runtime: &AppProcessRuntime, owner_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hash_text(&mut hasher, &owner_path.to_string_lossy());
    hash_text(&mut hasher, &declaration_fingerprint(runtime));
    for (name, value) in &runtime.environment {
        hash_text(&mut hasher, name);
        hash_text(&mut hasher, value);
    }
    if let Some(setup) = runtime.setup.as_ref() {
        for input in &setup.inputs {
            hash_text(&mut hasher, input);
            let path = owner_path.join(input);
            match std::fs::symlink_metadata(path) {
                Ok(metadata) => {
                    hasher.update([1]);
                    hasher.update(metadata.len().to_le_bytes());
                    hash_system_time(&mut hasher, metadata.modified().ok());
                    hasher.update([metadata.is_file() as u8, metadata.is_dir() as u8]);
                }
                Err(_) => hasher.update([0]),
            }
        }
    }
    hex_digest(hasher.finalize())
}

fn hash_recipe(hasher: &mut Sha256, recipe: Option<&AppCommandRecipe>) {
    let Some(recipe) = recipe else {
        hasher.update([0]);
        return;
    };
    hasher.update([1]);
    for value in &recipe.argv {
        hash_text(hasher, value);
    }
    hash_text(hasher, recipe.cwd.as_deref().unwrap_or(""));
    for value in &recipe.inputs {
        hash_text(hasher, value);
    }
}

fn hash_text(hasher: &mut Sha256, value: &str) {
    hasher.update(value.len().to_le_bytes());
    hasher.update(value.as_bytes());
}

fn hash_system_time(hasher: &mut Sha256, value: Option<SystemTime>) {
    let duration = value
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_default();
    hasher.update(duration.as_secs().to_le_bytes());
    hasher.update(duration.subsec_nanos().to_le_bytes());
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct AlwaysReady;

    impl UrlReadinessProbe for AlwaysReady {
        fn is_reachable<'a>(
            &'a self,
            _url: &'a str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
            Box::pin(async { true })
        }
    }

    struct NeverReady;

    impl UrlReadinessProbe for NeverReady {
        fn is_reachable<'a>(
            &'a self,
            _url: &'a str,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
            Box::pin(async { false })
        }
    }

    fn test_config() -> ProcessRuntimeConfig {
        ProcessRuntimeConfig {
            setup_timeout: Duration::from_secs(2),
            readiness_timeout: Duration::from_secs(2),
            probe_timeout: Duration::from_millis(200),
            poll_interval: Duration::from_millis(20),
        }
    }

    fn runtime(
        url: String,
        setup: Option<AppCommandRecipe>,
        start: AppCommandRecipe,
    ) -> AppProcessRuntime {
        AppProcessRuntime {
            setup,
            start,
            url,
            environment: Default::default(),
            environment_declaration: Default::default(),
        }
    }

    #[cfg(unix)]
    fn shell(script: impl Into<String>) -> AppCommandRecipe {
        AppCommandRecipe {
            argv: vec!["sh".to_string(), "-c".to_string(), script.into()],
            cwd: None,
            inputs: Vec::new(),
        }
    }

    async fn wait_for_snapshot(
        state: &AppProcessState,
        project: &Path,
        owner: &Path,
        runtime: &AppProcessRuntime,
        predicate: impl Fn(&AppProcessSnapshot) -> bool,
    ) -> AppProcessSnapshot {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = state.inspect_or_launch(project, owner, runtime.clone());
            if predicate(&snapshot) {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "process runtime did not converge: {snapshot:?}"
            );
            sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_setup_reuses_it_and_manages_only_the_direct_start_child() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("app");
        std::fs::create_dir(&owner).unwrap();
        std::fs::write(owner.join("input.lock"), "one").unwrap();
        let url = "http://127.0.0.1:3210/".to_string();
        let state = AppProcessState::with_probe(test_config(), Arc::new(AlwaysReady));
        let mut setup = shell("printf 'run\\n' >> setup.log");
        setup.inputs.push("input.lock".to_string());
        let runtime = runtime(url, Some(setup), shell("sleep 10"));

        let ready = wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: true, .. })
        })
        .await;
        assert!(matches!(
            ready,
            AppProcessSnapshot::Ready { managed: true, .. }
        ));
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.log")).unwrap(),
            "run\n"
        );

        state.control(&project, &owner, runtime.clone(), AppProcessAction::Restart);
        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: true, .. })
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.log")).unwrap(),
            "run\n"
        );

        state.control(
            &project,
            &owner,
            runtime.clone(),
            AppProcessAction::RerunSetup,
        );
        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: true, .. })
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.log")).unwrap(),
            "run\nrun\n"
        );

        std::fs::write(owner.join("input.lock"), "two values").unwrap();
        state.control(&project, &owner, runtime.clone(), AppProcessAction::Restart);
        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: true, .. })
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.log")).unwrap(),
            "run\nrun\nrun\n"
        );

        let key = AppProcessKey::new(&project, &owner);
        let child = state
            .inner
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .clone();
        let stopped = state.stop(&project, &owner).unwrap();
        assert!(matches!(stopped, AppProcessSnapshot::Stopped { .. }));
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if try_wait(&child).unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "managed child was not stopped");
            sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_resolved_environment_to_setup_and_start_and_restarts_on_change() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("environment-app");
        std::fs::create_dir(&owner).unwrap();
        let state = AppProcessState::with_probe(test_config(), Arc::new(AlwaysReady));
        let mut runtime = runtime(
            "http://127.0.0.1:3210/".to_string(),
            Some(shell("printf '%s' \"$APP_TOKEN\" > setup.env")),
            shell("printf '%s' \"$APP_TOKEN\" > start.env; sleep 10"),
        );
        runtime
            .environment
            .insert("APP_TOKEN".to_string(), "first".to_string());
        runtime
            .environment_declaration
            .insert("APP_TOKEN".to_string(), "${APP_TOKEN}".to_string());

        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { .. })
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.env")).unwrap(),
            "first"
        );
        assert_eq!(
            std::fs::read_to_string(owner.join("start.env")).unwrap(),
            "first"
        );

        runtime
            .environment
            .insert("APP_TOKEN".to_string(), "second".to_string());
        assert!(matches!(
            state.inspect_or_launch(&project, &owner, runtime.clone()),
            AppProcessSnapshot::Ready { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(owner.join("start.env")).unwrap(),
            "first"
        );
        state.control(&project, &owner, runtime.clone(), AppProcessAction::Restart);
        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { .. })
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(owner.join("setup.env")).unwrap(),
            "second"
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while std::fs::read_to_string(owner.join("start.env")).unwrap() != "second" {
            assert!(
                Instant::now() < deadline,
                "restarted process did not receive the changed environment"
            );
            sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            std::fs::read_to_string(owner.join("start.env")).unwrap(),
            "second"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_start_failure_with_bounded_logs_and_can_retry() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("app");
        std::fs::create_dir(&owner).unwrap();
        let runtime = runtime(
            "http://127.0.0.1:9/".to_string(),
            None,
            shell("printf failure >&2; exit 7"),
        );
        let state = AppProcessState::with_probe(test_config(), Arc::new(NeverReady));

        let failed = wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Failed { .. })
        })
        .await;
        let AppProcessSnapshot::Failed { reason, logs, .. } = failed else {
            unreachable!()
        };
        assert_eq!(reason, "start_exit_non_zero");
        assert!(logs.stderr.contains("failure"));
        assert!(logs.stderr.contains("exit status: 7"));

        let retried = state.control(&project, &owner, runtime, AppProcessAction::Retry);
        assert!(matches!(retried, AppProcessSnapshot::Launching { .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_missing_commands_and_setup_timeouts_without_environment_repair() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("app");
        std::fs::create_dir(&owner).unwrap();
        let mut config = test_config();
        config.setup_timeout = Duration::from_millis(80);

        let missing = runtime(
            "http://127.0.0.1:3210/".to_string(),
            None,
            AppCommandRecipe {
                argv: vec!["svode-command-that-does-not-exist".to_string()],
                cwd: None,
                inputs: Vec::new(),
            },
        );
        let state = AppProcessState::with_probe(config, Arc::new(NeverReady));
        let failed = wait_for_snapshot(&state, &project, &owner, &missing, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Failed { .. })
        })
        .await;
        let AppProcessSnapshot::Failed { reason, logs, .. } = failed else {
            unreachable!()
        };
        assert_eq!(reason, "start_spawn_failed");
        assert!(!logs.stderr.is_empty());

        let setup_timeout = runtime(
            "http://127.0.0.1:3210/".to_string(),
            Some(shell("sleep 10")),
            shell("exit 0"),
        );
        state.control(
            &project,
            &owner,
            setup_timeout.clone(),
            AppProcessAction::Restart,
        );
        let failed = wait_for_snapshot(&state, &project, &owner, &setup_timeout, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Failed { .. })
        })
        .await;
        assert!(matches!(
            failed,
            AppProcessSnapshot::Failed {
                reason: "setup_timeout",
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn accepts_an_external_service_and_drops_project_owned_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("app");
        std::fs::create_dir(&owner).unwrap();
        let runtime = runtime("https://example.com/app".to_string(), None, shell("exit 0"));
        let state = AppProcessState::with_probe(test_config(), Arc::new(AlwaysReady));

        let ready = wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: false, .. })
        })
        .await;
        assert!(matches!(
            ready,
            AppProcessSnapshot::Ready { managed: false, .. }
        ));

        let key = AppProcessKey::new(&project, &owner);
        let first_generation = state
            .inner
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .unwrap()
            .generation;

        state.stop_project(&project);
        let _ = state.inspect_or_launch(&project, &owner, runtime);
        let next_generation = state
            .inner
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .unwrap()
            .generation;
        assert_ne!(first_generation, next_generation);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_close_stops_its_managed_child() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let owner = project.join("app");
        std::fs::create_dir(&owner).unwrap();
        let runtime = runtime(
            "http://127.0.0.1:3210/".to_string(),
            None,
            shell("sleep 10"),
        );
        let state = AppProcessState::with_probe(test_config(), Arc::new(AlwaysReady));
        wait_for_snapshot(&state, &project, &owner, &runtime, |snapshot| {
            matches!(snapshot, AppProcessSnapshot::Ready { managed: true, .. })
        })
        .await;

        let key = AppProcessKey::new(&project, &owner);
        let child = state
            .inner
            .lock()
            .unwrap()
            .entries
            .get(&key)
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .clone();
        state.stop_project(&project);
        assert!(!state.inner.lock().unwrap().entries.contains_key(&key));

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if try_wait(&child).unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "managed child was not stopped");
            sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn log_buffers_keep_only_the_latest_bounded_output() {
        let mut logs = ProcessLogBuffers::default();
        logs.append(LogStream::Stdout, &vec![b'a'; MAX_LOG_BYTES]);
        logs.append(LogStream::Stdout, b"tail");
        assert_eq!(logs.stdout.len(), MAX_LOG_BYTES);
        assert!(logs.stdout.ends_with(b"tail"));
    }

    #[cfg(unix)]
    #[test]
    fn setup_cache_is_scoped_to_its_app_owner() {
        let runtime = runtime(
            "http://127.0.0.1:3210/".to_string(),
            Some(shell("exit 0")),
            shell("exit 0"),
        );
        assert_ne!(
            setup_cache_key(&runtime, Path::new("/project/first")),
            setup_cache_key(&runtime, Path::new("/project/second")),
        );
    }
}
