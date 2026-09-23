//! Freshness of index-backed reads: whether the pools a read needs hold a
//! prepared snapshot, whether their last check read every source, and when
//! this process last checked them against the files. An index that cannot
//! answer is reported as unavailable, never as an empty result.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::knowledge::{KnowledgeDiagnostic, KnowledgeScope};
use super::manifest::read_generation;
use super::state::IndexRuntimeState;
use super::{IndexError, IndexKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexFreshnessStatus {
    /// The last check read every source of every pool.
    Fresh,
    /// The last check could not read some sources; their earlier rows stay.
    Partial,
}

/// The `index` field of an index-backed read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFreshness {
    pub status: IndexFreshnessStatus,
    /// Oldest completed check of the read's pools by this process; `None`
    /// while one of them has not been checked yet.
    pub verified_at: Option<String>,
    pub diagnostics: Vec<KnowledgeDiagnostic>,
}

/// The pools of a read cannot answer: not open, never built, or not
/// recoverable.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct IndexUnavailable {
    pub message: String,
    pub diagnostics: Vec<KnowledgeDiagnostic>,
}

impl IndexUnavailable {
    pub fn new(diagnostics: Vec<KnowledgeDiagnostic>) -> Self {
        let spaces = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.space_id.as_deref().unwrap_or("root"))
            .collect::<Vec<_>>()
            .join(", ");
        Self {
            message: format!("The Svode index is unavailable for Space {spaces}"),
            diagnostics,
        }
    }

    /// Diagnostic of a pool of `key` that could not be prepared.
    pub fn failed(key: &IndexKey, error: impl std::fmt::Display) -> KnowledgeDiagnostic {
        diagnostic(key, "index_unavailable", error.to_string())
    }

    /// The process has not opened `project`, so it holds no prepared index.
    pub fn project_not_open(project: &Path) -> Self {
        Self {
            message: format!(
                "The Svode index of {} is not prepared: the project is not open in this Svode process",
                project.display()
            ),
            diagnostics: vec![KnowledgeDiagnostic {
                space_id: None,
                code: "project_not_open".to_string(),
                message: "Open this project in Svode to prepare its index".to_string(),
            }],
        }
    }
}

/// Last completed check of one pool against its sources.
#[derive(Debug, Clone)]
pub(crate) struct Verification {
    at: Instant,
    wall: String,
}

fn diagnostic(key: &IndexKey, code: &str, message: String) -> KnowledgeDiagnostic {
    KnowledgeDiagnostic {
        space_id: IndexRuntimeState::space_id_for_key(key),
        code: code.to_string(),
        message,
    }
}

impl IndexRuntimeState {
    /// Whether this process holds the Space cache of `project`.
    pub async fn is_project_open(&self, project: &Path) -> bool {
        self.spaces_cache.lock().await.contains_key(project)
    }

    /// Pools of an index-backed read in `scope`: the root or one ready child
    /// Space, or the root and every ready child of the Project.
    pub async fn keys_for_scope(
        &self,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> Result<Vec<IndexKey>, IndexError> {
        match scope {
            KnowledgeScope::Space { space_id } => Ok(vec![
                self.key_for_project_space_id(project, space_id.as_deref())
                    .await?,
            ]),
            KnowledgeScope::Project => Ok(self.keys_for_project(project).await),
        }
    }

    pub(crate) async fn record_verification(&self, key: &IndexKey) {
        self.verifications.lock().await.insert(
            key.clone(),
            Verification {
                at: Instant::now(),
                wall: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            },
        );
    }

    /// Forgets the last check of the pools owning `paths` after a mutation
    /// changed these sources without publishing them, so the next
    /// index-backed read checks the files again instead of answering from
    /// the earlier check.
    pub async fn expire_verification(&self, project: &Path, paths: &[std::path::PathBuf]) {
        for path in paths {
            if let Ok((key, _)) = self.resolve(project, path).await {
                self.verifications.lock().await.remove(&key);
            }
        }
    }

    /// Whether the last completed check of `key` is younger than `window`.
    pub async fn verified_within(&self, key: &IndexKey, window: Duration) -> bool {
        self.verifications
            .lock()
            .await
            .get(key)
            .is_some_and(|verification| verification.at.elapsed() < window)
    }

    /// Freshness of the open pools of `keys` as this process holds them. It
    /// neither opens nor checks a pool.
    pub async fn freshness(&self, keys: &[IndexKey]) -> Result<IndexFreshness, IndexUnavailable> {
        let mut unavailable = Vec::new();
        let mut diagnostics = Vec::new();
        let mut partial = false;
        let mut verified_at: Option<String> = None;
        let mut unverified = false;
        for key in keys {
            let Some(pool) = self.existing_pool(key).await else {
                unavailable.push(diagnostic(
                    key,
                    "pool_unavailable",
                    "The index of this Space is not open".to_string(),
                ));
                continue;
            };
            match read_generation(&pool).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    unavailable.push(diagnostic(
                        key,
                        "snapshot_unavailable",
                        "The index of this Space has not been built yet".to_string(),
                    ));
                    continue;
                }
                Err(error) => {
                    unavailable.push(diagnostic(
                        key,
                        "pool_unavailable",
                        format!("The index of this Space could not be read: {error}"),
                    ));
                    continue;
                }
            }
            let failures: i64 = sqlx::query_scalar(
                "SELECT failure_count FROM knowledge_manifest WHERE singleton = 1",
            )
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
            if failures > 0 {
                partial = true;
                diagnostics.push(diagnostic(
                    key,
                    "scan_incomplete",
                    format!("{failures} sources could not be read or indexed by the last check"),
                ));
            }
            if self.reindex_active_flag(key).await.load(Ordering::SeqCst) {
                diagnostics.push(diagnostic(
                    key,
                    "pool_stale",
                    "A previous prepared snapshot is being refreshed".to_string(),
                ));
            } else if self.reconcile_active_flag(key).await.load(Ordering::SeqCst) {
                diagnostics.push(diagnostic(
                    key,
                    "pool_checking",
                    "The cached snapshot is being checked for source changes".to_string(),
                ));
            }
            match self.verifications.lock().await.get(key) {
                Some(verification) => {
                    if verified_at
                        .as_ref()
                        .is_none_or(|oldest| verification.wall < *oldest)
                    {
                        verified_at = Some(verification.wall.clone());
                    }
                }
                None => unverified = true,
            }
        }
        if !unavailable.is_empty() {
            return Err(IndexUnavailable::new(unavailable));
        }
        Ok(IndexFreshness {
            status: if partial {
                IndexFreshnessStatus::Partial
            } else {
                IndexFreshnessStatus::Fresh
            },
            verified_at: if unverified { None } else { verified_at },
            diagnostics,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::index::update::IndexUpdateState;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::routines::store_state::RoutineStoreState;

    #[tokio::test]
    async fn an_unbuilt_or_closed_pool_is_unavailable_and_a_checked_one_is_fresh() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".svode")).unwrap();
        std::fs::write(root.join("note.md"), "# Note\n").unwrap();
        let key = IndexKey::Root(root.clone());
        let state = IndexRuntimeState::default();

        let closed = state.freshness(&[key.clone()]).await.unwrap_err();
        assert_eq!(closed.diagnostics[0].code, "pool_unavailable");

        state.get_or_create(&key).await.unwrap();
        let unbuilt = state.freshness(&[key.clone()]).await.unwrap_err();
        assert_eq!(unbuilt.diagnostics[0].code, "snapshot_unavailable");
        assert!(unbuilt.message.contains("Space root"));

        let stores = Arc::new(RoutineStoreState::new());
        let updates = IndexUpdateState::new(stores.clone());
        updates
            .reconcile_space(&state, &key, None::<&SystemGitDateExecutor>)
            .await
            .unwrap();
        let fresh = state.freshness(&[key.clone()]).await.unwrap();
        assert_eq!(fresh.status, IndexFreshnessStatus::Fresh);
        assert!(fresh.verified_at.is_some());
        assert!(fresh.diagnostics.is_empty());
        assert!(state.verified_within(&key, Duration::from_secs(60)).await);

        sqlx::query("UPDATE knowledge_manifest SET failure_count = 2 WHERE singleton = 1")
            .execute(&state.existing_pool(&key).await.unwrap())
            .await
            .unwrap();
        let partial = state.freshness(&[key.clone()]).await.unwrap();
        assert_eq!(partial.status, IndexFreshnessStatus::Partial);
        assert_eq!(partial.diagnostics[0].code, "scan_incomplete");

        state.close_key(&key).await;
        assert!(!state.verified_within(&key, Duration::from_secs(60)).await);
        stores.close_key(&key).await;
    }

    #[tokio::test]
    async fn an_open_pool_that_was_never_checked_has_no_verification_time() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".svode")).unwrap();
        let key = IndexKey::Root(root.clone());
        let state = IndexRuntimeState::default();
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(
            None::<&SystemGitDateExecutor>,
            &pool,
            &root,
            &root,
            &[],
        )
        .await
        .unwrap();

        let freshness = state.freshness(&[key.clone()]).await.unwrap();
        assert_eq!(freshness.status, IndexFreshnessStatus::Fresh);
        assert_eq!(freshness.verified_at, None);
        assert!(!state.is_project_open(&root).await);
        let unopened = IndexUnavailable::project_not_open(&root);
        assert_eq!(unopened.diagnostics[0].code, "project_not_open");
        state.close_key(&key).await;
    }
}
