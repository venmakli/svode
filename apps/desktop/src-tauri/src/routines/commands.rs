use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use super::cache;
use super::model::{
    CollectionEvent, MissedRuns, ResolvedRoutineOwner, RoutineAction, RoutineCatalogSnapshot,
    RoutineDefinition, RoutineDiagnostic, RoutineMutationResult, RoutineOwnerDescriptor,
    RoutineOwnerInputKind, RoutineOwnerKind, RoutineTrigger, RoutineTriggerType,
};
use super::parser;
use crate::AppError;
use crate::agent_actors;
use crate::git;
use crate::git::access::{RepositoryAccessState, access_store_path};
use crate::git::commands::{GitState, require_cli};
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;

const DEFAULT_SCHEDULE_CRON: &str = "0 9 * * 1-5";

#[derive(Debug, PartialEq, Eq)]
enum FileCasOutcome {
    Applied,
    Stale(String),
}

#[derive(Debug)]
struct RoutineOwnerInput {
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
}

impl RoutineOwnerInput {
    fn resolve(self) -> Result<ResolvedRoutineOwner, AppError> {
        resolve_owner(
            Path::new(&self.project_path),
            Path::new(&self.space_path),
            &self.space_id,
            &self.owner_path,
            self.owner_kind,
        )
    }
}

#[tauri::command]
pub async fn routines_list(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    refresh_owner(&index_state, &owner).await
}

#[tauri::command]
pub async fn routines_refresh(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    routines_list(
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
        index_state,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_create(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    title: String,
    description: Option<String>,
    trigger_type: RoutineTriggerType,
    timezone: Option<String>,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let definition = match create_definition(
        &title,
        description.as_deref(),
        trigger_type,
        timezone.as_deref(),
        owner.descriptor.kind,
    ) {
        Ok(definition) => definition,
        Err(message) => return Ok(RoutineMutationResult::Blocked { message }),
    };
    let repository = mutation_repository(&git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    authorize_mutation(&app, &git_state, &access_state, &repository).await?;

    let write_owner = owner.clone();
    let write_definition = definition.clone();
    let filename = tauri::async_runtime::spawn_blocking(move || {
        create_definition_file(&write_owner, &write_definition)
    })
    .await
    .map_err(blocking_task_error)??;
    let snapshot = refresh_owner(&index_state, &owner).await?;
    let Some(row) = snapshot
        .routines
        .iter()
        .find(|row| row.filename == filename)
    else {
        return Err(AppError::General(
            "created routine was not discoverable after its atomic write".into(),
        ));
    };
    Ok(RoutineMutationResult::Applied {
        routine_id: row.routine_id.clone(),
        snapshot,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_update(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    definition: RoutineDefinition,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let repository = mutation_repository(&git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    authorize_mutation(&app, &git_state, &access_state, &repository).await?;

    let current = discover_owner(&owner).await?;
    let Some(row) = current
        .routines
        .iter()
        .find(|row| row.routine_id == routine_id)
    else {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: None,
        });
    };
    if row.fingerprint != expected_fingerprint {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: Some(row.fingerprint.clone()),
        });
    }
    let content = match parser::serialize_definition(&definition) {
        Ok(content) if content.len() as u64 <= parser::MAX_ROUTINE_BYTES => content,
        Ok(_) => {
            return Ok(RoutineMutationResult::Blocked {
                message: "routine definition exceeds the 1 MiB limit".into(),
            });
        }
        Err(message) => return Ok(RoutineMutationResult::Blocked { message }),
    };
    let path = owner.routines_dir().join(&row.filename);
    let write_fingerprint = expected_fingerprint.clone();
    let write_content = content.into_bytes();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        atomic_replace_cas(&path, &write_fingerprint, &write_content)
    })
    .await
    .map_err(blocking_task_error)??;
    if let FileCasOutcome::Stale(current_fingerprint) = outcome {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: Some(current_fingerprint),
        });
    }
    let snapshot = refresh_owner(&index_state, &owner).await?;
    Ok(RoutineMutationResult::Applied {
        routine_id,
        snapshot,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_delete(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let repository = mutation_repository(&git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    authorize_mutation(&app, &git_state, &access_state, &repository).await?;

    let current = discover_owner(&owner).await?;
    let Some(row) = current
        .routines
        .iter()
        .find(|row| row.routine_id == routine_id)
    else {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: None,
        });
    };
    if row.fingerprint != expected_fingerprint {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: Some(row.fingerprint.clone()),
        });
    }
    let path = owner.routines_dir().join(&row.filename);
    let directory = owner.routines_dir();
    let delete_fingerprint = expected_fingerprint.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        delete_definition_file_cas(&directory, &path, &delete_fingerprint)
    })
    .await
    .map_err(blocking_task_error)??;
    if let FileCasOutcome::Stale(current_fingerprint) = outcome {
        return Ok(RoutineMutationResult::Stale {
            current_fingerprint: Some(current_fingerprint),
        });
    }
    let snapshot = refresh_owner(&index_state, &owner).await?;
    Ok(RoutineMutationResult::Applied {
        routine_id,
        snapshot,
    })
}

async fn mutation_repository(
    git_state: &GitState,
    owner: &ResolvedRoutineOwner,
) -> Result<PathBuf, AppError> {
    let cli = require_cli(git_state)?;
    let (_, repository) =
        git::ops::resolve_target_repo(&cli, &owner.project_path, &owner.space_path).await?;
    Ok(repository)
}

async fn authorize_mutation(
    app: &AppHandle,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    repository: &Path,
) -> Result<(), AppError> {
    let cli = require_cli(git_state)?;
    access_state
        .require_mutation(&cli, repository, &access_store_path(app)?)
        .await?;
    Ok(())
}

async fn refresh_owner(
    index_state: &IndexState,
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
    Ok(snapshot)
}

async fn discover_owner(owner: &ResolvedRoutineOwner) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = owner.clone();
    tauri::async_runtime::spawn_blocking(move || snapshot_with_executor_diagnostics(&owner))
        .await
        .map_err(blocking_task_error)
}

fn blocking_task_error(error: impl std::fmt::Display) -> AppError {
    AppError::General(format!("routine filesystem task failed: {error}"))
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

fn resolve_owner(
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
                fs::canonicalize(project.join(candidate.path))
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

fn create_definition(
    title: &str,
    description: Option<&str>,
    trigger_type: RoutineTriggerType,
    timezone: Option<&str>,
    owner_kind: RoutineOwnerKind,
) -> Result<RoutineDefinition, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("routine title must contain 1 to 240 characters".into());
    }
    let description = description.map(str::trim).filter(|value| !value.is_empty());
    if description.is_some_and(|value| value.chars().count() > 2_000) {
        return Err("routine description must contain at most 2000 characters".into());
    }
    let (enabled, trigger) = match trigger_type {
        RoutineTriggerType::Manual => (None, RoutineTrigger::Manual),
        RoutineTriggerType::Schedule => {
            let timezone = timezone
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "schedule routines require an explicit IANA timezone".to_string())?;
            (
                Some(false),
                RoutineTrigger::Schedule {
                    cron: DEFAULT_SCHEDULE_CRON.into(),
                    timezone: timezone.into(),
                    missed_runs: MissedRuns::Skip,
                },
            )
        }
        RoutineTriggerType::Event if owner_kind == RoutineOwnerKind::Collection => (
            Some(false),
            RoutineTrigger::Event {
                event: CollectionEvent::EntryCreated,
                match_: None,
            },
        ),
        RoutineTriggerType::Event => {
            return Err("event routines require a Collection owner".into());
        }
    };
    Ok(RoutineDefinition {
        title: Some(title.into()),
        description: description.map(str::to_owned),
        enabled,
        trigger,
        action: RoutineAction::RunAgent {
            executor: String::new(),
        },
        body: String::new(),
    })
}

fn create_definition_file(
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
) -> Result<String, AppError> {
    let directory = owner.routines_dir();
    ensure_routines_directory(&directory)?;
    let slug = slugify(definition.title.as_deref().unwrap_or("routine"));
    let content = parser::serialize_definition(definition).map_err(AppError::General)?;
    if content.len() as u64 > parser::MAX_ROUTINE_BYTES {
        return Err(AppError::General(
            "routine definition exceeds the 1 MiB limit".into(),
        ));
    }
    for _ in 0..8 {
        let filename = format!(
            "{slug}-{}.md",
            ulid::Ulid::new().to_string().to_ascii_lowercase()
        );
        let path = directory.join(&filename);
        match write_new_file(&path, content.as_bytes()) {
            Ok(()) => {
                sync_directory(&directory)?;
                return Ok(filename);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Err(AppError::FileAlreadyExists(
        "failed to allocate a unique routine filename".into(),
    ))
}

fn ensure_routines_directory(directory: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(AppError::PathNotAccessible(directory.display().to_string()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory)?;
            let parent = directory
                .parent()
                .ok_or_else(|| AppError::PathNotAccessible(directory.display().to_string()))?;
            sync_directory(parent)
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn atomic_replace_cas(
    path: &Path,
    expected_fingerprint: &str,
    bytes: &[u8],
) -> Result<FileCasOutcome, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::PathNotAccessible(path.display().to_string()))?;
    ensure_routines_directory(parent)?;
    let current_fingerprint = definition_file_fingerprint(path)?;
    if current_fingerprint != expected_fingerprint {
        return Ok(FileCasOutcome::Stale(current_fingerprint));
    }
    let temp = parent.join(format!(".routine-{}.tmp", ulid::Ulid::new()));
    write_new_file(&temp, bytes)?;
    let current_fingerprint = definition_file_fingerprint(path)?;
    if current_fingerprint != expected_fingerprint {
        let _ = fs::remove_file(&temp);
        return Ok(FileCasOutcome::Stale(current_fingerprint));
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(AppError::Io(error));
    }
    sync_directory(parent)?;
    Ok(FileCasOutcome::Applied)
}

fn delete_definition_file_cas(
    directory: &Path,
    path: &Path,
    expected_fingerprint: &str,
) -> Result<FileCasOutcome, AppError> {
    ensure_routines_directory(directory)?;
    let current_fingerprint = definition_file_fingerprint(path)?;
    if current_fingerprint != expected_fingerprint {
        return Ok(FileCasOutcome::Stale(current_fingerprint));
    }
    fs::remove_file(path)?;
    sync_directory(directory)?;
    Ok(FileCasOutcome::Applied)
}

fn ensure_regular_definition_file(path: &Path) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAccessible(path.display().to_string()));
    }
    Ok(())
}

fn definition_file_fingerprint(path: &Path) -> Result<String, AppError> {
    ensure_regular_definition_file(path)?;
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > parser::MAX_ROUTINE_BYTES {
        return Err(AppError::PathNotAccessible(format!(
            "routine definition exceeds the 1 MiB limit: {}",
            path.display()
        )));
    }
    Ok(parser::fingerprint(&bytes))
}

fn sync_directory(path: &Path) -> Result<(), AppError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if let Some(transliterated) = transliterate_cyrillic(character) {
            slug.push_str(transliterated);
            separator = false;
        } else if !slug.is_empty() && !separator {
            slug.push('-');
            separator = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    slug.truncate(48);
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "routine".into()
    } else {
        slug.into()
    }
}

fn transliterate_cyrillic(character: char) -> Option<&'static str> {
    Some(match character.to_lowercase().next()? {
        'а' => "a",
        'б' => "b",
        'в' => "v",
        'г' | 'ґ' => "g",
        'д' => "d",
        'е' | 'э' => "e",
        'ё' => "yo",
        'ж' => "zh",
        'з' => "z",
        'и' | 'і' => "i",
        'й' => "y",
        'к' => "k",
        'л' => "l",
        'м' => "m",
        'н' => "n",
        'о' => "o",
        'п' => "p",
        'р' => "r",
        'с' => "s",
        'т' => "t",
        'у' | 'ў' => "u",
        'ф' => "f",
        'х' => "kh",
        'ц' => "ts",
        'ч' => "ch",
        'ш' => "sh",
        'щ' => "shch",
        'ъ' | 'ь' => "",
        'ы' => "y",
        'ю' => "yu",
        'я' => "ya",
        'є' => "ye",
        'ї' => "yi",
        _ => return None,
    })
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
    fn create_defaults_are_disabled_until_an_executor_is_chosen() {
        let definition = create_definition(
            "Weekly review",
            Some("  Summarizes weekly changes.  "),
            RoutineTriggerType::Schedule,
            Some("Europe/Paris"),
            RoutineOwnerKind::Space,
        )
        .unwrap();
        assert_eq!(definition.enabled, Some(false));
        assert_eq!(
            definition.description.as_deref(),
            Some("Summarizes weekly changes.")
        );
        assert!(matches!(
            definition.trigger,
            RoutineTrigger::Schedule {
                missed_runs: MissedRuns::Skip,
                ..
            }
        ));
        assert_eq!(definition.action.executor(), Some(""));
    }

    #[test]
    fn event_create_is_collection_only() {
        assert!(
            create_definition(
                "Event",
                None,
                RoutineTriggerType::Event,
                None,
                RoutineOwnerKind::Project,
            )
            .is_err()
        );
    }

    #[test]
    fn slug_transliterates_cyrillic_and_keeps_a_portable_fallback() {
        assert_eq!(slugify("  Привет, мир!  "), "privet-mir");
        assert_eq!(slugify("Ёжик и щука"), "yozhik-i-shchuka");
        assert_eq!(slugify("日本語"), "routine");
        assert_eq!(slugify("Quarterly Review!"), "quarterly-review");
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
            "root-id",
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
                "child-id",
                "tasks",
                RoutineOwnerInputKind::RegisteredSpace,
            )
            .is_err()
        );
    }

    #[test]
    fn definition_file_create_replace_delete_is_owner_local_and_keeps_identity() {
        let temp = tempfile::tempdir().unwrap();
        let owner = ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root-id".into(),
                owner_path: ".".into(),
            },
            project_path: temp.path().into(),
            space_path: temp.path().into(),
            owner_root: temp.path().into(),
            index_key: IndexKey::Root(temp.path().into()),
        };
        let mut definition = create_definition(
            "Initial title",
            None,
            RoutineTriggerType::Manual,
            None,
            RoutineOwnerKind::Project,
        )
        .unwrap();
        let filename = create_definition_file(&owner, &definition).unwrap();
        assert!(!owner.routines_dir().join("schema.yaml").exists());
        let first = parser::discover_owner(&owner);
        let first_row = first
            .routines
            .iter()
            .find(|row| row.filename == filename)
            .unwrap();
        let routine_id = first_row.routine_id.clone();
        let fingerprint = first_row.fingerprint.clone();

        definition.title = Some("Changed title".into());
        let content = parser::serialize_definition(&definition).unwrap();
        assert_eq!(
            atomic_replace_cas(
                &owner.routines_dir().join(&filename),
                &fingerprint,
                content.as_bytes(),
            )
            .unwrap(),
            FileCasOutcome::Applied
        );
        let second = parser::discover_owner(&owner);
        let second_row = second
            .routines
            .iter()
            .find(|row| row.filename == filename)
            .unwrap();
        assert_eq!(second_row.routine_id, routine_id);
        assert_ne!(second_row.fingerprint, fingerprint);
        assert_eq!(second_row.title, "Changed title");

        assert_eq!(
            atomic_replace_cas(
                &owner.routines_dir().join(&filename),
                &fingerprint,
                b"must not replace the current definition",
            )
            .unwrap(),
            FileCasOutcome::Stale(second_row.fingerprint.clone())
        );

        fs::remove_file(owner.routines_dir().join(&filename)).unwrap();
        sync_directory(&owner.routines_dir()).unwrap();
        assert!(parser::discover_owner(&owner).routines.is_empty());
    }
}
