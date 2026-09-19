use sqlx::{Row, SqlitePool};

use super::model::{RoutineRunRow, RoutineRunTerminalStatus};

pub struct DefinitionRow {
    pub routine_id: String,
    pub fingerprint: String,
    pub row_json: String,
}

pub async fn replace_owner_snapshot(
    pool: &SqlitePool,
    owner_path: &str,
    is_collection: bool,
    refreshed_at: &str,
    rows: &[DefinitionRow],
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    if is_collection {
        sqlx::query("INSERT OR IGNORE INTO routine_owner_roots (owner_path) VALUES (?)")
            .bind(owner_path)
            .execute(&mut *transaction)
            .await?;
    }
    sqlx::query("DELETE FROM routine_definitions WHERE owner_path = ?")
        .bind(owner_path)
        .execute(&mut *transaction)
        .await?;
    for row in rows {
        sqlx::query(
            r#"INSERT INTO routine_definitions (
                owner_path, routine_id, fingerprint, row_json, refreshed_at
            ) VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(owner_path)
        .bind(&row.routine_id)
        .bind(&row.fingerprint)
        .bind(&row.row_json)
        .bind(refreshed_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

pub async fn read_owner_rows_json(
    pool: &SqlitePool,
    owner_path: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "SELECT row_json FROM routine_definitions WHERE owner_path = ? ORDER BY routine_id",
    )
    .bind(owner_path)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineScheduleState {
    pub definition_fingerprint: String,
    pub checkpoint_at: String,
    pub next_run_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRoutineClaim {
    pub run_key: String,
    pub claimed_by: String,
    pub claimed_at: String,
}

#[derive(Debug, Clone)]
pub struct QueuedRoutineEvent {
    pub queue_key: String,
    pub event_key: String,
    pub owner_path: String,
    pub routine_id: String,
    pub definition_fingerprint: String,
    pub payload_json: String,
}

pub async fn next_pending_event(
    pool: &SqlitePool,
    owner_path: &str,
) -> Result<Option<QueuedRoutineEvent>, sqlx::Error> {
    let row = sqlx::query(
        r#"SELECT queue_key, event_key, owner_path, routine_id,
                  definition_fingerprint, payload_json
           FROM routine_event_queue
           WHERE owner_path = ? AND state = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM routine_event_queue active
               WHERE active.owner_path = routine_event_queue.owner_path
                 AND active.routine_id = routine_event_queue.routine_id
                 AND active.state = 'active'
             )
           ORDER BY observed_at, queue_key LIMIT 1"#,
    )
    .bind(owner_path)
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(QueuedRoutineEvent {
            queue_key: row.try_get("queue_key")?,
            event_key: row.try_get("event_key")?,
            owner_path: row.try_get("owner_path")?,
            routine_id: row.try_get("routine_id")?,
            definition_fingerprint: row.try_get("definition_fingerprint")?,
            payload_json: row.try_get("payload_json")?,
        })
    })
    .transpose()
}

pub async fn activate_event(
    pool: &SqlitePool,
    queue_key: &str,
    execution_run_id: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE routine_event_queue SET state = 'active', payload_json = json_set(payload_json, '$.executionRunId', ?) WHERE queue_key = ? AND state = 'pending'",
    )
    .bind(execution_run_id)
    .bind(queue_key)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn finish_event(
    pool: &SqlitePool,
    queue_key: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    debug_assert!(matches!(state, "completed" | "failed" | "pending"));
    sqlx::query("UPDATE routine_event_queue SET state = ? WHERE queue_key = ?")
        .bind(state)
        .bind(queue_key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn schedule_state(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
) -> Result<Option<RoutineScheduleState>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT definition_fingerprint, checkpoint_at, next_run_at FROM routine_schedule_state WHERE owner_path = ? AND routine_id = ?",
    )
    .bind(owner_path)
    .bind(routine_id)
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(RoutineScheduleState {
            definition_fingerprint: row.try_get("definition_fingerprint")?,
            checkpoint_at: row.try_get("checkpoint_at")?,
            next_run_at: row.try_get("next_run_at")?,
        })
    })
    .transpose()
}

pub async fn write_schedule_state(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
    definition_fingerprint: &str,
    checkpoint_at: &str,
    next_run_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO routine_schedule_state (
            owner_path, routine_id, definition_fingerprint, checkpoint_at, next_run_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_path, routine_id) DO UPDATE SET
            definition_fingerprint = excluded.definition_fingerprint,
            checkpoint_at = excluded.checkpoint_at,
            next_run_at = excluded.next_run_at
        "#,
    )
    .bind(owner_path)
    .bind(routine_id)
    .bind(definition_fingerprint)
    .bind(checkpoint_at)
    .bind(next_run_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn claim_local_run(
    pool: &SqlitePool,
    run_key: &str,
    routine_id: &str,
    leased_at: &str,
    expires_at: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "INSERT OR IGNORE INTO routine_automatic_leases (run_key, routine_id, leased_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(run_key)
    .bind(routine_id)
    .bind(leased_at)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn record_remote_claim(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
    run_key: &str,
    definition_fingerprint: &str,
    claimed_by: &str,
    claimed_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO routine_remote_claims (
            run_key, owner_path, routine_id, definition_fingerprint, claimed_by, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(run_key)
    .bind(owner_path)
    .bind(routine_id)
    .bind(definition_fingerprint)
    .bind(claimed_by)
    .bind(claimed_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn latest_remote_claim(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
) -> Result<Option<RemoteRoutineClaim>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT run_key, claimed_by, claimed_at
        FROM routine_remote_claims
        WHERE owner_path = ? AND routine_id = ?
        ORDER BY claimed_at DESC, run_key DESC
        LIMIT 1
        "#,
    )
    .bind(owner_path)
    .bind(routine_id)
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(RemoteRoutineClaim {
            run_key: row.try_get("run_key")?,
            claimed_by: row.try_get("claimed_by")?,
            claimed_at: row.try_get("claimed_at")?,
        })
    })
    .transpose()
}

#[derive(Debug, Clone)]
pub struct NewRoutineRun<'a> {
    pub routine_run_id: &'a str,
    pub routine_id: &'a str,
    pub owner_path: &'a str,
    pub trigger_type: &'a str,
    pub definition_fingerprint: &'a str,
    pub definition_json: &'a str,
    pub launch_id: &'a str,
    pub source: &'a str,
    pub source_session_id: Option<&'a str>,
    pub agent_session_id: &'a str,
    pub created_at: &'a str,
}

pub async fn create_run(pool: &SqlitePool, run: NewRoutineRun<'_>) -> Result<(), sqlx::Error> {
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
    .bind(run.definition_json)
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

pub async fn attach_pty(
    pool: &SqlitePool,
    routine_run_id: &str,
    pty_id: &str,
    observed_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE routine_runs SET pty_id = ?, updated_at = ? WHERE routine_run_id = ?")
        .bind(pty_id)
        .bind(observed_at)
        .bind(routine_run_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn record_terminal_outcome(
    pool: &SqlitePool,
    routine_run_id: &str,
    status: RoutineRunTerminalStatus,
    exit_code: Option<i32>,
    reason: &str,
    observed_at: &str,
) -> Result<(), sqlx::Error> {
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

pub async fn reconcile_agent_session(
    pool: &SqlitePool,
    routine_run_id: &str,
    source_session_id: &str,
    agent_session_id: &str,
    session_status: &str,
    observed_at: &str,
) -> Result<(), sqlx::Error> {
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

pub async fn latest_run(
    pool: &SqlitePool,
    owner_path: &str,
    routine_id: &str,
) -> Result<Option<RoutineRunRow>, sqlx::Error> {
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

fn routine_run_from_row(row: sqlx::sqlite::SqliteRow) -> Result<RoutineRunRow, sqlx::Error> {
    let terminal_status = row.try_get::<Option<String>, _>("terminal_status")?;
    Ok(RoutineRunRow {
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
