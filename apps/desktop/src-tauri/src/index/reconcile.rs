#[cfg(test)]
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::index::{IndexKey, IndexState};

pub(crate) use svode_core::index::reconcile::MAX_INDEXED_MARKDOWN_BYTES;

#[cfg(test)]
use svode_core::index::manifest::{
    SourceManifestRecord, advance_generation, read_generation, read_revision, read_source_manifest,
    reconcile_source_manifest, replace_source_manifest,
};

pub(crate) use svode_core::index::reconcile::ReconcileOutcome;

pub(crate) async fn reconcile_pool(
    state: &IndexState,
    key: &IndexKey,
) -> Result<ReconcileOutcome, AppError> {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::reconcile::reconcile_pool(cli.as_ref(), &state.core, key)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn pool() -> SqlitePool {
        let temp = TempDir::new().unwrap();
        let path = temp.keep().join("index.db");
        let pool = crate::index::db::create_pool(&path).await.unwrap();
        crate::index::db::ensure_schema(&pool).await.unwrap();
        pool
    }

    fn record(path: &str, fingerprint: &str) -> SourceManifestRecord {
        SourceManifestRecord {
            source_path: path.to_string(),
            source_kind: "markdown".to_string(),
            fingerprint: fingerprint.to_string(),
            size_bytes: 1,
            modified_ns: 1,
            checked_at: "checked".to_string(),
            diagnostic_code: None,
        }
    }

    #[tokio::test]
    async fn source_manifest_noop_does_not_rewrite_checked_at() {
        let pool = pool().await;
        let mut tx = pool.begin().await.unwrap();
        replace_source_manifest(&mut tx, &[record("note.md", "one")])
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let previous = read_source_manifest(&pool).await.unwrap();
        let mut current = previous.clone();
        current[0].checked_at = "new-check".to_string();
        let mut tx = pool.begin().await.unwrap();
        assert!(
            !reconcile_source_manifest(&mut tx, &previous, &current)
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        assert_eq!(
            read_source_manifest(&pool).await.unwrap()[0].checked_at,
            "checked"
        );
    }

    #[tokio::test]
    async fn revision_and_generation_have_distinct_noop_semantics() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO knowledge_manifest \
             (singleton,checked_at,document_count,link_count,skipped_count,failure_count) \
             VALUES (1,'now',0,0,0,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, false, false).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(0));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(0));

        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, false, true).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(0));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(1));

        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, true, true).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(1));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(2));
    }

    #[tokio::test]
    async fn reconciliation_is_write_free_on_noop_and_targets_change_and_delete() {
        let temp = TempDir::new().unwrap();
        let space = temp.path();
        let note = space.join("note.md");
        std::fs::write(&note, "alpha body").unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(&pool, space, space, &[])
            .await
            .unwrap();

        let baseline = (
            read_revision(&pool).await.unwrap().unwrap(),
            read_generation(&pool).await.unwrap().unwrap(),
        );
        sqlx::query("UPDATE knowledge_manifest SET checked_at = 'sentinel' WHERE singleton = 1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE knowledge_source_manifest SET checked_at = 'sentinel' \
             WHERE source_path = 'note.md' AND source_kind = 'markdown'",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            (
                read_revision(&pool).await.unwrap().unwrap(),
                read_generation(&pool).await.unwrap().unwrap(),
            ),
            baseline
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT checked_at FROM knowledge_manifest WHERE singleton = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "sentinel"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT checked_at FROM knowledge_source_manifest \
                 WHERE source_path = 'note.md' AND source_kind = 'markdown'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "sentinel"
        );

        std::fs::write(&note, "beta body with a different size").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT body_preview FROM entries WHERE file_path = 'note.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "beta body with a different size"
        );
        assert_eq!(read_revision(&pool).await.unwrap(), Some(baseline.0 + 1));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(baseline.1 + 1));

        std::fs::remove_file(&note).unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM entries")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(read_revision(&pool).await.unwrap(), Some(baseline.0 + 2));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(baseline.1 + 2));
    }

    #[tokio::test]
    async fn reconciliation_falls_back_for_schema_diffs_and_bounds_unsafe_sources() {
        let temp = TempDir::new().unwrap();
        let space = temp.path();
        std::fs::write(space.join("visible.md"), "visible").unwrap();
        std::fs::write(space.join("secrets.md"), "do not index").unwrap();
        std::fs::write(
            space.join("large.md"),
            vec![b'x'; MAX_INDEXED_MARKDOWN_BYTES as usize + 1],
        )
        .unwrap();
        std::fs::write(space.join("invalid.md"), [0xff, 0xfe]).unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(&pool, space, space, &[])
            .await
            .unwrap();

        let paths =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["visible.md"]);
        let diagnostics: Vec<(String, String)> = sqlx::query_as(
            "SELECT source_path,diagnostic_code FROM knowledge_source_manifest \
             WHERE diagnostic_code IS NOT NULL ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            diagnostics,
            vec![
                ("invalid.md".to_string(), "unreadable_source".to_string()),
                ("large.md".to_string(), "oversized_source".to_string()),
                ("secrets.md".to_string(), "excluded_secret_like".to_string()),
            ]
        );

        std::fs::create_dir_all(space.join("tasks")).unwrap();
        std::fs::write(space.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Rebuild
        );
    }

    #[tokio::test]
    async fn df_088_reconciliation_converges_git_visibility_without_source_edit() {
        let temp = TempDir::new().unwrap();
        let space = temp.path();
        std::fs::write(space.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(
            space.join("item.md"),
            "---\ntitle: Policy Needle\n---\npolicy-body-token",
        )
        .unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(&pool, space, space, &[])
            .await
            .unwrap();
        let original_fingerprint: String = sqlx::query_scalar(
            "SELECT fingerprint FROM knowledge_source_manifest \
             WHERE source_path = 'item.md' AND source_kind = 'markdown'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(original_fingerprint.starts_with("discoverable:"));

        std::fs::write(space.join(".gitignore"), "item.md\n").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        let hidden: (i64, String) = sqlx::query_as(
            "SELECT is_discoverable,body_preview FROM entries WHERE file_path = 'item.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(hidden, (0, String::new()));
        let hidden_fingerprint: String = sqlx::query_scalar(
            "SELECT fingerprint FROM knowledge_source_manifest \
             WHERE source_path = 'item.md' AND source_kind = 'markdown'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(hidden_fingerprint.starts_with("collection-member-only:"));
        assert_ne!(hidden_fingerprint, original_fingerprint);
        assert!(
            crate::index::search::search_fts(&pool, "policy-body-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );

        std::fs::write(space.join(".gitignore"), "item.md\n!item.md\n").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT is_discoverable FROM entries WHERE file_path = 'item.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            crate::index::search::search_fts(&pool, "policy-body-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
