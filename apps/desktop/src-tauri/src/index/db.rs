use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use std::path::Path;
use std::time::Duration;

use crate::error::AppError;

/// Current schema version. Bumping this forces a drop-and-recreate of all
/// index tables on next open (the index is a rebuildable cache).
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
const SCHEMA_VERSION: i64 = 12;

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
        "DROP TABLE IF EXISTS routine_definitions",
        "DROP TABLE IF EXISTS routine_event_queue",
        "DROP TABLE IF EXISTS knowledge_links",
        "DROP TABLE IF EXISTS knowledge_fragments",
        "DROP TABLE IF EXISTS knowledge_agent_applicability",
        "DROP TABLE IF EXISTS knowledge_documents",
        "DROP TABLE IF EXISTS knowledge_manifest",
    ];
    for stmt in drops {
        sqlx::query(stmt).execute(pool).await?;
    }

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
        CREATE TABLE IF NOT EXISTS routine_definitions (
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            row_json TEXT NOT NULL,
            refreshed_at TEXT NOT NULL,
            PRIMARY KEY (owner_path, routine_id)
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_routine_definitions_owner ON routine_definitions(owner_path)",
        r#"
        CREATE TABLE IF NOT EXISTS routine_runs (
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
        "CREATE INDEX IF NOT EXISTS idx_routine_runs_owner_routine ON routine_runs(owner_path, routine_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_routine_runs_launch ON routine_runs(launch_id)",
        r#"
        CREATE TABLE IF NOT EXISTS routine_schedule_state (
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            checkpoint_at TEXT NOT NULL,
            next_run_at TEXT NOT NULL,
            PRIMARY KEY (owner_path, routine_id)
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS routine_owner_roots (
            owner_path TEXT PRIMARY KEY
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS routine_automatic_consent (
            project_path TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS routine_automatic_leases (
            run_key TEXT PRIMARY KEY,
            routine_id TEXT NOT NULL,
            leased_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS routine_remote_claims (
            run_key TEXT PRIMARY KEY,
            owner_path TEXT NOT NULL,
            routine_id TEXT NOT NULL,
            definition_fingerprint TEXT NOT NULL,
            claimed_by TEXT NOT NULL,
            claimed_at TEXT NOT NULL
        )
        "#,
        "CREATE INDEX IF NOT EXISTS idx_routine_remote_claims_owner_routine ON routine_remote_claims(owner_path, routine_id, claimed_at DESC)",
        r#"
        CREATE TABLE IF NOT EXISTS routine_event_queue (
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
        "CREATE INDEX IF NOT EXISTS idx_routine_event_queue_pending ON routine_event_queue(state, observed_at)",
        "CREATE INDEX IF NOT EXISTS idx_routine_event_queue_event ON routine_event_queue(event_key)",
        r#"
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            source_path TEXT PRIMARY KEY,
            node_kind TEXT NOT NULL CHECK (node_kind IN ('document', 'collection', 'entry', 'agent_instruction', 'skill')),
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
            failure_count INTEGER NOT NULL
        )
        "#,
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
