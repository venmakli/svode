use std::path::Path;

use tauri::AppHandle;

use super::{GitState, access, ops};
use crate::{
    AppError,
    repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base},
    space::types::SpaceGitType,
};

pub(crate) async fn save(
    app: &AppHandle,
    state: &GitState,
    project: Option<&Path>,
    space: &Path,
    requested: Option<Vec<String>>,
) -> Result<super::publication_flow::SaveReport, AppError> {
    let cli = super::require_cli(state)?;
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
    super::local_repair::repair_scope_best_effort(app, project.unwrap_or(space), space).await;
    let lock = state.get_lock(&repo).await;
    let _guard = lock.lock().await;
    access::require_repository_mutation(app, &repo).await?;
    super::branch::prepare_existing(&cli, &repo).await?;

    let anchors = requested.as_ref().map(|paths| {
        paths
            .iter()
            .map(|path| space.join(path))
            .collect::<Vec<_>>()
    });
    let mut pending = state.pending().begin_save(space, anchors.as_deref());
    let selected = match requested {
        Some(paths) => paths,
        None => ops::status(&cli, space)
            .await?
            .files
            .into_iter()
            .filter(|file| !super::local_policy::contains(&file.path))
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
    ops::commit_paths(&cli, &repo, &paths).await?;
    pending.complete();
    let parent = if let Some(project) = project.filter(|_| kind == SpaceGitType::Submodule) {
        let expected = ops::repository_head_oid(&cli, &repo).await?;
        Some(
            super::publication_flow::parent_step(
                app, &cli, &repo, project, &expected, false, false,
            )
            .await,
        )
    } else {
        None
    };
    Ok(super::publication_flow::SaveReport {
        status: ops::status(&cli, space).await?,
        parent,
    })
}
