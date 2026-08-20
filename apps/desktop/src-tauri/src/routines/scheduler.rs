use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use tauri::{AppHandle, Manager};

use super::authority;
use super::cache;
use super::commands;
use super::model::{
    ResolvedRoutineOwner, RoutineDefinition, RoutineDispatchBlockedCode,
    RoutineManualDispatchResult, RoutineTrigger,
};
use crate::AppError;
use crate::git::access::{
    RepositoryAccessState, RepositoryAccessStatus, RoutineClaimResult, access_store_path,
    require_repository_mutation_paths,
};
use crate::git::commands::{GitState, require_cli};
use crate::index::{IndexKey, IndexState};
use crate::terminal::TerminalManager;

const SCHEDULER_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct RoutineSchedulerState {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl RoutineSchedulerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_project(&self, app: AppHandle, project_id: String, project_path: PathBuf) {
        self.stop_project(&project_id);
        let task_project_id = project_id.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(SCHEDULER_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = tick_project(&app, &task_project_id, &project_path).await {
                    tracing::warn!(
                        project_id = %task_project_id,
                        "routine scheduler tick failed: {error}"
                    );
                }
            }
        });
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.insert(project_id, task);
        }
    }

    pub fn stop_project(&self, project_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock()
            && let Some(task) = tasks.remove(project_id)
        {
            task.abort();
        }
    }
}

async fn tick_project(
    app: &AppHandle,
    project_id: &str,
    project_path: &Path,
) -> Result<(), AppError> {
    let index_state = app.state::<IndexState>();
    let root_pool = index_state
        .get_or_create(&IndexKey::Root(project_path.to_path_buf()))
        .await?;
    if let Err(error) =
        authority::migrate_legacy_for_project(&root_pool, &index_state, project_path).await
    {
        tracing::warn!(
            project_id = %project_id,
            "routine automatic authority migration failed closed: {error}"
        );
    }
    let owners = authority::discover_project_owners(&index_state, project_path).await?;
    for owner in owners {
        if let Err(error) = tick_owner(app, &owner, &root_pool).await {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "routine schedule owner tick failed: {error}"
            );
        }
    }
    Ok(())
}

async fn tick_owner(
    app: &AppHandle,
    owner: &ResolvedRoutineOwner,
    authority_pool: &sqlx::SqlitePool,
) -> Result<(), AppError> {
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    let pool = index_state.get_or_create(&owner.index_key).await?;
    let automatic_authority = match authority::read(authority_pool, owner).await {
        Ok(enabled) => enabled,
        Err(error) => {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "routine automatic authority read failed closed: {error}"
            );
            false
        }
    };
    dispatch_next_event(app, owner, automatic_authority, &pool).await?;
    let snapshot = commands::discover_owner(owner).await?;
    let live_pty_ids = commands::live_agent_pty_ids(&terminal_manager)?;
    let now = Utc::now();

    for row in snapshot.routines {
        if !row.diagnostics.is_empty()
            || row
                .definition
                .as_ref()
                .is_none_or(|value| value.enabled != Some(true))
        {
            continue;
        }
        let Some(RoutineDefinition {
            trigger:
                RoutineTrigger::Schedule {
                    cron,
                    timezone,
                    missed_runs,
                },
            ..
        }) = row.definition.as_ref()
        else {
            continue;
        };

        let state =
            cache::schedule_state(&pool, &owner.descriptor.owner_path, &row.routine_id).await?;
        let Some(state) = state.filter(|state| state.definition_fingerprint == row.fingerprint)
        else {
            write_baseline(
                app,
                &pool,
                owner,
                &row.routine_id,
                &row.fingerprint,
                cron,
                timezone,
                now,
            )
            .await?;
            continue;
        };
        let Ok(checkpoint) = DateTime::parse_from_rfc3339(&state.checkpoint_at)
            .map(|value| value.with_timezone(&Utc))
        else {
            write_baseline(
                app,
                &pool,
                owner,
                &row.routine_id,
                &row.fingerprint,
                cron,
                timezone,
                now,
            )
            .await?;
            continue;
        };
        let evaluation = super::schedule::evaluate(cron, timezone, checkpoint, now, *missed_runs)
            .map_err(AppError::General)?;
        if !evaluation.had_occurrence {
            continue;
        }

        if !automatic_authority {
            continue;
        }
        if let Some(run) =
            cache::latest_run(&pool, &owner.descriptor.owner_path, &row.routine_id).await?
            && run.blocks_relaunch(&live_pty_ids)
        {
            advance_checkpoint(
                app,
                &pool,
                owner,
                &row.routine_id,
                &row.fingerprint,
                now,
                evaluation.next_at,
            )
            .await?;
            continue;
        }
        if !commands::scheduled_dispatch_ready(
            owner,
            row.definition.as_ref().expect("validated definition"),
        )
        .await
        {
            continue;
        }

        let repository = commands::mutation_repository(&app.state::<GitState>(), owner).await?;
        let git_state = app.state::<GitState>();
        let cli = require_cli(&git_state)?;
        let access_state = app.state::<RepositoryAccessState>();
        let store_path = access_store_path(app)?;
        let access = access_state
            .snapshot(&cli, &repository, &store_path)
            .await?;
        if !matches!(
            access.status,
            RepositoryAccessStatus::Local | RepositoryAccessStatus::Writable
        ) {
            continue;
        }

        let Some(due_at) = evaluation.due_at else {
            advance_checkpoint(
                app,
                &pool,
                owner,
                &row.routine_id,
                &row.fingerprint,
                now,
                evaluation.next_at,
            )
            .await?;
            continue;
        };
        let Some(repository_id) = access_state
            .routine_repository_id(&cli, &repository, &access)
            .await?
        else {
            continue;
        };
        let run_key = scheduled_run_key(&repository_id, &row.routine_id, due_at);
        let claim_time = now.timestamp();
        let claim = access_state
            .claim_routine(
                &cli,
                &repository,
                &store_path,
                &access,
                &row.routine_id,
                &run_key,
                &row.fingerprint,
                claim_time,
            )
            .await?;
        let should_dispatch = match claim {
            RoutineClaimResult::Local => {
                let leased_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
                let expires_at =
                    (now + TimeDelta::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true);
                cache::claim_local_run(&pool, &run_key, &row.routine_id, &leased_at, &expires_at)
                    .await?
            }
            RoutineClaimResult::Claimed {
                claimed_by,
                claimed_at,
            } => {
                record_claim(
                    app,
                    &pool,
                    owner,
                    &row.routine_id,
                    &run_key,
                    &row.fingerprint,
                    &claimed_by,
                    claimed_at,
                )
                .await?;
                true
            }
            RoutineClaimResult::AlreadyClaimed {
                claimed_by,
                claimed_at,
            } => {
                record_claim(
                    app,
                    &pool,
                    owner,
                    &row.routine_id,
                    &run_key,
                    &row.fingerprint,
                    &claimed_by,
                    claimed_at,
                )
                .await?;
                false
            }
            RoutineClaimResult::Unavailable { reason } => {
                tracing::debug!(?reason, routine_id = %row.routine_id, "routine claim unavailable");
                continue;
            }
        };
        advance_checkpoint(
            app,
            &pool,
            owner,
            &row.routine_id,
            &row.fingerprint,
            now,
            evaluation.next_at,
        )
        .await?;
        if !should_dispatch {
            continue;
        }
        match commands::dispatch_scheduled(app, owner.clone(), row.routine_id.clone()).await? {
            RoutineManualDispatchResult::Blocked {
                code: RoutineDispatchBlockedCode::RepositoryAccessDenied,
                message,
                ..
            } => {
                tracing::warn!(routine_id = %row.routine_id, "scheduled routine lost eligibility after claim: {message}")
            }
            RoutineManualDispatchResult::Blocked { message, .. }
            | RoutineManualDispatchResult::Failed { message, .. } => {
                tracing::warn!(routine_id = %row.routine_id, "scheduled routine dispatch did not start: {message}")
            }
            RoutineManualDispatchResult::Started { .. }
            | RoutineManualDispatchResult::Focused { .. } => {}
        }
    }
    Ok(())
}

async fn dispatch_next_event(
    app: &AppHandle,
    owner: &ResolvedRoutineOwner,
    consent: bool,
    pool: &sqlx::SqlitePool,
) -> Result<(), AppError> {
    if !consent {
        return Ok(());
    }
    let Some(event) = cache::next_pending_event(pool, &owner.descriptor.owner_path).await? else {
        return Ok(());
    };
    let terminal_manager = app.state::<TerminalManager>();
    let live_pty_ids = commands::live_agent_pty_ids(&terminal_manager)?;
    if let Some(run) = cache::latest_run(pool, &event.owner_path, &event.routine_id).await?
        && run.blocks_relaunch(&live_pty_ids)
    {
        return Ok(());
    }
    let Some(preflight) = commands::event_dispatch_preflight(owner, &event).await else {
        cache::finish_event(pool, &event.queue_key, "failed").await?;
        return Ok(());
    };
    if let commands::EventDispatchPreflight::UpdateProperties { mutation_paths } = &preflight
        && let Err(error) = require_repository_mutation_paths(app, mutation_paths.clone()).await
    {
        tracing::debug!(
            routine_id = %event.routine_id,
            "event property mutation access is not ready: {error}"
        );
        return Ok(());
    }

    let repository = commands::mutation_repository(&app.state::<GitState>(), owner).await?;
    let git_state = app.state::<GitState>();
    let cli = require_cli(&git_state)?;
    let access_state = app.state::<RepositoryAccessState>();
    let store_path = access_store_path(app)?;
    let access = access_state
        .snapshot(&cli, &repository, &store_path)
        .await?;
    if !matches!(
        access.status,
        RepositoryAccessStatus::Local | RepositoryAccessStatus::Writable
    ) {
        return Ok(());
    }
    let Some(repository_id) = access_state
        .routine_repository_id(&cli, &repository, &access)
        .await?
    else {
        return Ok(());
    };
    let run_key = event_run_key(&repository_id, &event.routine_id, &event.event_key);
    let now = Utc::now();
    let claim = access_state
        .claim_routine(
            &cli,
            &repository,
            &store_path,
            &access,
            &event.routine_id,
            &run_key,
            &event.definition_fingerprint,
            now.timestamp(),
        )
        .await?;
    let should_dispatch = match claim {
        RoutineClaimResult::Local => {
            cache::claim_local_run(
                pool,
                &run_key,
                &event.routine_id,
                &now.to_rfc3339_opts(SecondsFormat::Secs, true),
                &(now + TimeDelta::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true),
            )
            .await?
        }
        RoutineClaimResult::Claimed {
            claimed_by,
            claimed_at,
        } => {
            record_claim(
                app,
                pool,
                owner,
                &event.routine_id,
                &run_key,
                &event.definition_fingerprint,
                &claimed_by,
                claimed_at,
            )
            .await?;
            true
        }
        RoutineClaimResult::AlreadyClaimed {
            claimed_by,
            claimed_at,
        } => {
            record_claim(
                app,
                pool,
                owner,
                &event.routine_id,
                &run_key,
                &event.definition_fingerprint,
                &claimed_by,
                claimed_at,
            )
            .await?;
            false
        }
        RoutineClaimResult::Unavailable { .. } => return Ok(()),
    };
    if !should_dispatch {
        cache::finish_event(pool, &event.queue_key, "completed").await?;
        return Ok(());
    }
    let execution_run_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
    if !cache::activate_event(pool, &event.queue_key, &execution_run_id).await? {
        return Ok(());
    }
    let result =
        commands::dispatch_event(app, owner.clone(), event.clone(), execution_run_id).await;
    let state = match &result {
        Ok(RoutineManualDispatchResult::Started { .. })
        | Ok(RoutineManualDispatchResult::Focused { .. }) => "completed",
        Ok(RoutineManualDispatchResult::Blocked { message, .. })
        | Ok(RoutineManualDispatchResult::Failed { message, .. }) => {
            tracing::warn!(routine_id = %event.routine_id, "event routine failed: {message}");
            "failed"
        }
        Err(error) => {
            tracing::warn!(routine_id = %event.routine_id, "event routine dispatch failed: {error}");
            "failed"
        }
    };
    cache::finish_event(pool, &event.queue_key, state).await?;
    result.map(|_| ())
}

fn event_run_key(repository_id: &str, routine_id: &str, event_key: &str) -> String {
    let value = format!("{repository_id}\0{routine_id}\0{event_key}");
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("event-{hash:016x}")
}

async fn write_baseline(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    fingerprint: &str,
    cron: &str,
    timezone: &str,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    let next = super::schedule::next_after(cron, timezone, now).map_err(AppError::General)?;
    advance_checkpoint(app, pool, owner, routine_id, fingerprint, now, next).await
}

async fn advance_checkpoint(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    fingerprint: &str,
    checkpoint: DateTime<Utc>,
    next: DateTime<Utc>,
) -> Result<(), AppError> {
    cache::write_schedule_state(
        pool,
        &owner.descriptor.owner_path,
        routine_id,
        fingerprint,
        &checkpoint.to_rfc3339_opts(SecondsFormat::Secs, true),
        &next.to_rfc3339_opts(SecondsFormat::Secs, true),
    )
    .await?;
    super::emit_owner_invalidation(app, owner);
    Ok(())
}

async fn record_claim(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    run_key: &str,
    fingerprint: &str,
    claimed_by: &str,
    claimed_at: i64,
) -> Result<(), AppError> {
    let claimed_at = DateTime::<Utc>::from_timestamp(claimed_at, 0)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let previous =
        cache::latest_remote_claim(pool, &owner.descriptor.owner_path, routine_id).await?;
    cache::record_remote_claim(
        pool,
        &owner.descriptor.owner_path,
        routine_id,
        run_key,
        fingerprint,
        claimed_by,
        &claimed_at,
    )
    .await?;
    if previous.as_ref().is_none_or(|previous| {
        previous.run_key != run_key
            || previous.claimed_by != claimed_by
            || previous.claimed_at != claimed_at
    }) {
        super::emit_owner_invalidation(app, owner);
    }
    Ok(())
}

fn scheduled_run_key(repository_id: &str, routine_id: &str, due_at: DateTime<Utc>) -> String {
    let value = format!(
        "{repository_id}\0{routine_id}\0{}",
        due_at.to_rfc3339_opts(SecondsFormat::Secs, true)
    );
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("schedule-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_keys_are_stable_and_slot_specific() {
        let first = scheduled_run_key(
            "repo-1",
            "routine-1",
            "2026-08-07T09:00:00Z".parse().unwrap(),
        );
        assert_eq!(
            first,
            scheduled_run_key(
                "repo-1",
                "routine-1",
                "2026-08-07T09:00:00Z".parse().unwrap()
            )
        );
        assert_ne!(
            first,
            scheduled_run_key(
                "repo-1",
                "routine-1",
                "2026-08-08T09:00:00Z".parse().unwrap()
            )
        );
    }
}
