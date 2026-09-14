CREATE TABLE schema_version (version INTEGER NOT NULL);
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
            body_preview         TEXT,
            is_discoverable      INTEGER NOT NULL
        );
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            title, description, body_preview, content=entries, content_rowid=rowid
        );
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries
        WHEN new.is_discoverable = 1 BEGIN
            INSERT INTO entries_fts(rowid, title, description, body_preview)
            VALUES (new.rowid, new.title, new.description, new.body_preview);
        END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries
        WHEN old.is_discoverable = 1 BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, description, body_preview)
            VALUES ('delete', old.rowid, old.title, old.description, old.body_preview);
        END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title, description, body_preview)
            SELECT 'delete', old.rowid, old.title, old.description, old.body_preview
            WHERE old.is_discoverable = 1;
            INSERT INTO entries_fts(rowid, title, description, body_preview)
            SELECT new.rowid, new.title, new.description, new.body_preview
            WHERE new.is_discoverable = 1;
        END;
CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            rel_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            mime TEXT,
            size_bytes INTEGER,
            document_id TEXT,
            created_at TEXT NOT NULL
        );
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_path);
CREATE INDEX IF NOT EXISTS idx_entries_collection_root ON entries(collection_root_path);
CREATE INDEX IF NOT EXISTS idx_entries_in_collection ON entries(in_collection);
CREATE INDEX IF NOT EXISTS idx_entries_is_entry_head ON entries(is_entry_head);
CREATE INDEX IF NOT EXISTS idx_entries_is_discoverable ON entries(is_discoverable);
CREATE INDEX IF NOT EXISTS idx_assets_document ON assets(document_id);
CREATE TABLE IF NOT EXISTS broken_links (
            source_rel_path TEXT NOT NULL,
            target_space_id TEXT,
            target_url TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            PRIMARY KEY (source_rel_path, target_url)
        );
CREATE INDEX IF NOT EXISTS idx_broken_links_source ON broken_links(source_rel_path);
CREATE TABLE IF NOT EXISTS knowledge_documents (
            source_path TEXT PRIMARY KEY,
            node_kind TEXT NOT NULL CHECK (node_kind IN ('page', 'collection', 'agent_instruction', 'skill')),
            title TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            source_updated_at TEXT NOT NULL,
            checked_at TEXT NOT NULL,
            canonical_source_path TEXT NOT NULL,
            provenance_json TEXT NOT NULL
        );
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kind_path ON knowledge_documents(node_kind, source_path);
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
        );
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
        );
CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(source_path);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(target_scope, target_path);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_kind_source ON knowledge_links(edge_kind, source_path);
CREATE TABLE IF NOT EXISTS knowledge_agent_applicability (
            source_scope TEXT NOT NULL CHECK (source_scope IN ('current', 'root')),
            source_path TEXT NOT NULL,
            node_kind TEXT NOT NULL CHECK (node_kind IN ('agent_instruction', 'skill')),
            provenance_json TEXT NOT NULL,
            PRIMARY KEY (source_scope, source_path, node_kind)
        );
CREATE TABLE IF NOT EXISTS knowledge_manifest (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            checked_at TEXT NOT NULL,
            document_count INTEGER NOT NULL,
            link_count INTEGER NOT NULL,
            skipped_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            generation INTEGER NOT NULL DEFAULT 0
        );
CREATE TABLE IF NOT EXISTS knowledge_source_manifest (
            source_path TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('markdown', 'collection_schema', 'agent_context')),
            fingerprint TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            modified_ns INTEGER NOT NULL,
            checked_at TEXT NOT NULL,
            diagnostic_code TEXT,
            PRIMARY KEY (source_path, source_kind)
        );
CREATE INDEX IF NOT EXISTS idx_knowledge_source_manifest_diagnostic ON knowledge_source_manifest(diagnostic_code, source_path);
INSERT INTO schema_version VALUES (17);
