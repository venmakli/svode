use sqlx::{Sqlite, SqlitePool, Transaction};

use super::model::RoutineCatalogSnapshot;
#[cfg(test)]
use super::model::RoutineRow;
use crate::AppError;

pub(crate) async fn replace_owner_snapshot(
    pool: &SqlitePool,
    snapshot: &RoutineCatalogSnapshot,
) -> Result<(), AppError> {
    let mut transaction = pool.begin().await?;
    delete_owner_rows(&mut transaction, &snapshot.owner.owner_path).await?;
    for row in &snapshot.routines {
        let row_json = serde_json::to_string(row)?;
        sqlx::query(
            r#"
            INSERT INTO routine_definitions (
                owner_path,
                routine_id,
                fingerprint,
                row_json,
                refreshed_at
            ) VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&snapshot.owner.owner_path)
        .bind(&row.routine_id)
        .bind(&row.fingerprint)
        .bind(row_json)
        .bind(&snapshot.refreshed_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn delete_owner_rows(
    transaction: &mut Transaction<'_, Sqlite>,
    owner_path: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM routine_definitions WHERE owner_path = ?")
        .bind(owner_path)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn read_owner_rows(
    pool: &SqlitePool,
    owner_path: &str,
) -> Result<Vec<RoutineRow>, AppError> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT row_json FROM routine_definitions WHERE owner_path = ? ORDER BY routine_id",
    )
    .bind(owner_path)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| serde_json::from_str(&row).map_err(AppError::Serde))
        .collect()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::index::db;
    use crate::routines::model::{RoutineDiagnostic, RoutineOwnerDescriptor, RoutineOwnerKind};

    fn snapshot(owner_path: &str, rows: Vec<RoutineRow>) -> RoutineCatalogSnapshot {
        RoutineCatalogSnapshot {
            owner: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Collection,
                space_id: "root".into(),
                owner_path: owner_path.into(),
            },
            routines: rows,
            diagnostics: vec![RoutineDiagnostic::new("catalog", "diagnostic")],
            catalog_fingerprint: "catalog".into(),
            refreshed_at: "2026-08-06T00:00:00Z".into(),
        }
    }

    fn row(id: &str) -> RoutineRow {
        RoutineRow {
            routine_id: id.into(),
            filename: format!("{id}.md"),
            path: format!("tasks/.routines/{id}.md"),
            title: id.into(),
            description: None,
            enabled: None,
            trigger_type: None,
            trigger_summary: None,
            action_type: None,
            action_summary: None,
            executor: None,
            last_run_at: None,
            next_run_at: None,
            fingerprint: format!("fingerprint:{id}"),
            definition: None,
            diagnostics: Vec::new(),
        }
    }

    #[tokio::test]
    async fn owner_replace_is_transactional_and_does_not_touch_siblings() {
        let temp = tempdir().unwrap();
        let pool = db::create_pool(&temp.path().join("index.db"))
            .await
            .unwrap();
        db::ensure_schema(&pool).await.unwrap();

        replace_owner_snapshot(&pool, &snapshot("tasks", vec![row("one"), row("two")]))
            .await
            .unwrap();
        replace_owner_snapshot(&pool, &snapshot("notes", vec![row("sibling")]))
            .await
            .unwrap();
        replace_owner_snapshot(&pool, &snapshot("tasks", vec![row("current")]))
            .await
            .unwrap();

        assert_eq!(
            read_owner_rows(&pool, "tasks")
                .await
                .unwrap()
                .into_iter()
                .map(|row| row.routine_id)
                .collect::<Vec<_>>(),
            vec!["current"]
        );
        assert_eq!(read_owner_rows(&pool, "notes").await.unwrap().len(), 1);
    }
}
