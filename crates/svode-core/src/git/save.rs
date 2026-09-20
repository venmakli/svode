use std::path::Path;

use super::GitError;
use super::host::GitHost;
use super::state::GitRuntime;
use super::{ops, path::contained_file};
use crate::{
    git::path::{RootMode, normalize_repo_relative, repo_relative_from_base},
    storage::config::SpaceGitType,
};

/// One explicit user save: a scoped set of paths, its pending structural
/// companions and, for a submodule Space, the parent pointer step.
pub async fn save(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: Option<&Path>,
    space: &Path,
    requested: Option<Vec<String>>,
) -> Result<super::flow::SaveReport, GitError> {
    let cli = runtime.require_cli()?;
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
    super::local_repair::repair_scope_best_effort(runtime, host, project.unwrap_or(space), space)
        .await;
    let lock = runtime.get_lock(&repo).await;
    let _guard = lock.lock().await;
    host.authorize_repository(&repo).await?;
    super::branch::prepare_existing(&cli, &repo).await?;

    let anchors = requested.as_ref().map(|paths| {
        paths
            .iter()
            .map(|path| space.join(path))
            .collect::<Vec<_>>()
    });
    let mut pending = runtime.pending().begin_save(space, anchors.as_deref());
    let selected = match requested {
        Some(paths) => paths,
        None => ops::status(&cli, space)
            .await?
            .files
            .into_iter()
            .filter(|file| !super::policy::contains(&file.path))
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
        contained_file(&repo, path)?;
    }
    let affected = paths.iter().map(|path| repo.join(path)).collect::<Vec<_>>();
    host.authorize_paths(affected).await?;
    ops::commit_paths(&cli, &repo, &paths).await?;
    pending.complete();
    let parent = if let Some(project) = project.filter(|_| kind == SpaceGitType::Submodule) {
        let expected = ops::repository_head_oid(&cli, &repo).await?;
        Some(
            super::flow::parent_step(runtime, host, &cli, &repo, project, &expected, false, false)
                .await,
        )
    } else {
        None
    };
    Ok(super::flow::SaveReport {
        status: ops::status(&cli, space).await?,
        parent,
    })
}
