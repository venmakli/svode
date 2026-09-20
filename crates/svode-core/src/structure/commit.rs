use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::git::pending::StructuralOp;

/// Host seam for the Git history a structural operation produces.
///
/// The operation decides which paths belong to which Space and what the entry
/// is called in history; the host owns pending batching, task scheduling and
/// the actual commit. A missing sink means "record no history", not "skip the
/// source change".
pub trait StructuralCommitSink: Send + Sync {
    /// Queue `paths` for the pending structural batch of `space`.
    fn schedule(&self, project: &Path, space: &Path, op: StructuralOp, paths: Vec<PathBuf>);

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
    op: StructuralOp,
    paths: Vec<PathBuf>,
) {
    let (Some(commits), Some(project)) = (commits, project_path.filter(|path| !path.is_empty()))
    else {
        return;
    };
    commits.schedule(Path::new(project), Path::new(space_path), op, paths);
}
