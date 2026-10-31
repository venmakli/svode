use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::GitError;
use super::cli::GitCli;

/// Only the local inputs of the Human Actors projection, never the object store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActorSources {
    pub repository: PathBuf,
    files: Vec<PathBuf>,
    refs: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SourceValue {
    Missing,
    File(Vec<u8>),
    Directory,
    Symlink(PathBuf),
}

pub type SourceStamp = BTreeMap<PathBuf, SourceValue>;

impl ActorSources {
    pub async fn resolve(cli: &GitCli, space: &Path) -> Result<Self, GitError> {
        let result = cli
            .exec(
                space,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                    "--git-path",
                    "HEAD",
                    "--git-path",
                    "config",
                    "--git-path",
                    "config.worktree",
                    "--git-path",
                    "packed-refs",
                    "--git-path",
                    "shallow",
                    "--git-path",
                    "refs",
                    "--git-path",
                    "reftable/tables.list",
                ],
            )
            .await?;
        let paths: Vec<_> = result.stdout.lines().map(PathBuf::from).collect();
        if result.exit_code != 0 || paths.len() != 8 {
            return Err(GitError::GitCommandFailed(format!(
                "cannot resolve actor sources: {}",
                result.stderr.trim()
            )));
        }
        let repository = fs::canonicalize(&paths[0])?;
        let mut files = paths[1..6].to_vec();
        files.push(repository.join(".mailmap"));
        files.push(repository.join(".git"));
        // A reftable store rewrites its table list on every ref update; a
        // linked worktree keeps its own stack next to the common one. A
        // `files` store has no such directory to observe.
        let mut tables = vec![paths[7].clone()];
        if let Some(common) = paths[6].parent() {
            tables.push(common.join("reftable").join("tables.list"));
        }
        tables.dedup();
        files.extend(
            tables
                .into_iter()
                .filter(|list| list.parent().is_some_and(Path::is_dir)),
        );
        Ok(Self {
            repository,
            files,
            refs: paths[6].clone(),
        })
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.files.iter().any(|file| file.starts_with(path)) || path.starts_with(&self.refs)
    }

    pub fn watch_paths(&self) -> Vec<(PathBuf, bool)> {
        let mut paths = BTreeMap::new();
        for file in &self.files {
            if let Some(parent) = file.parent() {
                paths.insert(parent.to_path_buf(), false);
                if parent != self.repository
                    && let Some(anchor) = parent.parent()
                {
                    paths.insert(anchor.to_path_buf(), false);
                }
            }
        }
        if self.refs.is_dir() {
            paths.insert(self.refs.clone(), true);
        }
        paths.into_iter().collect()
    }

    pub fn stamp(&self) -> Result<SourceStamp, GitError> {
        let mut stamp = BTreeMap::new();
        for file in &self.files {
            // Ordinary repositories have a directory here; gitfiles are source inputs.
            if file == &self.repository.join(".git") && file.is_dir() {
                continue;
            }
            read_source(file, &mut stamp)?;
        }
        read_refs(&self.refs, &mut stamp)?;
        Ok(stamp)
    }
}

fn read_source(path: &Path, stamp: &mut SourceStamp) -> Result<(), GitError> {
    let value = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            SourceValue::Symlink(fs::read_link(path)?)
        }
        Ok(metadata) if metadata.is_dir() => SourceValue::Directory,
        Ok(_) => SourceValue::File(fs::read(path)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceValue::Missing,
        Err(error) => return Err(error.into()),
    };
    stamp.insert(path.to_path_buf(), value);
    Ok(())
}

fn read_refs(path: &Path, stamp: &mut SourceStamp) -> Result<(), GitError> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(".lock") {
            continue;
        }
        if entry.file_type()?.is_dir() {
            read_refs(&entry.path(), stamp)?;
        } else {
            read_source(&entry.path(), stamp)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::version::GitVersion;

    async fn git(cli: &GitCli, repo: &Path, args: &[&str]) {
        let out = cli.exec(repo, args).await.unwrap();
        assert_eq!(out.exit_code, 0, "{args:?}: {}", out.stderr);
    }

    #[tokio::test]
    async fn reftable_ref_updates_change_the_stamp_in_main_and_linked_worktrees() {
        let cli = GitCli::detect().unwrap();
        if cli
            .version()
            .is_none_or(|version| version < GitVersion::new(2, 45, 0))
        {
            eprintln!("skipped: no reftable in {:?}", cli.version());
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let linked = temp.path().join("linked");
        std::fs::create_dir(&repo).unwrap();
        git(
            &cli,
            &repo,
            &["init", "-q", "-b", "main", "--ref-format=reftable"],
        )
        .await;
        git(
            &cli,
            &repo,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial",
            ],
        )
        .await;
        git(
            &cli,
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                linked.to_str().unwrap(),
            ],
        )
        .await;
        for path in [&repo, &linked] {
            let sources = ActorSources::resolve(&cli, path).await.unwrap();
            let before = sources.stamp().unwrap();
            git(
                &cli,
                &repo,
                &[
                    "update-ref",
                    &format!("refs/heads/{}", path.file_name().unwrap().to_string_lossy()),
                    "HEAD",
                ],
            )
            .await;
            assert_ne!(sources.stamp().unwrap(), before, "{path:?}");
        }
        // HEAD of the linked worktree lives in its own reftable stack.
        let sources = ActorSources::resolve(&cli, &linked).await.unwrap();
        let before = sources.stamp().unwrap();
        git(&cli, &linked, &["checkout", "-q", "repo"]).await;
        assert_ne!(sources.stamp().unwrap(), before);
    }
}
