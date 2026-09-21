//! Desktop PTY lifecycle sink of a managed Routine run: it maps native terminal
//! and Agent Session evidence onto the shared operational persistence owner.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;
use svode_core::routines::operational::{reconcile_agent_session, record_terminal_outcome};

use crate::AppError;
use crate::agent_sessions::types::AgentSessionStatus;
use crate::terminal::{
    AgentTerminalLifecycleSink, AgentTerminalOutcomeEvidence, AgentTerminalOutcomeStatus,
};
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineInvalidationPayload, RoutineRunTerminalStatus,
};

pub(crate) struct RoutineRunLifecycleSink {
    pool: Mutex<SqlitePool>,
    store: Arc<svode_core::routines::store_state::RoutineStoreState>,
    key: crate::index::IndexKey,
    space_dir: PathBuf,
    routine_run_id: String,
    invalidation: Option<(tauri::AppHandle, RoutineInvalidationPayload)>,
}

impl RoutineRunLifecycleSink {
    #[cfg(test)]
    pub(crate) fn new(
        pool: SqlitePool,
        store: Arc<svode_core::routines::store_state::RoutineStoreState>,
        key: crate::index::IndexKey,
        space_dir: PathBuf,
        routine_run_id: String,
    ) -> Self {
        Self {
            pool: Mutex::new(pool),
            store,
            key,
            space_dir,
            routine_run_id,
            invalidation: None,
        }
    }

    pub(crate) fn with_invalidation(
        pool: SqlitePool,
        store: Arc<svode_core::routines::store_state::RoutineStoreState>,
        key: crate::index::IndexKey,
        space_dir: PathBuf,
        routine_run_id: String,
        app: tauri::AppHandle,
        owner: &ResolvedRoutineOwner,
    ) -> Self {
        Self {
            pool: Mutex::new(pool),
            store,
            key,
            space_dir,
            routine_run_id,
            invalidation: Some((app, RoutineInvalidationPayload::from_owner(owner))),
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
            let store = self.store.clone();
            let key = self.key.clone();
            let space_dir = self.space_dir.clone();
            *pool = tauri::async_runtime::block_on(async move {
                store.reopen_current(&key, &space_dir).await
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
mod tests {
    use std::collections::HashSet;

    use tempfile::tempdir;

    use super::*;
    use svode_core::routines::model::{RoutineAction, RoutineDefinition, RoutineTrigger};
    use svode_core::routines::operational::{
        NewRoutineRun, attach_pty, create_run, latest_run_record,
    };

    #[tokio::test]
    async fn routine_run_mapping_survives_terminal_and_session_reconciliation() {
        let temp = tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".svode")).unwrap();
        let key = crate::index::IndexKey::Root(temp.path().to_path_buf());
        let store = Arc::new(svode_core::routines::store_state::RoutineStoreState::new());
        let pool = store.get_or_create(&key, temp.path()).await.unwrap();
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
                definition_json: &serde_json::to_string(&definition).unwrap(),
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

        let before = latest_run_record(&pool, ".", "routine-one")
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

        let reconciled = latest_run_record(&pool, ".", "routine-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reconciled.source_session_id.as_deref(), Some("source-one"));
        assert_eq!(reconciled.agent_session_id, "codex:source-one");
        assert!(!reconciled.blocks_relaunch(&HashSet::from(["pty-one".to_string()])));
        assert_eq!(reconciled.to_ref(&HashSet::new()).launch_id, "launch-one");

        let sink = RoutineRunLifecycleSink::new(
            pool.clone(),
            store.clone(),
            key.clone(),
            temp.path().to_path_buf(),
            "run-one".into(),
        );
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

        let reopened = store.reopen_current(&key, temp.path()).await.unwrap();
        let after_reload = latest_run_record(&reopened, ".", "routine-one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after_reload.source_session_id.as_deref(),
            Some("source-after-reload")
        );
        assert_eq!(after_reload.agent_session_id, "codex:source-after-reload");
        assert!(
            !store
                .get_or_create(&key, temp.path())
                .await
                .unwrap()
                .is_closed()
        );
        store.close_key(&key).await;
    }
}
