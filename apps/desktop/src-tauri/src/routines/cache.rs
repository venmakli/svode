use std::path::PathBuf;
use std::sync::Mutex;

use sqlx::{Row, Sqlite, SqlitePool, Transaction};

#[cfg(test)]
use super::model::RoutineRow;
use super::model::{
    RoutineCatalogSnapshot, RoutineDefinition, RoutineRunRecord, RoutineRunTerminalStatus,
};
use crate::AppError;
use crate::agent_sessions::types::AgentSessionStatus;
use crate::terminal::{
    AgentTerminalLifecycleSink, AgentTerminalOutcomeEvidence, AgentTerminalOutcomeStatus,
};

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

#[derive(Debug, Clone)]
pub(crate) struct NewRoutineRun<'a> {
    pub routine_run_id: &'a str,
    pub routine_id: &'a str,
    pub owner_path: &'a str,
    pub trigger_type: &'a str,
    pub definition_fingerprint: &'a str,
    pub definition: &'a RoutineDefinition,
    pub launch_id: &'a str,
    pub source: &'a str,
    pub source_session_id: Option<&'a str>,
    pub agent_session_id: &'a str,
    pub created_at: &'a str,
}

pub(crate) async fn create_run(pool: &SqlitePool, run: NewRoutineRun<'_>) -> Result<(), AppError> {
    let definition_json = serde_json::to_string(run.definition)?;
    sqlx::query(
        r#"
        INSERT INTO routine_runs (
            routine_run_id, routine_id, owner_path, trigger_type,
            definition_fingerprint, definition_json, launch_id, source,
            source_session_id, agent_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(run.routine_run_id)
    .bind(run.routine_id)
    .bind(run.owner_path)
    .bind(run.trigger_type)
    .bind(run.definition_fingerprint)
    .bind(definition_json)
    .bind(run.launch_id)
    .bind(run.source)
    .bind(run.source_session_id)
    .bind(run.agent_session_id)
    .bind(run.created_at)
    .bind(run.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn attach_pty(
    pool: &SqlitePool,
    routine_run_id: &str,
    pty_id: &str,
    observed_at: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE routine_runs SET pty_id = ?, updated_at = ? WHERE routine_run_id = ?")
        .bind(pty_id)
        .bind(observed_at)
        .bind(routine_run_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn record_terminal_outcome(
    pool: &SqlitePool,
    routine_run_id: &str,
    status: RoutineRunTerminalStatus,
    exit_code: Option<i32>,
    reason: &str,
    observed_at: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE routine_runs
        SET terminal_status = ?, terminal_exit_code = ?, terminal_reason = ?,
            terminal_observed_at = ?, session_status = NULL, updated_at = ?
        WHERE routine_run_id = ?
        "#,
    )
    .bind(status.as_str())
    .bind(exit_code)
    .bind(reason)
    .bind(observed_at)
    .bind(observed_at)
    .bind(routine_run_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn reconcile_agent_session(
    pool: &SqlitePool,
    routine_run_id: &str,
    source_session_id: &str,
    agent_session_id: &str,
    session_status: &str,
    observed_at: &str,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE routine_runs
        SET source_session_id = ?, agent_session_id = ?, session_status = ?, updated_at = ?
        WHERE routine_run_id = ?
        "#,
    )
    .bind(source_session_id)
    .bind(agent_session_id)
    .bind(session_status)
    .bind(observed_at)
    .bind(routine_run_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn latest_run(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
) -> Result<Option<RoutineRunRecord>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT routine_run_id, routine_id, owner_path, launch_id, pty_id, source,
               source_session_id, agent_session_id, created_at, terminal_status,
               terminal_exit_code, terminal_reason, terminal_observed_at, session_status
        FROM routine_runs
        WHERE owner_path = ? AND routine_id = ?
        ORDER BY created_at DESC, routine_run_id DESC
        LIMIT 1
        "#,
    )
    .bind(owner_path)
    .bind(routine_id)
    .fetch_optional(pool)
    .await?;
    row.map(routine_run_from_row).transpose()
}

fn routine_run_from_row(row: sqlx::sqlite::SqliteRow) -> Result<RoutineRunRecord, AppError> {
    let terminal_status = row.try_get::<Option<String>, _>("terminal_status")?;
    Ok(RoutineRunRecord {
        routine_run_id: row.try_get("routine_run_id")?,
        routine_id: row.try_get("routine_id")?,
        owner_path: row.try_get("owner_path")?,
        launch_id: row.try_get("launch_id")?,
        pty_id: row.try_get("pty_id")?,
        source: row.try_get("source")?,
        source_session_id: row.try_get("source_session_id")?,
        agent_session_id: row.try_get("agent_session_id")?,
        created_at: row.try_get("created_at")?,
        terminal_status: terminal_status
            .as_deref()
            .and_then(RoutineRunTerminalStatus::from_str),
        terminal_exit_code: row.try_get("terminal_exit_code")?,
        terminal_reason: row.try_get("terminal_reason")?,
        terminal_observed_at: row.try_get("terminal_observed_at")?,
        session_status: row.try_get("session_status")?,
    })
}

pub(crate) struct RoutineRunLifecycleSink {
    pool: Mutex<SqlitePool>,
    db_path: PathBuf,
    routine_run_id: String,
}

impl RoutineRunLifecycleSink {
    pub(crate) fn new(pool: SqlitePool, db_path: PathBuf, routine_run_id: String) -> Self {
        Self {
            pool: Mutex::new(pool),
            db_path,
            routine_run_id,
        }
    }

    fn current_pool(&self) -> Result<SqlitePool, AppError> {
        let mut pool = self
            .pool
            .lock()
            .map_err(|_| AppError::General("routine run lifecycle pool lock poisoned".into()))?;
        if pool.is_closed() {
            let db_path = self.db_path.clone();
            *pool = tauri::async_runtime::block_on(async move {
                let pool = crate::index::db::create_pool(&db_path).await?;
                crate::index::db::ensure_schema(&pool).await?;
                Ok::<_, AppError>(pool)
            })?;
        }
        Ok(pool.clone())
    }
}

impl AgentTerminalLifecycleSink for RoutineRunLifecycleSink {
    fn record_terminal_outcome(
        &self,
        evidence: &AgentTerminalOutcomeEvidence,
    ) -> Result<(), AppError> {
        let pool = self.current_pool()?;
        let status = match evidence.status {
            AgentTerminalOutcomeStatus::Done => RoutineRunTerminalStatus::Done,
            AgentTerminalOutcomeStatus::Failed => RoutineRunTerminalStatus::Failed,
            AgentTerminalOutcomeStatus::Stopped => RoutineRunTerminalStatus::Stopped,
            AgentTerminalOutcomeStatus::Unknown => RoutineRunTerminalStatus::Unknown,
        };
        tauri::async_runtime::block_on(record_terminal_outcome(
            &pool,
            &self.routine_run_id,
            status,
            evidence.exit_code,
            &evidence.reason,
            &evidence.observed_at,
        ))
    }

    fn reconcile_agent_session(
        &self,
        source_session_id: &str,
        agent_session_id: &str,
        session_status: AgentSessionStatus,
        observed_at: &str,
    ) -> Result<(), AppError> {
        let pool = self.current_pool()?;
        let session_status = match session_status {
            AgentSessionStatus::Active => "active",
            AgentSessionStatus::Done => "done",
            AgentSessionStatus::Failed => "failed",
            AgentSessionStatus::Stopped => "stopped",
            AgentSessionStatus::Unknown => "unknown",
        };
        tauri::async_runtime::block_on(reconcile_agent_session(
            &pool,
            &self.routine_run_id,
            source_session_id,
            agent_session_id,
            session_status,
            observed_at,
        ))
    }
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
    use std::collections::HashSet;

    use tempfile::tempdir;

    use super::*;
    use crate::index::db;
    use crate::routines::model::{
        RoutineAction, RoutineDiagnostic, RoutineOwnerDescriptor, RoutineOwnerKind, RoutineTrigger,
    };

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
            last_run: None,
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

    #[tokio::test]
    async fn routine_run_mapping_survives_terminal_and_session_reconciliation() {
        let temp = tempdir().unwrap();
        let db_path = temp.path().join("index.db");
        let pool = db::create_pool(&db_path).await.unwrap();
        db::ensure_schema(&pool).await.unwrap();
        let definition = RoutineDefinition {
            title: Some("Review".into()),
            description: None,
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: "Review the backlog".into(),
        };

        create_run(
            &pool,
            NewRoutineRun {
                routine_run_id: "run-one",
                routine_id: "routine-one",
                owner_path: ".",
                trigger_type: "manual",
                definition_fingerprint: "fingerprint",
                definition: &definition,
                launch_id: "launch-one",
                source: "codex",
                source_session_id: None,
                agent_session_id: "codex:launch:launch-one",
                created_at: "2026-08-07T10:00:00Z",
            },
        )
        .await
        .unwrap();
        attach_pty(&pool, "run-one", "pty-one", "2026-08-07T10:00:01Z")
            .await
            .unwrap();

        let before = latest_run(&pool, ".", "routine-one")
            .await
            .unwrap()
            .unwrap();
        assert!(before.blocks_relaunch(&HashSet::from(["pty-one".to_string()])));

        reconcile_agent_session(
            &pool,
            "run-one",
            "source-one",
            "codex:source-one",
            "done",
            "2026-08-07T10:01:00Z",
        )
        .await
        .unwrap();
        record_terminal_outcome(
            &pool,
            "run-one",
            RoutineRunTerminalStatus::Done,
            Some(0),
            "turn complete",
            "2026-08-07T10:01:00Z",
        )
        .await
        .unwrap();

        let reconciled = latest_run(&pool, ".", "routine-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reconciled.source_session_id.as_deref(), Some("source-one"));
        assert_eq!(reconciled.agent_session_id, "codex:source-one");
        assert!(!reconciled.blocks_relaunch(&HashSet::from(["pty-one".to_string()])));
        assert_eq!(reconciled.to_ref(&HashSet::new()).launch_id, "launch-one");

        let sink = RoutineRunLifecycleSink::new(pool.clone(), db_path.clone(), "run-one".into());
        pool.close().await;
        tokio::task::spawn_blocking(move || {
            sink.reconcile_agent_session(
                "source-after-reload",
                "codex:source-after-reload",
                AgentSessionStatus::Done,
                "2026-08-07T10:02:00Z",
            )
        })
        .await
        .unwrap()
        .unwrap();

        let reopened = db::create_pool(&db_path).await.unwrap();
        db::ensure_schema(&reopened).await.unwrap();
        let after_reload = latest_run(&reopened, ".", "routine-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after_reload.source_session_id.as_deref(),
            Some("source-after-reload")
        );
        assert_eq!(after_reload.agent_session_id, "codex:source-after-reload");
    }
}
