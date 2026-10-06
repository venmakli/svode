use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use tauri::{AppHandle, Manager};

use super::dispatch::{self, EventDispatchPreflight};
use super::host;
use crate::AppError;
use crate::git::access::{
    RepositoryAccessSnapshot, RepositoryAccessState, RepositoryAccessStatus, RoutineClaimResult,
    access_store_path, require_repository_mutation_paths,
};
use crate::git::{GitState, require_cli};
use crate::routines::RoutineStoreState;
use crate::terminal::TerminalManager;
use svode_core::git::cli::GitCli;
use svode_core::routines::dispatch::{event_run_key, schedule_candidates, scheduled_run_key};
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineDefinition, RoutineDispatchBlockedCode, RoutineDispatchResult,
    RoutineLiveEvidence,
};
use svode_core::routines::operational::{
    QueuedRoutineEvent, activate_event, claim_local_run, finish_event, latest_remote_claim,
    latest_run_record, next_pending_event, record_remote_claim, schedule_state,
    write_schedule_state,
};
use svode_core::routines::schedule;
use svode_core::routines::store_state::RoutineStoreState as RoutineStores;
use svode_core::routines::{authority, service};

const SCHEDULER_INTERVAL: Duration = Duration::from_secs(60);

/// The Routine schedulers of the projects in the registry (Stage 10 `09`,
/// Routines of every project): one per listed project from the launch of
/// Desktop until exit, whether a window has the project open or not.
/// Windows binding, releasing or switching their project do not touch them.
#[derive(Default)]
pub struct RoutineSchedulerState {
    projects: Mutex<HashMap<String, ProjectScheduler>>,
}

struct ProjectScheduler {
    path: PathBuf,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl RoutineSchedulerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Brings the schedulers in line with the project registry: a project
    /// added to the list gets one, a project no longer listed loses its own
    /// along with its operational stores.
    pub fn sync(&self, app: &AppHandle) {
        let config_dir = match app.path().app_config_dir() {
            Ok(config_dir) => config_dir,
            Err(error) => {
                tracing::warn!("routine schedulers cannot read the project list: {error}");
                return;
            }
        };
        let listed = match crate::space::registry::read_registry(&config_dir) {
            Ok(registry) => registry
                .spaces
                .into_iter()
                .map(|project| (project.id, PathBuf::from(project.path)))
                .collect(),
            Err(error) => {
                tracing::warn!("routine schedulers cannot read the project list: {error}");
                return;
            }
        };
        let removed = self.sync_projects(listed, |path| spawn_project(app.clone(), path));
        for path in removed {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { close_stores(&app, &path).await });
        }
    }

    /// Starts a scheduler for each listed project without one and stops the
    /// schedulers of the others; returns the paths of the stopped ones.
    fn sync_projects(
        &self,
        listed: Vec<(String, PathBuf)>,
        mut start: impl FnMut(PathBuf) -> tauri::async_runtime::JoinHandle<()>,
    ) -> Vec<PathBuf> {
        let mut projects = self
            .projects
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut stopped = Vec::new();
        projects.retain(|id, scheduler| {
            let kept = listed
                .iter()
                .any(|(listed_id, path)| listed_id == id && *path == scheduler.path);
            if !kept {
                scheduler.task.abort();
                stopped.push(scheduler.path.clone());
            }
            kept
        });
        for (id, path) in listed {
            projects.entry(id).or_insert_with(|| ProjectScheduler {
                task: start(path.clone()),
                path,
            });
        }
        stopped
    }

    /// Stops the scheduler of a project leaving the list and closes its
    /// operational stores before its files are removed.
    pub async fn remove_project(&self, app: &AppHandle, project_id: &str, project_path: &Path) {
        self.stop_project(project_id);
        close_stores(app, project_path).await;
    }

    fn stop_project(&self, project_id: &str) {
        if let Some(scheduler) = self
            .projects
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(project_id)
        {
            scheduler.task.abort();
        }
    }

    /// Stops every scheduler at exit, before the runtimes it launches into.
    pub fn stop_all(&self) {
        let projects = std::mem::take(
            &mut *self
                .projects
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for scheduler in projects.into_values() {
            scheduler.task.abort();
        }
    }
}

fn spawn_project(app: AppHandle, project_path: PathBuf) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let host = AppSchedulerHost { app };
        let mut interval = tokio::time::interval(SCHEDULER_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = tick_project(&host, &project_path).await {
                tracing::warn!(
                    project = %project_path.display(),
                    "routine scheduler tick failed: {error}"
                );
            }
        }
    })
}

/// Closes the operational stores of a project, opened under its registered
/// or its canonical path.
async fn close_stores(app: &AppHandle, project_path: &Path) {
    let stores = app.state::<Arc<RoutineStoreState>>();
    stores.close_project(project_path).await;
    if let Ok(canonical) = std::fs::canonicalize(project_path)
        && canonical != project_path
    {
        stores.close_project(&canonical).await;
    }
}

/// Host effects of a scheduler tick: execution evidence, repository access
/// and claims, dispatch and window invalidation.
trait SchedulerHost {
    /// Repository the claims of an owner go to, with its access evidence.
    type Gate: Send + Sync;

    fn routine_stores(&self) -> &RoutineStores;

    fn live_evidence(&self) -> Result<RoutineLiveEvidence, AppError>;

    async fn dispatch_ready(
        &self,
        owner: &ResolvedRoutineOwner,
        definition: &RoutineDefinition,
    ) -> bool;

    async fn event_preflight(
        &self,
        owner: &ResolvedRoutineOwner,
        event: &QueuedRoutineEvent,
    ) -> Option<EventDispatchPreflight>;

    async fn mutation_paths_ready(&self, paths: Vec<PathBuf>) -> bool;

    /// `None` while the repository is neither local nor writable.
    async fn repository_gate(
        &self,
        owner: &ResolvedRoutineOwner,
    ) -> Result<Option<Self::Gate>, AppError>;

    /// The run key built from the repository identity and its claim; `None`
    /// while the repository has no identity for claims.
    async fn claim(
        &self,
        gate: &Self::Gate,
        routine_id: &str,
        fingerprint: &str,
        claim_time: i64,
        run_key: impl FnOnce(&str) -> String + Send,
    ) -> Result<Option<(String, RoutineClaimResult)>, AppError>;

    async fn dispatch_scheduled(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
    ) -> Result<RoutineDispatchResult, AppError>;

    async fn dispatch_event(
        &self,
        owner: ResolvedRoutineOwner,
        event: QueuedRoutineEvent,
        execution_run_id: String,
    ) -> Result<RoutineDispatchResult, AppError>;

    fn invalidate(&self, owner: &ResolvedRoutineOwner);
}

struct AppSchedulerHost {
    app: AppHandle,
}

struct RepositoryGate {
    cli: GitCli,
    repository: PathBuf,
    store_path: PathBuf,
    access: RepositoryAccessSnapshot,
}

impl SchedulerHost for AppSchedulerHost {
    type Gate = RepositoryGate;

    fn routine_stores(&self) -> &RoutineStores {
        self.app.state::<Arc<RoutineStoreState>>().inner().core()
    }

    fn live_evidence(&self) -> Result<RoutineLiveEvidence, AppError> {
        super::runtime::live_evidence(
            &self.app.state::<TerminalManager>(),
            &self.app.state::<super::RoutineAcpLaunches>(),
        )
    }

    async fn dispatch_ready(
        &self,
        owner: &ResolvedRoutineOwner,
        definition: &RoutineDefinition,
    ) -> bool {
        dispatch::scheduled_dispatch_ready(owner, definition).await
    }

    async fn event_preflight(
        &self,
        owner: &ResolvedRoutineOwner,
        event: &QueuedRoutineEvent,
    ) -> Option<EventDispatchPreflight> {
        dispatch::event_dispatch_preflight(owner, event).await
    }

    async fn mutation_paths_ready(&self, paths: Vec<PathBuf>) -> bool {
        match require_repository_mutation_paths(&self.app, paths).await {
            Ok(_) => true,
            Err(error) => {
                tracing::debug!("event property mutation access is not ready: {error}");
                false
            }
        }
    }

    async fn repository_gate(
        &self,
        owner: &ResolvedRoutineOwner,
    ) -> Result<Option<RepositoryGate>, AppError> {
        let git_state = self.app.state::<GitState>();
        let repository = host::mutation_repository(&git_state, owner).await?;
        let cli = require_cli(&git_state)?;
        let store_path = access_store_path(&self.app)?;
        let access = self
            .app
            .state::<RepositoryAccessState>()
            .snapshot(&cli, &repository, &store_path)
            .await?;
        Ok(matches!(
            access.status,
            RepositoryAccessStatus::Local | RepositoryAccessStatus::Writable
        )
        .then_some(RepositoryGate {
            cli,
            repository,
            store_path,
            access,
        }))
    }

    async fn claim(
        &self,
        gate: &RepositoryGate,
        routine_id: &str,
        fingerprint: &str,
        claim_time: i64,
        run_key: impl FnOnce(&str) -> String + Send,
    ) -> Result<Option<(String, RoutineClaimResult)>, AppError> {
        let access_state = self.app.state::<RepositoryAccessState>();
        let Some(repository_id) = access_state
            .routine_repository_id(&gate.cli, &gate.repository, &gate.access)
            .await?
        else {
            return Ok(None);
        };
        let run_key = run_key(&repository_id);
        let claim = access_state
            .claim_routine(
                &gate.cli,
                &gate.repository,
                &gate.store_path,
                &gate.access,
                routine_id,
                &run_key,
                fingerprint,
                claim_time,
            )
            .await?;
        Ok(Some((run_key, claim)))
    }

    async fn dispatch_scheduled(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
    ) -> Result<RoutineDispatchResult, AppError> {
        dispatch::dispatch_scheduled(&self.app, owner, routine_id).await
    }

    async fn dispatch_event(
        &self,
        owner: ResolvedRoutineOwner,
        event: QueuedRoutineEvent,
        execution_run_id: String,
    ) -> Result<RoutineDispatchResult, AppError> {
        dispatch::dispatch_event(&self.app, owner, event, execution_run_id).await
    }

    fn invalidate(&self, owner: &ResolvedRoutineOwner) {
        super::emit_owner_invalidation(&self.app, owner);
    }
}

/// One check of a project, with or without a window: its owners come from
/// its config and operational stores, never from an index runtime. A
/// project whose folder is unavailable is skipped until it is back.
async fn tick_project<H: SchedulerHost>(host: &H, project_path: &Path) -> Result<(), AppError> {
    if !project_path.join(".svode").join("config.json").is_file() {
        tracing::debug!(
            project = %project_path.display(),
            "routine scheduler skips a project whose folder is unavailable"
        );
        return Ok(());
    }
    let owners = service::discover_project_owners(host.routine_stores(), project_path).await?;
    for owner in owners {
        if let Err(error) = tick_owner(host, &owner).await {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "routine schedule owner tick failed: {error}"
            );
        }
    }
    Ok(())
}

async fn tick_owner<H: SchedulerHost>(
    host: &H,
    owner: &ResolvedRoutineOwner,
) -> Result<(), AppError> {
    let pool = host
        .routine_stores()
        .get_or_create(&owner.index_key, &owner.space_path)
        .await?;
    let automatic_authority = match authority::read_key(&owner.space_path, &owner.identity()) {
        Ok(enabled) => enabled,
        Err(error) => {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "routine automatic authority read failed closed: {error}"
            );
            false
        }
    };
    dispatch_next_event(host, owner, automatic_authority, &pool).await?;
    let snapshot = service::discover_owner(owner).await?;
    let live = host.live_evidence()?;
    let now = Utc::now();

    for candidate in schedule_candidates(&snapshot) {
        let routine_id = candidate.routine_id.as_str();
        let cron = candidate.cron.as_str();
        let time_basis = &candidate.time_basis;
        let missed_runs = &candidate.missed_runs;

        let state = schedule_state(&pool, &owner.descriptor.owner_path, routine_id).await?;
        let Some(state) =
            state.filter(|state| state.definition_fingerprint == candidate.execution_fingerprint)
        else {
            if let Err(error) = write_baseline(
                host,
                &pool,
                owner,
                routine_id,
                &candidate.execution_fingerprint,
                cron,
                time_basis,
                now,
            )
            .await
            {
                tracing::warn!(
                    routine_id,
                    "routine schedule baseline failed closed: {error}"
                );
            }
            continue;
        };
        let Ok(checkpoint) = DateTime::parse_from_rfc3339(&state.checkpoint_at)
            .map(|value| value.with_timezone(&Utc))
        else {
            if let Err(error) = write_baseline(
                host,
                &pool,
                owner,
                routine_id,
                &candidate.execution_fingerprint,
                cron,
                time_basis,
                now,
            )
            .await
            {
                tracing::warn!(
                    routine_id,
                    "routine schedule baseline failed closed: {error}"
                );
            }
            continue;
        };
        let evaluation = match schedule::evaluate(cron, time_basis, checkpoint, now, *missed_runs) {
            Ok(evaluation) => evaluation,
            Err(error) => {
                tracing::warn!(
                    routine_id,
                    "routine schedule evaluation failed closed: {error}"
                );
                continue;
            }
        };
        if !evaluation.had_occurrence {
            let next = evaluation
                .next_at
                .to_rfc3339_opts(SecondsFormat::Secs, true);
            if next != state.next_run_at {
                write_schedule_state(
                    &pool,
                    &owner.descriptor.owner_path,
                    routine_id,
                    &candidate.execution_fingerprint,
                    &state.checkpoint_at,
                    &next,
                )
                .await?;
                host.invalidate(owner);
            }
            continue;
        }

        if !automatic_authority {
            continue;
        }
        if let Some(run) =
            latest_run_record(&pool, &owner.descriptor.owner_path, routine_id).await?
            && run.blocks_relaunch(&live)
        {
            advance_checkpoint(
                host,
                &pool,
                owner,
                routine_id,
                &candidate.execution_fingerprint,
                now,
                evaluation.next_at,
            )
            .await?;
            continue;
        }
        if !host.dispatch_ready(owner, &candidate.definition).await {
            continue;
        }
        let Some(gate) = host.repository_gate(owner).await? else {
            continue;
        };

        let Some(due) = evaluation.due else {
            advance_checkpoint(
                host,
                &pool,
                owner,
                routine_id,
                &candidate.execution_fingerprint,
                now,
                evaluation.next_at,
            )
            .await?;
            continue;
        };
        let Some((run_key, claim)) = host
            .claim(
                &gate,
                routine_id,
                &candidate.execution_fingerprint,
                now.timestamp(),
                |repository_id| {
                    scheduled_run_key(
                        repository_id,
                        routine_id,
                        &time_basis.identity(),
                        &due.nominal_civil_time,
                    )
                },
            )
            .await?
        else {
            continue;
        };
        let should_dispatch = match claim {
            RoutineClaimResult::Local => {
                let leased_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
                let expires_at =
                    (now + TimeDelta::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true);
                claim_local_run(&pool, &run_key, routine_id, &leased_at, &expires_at).await?
            }
            RoutineClaimResult::Claimed {
                claimed_by,
                claimed_at,
            } => {
                record_claim(
                    host,
                    &pool,
                    owner,
                    routine_id,
                    &run_key,
                    &candidate.execution_fingerprint,
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
                    host,
                    &pool,
                    owner,
                    routine_id,
                    &run_key,
                    &candidate.execution_fingerprint,
                    &claimed_by,
                    claimed_at,
                )
                .await?;
                false
            }
            RoutineClaimResult::Unavailable { reason } => {
                tracing::debug!(?reason, routine_id, "routine claim unavailable");
                continue;
            }
        };
        advance_checkpoint(
            host,
            &pool,
            owner,
            routine_id,
            &candidate.execution_fingerprint,
            now,
            evaluation.next_at,
        )
        .await?;
        if !should_dispatch {
            continue;
        }
        match host
            .dispatch_scheduled(owner.clone(), routine_id.to_string())
            .await?
        {
            RoutineDispatchResult::Blocked {
                code: RoutineDispatchBlockedCode::RepositoryAccessDenied,
                message,
                ..
            } => {
                tracing::warn!(
                    routine_id,
                    "scheduled routine lost eligibility after claim: {message}"
                )
            }
            RoutineDispatchResult::Blocked { message, .. }
            | RoutineDispatchResult::Failed { message, .. } => {
                tracing::warn!(
                    routine_id,
                    "scheduled routine dispatch did not start: {message}"
                )
            }
            RoutineDispatchResult::Started { .. }
            | RoutineDispatchResult::AlreadyRunning { .. }
            | RoutineDispatchResult::Completed => {}
        }
    }
    Ok(())
}

async fn dispatch_next_event<H: SchedulerHost>(
    host: &H,
    owner: &ResolvedRoutineOwner,
    consent: bool,
    pool: &sqlx::SqlitePool,
) -> Result<(), AppError> {
    if !consent {
        return Ok(());
    }
    let Some(event) = next_pending_event(pool, &owner.descriptor.owner_path).await? else {
        return Ok(());
    };
    let live = host.live_evidence()?;
    if let Some(run) = latest_run_record(pool, &event.owner_path, &event.routine_id).await?
        && run.blocks_relaunch(&live)
    {
        return Ok(());
    }
    let Some(preflight) = host.event_preflight(owner, &event).await else {
        finish_event(pool, &event.queue_key, "failed").await?;
        return Ok(());
    };
    if let EventDispatchPreflight::UpdateProperties { mutation_paths } = &preflight
        && !host.mutation_paths_ready(mutation_paths.clone()).await
    {
        return Ok(());
    }

    let Some(gate) = host.repository_gate(owner).await? else {
        return Ok(());
    };
    let now = Utc::now();
    let Some((run_key, claim)) = host
        .claim(
            &gate,
            &event.routine_id,
            &event.definition_fingerprint,
            now.timestamp(),
            |repository_id| event_run_key(repository_id, &event.routine_id, &event.event_key),
        )
        .await?
    else {
        return Ok(());
    };
    let should_dispatch = match claim {
        RoutineClaimResult::Local => {
            claim_local_run(
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
                host,
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
                host,
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
        finish_event(pool, &event.queue_key, "completed").await?;
        return Ok(());
    }
    let execution_run_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
    if !activate_event(pool, &event.queue_key, &execution_run_id).await? {
        return Ok(());
    }
    let result = host
        .dispatch_event(owner.clone(), event.clone(), execution_run_id)
        .await;
    let state = match &result {
        Ok(RoutineDispatchResult::Started { .. })
        | Ok(RoutineDispatchResult::AlreadyRunning { .. })
        | Ok(RoutineDispatchResult::Completed) => "completed",
        Ok(RoutineDispatchResult::Blocked { message, .. })
        | Ok(RoutineDispatchResult::Failed { message, .. }) => {
            tracing::warn!(routine_id = %event.routine_id, "event routine failed: {message}");
            "failed"
        }
        Err(error) => {
            tracing::warn!(routine_id = %event.routine_id, "event routine dispatch failed: {error}");
            "failed"
        }
    };
    finish_event(pool, &event.queue_key, state).await?;
    result.map(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn write_baseline<H: SchedulerHost>(
    host: &H,
    pool: &sqlx::SqlitePool,
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    fingerprint: &str,
    cron: &str,
    time_basis: &svode_core::routines::model::RoutineTimeBasis,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    let next = schedule::next_after(cron, time_basis, now).map_err(AppError::General)?;
    advance_checkpoint(host, pool, owner, routine_id, fingerprint, now, next).await
}

async fn advance_checkpoint<H: SchedulerHost>(
    host: &H,
    pool: &sqlx::SqlitePool,
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    fingerprint: &str,
    checkpoint: DateTime<Utc>,
    next: DateTime<Utc>,
) -> Result<(), AppError> {
    write_schedule_state(
        pool,
        &owner.descriptor.owner_path,
        routine_id,
        fingerprint,
        &checkpoint.to_rfc3339_opts(SecondsFormat::Secs, true),
        &next.to_rfc3339_opts(SecondsFormat::Secs, true),
    )
    .await?;
    host.invalidate(owner);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn record_claim<H: SchedulerHost>(
    host: &H,
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
    let previous = latest_remote_claim(pool, &owner.descriptor.owner_path, routine_id).await?;
    record_remote_claim(
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
        host.invalidate(owner);
    }
    Ok(())
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
