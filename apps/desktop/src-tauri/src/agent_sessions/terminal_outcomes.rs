//! The exact outcomes of Svode terminals, saved in the project the terminal
//! is opened from so the catalogue shows them after the app starts again
//! (DF-164 R2–R4). Device-local, never in Git: the session's identity, its
//! last outcome with the reason and exit code and the second it was
//! observed, no transcript or terminal output (C8).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use svode_agents::status::SessionState;
use svode_core::agent_adapters::AgentId;

use super::cache::{cache_db_path, open_cache_pool, open_writable_cache_pool};
use crate::error::AppError;

const TABLE: &str = "terminal_outcome";

/// The last outcome a Svode terminal of a session ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SavedTerminalOutcome {
    pub agent_session_id: String,
    pub source: AgentId,
    pub source_session_id: String,
    pub launch_id: Option<String>,
    pub state: SessionState,
    pub exit_code: Option<i32>,
    pub reason: String,
    /// RFC 3339 UTC with second precision.
    pub observed_at: String,
}

/// The outcomes saved in each project before this process started, read on
/// the project's first use. Outcomes this process observes reach the
/// catalogue from its terminal surfaces, so the read is not repeated.
#[derive(Default)]
pub(crate) struct SavedTerminalOutcomes {
    projects: Mutex<HashMap<PathBuf, Vec<SavedTerminalOutcome>>>,
}

impl SavedTerminalOutcomes {
    pub(crate) fn of_project(&self, project: &Path) -> Vec<SavedTerminalOutcome> {
        let mut projects = self.projects.lock().unwrap();
        projects
            .entry(project.to_path_buf())
            .or_insert_with(|| read_outcomes(project))
            .clone()
    }
}

/// Saves the outcome as the last one of its session, in place of an earlier
/// one of the same session. A path outside a Svode project keeps it in
/// memory alone; a failed write leaves the catalogue as without it.
pub(crate) fn save_terminal_outcome(project: &Path, outcome: &SavedTerminalOutcome) {
    if !project.join(".svode").is_dir() {
        return;
    }
    if let Err(error) = write_outcome(project, outcome) {
        tracing::warn!(
            agent_session_id = outcome.agent_session_id,
            "agent terminal outcome write failed for {}: {error}",
            project.display()
        );
    }
}

fn write_outcome(project: &Path, outcome: &SavedTerminalOutcome) -> Result<(), AppError> {
    let state_json = serde_json::to_string(&outcome.state)?;
    tauri::async_runtime::block_on(async {
        let pool = open_writable_cache_pool(&cache_db_path(project)).await?;
        let result = async {
            ensure_outcome_schema(&pool).await?;
            let mut transaction = pool.begin().await?;
            // The rows of the same session under any of the keys the
            // catalogue matches a terminal by.
            sqlx::query(
                r#"
                DELETE FROM terminal_outcome
                WHERE agent_session_id = ?1
                    OR (agent = ?2 AND source_session_id = ?3 AND ?3 <> '')
                    OR (launch_id IS NOT NULL AND launch_id = ?4)
                "#,
            )
            .bind(&outcome.agent_session_id)
            .bind(outcome.source.as_str())
            .bind(&outcome.source_session_id)
            .bind(&outcome.launch_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO terminal_outcome (
                    agent_session_id, agent, source_session_id, launch_id,
                    state_json, exit_code, reason, observed_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(&outcome.agent_session_id)
            .bind(outcome.source.as_str())
            .bind(&outcome.source_session_id)
            .bind(&outcome.launch_id)
            .bind(&state_json)
            .bind(outcome.exit_code)
            .bind(&outcome.reason)
            .bind(&outcome.observed_at)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            Ok::<_, AppError>(())
        }
        .await;
        svode_core::index::db::close_pool(&pool).await;
        result
    })
}

type OutcomeRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<i32>,
    String,
    String,
);

/// The saved outcomes of the project; a missing, unreadable or damaged
/// store gives none, with a diagnostic. The read writes nothing.
fn read_outcomes(project: &Path) -> Vec<SavedTerminalOutcome> {
    let db_path = cache_db_path(project);
    if !db_path.is_file() {
        return Vec::new();
    }
    let rows = tauri::async_runtime::block_on(async {
        let pool = open_cache_pool(&db_path, false).await?;
        let rows = async {
            let saved: Option<String> = sqlx::query_scalar(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(TABLE)
            .fetch_optional(&pool)
            .await?;
            if saved.is_none() {
                return Ok(Vec::new());
            }
            Ok::<_, AppError>(
                sqlx::query_as::<_, OutcomeRow>(
                    r#"
                    SELECT agent_session_id, agent, source_session_id, launch_id,
                        state_json, exit_code, reason, observed_at
                    FROM terminal_outcome
                    "#,
                )
                .fetch_all(&pool)
                .await?,
            )
        }
        .await;
        svode_core::index::db::close_pool(&pool).await;
        rows
    });
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                "agent terminal outcomes read failed for {}: {error}",
                db_path.display()
            );
            return Vec::new();
        }
    };
    rows.into_iter()
        .filter_map(
            |(
                agent_session_id,
                agent,
                source_session_id,
                launch_id,
                state_json,
                exit_code,
                reason,
                observed_at,
            )| {
                let source = AgentId::parse(&agent).ok()?;
                let state = match serde_json::from_str(&state_json) {
                    Ok(state) => state,
                    Err(error) => {
                        tracing::warn!(
                            agent_session_id,
                            "agent terminal outcome is unreadable: {error}"
                        );
                        return None;
                    }
                };
                Some(SavedTerminalOutcome {
                    agent_session_id,
                    source,
                    source_session_id,
                    launch_id,
                    state,
                    exit_code,
                    reason,
                    observed_at,
                })
            },
        )
        .collect()
}

async fn ensure_outcome_schema(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS terminal_outcome (
            agent_session_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            launch_id TEXT,
            state_json TEXT NOT NULL,
            exit_code INTEGER,
            reason TEXT NOT NULL,
            observed_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}
