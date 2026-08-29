use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

/// Current schema version. An incompatible file is quarantined as a complete
/// SQLite family before a fresh rebuildable index is created.
///
/// Bumped to 2 in stage-3.5 Phase 5: adds the `broken_links` table that
/// Phase 7 will populate during cross-space link validation.
///
/// Bumped to 3 in stage-3.5 Phase 8: the per-pool `assets` table is
/// rewritten with renamed columns (`path → rel_path`, `original_name →
/// file_name`, `mime_type → mime`, `size → size_bytes`) and `asset_type`
/// is dropped (derived from mime at render time).
///
/// Bumped to 4 in stage-4 Phase 1: entries use the page metadata schema
/// with description/cover system fields and collection placeholder columns.
///
/// Bumped to 5 in stage-6 Phase 12: entries are keyed by file_path; legacy
/// YAML id is indexed only as a custom field.
///
/// Bumped to 6 in Stage 7 Phase 7.1: adds the rebuildable routine definition
/// cache used by owner-scoped Routines surfaces and later dispatch phases.
///
/// Bumped to 7 in Stage 7 Phase 7.2: adds local technical routine runs and
/// their launch, managed PTY, source-session and terminal-evidence mapping.
///
/// Bumped to 8 in Stage 7 Phase 7.3: adds durable schedule checkpoints,
/// project-local automatic consent, local leases and observed remote claims.
///
/// Bumped to 9 in Stage 7 Phase 7.4: adds the durable, deduplicated Collection
/// event queue populated by targeted index updates.
///
/// Bumped to 10 in Stage 7 Phase 8.1: adds the rebuildable document knowledge
/// projection (document nodes, searchable fragments, explicit links and a
/// per-pool freshness manifest).
///
/// Bumped to 11 in Stage 7 Phase 8.2: generalizes the projection to logical
/// Collections, entries and project Agent Context artifacts, typed explicit
/// edges, safe provenance and fragment source locations.
///
/// Bumped to 12 in Stage 7 Phase 8.3: stores target-specific Agent Context
/// applicability without duplicating inherited root artifacts in child pools.
///
/// Bumped to 13 in Stage 7 Phase 8.4: adds the per-source reconciliation
/// manifest plus independent content revision and source generation counters.
///
/// Bumped to 14 in Stage 8 DF-071: removes every Routines-owned table. A
/// mismatch now quarantines and recreates the whole derived index file.
///
/// Bumped to 15 in Stage 8 Slice 1A: rebuilds the Knowledge projection with
/// canonical Page nodes instead of the legacy document/entry split.
pub(crate) const SCHEMA_VERSION: i64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SchemaStatus {
    Current,
    Uninitialized,
    Incompatible(Option<i64>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuarantineReason {
    Corrupt,
    Incompatible,
}

impl QuarantineReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Corrupt => "corrupt",
            Self::Incompatible => "incompatible",
        }
    }
}

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

pub(crate) fn is_corrupt_database_error(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("database disk image is malformed")
        || message.contains("file is not a database")
        || message.contains("database corruption")
}

/// Move a SQLite main file and its sidecars aside before creating a new store.
/// The quarantined files remain available for manual inspection/recovery.
pub(crate) fn quarantine_database_family(
    db_path: &Path,
    reason: QuarantineReason,
) -> Result<Vec<std::path::PathBuf>, AppError> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut quarantined = Vec::new();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let source = if suffix.is_empty() {
            db_path.to_path_buf()
        } else {
            db_path.with_file_name(format!(
                "{}{}",
                db_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("index.db"),
                suffix
            ))
        };
        if !source.exists() {
            continue;
        }
        let backup = source.with_file_name(format!(
            "{}.{}-{stamp}",
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("index.db"),
            reason.as_str(),
        ));
        std::fs::rename(&source, &backup)?;
        quarantined.push(backup);
    }
    Ok(quarantined)
}

pub(crate) async fn schema_status(pool: &SqlitePool) -> Result<SchemaStatus, AppError> {
    let has_version_table: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
    )
    .fetch_one(pool)
    .await?;
    if has_version_table == 0 {
        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_one(pool)
        .await?;
        return Ok(if table_count == 0 {
            SchemaStatus::Uninitialized
        } else {
            SchemaStatus::Incompatible(None)
        });
    }
    let current: Option<i64> = sqlx::query_scalar("SELECT version FROM schema_version LIMIT 1")
        .fetch_optional(pool)
        .await?;
    Ok(if current == Some(SCHEMA_VERSION) {
        SchemaStatus::Current
    } else {
        SchemaStatus::Incompatible(current)
    })
}

/// Initialize the current schema. Existing incompatible files are handled by
/// the owning open path so no unknown table is ever modified in place.
pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), AppError> {
    match schema_status(pool).await? {
        SchemaStatus::Current => return Ok(()),
        SchemaStatus::Uninitialized => {}
        SchemaStatus::Incompatible(found) => {
            return Err(AppError::Index(format!(
                "index schema version mismatch (found {found:?}, expected {SCHEMA_VERSION})"
            )));
        }
    }

    sqlx::query("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        .execute(pool)
        .await?;

    let ddl = [
        r#"
        CREATE TABLE IF NOT EXISTS entries (
            file_path            TEXT PRIMARY KEY,
            parent_path          TEXT NOT NULL,
            title                TEXT NOT NULL,
            icon                 TEXT,
            description          TEXT,
            cover                TEXT,
            created              TEXT NOT NULL,
            updated              TEXT NOT NULL,
            collection_root_path TEXT,
            in_collection        INTEGER NOT NULL,
            is_entry_head        INTEGER NOT NULL,
            fields               TEXT NOT NULL,
            body_preview         TEXT
        )
        "#,
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            title, description, body_preview, content=entries, content_rowid=rowid
        )
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, title, description, body_preview)
            VALUES (new.rowid, new.title, new.description, new.body_preview);
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, description, body_preview)
            VALUES ('delete', old.rowid, old.title, old.description, old.body_preview);
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, description, body_preview)
            VALUES ('delete', old.rowid, old.title, old.description, old.body_preview);
            INSERT INTO entries_fts(rowid, title, description, body_preview)
            VALUES (new.rowid, new.title, new.description, new.body_preview);
        END
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            rel_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            mime TEXT,
            size_bytes INTEGER,
            document_id TEXT,
            created_at TEXT NOT NULL
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_path)",
        "CREATE INDEX IF NOT EXISTS idx_entries_collection_root ON entries(collection_root_path)",
        "CREATE INDEX IF NOT EXISTS idx_entries_in_collection ON entries(in_collection)",
        "CREATE INDEX IF NOT EXISTS idx_entries_is_entry_head ON entries(is_entry_head)",
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
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            source_path TEXT PRIMARY KEY,
            node_kind TEXT NOT NULL CHECK (node_kind IN ('page', 'collection', 'agent_instruction', 'skill')),
            title TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            source_updated_at TEXT NOT NULL,
            checked_at TEXT NOT NULL,
            canonical_source_path TEXT NOT NULL,
            provenance_json TEXT NOT NULL
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kind_path ON knowledge_documents(node_kind, source_path)",
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_fragments (
            source_path TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            location_path TEXT NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            byte_start INTEGER NOT NULL,
            byte_end INTEGER NOT NULL,
            PRIMARY KEY (source_path, ordinal),
            FOREIGN KEY (source_path) REFERENCES knowledge_documents(source_path) ON DELETE CASCADE
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_links (
            source_path TEXT NOT NULL,
            edge_kind TEXT NOT NULL CHECK (edge_kind IN ('links_to', 'relation', 'member_of', 'references')),
            target_url TEXT NOT NULL,
            target_scope TEXT NOT NULL,
            target_path TEXT,
            target_kind TEXT,
            field_name TEXT,
            location_path TEXT NOT NULL,
            byte_start INTEGER NOT NULL,
            byte_end INTEGER NOT NULL,
            origin TEXT NOT NULL CHECK (origin = 'explicit'),
            PRIMARY KEY (source_path, edge_kind, target_url, byte_start, field_name),
            FOREIGN KEY (source_path) REFERENCES knowledge_documents(source_path) ON DELETE CASCADE
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(source_path)",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(target_scope, target_path)",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_links_kind_source ON knowledge_links(edge_kind, source_path)",
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_agent_applicability (
            source_scope TEXT NOT NULL CHECK (source_scope IN ('current', 'root')),
            source_path TEXT NOT NULL,
            node_kind TEXT NOT NULL CHECK (node_kind IN ('agent_instruction', 'skill')),
            provenance_json TEXT NOT NULL,
            PRIMARY KEY (source_scope, source_path, node_kind)
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_manifest (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            checked_at TEXT NOT NULL,
            document_count INTEGER NOT NULL,
            link_count INTEGER NOT NULL,
            skipped_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            generation INTEGER NOT NULL DEFAULT 0
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_source_manifest (
            source_path TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('markdown', 'collection_schema', 'agent_context')),
            fingerprint TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            modified_ns INTEGER NOT NULL,
            checked_at TEXT NOT NULL,
            diagnostic_code TEXT,
            PRIMARY KEY (source_path, source_kind)
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_knowledge_source_manifest_diagnostic ON knowledge_source_manifest(diagnostic_code, source_path)",
    ];

    for stmt in ddl {
        sqlx::query(stmt).execute(pool).await?;
    }

    sqlx::query("INSERT INTO schema_version (version) VALUES (?)")
        .bind(SCHEMA_VERSION)
        .execute(pool)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn corrupt_index_is_quarantined_before_fresh_schema_creation() {
        let temp = tempfile::TempDir::new().unwrap();
        let db_path = temp.path().join("index.db");
        std::fs::write(&db_path, "not a sqlite database").unwrap();

        let replacement = crate::index::open_prepared_pool(&db_path).await.unwrap();
        ensure_schema(&replacement).await.unwrap();
        assert!(db_path.exists());
        assert!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        );
    }

    #[tokio::test]
    async fn incompatible_index_is_quarantined_as_a_whole_file() {
        let temp = tempfile::TempDir::new().unwrap();
        let db_path = temp.path().join("index.db");
        let legacy = create_pool(&db_path).await.unwrap();
        sqlx::query("CREATE TABLE schema_version (version INTEGER NOT NULL)")
            .execute(&legacy)
            .await
            .unwrap();
        sqlx::query("INSERT INTO schema_version VALUES (13)")
            .execute(&legacy)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE routine_runs (routine_run_id TEXT PRIMARY KEY)")
            .execute(&legacy)
            .await
            .unwrap();
        sqlx::query("INSERT INTO routine_runs VALUES ('legacy-run')")
            .execute(&legacy)
            .await
            .unwrap();
        legacy.close().await;

        let replacement = crate::index::open_prepared_pool(&db_path).await.unwrap();

        assert_eq!(
            schema_status(&replacement).await.unwrap(),
            SchemaStatus::Current
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'routine_%'",
            )
            .fetch_one(&replacement)
            .await
            .unwrap(),
            0
        );
        assert!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".incompatible-"))
        );
    }
}
