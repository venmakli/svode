//! Exact repository routing rule for one Svode-managed import.
//!
//! Extension-wide rules belong to the assets strategy; this writes only the
//! single generated path rule the import needs, verifies that Git actually
//! applies it, and restores the previous policy file when it does not.

use std::path::{Path, PathBuf};

use crate::git::GitError;
use crate::git::cli::GitCli;
use crate::git::state::GitRepositoryState;

use super::local_rules::local_gitignore;
use super::policy::{self, ManagedBinaryRoute, StoragePolicyError};
use super::routes::{
    LFS_PATHS_END, LFS_PATHS_START, parse_managed_paths, read_or_empty, rewrite_managed_path_block,
    write_or_remove,
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

/// Materialize only the exact rule required by one Svode-managed import. A
/// `local` route also keeps the extension block of `local_extensions` in
/// place and drops exact rules of gone paths.
pub async fn apply_managed_import_route(
    repository: &GitRepositoryState,
    cli: Option<&GitCli>,
    repo_dir: &Path,
    route: ManagedBinaryRoute,
    repo_relative_path: &str,
    local_extensions: &[String],
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
        ManagedBinaryRoute::LocalExtension | ManagedBinaryRoute::LocalThreshold => {
            Some(repo_dir.join(".gitignore"))
        }
        ManagedBinaryRoute::LfsThreshold => Some(repo_dir.join(".gitattributes")),
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::DirectGit => None,
    };

    let original = if let Some(path) = policy_path.as_ref() {
        let original = if path.exists() {
            Some(read_or_empty(path)?)
        } else {
            None
        };
        let current = original.as_deref().unwrap_or_default();
        let next = match route {
            ManagedBinaryRoute::LocalExtension => {
                local_gitignore(cli, repo_dir, current, local_extensions, &[]).await?
            }
            ManagedBinaryRoute::LocalThreshold => {
                local_gitignore(
                    cli,
                    repo_dir,
                    current,
                    local_extensions,
                    &[repo_relative_path.to_string()],
                )
                .await?
            }
            _ => {
                let mut paths = parse_managed_paths(current, LFS_PATHS_START, LFS_PATHS_END)?;
                paths.insert(repo_relative_path.to_string());
                rewrite_managed_path_block(current, LFS_PATHS_START, LFS_PATHS_END, &paths, true)
            }
        };
        if next != current {
            write_or_remove(path, &next)?;
            changed.push(path.clone());
        }
        original.map(|contents| (path.clone(), contents))
    } else {
        None
    };

    let verification = match route {
        ManagedBinaryRoute::LocalExtension | ManagedBinaryRoute::LocalThreshold => cli
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
        } else if let Some(path) = policy_path.as_ref() {
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
    use crate::storage::policy::{ManagedBinaryRoute, StoragePolicyError, check_lfs_filters};
    use crate::storage::routes::lfs_path_rule;
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
            ManagedBinaryRoute::LocalThreshold,
            "Topic/file [1].bin",
            &[],
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
            &[],
        )
        .await
        .expect_err("nested override must block LFS route");
        assert!(error.to_string().contains("not effective"));
        let attributes = std::fs::read_to_string(repo.join(".gitattributes")).unwrap_or_default();
        assert!(!attributes.contains("Topic/file.bin"));
        Ok(())
    }

    /// DF-380 R1, R2, R3 (a): a threshold route for a name with spaces is
    /// effective, and the block it writes also turns a rule left in the old
    /// backslash form into the quoted one.
    #[tokio::test]
    async fn a_threshold_route_for_a_name_with_spaces_is_effective_and_repairs_old_rules()
    -> Result<(), StoragePolicyError> {
        let Some(cli) = GitCli::detect().ok().filter(GitCli::lfs_available) else {
            return Ok(());
        };
        let repository = GitRepositoryState::new();
        let temp = tempfile::tempdir()?;
        let repo = temp.path();
        git_ok(&cli, repo, &["init"]).await?;
        let old_block = "*.custom merge=ours\n\
            # svode:assets-lfs-paths:start\n\
            # svode:path \"My Notes/big.mov\"\n\
            My\\ Notes/big.mov filter=lfs diff=lfs merge=lfs -text\n\
            # svode:assets-lfs-paths:end\n";
        std::fs::write(repo.join(".gitattributes"), old_block)?;
        let old = "My Notes/big.mov".to_string();
        assert_eq!(
            check_lfs_filters(&cli, repo, std::slice::from_ref(&old)).await?[0].value,
            "unspecified"
        );

        let imported = "Topic/Запись экрана 2026-10-07 в 12.06.16.mov";
        let changed = apply_managed_import_route(
            &repository,
            Some(&cli),
            repo,
            ManagedBinaryRoute::LfsThreshold,
            imported,
            &[],
        )
        .await?;

        assert_eq!(changed, vec![repo.join(".gitattributes")]);
        let attributes = std::fs::read_to_string(repo.join(".gitattributes"))?;
        assert!(
            attributes.starts_with("*.custom merge=ours\n"),
            "{attributes}"
        );
        assert!(
            attributes.contains(&lfs_path_rule(imported))
                && attributes.contains("\"My\\\\ Notes/big.mov\" filter=lfs")
                && !attributes.contains("\nMy\\ Notes/big.mov"),
            "{attributes}"
        );
        let checks = check_lfs_filters(&cli, repo, &[imported.to_string(), old]).await?;
        assert!(
            checks.iter().all(|check| check.value == "lfs"),
            "{checks:?}"
        );
        Ok(())
    }
}
