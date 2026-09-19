use std::path::Path;

use crate::error::AppError;

pub(crate) use svode_core::page::identity::{
    ArtifactKind, ContentOwnerKind, MarkdownIdentityFacts, PageRole, SemanticIdentity, SourceShape,
    resolve_markdown_identity,
};

pub(crate) fn resolve_markdown_identity_for_path(
    space: &Path,
    path: &str,
    agent_context: bool,
) -> Result<SemanticIdentity, AppError> {
    svode_core::page::identity::resolve_markdown_identity_for_path(space, path, agent_context)
        .map_err(Into::into)
}
