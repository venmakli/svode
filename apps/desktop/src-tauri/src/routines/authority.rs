use std::path::Path;

use chrono::{SecondsFormat, Utc};
use sqlx::{SqlitePool, Transaction};

use super::model::{ResolvedRoutineOwner, RoutineOwnerInputKind};
use super::service;
use crate::AppError;
use crate::index::{IndexKey, IndexState};

pub(crate) async fn read(
    pool: &SqlitePool,
    owner: &ResolvedRoutineOwner,
) -> Result<bool, AppError> {
    read_key(pool, &owner.identity()).await
}

pub(crate) async fn read_indexed_collection(
    pool: &SqlitePool,
    index_key: &IndexKey,
    owner_path: &str,
) -> Result<bool, AppError> {
    read_key(
        pool,
        &ResolvedRoutineOwner::indexed_collection_identity(index_key, owner_path),
    )
    .await
}

async fn read_key(pool: &SqlitePool, owner_key: &str) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT enabled FROM routine_automatic_authority WHERE owner_key = ?",
    )
    .bind(owner_key)
    .fetch_optional(pool)
    .await?
    .is_some_and(|enabled| enabled != 0))
}

pub(crate) async fn set(
    pool: &SqlitePool,
    owner: &ResolvedRoutineOwner,
    enabled: bool,
) -> Result<bool, AppError> {
    let owner_key = owner.identity();
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if enabled {
        sqlx::query(
            r#"
            INSERT INTO routine_automatic_authority (owner_key, enabled, updated_at)
            VALUES (?, 1, ?)
            ON CONFLICT(owner_key) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            WHERE routine_automatic_authority.enabled != excluded.enabled
            "#,
        )
        .bind(&owner_key)
        .bind(updated_at)
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE routine_automatic_authority SET enabled = 0, updated_at = ? WHERE owner_key = ? AND enabled != 0",
        )
        .bind(updated_at)
        .bind(&owner_key)
        .execute(pool)
        .await?;
    }
    read_key(pool, &owner_key).await
}

pub(crate) async fn migrate_legacy_for_project(
    root_pool: &SqlitePool,
    index_state: &IndexState,
    project_path: &Path,
) -> Result<(), AppError> {
    let project_key = project_path.to_string_lossy();
    let legacy = sqlx::query_scalar::<_, i64>(
        "SELECT enabled FROM routine_automatic_consent WHERE project_path = ?",
    )
    .bind(project_key.as_ref())
    .fetch_optional(root_pool)
    .await?;

    match legacy {
        None => Ok(()),
        Some(0) => consume_disabled_legacy(root_pool, project_key.as_ref()).await,
        Some(_) => {
            let owners = discover_project_owners(index_state, project_path).await?;
            materialize_enabled_legacy(root_pool, project_key.as_ref(), &owners).await
        }
    }
}

async fn consume_disabled_legacy(pool: &SqlitePool, project_path: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM routine_automatic_consent WHERE project_path = ?")
        .bind(project_path)
        .execute(pool)
        .await?;
    Ok(())
}

async fn materialize_enabled_legacy(
    pool: &SqlitePool,
    project_path: &str,
    owners: &[ResolvedRoutineOwner],
) -> Result<(), AppError> {
    let mut transaction = pool.begin().await?;
    let still_enabled = sqlx::query_scalar::<_, i64>(
        "SELECT enabled FROM routine_automatic_consent WHERE project_path = ?",
    )
    .bind(project_path)
    .fetch_optional(&mut *transaction)
    .await?
    .is_some_and(|enabled| enabled != 0);
    if !still_enabled {
        transaction.rollback().await?;
        return Ok(());
    }

    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    for owner in owners {
        insert_enabled_if_missing(&mut transaction, &owner.identity(), &updated_at).await?;
    }
    sqlx::query("DELETE FROM routine_automatic_consent WHERE project_path = ?")
        .bind(project_path)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

async fn insert_enabled_if_missing(
    transaction: &mut Transaction<'_, sqlx::Sqlite>,
    owner_key: &str,
    updated_at: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR IGNORE INTO routine_automatic_authority (owner_key, enabled, updated_at) VALUES (?, 1, ?)",
    )
    .bind(owner_key)
    .bind(updated_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(crate) async fn discover_project_owners(
    index_state: &IndexState,
    project_path: &Path,
) -> Result<Vec<ResolvedRoutineOwner>, AppError> {
    let project_path = project_path.to_path_buf();
    let mut owners = Vec::new();
    for key in index_state.routine_inventory_keys(&project_path).await? {
        let space_path = index_state.dir_for_key(&key).await?;
        let space_id = match &key {
            IndexKey::Root(_) => "root",
            IndexKey::Space { space_id, .. } => space_id,
        };
        owners.push(service::resolve_owner(
            &project_path,
            &space_path,
            space_id,
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )?);
        for owner_path in index_state.routine_owner_paths(&key).await? {
            owners.push(service::resolve_owner(
                &project_path,
                &space_path,
                space_id,
                &owner_path,
                RoutineOwnerInputKind::CollectionDirectory,
            )?);
        }
    }
    Ok(owners)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;
    use crate::index::db;
    use crate::routines::model::{RoutineOwnerDescriptor, RoutineOwnerKind};

    fn owner(space_id: &str, kind: RoutineOwnerKind, owner_path: &str) -> ResolvedRoutineOwner {
        let project_path = PathBuf::from("/project");
        let space_path = if space_id == "root" {
            project_path.clone()
        } else {
            project_path.join(space_id)
        };
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind,
                space_id: space_id.into(),
                owner_path: owner_path.into(),
            },
            project_path: project_path.clone(),
            space_path,
            owner_root: project_path.join(owner_path),
            index_key: if space_id == "root" {
                IndexKey::Root(project_path)
            } else {
                IndexKey::Space {
                    project: project_path,
                    space_id: space_id.into(),
                }
            },
        }
    }

    async fn pool() -> (tempfile::TempDir, SqlitePool) {
        let temp = tempdir().unwrap();
        let pool = db::create_pool(&temp.path().join("index.db"))
            .await
            .unwrap();
        db::ensure_schema(&pool).await.unwrap();
        (temp, pool)
    }

    #[tokio::test]
    async fn exact_owner_values_are_independent_and_new_or_renamed_owners_default_off() {
        let (_temp, pool) = pool().await;
        let root = owner("root", RoutineOwnerKind::Project, ".");
        let space_a = owner("space-a", RoutineOwnerKind::Space, ".");
        let space_b = owner("space-b", RoutineOwnerKind::Space, ".");
        let collection_a = owner("space-a", RoutineOwnerKind::Collection, "tasks");
        let collection_b = owner("space-a", RoutineOwnerKind::Collection, "notes");
        let renamed = owner("space-a", RoutineOwnerKind::Collection, "renamed-tasks");

        assert!(set(&pool, &root, true).await.unwrap());
        assert!(set(&pool, &space_a, true).await.unwrap());
        assert!(set(&pool, &collection_a, true).await.unwrap());
        assert!(read(&pool, &root).await.unwrap());
        assert!(read(&pool, &space_a).await.unwrap());
        assert!(!read(&pool, &space_b).await.unwrap());
        assert!(read(&pool, &collection_a).await.unwrap());
        assert!(!read(&pool, &collection_b).await.unwrap());
        assert!(!read(&pool, &renamed).await.unwrap());
    }

    #[tokio::test]
    async fn same_value_mutation_is_idempotent() {
        let (_temp, pool) = pool().await;
        let root = owner("root", RoutineOwnerKind::Project, ".");
        assert!(!set(&pool, &root, false).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM routine_automatic_authority WHERE owner_key = ?",
            )
            .bind(root.identity())
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        assert!(set(&pool, &root, true).await.unwrap());
        let first: String = sqlx::query_scalar(
            "SELECT updated_at FROM routine_automatic_authority WHERE owner_key = ?",
        )
        .bind(root.identity())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(set(&pool, &root, true).await.unwrap());
        let row: (i64, String) = sqlx::query_as(
            "SELECT COUNT(*), updated_at FROM routine_automatic_authority WHERE owner_key = ?",
        )
        .bind(root.identity())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (1, first));
    }

    #[tokio::test]
    async fn enabled_legacy_migration_is_atomic_idempotent_and_preserves_owner_values() {
        let (_temp, pool) = pool().await;
        let root = owner("root", RoutineOwnerKind::Project, ".");
        let space = owner("space-a", RoutineOwnerKind::Space, ".");
        let collection = owner("space-a", RoutineOwnerKind::Collection, "tasks");
        let later = owner("space-a", RoutineOwnerKind::Collection, "later");
        sqlx::query("INSERT INTO routine_automatic_consent (project_path, enabled, updated_at) VALUES ('/project', 1, 'legacy')")
            .execute(&pool)
            .await
            .unwrap();
        set(&pool, &space, true).await.unwrap();
        set(&pool, &space, false).await.unwrap();

        sqlx::query(
            "CREATE TRIGGER interrupt_authority BEFORE INSERT ON routine_automatic_authority WHEN NEW.enabled = 1 BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            materialize_enabled_legacy(
                &pool,
                "/project",
                &[root.clone(), space.clone(), collection.clone()]
            )
            .await
            .is_err()
        );
        assert!(!read(&pool, &root).await.unwrap());
        assert!(!read(&pool, &space).await.unwrap());
        let legacy: i64 = sqlx::query_scalar(
            "SELECT enabled FROM routine_automatic_consent WHERE project_path = '/project'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(legacy, 1);

        sqlx::query("DROP TRIGGER interrupt_authority")
            .execute(&pool)
            .await
            .unwrap();
        materialize_enabled_legacy(
            &pool,
            "/project",
            &[root.clone(), space.clone(), collection.clone()],
        )
        .await
        .unwrap();
        assert!(read(&pool, &root).await.unwrap());
        assert!(!read(&pool, &space).await.unwrap());
        assert!(read(&pool, &collection).await.unwrap());
        assert!(!read(&pool, &later).await.unwrap());
        materialize_enabled_legacy(&pool, "/project", &[root.clone(), later.clone()])
            .await
            .unwrap();
        assert!(!read(&pool, &later).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM routine_automatic_consent WHERE project_path = '/project'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn disabled_or_missing_legacy_values_do_not_fan_out() {
        let (_temp, pool) = pool().await;
        let root = owner("root", RoutineOwnerKind::Project, ".");
        assert!(!read(&pool, &root).await.unwrap());
        sqlx::query("INSERT INTO routine_automatic_consent (project_path, enabled, updated_at) VALUES ('/project', 0, 'legacy')")
            .execute(&pool)
            .await
            .unwrap();
        consume_disabled_legacy(&pool, "/project").await.unwrap();
        assert!(!read(&pool, &root).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_automatic_authority")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn enabled_legacy_is_not_consumed_without_a_complete_owner_inventory() {
        let (temp, pool) = pool().await;
        let project = temp.path();
        sqlx::query(
            "INSERT INTO routine_automatic_consent (project_path, enabled, updated_at) VALUES (?, 1, 'legacy')",
        )
        .bind(project.to_string_lossy().as_ref())
        .execute(&pool)
        .await
        .unwrap();

        let state = IndexState::new();
        assert!(
            migrate_legacy_for_project(&pool, &state, project)
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM routine_automatic_consent WHERE project_path = ?",
            )
            .bind(project.to_string_lossy().as_ref())
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_automatic_authority")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn closed_pool_reads_and_writes_fail_closed_to_callers() {
        let (_temp, pool) = pool().await;
        let root = owner("root", RoutineOwnerKind::Project, ".");
        pool.close().await;
        assert!(read(&pool, &root).await.is_err());
        assert!(set(&pool, &root, true).await.is_err());
    }
}
