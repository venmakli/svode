use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::GitError;
use super::cli::GitCli;

/// The local files Desktop observes for a repository, never the object
/// store: the inputs of the Human Actors projection, and the index whose
/// change, like one of HEAD or the refs, means a Git operation outside Svode
/// changed the status (a commit, reset or checkout of an agent or a terminal).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActorSources {
    pub repository: PathBuf,
    files: Vec<PathBuf>,
    refs: PathBuf,
    index: PathBuf,
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
                    "--git-path",
                    "index",
                ],
            )
            .await?;
        let paths: Vec<_> = result.stdout.lines().map(PathBuf::from).collect();
        if result.exit_code != 0 || paths.len() != 9 {
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
            index: paths[8].clone(),
        })
    }

    /// Whether a change at `path` is an input of the Human Actors projection.
    pub fn contains(&self, path: &Path) -> bool {
        self.files.iter().any(|file| file.starts_with(path)) || path.starts_with(&self.refs)
    }

    /// Whether a change at `path` may change the status or the branch
    /// counters of the repository: HEAD, the index, packed refs, loose refs,
    /// a reftable table list or the gitfile. Lock files count as their
    /// target, since Git renames them into place.
    pub fn changes_state(&self, path: &Path) -> bool {
        let path = match path.to_str().and_then(|text| text.strip_suffix(".lock")) {
            Some(target) => Path::new(target),
            None => path,
        };
        let head = &self.files[0];
        let packed_refs = &self.files[3];
        let gitfile = self.repository.join(".git");
        // A backend may report the Git directory itself for a change in it.
        path == head
            || path == self.index
            || Some(path) == self.index.parent()
            || path == packed_refs
            || path == gitfile
            || path.starts_with(&self.refs)
            || self
                .files
                .iter()
                .any(|file| file == path && file.ends_with("reftable/tables.list"))
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
        if let Some(parent) = self.index.parent() {
            paths.insert(parent.to_path_buf(), false);
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
            // The same table lists tell the Git indicators about the update.
            let lists = sources
                .files
                .iter()
                .filter(|file| file.ends_with("reftable/tables.list"))
                .collect::<Vec<_>>();
            assert!(!lists.is_empty(), "{path:?}");
            assert!(lists.iter().all(|list| sources.changes_state(list)));
        }
        // HEAD of the linked worktree lives in its own reftable stack.
        let sources = ActorSources::resolve(&cli, &linked).await.unwrap();
        let before = sources.stamp().unwrap();
        git(&cli, &linked, &["checkout", "-q", "repo"]).await;
        assert_ne!(sources.stamp().unwrap(), before);
    }

    #[tokio::test]
    async fn git_state_inputs_are_head_index_and_ref_storage_only() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let out = cli.exec(&root, &["init", "-q"]).await.unwrap();
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        let sources = ActorSources::resolve(&cli, &root).await.unwrap();
        let git = sources.repository.join(".git");
        for path in [
            git.join("HEAD"),
            git.join("HEAD.lock"),
            git.join("index"),
            git.join("index.lock"),
            git.join("packed-refs"),
            git.join("refs/heads/main"),
            git.join("refs/remotes/origin/main.lock"),
            git.clone(),
        ] {
            assert!(sources.changes_state(&path), "{}", path.display());
        }
        for path in [
            git.join("config"),
            git.join("config.lock"),
            git.join("FETCH_HEAD"),
            git.join("objects/ab/cdef"),
            // A `files` store has no table list.
            git.join("reftable/tables.list"),
            sources.repository.join(".mailmap"),
            sources.repository.join("notes.md"),
            sources.repository.clone(),
        ] {
            assert!(!sources.changes_state(&path), "{}", path.display());
        }
        assert!(
            sources
                .watch_paths()
                .iter()
                .any(|(path, recursive)| *path == git && !recursive)
        );
    }
}
