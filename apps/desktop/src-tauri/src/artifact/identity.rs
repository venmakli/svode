use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactKind {
    Page,
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
}
