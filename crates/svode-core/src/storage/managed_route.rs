//! Exact repository routing rule for one Svode-managed import.
//!
//! Extension-wide rules belong to the assets strategy; this writes only the
//! single generated path rule the import needs, verifies that Git actually
//! applies it, and restores the previous policy file when it does not.

use std::path::{Path, PathBuf};

use crate::git::GitError;
use crate::git::cli::GitCli;
use crate::git::state::GitRepositoryState;

use super::policy::{self, ManagedBinaryRoute, StoragePolicyError};
use super::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, parse_managed_paths,
    read_or_empty, rewrite_managed_path_block, write_or_remove,
};

fn restore_file(path: &Path, contents: Option<&str>) {
    match contents {
        Some(contents) => {
            let _ = std::fs::write(path, contents);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Materialize only the exact rule required by one Svode-managed import.
pub async fn apply_managed_import_route(
    repository: &GitRepositoryState,
    cli: Option<&GitCli>,
    repo_dir: &Path,
    route: ManagedBinaryRoute,
    repo_relative_path: &str,
) -> Result<Vec<PathBuf>, StoragePolicyError> {
    let cli = cli.ok_or(GitError::GitNotFound)?;
    if matches!(
        route,
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::LfsThreshold
    ) && !cli.lfs_available()
    {
        return Err(StoragePolicyError::Storage(
            "Git LFS route is not ready: git-lfs is not installed".to_string(),
        ));
    }

    let lock = repository.get_lock(repo_dir).await;
    let _guard = lock.lock().await;
    let mut changed = Vec::new();
    let policy_path = match route {
        ManagedBinaryRoute::Local => Some((
            repo_dir.join(".gitignore"),
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            false,
        )),
        ManagedBinaryRoute::LfsThreshold => Some((
            repo_dir.join(".gitattributes"),
            LFS_PATHS_START,
            LFS_PATHS_END,
            true,
        )),
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::DirectGit => None,
    };

    let original = if let Some((path, start, end, lfs)) = policy_path.as_ref() {
        let original = if path.exists() {
            Some(read_or_empty(path)?)
        } else {
            None
        };
        let current = original.as_deref().unwrap_or_default();
        let mut paths = parse_managed_paths(current, start, end)?;
        paths.insert(repo_relative_path.to_string());
        let next = rewrite_managed_path_block(current, start, end, &paths, *lfs);
        if next != current {
            write_or_remove(path, &next)?;
            changed.push(path.clone());
        }
        original.map(|contents| (path.clone(), contents))
    } else {
        None
    };

    let verification = match route {
        ManagedBinaryRoute::Local => cli
            .exec(
                repo_dir,
                &["check-ignore", "--quiet", "--", repo_relative_path],
            )
            .await
            .map_err(StoragePolicyError::from)
            .and_then(|output| {
                (output.exit_code == 0).then_some(()).ok_or_else(|| {
                    StoragePolicyError::Storage(format!(
                        "managed local route is not effective for `{repo_relative_path}`"
                    ))
                })
            }),
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::LfsThreshold => {
            policy::check_lfs_filters(cli, repo_dir, &[repo_relative_path.to_string()])
                .await
                .and_then(|checks| {
                    checks
                        .first()
                        .is_some_and(|check| check.value == "lfs")
                        .then_some(())
                        .ok_or_else(|| {
                            StoragePolicyError::Storage(format!(
                                "Git LFS route is not effective for `{repo_relative_path}`"
                            ))
                        })
                })
        }
        ManagedBinaryRoute::DirectGit => Ok(()),
    };

    if let Err(error) = verification {
        if let Some((path, contents)) = original.as_ref() {
            restore_file(path, Some(contents));
        } else if let Some((path, ..)) = policy_path.as_ref() {
            restore_file(path, None);
        }
        return Err(error);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::apply_managed_import_route;
    use crate::git::GitError;
    use crate::git::cli::GitCli;
    use crate::git::state::GitRepositoryState;
    use crate::storage::policy::{ManagedBinaryRoute, StoragePolicyError};
    use std::path::Path;

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), StoragePolicyError> {
        let output = cli.exec(repo, args).await?;
        if output.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                output.stderr.trim()
            ))
            .into());
        }
        Ok(())
    }

    #[tokio::test]
    async fn exact_rules_use_git_effective_resolution_and_fail_on_nested_override()
    -> Result<(), StoragePolicyError> {
        let Ok(cli) = GitCli::detect() else {
            return Ok(());
        };
        let repository = GitRepositoryState::new();
        let temp = tempfile::tempdir()?;
        let repo = temp.path();
        git_ok(&cli, repo, &["init"]).await?;

        apply_managed_import_route(
            &repository,
            Some(&cli),
            repo,
            ManagedBinaryRoute::Local,
            "Topic/file [1].bin",
        )
        .await?;
        let ignored = cli
            .exec(
                repo,
                &["check-ignore", "--quiet", "--", "Topic/file [1].bin"],
            )
            .await?;
        assert_eq!(ignored.exit_code, 0);

        if !cli.lfs_available() {
            return Ok(());
        }
        std::fs::create_dir_all(repo.join("Topic"))?;
        std::fs::write(repo.join("Topic/.gitattributes"), "file.bin -filter\n")?;
        let error = apply_managed_import_route(
            &repository,
            Some(&cli),
            repo,
            ManagedBinaryRoute::LfsThreshold,
            "Topic/file.bin",
        )
        .await
        .expect_err("nested override must block LFS route");
        assert!(error.to_string().contains("not effective"));
        let attributes = std::fs::read_to_string(repo.join(".gitattributes")).unwrap_or_default();
        assert!(!attributes.contains("Topic/file.bin"));
        Ok(())
    }
}
