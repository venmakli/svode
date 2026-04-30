use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::time::Duration;

use crate::error::AppError;

/// Current schema version. Bumping this forces a drop-and-recreate of all
/// index tables on next open (the index is a rebuildable cache).
///
/// Bumped to 2 in stage-3.5 Phase 5: adds the `broken_links` table that
/// Phase 7 will populate during cross-space link validation.
const SCHEMA_VERSION: i64 = 2;

/// Create a connection pool for a space's index database.
/// Ensures the parent directory exists and enables WAL mode.
pub async fn create_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .pragma("cache_size", "-8000");

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    Ok(pool)
}

/// Ensure the schema is at the current version. If the stored version differs
/// (including when tables don't exist yet), drop and recreate all tables.
pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), AppError> {
    // Bootstrap the version table so we can read it on first open as well as
    // after a version bump (we DELETE+INSERT into it below to update).
    sqlx::query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        .execute(pool)
        .await?;

    let current: Option<i64> = sqlx::query_scalar("SELECT version FROM schema_version LIMIT 1")
        .fetch_optional(pool)
        .await?;

    if current == Some(SCHEMA_VERSION) {
        return Ok(());
    }

    tracing::info!(
        "index schema version mismatch (found {:?}, expected {}), rebuilding",
        current,
        SCHEMA_VERSION
    );

    // Drop existing tables/triggers. Order matters for FTS content-linked tables.
    let drops = [
        "DROP TRIGGER IF EXISTS entries_au",
        "DROP TRIGGER IF EXISTS entries_ad",
        "DROP TRIGGER IF EXISTS entries_ai",
        "DROP TABLE IF EXISTS entries_fts",
        "DROP TABLE IF EXISTS entries",
        "DROP TABLE IF EXISTS assets",
        "DROP TABLE IF EXISTS broken_links",
    ];
    for stmt in drops {
        sqlx::query(stmt).execute(pool).await?;
    }

    let ddl = [
        r#"
        CREATE TABLE IF NOT EXISTS entries (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            table_name TEXT,
            title TEXT,
            metadata JSON,
            content TEXT,
            updated_at TEXT,
            git_hash TEXT
        )
        "#,
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            title, content, content=entries, content_rowid=rowid
        )
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, content)
            VALUES ('delete', old.rowid, old.title, old.content);
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, content)
            VALUES ('delete', old.rowid, old.title, old.content);
            INSERT INTO entries_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            original_name TEXT,
            document_id TEXT,
            asset_type TEXT NOT NULL,
            mime_type TEXT,
            size INTEGER,
            created_at TEXT NOT NULL
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)",
        "CREATE INDEX IF NOT EXISTS idx_entries_table ON entries(table_name)",
        "CREATE INDEX IF NOT EXISTS idx_assets_document ON assets(document_id)",
        // Per-pool broken-link registry (Stage 3.5 Phase 5 §5.6). Source side
        // owns the row — `source_space_id` is the pool; `target_space_id`
        // is captured because cross-space links may point at another pool.
        // Phase 7 populates this on link validation; the project-wide badge
        // is a fan-out SUM across pools.
        r#"
        CREATE TABLE IF NOT EXISTS broken_links (
            source_rel_path TEXT NOT NULL,
            target_space_id TEXT,
            target_url TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            PRIMARY KEY (source_rel_path, target_url)
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_broken_links_source ON broken_links(source_rel_path)",
    ];

    for stmt in ddl {
        sqlx::query(stmt).execute(pool).await?;
    }

    sqlx::query("DELETE FROM schema_version")
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO schema_version (version) VALUES (?)")
        .bind(SCHEMA_VERSION)
        .execute(pool)
        .await?;

    Ok(())
}
