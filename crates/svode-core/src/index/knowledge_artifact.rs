use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path};

use crate::agent_context::projection::ProjectKnowledgeArtifact;
use crate::collections::knowledge_projection::{
    KnowledgeCollectionProjection, KnowledgeRelationProjection,
};
use crate::index::model::{
    KnowledgeAgentApplicability, KnowledgeArtifact, KnowledgeEdgeArtifact,
    KnowledgeFragmentArtifact,
};
use crate::page::identity::{MarkdownIdentityFacts, SourceShape, resolve_markdown_identity};
use crate::page::links::parse_markdown_links;

pub fn build_file_artifact(
    source_path: &str,
    title: &str,
    source_updated_at: &str,
    raw: &str,
    body: &str,
    collection_root: Option<&str>,
    relations: &[KnowledgeRelationProjection],
) -> Option<KnowledgeArtifact> {
    let agent_context = is_agent_context_source(source_path);
    let identity = resolve_markdown_identity(MarkdownIdentityFacts {
        path: source_path,
        source_shape: SourceShape::File,
        collection_root,
        agent_context,
    });
    if is_excluded_source(source_path) || !identity.is_page() {
        return None;
    }
    let kind = "page";
    let mut edges = markdown_edges(source_path, raw);
    if let Some(root) = collection_root {
        edges.push(KnowledgeEdgeArtifact {
            kind: "member_of".to_string(),
            target_url: root.to_string(),
            target_scope: "current".to_string(),
            target_path: Some(root.to_string()),
            target_kind: Some("collection".to_string()),
            field_name: None,
            location_path: source_path.to_string(),
            byte_start: 0,
            byte_end: 0,
        });
    }
    for relation in relations {
        edges.push(KnowledgeEdgeArtifact {
            kind: "relation".to_string(),
            target_url: relation.target_path.clone(),
            target_scope: relation.target_scope.clone(),
            target_path: Some(relation.target_path.clone()),
            target_kind: Some("page".to_string()),
            field_name: Some(relation.field_name.clone()),
            location_path: source_path.to_string(),
            byte_start: 0,
            byte_end: 0,
        });
    }
    let mut searchable = body.to_string();
    for relation in relations {
        searchable.push('\n');
        searchable.push_str(&relation.field_name);
        searchable.push(' ');
        searchable.push_str(&relation.target_path);
    }
    Some(finish_artifact(
        source_path,
        kind,
        title,
        source_updated_at,
        raw,
        source_path,
        serde_json::json!({"sourceKind": kind}),
        searchable,
        edges,
    ))
}

pub fn build_collection_artifact(
    projection: &KnowledgeCollectionProjection,
    source_updated_at: &str,
) -> KnowledgeArtifact {
    let location_path =
        crate::collections::knowledge_projection::collection_readme_path(&projection.source_path);
    let raw = format!(
        "{}\n{}\n{}\n{}",
        projection.title,
        projection.description.as_deref().unwrap_or(""),
        projection.body,
        projection.schema_labels.join("\n")
    );
    let mut searchable = raw.clone();
    searchable.truncate(searchable.len().min(256 * 1024));
    finish_artifact(
        &projection.source_path,
        "collection",
        &projection.title,
        source_updated_at,
        &raw,
        &location_path,
        serde_json::json!({
            "sourceKind": "collection_root",
            "readmePath": location_path,
            "schemaPath": if projection.source_path == "." { "schema.yaml".to_string() } else { format!("{}/schema.yaml", projection.source_path) },
        }),
        searchable,
        markdown_edges(&location_path, &projection.body),
    )
}

pub fn build_agent_artifact(projection: &ProjectKnowledgeArtifact) -> KnowledgeArtifact {
    let mut edges = Vec::new();
    for reference in &projection.references {
        edges.push(KnowledgeEdgeArtifact {
            kind: "references".to_string(),
            target_url: reference.path.clone(),
            target_scope: "current".to_string(),
            target_path: Some(reference.path.clone()),
            target_kind: Some("agent_instruction".to_string()),
            field_name: None,
            location_path: projection.source_path.clone(),
            byte_start: 0,
            byte_end: 0,
        });
    }
    finish_artifact(
        &projection.source_path,
        &projection.kind,
        &projection.title,
        &projection.source_updated_at,
        &projection.text,
        &projection.source_path,
        agent_provenance(projection),
        projection.text.clone(),
        edges,
    )
}

pub fn build_agent_applicability(
    projection: &ProjectKnowledgeArtifact,
) -> KnowledgeAgentApplicability {
    KnowledgeAgentApplicability {
        source_scope: projection.owner_scope.clone(),
        source_path: projection.source_path.clone(),
        node_kind: projection.kind.clone(),
        provenance: agent_provenance(projection),
    }
}

fn agent_provenance(projection: &ProjectKnowledgeArtifact) -> serde_json::Value {
    serde_json::json!({
        "canonicalSourcePath": projection.canonical_source_path,
        "aliases": projection.aliases,
        "support": projection.support,
        "resolution": projection.resolution,
        "health": projection.health,
        "healthReasons": projection.health_reasons,
        "effectiveApplicability": projection.effective_applicability,
        "discovery": projection.discovery,
        "truncated": projection.truncated,
        "scopeApplicability": if projection.owner_scope == "root" { "inherited" } else { "local" },
    })
}

pub fn finish_artifact(
    source_path: &str,
    kind: &str,
    title: &str,
    source_updated_at: &str,
    raw: &str,
    location_path: &str,
    provenance: serde_json::Value,
    fragment: String,
    edges: Vec<KnowledgeEdgeArtifact>,
) -> KnowledgeArtifact {
    let provenance_json = serde_json::to_string(&provenance).unwrap_or_else(|_| "{}".to_string());
    let mut hasher = DefaultHasher::new();
    kind.hash(&mut hasher);
    raw.hash(&mut hasher);
    provenance_json.hash(&mut hasher);
    for edge in &edges {
        edge.kind.hash(&mut hasher);
        edge.target_scope.hash(&mut hasher);
        edge.target_path.hash(&mut hasher);
        edge.field_name.hash(&mut hasher);
    }
    let line_end = fragment.lines().count().max(1) as i64;
    let byte_end = fragment.len() as i64;
    KnowledgeArtifact {
        source_path: source_path.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        content_hash: format!("{:016x}", hasher.finish()),
        source_updated_at: source_updated_at.to_string(),
        checked_at: crate::index::manifest::now(),
        canonical_source_path: source_path.to_string(),
        provenance_json,
        fragments: vec![KnowledgeFragmentArtifact {
            text: fragment,
            location_path: location_path.to_string(),
            line_start: 1,
            line_end,
            byte_start: 0,
            byte_end,
        }],
        edges,
    }
}

fn markdown_edges(source_path: &str, raw: &str) -> Vec<KnowledgeEdgeArtifact> {
    parse_markdown_links(raw)
        .into_iter()
        .map(|(target_url, span)| KnowledgeEdgeArtifact {
            kind: "links_to".to_string(),
            target_url,
            target_scope: "resolve".to_string(),
            target_path: None,
            target_kind: None,
            field_name: None,
            location_path: source_path.to_string(),
            byte_start: span.byte_start as i64,
            byte_end: span.byte_end as i64,
        })
        .collect()
}

fn is_excluded_source(source_path: &str) -> bool {
    Path::new(source_path).components().any(|component| {
        matches!(component, Component::Normal(name) if matches!(name.to_str(), Some(".templates" | ".git" | ".svode" | ".routines" | ".sessions")))
    })
}

pub fn is_secret_like_source(source_path: &str) -> bool {
    let Some(filename) = Path::new(source_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
    else {
        return false;
    };
    let stem = filename.strip_suffix(".md").unwrap_or(&filename);
    let tokens = stem
        .split(['.', '-', '_'])
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    tokens.iter().any(|token| {
        matches!(
            *token,
            "secret"
                | "secrets"
                | "credential"
                | "credentials"
                | "password"
                | "passwords"
                | "token"
                | "tokens"
        )
    }) || stem.contains("api-key")
        || stem.contains("private-key")
}

pub fn is_agent_context_source(source_path: &str) -> bool {
    crate::page::identity::is_agent_context_source(source_path)
}

pub fn folded_collection_artifact(space_dir: &Path, rel_path: &str) -> Option<KnowledgeArtifact> {
    let path = Path::new(rel_path);
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return None;
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let collection_path = parent
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| ".".to_string());
    let schema_path = if collection_path == "." {
        space_dir.join("schema.yaml")
    } else {
        space_dir.join(&collection_path).join("schema.yaml")
    };
    if !schema_path.is_file() {
        return None;
    }
    let policy = crate::content_tree::policy::TreeIgnorePolicy::from_space_root(space_dir);
    if policy.is_ignored_abs(
        &schema_path,
        crate::content_tree::policy::TreePathKind::File,
    ) {
        return None;
    }
    let projection =
        crate::collections::knowledge_projection::project_collection(space_dir, &collection_path)
            .ok()?;
    Some(build_collection_artifact(
        &projection,
        &crate::index::entry_projection::file_modified_iso(&schema_path),
    ))
}
