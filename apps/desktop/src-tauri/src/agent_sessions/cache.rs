//! The last good session list of each agent, saved per project so the
//! catalogue shows it after the app starts, before an agent connection opens
//! (Stage 10 `02` C3, condition 3 of the scanner removal). A rebuildable
//! cache: the project's sessions with their bounded list fields and native
//! status evidence, no transcript (C8).

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use svode_agents::catalog::ListedSession;
use svode_agents::registry::{AdapterRuntimeRegistry, CatalogSource, NativeCatalogStore};
use svode_core::agent_adapters::AgentId;

use super::native_catalog::NativeListing;
use super::native_status::NativeLogRead;
use crate::error::AppError;

#[derive(Default)]
pub(crate) struct CatalogSnapshots {
    projects: Mutex<HashMap<PathBuf, ProjectSnapshot>>,
}

#[derive(Default)]
struct ProjectSnapshot {
    lists: HashMap<CatalogSourceKey, SavedList>,
    /// Hash of the sessions last written per source.
    written: HashMap<CatalogSourceKey, u64>,
}

/// The catalogue source a list is saved by (Stage 10 `07` N2): an agent's
/// ACP list, or one of the native stores its description declares.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct CatalogSourceKey {
    pub agent: AgentId,
    pub store: Option<NativeCatalogStore>,
}

impl CatalogSourceKey {
    pub(crate) fn acp(agent: AgentId) -> Self {
        Self { agent, store: None }
    }

    fn row(&self) -> String {
        match self.store {
            None => self.agent.as_str().to_string(),
            Some(store) => format!("{}/{}", self.agent.as_str(), store.as_str()),
        }
    }

    /// The source a saved row names, while the agent still declares it: a
    /// built-in agent's ACP list that is no longer its source, as the list
    /// of Hermes before slice 8.1, is not shown.
    fn of_row(row: &str) -> Option<Self> {
        let (agent, store) = match row.split_once('/') {
            Some((agent, store)) => (agent, Some(store)),
            None => (row, None),
        };
        let agent = AgentId::parse(agent).ok()?;
        let Some(builtin) = agent.builtin() else {
            return store.is_none().then(|| Self::acp(agent));
        };
        let declared = AdapterRuntimeRegistry
            .catalog_sources(builtin)
            .iter()
            .find(|source| match (source, store) {
                (CatalogSource::AcpList, None) => true,
                (CatalogSource::Native(native), Some(store)) => native.as_str() == store,
                _ => false,
            })?;
        Some(Self {
            agent,
            store: match declared {
                CatalogSource::AcpList => None,
                CatalogSource::Native(store) => Some(*store),
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedList {
    pub read_at: DateTime<Utc>,
    pub sessions: Vec<SavedSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedSession {
    pub listed: ListedSession,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeLogRead>,
    /// What a native catalogue source knew of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listing: Option<NativeListing>,
}

impl CatalogSnapshots {
    /// The lists saved for the project, read from disk on its first use;
    /// `loaded` sees them once, when they are read.
    pub(crate) fn lists(
        &self,
        project: &Path,
        loaded: impl FnOnce(&HashMap<CatalogSourceKey, SavedList>),
    ) -> HashMap<CatalogSourceKey, SavedList> {
        let mut projects = self.projects.lock().unwrap();
        if let Some(snapshot) = projects.get(project) {
            return snapshot.lists.clone();
        }
        let lists = read_saved_lists(project);
        loaded(&lists);
        let written = lists
            .iter()
            .filter_map(|(agent, list)| Some((agent.clone(), sessions_hash(&list.sessions)?)))
            .collect();
        projects.insert(
            project.to_path_buf(),
            ProjectSnapshot {
                lists: lists.clone(),
                written,
            },
        );
        lists
    }

    /// Keeps the source's list of the project and writes it when its
    /// sessions differ from the last written ones.
    pub(crate) fn save(&self, project: &Path, agent: &CatalogSourceKey, list: SavedList) {
        let Some(hash) = sessions_hash(&list.sessions) else {
            return;
        };
        let mut projects = self.projects.lock().unwrap();
        let snapshot = projects.entry(project.to_path_buf()).or_default();
        if snapshot.written.get(agent) == Some(&hash) {
            return;
        }
        match write_saved_list(project, agent, &list) {
            Ok(()) => {
                snapshot.written.insert(agent.clone(), hash);
            }
            Err(error) => tracing::warn!(
                "agent sessions snapshot write failed for {}: {error}",
                project.display()
            ),
        }
        snapshot.lists.insert(agent.clone(), list);
    }
}

fn sessions_hash(sessions: &[SavedSession]) -> Option<u64> {
    let json = serde_json::to_string(sessions).ok()?;
    let mut hasher = DefaultHasher::new();
    json.hash(&mut hasher);
    Some(hasher.finish())
}

fn read_saved_lists(project: &Path) -> HashMap<CatalogSourceKey, SavedList> {
    let db_path = cache_db_path(project);
    if !db_path.is_file() {
        return HashMap::new();
    }
    let rows = tauri::async_runtime::block_on(async {
        let pool = open_cache_pool(&db_path, false).await?;
        ensure_cache_schema(&pool).await?;
        let rows =
            sqlx::query_as::<_, (String, String)>("SELECT agent, list_json FROM acp_list_snapshot")
                .fetch_all(&pool)
                .await?;
        pool.close().await;
        Ok::<_, AppError>(rows)
    });
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                "agent sessions snapshot read failed for {}: {error}",
                db_path.display()
            );
            return HashMap::new();
        }
    };
    rows.into_iter()
        .filter_map(|(agent, json)| {
            let agent = CatalogSourceKey::of_row(&agent)?;
            match serde_json::from_str::<SavedList>(&json) {
                Ok(list) => Some((agent, list)),
                Err(error) => {
                    tracing::warn!("agent sessions snapshot of {agent:?} is unreadable: {error}");
                    None
                }
            }
        })
        .collect()
}

fn write_saved_list(
    project: &Path,
    agent: &CatalogSourceKey,
    list: &SavedList,
) -> Result<(), AppError> {
    let db_path = cache_db_path(project);
    let list_json = serde_json::to_string(list)?;
    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    tauri::async_runtime::block_on(async {
        let pool = open_writable_cache_pool(&db_path).await?;
        sqlx::query(
            r#"
            INSERT INTO acp_list_snapshot (agent, list_json, saved_at)
            VALUES (?, ?, ?)
            ON CONFLICT(agent) DO UPDATE SET
                list_json = excluded.list_json,
                saved_at = excluded.saved_at
            "#,
        )
        .bind(agent.row())
        .bind(list_json)
        .bind(saved_at)
        .execute(&pool)
        .await?;
        pool.close().await;
        Ok(())
    })
}

pub(super) fn cache_db_path(project: &Path) -> PathBuf {
    project.join(".svode").join("agent-sessions.db")
}

async fn open_cache_pool(
    db_path: &Path,
    create_if_missing: bool,
) -> Result<sqlx::SqlitePool, AppError> {
    if create_if_missing && let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(create_if_missing)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

async fn open_writable_cache_pool(db_path: &Path) -> Result<sqlx::SqlitePool, AppError> {
    let initial = open_cache_pool(db_path, true).await;
    match initial {
        Ok(pool) => match ensure_cache_schema(&pool).await {
            Ok(()) => Ok(pool),
            Err(error) if svode_core::index::db::is_corrupt_database_error(&error) => {
                svode_core::index::db::close_pool(&pool).await;
                replace_corrupt_cache(db_path).await
            }
            Err(error) => {
                pool.close().await;
                Err(error)
            }
        },
        Err(error) if svode_core::index::db::is_corrupt_database_error(&error) => {
            replace_corrupt_cache(db_path).await
        }
        Err(error) => Err(error),
    }
}

async fn replace_corrupt_cache(db_path: &Path) -> Result<sqlx::SqlitePool, AppError> {
    svode_core::index::db::quarantine_database_family(
        db_path,
        svode_core::index::db::QuarantineReason::Corrupt,
    )?;
    let pool = open_cache_pool(db_path, true).await?;
    ensure_cache_schema(&pool).await?;
    Ok(pool)
}

/// The snapshot table; the scanners' catalogue cache of earlier versions is
/// dropped with its rows.
async fn ensure_cache_schema(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS acp_list_snapshot (
            agent TEXT PRIMARY KEY NOT NULL,
            list_json TEXT NOT NULL,
            saved_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query("DROP TABLE IF EXISTS source_cache")
        .execute(pool)
        .await?;
    Ok(())
}
