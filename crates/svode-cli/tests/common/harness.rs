//! Harness host with the mutation runtime of an open Project, as the
//! headless runtime will provide it, and helpers to run the public `svode`
//! frame on it.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineLiveEvidence};
use svode_core::routines::store_state::RoutineStoreState;
use svode_core::storage::config::AssetsSpaceConfig;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};

/// Whether the host grants repository access to mutations.
#[derive(Clone, Copy, PartialEq)]
pub enum Access {
    Grant,
    Deny,
}

pub struct WriteHost {
    access: Access,
    asked: Mutex<Vec<String>>,
    pub authorized: Mutex<Vec<PathBuf>>,
    routines: Arc<RoutineStoreState>,
    pub index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
    actors: ActorCatalogState,
    git: GitRuntime,
    /// Answer of the Git LFS readiness probe; `None` means the host has no
    /// probe.
    lfs_ready: Option<bool>,
    pub lfs_probes: Mutex<Vec<PathBuf>>,
    pub deliveries: Mutex<Vec<ManagedImportDelivery>>,
}

impl WriteHost {
    pub fn new(access: Access) -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            access,
            asked: Mutex::new(Vec::new()),
            authorized: Mutex::new(Vec::new()),
            updates: IndexUpdateState::new(routines.clone()),
            routines,
            index: IndexRuntimeState::default(),
            nonces: WriteNonceRegistry::new(),
            actors: ActorCatalogState::new(),
            git: GitRuntime::new(),
            lfs_ready: None,
            lfs_probes: Mutex::new(Vec::new()),
            deliveries: Mutex::new(Vec::new()),
        }
    }

    /// Host whose Git LFS readiness probe answers `ready`.
    pub fn with_lfs(ready: bool) -> Self {
        Self {
            lfs_ready: Some(ready),
            ..Self::new(Access::Grant)
        }
    }

    pub fn take_asked(&self) -> BTreeSet<String> {
        std::mem::take(&mut *self.asked.lock().unwrap())
            .into_iter()
            .collect()
    }
}

impl ToolHost for WriteHost {
    fn version(&self) -> &str {
        "harness"
    }

    fn serves_tool(&self, name: &str) -> bool {
        self.asked.lock().unwrap().push(name.to_string());
        true
    }

    async fn index_pool(&self, key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        self.index.existing_pool(key).await
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Ok(RepositoryAccessSnapshot {
            repository_id: "harness".to_string(),
            generation: 1,
            status: RepositoryAccessStatus::Local,
            reason: None,
            checked_at: None,
            expires_at: None,
            last_known_status: None,
        })
    }

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), ToolError> {
        self.authorized
            .lock()
            .unwrap()
            .push(repository.to_path_buf());
        match self.access {
            Access::Grant => Ok(()),
            Access::Deny => Err(ToolError::new(
                "REPOSITORY_ACCESS_DENIED",
                "Repository access denied: status=read_only",
            )),
        }
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: &self.index,
            updates: &self.updates,
            nonces: &self.nonces,
        }
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: &self.index,
            actors: &self.actors,
            git: &self.git,
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        self.lfs_ready.map(|_| self as &dyn LfsReadiness)
    }

    fn deliver_managed_import(&self, delivery: &ManagedImportDelivery) {
        self.deliveries.lock().unwrap().push(delivery.clone());
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: &self.routines,
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

impl LfsReadiness for WriteHost {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        _config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        self.lfs_probes.lock().unwrap().push(repo_dir.to_path_buf());
        let ready = self.lfs_ready.unwrap_or(false);
        Box::pin(async move { ready })
    }
}

pub fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

pub fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// Read command of a body write without `--source-version`: the same
/// selectors, without body and title.
fn source_read(args: &[&str]) -> Option<Vec<String>> {
    if args.contains(&"--source-version") {
        return None;
    }
    let write = args.iter().position(|arg| *arg == "write")?;
    let noun = args[..write]
        .iter()
        .rev()
        .find(|arg| !arg.starts_with('-'))
        .copied()?;
    if !matches!(noun, "page" | "item" | "readme") {
        return None;
    }
    let mut read = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match *arg {
            "write" => read.push("read".to_string()),
            "--body" | "--body-file" | "--title" => {
                rest.next();
            }
            "--path" | "--collection" | "--space" | "--project" => {
                read.push(arg.to_string());
                read.extend(rest.next().map(|value| value.to_string()));
            }
            arg => read.push(arg.to_string()),
        }
    }
    Some(read)
}

/// Arguments of one command; a body write without `--source-version` runs
/// the safe cycle of a caller: it reads the source first and passes the
/// `sourceVersion` of that read (a placeholder when the read fails).
async fn with_source_version(host: &WriteHost, cwd: &Path, args: &[&str]) -> Vec<String> {
    let mut args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    if let Some(read) = source_read(&refs) {
        // The read belongs to the caller, not to the audited command.
        let asked = std::mem::take(&mut *host.asked.lock().unwrap());
        let mut raw = vec![OsString::from("svode"), OsString::from("--json")];
        raw.extend(read.iter().map(OsString::from));
        let version = match svode_cli::parse(&raw) {
            Ok(cli) => serde_json::from_str::<Value>(&svode_cli::run(host, cli, cwd).await.stdout)
                .ok()
                .and_then(|value| value["sourceVersion"].as_str().map(str::to_string)),
            Err(_) => None,
        };
        *host.asked.lock().unwrap() = asked;
        args.push("--source-version".into());
        args.push(version.unwrap_or_else(|| "unread".into()));
    }
    args
}

/// Runs one JSON command through the public frame; returns the exit code
/// and the single stdout object.
pub async fn svode(host: &WriteHost, cwd: &Path, args: &[&str]) -> (i32, Value) {
    let args = with_source_version(host, cwd, args).await;
    let mut raw = vec![OsString::from("svode"), OsString::from("--json")];
    raw.extend(args.iter().map(OsString::from));
    let cli = svode_cli::parse(&raw).unwrap_or_else(|rendered| panic!("{args:?}: {rendered:?}"));
    let rendered = svode_cli::run(host, cli, cwd).await;
    assert_eq!(rendered.stdout.lines().count(), 1, "{args:?}: {rendered:?}");
    (
        rendered.exit,
        serde_json::from_str(&rendered.stdout).unwrap(),
    )
}

pub async fn human(host: &WriteHost, cwd: &Path, args: &[&str]) -> svode_cli::Rendered {
    let args = with_source_version(host, cwd, args).await;
    let mut raw = vec![OsString::from("svode")];
    raw.extend(args.iter().map(OsString::from));
    let cli = svode_cli::parse(&raw).unwrap();
    svode_cli::run(host, cli, cwd).await
}

pub fn ok(exit: i32, value: &Value) {
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["ok"], true, "{value}");
}
