//! The uncommitted groups of an area, as «Зафиксировать с агентом» hands
//! them to an agent (Stage 11 1.G «Пересказ смысла»): the groups an explicit
//! commit of the same paths would make, each with the facts of its message
//! and the paths its commit takes. Nothing is staged or committed. A path
//! in a sensitive Collection is named by its Collection's folder, never by
//! its file name, which carries the record's title.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::super::GitError;
use super::super::ops;
use super::super::path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use super::super::state::GitRuntime;
use super::auto::{nested_repository, repository_of};
use super::changes::{ChangeStatus, PathChange, Sources};
use super::facts::{facts_of, sensitive_collection_of};
use super::group::{GroupKind, PendingOperation, at_or_under, group_changes};
use super::{MessageLanguage, compose};

/// The uncommitted groups of an area in one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UncommittedGroups {
    /// The repository the paths of the groups are relative to.
    pub repository: PathBuf,
    pub groups: Vec<UncommittedGroup>,
}

/// One group: what one commit takes, as its message would describe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UncommittedGroup {
    pub kind: GroupKind,
    /// The summary line of the message Svode would write.
    pub header: String,
    /// Every fact of the group, when the summary does not say them all.
    pub facts: Vec<String>,
    /// Repository-relative paths the commit of the group takes.
    pub paths: Vec<String>,
    /// Files of sensitive Collections the group takes, named by folder.
    pub hidden: Vec<HiddenFiles>,
}

/// Files of a sensitive Collection, counted instead of named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenFiles {
    /// The Collection's folder, relative to the repository.
    pub folder: String,
    pub files: usize,
}

/// The uncommitted groups of `paths` (relative to `space`, a Space or a
/// repository) with messages in `language`. Conflicted paths and Space
/// pointers that are repositories of their own are left out, as a commit
/// leaves them.
pub async fn uncommitted(
    runtime: &GitRuntime,
    space: &Path,
    paths: &[String],
    language: MessageLanguage,
) -> Result<UncommittedGroups, GitError> {
    let cli = runtime.require_cli()?;
    let repo = repository_of(space).ok_or_else(|| {
        GitError::PathNotAccessible(format!("no repository holds {}", space.display()))
    })?;
    let prefix = repo_relative_from_base(&repo, space, RootMode::Allow)?;
    let area = paths
        .iter()
        .map(|path| {
            let path = normalize_repo_relative(path, RootMode::Reject)?;
            Ok(if prefix == "." {
                path
            } else {
                format!("{prefix}/{path}")
            })
        })
        .collect::<Result<Vec<_>, GitError>>()?;
    let mut result = UncommittedGroups {
        repository: repo.clone(),
        groups: Vec::new(),
    };
    if area.is_empty() {
        return Ok(result);
    }

    let status = ops::full_status(&cli, &repo).await?;
    let changes = status
        .files
        .iter()
        .filter(|file| file.state != "conflict" && !nested_repository(&repo, &file.path))
        .filter(|file| area.iter().any(|root| at_or_under(&file.path, root)))
        .map(|file| PathChange {
            status: match file.state.as_str() {
                "untracked" => ChangeStatus::Added,
                "deleted" => ChangeStatus::Deleted,
                _ => ChangeStatus::Modified,
            },
            path: file.path.clone(),
            from: None,
            gitlink: false,
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Ok(result);
    }
    let operations = runtime
        .pending()
        .peek_under(&repo)
        .into_iter()
        .filter(|registration| repository_of(&registration.space).as_deref() == Some(&*repo))
        .map(|registration| {
            PendingOperation::registered(
                &repo,
                registration.change.as_ref(),
                registration.paths.as_slice(),
            )
        })
        .collect::<Vec<_>>();
    let sources = Sources::read(&cli, &repo, &changes).await;
    for group in group_changes(&repo, changes, &operations, &sources) {
        let message = compose(&facts_of(&repo, &group, &sources), language);
        let mut paths = Vec::new();
        let mut hidden = Vec::<HiddenFiles>::new();
        for path in group.paths() {
            match sensitive_collection_of(&repo, &path) {
                Some(folder) => {
                    let folder = if folder.is_empty() {
                        ".".into()
                    } else {
                        folder
                    };
                    match hidden.iter_mut().find(|known| known.folder == folder) {
                        Some(known) => known.files += 1,
                        None => hidden.push(HiddenFiles { folder, files: 1 }),
                    }
                }
                None => paths.push(path),
            }
        }
        result.groups.push(UncommittedGroup {
            kind: group.kind,
            header: message.header,
            facts: message.body,
            paths,
            hidden,
        });
    }
    Ok(result)
}
