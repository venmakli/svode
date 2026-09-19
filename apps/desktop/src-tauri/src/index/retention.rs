#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::index::{IndexKey, IndexState};
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

    async fn fixture(directory: &Path, generation: &str, version: i64, extra: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join(format!("index.db.incompatible-{generation}"));
        let sql = match version {
            14 => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../crates/svode-core/src/index/fixtures/index-v14.sql"
            )),
            15 | 16 => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../crates/svode-core/src/index/fixtures/index-v15.sql"
            )),
            _ => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../crates/svode-core/src/index/fixtures/index-v17.sql"
            )),
        };
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(sql).execute(&mut connection).await.unwrap();
        sqlx::query("UPDATE schema_version SET version = ?")
            .bind(version)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(extra).execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        path
    }

    #[tokio::test]
    async fn schema_creation_failure_and_stale_pool_do_not_authorize_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let directory = root.join(".svode");
        let old = fixture(&directory, "1", 15, "").await;
        let state = IndexState::new();
        let key = IndexKey::Root(root);
        let pool = state.get_or_create(&key).await.unwrap();
        state.cleanup_reconciled_index(&key, &pool).await;
        assert!(old.exists());
        sqlx::query("DROP TABLE entries")
            .execute(&pool)
            .await
            .unwrap();
        assert!(state.run_full_reindex(&key).await.is_err());
        assert!(old.exists());
        state.close_key(&key).await;
        let replacement = state.get_or_create(&key).await.unwrap();
        state.cleanup_reconciled_index(&key, &pool).await;
        assert!(old.exists());
        replacement.close().await;
        state.close_key(&key).await;
    }

    #[tokio::test]
    async fn source_failure_preserves_families_until_successful_reconciliation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let key = IndexKey::Root(root.clone());
        let state = IndexState::new();
        fs::write(root.join("page.md"), "---\ntitle: [\n---\nbody").unwrap();
        let old = fixture(&root.join(".svode"), "1", 15, "").await;
        state.run_full_reindex(&key).await.unwrap();
        assert!(old.exists());
        state.run_reconciliation(&key).await.unwrap();
        assert!(old.exists());
        fs::write(root.join("page.md"), "# Repaired content").unwrap();
        state.run_reconciliation(&key).await.unwrap();
        assert!(!old.exists());
        state.close_key(&key).await;
    }

    #[tokio::test]
    async fn successful_rebuild_and_cached_reopen_remove_accumulated_generations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let key = IndexKey::Root(root.clone());
        let state = IndexState::new();
        fs::write(
            root.join("page.md"),
            "# Searchable page\n\nPreserved content",
        )
        .unwrap();
        let directory = root.join(".svode");
        let canonical = fixture(&directory, "0", 14, "").await;
        fs::rename(canonical, directory.join("index.db")).unwrap();
        let old = fixture(&directory, "1", 15, "").await;
        state.run_full_reindex(&key).await.unwrap();
        assert!(
            !fs::read_dir(&directory)
                .unwrap()
                .map(Result::unwrap)
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("incompatible-"))
        );
        assert!(!old.exists());
        state.close_key(&key).await;
        let old = fixture(&directory, "2", 16, "").await;
        state.get_or_create(&key).await.unwrap();
        assert!(old.exists());
        state.run_reconciliation(&key).await.unwrap();
        assert!(!old.exists());
        let pool = state.existing_pool(&key).await.unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM entries WHERE file_path = 'page.md'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        state.close_key(&key).await;
    }
}
