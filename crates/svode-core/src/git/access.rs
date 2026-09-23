use std::collections::HashMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::GitError;
use super::cli::{GitCli, GitOutput};

/// File name of the device-local repository access evidence store inside
/// the config directory of the install.
pub const ACCESS_STORE_FILE: &str = "repository-access.json";
const ACCESS_STORE_VERSION: u32 = 1;
const MAX_EVIDENCE_ENTRIES: usize = 128;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest wait for the store lock held by another process. Not a public contract.
const STORE_LOCK_WAIT: Duration = Duration::from_secs(2);
const STORE_LOCK_RETRY: Duration = Duration::from_millis(5);
pub const ACCESS_EVIDENCE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

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
pub enum RoutineClaimResult {
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
    /// Stored evidence the own verification behind this result started from;
    /// `None` when the result does not come from an own verification.
    verification_base: Option<Option<PersistedEvidence>>,
}

impl PublishedSnapshot {
    /// An inconclusive result yields to conclusive evidence that another
    /// process saved after the verification behind it started.
    fn yields_to(&self, stored: Option<&PersistedEvidence>) -> bool {
        let Some(stored) = stored.filter(|stored| conclusive(stored.status)) else {
            return false;
        };
        !conclusive(self.snapshot.status)
            && self
                .verification_base
                .as_ref()
                .is_none_or(|base| base.as_ref() != Some(stored))
    }
}

/// The own verification a result comes from: the generation of its
/// `checking` publication and the stored evidence it started from.
struct Verification {
    generation: u64,
    base: Option<PersistedEvidence>,
}

/// Exclusive read-modify-write access to the store across the processes of
/// one installation.
struct StoreLock<'a> {
    _process: MutexGuard<'a, ()>,
    _file: File,
}

#[derive(Debug, Clone)]
struct RemoteConfig {
    push_url: String,
    fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedEvidence {
    remote_fingerprint: String,
    status: RepositoryAccessStatus,
    reason: Option<RepositoryAccessReason>,
    checked_at: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomaticAttempt {
    remote_fingerprint: String,
    checked_at: Option<i64>,
    consumed: bool,
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
    #[serde(default)]
    automatic_attempts: HashMap<String, AutomaticAttempt>,
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
    generation: AtomicU64,
    snapshots: Mutex<HashMap<PathBuf, Arc<PublishedSnapshot>>>,
    probe_locks: Mutex<HashMap<PathBuf, Arc<ProbeFlight>>>,
    persistence_lock: Mutex<()>,
}

impl RepositoryAccessState {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            generation: AtomicU64::new(0),
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
    ) -> Result<RepositoryAccessSnapshot, GitError> {
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
                let observed = self.cached(&repository)?;
                if let Some(observed) = &observed
                    && observed.snapshot.status == RepositoryAccessStatus::Checking
                {
                    return Ok(observed.snapshot.clone());
                }
                let current = observed.as_ref().filter(|current| {
                    current.remote_fingerprint.as_deref() == Some(remote.fingerprint.as_str())
                });
                // The shared store is authoritative across processes; the cache
                // only wins with a strictly newer result of this process, and an
                // inconclusive one yields to conclusive evidence saved after it started.
                let (stored, stored_evidence) = match self.read_store(store_path) {
                    Ok(store) => (
                        snapshot_from_store(&repository_id, &store, &remote.fingerprint, now),
                        store
                            .evidence
                            .get(&repository_id)
                            .filter(|evidence| evidence.remote_fingerprint == remote.fingerprint)
                            .cloned(),
                    ),
                    Err(error) => {
                        let Some(current) = current else {
                            return Err(error);
                        };
                        tracing::warn!("failed to read repository access evidence: {error}");
                        (refresh_expiration(&current.snapshot, now), None)
                    }
                };
                let mut selected = match current {
                    Some(current)
                        if current.snapshot.checked_at > stored.checked_at
                            && !current.yields_to(stored_evidence.as_ref()) =>
                    {
                        refresh_expiration(&current.snapshot, now)
                    }
                    _ => stored,
                };
                if let Some(current) = current {
                    selected.generation = current.snapshot.generation;
                    if selected == current.snapshot {
                        return Ok(selected);
                    }
                }
                let mut snapshots = self.snapshots.lock().map_err(|_| {
                    GitError::General("repository access snapshot lock poisoned".into())
                })?;
                // A concurrent publication of this process, such as its own
                // `checking`, is newer than what this read selected from.
                if let Some(latest) = snapshots.get(&repository)
                    && observed.as_ref().is_none_or(|observed| {
                        observed.snapshot.generation != latest.snapshot.generation
                    })
                {
                    return Ok(latest.snapshot.clone());
                }
                Ok(self.publish_locked(
                    &mut snapshots,
                    &repository,
                    Some(remote.fingerprint),
                    selected,
                    None,
                ))
            }
        }
    }

    #[cfg(test)]
    pub async fn verify(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        self.verify_requested(cli, space_path, store_path, false, |_| {})
            .await
    }

    pub async fn verify_requested(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
        automatic: bool,
        on_checking: impl Fn(&str),
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        let repository = resolve_repository(cli, space_path).await?;
        let permit = self.acquire_probe(&repository, automatic).await?;
        if matches!(permit, ProbePermit::Joined) {
            if let Some(snapshot) = self.cached(&repository)? {
                return Ok(snapshot.snapshot.clone());
            }
            return self.snapshot(cli, &repository, store_path).await;
        }
        let mut guard = match permit {
            ProbePermit::Owner(guard) => guard,
            ProbePermit::Joined => unreachable!(),
        };

        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        let remote = match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => {
                return self.publish(
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
                );
            }
            RemoteInspection::Unsupported => {
                return self.publish(
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
                );
            }
            RemoteInspection::Remote(remote) => remote,
        };

        let checking = {
            let mut snapshots = self.snapshots.lock().map_err(|_| {
                GitError::General("repository access snapshot lock poisoned".into())
            })?;
            let _lock = self.lock_store(store_path)?;
            let mut store = read_store_file(store_path)?;
            let evidence = store.evidence.get(&repository_id);
            let base = evidence
                .filter(|value| value.remote_fingerprint == remote.fingerprint)
                .cloned();
            let eligible = automatic_attempt_eligible(
                evidence,
                store.automatic_attempts.get(&repository_id),
                &remote.fingerprint,
                self.clock.now_unix(),
            );
            // A newer in-memory success also blocks probing if its durable write failed.
            let fresh = snapshots.get(&repository).is_some_and(|current| {
                current.remote_fingerprint.as_deref() == Some(&remote.fingerprint)
                    && current.snapshot.status == RepositoryAccessStatus::Writable
                    && current
                        .snapshot
                        .expires_at
                        .is_some_and(|expiry| expiry > self.clock.now_unix())
            });
            if automatic && (!eligible || fresh) {
                None
            } else {
                store.automatic_attempts.insert(
                    repository_id.clone(),
                    AutomaticAttempt {
                        remote_fingerprint: remote.fingerprint.clone(),
                        checked_at: evidence.map(|value| value.checked_at),
                        consumed: true,
                    },
                );
                // The reservation must survive a crash before any network IO starts.
                write_store_file(store_path, &store)?;
                let last_known_status = snapshots
                    .get(&repository)
                    .map(|current| current.snapshot.status);
                let checking = self.publish_locked(
                    &mut snapshots,
                    &repository,
                    Some(remote.fingerprint.clone()),
                    RepositoryAccessSnapshot {
                        repository_id: repository_id.clone(),
                        generation: 0,
                        status: RepositoryAccessStatus::Checking,
                        reason: None,
                        checked_at: None,
                        expires_at: None,
                        last_known_status,
                    },
                    None,
                );
                Some(Verification {
                    generation: checking.generation,
                    base,
                })
            }
        };
        let Some(verification) = checking else {
            return self.snapshot(cli, &repository, store_path).await;
        };
        guard.attempted = true;
        on_checking(&repository_id);

        let installation_id = match self.ensure_installation_id(store_path) {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.publish_probe_error(
                    &repository,
                    &repository_id,
                    &remote.fingerprint,
                    &verification,
                )?;
                return Err(error);
            }
        };
        let installation_hash = stable_hash(&installation_id);
        let started_at = self.clock.now_unix();
        let result =
            match probe_remote(cli, &repository, &remote, &installation_hash, started_at).await {
                Ok(result) => result,
                Err(error) => {
                    self.publish_probe_error(
                        &repository,
                        &repository_id,
                        &remote.fingerprint,
                        &verification,
                    )?;
                    return Err(error);
                }
            };
        let checked_at = self.clock.now_unix();
        let current_remote = match inspect_remote(cli, &repository).await {
            Ok(remote) => remote,
            Err(error) => {
                self.publish_probe_error(
                    &repository,
                    &repository_id,
                    &remote.fingerprint,
                    &verification,
                )?;
                return Err(error);
            }
        };
        if !matches!(current_remote, RemoteInspection::Remote(current) if current.fingerprint == remote.fingerprint)
        {
            {
                let mut snapshots = self.snapshots.lock().map_err(|_| {
                    GitError::General("repository access snapshot lock poisoned".into())
                })?;
                if snapshots
                    .get(&repository)
                    .is_some_and(|current| current.snapshot.generation == verification.generation)
                {
                    snapshots.remove(&repository);
                }
            }
            return self.snapshot(cli, &repository, store_path).await;
        }
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
        self.persist_and_publish(
            &repository,
            &remote.fingerprint,
            snapshot,
            store_path,
            Some(&verification),
        )
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
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        let snapshot = self.snapshot(cli, space_path, store_path).await?;
        ensure_mutation_allowed(&snapshot, self.clock.now_unix())?;
        Ok(snapshot)
    }

    pub async fn claim_routine(
        &self,
        cli: &GitCli,
        repository: &Path,
        store_path: &Path,
        snapshot: &RepositoryAccessSnapshot,
        routine_id: &str,
        run_key: &str,
        definition_hash: &str,
        claimed_at: i64,
    ) -> Result<RoutineClaimResult, GitError> {
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

    pub async fn routine_repository_id(
        &self,
        cli: &GitCli,
        repository: &Path,
        snapshot: &RepositoryAccessSnapshot,
    ) -> Result<Option<String>, GitError> {
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

    pub async fn record_writable_evidence(
        &self,
        cli: &GitCli,
        space_path: &Path,
        store_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        let repository = resolve_repository(cli, space_path).await?;
        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        let remote = match inspect_remote(cli, &repository).await? {
            RemoteInspection::Local => {
                return self.publish(
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
                );
            }
            RemoteInspection::Unsupported => {
                return self.publish(
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
                );
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
            None,
        )
    }

    pub async fn invalidate(&self, cli: &GitCli, space_path: &Path) -> Result<String, GitError> {
        let repository = resolve_repository(cli, space_path).await?;
        let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
        self.snapshots
            .lock()
            .map_err(|_| GitError::General("repository access snapshot lock poisoned".into()))?
            .remove(&repository);
        Ok(repository_id)
    }

    fn cached(&self, repository: &Path) -> Result<Option<Arc<PublishedSnapshot>>, GitError> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.get(repository).cloned())
            .map_err(|_| GitError::General("repository access snapshot lock poisoned".into()))
    }

    fn publish(
        &self,
        repository: &Path,
        remote_fingerprint: Option<String>,
        snapshot: RepositoryAccessSnapshot,
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| GitError::General("repository access snapshot lock poisoned".into()))?;
        Ok(self.publish_locked(
            &mut snapshots,
            repository,
            remote_fingerprint,
            snapshot,
            None,
        ))
    }

    fn publish_locked(
        &self,
        snapshots: &mut HashMap<PathBuf, Arc<PublishedSnapshot>>,
        repository: &Path,
        remote_fingerprint: Option<String>,
        mut snapshot: RepositoryAccessSnapshot,
        verification_base: Option<Option<PersistedEvidence>>,
    ) -> RepositoryAccessSnapshot {
        snapshot.generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        snapshots.insert(
            repository.to_path_buf(),
            Arc::new(PublishedSnapshot {
                remote_fingerprint,
                snapshot: snapshot.clone(),
                verification_base,
            }),
        );
        snapshot
    }

    fn persist_and_publish(
        &self,
        repository: &Path,
        remote_fingerprint: &str,
        snapshot: RepositoryAccessSnapshot,
        store_path: &Path,
        verification: Option<&Verification>,
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| GitError::General("repository access snapshot lock poisoned".into()))?;
        if let Some(verification) = verification {
            let current = snapshots.get(repository).ok_or_else(|| {
                GitError::General(
                    "Repository access changed during verification. Check again.".into(),
                )
            })?;
            if current.snapshot.generation != verification.generation {
                return Ok(current.snapshot.clone());
            }
        }
        let verification_base = verification.map(|verification| verification.base.clone());
        let persist_result = (|| -> Result<Option<RepositoryAccessSnapshot>, GitError> {
            let _lock = self.lock_store(store_path)?;
            let mut store = read_store_file(store_path)?;
            let result = PersistedEvidence {
                remote_fingerprint: remote_fingerprint.to_string(),
                status: snapshot.status,
                reason: snapshot.reason,
                checked_at: snapshot.checked_at.unwrap_or_else(|| self.clock.now_unix()),
                expires_at: snapshot.expires_at,
            };
            let kept = store
                .evidence
                .get(&snapshot.repository_id)
                .filter(|stored| {
                    stored.remote_fingerprint == remote_fingerprint
                        && stored_prevails(stored, &result, verification_base.as_ref())
                })
                .cloned();
            let recorded = kept.clone().unwrap_or(result);
            // Bookkeeping follows the evidence that is actually stored.
            store.automatic_attempts.insert(
                snapshot.repository_id.clone(),
                AutomaticAttempt {
                    remote_fingerprint: remote_fingerprint.to_string(),
                    checked_at: Some(recorded.checked_at),
                    consumed: recorded.status != RepositoryAccessStatus::Writable,
                },
            );
            store
                .evidence
                .insert(snapshot.repository_id.clone(), recorded);
            // Preserve legacy negative recovery even if its detailed evidence is evicted.
            for (id, evidence) in &store.evidence {
                store
                    .automatic_attempts
                    .entry(id.clone())
                    .or_insert_with(|| AutomaticAttempt {
                        remote_fingerprint: evidence.remote_fingerprint.clone(),
                        checked_at: Some(evidence.checked_at),
                        consumed: evidence.status != RepositoryAccessStatus::Writable,
                    });
            }
            trim_evidence(&mut store.evidence);
            write_store_file(store_path, &store)?;
            Ok(kept.map(|_| {
                snapshot_from_store(
                    &snapshot.repository_id,
                    &store,
                    remote_fingerprint,
                    self.clock.now_unix(),
                )
            }))
        })();
        let (snapshot, verification_base) = match persist_result {
            Ok(Some(stored)) => (stored, None),
            Ok(None) => (snapshot, verification_base),
            Err(error) => {
                tracing::warn!("failed to persist repository access evidence: {error}");
                (snapshot, verification_base)
            }
        };
        Ok(self.publish_locked(
            &mut snapshots,
            repository,
            Some(remote_fingerprint.to_string()),
            snapshot,
            verification_base,
        ))
    }

    fn publish_probe_error(
        &self,
        repository: &Path,
        repository_id: &str,
        remote_fingerprint: &str,
        verification: &Verification,
    ) -> Result<(), GitError> {
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| GitError::General("repository access snapshot lock poisoned".into()))?;
        if !snapshots
            .get(repository)
            .is_some_and(|current| current.snapshot.generation == verification.generation)
        {
            return Ok(());
        }
        self.publish_locked(
            &mut snapshots,
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
            Some(verification.base.clone()),
        );
        Ok(())
    }

    fn read_store(&self, store_path: &Path) -> Result<AccessStore, GitError> {
        let _guard = self
            .persistence_lock
            .lock()
            .map_err(|_| GitError::General("repository access persistence lock poisoned".into()))?;
        read_store_file(store_path)
    }

    fn ensure_installation_id(&self, store_path: &Path) -> Result<String, GitError> {
        let _lock = self.lock_store(store_path)?;
        let mut store = read_store_file(store_path)?;
        if store.installation_id.is_empty() {
            store.installation_id = ulid::Ulid::new().to_string().to_lowercase();
            write_store_file(store_path, &store)?;
        }
        Ok(store.installation_id)
    }

    /// Every read-modify-write of the store holds this lock, so processes of
    /// one installation do not lose each other's changes. The advisory lock on
    /// the device-local file next to the store is held only for the local
    /// file work, never across network IO, and the operating system releases
    /// it when its holder exits.
    fn lock_store(&self, store_path: &Path) -> Result<StoreLock<'_>, GitError> {
        let process = self
            .persistence_lock
            .lock()
            .map_err(|_| GitError::General("repository access persistence lock poisoned".into()))?;
        let path = store_path.with_extension("lock");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)?;
        let deadline = Instant::now() + STORE_LOCK_WAIT;
        loop {
            match file.try_lock() {
                Ok(()) => {
                    return Ok(StoreLock {
                        _process: process,
                        _file: file,
                    });
                }
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(STORE_LOCK_RETRY);
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(GitError::General(
                        "Repository access state is busy in another Svode process. Try again."
                            .into(),
                    ));
                }
                Err(TryLockError::Error(error)) => return Err(error.into()),
            }
        }
    }

    fn probe_lock(&self, repository: &Path) -> Result<Arc<ProbeFlight>, GitError> {
        let mut locks = self
            .probe_locks
            .lock()
            .map_err(|_| GitError::General("repository access probe lock cache poisoned".into()))?;
        Ok(locks
            .entry(repository.to_path_buf())
            .or_insert_with(|| {
                Arc::new(ProbeFlight {
                    mutex: Arc::new(AsyncMutex::new(())),
                    completed: AtomicU64::new(0),
                })
            })
            .clone())
    }

    async fn acquire_probe(
        &self,
        repository: &Path,
        automatic: bool,
    ) -> Result<ProbePermit, GitError> {
        let flight = self.probe_lock(repository)?;
        let completed = flight.completed.load(Ordering::SeqCst);
        let guard = match flight.mutex.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                let guard = flight.mutex.clone().lock_owned().await;
                if automatic || flight.completed.load(Ordering::SeqCst) != completed {
                    return Ok(ProbePermit::Joined);
                }
                // An automatic no-op must not swallow a simultaneous manual retry.
                guard
            }
        };
        Ok(ProbePermit::Owner(ProbeGuard {
            _guard: guard,
            flight,
            attempted: false,
        }))
    }
}

impl Default for RepositoryAccessState {
    fn default() -> Self {
        Self::new()
    }
}

struct ProbeFlight {
    mutex: Arc<AsyncMutex<()>>,
    completed: AtomicU64,
}

struct ProbeGuard {
    _guard: OwnedMutexGuard<()>,
    flight: Arc<ProbeFlight>,
    attempted: bool,
}

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        if self.attempted {
            self.flight.completed.fetch_add(1, Ordering::SeqCst);
        }
    }
}

enum ProbePermit {
    Owner(ProbeGuard),
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

fn existing_git_context(path: &Path) -> Result<PathBuf, GitError> {
    let mut candidate = if path.is_file() {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };
    while !candidate.is_dir() {
        if !candidate.pop() {
            return Err(GitError::PathNotAccessible(path.display().to_string()));
        }
    }
    Ok(candidate)
}

pub fn local_repository_root(path: &Path) -> Result<PathBuf, GitError> {
    let mut candidate = existing_git_context(path)?;
    loop {
        if candidate.join(".git").symlink_metadata().is_ok() {
            return candidate.canonicalize().map_err(GitError::Io);
        }
        if !candidate.pop() {
            return Err(GitError::GitCommandFailed(format!(
                "failed to resolve repository for {}",
                path.display()
            )));
        }
    }
}

/// Runs the source phase of a managed mutation over its authorized
/// touched-set: it holds the write guard of every repository of `paths`
/// and rechecks later writes against these repositories.
pub async fn scope_authorized_mutation_paths<F, T, E>(
    paths: Vec<PathBuf>,
    future: F,
    map_error: impl Fn(GitError) -> E,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let repositories = paths
        .iter()
        .map(|path| local_repository_root(path))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()
        .map_err(&map_error)?;
    let authorized = repositories.iter().cloned().collect();
    super::write_guard::scope(
        repositories,
        &paths,
        AUTHORIZED_MUTATION_REPOSITORIES.scope(Some(Arc::new(authorized)), future),
        map_error,
    )
    .await
}

/// Runs an operation that is not itself a source write, such as a Routine
/// launch, with the repositories authorized for it; it takes no write guard.
pub async fn scope_authorized_paths<F, T, E>(
    paths: Vec<PathBuf>,
    future: F,
    map_error: impl Fn(GitError) -> E,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let repositories = paths
        .iter()
        .map(|path| local_repository_root(path))
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(map_error)?;
    AUTHORIZED_MUTATION_REPOSITORIES
        .scope(Some(Arc::new(repositories)), future)
        .await
}

pub fn ensure_mutation_paths_were_authorized(paths: &[PathBuf]) -> Result<(), GitError> {
    AUTHORIZED_MUTATION_REPOSITORIES
        .try_with(|authorized| {
            let Some(authorized) = authorized else {
                return Ok(());
            };
            for path in paths {
                let repository = local_repository_root(path)?;
                if !authorized.contains(&repository) {
                    return Err(GitError::RepositoryAccessDenied {
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

fn ensure_mutation_allowed(snapshot: &RepositoryAccessSnapshot, now: i64) -> Result<(), GitError> {
    if automatic_mutation_eligible(snapshot, now) {
        return Ok(());
    }
    Err(GitError::RepositoryAccessDenied {
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

pub async fn resolve_repository(cli: &GitCli, space_path: &Path) -> Result<PathBuf, GitError> {
    let output = cli
        .exec(space_path, &["rev-parse", "--show-toplevel"])
        .await?;
    if output.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "failed to resolve repository for {}: {}",
            space_path.display(),
            output.stderr.trim()
        )));
    }
    let root = PathBuf::from(output.stdout.trim());
    fs::canonicalize(&root).map_err(|error| {
        GitError::GitCommandFailed(format!(
            "failed to canonicalize repository {}: {error}",
            root.display()
        ))
    })
}

async fn inspect_remote(cli: &GitCli, repository: &Path) -> Result<RemoteInspection, GitError> {
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
) -> Result<Vec<String>, GitError> {
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
) -> Result<ProbeResult, GitError> {
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

    let failure = classify_failure(&output, ServiceRefStage::Push);
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
) -> Result<RoutineClaimResult, GitError> {
    let reference = format!("refs/svode/routines/{}", stable_hash(routine_id));
    let current = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
    let expected = match current {
        RemoteRead::Oid(oid) => {
            if let Some(existing) = find_routine_claim(
                cli,
                repository,
                &remote.push_url,
                &reference,
                &oid,
                &payload.run_key,
            )
            .await?
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

    let failure = classify_failure(&output, ServiceRefStage::Push);
    let readback = read_remote_ref(cli, repository, &remote.push_url, &reference).await?;
    if routine_claim_readback_confirms(&new_oid, &readback) {
        return Ok(RoutineClaimResult::Claimed {
            claimed_by: payload.claimed_by.clone(),
            claimed_at: payload.claimed_at,
        });
    }
    if let RemoteRead::Oid(oid) = readback
        && let Some(existing) = find_routine_claim(
            cli,
            repository,
            &remote.push_url,
            &reference,
            &oid,
            &payload.run_key,
        )
        .await?
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

async fn find_routine_claim(
    cli: &GitCli,
    repository: &Path,
    push_url: &str,
    reference: &str,
    oid: &str,
    run_key: &str,
) -> Result<Option<RoutineClaimPayload>, GitError> {
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
    let log = cli
        .exec(repository, &["log", "--format=%B%x00", oid])
        .await?;
    if log.exit_code != 0 {
        return Ok(None);
    }
    Ok(log
        .stdout
        .split('\0')
        .filter_map(parse_routine_claim)
        .find(|claim| claim.run_key == run_key))
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
) -> Result<String, GitError> {
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
        return Err(GitError::GitCommandFailed(format!(
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
        return Err(GitError::GitCommandFailed(format!(
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
) -> Result<RemoteRead, GitError> {
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
        return Ok(RemoteRead::Failure(classify_failure(
            &output,
            ServiceRefStage::Read,
        )));
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

pub async fn create_service_commit(
    cli: &GitCli,
    repository: &Path,
    installation_hash: &str,
    checked_at: i64,
) -> Result<String, GitError> {
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
        return Err(GitError::GitCommandFailed(format!(
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
        return Err(GitError::GitCommandFailed(format!(
            "failed to create access service commit: {}",
            bounded_detail(&commit.stderr)
        )));
    }
    Ok(commit.stdout.trim().to_string())
}

pub fn is_access_probe_identity(name: &str, email: &str) -> bool {
    name == SERVICE_AUTHOR_NAME && email == SERVICE_AUTHOR_EMAIL
}

// Recognizes the existing wire format; this is not proof of origin or authority.
fn access_probe_tree(commit: &str) -> Option<&str> {
    let (headers, message) = commit.split_once("\n\n")?;
    let mut tree = None;
    let mut author = false;
    let mut committer = false;
    for header in headers.lines() {
        if let Some(oid) = header.strip_prefix("tree ") {
            if tree.is_some()
                || !matches!(oid.len(), 40 | 64)
                || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            tree = Some(oid);
        } else if header.starts_with("parent ") {
            return None;
        } else if let Some(identity) = header.strip_prefix("author ") {
            if author || !identity.starts_with("Svode Access Probe <access@svode.invalid> ") {
                return None;
            }
            author = true;
        } else if let Some(identity) = header.strip_prefix("committer ") {
            if committer || !identity.starts_with("Svode Access Probe <access@svode.invalid> ") {
                return None;
            }
            committer = true;
        }
    }
    let mut lines = message.strip_suffix('\n')?.split('\n');
    if !author || !committer || lines.next()? != "version=1" {
        return None;
    }
    let installation = lines.next()?.strip_prefix("installation=")?;
    if installation.len() != 16
        || !installation
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let nonce = lines.next()?.strip_prefix("nonce=")?;
    if nonce.len() != 26
        || nonce.as_bytes()[0] > b'7'
        || !nonce.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'h' | b'j'..=b'k' | b'm'..=b'n' | b'p'..=b't' | b'v'..=b'z'))
    {
        return None;
    }
    let checked_at = lines.next()?.strip_prefix("checked-at=")?;
    if checked_at.parse::<i64>().ok()?.to_string() != checked_at || lines.next().is_some() {
        return None;
    }
    tree
}

pub async fn is_access_probe_commit(
    cli: &GitCli,
    repository: &Path,
    oid: &str,
) -> Result<bool, GitError> {
    let object = cli
        .exec_with_env(
            repository,
            &["cat-file", "commit", oid],
            &[("GIT_NO_LAZY_FETCH", "1")],
        )
        .await?;
    if object.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "failed to read actor history candidate {oid}: {}",
            object.stderr.trim()
        )));
    }
    let Some(tree) = access_probe_tree(&object.stdout) else {
        return Ok(false);
    };
    let contents = cli
        .exec_with_env(
            repository,
            &["ls-tree", tree],
            &[("GIT_NO_LAZY_FETCH", "1")],
        )
        .await?;
    if contents.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "failed to read access probe tree {tree}: {}",
            contents.stderr.trim()
        )));
    }
    Ok(contents.stdout.is_empty())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ServiceRefStage {
    Read,
    Push,
}

fn classify_failure(output: &GitOutput, stage: ServiceRefStage) -> ProbeResult {
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
            "hook declined",
            "pre-receive hook",
            "pre-push hook",
            "non-fast-forward",
            "denycurrentbranch",
            "denynonfastforwards",
            "denydeletes",
            "branch is currently checked out",
        ],
    ) {
        RepositoryAccessReason::AmbiguousRejection
    } else if stage == ServiceRefStage::Push && explicit_remote_write_denial(&output.stderr) {
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

fn explicit_remote_write_denial(stderr: &str) -> bool {
    // Free-form local/hook diagnostics and generic rejection summaries are not
    // evidence of repository permissions. Accept only explicit remote answers.
    stderr.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        let Some(message) = line.strip_prefix("remote:") else {
            return false;
        };
        matches!(
            message.trim().trim_end_matches('.'),
            "write access to repository not granted"
                | "you are not allowed to push code to this project"
        )
    })
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

fn automatic_attempt_eligible(
    evidence: Option<&PersistedEvidence>,
    attempt: Option<&AutomaticAttempt>,
    fingerprint: &str,
    now: i64,
) -> bool {
    if let Some(attempt) = attempt {
        if attempt.consumed || attempt.remote_fingerprint != fingerprint {
            return false;
        }
        if evidence.map(|value| value.checked_at) != attempt.checked_at {
            return false;
        }
    }
    match evidence {
        None => attempt.is_none(),
        Some(value) => {
            value.remote_fingerprint == fingerprint
                && value.status == RepositoryAccessStatus::Writable
                && value.expires_at.is_some_and(|expiry| expiry <= now)
        }
    }
}

fn conclusive(status: RepositoryAccessStatus) -> bool {
    matches!(
        status,
        RepositoryAccessStatus::Writable | RepositoryAccessStatus::ReadOnly
    )
}

/// Whether stored evidence of the same remote stays instead of a new result.
/// Conclusive results are ordered by `checked_at`; conclusive evidence
/// replaces an inconclusive result of a concurrent verification, and an
/// inconclusive result never replaces conclusive evidence saved after its
/// own verification started.
fn stored_prevails(
    stored: &PersistedEvidence,
    result: &PersistedEvidence,
    verification_base: Option<&Option<PersistedEvidence>>,
) -> bool {
    match (conclusive(stored.status), conclusive(result.status)) {
        (true, false) if verification_base.is_none_or(|base| base.as_ref() != Some(stored)) => true,
        (false, true) => false,
        _ => stored.checked_at > result.checked_at,
    }
}

fn snapshot_from_store(
    repository_id: &str,
    store: &AccessStore,
    remote_fingerprint: &str,
    now: i64,
) -> RepositoryAccessSnapshot {
    let mut snapshot = snapshot_from_evidence(
        repository_id,
        store.evidence.get(repository_id),
        remote_fingerprint,
        now,
    );
    if let Some(attempt) = store.automatic_attempts.get(repository_id) {
        if attempt.remote_fingerprint != remote_fingerprint {
            snapshot = unknown_snapshot(
                repository_id,
                RepositoryAccessReason::RemoteChanged,
                snapshot.last_known_status,
            );
        } else if attempt.consumed
            && (snapshot.status == RepositoryAccessStatus::Writable
                || snapshot.reason == Some(RepositoryAccessReason::NotChecked)
                || (snapshot.reason == Some(RepositoryAccessReason::Expired)
                    && snapshot.last_known_status == Some(RepositoryAccessStatus::Writable)))
        {
            if snapshot.status == RepositoryAccessStatus::Writable {
                snapshot.last_known_status = Some(RepositoryAccessStatus::Writable);
            }
            snapshot.status = RepositoryAccessStatus::Unknown;
            snapshot.reason = Some(RepositoryAccessReason::AmbiguousRejection);
        }
    }
    snapshot
}

fn snapshot_from_evidence(
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

fn read_store_file(path: &Path) -> Result<AccessStore, GitError> {
    if !path.exists() {
        return Ok(AccessStore {
            version: ACCESS_STORE_VERSION,
            ..AccessStore::default()
        });
    }
    let raw = fs::read_to_string(path)?;
    let store: AccessStore = serde_json::from_str(&raw)?;
    if store.version != ACCESS_STORE_VERSION {
        return Err(GitError::General("Unsupported repository access store version. Restore access state before checking again.".into()));
    }
    Ok(store)
}

fn write_store_file(path: &Path, store: &AccessStore) -> Result<(), GitError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(serde_json::to_string_pretty(store)?.as_bytes())?;
    staged.as_file().sync_all()?;
    staged
        .persist(path)
        .map_err(|error| GitError::Io(error.error))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
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

#[cfg(all(test, unix))]
#[path = "access_probe_tests.rs"]
mod probe_tests;

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

        git_ok(&cli, &repository, &["update-ref", &reference, &remote_oid]).await;
        let evidence_before = fs::read(&store).unwrap();
        assert!(is_access_probe_identity(
            SERVICE_AUTHOR_NAME,
            SERVICE_AUTHOR_EMAIL
        ));
        assert_eq!(fs::read(&store).unwrap(), evidence_before);
        let after_read = state.snapshot(&cli, &repository, &store).await.unwrap();
        assert_eq!(after_read.status, second.status);
        assert_eq!(after_read.generation, second.generation);
        assert_eq!(
            git_ok(&cli, &remote, &["rev-parse", &reference])
                .await
                .stdout
                .trim(),
            remote_oid
        );
        assert_eq!(
            state
                .verify(&cli, &repository, &store)
                .await
                .unwrap()
                .status,
            RepositoryAccessStatus::Writable
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
        let historical_slot = second_state
            .claim_routine(
                &cli,
                &second,
                &second_store,
                &second_access,
                "routine-one",
                "slot-one",
                "definition-one",
                1_700_000_300,
            )
            .await
            .expect("historical slot claim lookup");
        assert!(matches!(
            historical_slot,
            RoutineClaimResult::AlreadyClaimed {
                claimed_at: 1_700_000_100,
                ..
            }
        ));
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
        assert_eq!(
            git_ok(&cli, &remote, &["rev-list", "--count", &reference])
                .await
                .stdout
                .trim(),
            "2"
        );
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
    async fn seven_day_evidence_preserves_legacy_expiry_and_renews_only_on_success() {
        let temp = TempDir::new().unwrap();
        let repository = temp.path().join("repository");
        let remote = temp.path().join("remote.git");
        let cli = GitCli::detect().unwrap();
        init_repository(&cli, &repository).await;
        init_bare(&cli, &remote).await;
        add_origin(&cli, &repository, &remote).await;
        let clock = Arc::new(TestClock::new(1_000));
        let store = temp.path().join("access.json");
        let state = test_state(clock.clone());
        let initial = state
            .record_writable_evidence(&cli, &repository, &store)
            .await
            .unwrap();
        assert_eq!(initial.expires_at, Some(1_000 + 604_800));
        let bytes = fs::read(&store).unwrap();
        for now in [1_001, 1_000 + 604_799, 1_000 + 604_800, 1_000 + 604_801] {
            clock.set(now);
            let restarted = test_state(clock.clone());
            let snapshot = restarted.snapshot(&cli, &repository, &store).await.unwrap();
            assert_eq!(snapshot.checked_at, initial.checked_at);
            assert_eq!(snapshot.expires_at, initial.expires_at);
            assert_eq!(
                restarted
                    .require_mutation(&cli, &repository, &store)
                    .await
                    .is_ok(),
                now < 605_800
            );
            assert_eq!(fs::read(&store).unwrap(), bytes);
        }
        // Legacy evidence keeps its recorded one-day deadline, including after restart.
        let mut legacy = read_store_file(&store).unwrap();
        legacy
            .evidence
            .get_mut(&initial.repository_id)
            .unwrap()
            .expires_at = Some(87_400);
        write_store_file(&store, &legacy).unwrap();
        for now in [87_399, 87_400, 87_401] {
            clock.set(now);
            let restarted = test_state(clock.clone());
            let snapshot = restarted.snapshot(&cli, &repository, &store).await.unwrap();
            assert_eq!(snapshot.expires_at, Some(87_400));
            assert_eq!(
                restarted
                    .require_mutation(&cli, &repository, &store)
                    .await
                    .is_ok(),
                now < 87_400
            );
        }
        clock.set(900_000);
        let renewed = state
            .record_writable_evidence(&cli, &repository, &store)
            .await
            .unwrap();
        assert_eq!(renewed.checked_at, Some(900_000));
        assert_eq!(renewed.expires_at, Some(1_504_800));
        let before = renewed.generation;
        state.invalidate(&cli, &repository).await.unwrap();
        let reread = state.snapshot(&cli, &repository, &store).await.unwrap();
        assert!(reread.generation > before);
        assert_eq!(reread.checked_at, renewed.checked_at);
        git_ok(
            &cli,
            &repository,
            &["remote", "set-url", "origin", "changed"],
        )
        .await;
        state.invalidate(&cli, &repository).await.unwrap();
        let changed = state.snapshot(&cli, &repository, &store).await.unwrap();
        assert!(changed.generation > reread.generation);
        assert_eq!(changed.reason, Some(RepositoryAccessReason::RemoteChanged));
    }

    #[tokio::test]
    async fn access_explicit_verification_is_single_flight_per_repository() {
        let state = Arc::new(test_state(Arc::new(TestClock::new(10))));
        let repository = PathBuf::from("/virtual/repository");
        let owner = state
            .acquire_probe(&repository, false)
            .await
            .expect("owner permit");
        let ProbePermit::Owner(mut owner_guard) = owner else {
            panic!("first caller must own probe");
        };
        owner_guard.attempted = true;
        let joined_state = state.clone();
        let joined_repository = repository.clone();
        let joined = tokio::spawn(async move {
            joined_state
                .acquire_probe(&joined_repository, false)
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
                .acquire_probe(&repository, false)
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
                    stderr: "remote: Write access to repository not granted.".into(),
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
            let classified = classify_failure(&output, ServiceRefStage::Push);
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
            GitError::RepositoryAccessDenied { ref status, ref reason, .. }
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
            GitError::RepositoryAccessDenied { ref status, ref reason, .. }
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

        scope_authorized_mutation_paths(
            vec![child_target.clone()],
            async {
                ensure_mutation_paths_were_authorized(&[child_target])?;
                let denied = ensure_mutation_paths_were_authorized(&[parent_target])
                    .expect_err("child-only plan must not authorize a parent write");
                assert!(matches!(
                    denied,
                    GitError::RepositoryAccessDenied { ref reason, .. }
                        if reason == "mutation_plan_changed"
                ));
                Ok::<(), GitError>(())
            },
            |error| error,
        )
        .await
        .expect("authorized child plan");
    }
}
