//! Owner and role checks of public content tools.

use std::path::Path;

use svode_core::page::identity::{
    ContentOwnerKind, PageRole, SemanticIdentity, resolve_markdown_identity_for_path,
};

use crate::error::McpBusinessError;

pub fn semantic_identity_for_path(
    space: &str,
    path: &str,
) -> Result<SemanticIdentity, McpBusinessError> {
    resolve_markdown_identity_for_path(
        Path::new(space),
        path,
        svode_core::index::knowledge::is_agent_context_source(path),
    )
    .map_err(Into::into)
}

pub fn require_standalone_page(space: &str, path: &str) -> Result<(), McpBusinessError> {
    let identity = semantic_identity_for_path(space, path)?;
    if identity.is_page() && identity.page_role == Some(PageRole::Standalone) {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "NOT_A_STANDALONE_PAGE",
        "path belongs to owner content or a Collection item; use its canonical owner-specific tool",
    ))
}

pub fn require_collection_item(space: &str, path: &str) -> Result<(), McpBusinessError> {
    if semantic_identity_for_path(space, path)?.is_collection_item() {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "NOT_A_COLLECTION_ITEM",
        "path is not an item inside a schema-backed Collection",
    ))
}

pub fn require_owner(
    space: &str,
    path: &str,
    expected: ContentOwnerKind,
) -> Result<(), McpBusinessError> {
    if semantic_identity_for_path(space, path)?.owner_kind == Some(expected) {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "CONTENT_OWNER_MISMATCH",
        "path does not belong to the requested content owner",
    ))
}

pub fn collection_readme_path(collection_path: &str) -> String {
    if collection_path.is_empty() || collection_path == "." {
        "README.md".to_string()
    } else {
        format!("{}/README.md", collection_path.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_identity_distinguishes_collection_owner_readme_from_item_page() {
        let temp = tempfile::tempdir().expect("temp dir");
        let collection = temp.path().join("tasks");
        std::fs::create_dir_all(&collection).expect("collection dir");
        std::fs::write(collection.join("schema.yaml"), "columns: []\nviews: []\n").expect("schema");

        let owner =
            semantic_identity_for_path(temp.path().to_string_lossy().as_ref(), "tasks/README.md")
                .expect("owner identity");
        let item =
            semantic_identity_for_path(temp.path().to_string_lossy().as_ref(), "tasks/item.md")
                .expect("item identity");

        assert_eq!(owner.owner_kind, Some(ContentOwnerKind::Collection));
        assert!(!owner.is_page());
        assert_eq!(item.page_role, Some(PageRole::CollectionItem));
        assert!(item.is_page());
    }
}
