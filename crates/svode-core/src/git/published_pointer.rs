use super::GitError;
use super::cli::GitCli;
use std::{collections::BTreeSet, fs::OpenOptions, path::Path};

/// The project pointer moves only forward: a Space revision may replace the
/// recorded pointer only when its history contains that pointer.
pub async fn contains(
    cli: &GitCli,
    child: &Path,
    pointer: &str,
    revision: &str,
) -> Result<bool, GitError> {
    if pointer == revision {
        return Ok(true);
    }
    let out = cli
        .exec(child, &["merge-base", "--is-ancestor", pointer, revision])
        .await?;
    match out.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => {
            // A pointer absent from the Space history is not contained in it.
            let known = cli
                .exec(child, &["cat-file", "-e", &format!("{pointer}^{{commit}}")])
                .await?;
            if known.exit_code != 0 {
                Ok(false)
            } else {
                Err(GitError::GitCommandFailed(
                    "Cannot compare the project pointer with the Space revision".into(),
                ))
            }
        }
    }
}

/// The Space pointer `revision` of the project records at `path`, if any.
pub async fn recorded(
    cli: &GitCli,
    root: &Path,
    revision: &str,
    path: &str,
) -> Result<Option<String>, GitError> {
    let out = cli
        .exec_redacted(
            root,
            &[
                "ls-tree",
                "-z",
                revision,
                "--",
                &format!(":(literal){path}"),
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    Ok(gitlinks(&out.stdout)
        .find(|(entry, _)| *entry == path)
        .map(|(_, pointer)| pointer.to_string()))
}

/// Gitlink entries of NUL-separated `ls-tree` output as `(path, pointer)`.
fn gitlinks(listing: &str) -> impl Iterator<Item = (&str, &str)> {
    listing.split('\0').filter_map(|entry| {
        let (meta, path) = entry.split_once('\t')?;
        Some((path, meta.strip_prefix("160000 commit ")?))
    })
}

/// Recorded Space pointers among `paths` that the current Space checkout does
/// not contain: committing that checkout would move the pointer back.
pub async fn backward(
    cli: &GitCli,
    root: &Path,
    paths: &[String],
) -> Result<BTreeSet<String>, GitError> {
    if paths.is_empty() || !root.join(".gitmodules").is_file() {
        return Ok(BTreeSet::new());
    }
    let literals = paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect::<Vec<_>>();
    let mut args = vec!["ls-tree", "-r", "-z", "HEAD", "--"];
    args.extend(literals.iter().map(String::as_str));
    let out = cli.exec_redacted(root, &args).await?;
    if out.exit_code != 0 {
        // An unborn project records no pointer yet.
        let head = cli.exec(root, &["rev-parse", "--verify", "HEAD"]).await?;
        if head.exit_code != 0 {
            return Ok(BTreeSet::new());
        }
        return Err(GitError::GitCommandFailed(
            "Cannot read project pointers".into(),
        ));
    }
    let mut backward = BTreeSet::new();
    for (path, pointer) in gitlinks(&out.stdout) {
        let child = root.join(path);
        if child.join(".git").symlink_metadata().is_err() {
            continue;
        }
        let head = cli.exec(&child, &["rev-parse", "--verify", "HEAD"]).await?;
        if head.exit_code == 0 && !contains(cli, &child, pointer, head.stdout.trim()).await? {
            backward.insert(path.to_string());
        }
    }
    Ok(backward)
}

/// Commit only the revision that the child publisher actually sent. The caller
/// holds child then root locks; index.lock also excludes external Git staging.
pub async fn commit(
    cli: &GitCli,
    root: &Path,
    child: &Path,
    published: &str,
) -> Result<bool, GitError> {
    super::branch::ensure_no_operation(cli, root).await?;
    let path =
        crate::git::path::repo_relative_from_base(root, child, crate::git::path::RootMode::Reject)?;
    let old_head = super::ops::repository_head_oid(cli, root).await?;
    if super::ops::repository_head_oid(cli, child).await? != published {
        return Err(GitError::PublicationBlocked {
            repository: root.to_string_lossy().into_owned(),
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    if let Some(current) = recorded(cli, root, &old_head, &path).await? {
        if current == published {
            return Ok(false);
        }
        // The step checked this before; a project HEAD moved meanwhile is a new target.
        if !contains(cli, child, &current, published).await? {
            return Err(GitError::PublicationBlocked {
                repository: root.to_string_lossy().into_owned(),
                reason: super::publication::PublicationBlockReason::TargetChanged,
            });
        }
    }
    let index = cli
        .exec(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await?;
    if index.exit_code != 0 {
        return Err(GitError::GitCommandFailed(
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
    ) -> Result<String, GitError> {
        let out = cli
            .exec_with_env(root, args, &[("GIT_INDEX_FILE", &index.to_string_lossy())])
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(
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
