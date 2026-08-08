use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::cli::{GitCli, GitOutput};
use super::commands::{GitState, require_cli};
use crate::AppError;

const ACCESS_STORE_FILE: &str = "repository-access.json";
const ACCESS_STORE_VERSION: u32 = 1;
const MAX_EVIDENCE_ENTRIES: usize = 128;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const ACCESS_EVIDENCE_TTL_SECONDS: i64 = 24 * 60 * 60;

const SERVICE_AUTHOR_NAME: &str = "Svode Access Probe";
const SERVICE_AUTHOR_EMAIL: &str = "access@svode.invalid";
const ROUTINE_SERVICE_AUTHOR_NAME: &str = "Svode Routine Claim";
const ROUTINE_SERVICE_AUTHOR_EMAIL: &str = "routines@svode.invalid";

tokio::task_local! {
    static AUTHORIZED_MUTATION_REPOSITORIES: Option<Arc<std::collections::HashSet<PathBuf>>>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryAccessStatus {
    Local,
    Checking,
    Writable,
    ReadOnly,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryAccessReason {
    NotChecked,
    AuthRequired,
    OfflineOrTimeout,
    UnsupportedRef,
    UnsupportedRemoteConfiguration,
    AmbiguousRejection,
    LeaseConflict,
    Expired,
    RemoteChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAccessSnapshot {
    pub repository_id: String,
    pub generation: u64,
    pub status: RepositoryAccessStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RepositoryAccessReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_known_status: Option<RepositoryAccessStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RoutineClaimResult {
    Local,
    Claimed { claimed_by: String, claimed_at: i64 },
    AlreadyClaimed { claimed_by: String, claimed_at: i64 },
    Unavailable { reason: RepositoryAccessReason },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RoutineClaimPayload {
    run_key: String,
    definition_hash: String,
    claimed_by: String,
    claimed_at: i64,
}

#[derive(Debug, Clone)]
struct PublishedSnapshot {
    remote_fingerprint: Option<String>,
    snapshot: RepositoryAccessSnapshot,
}

#[derive(Debug, Clone)]
struct RemoteConfig {
    push_url: String,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedEvidence {
    remote_fingerprint: String,
    status: RepositoryAccessStatus,
    reason: Option<RepositoryAccessReason>,
    checked_at: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessStore {
    #[serde(default = "access_store_version")]
    version: u32,
    #[serde(default)]
    installation_id: String,
    #[serde(default)]
    evidence: HashMap<String, PersistedEvidence>,
}

fn access_store_version() -> u32 {
    ACCESS_STORE_VERSION
}

trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }
}

pub struct RepositoryAccessState {
    clock: Arc<dyn Clock>,
    snapshots: Mutex<HashMap<PathBuf, Arc<PublishedSnapshot>>>,
    probe_locks: Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
    persistence_lock: Mutex<()>,
}

impl RepositoryAccessState {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            snapshots: Mutex::new(HashMap::new()),
            probe_locks: Mutex::new(HashMap::new()),
            persistence_lock: Mutex::new(()),
        }
    }

    pub async fn snapshot(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        if let Some(current) = self.cached(&repository)? {
            if current.snapshot.status == RepositoryAccessStatus::Checking {
                return Ok(current.snapshot.clone());
            }
        }

        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => {
                if let Some(current) = self.cached(&repository)?
                    && current.remote_fingerprint.is_none()
                    && current.snapshot.status == RepositoryAccessStatus::Local
                {
                    return Ok(current.snapshot.clone());
                }
                Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Local,
                        reason: None,
                        checked_at: None,
                        expires_at: None,
                        last_known_status: None,
                    },
                )?)
            }
            RemoteInspection::Unsupported => {
                if let Some(current) = self.cached(&repository)?
                    && current.remote_fingerprint.is_none()
                    && current.snapshot.status == RepositoryAccessStatus::Unknown
                    && current.snapshot.reason
                        == Some(RepositoryAccessReason::UnsupportedRemoteConfiguration)
                {
                    return Ok(current.snapshot.clone());
                }
                Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Unknown,
                        reason: Some(RepositoryAccessReason::UnsupportedRemoteConfiguration),
                        checked_at: None,
                        expires_at: None,
                        last_known_status: None,
                    },
                )?)
            }
            RemoteInspection::Remote(remote) => {
                let now = self.clock.now_unix();
                if let Some(current) = self.cached(&repository)? {
                    if current.remote_fingerprint.as_deref() == Some(&remote.fingerprint) {
                        let refreshed = refresh_expiration(&current.snapshot, now);
                        if refreshed == current.snapshot {
                            return Ok(refreshed);
                        }
                        return self.publish(&repository, Some(remote.fingerprint), refreshed);
                    }
                }

                let store = self.read_store(store_path)?;
                let snapshot = snapshot_from_store(
                    &repository_id,
                    store.evidence.get(&repository_id),
                    &remote.fingerprint,
                    now,
                );
                Ok(self.publish(&repository, Some(remote.fingerprint), snapshot)?)
            }
        }
    }

    pub async fn verify(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        let permit = self.acquire_probe(&repository).await?;
        if matches!(permit, ProbePermit::Joined) {
            if let Some(snapshot) = self.cached(&repository)? {
                return Ok(snapshot.snapshot.clone());
            }
            return self.snapshot(cli, &repository, store_path).await;
        }
        let _guard = match permit {
            ProbePermit::Owner(guard) => guard,
            ProbePermit::Joined => unreachable!(),
        };

        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        let remote = match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => {
                return Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Local,
                        reason: None,
                        checked_at: None,
                        expires_at: None,
                        last_known_status: None,
                    },
                )?);
            }
            RemoteInspection::Unsupported => {
                return Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Unknown,
                        reason: Some(RepositoryAccessReason::UnsupportedRemoteConfiguration),
                        checked_at: Some(self.clock.now_unix()),
                        expires_at: None,
                        last_known_status: None,
                    },
                )?);
            }
            RemoteInspection::Remote(remote) => remote,
        };

        self.publish(
            &repository,
            Some(remote.fingerprint.clone()),
            RepositoryAccessSnapshot {
                repository_id: repository_id.clone(),
                generation: 0,
                status: RepositoryAccessStatus::Checking,
                reason: None,
                checked_at: None,
                expires_at: None,
                last_known_status: self
                    .cached(&repository)?
                    .map(|current| current.snapshot.status)
                    .filter(|status| *status != RepositoryAccessStatus::Checking),
            },
        )?;

        let installation_id = match self.ensure_installation_id(store_path) {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.publish_probe_error(&repository, &repository_id, &remote.fingerprint)?;
                return Err(error);
            }
        };
        let installation_hash = stable_hash(&installation_id);
        let checked_at = self.clock.now_unix();
        let result =
            match probe_remote(cli, &repository, &remote, &installation_hash, checked_at).await {
                Ok(result) => result,
                Err(error) => {
                    self.publish_probe_error(&repository, &repository_id, &remote.fingerprint)?;
                    return Err(error);
                }
            };
        let snapshot = RepositoryAccessSnapshot {
            repository_id,
            generation: 0,
            status: result.status,
            reason: result.reason,
            checked_at: Some(checked_at),
            expires_at: matches!(
                result.status,
                RepositoryAccessStatus::Writable | RepositoryAccessStatus::ReadOnly
            )
            .then_some(checked_at.saturating_add(ACCESS_EVIDENCE_TTL_SECONDS)),
            last_known_status: None,
        };
        self.persist_and_publish(&repository, &remote.fingerprint, snapshot, store_path)
    }

    /// Authorize a managed mutation from local repository state only.
    ///
    /// This deliberately uses `snapshot`, never `verify`: consumers cannot
    /// turn a write attempt into a hidden network capability probe.
    pub async fn require_mutation(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let snapshot = self.snapshot(cli, space_path, store_path).await?;
        ensure_mutation_allowed(&snapshot, self.clock.now_unix())?;
        Ok(snapshot)
    }

    pub(crate) async fn claim_routine(
        &self,
        cli: &GitCli,
        repository: &Path,
        store_path: &Path,
        snapshot: &RepositoryAccessSnapshot,
        routine_id: &str,
        run_key: &str,
        definition_hash: &str,
        claimed_at: i64,
    ) -> Result<RoutineClaimResult, AppError> {
        ensure_mutation_allowed(snapshot, self.clock.now_unix())?;
        let repository = resolve_repository(cli, repository).await?;
        let remote = match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => return Ok(RoutineClaimResult::Local),
            RemoteInspection::Unsupported => {
                return Ok(RoutineClaimResult::Unavailable {
                    reason: RepositoryAccessReason::UnsupportedRemoteConfiguration,
                });
            }
            RemoteInspection::Remote(remote) => remote,
        };
        if snapshot.status != RepositoryAccessStatus::Writable
            || self
                .cached(&repository)?
                .and_then(|current| current.remote_fingerprint.clone())
                .as_deref()
                != Some(remote.fingerprint.as_str())
        {
            return Ok(RoutineClaimResult::Unavailable {
                reason: RepositoryAccessReason::RemoteChanged,
            });
        }
        let payload = RoutineClaimPayload {
            run_key: run_key.to_string(),
            definition_hash: definition_hash.to_string(),
            claimed_by: self.ensure_installation_id(store_path)?,
            claimed_at,
        };
        claim_remote_routine(cli, &repository, &remote, routine_id, &payload).await
    }

    pub(crate) async fn routine_repository_id(
        &self,
        cli: &GitCli,
        repository: &Path,
        snapshot: &RepositoryAccessSnapshot,
    ) -> Result<Option<String>, AppError> {
        ensure_mutation_allowed(snapshot, self.clock.now_unix())?;
        let repository = resolve_repository(cli, repository).await?;
        match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local if snapshot.status == RepositoryAccessStatus::Local => {
                Ok(Some(snapshot.repository_id.clone()))
            }
            RemoteInspection::Remote(remote)
                if snapshot.status == RepositoryAccessStatus::Writable
                    && self
                        .cached(&repository)?
                        .and_then(|current| current.remote_fingerprint.clone())
                        .as_deref()
                        == Some(remote.fingerprint.as_str()) =>
            {
                Ok(Some(opaque_id("routine-repo", &remote.fingerprint)))
            }
            _ => Ok(None),
        }
    }

    pub(crate) async fn record_writable_evidence(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        let remote = match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => {
                return Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Local,
                        reason: None,
                        checked_at: None,
                        expires_at: None,
                        last_known_status: None,
                    },
                )?);
            }
            RemoteInspection::Unsupported => {
                return Ok(self.publish(
                    &repository,
                    None,
                    RepositoryAccessSnapshot {
                        repository_id,
                        generation: 0,
                        status: RepositoryAccessStatus::Unknown,
                        reason: Some(RepositoryAccessReason::UnsupportedRemoteConfiguration),
                        checked_at: Some(self.clock.now_unix()),
                        expires_at: None,
                        last_known_status: None,
                    },
                )?);
            }
            RemoteInspection::Remote(remote) => remote,
        };
        let checked_at = self.clock.now_unix();
        self.persist_and_publish(
            &repository,
            &remote.fingerprint,
            RepositoryAccessSnapshot {
                repository_id,
                generation: 0,
                status: RepositoryAccessStatus::Writable,
                reason: None,
                checked_at: Some(checked_at),
                expires_at: Some(checked_at.saturating_add(ACCESS_EVIDENCE_TTL_SECONDS)),
                last_known_status: None,
            },
            store_path,
        )
    }

    pub(crate) async fn invalidate(&self, cli: &GitCli, space_path: &Path) -> Result<(), AppError> {
        let repository = resolve_repository(cli, space_path).await?;
        self.snapshots
            .lock()
            .map_err(|_| AppError::General("repository access snapshot lock poisoned".into()))?
            .remove(&repository);
        Ok(())
    }

    fn cached(&self, repository: &Path) -> Result<Option<Arc<PublishedSnapshot>>, AppError> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.get(repository).cloned())
            .map_err(|_| AppError::General("repository access snapshot lock poisoned".into()))
    }

    fn publish(
        &self,
        repository: &Path,
        remote_fingerprint: Option<String>,
        mut snapshot: RepositoryAccessSnapshot,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| AppError::General("repository access snapshot lock poisoned".into()))?;
        snapshot.generation = snapshots
            .get(repository)
            .map_or(1, |current| current.snapshot.generation.saturating_add(1));
        snapshots.insert(
            repository.to_path_buf(),
            Arc::new(PublishedSnapshot {
                remote_fingerprint,
                snapshot: snapshot.clone(),
            }),
        );
        Ok(snapshot)
    }

    fn persist_and_publish(
        &self,
        repository: &Path,
        remote_fingerprint: &str,
        snapshot: RepositoryAccessSnapshot,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        let persist_result = (|| {
            let _guard = self.persistence_lock.lock().map_err(|_| {
                AppError::General("repository access persistence lock poisoned".into())
            })?;
            let mut store = read_store_file(store_path)?;
            store.evidence.insert(
                snapshot.repository_id.clone(),
                PersistedEvidence {
                    remote_fingerprint: remote_fingerprint.to_string(),
                    status: snapshot.status,
                    reason: snapshot.reason,
                    checked_at: snapshot.checked_at.unwrap_or_else(|| self.clock.now_unix()),
                    expires_at: snapshot.expires_at,
                },
            );
            trim_evidence(&mut store.evidence);
            write_store_file(store_path, &store)
        })();
        let published = self.publish(repository, Some(remote_fingerprint.to_string()), snapshot)?;
        if let Err(error) = persist_result {
            tracing::warn!("failed to persist repository access evidence: {error}");
        }
        Ok(published)
    }

    fn publish_probe_error(
        &self,
        repository: &Path,
        repository_id: &str,
        remote_fingerprint: &str,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        self.publish(
            repository,
            Some(remote_fingerprint.to_string()),
            RepositoryAccessSnapshot {
                repository_id: repository_id.to_string(),
                generation: 0,
                status: RepositoryAccessStatus::Unknown,
                reason: Some(RepositoryAccessReason::AmbiguousRejection),
                checked_at: Some(self.clock.now_unix()),
                expires_at: None,
                last_known_status: None,
            },
        )
    }

    fn read_store(&self, store_path: &Path) -> Result<AccessStore, AppError> {
        let _guard = self
            .persistence_lock
            .lock()
            .map_err(|_| AppError::General("repository access persistence lock poisoned".into()))?;
        read_store_file(store_path)
    }

    fn ensure_installation_id(&self, store_path: &Path) -> Result<String, AppError> {
        let _guard = self
            .persistence_lock
            .lock()
            .map_err(|_| AppError::General("repository access persistence lock poisoned".into()))?;
        let mut store = read_store_file(store_path)?;
        if store.installation_id.is_empty() {
            store.installation_id = ulid::Ulid::new().to_string().to_lowercase();
            write_store_file(store_path, &store)?;
        }
        Ok(store.installation_id)
    }

    fn probe_lock(&self, repository: &Path) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let mut locks = self
            .probe_locks
            .lock()
            .map_err(|_| AppError::General("repository access probe lock cache poisoned".into()))?;
        Ok(locks
            .entry(repository.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    async fn acquire_probe(&self, repository: &Path) -> Result<ProbePermit, AppError> {
        let lock = self.probe_lock(repository)?;
        match lock.clone().try_lock_owned() {
            Ok(guard) => Ok(ProbePermit::Owner(guard)),
            Err(_) => {
                let guard = lock.lock_owned().await;
                drop(guard);
                Ok(ProbePermit::Joined)
            }
        }
    }
}

impl Default for RepositoryAccessState {
    fn default() -> Self {
        Self::new()
    }
}

enum ProbePermit {
    Owner(OwnedMutexGuard<()>),
    Joined,
}

enum RemoteInspection {
    Local,
    Remote(RemoteConfig),
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProbeResult {
    status: RepositoryAccessStatus,
    reason: Option<RepositoryAccessReason>,
}

#[tauri::command]
pub async fn repository_access_get(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let cli = require_cli(&git_state)?;
    let store_path = access_store_path(&app)?;
    access_state
        .snapshot(&cli, Path::new(&space_path), &store_path)
        .await
}

#[tauri::command]
pub async fn repository_access_verify(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let cli = require_cli(&git_state)?;
    let store_path = access_store_path(&app)?;
    access_state
        .verify(&cli, Path::new(&space_path), &store_path)
        .await
}

pub async fn require_repository_mutation(
    app: &AppHandle,
    space_path: &Path,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let git_state = app.state::<GitState>();
    let cli = require_cli(&git_state)?;
    let access_state = app.state::<RepositoryAccessState>();
    let store_path = access_store_path(app)?;
    access_state
        .require_mutation(&cli, space_path, &store_path)
        .await
}

pub async fn repository_access_snapshot(
    app: &AppHandle,
    space_path: &Path,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let git_state = app.state::<GitState>();
    let cli = require_cli(&git_state)?;
    let access_state = app.state::<RepositoryAccessState>();
    let store_path = access_store_path(app)?;
    access_state.snapshot(&cli, space_path, &store_path).await
}

pub async fn require_repository_mutation_paths(
    app: &AppHandle,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<RepositoryAccessSnapshot>, AppError> {
    let mut authorized = Vec::new();
    let mut repositories = std::collections::HashSet::new();
    for path in paths {
        let repository = local_repository_root(&path)?;
        if repositories.insert(repository.clone()) {
            authorized.push(require_repository_mutation(app, &repository).await?);
        }
    }
    Ok(authorized)
}

fn existing_git_context(path: &Path) -> Result<PathBuf, AppError> {
    let mut candidate = if path.is_file() {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };
    while !candidate.is_dir() {
        if !candidate.pop() {
            return Err(AppError::PathNotAccessible(path.display().to_string()));
        }
    }
    Ok(candidate)
}

fn local_repository_root(path: &Path) -> Result<PathBuf, AppError> {
    let mut candidate = existing_git_context(path)?;
    loop {
        if candidate.join(".git").symlink_metadata().is_ok() {
            return candidate.canonicalize().map_err(AppError::Io);
        }
        if !candidate.pop() {
            return Err(AppError::GitCommandFailed(format!(
                "failed to resolve repository for {}",
                path.display()
            )));
        }
    }
}

pub async fn scope_authorized_mutation_paths<F, T, E>(
    paths: Vec<PathBuf>,
    future: F,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: From<AppError>,
{
    let repositories = paths
        .iter()
        .map(|path| local_repository_root(path))
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(E::from)?;
    AUTHORIZED_MUTATION_REPOSITORIES
        .scope(Some(Arc::new(repositories)), future)
        .await
}

pub fn ensure_mutation_paths_were_authorized(paths: &[PathBuf]) -> Result<(), AppError> {
    AUTHORIZED_MUTATION_REPOSITORIES
        .try_with(|authorized| {
            let Some(authorized) = authorized else {
                return Ok(());
            };
            for path in paths {
                let repository = local_repository_root(path)?;
                if !authorized.contains(&repository) {
                    return Err(AppError::RepositoryAccessDenied {
                        repository_id: opaque_id("access-repo", &repository.to_string_lossy()),
                        status: "unknown".to_string(),
                        reason: "mutation_plan_changed".to_string(),
                    });
                }
            }
            Ok(())
        })
        .unwrap_or(Ok(()))
}

/// Shared predicate for future automatic routine eligibility.
/// Callers must pass a snapshot returned by `snapshot`, which has already
/// failed expired or remote-changed evidence closed to `unknown`.
pub fn automatic_mutation_eligible(snapshot: &RepositoryAccessSnapshot, now: i64) -> bool {
    if snapshot.status == RepositoryAccessStatus::Local {
        return true;
    }
    if snapshot.status != RepositoryAccessStatus::Writable {
        return false;
    }
    let (Some(checked_at), Some(expires_at)) = (snapshot.checked_at, snapshot.expires_at) else {
        return false;
    };
    checked_at <= now
        && checked_at < expires_at
        && expires_at > now
        && expires_at <= checked_at.saturating_add(ACCESS_EVIDENCE_TTL_SECONDS)
}

fn ensure_mutation_allowed(snapshot: &RepositoryAccessSnapshot, now: i64) -> Result<(), AppError> {
    if automatic_mutation_eligible(snapshot, now) {
        return Ok(());
    }
    Err(AppError::RepositoryAccessDenied {
        repository_id: snapshot.repository_id.clone(),
        status: status_name(snapshot.status).to_string(),
        reason: snapshot
            .reason
            .map(reason_name)
            .unwrap_or("none")
            .to_string(),
    })
}

fn status_name(status: RepositoryAccessStatus) -> &'static str {
    match status {
        RepositoryAccessStatus::Local => "local",
        RepositoryAccessStatus::Checking => "checking",
        RepositoryAccessStatus::Writable => "writable",
        RepositoryAccessStatus::ReadOnly => "read_only",
        RepositoryAccessStatus::Unknown => "unknown",
    }
}

fn reason_name(reason: RepositoryAccessReason) -> &'static str {
    match reason {
        RepositoryAccessReason::NotChecked => "not_checked",
        RepositoryAccessReason::AuthRequired => "auth_required",
        RepositoryAccessReason::OfflineOrTimeout => "offline_or_timeout",
        RepositoryAccessReason::UnsupportedRef => "unsupported_ref",
        RepositoryAccessReason::UnsupportedRemoteConfiguration => {
            "unsupported_remote_configuration"
        }
        RepositoryAccessReason::AmbiguousRejection => "ambiguous_rejection",
        RepositoryAccessReason::LeaseConflict => "lease_conflict",
        RepositoryAccessReason::Expired => "expired",
        RepositoryAccessReason::RemoteChanged => "remote_changed",
    }
}

pub(crate) fn access_store_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let config_dir = app.path().app_config_dir().map_err(|error| {
        AppError::General(format!("failed to resolve app config path: {error}"))
    })?;
    Ok(config_dir.join(ACCESS_STORE_FILE))
}

async fn resolve_repository(cli: &GitCli, space_path: &Path) -> Result<PathBuf, AppError> {
    let output = cli
        .exec(space_path, &["rev-parse", "--show-toplevel"])
        .await?;
    if output.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to resolve repository for {}: {}",
            space_path.display(),
            output.stderr.trim()
        )));
    }
    let root = PathBuf::from(output.stdout.trim());
    fs::canonicalize(&root).map_err(|error| {
        AppError::GitCommandFailed(format!(
            "failed to canonicalize repository {}: {error}",
            root.display()
        ))
    })
}

async fn inspect_remote(cli: &GitCli, repository: &Path) -> Result<RemoteInspection, AppError> {
    let fetch = config_values(cli, repository, "remote.origin.url").await?;
    if fetch.is_empty() {
        return Ok(RemoteInspection::Local);
    }
    let push = config_values(cli, repository, "remote.origin.pushurl").await?;
    if fetch.len() != 1 || push.len() > 1 {
        return Ok(RemoteInspection::Unsupported);
    }
    let fetch_url = fetch[0].clone();
    let push_url = push.first().cloned().unwrap_or_else(|| fetch_url.clone());
    let fingerprint = stable_hash(&format!("fetch\0{fetch_url}\0push\0{push_url}"));
    Ok(RemoteInspection::Remote(RemoteConfig {
        push_url,
        fingerprint,
    }))
}

async fn config_values(
    cli: &GitCli,
    repository: &Path,
    key: &str,
) -> Result<Vec<String>, AppError> {
    let output = cli.exec(repository, &["config", "--get-all", key]).await?;
    if output.exit_code != 0 {
        return Ok(Vec::new());
    }
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

async fn probe_remote(
    cli: &GitCli,
    repository: &Path,
    remote: &RemoteConfig,
    installation_hash: &str,
    checked_at: i64,
) -> Result<ProbeResult, AppError> {
    let reference = format!("refs/svode/access/{installation_hash}");
    let current = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
    let expected = match current {
        RemoteRead::Oid(oid) => oid,
        RemoteRead::Missing => String::new(),
        RemoteRead::Failure(result) => return Ok(result),
    };
    let new_oid = create_service_commit(cli, repository, installation_hash, checked_at).await?;
    let lease = exact_lease(&reference, &expected);
    let refspec = format!("{new_oid}:{reference}");
    let output = cli
        .exec_sensitive_with_stdin(
            repository,
            &["push", "--porcelain", &lease, "origin", &refspec],
            &[],
            None,
            PROBE_TIMEOUT,
        )
        .await?;
    if output.exit_code == 0 {
        return Ok(ProbeResult {
            status: RepositoryAccessStatus::Writable,
            reason: None,
        });
    }

    let failure = classify_failure(&output);
    if matches!(
        failure.reason,
        Some(RepositoryAccessReason::OfflineOrTimeout | RepositoryAccessReason::AmbiguousRejection)
    ) {
        let readback = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
        return Ok(resolve_uncertain_result(failure, &new_oid, readback));
    }
    Ok(failure)
}

async fn claim_remote_routine(
    cli: &GitCli,
    repository: &Path,
    remote: &RemoteConfig,
    routine_id: &str,
    payload: &RoutineClaimPayload,
) -> Result<RoutineClaimResult, AppError> {
    let reference = format!("refs/svode/routines/{}", stable_hash(routine_id));
    let current = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
    let expected = match current {
        RemoteRead::Oid(oid) => {
            if let Some(existing) =
                read_routine_claim(cli, repository, &remote.push_url, &reference, &oid).await?
                && existing.run_key == payload.run_key
            {
                return Ok(RoutineClaimResult::AlreadyClaimed {
                    claimed_by: existing.claimed_by,
                    claimed_at: existing.claimed_at,
                });
            }
            oid
        }
        RemoteRead::Missing => String::new(),
        RemoteRead::Failure(result) => {
            return Ok(RoutineClaimResult::Unavailable {
                reason: result
                    .reason
                    .unwrap_or(RepositoryAccessReason::AmbiguousRejection),
            });
        }
    };
    let new_oid = create_routine_claim_commit(cli, repository, &expected, payload).await?;
    let lease = exact_lease(&reference, &expected);
    let refspec = format!("{new_oid}:{reference}");
    let output = cli
        .exec_sensitive_with_stdin(
            repository,
            &["push", "--porcelain", &lease, "origin", &refspec],
            &[],
            None,
            PROBE_TIMEOUT,
        )
        .await?;
    if output.exit_code == 0 {
        return Ok(RoutineClaimResult::Claimed {
            claimed_by: payload.claimed_by.clone(),
            claimed_at: payload.claimed_at,
        });
    }

    let failure = classify_failure(&output);
    let readback = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
    if routine_claim_readback_confirms(&new_oid, &readback) {
        return Ok(RoutineClaimResult::Claimed {
            claimed_by: payload.claimed_by.clone(),
            claimed_at: payload.claimed_at,
        });
    }
    if let RemoteRead::Oid(oid) = readback
        && let Some(existing) =
            read_routine_claim(cli, repository, &remote.push_url, &reference, &oid).await?
        && existing.run_key == payload.run_key
    {
        return Ok(RoutineClaimResult::AlreadyClaimed {
            claimed_by: existing.claimed_by,
            claimed_at: existing.claimed_at,
        });
    }
    Ok(RoutineClaimResult::Unavailable {
        reason: failure
            .reason
            .unwrap_or(RepositoryAccessReason::AmbiguousRejection),
    })
}

fn routine_claim_readback_confirms(new_oid: &str, readback: &RemoteRead) -> bool {
    matches!(readback, RemoteRead::Oid(oid) if oid == new_oid)
}

async fn read_routine_claim(
    cli: &GitCli,
    repository: &Path,
    push_url: &str,
    reference: &str,
    oid: &str,
) -> Result<Option<RoutineClaimPayload>, AppError> {
    let fetch = cli
        .exec_sensitive_with_stdin(
            repository,
            &["fetch", "--no-tags", "--quiet", push_url, reference],
            &[],
            None,
            PROBE_TIMEOUT,
        )
        .await?;
    if fetch.exit_code != 0 {
        return Ok(None);
    }
    let show = cli
        .exec(repository, &["show", "-s", "--format=%B", oid])
        .await?;
    if show.exit_code != 0 {
        return Ok(None);
    }
    Ok(parse_routine_claim(&show.stdout))
}

fn parse_routine_claim(message: &str) -> Option<RoutineClaimPayload> {
    let values = message
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<HashMap<_, _>>();
    if values.get("version") != Some(&"1") {
        return None;
    }
    Some(RoutineClaimPayload {
        run_key: values.get("run-key")?.to_string(),
        definition_hash: values.get("definition-hash")?.to_string(),
        claimed_by: values.get("claimed-by")?.to_string(),
        claimed_at: values.get("claimed-at")?.parse().ok()?,
    })
}

async fn create_routine_claim_commit(
    cli: &GitCli,
    repository: &Path,
    parent: &str,
    payload: &RoutineClaimPayload,
) -> Result<String, AppError> {
    let empty_tree = cli
        .exec_sensitive_with_stdin(
            repository,
            &["hash-object", "-w", "-t", "tree", "--stdin"],
            &[],
            Some(""),
            PROBE_TIMEOUT,
        )
        .await?;
    if empty_tree.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to create routine claim tree: {}",
            bounded_detail(&empty_tree.stderr)
        )));
    }
    let message = format!(
        "version=1\nrun-key={}\ndefinition-hash={}\nclaimed-by={}\nclaimed-at={}\n",
        payload.run_key, payload.definition_hash, payload.claimed_by, payload.claimed_at
    );
    let git_date = format!("@{} +0000", payload.claimed_at);
    let env = [
        ("GIT_AUTHOR_NAME", ROUTINE_SERVICE_AUTHOR_NAME),
        ("GIT_AUTHOR_EMAIL", ROUTINE_SERVICE_AUTHOR_EMAIL),
        ("GIT_COMMITTER_NAME", ROUTINE_SERVICE_AUTHOR_NAME),
        ("GIT_COMMITTER_EMAIL", ROUTINE_SERVICE_AUTHOR_EMAIL),
        ("GIT_AUTHOR_DATE", git_date.as_str()),
        ("GIT_COMMITTER_DATE", git_date.as_str()),
    ];
    let mut args = vec!["commit-tree", empty_tree.stdout.trim()];
    if !parent.is_empty() {
        args.extend(["-p", parent]);
    }
    let commit = cli
        .exec_sensitive_with_stdin(repository, &args, &env, Some(&message), PROBE_TIMEOUT)
        .await?;
    if commit.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to create routine claim commit: {}",
            bounded_detail(&commit.stderr)
        )));
    }
    Ok(commit.stdout.trim().to_string())
}

enum RemoteRead {
    Oid(String),
    Missing,
    Failure(ProbeResult),
}

async fn read_remote_ref(
    cli: &GitCli,
    repository: &Path,
    push_url: &str,
    reference: &str,
) -> Result<RemoteRead, AppError> {
    let output = cli
        .exec_sensitive_with_stdin(
            repository,
            &["ls-remote", "--refs", "--quiet", push_url, reference],
            &[],
            None,
            PROBE_TIMEOUT,
        )
        .await?;
    if output.exit_code != 0 {
        return Ok(RemoteRead::Failure(classify_failure(&output)));
    }
    let oid = output
        .stdout
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .unwrap_or_default();
    if oid.is_empty() {
        Ok(RemoteRead::Missing)
    } else {
        Ok(RemoteRead::Oid(oid.to_string()))
    }
}

async fn create_service_commit(
    cli: &GitCli,
    repository: &Path,
    installation_hash: &str,
    checked_at: i64,
) -> Result<String, AppError> {
    let empty_tree = cli
        .exec_sensitive_with_stdin(
            repository,
            &["hash-object", "-w", "-t", "tree", "--stdin"],
            &[],
            Some(""),
            PROBE_TIMEOUT,
        )
        .await?;
    if empty_tree.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to create access service tree: {}",
            bounded_detail(&empty_tree.stderr)
        )));
    }
    let tree_oid = empty_tree.stdout.trim();
    let nonce = ulid::Ulid::new().to_string().to_lowercase();
    let message = format!(
        "version=1\ninstallation={installation_hash}\nnonce={nonce}\nchecked-at={checked_at}\n"
    );
    let git_date = format!("@{checked_at} +0000");
    let env = [
        ("GIT_AUTHOR_NAME", SERVICE_AUTHOR_NAME),
        ("GIT_AUTHOR_EMAIL", SERVICE_AUTHOR_EMAIL),
        ("GIT_COMMITTER_NAME", SERVICE_AUTHOR_NAME),
        ("GIT_COMMITTER_EMAIL", SERVICE_AUTHOR_EMAIL),
        ("GIT_AUTHOR_DATE", git_date.as_str()),
        ("GIT_COMMITTER_DATE", git_date.as_str()),
    ];
    let commit = cli
        .exec_sensitive_with_stdin(
            repository,
            &["commit-tree", tree_oid],
            &env,
            Some(&message),
            PROBE_TIMEOUT,
        )
        .await?;
    if commit.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "failed to create access service commit: {}",
            bounded_detail(&commit.stderr)
        )));
    }
    Ok(commit.stdout.trim().to_string())
}

fn classify_failure(output: &GitOutput) -> ProbeResult {
    let detail = format!("{}\n{}", output.stderr, output.stdout).to_ascii_lowercase();
    let reason = if output.exit_code == -2
        || contains_any(
            &detail,
            &[
                "could not resolve host",
                "connection timed out",
                "operation timed out",
                "network is unreachable",
                "connection refused",
                "connection reset",
                "remote end hung up unexpectedly",
            ],
        ) {
        RepositoryAccessReason::OfflineOrTimeout
    } else if contains_any(
        &detail,
        &[
            "authentication failed",
            "could not read username",
            "terminal prompts disabled",
            "permission denied (publickey)",
            "missing credentials",
            "missing or invalid credentials",
        ],
    ) {
        RepositoryAccessReason::AuthRequired
    } else if contains_any(
        &detail,
        &[
            "deny updating a hidden ref",
            "funny ref",
            "invalid refspec",
            "refusing to create",
            "prohibited by config",
        ],
    ) {
        RepositoryAccessReason::UnsupportedRef
    } else if contains_any(&detail, &["stale info", "force-with-lease", "fetch first"]) {
        RepositoryAccessReason::LeaseConflict
    } else if contains_any(
        &detail,
        &[
            "permission denied",
            "write access to repository not granted",
            "not allowed to push",
        ],
    ) {
        return ProbeResult {
            status: RepositoryAccessStatus::ReadOnly,
            reason: None,
        };
    } else {
        RepositoryAccessReason::AmbiguousRejection
    };
    ProbeResult {
        status: RepositoryAccessStatus::Unknown,
        reason: Some(reason),
    }
}

fn exact_lease(reference: &str, expected: &str) -> String {
    format!("--force-with-lease={reference}:{expected}")
}

fn resolve_uncertain_result(
    failure: ProbeResult,
    new_oid: &str,
    readback: RemoteRead,
) -> ProbeResult {
    if matches!(readback, RemoteRead::Oid(ref oid) if oid == new_oid) {
        ProbeResult {
            status: RepositoryAccessStatus::Writable,
            reason: None,
        }
    } else {
        failure
    }
}

fn contains_any(detail: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| detail.contains(needle))
}

fn bounded_detail(detail: &str) -> String {
    detail.chars().take(512).collect()
}

fn snapshot_from_store(
    repository_id: &str,
    evidence: Option<&PersistedEvidence>,
    remote_fingerprint: &str,
    now: i64,
) -> RepositoryAccessSnapshot {
    let Some(evidence) = evidence else {
        return unknown_snapshot(repository_id, RepositoryAccessReason::NotChecked, None);
    };
    if evidence.remote_fingerprint != remote_fingerprint {
        return unknown_snapshot(
            repository_id,
            RepositoryAccessReason::RemoteChanged,
            Some(evidence.status),
        );
    }
    if matches!(
        evidence.status,
        RepositoryAccessStatus::Writable | RepositoryAccessStatus::ReadOnly
    ) && evidence
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return RepositoryAccessSnapshot {
            repository_id: repository_id.to_string(),
            generation: 0,
            status: RepositoryAccessStatus::Unknown,
            reason: Some(RepositoryAccessReason::Expired),
            checked_at: Some(evidence.checked_at),
            expires_at: evidence.expires_at,
            last_known_status: Some(evidence.status),
        };
    }
    RepositoryAccessSnapshot {
        repository_id: repository_id.to_string(),
        generation: 0,
        status: evidence.status,
        reason: evidence.reason,
        checked_at: Some(evidence.checked_at),
        expires_at: evidence.expires_at,
        last_known_status: None,
    }
}

fn refresh_expiration(snapshot: &RepositoryAccessSnapshot, now: i64) -> RepositoryAccessSnapshot {
    if matches!(
        snapshot.status,
        RepositoryAccessStatus::Writable | RepositoryAccessStatus::ReadOnly
    ) && snapshot
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return RepositoryAccessSnapshot {
            repository_id: snapshot.repository_id.clone(),
            generation: snapshot.generation,
            status: RepositoryAccessStatus::Unknown,
            reason: Some(RepositoryAccessReason::Expired),
            checked_at: snapshot.checked_at,
            expires_at: snapshot.expires_at,
            last_known_status: Some(snapshot.status),
        };
    }
    snapshot.clone()
}

fn unknown_snapshot(
    repository_id: &str,
    reason: RepositoryAccessReason,
    last_known_status: Option<RepositoryAccessStatus>,
) -> RepositoryAccessSnapshot {
    RepositoryAccessSnapshot {
        repository_id: repository_id.to_string(),
        generation: 0,
        status: RepositoryAccessStatus::Unknown,
        reason: Some(reason),
        checked_at: None,
        expires_at: None,
        last_known_status,
    }
}

fn read_store_file(path: &Path) -> Result<AccessStore, AppError> {
    if !path.exists() {
        return Ok(AccessStore {
            version: ACCESS_STORE_VERSION,
            ..AccessStore::default()
        });
    }
    let raw = fs::read_to_string(path)?;
    let store: AccessStore = serde_json::from_str(&raw)?;
    if store.version != ACCESS_STORE_VERSION {
        return Ok(AccessStore {
            version: ACCESS_STORE_VERSION,
            ..AccessStore::default()
        });
    }
    Ok(store)
}

fn write_store_file(path: &Path, store: &AccessStore) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

fn trim_evidence(evidence: &mut HashMap<String, PersistedEvidence>) {
    if evidence.len() <= MAX_EVIDENCE_ENTRIES {
        return;
    }
    let mut entries: Vec<_> = evidence
        .iter()
        .map(|(key, value)| (key.clone(), value.checked_at))
        .collect();
    entries.sort_by_key(|(_, checked_at)| *checked_at);
    for (key, _) in entries
        .into_iter()
        .take(evidence.len().saturating_sub(MAX_EVIDENCE_ENTRIES))
    {
        evidence.remove(&key);
    }
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn opaque_id(prefix: &str, value: &str) -> String {
    format!("{prefix}-{}", stable_hash(value))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicI64, Ordering};

    use tempfile::TempDir;

    use super::*;

    struct TestClock {
        now: AtomicI64,
    }

    impl TestClock {
        fn new(now: i64) -> Self {
            Self {
                now: AtomicI64::new(now),
            }
        }

        fn set(&self, now: i64) {
            self.now.store(now, Ordering::SeqCst);
        }
    }

    impl Clock for TestClock {
        fn now_unix(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }
    }

    async fn git_ok(cli: &GitCli, dir: &Path, args: &[&str]) -> GitOutput {
        let output = cli.exec(dir, args).await.expect("run git");
        assert_eq!(
            output.exit_code,
            0,
            "git {} failed: {}",
            args.join(" "),
            output.stderr
        );
        output
    }

    async fn init_repository(cli: &GitCli, root: &Path) {
        fs::create_dir_all(root).expect("create repository directory");
        git_ok(cli, root, &["init"]).await;
    }

    async fn init_bare(cli: &GitCli, root: &Path) {
        fs::create_dir_all(root).expect("create bare directory");
        git_ok(cli, root, &["init", "--bare"]).await;
    }

    async fn add_origin(cli: &GitCli, repository: &Path, remote: &Path) {
        let remote = remote.to_string_lossy();
        git_ok(cli, repository, &["remote", "add", "origin", &remote]).await;
    }

    fn test_state(clock: Arc<TestClock>) -> RepositoryAccessState {
        RepositoryAccessState::with_clock(clock)
    }

    #[tokio::test]
    async fn access_local_repository_and_inline_scope_share_one_publication() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let inline = repository.join("docs");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        fs::create_dir_all(&inline).expect("inline directory");
        let state = test_state(Arc::new(TestClock::new(1_000)));
        let store = temp.path().join("access.json");

        let root = state
            .snapshot(&cli, &repository, &store)
            .await
            .expect("root snapshot");
        let child = state
            .snapshot(&cli, &inline, &store)
            .await
            .expect("inline snapshot");

        assert_eq!(root.status, RepositoryAccessStatus::Local);
        assert_eq!(child.status, RepositoryAccessStatus::Local);
        assert_eq!(root.repository_id, child.repository_id);
        assert_eq!(child.generation, root.generation);
        assert!(!store.exists(), "local reads must not create evidence");
    }

    #[tokio::test]
    async fn access_probe_writes_one_parentless_service_ref_with_exact_identity() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let remote = temp.path().join("remote.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        init_bare(&cli, &remote).await;
        add_origin(&cli, &repository, &remote).await;
        let state = test_state(Arc::new(TestClock::new(1_700_000_000)));
        let store = temp.path().join("state/access.json");

        let first = state
            .verify(&cli, &repository, &store)
            .await
            .expect("first access probe");
        let second = state
            .verify(&cli, &repository, &store)
            .await
            .expect("second access probe");

        assert_eq!(first.status, RepositoryAccessStatus::Writable);
        assert_eq!(second.status, RepositoryAccessStatus::Writable);
        let persisted = read_store_file(&store).expect("persisted store");
        let installation_hash = stable_hash(&persisted.installation_id);
        let reference = format!("refs/svode/access/{installation_hash}");
        let remote_oid = git_ok(&cli, &remote, &["rev-parse", &reference])
            .await
            .stdout
            .trim()
            .to_string();
        let commit = git_ok(&cli, &remote, &["cat-file", "-p", &remote_oid])
            .await
            .stdout;

        assert!(!commit.lines().any(|line| line.starts_with("parent ")));
        assert!(commit.contains("author Svode Access Probe <access@svode.invalid>"));
        assert!(commit.contains("committer Svode Access Probe <access@svode.invalid>"));
        assert!(commit.contains("version=1"));
        assert!(commit.contains(&format!("installation={installation_hash}")));
        assert!(!commit.contains(&repository.to_string_lossy().to_string()));
        assert_eq!(
            exact_lease(&reference, ""),
            format!("--force-with-lease={reference}:")
        );
    }

    #[tokio::test]
    async fn routine_claim_allows_only_one_clone_and_keeps_service_ref_history() {
        let temp = TempDir::new().expect("temp dir");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let remote = temp.path().join("remote.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &first).await;
        init_repository(&cli, &second).await;
        init_bare(&cli, &remote).await;
        add_origin(&cli, &first, &remote).await;
        add_origin(&cli, &second, &remote).await;
        let first_state = test_state(Arc::new(TestClock::new(1_700_000_000)));
        let second_state = test_state(Arc::new(TestClock::new(1_700_000_000)));
        let first_store = temp.path().join("first-access.json");
        let second_store = temp.path().join("second-access.json");
        let first_access = first_state
            .verify(&cli, &first, &first_store)
            .await
            .expect("first writable access");
        let second_access = second_state
            .verify(&cli, &second, &second_store)
            .await
            .expect("second writable access");
        assert_eq!(
            first_state
                .routine_repository_id(&cli, &first, &first_access)
                .await
                .unwrap(),
            second_state
                .routine_repository_id(&cli, &second, &second_access)
                .await
                .unwrap()
        );

        let (first_claim, second_claim) = tokio::join!(
            first_state.claim_routine(
                &cli,
                &first,
                &first_store,
                &first_access,
                "routine-one",
                "slot-one",
                "definition-one",
                1_700_000_100,
            ),
            second_state.claim_routine(
                &cli,
                &second,
                &second_store,
                &second_access,
                "routine-one",
                "slot-one",
                "definition-one",
                1_700_000_100,
            )
        );
        let claims = [first_claim.unwrap(), second_claim.unwrap()];
        assert_eq!(
            claims
                .iter()
                .filter(|claim| matches!(claim, RoutineClaimResult::Claimed { .. }))
                .count(),
            1,
            "claims: {claims:?}"
        );
        assert_eq!(
            claims
                .iter()
                .filter(|claim| matches!(claim, RoutineClaimResult::AlreadyClaimed { .. }))
                .count(),
            1
        );

        let second_slot = first_state
            .claim_routine(
                &cli,
                &first,
                &first_store,
                &first_access,
                "routine-one",
                "slot-two",
                "definition-one",
                1_700_000_200,
            )
            .await
            .expect("second slot claim");
        assert!(matches!(second_slot, RoutineClaimResult::Claimed { .. }));
        let reference = format!("refs/svode/routines/{}", stable_hash("routine-one"));
        let oid = git_ok(&cli, &remote, &["rev-parse", &reference])
            .await
            .stdout
            .trim()
            .to_string();
        let commit = git_ok(&cli, &remote, &["cat-file", "-p", &oid])
            .await
            .stdout;
        assert!(commit.lines().any(|line| line.starts_with("parent ")));
        assert!(commit.contains("run-key=slot-two"));
        assert!(commit.contains("definition-hash=definition-one"));
        assert!(
            git_ok(&cli, &first, &["status", "--porcelain"])
                .await
                .stdout
                .is_empty()
        );
    }

    #[test]
    fn routine_claim_uncertain_push_requires_exact_readback() {
        assert!(routine_claim_readback_confirms(
            "own-oid",
            &RemoteRead::Oid("own-oid".into())
        ));
        assert!(!routine_claim_readback_confirms(
            "own-oid",
            &RemoteRead::Oid("other-oid".into())
        ));
        assert!(!routine_claim_readback_confirms(
            "own-oid",
            &RemoteRead::Missing
        ));
    }

    #[tokio::test]
    async fn access_probe_uses_pushurl_and_changed_fingerprint_fails_closed() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let fetch_remote = temp.path().join("fetch.git");
        let push_remote = temp.path().join("push.git");
        let changed_remote = temp.path().join("changed.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        init_bare(&cli, &fetch_remote).await;
        init_bare(&cli, &push_remote).await;
        init_bare(&cli, &changed_remote).await;
        add_origin(&cli, &repository, &fetch_remote).await;
        let push_remote_arg = push_remote.to_string_lossy();
        git_ok(
            &cli,
            &repository,
            &["config", "remote.origin.pushurl", &push_remote_arg],
        )
        .await;
        let clock = Arc::new(TestClock::new(2_000));
        let state = test_state(clock);
        let store = temp.path().join("access.json");

        let verified = state
            .verify(&cli, &repository, &store)
            .await
            .expect("verify pushurl");
        assert_eq!(verified.status, RepositoryAccessStatus::Writable);
        let persisted = read_store_file(&store).expect("persisted store");
        let reference = format!(
            "refs/svode/access/{}",
            stable_hash(&persisted.installation_id)
        );
        assert!(
            git_ok(&cli, &push_remote, &["rev-parse", &reference])
                .await
                .stdout
                .trim()
                .len()
                > 10
        );
        let fetch_lookup = cli
            .exec(&fetch_remote, &["rev-parse", "--verify", &reference])
            .await
            .expect("fetch lookup");
        assert_ne!(fetch_lookup.exit_code, 0);

        let changed_remote_arg = changed_remote.to_string_lossy();
        git_ok(
            &cli,
            &repository,
            &["config", "remote.origin.pushurl", &changed_remote_arg],
        )
        .await;
        let changed = state
            .snapshot(&cli, &repository, &store)
            .await
            .expect("changed snapshot");
        assert_eq!(changed.status, RepositoryAccessStatus::Unknown);
        assert_eq!(changed.reason, Some(RepositoryAccessReason::RemoteChanged));
        assert_eq!(
            changed.last_known_status,
            Some(RepositoryAccessStatus::Writable)
        );
    }

    #[tokio::test]
    async fn access_evidence_survives_restart_and_expires_without_network() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let remote = temp.path().join("remote.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        init_bare(&cli, &remote).await;
        add_origin(&cli, &repository, &remote).await;
        let clock = Arc::new(TestClock::new(5_000));
        let store = temp.path().join("access.json");
        test_state(clock.clone())
            .record_writable_evidence(&cli, &repository, &store)
            .await
            .expect("record successful push");

        let restarted = test_state(clock.clone());
        let fresh = restarted
            .snapshot(&cli, &repository, &store)
            .await
            .expect("fresh persisted snapshot");
        assert_eq!(fresh.status, RepositoryAccessStatus::Writable);

        clock.set(5_000 + ACCESS_EVIDENCE_TTL_SECONDS + 1);
        let expired_restart = test_state(clock);
        let expired = expired_restart
            .snapshot(&cli, &repository, &store)
            .await
            .expect("expired snapshot");
        assert_eq!(expired.status, RepositoryAccessStatus::Unknown);
        assert_eq!(expired.reason, Some(RepositoryAccessReason::Expired));
        assert_eq!(
            expired.last_known_status,
            Some(RepositoryAccessStatus::Writable)
        );
    }

    #[tokio::test]
    async fn access_explicit_verification_is_single_flight_per_repository() {
        let state = Arc::new(test_state(Arc::new(TestClock::new(10))));
        let repository = PathBuf::from("/virtual/repository");
        let owner = state
            .acquire_probe(&repository)
            .await
            .expect("owner permit");
        let ProbePermit::Owner(owner_guard) = owner else {
            panic!("first caller must own probe");
        };
        let joined_state = state.clone();
        let joined_repository = repository.clone();
        let joined = tokio::spawn(async move {
            joined_state
                .acquire_probe(&joined_repository)
                .await
                .expect("joined permit")
        });
        tokio::task::yield_now().await;
        drop(owner_guard);

        assert!(matches!(
            joined.await.expect("joined task"),
            ProbePermit::Joined
        ));
        assert!(matches!(
            state
                .acquire_probe(&repository)
                .await
                .expect("later explicit permit"),
            ProbePermit::Owner(_)
        ));
    }

    #[test]
    fn access_failure_matrix_and_uncertain_readback_are_fail_closed() {
        let cases = [
            (
                GitOutput {
                    stdout: String::new(),
                    stderr: "Authentication failed".into(),
                    exit_code: 1,
                },
                RepositoryAccessStatus::Unknown,
                Some(RepositoryAccessReason::AuthRequired),
            ),
            (
                GitOutput {
                    stdout: String::new(),
                    stderr: "connection timed out".into(),
                    exit_code: -2,
                },
                RepositoryAccessStatus::Unknown,
                Some(RepositoryAccessReason::OfflineOrTimeout),
            ),
            (
                GitOutput {
                    stdout: String::new(),
                    stderr: "deny updating a hidden ref".into(),
                    exit_code: 1,
                },
                RepositoryAccessStatus::Unknown,
                Some(RepositoryAccessReason::UnsupportedRef),
            ),
            (
                GitOutput {
                    stdout: String::new(),
                    stderr: "write access to repository not granted".into(),
                    exit_code: 1,
                },
                RepositoryAccessStatus::ReadOnly,
                None,
            ),
            (
                GitOutput {
                    stdout: String::new(),
                    stderr: "stale info".into(),
                    exit_code: 1,
                },
                RepositoryAccessStatus::Unknown,
                Some(RepositoryAccessReason::LeaseConflict),
            ),
        ];
        for (output, status, reason) in cases {
            let classified = classify_failure(&output);
            assert_eq!(classified.status, status);
            assert_eq!(classified.reason, reason);
        }

        let uncertain = ProbeResult {
            status: RepositoryAccessStatus::Unknown,
            reason: Some(RepositoryAccessReason::AmbiguousRejection),
        };
        assert_eq!(
            resolve_uncertain_result(
                uncertain,
                "new-object",
                RemoteRead::Oid("new-object".into())
            ),
            ProbeResult {
                status: RepositoryAccessStatus::Writable,
                reason: None,
            }
        );
        assert_eq!(
            resolve_uncertain_result(
                uncertain,
                "new-object",
                RemoteRead::Oid("other-object".into())
            ),
            uncertain
        );
    }

    #[tokio::test]
    async fn access_multiple_pushurls_are_unknown_without_probe() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let remote = temp.path().join("remote.git");
        let second = temp.path().join("second.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        init_bare(&cli, &remote).await;
        init_bare(&cli, &second).await;
        add_origin(&cli, &repository, &remote).await;
        for pushurl in [&remote, &second] {
            let pushurl = pushurl.to_string_lossy();
            git_ok(
                &cli,
                &repository,
                &["config", "--add", "remote.origin.pushurl", &pushurl],
            )
            .await;
        }
        let state = test_state(Arc::new(TestClock::new(100)));
        let snapshot = state
            .verify(&cli, &repository, &temp.path().join("access.json"))
            .await
            .expect("unsupported snapshot");
        assert_eq!(snapshot.status, RepositoryAccessStatus::Unknown);
        assert_eq!(
            snapshot.reason,
            Some(RepositoryAccessReason::UnsupportedRemoteConfiguration)
        );
        assert!(!temp.path().join("access.json").exists());
    }

    #[test]
    fn mutation_gate_matrix_and_automatic_eligibility_allow_only_local_or_writable() {
        for (status, allowed) in [
            (RepositoryAccessStatus::Local, true),
            (RepositoryAccessStatus::Checking, false),
            (RepositoryAccessStatus::Writable, true),
            (RepositoryAccessStatus::ReadOnly, false),
            (RepositoryAccessStatus::Unknown, false),
        ] {
            let snapshot = RepositoryAccessSnapshot {
                repository_id: "repo".to_string(),
                generation: 1,
                status,
                reason: (!allowed).then_some(RepositoryAccessReason::NotChecked),
                checked_at: (status == RepositoryAccessStatus::Writable).then_some(10),
                expires_at: (status == RepositoryAccessStatus::Writable)
                    .then_some(10 + ACCESS_EVIDENCE_TTL_SECONDS),
                last_known_status: None,
            };
            assert_eq!(
                automatic_mutation_eligible(&snapshot, 10),
                allowed,
                "{status:?}"
            );
            assert_eq!(
                ensure_mutation_allowed(&snapshot, 10).is_ok(),
                allowed,
                "{status:?}"
            );
        }
    }

    #[test]
    fn automatic_eligibility_requires_fresh_bounded_writable_evidence() {
        let writable = |checked_at, expires_at| RepositoryAccessSnapshot {
            repository_id: "repo".to_string(),
            generation: 1,
            status: RepositoryAccessStatus::Writable,
            reason: None,
            checked_at,
            expires_at,
            last_known_status: None,
        };

        assert!(automatic_mutation_eligible(
            &writable(Some(100), Some(100 + ACCESS_EVIDENCE_TTL_SECONDS)),
            101,
        ));
        assert!(!automatic_mutation_eligible(
            &writable(Some(100), Some(101)),
            101,
        ));
        assert!(!automatic_mutation_eligible(
            &writable(Some(100), None),
            101,
        ));
        assert!(!automatic_mutation_eligible(
            &writable(Some(200), Some(200 + ACCESS_EVIDENCE_TTL_SECONDS)),
            101,
        ));
        assert!(!automatic_mutation_eligible(
            &writable(Some(100), Some(100 + ACCESS_EVIDENCE_TTL_SECONDS + 1),),
            101,
        ));
    }

    #[tokio::test]
    async fn mutation_gate_rejects_expired_and_remote_changed_evidence() {
        let temp = TempDir::new().expect("temp dir");
        let repository = temp.path().join("repository");
        let remote = temp.path().join("remote.git");
        let changed_remote = temp.path().join("changed.git");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &repository).await;
        init_bare(&cli, &remote).await;
        init_bare(&cli, &changed_remote).await;
        add_origin(&cli, &repository, &remote).await;
        let clock = Arc::new(TestClock::new(1_000));
        let store = temp.path().join("access.json");
        let state = test_state(clock.clone());
        state
            .record_writable_evidence(&cli, &repository, &store)
            .await
            .expect("record evidence");

        clock.set(1_000 + ACCESS_EVIDENCE_TTL_SECONDS + 1);
        let expired = test_state(clock.clone())
            .require_mutation(&cli, &repository, &store)
            .await
            .expect_err("expired evidence must fail closed");
        assert!(matches!(
            expired,
            AppError::RepositoryAccessDenied { ref status, ref reason, .. }
                if status == "unknown" && reason == "expired"
        ));

        clock.set(2_000);
        let changed_remote_arg = changed_remote.to_string_lossy();
        git_ok(
            &cli,
            &repository,
            &["config", "remote.origin.pushurl", &changed_remote_arg],
        )
        .await;
        let changed = test_state(clock)
            .require_mutation(&cli, &repository, &store)
            .await
            .expect_err("changed remote must fail closed");
        assert!(matches!(
            changed,
            AppError::RepositoryAccessDenied { ref status, ref reason, .. }
                if status == "unknown" && reason == "remote_changed"
        ));
    }

    #[tokio::test]
    async fn authorized_child_plan_does_not_authorize_parent_repository_writes() {
        let temp = TempDir::new().expect("temp dir");
        let parent = temp.path().join("project");
        let child = parent.join("child");
        let cli = GitCli::detect().expect("git");
        init_repository(&cli, &parent).await;
        init_repository(&cli, &child).await;
        let child_target = child.join("entry.md");
        let parent_target = parent.join(".svode").join("config.json");

        scope_authorized_mutation_paths(vec![child_target.clone()], async {
            ensure_mutation_paths_were_authorized(&[child_target])?;
            let denied = ensure_mutation_paths_were_authorized(&[parent_target])
                .expect_err("child-only plan must not authorize a parent write");
            assert!(matches!(
                denied,
                AppError::RepositoryAccessDenied { ref reason, .. }
                    if reason == "mutation_plan_changed"
            ));
            Ok::<(), AppError>(())
        })
        .await
        .expect("authorized child plan");
    }
}
