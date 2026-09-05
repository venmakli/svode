use std::path::Path;

use tauri::AppHandle;

use super::{access, autocommit::AutocommitService, commands::GitState, ops};
use crate::{
    AppError,
    repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base},
    space::types::SpaceGitType,
};

pub(crate) async fn save(
    app: &AppHandle,
    state: &GitState,
    autocommit: &AutocommitService,
    project: Option<&Path>,
    space: &Path,
    requested: Option<Vec<String>>,
) -> Result<ops::GitStatus, AppError> {
    let cli = super::commands::require_cli(state)?;
    let (kind, repo) = match project {
        Some(project) => ops::resolve_target_repo(&cli, project, space).await?,
        None => (SpaceGitType::Independent, space.to_path_buf()),
    };
    let requested = requested
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| normalize_repo_relative(&path, RootMode::Reject))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let key = format!("{}:{requested:?}", space.display());
    let lock = state.get_lock(&repo).await;
    let _guard = lock.lock().await;
    let parent_lock = if kind == SpaceGitType::Submodule {
        Some(state.get_lock(project.unwrap()).await)
    } else {
        None
    };
    let _parent_guard = match &parent_lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };

    // Authorize both repositories before staging; a late denial is preserved as
    // the parent outcome once a child commit has succeeded.
    if let Some(project) = project.filter(|_| kind == SpaceGitType::Submodule) {
        let pending = state
            .pending_manual_pointers
            .lock()
            .await
            .get(&key)
            .cloned();
        if let Some(expected_head) = pending {
            access::require_repository_mutation(app, project)
                .await
                .map_err(|cause| AppError::GitSavePartial {
                    cause: Box::new(cause),
                })?;
            let current = cli.exec(space, &["rev-parse", "HEAD"]).await?;
            if current.exit_code != 0 || current.stdout.trim() != expected_head {
                return Err(AppError::GitSavePartial {
                    cause: Box::new(AppError::GitCommandFailed(
                        "Child HEAD changed; parent pointer recovery needs review".into(),
                    )),
                });
            }
            ops::submodule_update_pointer(&cli, project, space)
                .await
                .map_err(|cause| AppError::GitSavePartial {
                    cause: Box::new(cause),
                })?;
            state.pending_manual_pointers.lock().await.remove(&key);
            return ops::status(&cli, space).await;
        }
        access::require_repository_mutation(app, project).await?;
    }
    access::require_repository_mutation(app, &repo).await?;

    let anchors = requested.as_ref().map(|paths| {
        paths
            .iter()
            .map(|path| space.join(path))
            .collect::<Vec<_>>()
    });
    let mut pending = autocommit.begin_manual_save(space, anchors.as_deref());
    let selected = match requested {
        Some(paths) => paths,
        None => ops::status(&cli, space)
            .await?
            .files
            .into_iter()
            .map(|file| file.path)
            .collect(),
    };
    let mut paths = selected
        .iter()
        .map(|path| repo_relative_from_base(&repo, &space.join(path), RootMode::Reject))
        .collect::<Result<Vec<_>, _>>()?;
    for path in pending.paths() {
        let path = repo_relative_from_base(&repo, &path, RootMode::Reject)?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    for path in &paths {
        super::inspection::contained_file(&repo, path)?;
    }
    let affected = paths.iter().map(|path| repo.join(path)).collect::<Vec<_>>();
    access::require_repository_mutation_paths(app, affected).await?;
    let created = ops::commit_paths(&cli, &repo, &paths).await?;
    pending.complete();
    if created && let Some(project) = project.filter(|_| kind == SpaceGitType::Submodule) {
        let head = cli.exec(space, &["rev-parse", "HEAD"]).await?;
        state
            .pending_manual_pointers
            .lock()
            .await
            .insert(key.clone(), head.stdout.trim().to_string());
        let result = async {
            access::require_repository_mutation(app, project).await?;
            ops::submodule_update_pointer(&cli, project, space).await
        }
        .await;
        result.map_err(|cause| AppError::GitSavePartial {
            cause: Box::new(cause),
        })?;
        state.pending_manual_pointers.lock().await.remove(&key);
    }
    ops::status(&cli, space).await
}
