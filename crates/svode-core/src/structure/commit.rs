use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::git::pending::StructuralChange;

use super::naming::{entry_relocation, entry_rename_op, grouped_abs_paths_by_space};

/// Host seam for the Git history a structural operation produces.
///
/// The operation decides which paths belong to which Space and what the entry
/// is called in history; the host owns pending batching, task scheduling and
/// the actual commit. A missing sink means "record no history", not "skip the
/// source change".
pub trait StructuralCommitSink: Send + Sync {
    /// Queue `paths` for the pending structural batch of `space`. Every
    /// registration of one operation carries the same `change` identity.
    fn schedule(&self, project: &Path, space: &Path, change: StructuralChange, paths: Vec<PathBuf>);

    /// Commit `paths` immediately under `message`, bypassing the pending batch.
    /// Used where a source rewrite must not stay uncommitted between steps.
    fn commit_now<'a>(
        &'a self,
        project: &'a Path,
        space: &'a Path,
        paths: Vec<PathBuf>,
        message: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

/// Schedule `paths` only when the Space belongs to an open Project.
pub(crate) fn schedule_structural_paths(
    commits: Option<&dyn StructuralCommitSink>,
    project_path: Option<&str>,
    space_path: &str,
    change: StructuralChange,
    paths: Vec<PathBuf>,
) {
    let (Some(commits), Some(project)) = (commits, project_path.filter(|path| !path.is_empty()))
    else {
        return;
    };
    commits.schedule(Path::new(project), Path::new(space_path), change, paths);
}

/// Schedule the history of a Page rename, split across the Spaces that own
/// the changed paths. The Page's own Space carries the relocation; the others
/// hold companion backlinks of the same operation.
pub fn schedule_rename(
    commits: Option<&dyn StructuralCommitSink>,
    project_path: Option<&str>,
    space: &str,
    from: &str,
    to: &str,
    changed_paths: &[PathBuf],
) {
    if commits.is_none() || changed_paths.is_empty() {
        return;
    }
    let change = StructuralChange::new(entry_rename_op(space, from, to));
    for (owner, paths) in grouped_abs_paths_by_space(project_path, space, changed_paths) {
        let change = if owner == Path::new(space) {
            change.clone().relocating(entry_relocation(space, from, to))
        } else {
            change.companion()
        };
        schedule_structural_paths(
            commits,
            project_path,
            &owner.to_string_lossy(),
            change,
            paths,
        );
    }
}
