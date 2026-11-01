use std::collections::BTreeMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Read;
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

#[derive(Debug, PartialEq, Eq, Hash)]
pub enum SourceValue {
    Missing,
    File(Vec<u8>),
    Directory,
    Symlink(PathBuf),
}

pub type SourceStamp = BTreeMap<PathBuf, SourceValue>;

/// The Git state of a repository a state change signal compares: its HEAD,
/// index and refs (loose, packed, reftable table lists) by content. A lock
/// file is not part of it until Git renames it into place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StateFingerprint(u64);

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

    /// Read the current [`StateFingerprint`] of the repository.
    pub fn state(&self) -> Result<StateFingerprint, GitError> {
        let mut hasher = DefaultHasher::new();
        self.repository.hash(&mut hasher);
        let head = &self.files[0];
        let packed_refs = &self.files[3];
        let gitfile = self.repository.join(".git");
        let tables = self
            .files
            .iter()
            .filter(|file| file.ends_with("reftable/tables.list"));
        for path in [head, &self.index, packed_refs, &gitfile]
            .into_iter()
            .chain(tables)
        {
            hash_source(path, &mut hasher)?;
        }
        let mut refs = BTreeMap::new();
        read_refs(&self.refs, &mut refs)?;
        refs.hash(&mut hasher);
        Ok(StateFingerprint(hasher.finish()))
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

/// Hash a state input by its kind and content, streaming the file so a
/// large index is not held in memory.
fn hash_source(path: &Path, hasher: &mut impl Hasher) -> Result<(), GitError> {
    path.hash(hasher);
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            hasher.write_u8(1);
            fs::read_link(path)?.hash(hasher);
        }
        Ok(metadata) if metadata.is_dir() => hasher.write_u8(2),
        Ok(_) => match fs::File::open(path) {
            Ok(mut file) => {
                hasher.write_u8(3);
                let mut buffer = [0; 64 * 1024];
                loop {
                    let read = file.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hasher.write(&buffer[..read]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => hasher.write_u8(0),
            Err(error) => return Err(error.into()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => hasher.write_u8(0),
        Err(error) => return Err(error.into()),
    }
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
            let state = sources.state().unwrap();
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
            assert_ne!(sources.state().unwrap(), state, "{path:?}");
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
        let state = sources.state().unwrap();
        git(&cli, &linked, &["checkout", "-q", "repo"]).await;
        assert_ne!(sources.stamp().unwrap(), before);
        assert_ne!(sources.state().unwrap(), state);
    }

    /// DF-289 R1: the state a change signal compares is HEAD, the index and
    /// the refs by content; lock files, config and other Git files are not.
    #[tokio::test]
    async fn the_state_fingerprint_follows_head_index_and_refs_only() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let out = cli
            .exec(&root, &["-c", "init.defaultRefFormat=files", "init", "-q"])
            .await
            .unwrap();
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        let commit = [
            "-c",
            "user.name=F",
            "-c",
            "user.email=f@example.test",
            "commit",
            "-q",
        ];
        git(
            &cli,
            &root,
            &[&commit[..], &["--allow-empty", "-m", "one"]].concat(),
        )
        .await;
        let sources = ActorSources::resolve(&cli, &root).await.unwrap();
        let git_dir = root.join(".git");
        let state = sources.state().unwrap();
        assert_eq!(sources.state().unwrap(), state, "stable without a change");

        // Git files that are not the state, and locks Git never renamed into place.
        for lock in [
            "index.lock",
            "HEAD.lock",
            "packed-refs.lock",
            "refs/heads/main.lock",
        ] {
            std::fs::write(git_dir.join(lock), "pending").unwrap();
        }
        std::fs::write(git_dir.join("FETCH_HEAD"), "fetched").unwrap();
        git(&cli, &root, &["config", "svode.probe", "true"]).await;
        assert_eq!(sources.state().unwrap(), state);
        for lock in [
            "index.lock",
            "HEAD.lock",
            "packed-refs.lock",
            "refs/heads/main.lock",
        ] {
            std::fs::remove_file(git_dir.join(lock)).unwrap();
        }
        assert_eq!(sources.state().unwrap(), state);

        // Each of the index, HEAD and the refs changes it.
        let mut previous = state;
        std::fs::write(root.join("page.md"), "page").unwrap();
        let steps: [&[&str]; 5] = [
            &["add", "page.md"],
            &[&commit[..], &["-m", "two"]].concat(),
            &["update-ref", "refs/heads/other", "HEAD"],
            &["pack-refs", "--all", "--prune"],
            &["symbolic-ref", "HEAD", "refs/heads/other"],
        ];
        for step in steps {
            git(&cli, &root, step).await;
            let current = sources.state().unwrap();
            assert_ne!(current, previous, "{step:?}");
            previous = current;
        }
    }

    #[tokio::test]
    async fn git_state_inputs_are_head_index_and_ref_storage_only() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        // The `files` ref store, whatever the user's `init.defaultRefFormat`.
        let out = cli
            .exec(&root, &["-c", "init.defaultRefFormat=files", "init", "-q"])
            .await
            .unwrap();
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
