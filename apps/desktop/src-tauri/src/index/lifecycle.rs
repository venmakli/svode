#[cfg(test)]
use std::path::Path;

#[cfg(test)]
use svode_core::index::lifecycle::cleanup_using;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{IndexKey, IndexState, db};
    use std::sync::Arc;

    fn generations(dir: &Path) -> usize {
        std::fs::read_dir(dir.join(".svode"))
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("index.db.incompatible-")
            })
            .count()
    }

    #[tokio::test]
    async fn slow_inspection_allows_other_owners_and_reopen_rejects_stale_cleanup() {
        use tokio::sync::oneshot;
        use tokio::time::{Duration, timeout};
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().join("first"));
        let other = IndexKey::Root(temp.path().join("other"));
        let pool = state.get_or_create(&key).await.unwrap();
        state.run_full_reindex(&key).await.unwrap();
        let directory = state.dir_for_key(&key).await.unwrap().join(".svode");
        let old = directory.join("index.db.incompatible-123");
        let legacy = db::create_pool(&old).await.unwrap();
        sqlx::raw_sql(include_str!("fixtures/index-v15.sql"))
            .execute(&legacy)
            .await
            .unwrap();
        db::close_pool(&legacy).await;
        let before = std::fs::read(&old).unwrap();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        let task = {
            let state = state.clone();
            let key = key.clone();
            let pool = pool.clone();
            tokio::spawn(async move {
                cleanup_using(
                    state.core.pools.clone().lock_owned().await,
                    key,
                    pool,
                    |directory, owner| async move {
                        entered_tx.send(()).unwrap();
                        resume_rx.await.unwrap();
                        svode_core::index::retention::cleanup_with_owner(&directory, Some(&owner))
                            .await
                    },
                )
                .await;
            })
        };
        timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        // Ready reads and a cold open remain usable while inspection is paused.
        timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        let other_pool = timeout(Duration::from_secs(5), state.get_or_create(&other))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT 1")
                .fetch_one(&other_pool)
                .await
                .unwrap(),
            1
        );
        // A duplicate request is coalesced rather than queued behind this scan.
        timeout(
            Duration::from_secs(5),
            state.cleanup_reconciled_index(&key, &pool),
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(5), state.close_key(&key))
            .await
            .unwrap();
        let replacement = timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        assert!(pool.is_closed());
        assert!(!replacement.is_closed());
        resume_tx.send(()).unwrap();
        timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read(&old).unwrap(),
            before,
            "old cleanup deleted after reopen"
        );
        state.run_full_reindex(&key).await.unwrap();
        assert!(!old.exists(), "current successful rebuild can clean up");
        state.close_key(&key).await;
        state.close_key(&other).await;
    }

    #[tokio::test]
    async fn pending_deletion_close_does_not_hold_registry_and_survives_cancellation() {
        use tokio::time::{Duration, timeout};
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().join("first"));
        let other = IndexKey::Root(temp.path().join("other"));
        let pool = state.get_or_create(&key).await.unwrap();
        state.run_full_reindex(&key).await.unwrap();
        let owner = {
            let pools = state.core.pools.lock().await;
            pools.cleanup_owner(&key).unwrap()
        };
        let deletion = owner.authorize_deletion().await.unwrap();
        let close = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.close_key(&key).await })
        };
        // Wait until close is queued on the owner gate, without wall-clock sleeps.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(!close.is_finished());
        timeout(Duration::from_secs(5), state.get_or_create(&other))
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        close.abort();
        drop(deletion);
        timeout(Duration::from_secs(5), pool.close_event())
            .await
            .unwrap();
        let replacement = timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        assert!(!replacement.is_closed());
        assert!(owner.authorize_deletion().await.is_none());
        state.close_key(&key).await;
        state.close_key(&other).await;
    }

    #[tokio::test]
    async fn cancelled_initializer_cannot_publish_after_close() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join(".svode/index.db");
        let blocker = db::create_pool(&path).await.unwrap();
        let mut connection = blocker.acquire().await.unwrap();
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut *connection)
            .await
            .unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let caller = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.get_or_create(&key).await })
        };
        while state.core.pools.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
        caller.abort();
        let close = {
            let state = state.clone();
            let project = temp.path().to_path_buf();
            tokio::spawn(async move { state.close_project(&project).await })
        };
        sqlx::query("ROLLBACK")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);
        blocker.close().await;
        close.await.unwrap();
        assert!(state.existing_pool(&key).await.is_none());
        let pool = state.get_or_create(&key).await.unwrap();
        assert_eq!(
            db::schema_status(&pool).await.unwrap(),
            db::SchemaStatus::Current
        );
        assert_eq!(generations(temp.path()), 0);
        state.close_key(&key).await;
    }

    #[tokio::test]
    async fn root_inline_and_independent_owners_preserve_operational_rows() {
        let temp = tempfile::TempDir::new().unwrap();
        let project = temp.path();
        let state = IndexState::new();
        let mut cache = super::super::ProjectSpacesCache::default();
        for folder in ["inline", "independent"] {
            std::fs::create_dir_all(project.join(folder)).unwrap();
            cache.folder_by_id.insert(folder.into(), folder.into());
            cache.by_folder.insert(folder.into(), folder.into());
            cache
                .status_by_id
                .insert(folder.into(), crate::space::types::SpaceStatus::Ready);
        }
        state
            .core
            .spaces_cache
            .lock()
            .await
            .insert(project.to_path_buf(), cache);
        let keys = [
            IndexKey::Root(project.to_path_buf()),
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "inline".into(),
            },
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "independent".into(),
            },
        ];
        for (i, key) in keys.iter().enumerate() {
            let routines = state.get_or_create_routines(key).await.unwrap();
            sqlx::query("INSERT INTO routine_schedule_state VALUES (?, 'routine', 'fingerprint', 'checkpoint', 'next-run')")
                .bind(format!("owner-{i}")).execute(&routines).await.unwrap();
            let dir = state.dir_for_key(key).await.unwrap();
            crate::space::config::mutate_local_config(&dir, |local| {
                if i == 0 {
                    local.agent_sessions = Some(crate::space::types::AgentSessionsLocalConfig {
                        pinned_session_ids: vec!["codex:retained-pin".into()],
                    });
                }
                local
                    .routines
                    .as_mut()
                    .unwrap()
                    .automatic_authority
                    .insert(format!("owner-{i}"), true);
                Ok(())
            })
            .unwrap();
            sqlx::query("INSERT INTO routine_owner_roots VALUES (?)")
                .bind(format!("owner-{i}"))
                .execute(&routines)
                .await
                .unwrap();
            let index = state.get_or_create(key).await.unwrap();
            sqlx::query("UPDATE schema_version SET version = 16")
                .execute(&index)
                .await
                .unwrap();
        }
        for (i, key) in keys.iter().enumerate() {
            let dir = state.dir_for_key(key).await.unwrap();
            let local_before = std::fs::read(dir.join(".svode/local.json")).unwrap();
            let old = dir.join(".svode/index.db.incompatible-1");
            let old_pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&old)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("fixtures/index-v15.sql"))
                .execute(&old_pool)
                .await
                .unwrap();
            db::close_pool(&old_pool).await;
            std::fs::write(dir.join("page.md"), "# Preserved searchable content").unwrap();
            let owner = dir.join(format!("owner-{i}"));
            std::fs::create_dir_all(&owner).unwrap();
            std::fs::write(
                owner.join("schema.yaml"),
                "name: Retained owner\nproperties: []\n",
            )
            .unwrap();
            state.close_key(key).await;
            let index = state.get_or_create(key).await.unwrap();
            assert_eq!(
                db::schema_status(&index).await.unwrap(),
                db::SchemaStatus::Current
            );
            state.run_full_reindex(key).await.unwrap();
            assert!(!old.exists());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM entries WHERE file_path = 'page.md'"
                )
                .fetch_one(&index)
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM knowledge_documents WHERE source_path = 'page.md'"
                )
                .fetch_one(&index)
                .await
                .unwrap(),
                1
            );
            let routines = state.get_or_create_routines(key).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (String, String, String, String, String)>(
                "SELECT owner_path, routine_id, definition_fingerprint, checkpoint_at, next_run_at FROM routine_schedule_state"
            ).fetch_all(&routines).await.unwrap(), vec![(format!("owner-{i}"), "routine".into(), "fingerprint".into(), "checkpoint".into(), "next-run".into())]);
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT owner_path FROM routine_owner_roots")
                    .fetch_all(&routines)
                    .await
                    .unwrap(),
                vec![format!("owner-{i}")]
            );
            assert_eq!(
                std::fs::read(dir.join(".svode/local.json")).unwrap(),
                local_before
            );
            assert_eq!(generations(&dir), 1);
        }
        state.close_project(project).await;
    }

    #[tokio::test]
    async fn concurrent_cold_open_and_reopen_share_one_physical_generation() {
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let old = db::create_pool(&temp.path().join(".svode/index.db"))
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (16);")
            .execute(&old).await.unwrap();
        db::close_pool(&old).await;
        assert_eq!(old.size(), 0, "pool close returned with live connections");
        let mut tasks = Vec::new();
        for _ in 0..24 {
            let state = state.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                state.get_or_create(&key).await.unwrap()
            }));
        }
        let mut pools = Vec::new();
        for task in tasks {
            pools.push(task.await.unwrap());
        }
        assert_eq!(generations(temp.path()), 1);
        assert_eq!(state.core.pools.lock().await.physical_count(), 1);
        for _ in 0..5 {
            state.close_project(temp.path()).await;
            for pool in &pools {
                assert!(pool.is_closed());
            }
            let pool = state.get_or_create(&key).await.unwrap();
            assert_eq!(
                db::schema_status(&pool).await.unwrap(),
                db::SchemaStatus::Current
            );
        }
        assert_eq!(generations(temp.path()), 1);
        state.close_project(temp.path()).await;
    }

    #[tokio::test]
    async fn cancelled_close_drains_connections_before_reopen() {
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        let connection = pool.acquire().await.unwrap();
        let closer = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.close_key(&key).await })
        };
        pool.close_event().await;
        closer.abort();
        let reopen = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.get_or_create(&key).await.unwrap() })
        };
        tokio::task::yield_now().await;
        assert!(!reopen.is_finished());
        drop(connection);
        let replacement = reopen.await.unwrap();
        assert!(!replacement.is_closed());
        assert!(pool.is_closed());
        assert_eq!(generations(temp.path()), 0);
        state.close_key(&key).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn path_aliases_share_pool_and_close_together() {
        let temp = tempfile::TempDir::new().unwrap();
        let dir = temp.path().join("owner");
        std::fs::create_dir(&dir).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&dir, &alias).unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(dir.clone());
        let alias_key = IndexKey::Root(alias);
        let first = state.get_or_create(&key).await.unwrap();
        let second = state.get_or_create(&alias_key).await.unwrap();
        assert_eq!(state.core.pools.lock().await.physical_count(), 1);
        state.close_key(&key).await;
        assert!(first.is_closed());
        assert!(second.is_closed());
        assert!(state.existing_pool(&alias_key).await.is_none());
    }

    #[tokio::test]
    async fn interrupted_legacy_bootstrap_is_preserved_and_retry_converges() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join(".svode/index.db");
        let partial = db::create_pool(&path).await.unwrap();
        sqlx::raw_sql("CREATE TABLE schema_version (version INTEGER); CREATE TABLE unknown_evidence (value TEXT); INSERT INTO unknown_evidence VALUES ('keep');")
            .execute(&partial).await.unwrap();
        db::close_pool(&partial).await;
        let state = IndexState::new();
        let key = IndexKey::Root(temp.path().to_path_buf());
        state.get_or_create(&key).await.unwrap();
        state.close_key(&key).await;
        state.get_or_create(&key).await.unwrap();
        assert_eq!(generations(temp.path()), 1);
        let backup = std::fs::read_dir(temp.path().join(".svode"))
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("index.db.incompatible-")
            })
            .unwrap()
            .path();
        let evidence = db::create_pool(&backup).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM unknown_evidence")
                .fetch_one(&evidence)
                .await
                .unwrap(),
            "keep"
        );
        evidence.close().await;
        state.close_key(&key).await;
    }
}
