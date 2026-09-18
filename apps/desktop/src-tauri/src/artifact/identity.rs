use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactKind {
    Page,
    Document,
    Media,
}

impl ArtifactKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Document => "document",
            Self::Media => "media",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContentOwnerKind {
    Space,
    Collection,
    Routine,
    AgentContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PageRole {
    Standalone,
    CollectionItem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceShape {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MarkdownIdentityFacts<'a> {
    pub path: &'a str,
    pub source_shape: SourceShape,
    pub collection_root: Option<&'a str>,
    pub agent_context: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticIdentity {
    pub artifact_kind: Option<ArtifactKind>,
    pub owner_kind: Option<ContentOwnerKind>,
    pub page_role: Option<PageRole>,
    pub source_shape: SourceShape,
}

impl SemanticIdentity {
    pub(crate) fn is_page(self) -> bool {
        self.artifact_kind == Some(ArtifactKind::Page)
    }

    pub(crate) fn is_collection_item(self) -> bool {
        self.page_role == Some(PageRole::CollectionItem)
    }
}

pub(crate) fn resolve_markdown_identity(facts: MarkdownIdentityFacts<'_>) -> SemanticIdentity {
    let owner_kind = if is_space_readme(facts.path) {
        Some(ContentOwnerKind::Space)
    } else if is_routine_source(facts.path) {
        Some(ContentOwnerKind::Routine)
    } else if facts.agent_context {
        Some(ContentOwnerKind::AgentContext)
    } else if facts.collection_root.is_some_and(|root| {
        facts
            .path
            .eq_ignore_ascii_case(&collection_readme_path(root))
    }) {
        Some(ContentOwnerKind::Collection)
    } else {
        None
    };

    SemanticIdentity {
        artifact_kind: owner_kind.is_none().then_some(ArtifactKind::Page),
        owner_kind,
        page_role: owner_kind
            .is_none()
            .then_some(if facts.collection_root.is_some() {
                PageRole::CollectionItem
            } else {
                PageRole::Standalone
            }),
        source_shape: facts.source_shape,
    }
}

pub(crate) fn resolve_markdown_identity_for_path(
    space: &Path,
    path: &str,
    agent_context: bool,
) -> Result<SemanticIdentity, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let collection_root =
        collection_root_for_markdown(space, &path).map(|root| relative_display(&root));
    let source_shape = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
        .then_some(SourceShape::Directory)
        .unwrap_or(SourceShape::File);

    Ok(resolve_markdown_identity(MarkdownIdentityFacts {
        path: &path,
        source_shape,
        collection_root: collection_root.as_deref(),
        agent_context,
    }))
}

fn collection_root_for_markdown(space: &Path, path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf);
    let is_readme = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));

    if is_readme
        && let Some(owner) = parent.as_ref()
        && space.join(owner).join("schema.yaml").is_file()
    {
        return Some(owner.clone());
    }

    let mut candidate = if is_readme {
        parent
            .and_then(|owner| owner.parent().map(Path::to_path_buf))
            .unwrap_or_default()
    } else {
        parent.unwrap_or_default()
    };
    loop {
        if space.join(&candidate).join("schema.yaml").is_file() {
            return Some(candidate);
        }
        if candidate.as_os_str().is_empty() {
            return None;
        }
        candidate = candidate
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default();
    }
}

fn relative_display(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

fn is_space_readme(path: &str) -> bool {
    let mut components = Path::new(path).components();
    matches!(components.next(), Some(Component::Normal(value)) if value.to_string_lossy().eq_ignore_ascii_case("readme.md"))
        && components.next().is_none()
}

fn is_routine_source(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| matches!(component, Component::Normal(value) if value == ".routines"))
}

fn collection_readme_path(root: &str) -> String {
    if root.is_empty() || root == "." {
        "README.md".to_string()
    } else {
        format!("{}/README.md", root.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(path: &'a str, collection_root: Option<&'a str>) -> MarkdownIdentityFacts<'a> {
        MarkdownIdentityFacts {
            path,
            source_shape: SourceShape::File,
            collection_root,
            agent_context: false,
        }
    }

    #[test]
    fn owner_identity_precedes_page_projection() {
        let space = resolve_markdown_identity(facts("README.md", None));
        assert_eq!(space.owner_kind, Some(ContentOwnerKind::Space));
        assert!(!space.is_page());

        let collection = resolve_markdown_identity(facts("tasks/README.md", Some("tasks")));
        assert_eq!(collection.owner_kind, Some(ContentOwnerKind::Collection));
        assert!(!collection.is_page());

        let mut agent_facts = facts("AGENTS.md", None);
        agent_facts.agent_context = true;
        let agent = resolve_markdown_identity(agent_facts);
        assert_eq!(agent.owner_kind, Some(ContentOwnerKind::AgentContext));
        assert!(!agent.is_page());

        let routine = resolve_markdown_identity(facts(".routines/daily.md", None));
        assert_eq!(routine.owner_kind, Some(ContentOwnerKind::Routine));
        assert!(!routine.is_page());
    }

    #[test]
    fn standalone_and_collection_items_share_page_artifact_kind() {
        let standalone = resolve_markdown_identity(facts("notes/idea.md", None));
        assert!(standalone.is_page());
        assert_eq!(standalone.page_role, Some(PageRole::Standalone));

        let item = resolve_markdown_identity(facts("tasks/item.md", Some("tasks")));
        assert!(item.is_page());
        assert!(item.is_collection_item());
    }

    #[test]
    fn filesystem_classification_handles_root_owner_collection_owner_and_membership() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("tasks/nested")).unwrap();
        std::fs::write(temp.path().join("tasks/schema.yaml"), "malformed: [").unwrap();

        let root = resolve_markdown_identity_for_path(temp.path(), "README.md", false).unwrap();
        let owner =
            resolve_markdown_identity_for_path(temp.path(), "tasks/README.md", false).unwrap();
        let item = resolve_markdown_identity_for_path(temp.path(), "tasks/item.md", false).unwrap();
        let nested_owner =
            resolve_markdown_identity_for_path(temp.path(), "tasks/nested/README.md", false)
                .unwrap();

        assert_eq!(root.owner_kind, Some(ContentOwnerKind::Space));
        assert_eq!(owner.owner_kind, Some(ContentOwnerKind::Collection));
        assert_eq!(item.page_role, Some(PageRole::CollectionItem));
        assert_eq!(nested_owner.page_role, Some(PageRole::CollectionItem));
    }

    #[test]
    fn filesystem_classification_rejects_non_relative_paths() {
        let temp = tempfile::tempdir().unwrap();
        assert!(resolve_markdown_identity_for_path(temp.path(), "../outside.md", false).is_err());
    }
}
