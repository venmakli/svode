use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};

use super::model::{
    ResolvedRoutineOwner, RoutineCatalogSnapshot, RoutineDefinition, RoutineDiagnostic,
    RoutineOwnerDescriptor, RoutineOwnerInputKind, RoutineOwnerKind, RoutineRunOrigin,
    RoutineTrigger,
};
use super::{authority, cache, parser};
use crate::AppError;
use crate::agent_actors;
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;
use crate::terminal::TerminalManager;

pub(crate) fn resolve_owner(
    project_path: &Path,
    space_path: &Path,
    space_id: &str,
    owner_path: &str,
    owner_kind: RoutineOwnerInputKind,
) -> Result<ResolvedRoutineOwner, AppError> {
    if space_id.trim().is_empty() {
        return Err(AppError::PathNotAccessible("missing Space id".into()));
    }
    let project = canonical_space_path(project_path)?;
    let space = canonical_space_path(space_path)?;
    config::read_space_config(&space)?;
    if project != space {
        let registered = config::read_space_config(&project)?
            .spaces
            .unwrap_or_default()
            .into_iter()
            .any(|candidate| {
                candidate.id == space_id
                    && fs::canonicalize(project.join(candidate.path))
                        .is_ok_and(|candidate| candidate == space)
            });
        if !registered {
            return Err(AppError::PathNotAccessible(space.display().to_string()));
        }
    }
    let index_key = if project == space {
        IndexKey::Root(project.clone())
    } else {
        IndexKey::Space {
            project: project.clone(),
            space_id: space_id.to_string(),
        }
    };
    let (kind, normalized_owner_path, owner_root) = match owner_kind {
        RoutineOwnerInputKind::RegisteredSpace => {
            if owner_path != "." {
                return Err(AppError::PathNotAccessible(owner_path.to_string()));
            }
            let kind = if project == space {
                RoutineOwnerKind::Project
            } else {
                RoutineOwnerKind::Space
            };
            (kind, ".".to_string(), space.clone())
        }
        RoutineOwnerInputKind::CollectionDirectory => {
            let normalized = normalize_repo_relative(owner_path, RootMode::Reject)?;
            let collection = fs::canonicalize(space.join(&normalized)).map_err(|error| {
                AppError::General(format!(
                    "failed to resolve routine collection owner {normalized}: {error}"
                ))
            })?;
            if !collection.starts_with(&space) || !collection.is_dir() {
                return Err(AppError::PathNotAccessible(owner_path.to_string()));
            }
            ensure_collection_schema(&collection)?;
            (RoutineOwnerKind::Collection, normalized, collection)
        }
    };
    Ok(ResolvedRoutineOwner {
        descriptor: RoutineOwnerDescriptor {
            kind,
            space_id: space_id.to_string(),
            owner_path: normalized_owner_path,
        },
        project_path: project,
        space_path: space,
        owner_root,
        index_key,
    })
}

pub(crate) async fn read_catalog(
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
    owner: &ResolvedRoutineOwner,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let mut snapshot = discover_owner(owner).await?;
    match index_state.get_or_create(&owner.index_key).await {
        Ok(pool) => {
            if let Err(error) = cache::replace_owner_snapshot(&pool, &snapshot).await {
                tracing::warn!(
                    owner = %owner.descriptor.owner_path,
                    "failed to refresh routine definition cache: {error}"
                );
                snapshot.diagnostics.push(RoutineDiagnostic::new(
                    "routine_cache_unavailable",
                    "routine files were read, but the local definition cache could not be refreshed",
                ));
            }
            let live_pty_ids = live_agent_pty_ids(terminal_manager)?;
            let now = Utc::now();
            for row in &mut snapshot.routines {
                if row.diagnostics.is_empty()
                    && let Some(RoutineDefinition {
                        trigger: RoutineTrigger::Schedule { cron, timezone, .. },
                        ..
                    }) = row.definition.as_ref()
                {
                    let current =
                        cache::schedule_state(&pool, &owner.descriptor.owner_path, &row.routine_id)
                            .await?;
                    if let Some(current) =
                        current.filter(|state| state.definition_fingerprint == row.fingerprint)
                    {
                        row.next_run_at = Some(current.next_run_at);
                    } else if let Ok(next) = super::schedule::next_after(cron, timezone, now) {
                        let checkpoint = now.to_rfc3339_opts(SecondsFormat::Secs, true);
                        let next = next.to_rfc3339_opts(SecondsFormat::Secs, true);
                        cache::write_schedule_state(
                            &pool,
                            &owner.descriptor.owner_path,
                            &row.routine_id,
                            &row.fingerprint,
                            &checkpoint,
                            &next,
                        )
                        .await?;
                        row.next_run_at = Some(next);
                    }
                }

                let local = match cache::latest_run(
                    &pool,
                    &owner.descriptor.owner_path,
                    &row.routine_id,
                )
                .await
                {
                    Ok(run) => run,
                    Err(error) => {
                        tracing::warn!(
                            routine_id = %row.routine_id,
                            "failed to load latest routine run: {error}"
                        );
                        snapshot.diagnostics.push(RoutineDiagnostic::new(
                            "routine_run_cache_unavailable",
                            "routine definitions were read, but latest local run references are unavailable",
                        ));
                        break;
                    }
                };
                let remote = cache::latest_remote_claim(
                    &pool,
                    &owner.descriptor.owner_path,
                    &row.routine_id,
                )
                .await?;
                if remote.as_ref().is_some_and(|claim| {
                    local
                        .as_ref()
                        .is_none_or(|run| claim.claimed_at > run.created_at)
                }) {
                    let claim = remote.expect("checked remote claim");
                    row.last_run_at = Some(claim.claimed_at);
                    row.last_run_origin = Some(RoutineRunOrigin::Remote);
                    row.last_run = None;
                } else if let Some(run) = local {
                    row.last_run_at = Some(run.created_at.clone());
                    row.last_run_origin = Some(RoutineRunOrigin::Local);
                    row.last_run = Some(run.to_ref(&live_pty_ids));
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "failed to open routine definition cache: {error}"
            );
            snapshot.diagnostics.push(RoutineDiagnostic::new(
                "routine_cache_unavailable",
                "routine files were read, but the local definition cache is unavailable",
            ));
        }
    }
    snapshot.catalog_fingerprint = publication_fingerprint(&snapshot);
    Ok(snapshot)
}

pub(crate) async fn read_automatic_authority(
    index_state: &IndexState,
    owner: &ResolvedRoutineOwner,
) -> Result<bool, AppError> {
    let pool = index_state
        .get_or_create(&IndexKey::Root(owner.project_path.clone()))
        .await?;
    authority::migrate_legacy_for_project(&pool, index_state, &owner.project_path).await?;
    authority::read(&pool, owner).await
}

pub(crate) async fn discover_owner(
    owner: &ResolvedRoutineOwner,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = owner.clone();
    tauri::async_runtime::spawn_blocking(move || snapshot_with_executor_diagnostics(&owner))
        .await
        .map_err(blocking_task_error)
}

pub(crate) fn live_agent_pty_ids(
    terminal_manager: &TerminalManager,
) -> Result<HashSet<String>, AppError> {
    Ok(terminal_manager
        .list_agent_surfaces()?
        .into_iter()
        .filter(|surface| surface.live)
        .map(|surface| surface.pty_id)
        .collect())
}

fn publication_fingerprint(snapshot: &RoutineCatalogSnapshot) -> String {
    let mut value = String::new();
    for row in &snapshot.routines {
        for field in [
            row.routine_id.as_str(),
            row.fingerprint.as_str(),
            row.last_run_at.as_deref().unwrap_or_default(),
            row.next_run_at.as_deref().unwrap_or_default(),
        ] {
            value.push_str(field);
            value.push('\0');
        }
        value.push_str(match row.last_run_origin {
            Some(RoutineRunOrigin::Local) => "local",
            Some(RoutineRunOrigin::Remote) => "remote",
            None => "",
        });
        value.push('\0');
        if let Some(last_run) = &row.last_run {
            value.push_str(&serde_json::to_string(last_run).unwrap_or_default());
        }
        value.push('\0');
        for diagnostic in &row.diagnostics {
            value.push_str(&diagnostic.code);
            value.push('\0');
            value.push_str(&diagnostic.message);
            value.push('\0');
            value.push_str(diagnostic.field.as_deref().unwrap_or_default());
            value.push('\0');
            value.push_str(diagnostic.path.as_deref().unwrap_or_default());
            value.push('\0');
        }
    }
    for diagnostic in &snapshot.diagnostics {
        value.push_str(&diagnostic.code);
        value.push('\0');
        value.push_str(&diagnostic.message);
        value.push('\0');
        value.push_str(diagnostic.path.as_deref().unwrap_or_default());
        value.push('\0');
    }
    parser::fingerprint(value.as_bytes())
}

fn snapshot_with_executor_diagnostics(owner: &ResolvedRoutineOwner) -> RoutineCatalogSnapshot {
    let mut snapshot = parser::discover_owner(owner);
    let inherited =
        (owner.space_path != owner.project_path).then_some(owner.project_path.as_path());
    let resolution = agent_actors::resolve_catalogs(&owner.space_path, inherited);
    let actors = resolution
        .actors
        .into_iter()
        .map(|resolved| format!("agent:{}", resolved.actor.id))
        .collect::<HashSet<_>>();
    for row in &mut snapshot.routines {
        let Some(executor) = row
            .definition
            .as_ref()
            .and_then(|definition| definition.action.executor())
        else {
            continue;
        };
        if executor.is_empty()
            || row
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "routine_executor_invalid")
        {
            continue;
        }
        if !actors.contains(executor) {
            row.diagnostics.push(
                RoutineDiagnostic::new(
                    "routine_executor_unavailable",
                    format!(
                        "executor {executor} is not available in the effective Agent Actors catalog"
                    ),
                )
                .field("action.executor")
                .path(row.path.clone()),
            );
        }
    }
    snapshot.catalog_fingerprint =
        parser::catalog_fingerprint(&snapshot.routines, &snapshot.diagnostics);
    snapshot
}

fn canonical_space_path(path: &Path) -> Result<PathBuf, AppError> {
    fs::canonicalize(path).map_err(|error| {
        AppError::General(format!(
            "failed to resolve routine Space {}: {error}",
            path.display()
        ))
    })
}

fn ensure_collection_schema(collection: &Path) -> Result<(), AppError> {
    let schema = collection.join("schema.yaml");
    let metadata = fs::symlink_metadata(&schema).map_err(|_| {
        AppError::PathNotAccessible(format!(
            "routine collection owner has no direct schema.yaml: {}",
            collection.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAccessible(schema.display().to_string()));
    }
    Ok(())
}

fn blocking_task_error(error: impl std::fmt::Display) -> AppError {
    AppError::General(format!("routine filesystem task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, SpaceRef};

    fn space_config(name: &str, spaces: Option<Vec<SpaceRef>>) -> SpaceConfig {
        SpaceConfig {
            name: name.into(),
            description: String::new(),
            icon: "folder".into(),
            spaces,
            agent: None,
            defaults: None,
            git: None,
            assets: None,
            tree: None,
        }
    }

    #[test]
    fn resolves_project_space_and_collection_owners_without_ambiguity() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let child = project.join("child");
        let collection = child.join("tasks");
        fs::create_dir_all(&collection).unwrap();
        fs::write(collection.join("schema.yaml"), "name: Tasks\n").unwrap();
        write_space_config(&child, &space_config("Child", None)).unwrap();
        write_space_config(
            project,
            &space_config(
                "Project",
                Some(vec![SpaceRef {
                    id: "child-id".into(),
                    path: "child".into(),
                    repo: None,
                }]),
            ),
        )
        .unwrap();

        let root = resolve_owner(
            project,
            project,
            "root",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        assert_eq!(root.descriptor.kind, RoutineOwnerKind::Project);

        let space = resolve_owner(
            project,
            &child,
            "child-id",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        assert_eq!(space.descriptor.kind, RoutineOwnerKind::Space);

        let collection = resolve_owner(
            project,
            &child,
            "child-id",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        assert_eq!(collection.descriptor.kind, RoutineOwnerKind::Collection);
        assert_eq!(collection.descriptor.owner_path, "tasks");

        assert!(
            resolve_owner(
                project,
                &child,
                "wrong-child-id",
                "tasks",
                RoutineOwnerInputKind::CollectionDirectory,
            )
            .is_err()
        );
        assert!(
            resolve_owner(
                project,
                &child,
                "child-id",
                "tasks",
                RoutineOwnerInputKind::RegisteredSpace,
            )
            .is_err()
        );
        for unsafe_path in ["/tasks", "../tasks", "tasks/../other"] {
            assert!(
                resolve_owner(
                    project,
                    &child,
                    "child-id",
                    unsafe_path,
                    RoutineOwnerInputKind::CollectionDirectory,
                )
                .is_err(),
                "{unsafe_path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn collection_owner_rejects_symlink_escape() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("schema.yaml"), "name: Outside\n").unwrap();
        write_space_config(project.path(), &space_config("Project", None)).unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join("linked")).unwrap();

        assert!(
            resolve_owner(
                project.path(),
                project.path(),
                "root",
                "linked",
                RoutineOwnerInputKind::CollectionDirectory,
            )
            .is_err()
        );
    }

    #[test]
    fn publication_fingerprint_tracks_runtime_but_not_authority() {
        let row = super::super::model::RoutineRow {
            routine_id: "routine:one".into(),
            filename: "one.md".into(),
            path: ".routines/one.md".into(),
            title: "One".into(),
            description: None,
            enabled: Some(true),
            trigger_type: Some(super::super::model::RoutineTriggerType::Manual),
            trigger_summary: None,
            action_type: None,
            action_summary: None,
            executor: None,
            last_run_at: Some("2026-08-19T10:00:00Z".into()),
            last_run_origin: Some(RoutineRunOrigin::Local),
            next_run_at: None,
            last_run: None,
            fingerprint: "definition".into(),
            definition: None,
            diagnostics: Vec::new(),
        };
        let snapshot = RoutineCatalogSnapshot {
            owner: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root".into(),
                owner_path: ".".into(),
            },
            routines: vec![row],
            diagnostics: Vec::new(),
            catalog_fingerprint: String::new(),
            refreshed_at: "2026-08-19T10:00:00Z".into(),
        };
        let initial = publication_fingerprint(&snapshot);
        let mut changed = snapshot.clone();
        changed.routines[0].last_run_origin = Some(RoutineRunOrigin::Remote);
        assert_ne!(publication_fingerprint(&changed), initial);
        changed.routines[0].last_run_origin = Some(RoutineRunOrigin::Local);
        assert_eq!(publication_fingerprint(&changed), initial);
        changed.routines[0].next_run_at = Some("2026-08-20T10:00:00Z".into());
        assert_ne!(publication_fingerprint(&changed), initial);
    }

    #[tokio::test]
    async fn shared_read_keeps_valid_and_malformed_rows_and_exact_owner_authority() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let collection = project.join("tasks");
        let routines = collection.join(".routines");
        fs::create_dir_all(&routines).unwrap();
        fs::write(collection.join("schema.yaml"), "name: Tasks\n").unwrap();
        fs::write(
            routines.join("valid.md"),
            "---\ntitle: Valid\ntrigger:\n  type: event\n  event: collection.entry_created\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    reviewed: true\n---\nBody\n",
        )
        .unwrap();
        fs::write(routines.join("invalid.md"), "---\ntrigger: [\n---\n").unwrap();
        write_space_config(project, &space_config("Project", None)).unwrap();
        let owner = resolve_owner(
            project,
            project,
            "root",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        let index_state = IndexState::new();
        let terminal_manager = TerminalManager::new();

        let snapshot = read_catalog(&index_state, &terminal_manager, &owner)
            .await
            .unwrap();

        assert_eq!(snapshot.routines.len(), 2);
        let valid = snapshot
            .routines
            .iter()
            .find(|row| row.filename == "valid.md")
            .unwrap();
        assert!(valid.definition.is_some());
        assert!(valid.diagnostics.is_empty());
        let invalid = snapshot
            .routines
            .iter()
            .find(|row| row.filename == "invalid.md")
            .unwrap();
        assert!(invalid.definition.is_none());
        assert_eq!(invalid.diagnostics[0].code, "routine_frontmatter_invalid");

        assert!(
            !read_automatic_authority(&index_state, &owner)
                .await
                .unwrap()
        );
        let pool = index_state
            .get_or_create(&IndexKey::Root(owner.project_path.clone()))
            .await
            .unwrap();
        authority::set(&pool, &owner, true).await.unwrap();
        assert!(
            read_automatic_authority(&index_state, &owner)
                .await
                .unwrap()
        );
    }
}
