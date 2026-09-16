use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::cli::GitCli;
use crate::error::AppError;

/// Only the local inputs of the Human Actors projection, never the object store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ActorSources {
    pub repository: PathBuf,
    files: Vec<PathBuf>,
    refs: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SourceValue {
    Missing,
    File(Vec<u8>),
    Directory,
    Symlink(PathBuf),
}

pub(crate) type SourceStamp = BTreeMap<PathBuf, SourceValue>;

impl ActorSources {
    pub async fn resolve(cli: &GitCli, space: &Path) -> Result<Self, AppError> {
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
                ],
            )
            .await?;
        let paths: Vec<_> = result.stdout.lines().map(PathBuf::from).collect();
        if result.exit_code != 0 || paths.len() != 7 {
            return Err(AppError::GitCommandFailed(format!(
                "cannot resolve actor sources: {}",
                result.stderr.trim()
            )));
        }
        let repository = fs::canonicalize(&paths[0])?;
        let mut files = paths[1..6].to_vec();
        files.push(repository.join(".mailmap"));
        files.push(repository.join(".git"));
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

    pub fn stamp(&self) -> Result<SourceStamp, AppError> {
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

fn read_source(path: &Path, stamp: &mut SourceStamp) -> Result<(), AppError> {
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

fn read_refs(path: &Path, stamp: &mut SourceStamp) -> Result<(), AppError> {
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
