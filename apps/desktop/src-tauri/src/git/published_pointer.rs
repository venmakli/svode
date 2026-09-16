use super::cli::GitCli;
use crate::AppError;
use std::{fs::OpenOptions, path::Path};

/// Commit only the revision that the child publisher actually sent. The caller
/// holds child then root locks; index.lock also excludes external Git staging.
pub(crate) async fn commit(
    cli: &GitCli,
    root: &Path,
    child: &Path,
    published: &str,
) -> Result<bool, AppError> {
    super::branch::ensure_no_operation(cli, root).await?;
    let path =
        crate::repo_path::repo_relative_from_base(root, child, crate::repo_path::RootMode::Reject)?;
    let old_head = super::ops::repository_head_oid(cli, root).await?;
    if super::ops::repository_head_oid(cli, child).await? != published {
        return Err(AppError::GitPublicationBlocked {
            repository: root.to_string_lossy().into_owned(),
            child: Some(path),
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    let current = cli
        .exec(root, &["rev-parse", &format!("{old_head}:{path}")])
        .await?;
    if current.exit_code == 0 && current.stdout.trim() == published {
        return Ok(false);
    }
    let index = cli
        .exec(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await?;
    if index.exit_code != 0 {
        return Err(AppError::GitCommandFailed(
            "Cannot locate project index".into(),
        ));
    }
    let index = std::path::PathBuf::from(index.stdout.trim_end());
    let lock_path = index.with_file_name("index.lock");
    let lock_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)?;
    struct Lock(std::path::PathBuf);
    impl Drop for Lock {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _lock = Lock(lock_path.clone());
    drop(lock_file);
    let temp = tempfile::tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let commit_index = temp.path().join("commit-index");
    let preserved_index = temp.path().join("preserved-index");
    async fn run(
        cli: &GitCli,
        root: &Path,
        index: &Path,
        args: &[&str],
    ) -> Result<String, AppError> {
        let out = cli
            .exec_with_env(root, args, &[("GIT_INDEX_FILE", &index.to_string_lossy())])
            .await?;
        if out.exit_code != 0 {
            return Err(AppError::GitCommandFailed(
                "Project pointer commit failed; local content is preserved".into(),
            ));
        }
        Ok(out.stdout.trim_end().into())
    }
    run(cli, root, &commit_index, &["read-tree", &old_head]).await?;
    let cache = format!("160000,{published},{path}");
    run(
        cli,
        root,
        &commit_index,
        &["update-index", "--add", "--cacheinfo", &cache],
    )
    .await?;
    let tree = run(cli, root, &commit_index, &["write-tree"]).await?;
    if index.exists() {
        std::fs::copy(&index, &preserved_index)?;
    } else {
        run(cli, root, &preserved_index, &["read-tree", &old_head]).await?;
    }
    run(
        cli,
        root,
        &preserved_index,
        &["update-index", "--add", "--cacheinfo", &cache],
    )
    .await?;
    std::fs::copy(&preserved_index, &lock_path)?;
    let message = format!("Update {path}");
    let mut args = vec!["commit-tree", &tree, "-p", &old_head, "-m", &message];
    let signed = cli
        .exec(root, &["config", "--bool", "commit.gpgsign"])
        .await?;
    if signed.stdout.trim() == "true" {
        args.push("-S");
    }
    let commit = run(cli, root, &commit_index, &args).await?;
    run(
        cli,
        root,
        &commit_index,
        &[
            "update-ref",
            "-m",
            &format!("commit: {message}"),
            "HEAD",
            &commit,
            &old_head,
        ],
    )
    .await?;
    std::fs::rename(&lock_path, &index)?;
    Ok(true)
}
