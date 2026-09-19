#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use sqlx::SqlitePool;

#[cfg(test)]
use svode_core::routines::observation::reconcile_projection_from_index;

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

pub(crate) use svode_core::routines::operational::{
    QueuedRoutineEvent, activate_event, claim_local_run, finish_event, latest_remote_claim,
    next_pending_event, record_remote_claim, schedule_state, write_schedule_state,
};

pub(crate) async fn replace_owner_snapshot(
    pool: &SqlitePool,
    snapshot: &RoutineCatalogSnapshot,
) -> Result<(), AppError> {
    let rows = snapshot
        .routines
        .iter()
        .filter_map(|row| {
            row.routine_id.as_ref().map(|routine_id| {
                Ok(svode_core::routines::operational::DefinitionRow {
                    routine_id: routine_id.clone(),
                    fingerprint: row.execution_fingerprint.clone(),
                    row_json: serde_json::to_string(row)?,
                })
            })
        })
        .collect::<Result<Vec<_>, serde_json::Error>>()?;
    svode_core::routines::operational::replace_owner_snapshot(
        pool,
        &snapshot.owner.owner_path,
        snapshot.owner.kind == super::model::RoutineOwnerKind::Collection,
        &snapshot.refreshed_at,
        &rows,
    )
    .await?;
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
    svode_core::routines::operational::create_run(
        pool,
        svode_core::routines::operational::NewRoutineRun {
            routine_run_id: run.routine_run_id,
            routine_id: run.routine_id,
            owner_path: run.owner_path,
            trigger_type: run.trigger_type,
            definition_fingerprint: run.definition_fingerprint,
            definition_json: &definition_json,
            launch_id: run.launch_id,
            source: run.source,
            source_session_id: run.source_session_id,
            agent_session_id: run.agent_session_id,
            created_at: run.created_at,
        },
    )
    .await?;
    Ok(())
}

pub(crate) use svode_core::routines::operational::{
    attach_pty, reconcile_agent_session, record_terminal_outcome,
};

pub(crate) async fn latest_run(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
) -> Result<Option<RoutineRunRecord>, AppError> {
    Ok(
        svode_core::routines::operational::latest_run(pool, owner_path, routine_id)
            .await?
            .map(|row| RoutineRunRecord {
                routine_run_id: row.routine_run_id,
                routine_id: row.routine_id,
                owner_path: row.owner_path,
                launch_id: row.launch_id,
                pty_id: row.pty_id,
                source: row.source,
                source_session_id: row.source_session_id,
                agent_session_id: row.agent_session_id,
                created_at: row.created_at,
                terminal_status: row.terminal_status,
                terminal_exit_code: row.terminal_exit_code,
                terminal_reason: row.terminal_reason,
                terminal_observed_at: row.terminal_observed_at,
                session_status: row.session_status,
            }),
    )
}

pub(crate) struct RoutineRunLifecycleSink {
    pool: Mutex<SqlitePool>,
    db_path: PathBuf,
    routine_run_id: String,
    invalidation: Option<(tauri::AppHandle, super::model::RoutineInvalidationPayload)>,
}

impl RoutineRunLifecycleSink {
    #[cfg(test)]
    pub(crate) fn new(pool: SqlitePool, db_path: PathBuf, routine_run_id: String) -> Self {
        Self {
            pool: Mutex::new(pool),
            db_path,
            routine_run_id,
            invalidation: None,
        }
    }

    pub(crate) fn with_invalidation(
        pool: SqlitePool,
        db_path: PathBuf,
        routine_run_id: String,
        app: tauri::AppHandle,
        owner: &super::model::ResolvedRoutineOwner,
    ) -> Self {
        Self {
            pool: Mutex::new(pool),
            db_path,
            routine_run_id,
            invalidation: Some((
                app,
                super::model::RoutineInvalidationPayload::from_owner(owner),
            )),
        }
    }

    fn emit_invalidation(&self) {
        if let Some((app, payload)) = &self.invalidation {
            super::emit_invalidation(app, payload.clone());
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
                crate::routines::storage::reopen_current_pool(&db_path).await
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
        ))?;
        self.emit_invalidation();
        Ok(())
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
        ))?;
        self.emit_invalidation();
        Ok(())
    }
}

#[cfg(test)]
pub(crate) async fn read_owner_rows(
    pool: &SqlitePool,
    owner_path: &str,
) -> Result<Vec<RoutineRow>, AppError> {
    svode_core::routines::operational::read_owner_rows_json(pool, owner_path)
        .await?
        .into_iter()
        .map(|row| serde_json::from_str(&row).map_err(AppError::Serde))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use tempfile::tempdir;

    use super::*;
    use crate::routines::model::{
        RoutineAction, RoutineDiagnostic, RoutineOwnerDescriptor, RoutineOwnerKind, RoutineTrigger,
    };
    use crate::routines::storage;

    async fn routines_pool(path: &Path) -> SqlitePool {
        storage::open_pool(path, false).await.unwrap().pool
    }

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
            routine_id: Some(id.into()),
            portable_id: Some("01arz3ndektsv4rrffq69g5fav".into()),
            filename: format!("{id}.md"),
            path: format!("tasks/.routines/{id}.md"),
            name: id.into(),
            name_conflict: None,
            description: None,
            enabled: None,
            trigger_type: None,
            trigger_summary: None,
            action_type: None,
            action_summary: None,
            executor: None,
            last_run_at: None,
            last_run_origin: None,
            next_run_at: None,
            last_run: None,
            fingerprint: format!("fingerprint:{id}"),
            execution_fingerprint: format!("execution:{id}"),
            definition: None,
            diagnostics: Vec::new(),
        }
    }

    #[tokio::test]
    async fn owner_replace_is_transactional_and_does_not_touch_siblings() {
        let temp = tempdir().unwrap();
        let pool = routines_pool(&temp.path().join("routines.db")).await;

        replace_owner_snapshot(&pool, &snapshot("tasks", vec![row("one"), row("two")]))
            .await
            .unwrap();
        replace_owner_snapshot(&pool, &snapshot("notes", vec![row("sibling")]))
            .await
            .unwrap();
        let mut invalid = row("invalid");
        invalid.routine_id = None;
        invalid.portable_id = None;
        replace_owner_snapshot(&pool, &snapshot("tasks", vec![row("current"), invalid]))
            .await
            .unwrap();

        assert_eq!(
            read_owner_rows(&pool, "tasks")
                .await
                .unwrap()
                .into_iter()
                .map(|row| row.routine_id)
                .collect::<Vec<_>>(),
            vec![Some("current".into())]
        );
        assert_eq!(read_owner_rows(&pool, "notes").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn event_queue_is_ordered_and_one_active_per_routine() {
        let temp = tempdir().unwrap();
        let pool = routines_pool(&temp.path().join("routines.db")).await;
        for (queue_key, routine_id, entry_path, observed_at) in [
            (
                "second",
                "routine-a",
                "tasks/two.md",
                "2026-08-08T00:00:02Z",
            ),
            ("first", "routine-a", "tasks/one.md", "2026-08-08T00:00:01Z"),
            (
                "other",
                "routine-b",
                "tasks/three.md",
                "2026-08-08T00:00:03Z",
            ),
        ] {
            sqlx::query("INSERT INTO routine_event_queue (queue_key, event_key, owner_path, routine_id, definition_fingerprint, event_type, entry_path, payload_json, observed_at, state) VALUES (?, ?, 'tasks', ?, 'fp', 'collection.field_changed', ?, '{}', ?, 'pending')")
                .bind(queue_key)
                .bind(queue_key)
                .bind(routine_id)
                .bind(entry_path)
                .bind(observed_at)
                .execute(&pool)
                .await
                .unwrap();
        }

        let first = next_pending_event(&pool, "tasks").await.unwrap().unwrap();
        assert_eq!(first.queue_key, "first");
        assert!(activate_event(&pool, "first", "run-first").await.unwrap());
        let next = next_pending_event(&pool, "tasks").await.unwrap().unwrap();
        assert_eq!(next.queue_key, "other");
        finish_event(&pool, "first", "completed").await.unwrap();
        assert_eq!(
            next_pending_event(&pool, "tasks")
                .await
                .unwrap()
                .unwrap()
                .queue_key,
            "second"
        );
    }

    #[tokio::test]
    async fn routine_run_mapping_survives_terminal_and_session_reconciliation() {
        let temp = tempdir().unwrap();
        let db_path = temp.path().join("routines.db");
        let pool = routines_pool(&db_path).await;
        let definition = RoutineDefinition {
            name: Some("Review".into()),
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

        let reopened = storage::reopen_current_pool(&db_path).await.unwrap();
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

    #[tokio::test]
    async fn schedule_checkpoint_and_claim_evidence_are_durable() {
        let temp = tempdir().unwrap();
        let db_path = temp.path().join("routines.db");
        let pool = routines_pool(&db_path).await;

        write_schedule_state(
            &pool,
            ".",
            "routine-one",
            "fingerprint",
            "2026-08-07T09:00:00Z",
            "2026-08-08T09:00:00Z",
        )
        .await
        .unwrap();
        assert!(
            claim_local_run(
                &pool,
                "slot-one",
                "routine-one",
                "2026-08-07T09:00:00Z",
                "2026-08-07T09:05:00Z",
            )
            .await
            .unwrap()
        );
        assert!(
            !claim_local_run(
                &pool,
                "slot-one",
                "routine-one",
                "2026-08-07T09:00:01Z",
                "2026-08-07T09:05:01Z",
            )
            .await
            .unwrap()
        );
        record_remote_claim(
            &pool,
            ".",
            "routine-one",
            "slot-remote",
            "fingerprint",
            "device-two",
            "2026-08-07T10:00:00Z",
        )
        .await
        .unwrap();

        pool.close().await;
        let reopened = storage::reopen_current_pool(&db_path).await.unwrap();
        assert_eq!(
            schedule_state(&reopened, ".", "routine-one")
                .await
                .unwrap()
                .unwrap()
                .next_run_at,
            "2026-08-08T09:00:00Z"
        );
        assert_eq!(
            latest_remote_claim(&reopened, ".", "routine-one")
                .await
                .unwrap()
                .unwrap()
                .claimed_by,
            "device-two"
        );
    }

    #[tokio::test]
    async fn index_projection_reconciliation_preserves_operational_rows() {
        let temp = tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("tasks")).unwrap();
        std::fs::write(
            temp.path().join("tasks/schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        std::fs::write(
            temp.path().join("tasks/item.md"),
            "---\ntitle: Item\nStatus: Open\n---\n",
        )
        .unwrap();
        let index_pool = crate::index::db::create_pool(&temp.path().join("index.db"))
            .await
            .unwrap();
        crate::index::db::ensure_schema(&index_pool).await.unwrap();
        crate::index::reindex::full_reindex(&index_pool, temp.path(), &[])
            .await
            .unwrap();
        let routines_pool = routines_pool(&temp.path().join("routines.db")).await;
        replace_owner_snapshot(&routines_pool, &snapshot("tasks", vec![row("kept")]))
            .await
            .unwrap();
        sqlx::query("INSERT INTO routine_event_queue (queue_key, event_key, owner_path, routine_id, definition_fingerprint, event_type, entry_path, payload_json, observed_at, state) VALUES ('queued', 'event', 'tasks', 'kept', 'execution:kept', 'collection.entry_created', 'tasks/item.md', '{}', '2026-08-08T00:00:00Z', 'pending')")
            .execute(&routines_pool)
            .await
            .unwrap();

        reconcile_projection_from_index(&routines_pool, &index_pool, temp.path())
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_observation_baseline")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );

        sqlx::query("DELETE FROM entries")
            .execute(&index_pool)
            .await
            .unwrap();
        reconcile_projection_from_index(&routines_pool, &index_pool, temp.path())
            .await
            .unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_definitions")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_observation_baseline")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            0
        );
    }
}
