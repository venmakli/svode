use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

use crate::AppError;
use crate::index::db::{self, QuarantineReason};

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryEvidence {
    pub reason: &'static str,
    pub quarantine_files: Vec<String>,
}

pub(crate) struct OpenOutcome {
    pub pool: SqlitePool,
    pub recovery: Option<RecoveryEvidence>,
}

#[derive(Debug, PartialEq, Eq)]
enum SchemaStatus {
    Current,
    Uninitialized,
    Unsupported(Option<i64>),
}

pub(crate) async fn open_pool(
    db_path: &Path,
    previously_created: bool,
) -> Result<OpenOutcome, AppError> {
    if !db_path.exists() {
        let pool = connect(db_path, true).await?;
        initialize_schema(&pool).await?;
        return Ok(OpenOutcome {
            pool,
            recovery: previously_created.then_some(RecoveryEvidence {
                reason: "missing",
                quarantine_files: Vec::new(),
            }),
        });
    }

    match connect(db_path, false).await {
        Ok(pool) => match schema_status(&pool).await {
            Ok(SchemaStatus::Current) => Ok(OpenOutcome {
                pool,
                recovery: None,
            }),
            Ok(SchemaStatus::Unsupported(found)) => {
                pool.close().await;
                Err(AppError::General(format!(
                    "unsupported routines database schema (found {found:?}, expected {SCHEMA_VERSION})"
                )))
            }
            Ok(SchemaStatus::Uninitialized) => {
                pool.close().await;
                replace_unreadable(db_path, previously_created).await
            }
            Err(error) if db::is_corrupt_database_error(&error) => {
                pool.close().await;
                replace_unreadable(db_path, previously_created).await
            }
            Err(error) => Err(error),
        },
        Err(error) if db::is_corrupt_database_error(&error) => {
            replace_unreadable(db_path, previously_created).await
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn reopen_current_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    let pool = connect(db_path, false).await?;
    match schema_status(&pool).await? {
        SchemaStatus::Current => Ok(pool),
        SchemaStatus::Uninitialized | SchemaStatus::Unsupported(_) => {
            pool.close().await;
            Err(AppError::General(format!(
                "routines database is unavailable: {}",
                db_path.display()
            )))
        }
    }
}

async fn replace_unreadable(
    db_path: &Path,
    previously_created: bool,
) -> Result<OpenOutcome, AppError> {
    let quarantined = db::quarantine_database_family(db_path, QuarantineReason::Corrupt)?;
    let quarantine_files = quarantined
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    let pool = connect(db_path, true).await?;
    initialize_schema(&pool).await?;
    Ok(OpenOutcome {
        pool,
        recovery: previously_created.then_some(RecoveryEvidence {
            reason: "corrupt",
            quarantine_files,
        }),
    })
}

async fn connect(db_path: &Path, create_if_missing: bool) -> Result<SqlitePool, AppError> {
    if create_if_missing && let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(create_if_missing)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .pragma("cache_size", "-4000");
    Ok(SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?)
}

async fn schema_status(pool: &SqlitePool) -> Result<SchemaStatus, AppError> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
    )
    .fetch_one(pool)
    .await?;
    if exists == 0 {
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_one(pool)
        .await?;
        return Ok(if tables == 0 {
            SchemaStatus::Uninitialized
        } else {
            SchemaStatus::Unsupported(None)
        });
    }
    let version = sqlx::query_scalar::<_, i64>("SELECT version FROM schema_version LIMIT 1")
        .fetch_optional(pool)
        .await?;
    Ok(if version == Some(SCHEMA_VERSION) {
        SchemaStatus::Current
    } else {
        SchemaStatus::Unsupported(version)
    })
}

pub(crate) async fn initialize_schema(pool: &SqlitePool) -> Result<(), AppError> {
    match schema_status(pool).await? {
        SchemaStatus::Current => return Ok(()),
        SchemaStatus::Uninitialized => {}
        SchemaStatus::Unsupported(found) => {
            return Err(AppError::General(format!(
                "unsupported routines database schema (found {found:?}, expected {SCHEMA_VERSION})"
            )));
        }
    }
    let ddl = [
        "CREATE TABLE schema_version (version INTEGER NOT NULL)",
        r#"
        CREATE TABLE routine_definitions (
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            row_json TEXT NOT NULL,
            refreshed_at TEXT NOT NULL,
            PRIMARY KEY (owner_path, routine_id)
        )
        "#,
        "CREATE INDEX idx_routine_definitions_owner ON routine_definitions(owner_path)",
        r#"
        CREATE TABLE routine_observation_baseline (
            entry_path TEXT PRIMARY KEY,
            snapshot_json TEXT NOT NULL,
            observed_at TEXT NOT NULL
        )
        "#,
        r#"
        CREATE TABLE routine_runs (
            routine_run_id TEXT PRIMARY KEY,
            routine_id TEXT NOT NULL,
            owner_path TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            definition_json TEXT NOT NULL,
            launch_id TEXT NOT NULL UNIQUE,
            pty_id TEXT,
            source TEXT NOT NULL,
            source_session_id TEXT,
            agent_session_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            terminal_status TEXT,
            terminal_exit_code INTEGER,
            terminal_reason TEXT,
            terminal_observed_at TEXT,
            session_status TEXT,
            updated_at TEXT NOT NULL
        )
        "#,
        "CREATE INDEX idx_routine_runs_owner_routine ON routine_runs(owner_path, routine_id, created_at DESC)",
        "CREATE INDEX idx_routine_runs_launch ON routine_runs(launch_id)",
        r#"
        CREATE TABLE routine_schedule_state (
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            checkpoint_at TEXT NOT NULL,
            next_run_at TEXT NOT NULL,
            PRIMARY KEY (owner_path, routine_id)
        )
        "#,
        "CREATE TABLE routine_owner_roots (owner_path TEXT PRIMARY KEY)",
        r#"
        CREATE TABLE routine_automatic_leases (
            run_key TEXT PRIMARY KEY,
            routine_id TEXT NOT NULL,
            leased_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        "#,
        r#"
        CREATE TABLE routine_remote_claims (
            run_key TEXT PRIMARY KEY,
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            claimed_by TEXT NOT NULL,
            claimed_at TEXT NOT NULL
        )
        "#,
        "CREATE INDEX idx_routine_remote_claims_owner_routine ON routine_remote_claims(owner_path, routine_id, claimed_at DESC)",
        r#"
        CREATE TABLE routine_event_queue (
            queue_key TEXT PRIMARY KEY,
            event_key TEXT NOT NULL,
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            event_type TEXT NOT NULL,
            entry_path TEXT NOT NULL,
            property_key TEXT,
            payload_json TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending'
        )
        "#,
        "CREATE INDEX idx_routine_event_queue_pending ON routine_event_queue(state, observed_at)",
        "CREATE INDEX idx_routine_event_queue_event ON routine_event_queue(event_key)",
    ];
    for statement in ddl {
        sqlx::query(statement).execute(pool).await?;
    }
    sqlx::query("INSERT INTO schema_version (version) VALUES (?)")
        .bind(SCHEMA_VERSION)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) fn database_path(space_dir: &Path) -> PathBuf {
    space_dir.join(".svode").join("routines.db")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unsupported_schema_is_left_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("routines.db");
        let pool = connect(&path, true).await.unwrap();
        sqlx::query("CREATE TABLE schema_version (version INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO schema_version VALUES (99)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        assert!(open_pool(&path, true).await.is_err());
        let pool = connect(&path, false).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT version FROM schema_version")
                .fetch_one(&pool)
                .await
                .unwrap(),
            99
        );
    }

    #[tokio::test]
    async fn missing_or_corrupt_previous_store_returns_recovery_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing-routines.db");
        let missing_outcome = open_pool(&missing, true).await.unwrap();
        assert_eq!(missing_outcome.recovery.unwrap().reason, "missing");
        missing_outcome.pool.close().await;

        let corrupt = temp.path().join("corrupt-routines.db");
        std::fs::write(&corrupt, "not sqlite").unwrap();
        let corrupt_outcome = open_pool(&corrupt, true).await.unwrap();
        let recovery = corrupt_outcome.recovery.unwrap();
        assert_eq!(recovery.reason, "corrupt");
        assert!(
            recovery
                .quarantine_files
                .iter()
                .any(|name| name.contains("corrupt-routines.db.corrupt-"))
        );
        assert_eq!(
            schema_status(&corrupt_outcome.pool).await.unwrap(),
            SchemaStatus::Current
        );
    }

    #[tokio::test]
    async fn routines_schema_owns_operational_tables_without_authority() {
        let temp = tempfile::tempdir().unwrap();
        let outcome = open_pool(&temp.path().join("routines.db"), false)
            .await
            .unwrap();
        let tables = sqlx::query_scalar::<_, String>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .fetch_all(&outcome.pool)
        .await
        .unwrap();

        assert!(tables.contains(&"routine_definitions".to_string()));
        assert!(tables.contains(&"routine_observation_baseline".to_string()));
        assert!(tables.contains(&"routine_runs".to_string()));
        assert!(tables.contains(&"routine_event_queue".to_string()));
        assert!(!tables.contains(&"routine_automatic_authority".to_string()));
    }
}
