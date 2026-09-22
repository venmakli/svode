//! Mutation policy of the public MCP surface.
//!
//! MCP mutations are agent-origin and never autocommit: the library calls
//! the shared core operations without a commit sink, and Git history stays
//! an explicit user action. Before the first source write every repository
//! of the planned touched-set is authorized through the host access state.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;

use serde_json::json;
use svode_core::git::access::{local_repository_root, scope_authorized_mutation_paths};
use svode_core::git::cli::GitCli;
use svode_core::git::state::detected_cli;
use svode_core::page::PageError;
use svode_core::page::naming::DocumentNameConflict;
use svode_core::page::write::PageRuntime;

use crate::error::McpBusinessError;
use crate::host::{McpHost, MutationRuntime};
use crate::protocol::{ContentBlock, ToolCallResult};

/// Failure of a shared mutation: core errors keep their evidence until the
/// public projection, host failures are already business errors.
pub(crate) enum MutationError {
    Page(PageError),
    Business(McpBusinessError),
}

impl From<PageError> for MutationError {
    fn from(error: PageError) -> Self {
        Self::Page(error)
    }
}

impl From<McpBusinessError> for MutationError {
    fn from(error: McpBusinessError) -> Self {
        Self::Business(error)
    }
}

impl From<MutationError> for McpBusinessError {
    fn from(error: MutationError) -> Self {
        match error {
            MutationError::Page(error) => error.into(),
            MutationError::Business(error) => error,
        }
    }
}

/// Public projection of a failed mutation. A name conflict keeps its
/// container and conflicting Page evidence.
pub(crate) fn failure(error: MutationError) -> Result<ToolCallResult, McpBusinessError> {
    match error {
        MutationError::Page(PageError::DocumentNameConflict(conflict)) => {
            Ok(page_name_conflict_result(conflict))
        }
        error => Err(error.into()),
    }
}

fn page_name_conflict_result(conflict: DocumentNameConflict) -> ToolCallResult {
    let message = "Page name is already used in this container";
    ToolCallResult {
        content: vec![ContentBlock::text(message)],
        structured_content: Some(json!({
            "error": {
                "code": "PAGE_NAME_CONFLICT",
                "message": message,
                "parentPath": conflict.parent_path,
                "conflicts": conflict.conflicts,
            }
        })),
        is_error: true,
    }
}

/// Authorizes the planned touched-set of a mutation in `space`: every
/// distinct local repository once, all before the first write.
pub(crate) async fn authorize(
    host: &impl McpHost,
    space: &str,
    mut paths: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, MutationError> {
    paths.push(PathBuf::from(space));
    authorize_paths(host, paths).await
}

/// Authorizes exactly the planned touched-set, without adding its Space.
pub(crate) async fn authorize_paths(
    host: &impl McpHost,
    paths: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, MutationError> {
    let mut repositories = HashSet::new();
    for path in &paths {
        let repository = local_repository_root(path).map_err(McpBusinessError::from)?;
        if repositories.insert(repository.clone()) {
            host.require_mutation_access(&repository).await?;
        }
    }
    Ok(paths)
}

/// Runs an operation that re-checks its touched-set against the repositories
/// authorized before it started.
pub(crate) async fn within_authorized<T>(
    paths: Vec<PathBuf>,
    operation: impl Future<Output = Result<T, McpBusinessError>>,
) -> Result<T, McpBusinessError> {
    scope_authorized_mutation_paths(paths, operation, McpBusinessError::from).await
}

/// Host mutation runtime with the detected Git CLI as date provider.
pub(crate) struct PageHandles<'a> {
    pub(crate) runtime: MutationRuntime<'a>,
    git_dates: Option<GitCli>,
}

impl<'a> PageHandles<'a> {
    pub(crate) fn of(host: &'a impl McpHost) -> Self {
        Self {
            runtime: host.mutation_runtime(),
            git_dates: detected_cli(),
        }
    }

    pub(crate) fn page(&self) -> PageRuntime<'_, GitCli> {
        PageRuntime {
            index: self.runtime.index,
            updates: self.runtime.updates,
            nonces: self.runtime.nonces,
            git_dates: self.git_dates.as_ref(),
        }
    }

    pub(crate) fn git_dates(&self) -> Option<&GitCli> {
        self.git_dates.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svode_core::page::naming::DocumentNameConflictEvidence;

    #[test]
    fn name_conflict_result_preserves_container_and_conflicting_page_evidence() {
        let result = failure(MutationError::Page(PageError::DocumentNameConflict(
            DocumentNameConflict {
                parent_path: Some("docs".to_string()),
                conflicts: vec![DocumentNameConflictEvidence {
                    path: "docs/existing.md".to_string(),
                    title: "Existing".to_string(),
                }],
            },
        )))
        .unwrap();

        assert!(result.is_error);
        let error = &result.structured_content.unwrap()["error"];
        assert_eq!(error["code"], "PAGE_NAME_CONFLICT");
        assert_eq!(error["parentPath"], "docs");
        assert_eq!(error["conflicts"][0]["path"], "docs/existing.md");
        assert_eq!(error["conflicts"][0]["title"], "Existing");
    }
}
