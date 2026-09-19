use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::source::PageSourceError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Page,
    Document,
    Media,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Document => "document",
            Self::Media => "media",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentOwnerKind {
    Space,
    Collection,
    Routine,
    AgentContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageRole {
    Standalone,
    CollectionItem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceShape {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkdownIdentityFacts<'a> {
    pub path: &'a str,
    pub source_shape: SourceShape,
    pub collection_root: Option<&'a str>,
    pub agent_context: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIdentity {
    pub artifact_kind: Option<ArtifactKind>,
    pub owner_kind: Option<ContentOwnerKind>,
    pub page_role: Option<PageRole>,
    pub source_shape: SourceShape,
}

impl SemanticIdentity {
    pub fn is_page(self) -> bool {
        self.artifact_kind == Some(ArtifactKind::Page)
    }
    pub fn is_collection_item(self) -> bool {
        self.page_role == Some(PageRole::CollectionItem)
    }
}

pub fn resolve_markdown_identity(facts: MarkdownIdentityFacts<'_>) -> SemanticIdentity {
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

pub fn resolve_markdown_identity_for_path(
    space: &Path,
    path: &str,
    agent_context: bool,
) -> Result<SemanticIdentity, PageSourceError> {
    let path = super::source::normalize_page_path(path)?;
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
        ".".into()
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

pub fn is_agent_context_source(source_path: &str) -> bool {
    let path = Path::new(source_path);
    let filename = path.file_name().and_then(|name| name.to_str());
    if matches!(
        filename,
        Some(
            "AGENTS.md"
                | "AGENTS.override.md"
                | "CLAUDE.md"
                | "CLAUDE.local.md"
                | "GEMINI.md"
                | "SOUL.md"
                | "USER.md"
                | "MEMORY.md"
        )
    ) {
        return true;
    }
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    components
        .windows(2)
        .any(|parts| matches!(parts, [".agents", "skills"] | [".claude", "skills"]))
}

fn collection_readme_path(root: &str) -> String {
    if root.is_empty() || root == "." {
        "README.md".into()
    } else {
        format!("{}/README.md", root.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_precedence_and_nested_collection_role() {
        let facts = |path, collection_root| MarkdownIdentityFacts {
            path,
            collection_root,
            source_shape: SourceShape::File,
            agent_context: false,
        };
        assert_eq!(
            resolve_markdown_identity(facts("README.md", None)).owner_kind,
            Some(ContentOwnerKind::Space)
        );
        assert_eq!(
            resolve_markdown_identity(facts("tasks/README.md", Some("tasks"))).owner_kind,
            Some(ContentOwnerKind::Collection)
        );
        assert_eq!(
            resolve_markdown_identity(facts(".routines/daily.md", None)).owner_kind,
            Some(ContentOwnerKind::Routine)
        );
        assert_eq!(
            resolve_markdown_identity(facts("tasks/item.md", Some("tasks"))).page_role,
            Some(PageRole::CollectionItem)
        );
        assert_eq!(
            resolve_markdown_identity(facts("notes/idea.md", None)).page_role,
            Some(PageRole::Standalone)
        );
        assert!(is_agent_context_source("AGENTS.md"));
        assert!(is_agent_context_source(".agents/skills/test/SKILL.md"));
    }

    #[test]
    fn schema_markers_select_nearest_owner_without_reclassifying_nested_heads() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("tasks")).unwrap();
        std::fs::create_dir(temp.path().join("tasks/nested")).unwrap();
        std::fs::write(temp.path().join("tasks/schema.yaml"), "name: Tasks").unwrap();
        let head =
            resolve_markdown_identity_for_path(temp.path(), "tasks/README.md", false).unwrap();
        let item = resolve_markdown_identity_for_path(temp.path(), "tasks/item.md", false).unwrap();
        let nested =
            resolve_markdown_identity_for_path(temp.path(), "tasks/nested/README.md", false)
                .unwrap();
        assert_eq!(head.owner_kind, Some(ContentOwnerKind::Collection));
        assert_eq!(item.page_role, Some(PageRole::CollectionItem));
        assert_eq!(nested.page_role, Some(PageRole::CollectionItem));
        assert_eq!(nested.source_shape, SourceShape::Directory);
    }
}
