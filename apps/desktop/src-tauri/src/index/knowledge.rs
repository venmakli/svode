use std::collections::{BTreeSet, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path};
use std::sync::atomic::Ordering;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool, Transaction};

use crate::agent_context::projection::ProjectKnowledgeArtifact;
use crate::artifact::identity::{MarkdownIdentityFacts, SourceShape, resolve_markdown_identity};
use crate::error::AppError;
use crate::files::backlinks::parse_markdown_links;
use crate::index::{IndexKey, IndexState};
use crate::properties::knowledge_projection::{
    KnowledgeCollectionProjection, KnowledgeRelationProjection,
};
use crate::space::types::SpaceStatus;

const DEFAULT_NODE_LIMIT: usize = 200;
const DEFAULT_EDGE_LIMIT: usize = 400;
const DEFAULT_SEARCH_LIMIT: usize = 20;
const DEFAULT_NEIGHBOR_LIMIT: usize = 40;
const MAX_NODE_LIMIT: usize = 1_000;
const MAX_EDGE_LIMIT: usize = 2_000;
const MAX_SEARCH_LIMIT: usize = 100;
const MAX_NEIGHBOR_LIMIT: usize = 100;
const MAX_INCOMING_LINK_SCAN: usize = 2_000;
const MAX_RELATED_CONTEXT_ITEMS: usize = 20;
const MAX_RELATED_CONTEXT_BYTES: usize = 16_000;
const MAX_RELATED_NEIGHBORS: usize = 100;
const RELATED_NEIGHBORS_PER_ITEM: usize = 5;
const NODE_KINDS: [&str; 4] = ["page", "collection", "agent_instruction", "skill"];
const EDGE_KINDS: [&str; 4] = ["links_to", "relation", "member_of", "references"];

#[derive(Debug, Clone)]
pub(crate) struct KnowledgeArtifact {
    pub source_path: String,
    pub kind: String,
    pub title: String,
    pub content_hash: String,
    pub source_updated_at: String,
    pub checked_at: String,
    pub canonical_source_path: String,
    pub provenance_json: String,
    pub fragments: Vec<KnowledgeFragmentArtifact>,
    pub edges: Vec<KnowledgeEdgeArtifact>,
}

#[derive(Debug, Clone)]
pub(crate) struct KnowledgeFragmentArtifact {
    pub text: String,
    pub location_path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub byte_start: i64,
    pub byte_end: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct KnowledgeEdgeArtifact {
    pub kind: String,
    pub target_url: String,
    pub target_scope: String,
    pub target_path: Option<String>,
    pub target_kind: Option<String>,
    pub field_name: Option<String>,
    pub location_path: String,
    pub byte_start: i64,
    pub byte_end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAgentApplicability {
    pub source_scope: String,
    pub source_path: String,
    pub node_kind: String,
    pub provenance: serde_json::Value,
}

pub(crate) fn build_file_artifact(
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

pub(crate) fn build_collection_artifact(
    projection: &KnowledgeCollectionProjection,
    source_updated_at: &str,
) -> KnowledgeArtifact {
    let location_path =
        crate::properties::knowledge_projection::collection_readme_path(&projection.source_path);
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

pub(crate) fn build_agent_artifact(projection: &ProjectKnowledgeArtifact) -> KnowledgeArtifact {
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

pub(crate) fn build_agent_applicability(
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

fn finish_artifact(
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
        checked_at: now(),
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

pub(crate) fn is_secret_like_source(source_path: &str) -> bool {
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

pub(crate) fn is_agent_context_source(source_path: &str) -> bool {
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

pub(crate) async fn replace_all(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
    applicability: &[KnowledgeAgentApplicability],
    skipped_count: usize,
    failure_count: usize,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM knowledge_links")
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_fragments")
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_documents")
        .execute(&mut **tx)
        .await?;
    replace_applicability(tx, applicability).await?;
    for artifact in artifacts {
        insert_artifact(tx, artifact).await?;
    }
    refresh_manifest(tx, skipped_count, failure_count).await
}

pub(crate) async fn replace_agent_context(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
    applicability: &[KnowledgeAgentApplicability],
) -> Result<bool, AppError> {
    let existing: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_path, content_hash FROM knowledge_documents \
         WHERE node_kind IN ('agent_instruction', 'skill') ORDER BY source_path",
    )
    .fetch_all(&mut **tx)
    .await?;
    let next = artifacts
        .iter()
        .map(|artifact| (artifact.source_path.clone(), artifact.content_hash.clone()))
        .collect::<Vec<_>>();
    let existing_applicability = read_agent_applicability_tx(tx).await?;
    if existing == next && existing_applicability == applicability {
        return Ok(false);
    }
    sqlx::query(
        "DELETE FROM knowledge_links WHERE source_path IN \
         (SELECT source_path FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill'))",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "DELETE FROM knowledge_fragments WHERE source_path IN \
         (SELECT source_path FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill'))",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "DELETE FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill')",
    )
    .execute(&mut **tx)
    .await?;
    for artifact in artifacts {
        delete_rows(tx, &artifact.source_path).await?;
        if let Ok(provenance) = serde_json::from_str::<serde_json::Value>(&artifact.provenance_json)
        {
            for alias in provenance
                .get("aliases")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
            {
                delete_rows(tx, alias).await?;
            }
        }
        insert_artifact(tx, artifact).await?;
    }
    replace_applicability(tx, applicability).await?;
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
}

async fn replace_applicability(
    tx: &mut Transaction<'_, Sqlite>,
    applicability: &[KnowledgeAgentApplicability],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM knowledge_agent_applicability")
        .execute(&mut **tx)
        .await?;
    for row in applicability {
        sqlx::query(
            "INSERT INTO knowledge_agent_applicability \
             (source_scope,source_path,node_kind,provenance_json) VALUES (?,?,?,?)",
        )
        .bind(&row.source_scope)
        .bind(&row.source_path)
        .bind(&row.node_kind)
        .bind(serde_json::to_string(&row.provenance).unwrap_or_else(|_| "{}".to_string()))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn read_agent_applicability_tx(
    tx: &mut Transaction<'_, Sqlite>,
) -> Result<Vec<KnowledgeAgentApplicability>, AppError> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT source_scope,source_path,node_kind,provenance_json \
         FROM knowledge_agent_applicability ORDER BY source_scope,node_kind,source_path",
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(applicability_rows(rows))
}

pub async fn read_agent_applicability(
    pool: &SqlitePool,
) -> Result<Vec<KnowledgeAgentApplicability>, AppError> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT source_scope,source_path,node_kind,provenance_json \
         FROM knowledge_agent_applicability ORDER BY source_scope,node_kind,source_path",
    )
    .fetch_all(pool)
    .await?;
    Ok(applicability_rows(rows))
}

fn applicability_rows(
    rows: Vec<(String, String, String, String)>,
) -> Vec<KnowledgeAgentApplicability> {
    rows.into_iter()
        .map(|row| KnowledgeAgentApplicability {
            source_scope: row.0,
            source_path: row.1,
            node_kind: row.2,
            provenance: serde_json::from_str(&row.3).unwrap_or_else(|_| serde_json::json!({})),
        })
        .collect()
}

pub(crate) async fn upsert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<bool, AppError> {
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT node_kind, content_hash FROM knowledge_documents WHERE source_path = ?",
    )
    .bind(&artifact.source_path)
    .fetch_optional(&mut **tx)
    .await?;
    if existing
        .as_ref()
        .is_some_and(|(kind, hash)| kind == &artifact.kind && hash == &artifact.content_hash)
    {
        return Ok(false);
    }
    delete_rows(tx, &artifact.source_path).await?;
    insert_artifact(tx, artifact).await?;
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
}

pub(crate) async fn delete_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
) -> Result<bool, AppError> {
    let deleted = delete_rows(tx, source_path).await?;
    if deleted {
        refresh_manifest_preserving_diagnostics(tx).await?;
    }
    Ok(deleted)
}

async fn delete_rows(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
) -> Result<bool, AppError> {
    sqlx::query("DELETE FROM knowledge_links WHERE source_path = ?")
        .bind(source_path)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_fragments WHERE source_path = ?")
        .bind(source_path)
        .execute(&mut **tx)
        .await?;
    Ok(
        sqlx::query("DELETE FROM knowledge_documents WHERE source_path = ?")
            .bind(source_path)
            .execute(&mut **tx)
            .await?
            .rows_affected()
            > 0,
    )
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO knowledge_documents \
         (source_path, node_kind, title, content_hash, source_updated_at, checked_at, canonical_source_path, provenance_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&artifact.source_path)
    .bind(&artifact.kind)
    .bind(&artifact.title)
    .bind(&artifact.content_hash)
    .bind(&artifact.source_updated_at)
    .bind(&artifact.checked_at)
    .bind(&artifact.canonical_source_path)
    .bind(&artifact.provenance_json)
    .execute(&mut **tx)
    .await?;
    for (ordinal, fragment) in artifact.fragments.iter().enumerate() {
        sqlx::query(
            "INSERT INTO knowledge_fragments \
             (source_path, ordinal, text, content_hash, location_path, line_start, line_end, byte_start, byte_end) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&artifact.source_path)
        .bind(ordinal as i64)
        .bind(&fragment.text)
        .bind(&artifact.content_hash)
        .bind(&fragment.location_path)
        .bind(fragment.line_start)
        .bind(fragment.line_end)
        .bind(fragment.byte_start)
        .bind(fragment.byte_end)
        .execute(&mut **tx)
        .await?;
    }
    for edge in &artifact.edges {
        sqlx::query(
            "INSERT OR IGNORE INTO knowledge_links \
             (source_path, edge_kind, target_url, target_scope, target_path, target_kind, field_name, location_path, byte_start, byte_end, origin) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'explicit')",
        )
        .bind(&artifact.source_path)
        .bind(&edge.kind)
        .bind(&edge.target_url)
        .bind(&edge.target_scope)
        .bind(&edge.target_path)
        .bind(&edge.target_kind)
        .bind(&edge.field_name)
        .bind(&edge.location_path)
        .bind(edge.byte_start)
        .bind(edge.byte_end)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(crate) async fn refresh_manifest_preserving_diagnostics(
    tx: &mut Transaction<'_, Sqlite>,
) -> Result<(), AppError> {
    let diagnostics: Option<(i64, i64)> = sqlx::query_as(
        "SELECT skipped_count, failure_count FROM knowledge_manifest WHERE singleton = 1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let (skipped, failures) = diagnostics.unwrap_or((0, 0));
    refresh_manifest(tx, skipped as usize, failures as usize).await
}

async fn refresh_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    skipped_count: usize,
    failure_count: usize,
) -> Result<(), AppError> {
    let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_documents")
        .fetch_one(&mut **tx)
        .await?;
    let edge_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_links")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO knowledge_manifest \
         (singleton, checked_at, document_count, link_count, skipped_count, failure_count) \
         VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET \
         checked_at=excluded.checked_at, document_count=excluded.document_count, \
         link_count=excluded.link_count, skipped_count=excluded.skipped_count, failure_count=excluded.failure_count",
    )
    .bind(now())
    .bind(node_count)
    .bind(edge_count)
    .bind(skipped_count as i64)
    .bind(failure_count as i64)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum KnowledgeScope {
    Project,
    Space { space_id: Option<String> },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFilters {
    pub node_kinds: Option<Vec<String>>,
    pub edge_kinds: Option<Vec<String>>,
    #[serde(default)]
    pub edge_source_kinds: Option<Vec<String>>,
    pub neighbor: Option<KnowledgeSource>,
    pub neighbor_limit: Option<usize>,
    #[serde(default)]
    pub source: Option<KnowledgeSource>,
    #[serde(default)]
    pub sources: Option<Vec<KnowledgeSource>>,
    #[serde(default)]
    pub edge_sources: Option<Vec<KnowledgeSource>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub space_id: Option<String>,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNode {
    pub id: String,
    pub source: KnowledgeSource,
    pub space_name: String,
    pub title: String,
    pub content_hash: String,
    pub source_updated_at: String,
    pub checked_at: String,
    pub canonical_source_path: String,
    pub provenance: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEdge {
    pub kind: String,
    pub source_id: String,
    pub source: KnowledgeSource,
    pub target_id: Option<String>,
    pub target: Option<KnowledgeSource>,
    pub target_url: String,
    pub target_status: String,
    pub origin: String,
    pub field_name: Option<String>,
    pub location_path: String,
    pub byte_start: usize,
    pub byte_end: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchItem {
    pub rank: usize,
    pub node_id: String,
    pub source: KnowledgeSource,
    pub space_name: String,
    pub title: String,
    pub snippet: Option<String>,
    pub location_path: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub provenance: serde_json::Value,
    pub snippet_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePoolFreshness {
    pub space_id: Option<String>,
    pub checked_at: String,
    pub page_count: usize,
    pub link_count: usize,
    pub skipped_count: usize,
    pub failure_count: usize,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDiagnostic {
    pub space_id: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeResponse {
    pub status: String,
    pub nodes: Vec<KnowledgeNode>,
    pub edges: Vec<KnowledgeEdge>,
    pub search_items: Vec<KnowledgeSearchItem>,
    pub freshness: Vec<KnowledgePoolFreshness>,
    pub diagnostics: Vec<KnowledgeDiagnostic>,
    pub readable_pools: usize,
    pub total_pools: usize,
    pub truncated: bool,
    pub total_node_count: usize,
    pub total_edge_count: usize,
    pub omitted_node_count: usize,
    pub omitted_edge_count: usize,
    pub next_node_offset: Option<usize>,
    pub next_edge_offset: Option<usize>,
    pub has_more_nodes: bool,
    pub has_more_edges: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeContextItem {
    pub node_id: String,
    pub source: KnowledgeSource,
    pub title: String,
    pub text: String,
    pub location_path: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub provenance: serde_json::Value,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeContextNeighbor {
    pub edge: KnowledgeEdge,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRelatedContext {
    pub context: Vec<KnowledgeContextItem>,
    pub neighbors: Vec<KnowledgeContextNeighbor>,
    pub text_budget: usize,
    pub used_budget: usize,
    pub truncated: bool,
    pub status: String,
    pub diagnostics: Vec<KnowledgeDiagnostic>,
}

#[derive(Debug)]
struct PoolNode {
    key: IndexKey,
    path: String,
    kind: String,
    title: String,
    content_hash: String,
    source_updated_at: String,
    checked_at: String,
    canonical_source_path: String,
    provenance_json: String,
}

#[derive(Debug)]
struct PoolEdge {
    key: IndexKey,
    source_path: String,
    source_kind: String,
    kind: String,
    target_url: String,
    target_scope: String,
    target_path: Option<String>,
    target_kind: Option<String>,
    field_name: Option<String>,
    location_path: String,
    byte_start: i64,
    byte_end: i64,
}

#[derive(Debug)]
struct PoolSearchItem {
    key: IndexKey,
    path: String,
    kind: String,
    title: String,
    snippet: Option<String>,
    location_path: Option<String>,
    line_start: Option<i64>,
    line_end: Option<i64>,
    provenance_json: String,
    snippet_truncated: bool,
}

#[allow(dead_code)]
pub async fn read_project_snapshot(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
    query: Option<&str>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
) -> KnowledgeResponse {
    read_project_snapshot_filtered(
        state,
        project,
        scope,
        query,
        node_offset,
        edge_offset,
        node_limit,
        edge_limit,
        search_limit,
        KnowledgeFilters::default(),
    )
    .await
}

/// Reads one physical Space pool plus the root-owned Agent Context artifacts that the
/// prepared target-specific applicability map marks as effective for that Space.
///
/// This is the canonical backend read path for Space-scoped consumers. It never scans
/// the filesystem or opens a missing pool; project-wide reads continue to use
/// `read_project_snapshot_filtered` so root and child artifacts are returned once by
/// their physical owner.
#[allow(clippy::too_many_arguments)]
pub async fn read_effective_space_snapshot_filtered(
    state: &IndexState,
    project: &Path,
    space_id: Option<String>,
    query: Option<&str>,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    let scope = KnowledgeScope::Space {
        space_id: space_id.clone(),
    };
    let mut non_agent_filters = filters.clone();
    non_agent_filters.node_kinds = Some(non_agent_kinds(filters.node_kinds.as_deref()));
    non_agent_filters.edge_source_kinds =
        Some(non_agent_kinds(filters.edge_source_kinds.as_deref()));
    let mut primary = read_project_snapshot_filtered(
        state,
        project,
        Some(scope.clone()),
        query,
        None,
        None,
        Some(node_limit),
        Some(edge_limit),
        Some(search_limit),
        non_agent_filters,
    )
    .await;
    let applicability = match state
        .key_for_project_space_id(project, space_id.as_deref())
        .await
    {
        Ok(key) => match state.existing_pool(&key).await {
            Some(pool) => match read_agent_applicability(&pool).await {
                Ok(rows) => rows,
                Err(error) => {
                    tracing::warn!(
                        "prepared Agent Context applicability read failed for {:?}: {error}",
                        space_id
                    );
                    primary.diagnostics.push(KnowledgeDiagnostic {
                        space_id: space_id.clone(),
                        code: "agent_applicability_unavailable".to_string(),
                        message: "The prepared Agent Context scope could not be read".to_string(),
                    });
                    primary.status = combined_status(&primary).to_string();
                    Vec::new()
                }
            },
            None => Vec::new(),
        },
        Err(_) => Vec::new(),
    };
    let current_node_kinds = inherited_agent_kinds(filters.node_kinds.as_deref());
    let current_edge_source_kinds = inherited_agent_kinds(filters.edge_source_kinds.as_deref());
    let current_sources = applicability_sources(
        &applicability,
        "current",
        space_id.as_deref(),
        filters.source.as_ref(),
        filters.sources.as_deref(),
    );
    let current_edge_sources = applicability_sources(
        &applicability,
        "current",
        space_id.as_deref(),
        None,
        filters.edge_sources.as_deref(),
    );
    if (!current_node_kinds.is_empty() && !current_sources.is_empty())
        || (!current_edge_source_kinds.is_empty() && !current_edge_sources.is_empty())
    {
        let mut current_filters = filters.clone();
        current_filters.node_kinds = Some(current_node_kinds);
        current_filters.edge_source_kinds = Some(current_edge_source_kinds);
        current_filters.source = None;
        current_filters.sources = Some(current_sources);
        current_filters.edge_sources = Some(current_edge_sources);
        let mut current = read_project_snapshot_filtered(
            state,
            project,
            Some(scope),
            query,
            None,
            None,
            Some(node_limit),
            Some(edge_limit),
            Some(search_limit),
            current_filters,
        )
        .await;
        apply_prepared_applicability(&mut current, &applicability, "current", space_id.as_deref());
        primary = merge_same_pool_responses(primary, current, node_limit, edge_limit, search_limit);
    }
    let Some(space_id) = space_id else {
        return primary;
    };

    let inherited_node_kinds = inherited_agent_kinds(filters.node_kinds.as_deref());
    let inherited_edge_source_kinds = inherited_agent_kinds(filters.edge_source_kinds.as_deref());
    let inherited_sources = applicability_sources(
        &applicability,
        "root",
        None,
        filters.source.as_ref(),
        filters.sources.as_deref(),
    );
    let inherited_edge_sources = applicability_sources(
        &applicability,
        "root",
        None,
        None,
        filters.edge_sources.as_deref(),
    );
    if inherited_sources.is_empty()
        || (inherited_node_kinds.is_empty() && inherited_edge_source_kinds.is_empty())
    {
        return primary;
    }

    let mut inherited_filters = filters;
    inherited_filters.node_kinds = Some(inherited_node_kinds);
    inherited_filters.edge_source_kinds = Some(inherited_edge_source_kinds);
    inherited_filters.source = None;
    inherited_filters.sources = Some(inherited_sources);
    inherited_filters.edge_sources = Some(inherited_edge_sources);
    let mut inherited = read_project_snapshot_filtered(
        state,
        project,
        Some(KnowledgeScope::Space { space_id: None }),
        query,
        None,
        None,
        Some(node_limit),
        Some(edge_limit),
        Some(search_limit),
        inherited_filters,
    )
    .await;
    apply_prepared_applicability(&mut inherited, &applicability, "root", Some(&space_id));
    merge_effective_responses(primary, inherited, node_limit, edge_limit, search_limit)
}

#[allow(clippy::too_many_arguments)]
pub async fn read_scoped_snapshot_filtered(
    state: &IndexState,
    project: &Path,
    scope: KnowledgeScope,
    query: Option<&str>,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    match scope {
        KnowledgeScope::Project => {
            read_project_snapshot_filtered(
                state,
                project,
                Some(KnowledgeScope::Project),
                query,
                None,
                None,
                Some(node_limit),
                Some(edge_limit),
                Some(search_limit),
                filters,
            )
            .await
        }
        KnowledgeScope::Space { space_id } => {
            read_effective_space_snapshot_filtered(
                state,
                project,
                space_id,
                query,
                node_limit,
                edge_limit,
                search_limit,
                filters,
            )
            .await
        }
    }
}

pub async fn read_related_context(
    state: &IndexState,
    project: &Path,
    scope: KnowledgeScope,
    query: &str,
    limit: usize,
    text_budget: usize,
    node_kinds: Option<Vec<String>>,
) -> KnowledgeRelatedContext {
    let limit = limit.clamp(1, MAX_RELATED_CONTEXT_ITEMS);
    let text_budget = text_budget.clamp(1, MAX_RELATED_CONTEXT_BYTES);
    let mut response = read_scoped_snapshot_filtered(
        state,
        project,
        scope.clone(),
        Some(query),
        1,
        1,
        limit.saturating_add(1),
        KnowledgeFilters {
            node_kinds,
            edge_kinds: Some(Vec::new()),
            edge_source_kinds: Some(Vec::new()),
            neighbor: None,
            neighbor_limit: None,
            source: None,
            sources: None,
            edge_sources: None,
        },
    )
    .await;
    response.search_items.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    let mut truncated = response.search_items.len() > limit;
    response.search_items.truncate(limit);
    let mut used_budget = 0usize;
    let mut context = Vec::new();
    let mut neighbor_items = Vec::new();
    for item in std::mem::take(&mut response.search_items) {
        let Some(snippet) = item.snippet.as_deref() else {
            continue;
        };
        let remaining = text_budget.saturating_sub(used_budget);
        if remaining == 0 {
            truncated = true;
            break;
        }
        let (text, cut) = utf8_prefix(snippet, remaining);
        used_budget += text.len();
        truncated |= cut || item.snippet_truncated;
        let source = item.source.clone();
        context.push(KnowledgeContextItem {
            node_id: item.node_id,
            source: item.source,
            title: item.title,
            text: text.to_string(),
            location_path: item.location_path,
            line_start: item.line_start,
            line_end: item.line_end,
            provenance: item.provenance,
            truncated: cut || item.snippet_truncated,
        });
        if cut {
            break;
        }
        if neighbor_items.len() >= MAX_RELATED_NEIGHBORS {
            truncated = true;
            break;
        }
        let mut neighbors = read_scoped_snapshot_filtered(
            state,
            project,
            scope.clone(),
            None,
            1,
            RELATED_NEIGHBORS_PER_ITEM.saturating_add(1),
            1,
            KnowledgeFilters {
                node_kinds: Some(Vec::new()),
                edge_kinds: None,
                edge_source_kinds: None,
                neighbor: Some(source),
                neighbor_limit: Some(RELATED_NEIGHBORS_PER_ITEM.saturating_add(1)),
                source: None,
                sources: None,
                edge_sources: None,
            },
        )
        .await;
        truncated |= neighbors.truncated || neighbors.edges.len() > RELATED_NEIGHBORS_PER_ITEM;
        for diagnostic in neighbors.diagnostics.drain(..) {
            if !response.diagnostics.iter().any(|current| {
                current.space_id == diagnostic.space_id && current.code == diagnostic.code
            }) {
                response.diagnostics.push(diagnostic);
            }
        }
        for edge in neighbors.edges.drain(..).take(RELATED_NEIGHBORS_PER_ITEM) {
            let compact = format!(
                "{} {} {}",
                edge.source_id,
                edge.kind,
                edge.target_id.as_deref().unwrap_or(&edge.target_url)
            );
            let remaining = text_budget.saturating_sub(used_budget);
            if remaining == 0 {
                truncated = true;
                break;
            }
            let (text, cut) = utf8_prefix(&compact, remaining);
            used_budget += text.len();
            neighbor_items.push(KnowledgeContextNeighbor {
                edge,
                text: text.to_string(),
                truncated: cut,
            });
            if cut {
                truncated = true;
                break;
            }
        }
    }
    response.status = combined_status(&response).to_string();
    KnowledgeRelatedContext {
        context,
        neighbors: neighbor_items,
        text_budget,
        used_budget,
        truncated,
        status: response.status,
        diagnostics: response.diagnostics,
    }
}

fn utf8_prefix(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}

const AGENT_NODE_KINDS: [&str; 2] = ["agent_instruction", "skill"];
const NON_AGENT_NODE_KINDS: [&str; 2] = ["page", "collection"];

fn inherited_agent_kinds(requested: Option<&[String]>) -> Vec<String> {
    match requested {
        Some(kinds) => kinds
            .iter()
            .filter(|kind| AGENT_NODE_KINDS.contains(&kind.as_str()))
            .cloned()
            .collect(),
        None => AGENT_NODE_KINDS
            .iter()
            .map(|kind| (*kind).to_string())
            .collect(),
    }
}

fn non_agent_kinds(requested: Option<&[String]>) -> Vec<String> {
    match requested {
        Some(kinds) => kinds
            .iter()
            .filter(|kind| NON_AGENT_NODE_KINDS.contains(&kind.as_str()))
            .cloned()
            .collect(),
        None => NON_AGENT_NODE_KINDS
            .iter()
            .map(|kind| (*kind).to_string())
            .collect(),
    }
}

fn applicability_sources(
    rows: &[KnowledgeAgentApplicability],
    source_scope: &str,
    source_space_id: Option<&str>,
    requested: Option<&KnowledgeSource>,
    requested_many: Option<&[KnowledgeSource]>,
) -> Vec<KnowledgeSource> {
    rows.iter()
        .filter(|row| row.source_scope == source_scope)
        .map(|row| KnowledgeSource {
            space_id: source_space_id.map(ToString::to_string),
            path: row.source_path.clone(),
            kind: row.node_kind.clone(),
        })
        .filter(|source| {
            requested.is_none_or(|candidate| candidate == source)
                && requested_many.is_none_or(|candidates| candidates.contains(source))
        })
        .collect()
}

fn apply_prepared_applicability(
    response: &mut KnowledgeResponse,
    rows: &[KnowledgeAgentApplicability],
    source_scope: &str,
    effective_space_id: Option<&str>,
) {
    let provenance = rows
        .iter()
        .filter(|row| row.source_scope == source_scope)
        .map(|row| {
            (
                (row.source_path.as_str(), row.node_kind.as_str()),
                &row.provenance,
            )
        })
        .collect::<HashMap<_, _>>();
    response.nodes.retain(|node| {
        !AGENT_NODE_KINDS.contains(&node.source.kind.as_str())
            || provenance.contains_key(&(node.source.path.as_str(), node.source.kind.as_str()))
    });
    response.search_items.retain(|item| {
        !AGENT_NODE_KINDS.contains(&item.source.kind.as_str())
            || provenance.contains_key(&(item.source.path.as_str(), item.source.kind.as_str()))
    });
    response.edges.retain(|edge| {
        !AGENT_NODE_KINDS.contains(&edge.source.kind.as_str())
            || provenance.contains_key(&(edge.source.path.as_str(), edge.source.kind.as_str()))
    });
    for node in &mut response.nodes {
        if let Some(prepared) =
            provenance.get(&(node.source.path.as_str(), node.source.kind.as_str()))
        {
            node.provenance = (*prepared).clone();
            annotate_effective_space(&mut node.provenance, effective_space_id);
        }
    }
    for item in &mut response.search_items {
        if let Some(prepared) =
            provenance.get(&(item.source.path.as_str(), item.source.kind.as_str()))
        {
            item.provenance = (*prepared).clone();
            annotate_effective_space(&mut item.provenance, effective_space_id);
        }
    }
}

fn annotate_effective_space(provenance: &mut serde_json::Value, effective_space_id: Option<&str>) {
    if !provenance.is_object() {
        *provenance = serde_json::json!({});
    }
    if let Some(object) = provenance.as_object_mut() {
        object.insert(
            "effectiveSpaceId".to_string(),
            effective_space_id.map_or(serde_json::Value::Null, |id| {
                serde_json::Value::String(id.to_string())
            }),
        );
    }
}

fn merge_effective_responses(
    mut primary: KnowledgeResponse,
    mut inherited: KnowledgeResponse,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
) -> KnowledgeResponse {
    append_response_content(&mut primary, &mut inherited);
    primary.freshness.append(&mut inherited.freshness);
    primary.diagnostics.append(&mut inherited.diagnostics);
    primary.readable_pools += inherited.readable_pools;
    primary.total_pools += inherited.total_pools;
    finalize_merged_response(
        &mut primary,
        inherited.truncated,
        node_limit,
        edge_limit,
        search_limit,
    );
    primary
}

fn merge_same_pool_responses(
    mut primary: KnowledgeResponse,
    mut additional: KnowledgeResponse,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
) -> KnowledgeResponse {
    append_response_content(&mut primary, &mut additional);
    for diagnostic in additional.diagnostics.drain(..) {
        if !primary.diagnostics.iter().any(|current| {
            current.space_id == diagnostic.space_id && current.code == diagnostic.code
        }) {
            primary.diagnostics.push(diagnostic);
        }
    }
    finalize_merged_response(
        &mut primary,
        additional.truncated,
        node_limit,
        edge_limit,
        search_limit,
    );
    primary
}

fn append_response_content(primary: &mut KnowledgeResponse, additional: &mut KnowledgeResponse) {
    primary.nodes.append(&mut additional.nodes);
    primary.edges.append(&mut additional.edges);
    primary.search_items.append(&mut additional.search_items);
    primary.search_items.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.node_id.cmp(&right.node_id))
    });
    primary.total_node_count += additional.total_node_count;
    primary.total_edge_count += additional.total_edge_count;
}

fn finalize_merged_response(
    primary: &mut KnowledgeResponse,
    additional_truncated: bool,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
) {
    let nodes_before_truncate = primary.nodes.len();
    let edges_before_truncate = primary.edges.len();
    let search_truncated = primary.search_items.len() > search_limit;
    primary.nodes.truncate(node_limit);
    primary.edges.truncate(edge_limit);
    primary.search_items.truncate(search_limit);
    primary.omitted_node_count = primary.total_node_count.saturating_sub(primary.nodes.len());
    primary.omitted_edge_count = primary.total_edge_count.saturating_sub(primary.edges.len());
    primary.has_more_nodes =
        nodes_before_truncate > primary.nodes.len() || primary.omitted_node_count > 0;
    primary.has_more_edges =
        edges_before_truncate > primary.edges.len() || primary.omitted_edge_count > 0;
    primary.truncated |= additional_truncated
        || primary.has_more_nodes
        || primary.has_more_edges
        || search_truncated;
    primary.next_node_offset = primary.has_more_nodes.then_some(primary.nodes.len());
    primary.next_edge_offset = primary.has_more_edges.then_some(primary.edges.len());
    primary.status = combined_status(primary).to_string();
}

fn combined_status(response: &KnowledgeResponse) -> &'static str {
    if response.readable_pools == 0 && !response.diagnostics.is_empty() {
        "error"
    } else if response
        .diagnostics
        .iter()
        .any(|diagnostic| !matches!(diagnostic.code.as_str(), "pool_stale" | "pool_checking"))
        || response.readable_pools < response.total_pools
    {
        "partial"
    } else if response.freshness.iter().any(|freshness| freshness.stale) {
        "stale"
    } else if response.total_node_count == 0 {
        "empty"
    } else {
        "complete"
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn read_project_snapshot_filtered(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
    query: Option<&str>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    let node_offset = node_offset.unwrap_or(0);
    let edge_offset = edge_offset.unwrap_or(0);
    let node_limit = node_limit
        .unwrap_or(DEFAULT_NODE_LIMIT)
        .clamp(1, MAX_NODE_LIMIT);
    let edge_limit = filters
        .neighbor
        .as_ref()
        .map(|_| {
            filters
                .neighbor_limit
                .unwrap_or(DEFAULT_NEIGHBOR_LIMIT)
                .clamp(1, MAX_NEIGHBOR_LIMIT)
        })
        .unwrap_or_else(|| {
            edge_limit
                .unwrap_or(DEFAULT_EDGE_LIMIT)
                .clamp(1, MAX_EDGE_LIMIT)
        });
    let search_limit = search_limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let node_kinds = sanitize_kinds(filters.node_kinds.as_deref(), &NODE_KINDS);
    let edge_kinds = sanitize_kinds(filters.edge_kinds.as_deref(), &EDGE_KINDS);
    let edge_source_kinds = sanitize_kinds(filters.edge_source_kinds.as_deref(), &NODE_KINDS);
    let (mut keys, mut diagnostics, total_pools) = scoped_keys(state, project, scope).await;
    keys.sort_by_key(key_sort);
    let mut nodes = Vec::new();
    let mut raw_edges = Vec::new();
    let mut searches = Vec::new();
    let mut freshness = Vec::new();
    let mut total_nodes = 0usize;
    let mut total_edges = 0usize;
    let mut readable_pools = 0usize;
    let mut node_skip = node_offset;
    let mut edge_skip = edge_offset;
    let mut node_remaining = node_limit;
    let mut edge_remaining = edge_limit;
    let mut saw_stale = false;
    let mut incoming_links = Vec::new();
    let mut incoming_link_scan_remaining = MAX_INCOMING_LINK_SCAN;
    let mut incoming_link_scan_truncated = false;

    for key in keys {
        let node_sources =
            scoped_sources(&key, filters.source.as_ref(), filters.sources.as_deref());
        let edge_sources = scoped_sources(&key, None, filters.edge_sources.as_deref());
        let space_id = IndexState::space_id_for_key(&key);
        let rebuilding = state.reindex_active_flag(&key).await.load(Ordering::SeqCst);
        let reconciling = state
            .reconcile_active_flag(&key)
            .await
            .load(Ordering::SeqCst);
        let stale = rebuilding || reconciling;
        if rebuilding {
            saw_stale = true;
            diagnostics.push(KnowledgeDiagnostic {
                space_id: space_id.clone(),
                code: "pool_stale".to_string(),
                message: "A previous prepared snapshot is being refreshed".to_string(),
            });
        } else if reconciling {
            saw_stale = true;
            diagnostics.push(KnowledgeDiagnostic {
                space_id: space_id.clone(),
                code: "pool_checking".to_string(),
                message: "The cached snapshot is being checked for source changes".to_string(),
            });
        }
        let Some(pool) = state.existing_pool(&key).await else {
            diagnostics.push(KnowledgeDiagnostic {
                space_id,
                code: "pool_unavailable".to_string(),
                message: "The prepared snapshot pool is not open".to_string(),
            });
            continue;
        };
        let manifest = match read_manifest(&pool).await {
            Ok(Some(manifest)) => manifest,
            Ok(None) => {
                diagnostics.push(KnowledgeDiagnostic {
                    space_id,
                    code: "snapshot_unavailable".to_string(),
                    message: "The pool has not produced a knowledge snapshot yet".to_string(),
                });
                continue;
            }
            Err(error) => {
                tracing::warn!("knowledge manifest read failed for {:?}: {error}", key);
                diagnostics.push(KnowledgeDiagnostic {
                    space_id,
                    code: "pool_unavailable".to_string(),
                    message: "The prepared snapshot could not be read".to_string(),
                });
                continue;
            }
        };
        readable_pools += 1;
        let pool_node_count = count_nodes(&pool, &node_kinds, node_sources.as_deref())
            .await
            .unwrap_or(0);
        let pool_edge_count = count_edges(
            &pool,
            &edge_kinds,
            &edge_source_kinds,
            edge_sources.as_deref(),
            filters.neighbor.as_ref(),
            &key,
        )
        .await
        .unwrap_or(0);
        total_nodes += pool_node_count;
        total_edges += pool_edge_count;
        freshness.push(KnowledgePoolFreshness {
            space_id: IndexState::space_id_for_key(&key),
            stale,
            ..manifest
        });

        let local_node_offset = node_skip.min(pool_node_count);
        node_skip -= local_node_offset;
        let local_node_limit =
            node_remaining.min(pool_node_count.saturating_sub(local_node_offset));
        if local_node_limit > 0 {
            node_remaining -= local_node_limit;
            match read_pool_nodes(
                &pool,
                &key,
                local_node_offset,
                local_node_limit,
                &node_kinds,
                node_sources.as_deref(),
            )
            .await
            {
                Ok(mut rows) => nodes.append(&mut rows),
                Err(error) => diagnostics.push(read_diagnostic(&key, "pool_read_failed", &error)),
            }
        }

        let local_edge_offset = edge_skip.min(pool_edge_count);
        edge_skip -= local_edge_offset;
        let local_edge_limit =
            edge_remaining.min(pool_edge_count.saturating_sub(local_edge_offset));
        if local_edge_limit > 0 {
            edge_remaining -= local_edge_limit;
            match read_pool_edges(
                &pool,
                &key,
                local_edge_offset,
                local_edge_limit,
                &edge_kinds,
                &edge_source_kinds,
                edge_sources.as_deref(),
                filters.neighbor.as_ref(),
            )
            .await
            {
                Ok(mut rows) => raw_edges.append(&mut rows),
                Err(error) => diagnostics.push(read_diagnostic(&key, "pool_read_failed", &error)),
            }
        }
        match read_pool_search(
            &pool,
            &key,
            query,
            search_limit,
            &node_kinds,
            node_sources.as_deref(),
        )
        .await
        {
            Ok(mut rows) => searches.append(&mut rows),
            Err(error) => diagnostics.push(read_diagnostic(&key, "pool_search_failed", &error)),
        }
        if edge_kinds.iter().any(|kind| kind == "links_to")
            && let Some(neighbor) = filters.neighbor.as_ref()
        {
            match read_incoming_markdown_links(
                state,
                project,
                &pool,
                &key,
                neighbor,
                &edge_source_kinds,
                edge_sources.as_deref(),
                incoming_link_scan_remaining,
            )
            .await
            {
                Ok((mut matches, scanned, truncated)) => {
                    incoming_link_scan_remaining =
                        incoming_link_scan_remaining.saturating_sub(scanned);
                    incoming_link_scan_truncated |= truncated;
                    incoming_links.append(&mut matches);
                }
                Err(error) => {
                    diagnostics.push(read_diagnostic(&key, "incoming_links_read_failed", &error))
                }
            }
        }
    }

    incoming_links.sort_by(|left, right| {
        key_sort(&left.key)
            .cmp(&key_sort(&right.key))
            .then_with(|| left.source_path.cmp(&right.source_path))
            .then_with(|| left.byte_start.cmp(&right.byte_start))
            .then_with(|| left.target_url.cmp(&right.target_url))
    });
    total_edges += incoming_links.len();
    let incoming_offset = edge_skip.min(incoming_links.len());
    let incoming_limit = edge_remaining.min(incoming_links.len().saturating_sub(incoming_offset));
    if incoming_limit > 0 {
        raw_edges.extend(
            incoming_links
                .into_iter()
                .skip(incoming_offset)
                .take(incoming_limit),
        );
    }
    if incoming_link_scan_truncated {
        diagnostics.push(KnowledgeDiagnostic {
            space_id: filters
                .neighbor
                .as_ref()
                .and_then(|source| source.space_id.clone()),
            code: "incoming_links_truncated".to_string(),
            message: format!(
                "Incoming Markdown neighbor resolution reached the bounded {MAX_INCOMING_LINK_SCAN}-edge scan limit"
            ),
        });
    }

    searches.sort_by(|left, right| {
        search_rank(&left.title, left.snippet.as_deref(), query)
            .cmp(&search_rank(&right.title, right.snippet.as_deref(), query))
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    searches.truncate(search_limit);
    let mut space_names = HashMap::new();
    for key in nodes
        .iter()
        .map(|row| &row.key)
        .chain(searches.iter().map(|row| &row.key))
    {
        if !space_names.contains_key(key) {
            space_names.insert(key.clone(), state.space_name(key).await);
        }
    }
    let nodes = nodes
        .into_iter()
        .map(|row| {
            let source = source_for(&row.key, &row.path, &row.kind);
            KnowledgeNode {
                id: node_id(&source),
                source,
                space_name: space_names.get(&row.key).cloned().unwrap_or_default(),
                title: row.title,
                content_hash: row.content_hash,
                source_updated_at: row.source_updated_at,
                checked_at: row.checked_at,
                canonical_source_path: row.canonical_source_path,
                provenance: serde_json::from_str(&row.provenance_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
            }
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::with_capacity(raw_edges.len());
    for row in raw_edges {
        edges.push(resolve_edge(state, project, row).await);
    }
    let search_items = searches
        .into_iter()
        .map(|row| {
            let source = source_for(&row.key, &row.path, &row.kind);
            KnowledgeSearchItem {
                rank: search_rank(&row.title, row.snippet.as_deref(), query),
                node_id: node_id(&source),
                source,
                space_name: space_names.get(&row.key).cloned().unwrap_or_default(),
                title: row.title,
                snippet: row.snippet,
                location_path: row.location_path,
                line_start: row.line_start.map(|value| value as usize),
                line_end: row.line_end.map(|value| value as usize),
                provenance: serde_json::from_str(&row.provenance_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
                snippet_truncated: row.snippet_truncated,
            }
        })
        .collect();
    let omitted_node_count = total_nodes.saturating_sub(nodes.len());
    let omitted_edge_count = total_edges.saturating_sub(edges.len());
    let next_node_cursor = node_offset.saturating_add(node_limit).min(total_nodes);
    let next_edge_cursor = edge_offset.saturating_add(edge_limit).min(total_edges);
    let has_more_nodes = next_node_cursor < total_nodes;
    let has_more_edges = next_edge_cursor < total_edges;
    let hard_diagnostics = diagnostics
        .iter()
        .any(|item| !matches!(item.code.as_str(), "pool_stale" | "pool_checking"));
    let status = if readable_pools == 0 && !diagnostics.is_empty() {
        "error"
    } else if hard_diagnostics || readable_pools < total_pools {
        "partial"
    } else if saw_stale {
        "stale"
    } else if total_nodes == 0 {
        "empty"
    } else {
        "complete"
    };
    KnowledgeResponse {
        status: status.to_string(),
        nodes,
        edges,
        search_items,
        freshness,
        diagnostics,
        readable_pools,
        total_pools,
        truncated: omitted_node_count > 0 || omitted_edge_count > 0 || incoming_link_scan_truncated,
        total_node_count: total_nodes,
        total_edge_count: total_edges,
        omitted_node_count,
        omitted_edge_count,
        next_node_offset: has_more_nodes.then_some(next_node_cursor),
        next_edge_offset: has_more_edges.then_some(next_edge_cursor),
        has_more_nodes,
        has_more_edges,
    }
}

async fn resolve_edge(state: &IndexState, project: &Path, row: PoolEdge) -> KnowledgeEdge {
    let source = source_for(&row.key, &row.source_path, &row.source_kind);
    let resolved = if row.target_scope == "resolve" {
        state
            .resolve_link_target_key(
                project,
                source.space_id.as_deref(),
                &source.path,
                &row.target_url,
            )
            .await
            .ok()
            .flatten()
    } else {
        target_key(
            state,
            project,
            &row.key,
            &row.target_scope,
            row.target_path.as_deref(),
        )
        .await
    };
    let (target, target_status) = match resolved {
        Some((target_key, target_path)) => {
            let kind = match state.existing_pool(&target_key).await {
                Some(pool) => node_kind_for(&pool, &target_path).await.ok().flatten(),
                None => None,
            };
            match kind {
                Some(kind) => (Some(source_for(&target_key, &target_path, &kind)), "ready"),
                None => {
                    let target = row
                        .target_kind
                        .as_deref()
                        .map(|kind| source_for(&target_key, &target_path, kind));
                    (target, "broken")
                }
            }
        }
        None => (None, "broken"),
    };
    KnowledgeEdge {
        kind: row.kind,
        source_id: node_id(&source),
        source,
        target_id: target.as_ref().map(node_id),
        target,
        target_url: row.target_url,
        target_status: target_status.to_string(),
        origin: "explicit".to_string(),
        field_name: row.field_name,
        location_path: row.location_path,
        byte_start: row.byte_start as usize,
        byte_end: row.byte_end as usize,
    }
}

async fn target_key(
    state: &IndexState,
    project: &Path,
    current: &IndexKey,
    scope: &str,
    target_path: Option<&str>,
) -> Option<(IndexKey, String)> {
    let path = target_path?.to_string();
    let key = if scope == "current" {
        current.clone()
    } else if scope == "root" {
        IndexKey::Root(project.to_path_buf())
    } else if let Some(space_id) = scope.strip_prefix("space:") {
        state
            .key_for_project_space_id(project, Some(space_id))
            .await
            .ok()?
    } else {
        return None;
    };
    Some((key, path))
}

fn sanitize_kinds(requested: Option<&[String]>, allowed: &[&str]) -> Vec<String> {
    let allowed = allowed.iter().copied().collect::<BTreeSet<_>>();
    let mut values = requested
        .unwrap_or_default()
        .iter()
        .filter(|value| allowed.contains(value.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if requested.is_none() {
        values = allowed.into_iter().map(ToString::to_string).collect();
    }
    values.sort();
    values.dedup();
    values
}

async fn count_nodes(
    pool: &SqlitePool,
    kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
) -> Result<usize, AppError> {
    if kinds.is_empty() || sources.is_some_and(<[KnowledgeSource]>::is_empty) {
        return Ok(0);
    }
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*) FROM knowledge_documents WHERE node_kind IN (",
    );
    let mut separated = query.separated(",");
    for kind in kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    push_source_filter(&mut query, "source_path", "node_kind", sources);
    let count: i64 = query.build_query_scalar().fetch_one(pool).await?;
    Ok(count as usize)
}

async fn count_edges(
    pool: &SqlitePool,
    kinds: &[String],
    source_kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
    neighbor: Option<&KnowledgeSource>,
    key: &IndexKey,
) -> Result<usize, AppError> {
    if kinds.is_empty()
        || source_kinds.is_empty()
        || sources.is_some_and(<[KnowledgeSource]>::is_empty)
    {
        return Ok(0);
    }
    let mut query = edge_query(
        "SELECT COUNT(*)",
        kinds,
        source_kinds,
        sources,
        neighbor,
        key,
    );
    let count: i64 = query.build_query_scalar().fetch_one(pool).await?;
    Ok(count as usize)
}

fn edge_query<'a>(
    select: &str,
    kinds: &'a [String],
    source_kinds: &'a [String],
    sources: Option<&'a [KnowledgeSource]>,
    neighbor: Option<&'a KnowledgeSource>,
    key: &IndexKey,
) -> QueryBuilder<'a, Sqlite> {
    let mut query = QueryBuilder::<Sqlite>::new(select);
    query.push(" FROM knowledge_links l JOIN knowledge_documents d ON d.source_path=l.source_path WHERE l.edge_kind IN (");
    let mut separated = query.separated(",");
    for kind in kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    query.push(" AND d.node_kind IN (");
    let mut separated = query.separated(",");
    for kind in source_kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    push_source_filter(&mut query, "l.source_path", "d.node_kind", sources);
    if let Some(neighbor) = neighbor {
        let source_pool_matches = neighbor.space_id == IndexState::space_id_for_key(key);
        query.push(" AND (");
        let mut has_clause = false;
        if source_pool_matches {
            query.push("l.source_path = ").push_bind(&neighbor.path);
            has_clause = true;
        }
        let target_scope = match neighbor.space_id.as_deref() {
            None => "root".to_string(),
            Some(space_id) => format!("space:{space_id}"),
        };
        if has_clause {
            query.push(" OR ");
        }
        query
            .push("(l.target_path = ")
            .push_bind(&neighbor.path)
            .push(" AND (l.target_scope = ")
            .push_bind(target_scope);
        if source_pool_matches {
            query.push(" OR l.target_scope = 'current'");
        }
        query.push("))");
        query.push(")");
    }
    query
}

async fn read_pool_nodes(
    pool: &SqlitePool,
    key: &IndexKey,
    offset: usize,
    limit: usize,
    kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
) -> Result<Vec<PoolNode>, AppError> {
    if kinds.is_empty() || sources.is_some_and(<[KnowledgeSource]>::is_empty) {
        return Ok(Vec::new());
    }
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT source_path,node_kind,title,content_hash,source_updated_at,checked_at,canonical_source_path,provenance_json FROM knowledge_documents WHERE node_kind IN (",
    );
    let mut separated = query.separated(",");
    for kind in kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    push_source_filter(&mut query, "source_path", "node_kind", sources);
    query
        .push(" ORDER BY node_kind,source_path LIMIT ")
        .push_bind(limit as i64)
        .push(" OFFSET ")
        .push_bind(offset as i64);
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )> = query.build_query_as().fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| PoolNode {
            key: key.clone(),
            path: row.0,
            kind: row.1,
            title: row.2,
            content_hash: row.3,
            source_updated_at: row.4,
            checked_at: row.5,
            canonical_source_path: row.6,
            provenance_json: row.7,
        })
        .collect())
}

async fn read_pool_edges(
    pool: &SqlitePool,
    key: &IndexKey,
    offset: usize,
    limit: usize,
    kinds: &[String],
    source_kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
    neighbor: Option<&KnowledgeSource>,
) -> Result<Vec<PoolEdge>, AppError> {
    if kinds.is_empty()
        || source_kinds.is_empty()
        || sources.is_some_and(<[KnowledgeSource]>::is_empty)
    {
        return Ok(Vec::new());
    }
    let mut query = edge_query(
        "SELECT l.source_path,d.node_kind,l.edge_kind,l.target_url,l.target_scope,l.target_path,l.target_kind,l.field_name,l.location_path,l.byte_start,l.byte_end",
        kinds,
        source_kinds,
        sources,
        neighbor,
        key,
    );
    query
        .push(" ORDER BY l.source_path,l.edge_kind,l.byte_start,l.target_url LIMIT ")
        .push_bind(limit as i64)
        .push(" OFFSET ")
        .push_bind(offset as i64);
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
        i64,
    )> = query.build_query_as().fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| PoolEdge {
            key: key.clone(),
            source_path: row.0,
            source_kind: row.1,
            kind: row.2,
            target_url: row.3,
            target_scope: row.4,
            target_path: row.5,
            target_kind: row.6,
            field_name: row.7,
            location_path: row.8,
            byte_start: row.9,
            byte_end: row.10,
        })
        .collect())
}

async fn read_pool_search(
    pool: &SqlitePool,
    key: &IndexKey,
    query_text: Option<&str>,
    limit: usize,
    kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
) -> Result<Vec<PoolSearchItem>, AppError> {
    if kinds.is_empty() || sources.is_some_and(<[KnowledgeSource]>::is_empty) {
        return Ok(Vec::new());
    }
    let query_text = query_text.unwrap_or("").trim();
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT d.source_path,d.node_kind,d.title,substr(f.text,1,240),f.location_path,f.line_start,f.line_end,d.provenance_json,length(COALESCE(f.text,''))>240 FROM knowledge_documents d LEFT JOIN knowledge_fragments f ON f.source_path=d.source_path AND f.ordinal=0 WHERE d.node_kind IN (",
    );
    let mut separated = query.separated(",");
    for kind in kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    push_source_filter(&mut query, "d.source_path", "d.node_kind", sources);
    if !query_text.is_empty() {
        query
            .push(" AND (instr(lower(d.title),lower(")
            .push_bind(query_text)
            .push("))>0 OR instr(lower(COALESCE(f.text,'')),lower(")
            .push_bind(query_text)
            .push("))>0)");
    }
    query
        .push(" ORDER BY d.source_updated_at DESC,d.node_kind,d.source_path LIMIT ")
        .push_bind(limit as i64);
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        String,
        bool,
    )> = query.build_query_as().fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| PoolSearchItem {
            key: key.clone(),
            path: row.0,
            kind: row.1,
            title: row.2,
            snippet: row.3,
            location_path: row.4,
            line_start: row.5,
            line_end: row.6,
            provenance_json: row.7,
            snippet_truncated: row.8,
        })
        .collect())
}

fn scoped_sources(
    key: &IndexKey,
    source: Option<&KnowledgeSource>,
    sources: Option<&[KnowledgeSource]>,
) -> Option<Vec<KnowledgeSource>> {
    if source.is_none() && sources.is_none() {
        return None;
    }
    let key_space_id = IndexState::space_id_for_key(key);
    Some(
        source
            .into_iter()
            .chain(sources.into_iter().flatten())
            .filter(|source| source.space_id == key_space_id)
            .cloned()
            .collect(),
    )
}

fn push_source_filter<'a>(
    query: &mut QueryBuilder<'a, Sqlite>,
    path_column: &str,
    kind_column: &str,
    sources: Option<&'a [KnowledgeSource]>,
) {
    let Some(sources) = sources else {
        return;
    };
    query.push(" AND (");
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            query.push(" OR ");
        }
        query
            .push("(")
            .push(path_column)
            .push(" = ")
            .push_bind(&source.path)
            .push(" AND ")
            .push(kind_column)
            .push(" = ")
            .push_bind(&source.kind)
            .push(")");
    }
    query.push(")");
}

fn search_rank(title: &str, snippet: Option<&str>, query: Option<&str>) -> usize {
    let query = query.unwrap_or_default().trim().to_lowercase();
    if query.is_empty() {
        return 0;
    }
    let title = title.to_lowercase();
    if title == query {
        0
    } else if title.contains(&query) {
        1
    } else if snippet.is_some_and(|snippet| snippet.to_lowercase().contains(&query)) {
        2
    } else {
        3
    }
}

async fn read_incoming_markdown_links(
    state: &IndexState,
    project: &Path,
    pool: &SqlitePool,
    key: &IndexKey,
    neighbor: &KnowledgeSource,
    source_kinds: &[String],
    sources: Option<&[KnowledgeSource]>,
    scan_limit: usize,
) -> Result<(Vec<PoolEdge>, usize, bool), AppError> {
    if source_kinds.is_empty() || sources.is_some_and(<[KnowledgeSource]>::is_empty) {
        return Ok((Vec::new(), 0, false));
    }
    let fetch_limit = scan_limit.saturating_add(1).min(MAX_INCOMING_LINK_SCAN + 1);
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT l.source_path,d.node_kind,l.edge_kind,l.target_url,l.target_scope,l.target_path,l.target_kind,l.field_name,l.location_path,l.byte_start,l.byte_end \
         FROM knowledge_links l JOIN knowledge_documents d ON d.source_path=l.source_path \
        WHERE l.edge_kind='links_to'",
    );
    query.push(" AND d.node_kind IN (");
    let mut separated = query.separated(",");
    for kind in source_kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
    push_source_filter(&mut query, "l.source_path", "d.node_kind", sources);
    if neighbor.space_id == IndexState::space_id_for_key(key) {
        query
            .push(" AND l.source_path != ")
            .push_bind(&neighbor.path);
    }
    query
        .push(" ORDER BY l.source_path,l.byte_start,l.target_url LIMIT ")
        .push_bind(fetch_limit as i64);
    let mut rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
        i64,
    )> = query.build_query_as().fetch_all(pool).await?;
    let truncated = rows.len() > scan_limit;
    rows.truncate(scan_limit);
    let scanned = rows.len();
    let mut matches = Vec::new();
    for row in rows {
        let resolved = state
            .resolve_link_target_key(
                project,
                IndexState::space_id_for_key(key).as_deref(),
                &row.0,
                &row.3,
            )
            .await
            .ok()
            .flatten();
        if resolved.as_ref().is_some_and(|(target_key, target_path)| {
            IndexState::space_id_for_key(target_key) == neighbor.space_id
                && target_path == &neighbor.path
        }) {
            matches.push(PoolEdge {
                key: key.clone(),
                source_path: row.0,
                source_kind: row.1,
                kind: row.2,
                target_url: row.3,
                target_scope: row.4,
                target_path: row.5,
                target_kind: row.6,
                field_name: row.7,
                location_path: row.8,
                byte_start: row.9,
                byte_end: row.10,
            });
        }
    }
    Ok((matches, scanned, truncated))
}

async fn node_kind_for(pool: &SqlitePool, path: &str) -> Result<Option<String>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT node_kind FROM knowledge_documents WHERE source_path=?")
            .bind(path)
            .fetch_optional(pool)
            .await?,
    )
}

async fn read_manifest(pool: &SqlitePool) -> Result<Option<KnowledgePoolFreshness>, AppError> {
    let row: Option<(String,i64,i64,i64,i64)> = sqlx::query_as("SELECT checked_at,document_count,link_count,skipped_count,failure_count FROM knowledge_manifest WHERE singleton=1").fetch_optional(pool).await?;
    Ok(row.map(|row| KnowledgePoolFreshness {
        space_id: None,
        checked_at: row.0,
        page_count: row.1 as usize,
        link_count: row.2 as usize,
        skipped_count: row.3 as usize,
        failure_count: row.4 as usize,
        stale: false,
    }))
}

async fn scoped_keys(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
) -> (Vec<IndexKey>, Vec<KnowledgeDiagnostic>, usize) {
    match scope {
        Some(KnowledgeScope::Space { space_id }) => {
            let key = match space_id.as_deref() {
                None => Some(IndexKey::Root(project.to_path_buf())),
                Some(id) => state.key_for_project_space_id(project, Some(id)).await.ok(),
            };
            match key {
                Some(key) => (vec![key], Vec::new(), 1),
                None => (
                    Vec::new(),
                    vec![KnowledgeDiagnostic {
                        space_id,
                        code: "space_unavailable".into(),
                        message: "The requested Space is not ready".into(),
                    }],
                    1,
                ),
            }
        }
        Some(KnowledgeScope::Project) | None => {
            let keys = state.keys_for_project(&project.to_path_buf()).await;
            let cache = state.spaces_cache.lock().await;
            let mut diagnostics = Vec::new();
            let mut unavailable = 0;
            if let Some(cache) = cache.get(project) {
                for (space_id, status) in &cache.status_by_id {
                    if !matches!(status, SpaceStatus::Ready) {
                        unavailable += 1;
                        diagnostics.push(KnowledgeDiagnostic {
                            space_id: Some(space_id.clone()),
                            code: "space_unavailable".into(),
                            message: format!("Space status is {status:?}"),
                        });
                    }
                }
            }
            let total = keys.len() + unavailable;
            (keys, diagnostics, total)
        }
    }
}

fn read_diagnostic(key: &IndexKey, code: &str, error: &AppError) -> KnowledgeDiagnostic {
    tracing::warn!("knowledge {code} for {:?}: {error}", key);
    KnowledgeDiagnostic {
        space_id: IndexState::space_id_for_key(key),
        code: code.to_string(),
        message: "The prepared projection could not be read".to_string(),
    }
}

fn source_for(key: &IndexKey, path: &str, kind: &str) -> KnowledgeSource {
    KnowledgeSource {
        space_id: IndexState::space_id_for_key(key),
        path: path.to_string(),
        kind: kind.to_string(),
    }
}

fn node_id(source: &KnowledgeSource) -> String {
    format!(
        "{}:{}:{}",
        source.kind,
        source.space_id.as_deref().unwrap_or("root"),
        source.path
    )
}

fn key_sort(key: &IndexKey) -> (u8, String) {
    match key {
        IndexKey::Root(_) => (0, String::new()),
        IndexKey::Space { space_id, .. } => (1, space_id.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{ProjectSpacesCache, reindex::full_reindex, update};
    use crate::space::types::SpaceStatus;
    use std::collections::{BTreeSet, HashMap};
    use std::fs;
    use tempfile::TempDir;

    fn test_artifact(path: &str, kind: &str, text: &str) -> KnowledgeArtifact {
        finish_artifact(
            path,
            kind,
            path,
            "2026-08-09T00:00:00Z",
            text,
            path,
            serde_json::json!({ "physical": true }),
            text.to_string(),
            Vec::new(),
        )
    }

    async fn replace_test_snapshot(
        pool: &SqlitePool,
        artifacts: &[KnowledgeArtifact],
        applicability: &[KnowledgeAgentApplicability],
    ) {
        let mut tx = pool.begin().await.unwrap();
        replace_all(&mut tx, artifacts, applicability, 0, 0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn owner_content_and_templates_are_excluded_while_pages_remain_nodes() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join(".templates")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        fs::write(project.join("tasks/item.md"), "Unlinked body").unwrap();
        fs::write(project.join("README.md"), "Space owner content").unwrap();
        fs::write(project.join(".templates/hidden.md"), "Hidden").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT source_path,node_kind FROM knowledge_documents ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("tasks".to_string(), "collection".to_string()),
                ("tasks/item.md".to_string(), "page".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn effective_child_scope_uses_prepared_agent_applicability_without_document_leakage() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("child/.svode")).unwrap();
        fs::create_dir_all(project.join("sibling/.svode")).unwrap();

        let state = IndexState::new();
        state.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([
                    ("child".to_string(), "child-space".to_string()),
                    ("sibling".to_string(), "sibling-space".to_string()),
                ]),
                folder_by_id: HashMap::from([
                    ("child-space".to_string(), "child".to_string()),
                    ("sibling-space".to_string(), "sibling".to_string()),
                ]),
                status_by_id: HashMap::from([
                    ("child-space".to_string(), SpaceStatus::Ready),
                    ("sibling-space".to_string(), SpaceStatus::Ready),
                ]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([
                    ("child-space".to_string(), "Child".to_string()),
                    ("sibling-space".to_string(), "Sibling".to_string()),
                ]),
            },
        );

        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let child_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "child-space".to_string(),
            })
            .await
            .unwrap();
        let sibling_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "sibling-space".to_string(),
            })
            .await
            .unwrap();

        replace_test_snapshot(
            &root_pool,
            &[
                test_artifact("root.md", "page", "root page"),
                test_artifact(
                    "AGENTS.md",
                    "agent_instruction",
                    "effective root instructions",
                ),
                test_artifact(
                    "shadowed/AGENTS.md",
                    "agent_instruction",
                    "not effective for child",
                ),
            ],
            &[],
        )
        .await;
        let mut child_page = test_artifact("child.md", "page", "🙂🙂");
        child_page.edges = (0..=RELATED_NEIGHBORS_PER_ITEM)
            .map(|index| KnowledgeEdgeArtifact {
                kind: "links_to".to_string(),
                target_url: format!("related-{index}.md"),
                target_scope: "resolve".to_string(),
                target_path: None,
                target_kind: None,
                field_name: None,
                location_path: "child.md".to_string(),
                byte_start: index as i64,
                byte_end: index as i64,
            })
            .collect();
        replace_test_snapshot(
            &child_pool,
            &[
                child_page,
                test_artifact("AGENTS.md", "agent_instruction", "local instructions"),
            ],
            &[
                KnowledgeAgentApplicability {
                    source_scope: "current".to_string(),
                    source_path: "AGENTS.md".to_string(),
                    node_kind: "agent_instruction".to_string(),
                    provenance: serde_json::json!({ "scopeApplicability": "local" }),
                },
                KnowledgeAgentApplicability {
                    source_scope: "root".to_string(),
                    source_path: "AGENTS.md".to_string(),
                    node_kind: "agent_instruction".to_string(),
                    provenance: serde_json::json!({ "scopeApplicability": "inherited" }),
                },
            ],
        )
        .await;
        replace_test_snapshot(
            &sibling_pool,
            &[test_artifact("sibling.md", "page", "sibling page")],
            &[],
        )
        .await;

        let effective = read_effective_space_snapshot_filtered(
            &state,
            project,
            Some("child-space".to_string()),
            None,
            32,
            32,
            32,
            KnowledgeFilters::default(),
        )
        .await;
        let sources = effective
            .nodes
            .iter()
            .map(|node| {
                (
                    node.source.space_id.clone(),
                    node.source.path.clone(),
                    node.source.kind.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            sources,
            BTreeSet::from([
                (
                    None,
                    "AGENTS.md".to_string(),
                    "agent_instruction".to_string(),
                ),
                (
                    Some("child-space".to_string()),
                    "AGENTS.md".to_string(),
                    "agent_instruction".to_string(),
                ),
                (
                    Some("child-space".to_string()),
                    "child.md".to_string(),
                    "page".to_string(),
                ),
            ])
        );
        assert!(!sources.iter().any(|(_, path, _)| path == "root.md"));
        assert!(!sources.iter().any(|(_, path, _)| path == "sibling.md"));
        assert!(
            !sources
                .iter()
                .any(|(_, path, _)| path == "shadowed/AGENTS.md")
        );
        let inherited = effective
            .nodes
            .iter()
            .find(|node| node.source.space_id.is_none() && node.source.path == "AGENTS.md")
            .unwrap();
        assert_eq!(inherited.provenance["scopeApplicability"], "inherited");
        assert_eq!(inherited.provenance["effectiveSpaceId"], "child-space");

        let related = read_related_context(
            &state,
            project,
            KnowledgeScope::Space {
                space_id: Some("child-space".to_string()),
            },
            "🙂",
            8,
            5,
            None,
        )
        .await;
        assert_eq!(related.used_budget, 4);
        assert!(related.used_budget <= related.text_budget);
        assert_eq!(related.context.len(), 1);
        assert_eq!(related.context[0].text, "🙂");
        assert!(related.context[0].truncated);
        assert!(related.truncated);

        let related = read_related_context(
            &state,
            project,
            KnowledgeScope::Space {
                space_id: Some("child-space".to_string()),
            },
            "🙂",
            8,
            4_000,
            None,
        )
        .await;
        assert_eq!(related.neighbors.len(), RELATED_NEIGHBORS_PER_ITEM);
        assert!(related.truncated);

        let root = read_effective_space_snapshot_filtered(
            &state,
            project,
            None,
            None,
            32,
            32,
            32,
            KnowledgeFilters::default(),
        )
        .await;
        assert!(root.nodes.iter().any(|node| node.source.path == "root.md"));
        assert!(!root.nodes.iter().any(|node| node.source.space_id.is_some()));

        let project_wide = read_project_snapshot_filtered(
            &state,
            project,
            Some(KnowledgeScope::Project),
            None,
            None,
            None,
            Some(32),
            Some(32),
            Some(32),
            KnowledgeFilters::default(),
        )
        .await;
        assert!(
            project_wide
                .nodes
                .iter()
                .any(|node| node.source.path == "sibling.md")
        );
        assert_eq!(
            project_wide
                .nodes
                .iter()
                .filter(|node| node.source.path == "AGENTS.md")
                .count(),
            2
        );
    }

    #[test]
    fn related_context_utf8_budget_never_splits_a_codepoint() {
        let (prefix, truncated) = utf8_prefix("a🙂b", 4);
        assert_eq!(prefix, "a");
        assert!(truncated);
        let (prefix, truncated) = utf8_prefix("a🙂b", 5);
        assert_eq!(prefix, "a🙂");
        assert!(truncated);
    }

    #[tokio::test]
    async fn targeted_update_delete_and_noop_are_atomic() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        let path = project.join("note.md");
        fs::write(&path, "[old](old.md)").unwrap();
        let state = IndexState::new();
        update::update_entry(&state, project, &path).await.unwrap();
        let pool = state
            .existing_pool(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        sqlx::query("UPDATE knowledge_manifest SET checked_at='sentinel'")
            .execute(&pool)
            .await
            .unwrap();
        update::update_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT checked_at FROM knowledge_manifest")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "sentinel"
        );
        fs::write(&path, "[new](new.md)").unwrap();
        update::update_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT target_url FROM knowledge_links")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "new.md"
        );
        fs::remove_file(&path).unwrap();
        update::delete_entry(&state, project, &path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM knowledge_documents")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn empty_collection_folds_readme_and_schema_into_one_logical_node() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(
            project.join("tasks/schema.yaml"),
            "system_fields:\n  title:\n    label: Task name\ncolumns:\n  - name: Status\n    type: text\n",
        )
        .unwrap();
        fs::write(
            project.join("tasks/README.md"),
            "---\ntitle: Work queue\ndescription: Safe description\n---\nCollection body",
        )
        .unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();

        let nodes: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT source_path,node_kind,title FROM knowledge_documents ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            nodes,
            vec![(
                "tasks".to_string(),
                "collection".to_string(),
                "Work queue".to_string()
            )]
        );
        let fragment: String =
            sqlx::query_scalar("SELECT text FROM knowledge_fragments WHERE source_path='tasks'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(fragment.contains("Collection body"));
        assert!(fragment.contains("Task name"));
        assert!(fragment.contains("Status"));
    }

    #[tokio::test]
    async fn typed_relations_member_edges_safe_search_and_filters_share_one_model() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::create_dir_all(project.join("projects")).unwrap();
        fs::write(
            project.join("tasks/schema.yaml"),
            "columns:\n  - name: Project\n    type: relation\n    relation: projects\n  - name: Secret\n    type: text\n",
        )
        .unwrap();
        fs::write(project.join("projects/schema.yaml"), "columns: []\n").unwrap();
        fs::write(
            project.join("tasks/item.md"),
            "---\ntitle: Item\nProject: alpha.md\nSecret: must-not-leak\n---\nPublic body",
        )
        .unwrap();
        fs::write(
            project.join("projects/alpha.md"),
            "---\ntitle: Alpha\n---\nAlpha body",
        )
        .unwrap();
        fs::write(project.join("source.md"), "See [the item](tasks/item.md)").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();

        let edges: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT edge_kind,target_url,field_name FROM knowledge_links \
             WHERE source_path='tasks/item.md' ORDER BY edge_kind,target_url",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            edges,
            vec![
                ("member_of".to_string(), "tasks".to_string(), None),
                (
                    "relation".to_string(),
                    "projects/alpha.md".to_string(),
                    Some("Project".to_string())
                )
            ]
        );
        let leaked = read_project_snapshot(
            &state,
            project,
            None,
            Some("must-not-leak"),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(leaked.search_items.is_empty());
        let relation_target = read_project_snapshot(
            &state,
            project,
            None,
            Some("projects/alpha.md"),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(relation_target.search_items.len(), 1);
        assert_eq!(relation_target.search_items[0].source.path, "tasks/item.md");

        let filtered = read_project_snapshot_filtered(
            &state,
            project,
            None,
            None,
            None,
            None,
            Some(1),
            None,
            None,
            KnowledgeFilters {
                node_kinds: Some(vec!["collection".to_string()]),
                edge_kinds: Some(vec!["relation".to_string(), "member_of".to_string()]),
                edge_source_kinds: None,
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "page".to_string(),
                }),
                neighbor_limit: Some(10),
                source: None,
                sources: None,
                edge_sources: None,
            },
        )
        .await;
        assert_eq!(filtered.total_node_count, 2);
        assert_eq!(filtered.nodes.len(), 1);
        assert!(filtered.has_more_nodes);
        assert_eq!(filtered.total_edge_count, 2);
        assert_eq!(filtered.edges.len(), 2);
        assert!(
            filtered
                .edges
                .iter()
                .all(|edge| edge.source.path == "tasks/item.md")
        );

        let incoming_markdown = read_project_snapshot_filtered(
            &state,
            project,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            KnowledgeFilters {
                node_kinds: None,
                edge_kinds: Some(vec!["links_to".to_string()]),
                edge_source_kinds: None,
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "page".to_string(),
                }),
                neighbor_limit: Some(10),
                source: None,
                sources: None,
                edge_sources: None,
            },
        )
        .await;
        assert_eq!(incoming_markdown.total_edge_count, 1);
        assert_eq!(incoming_markdown.edges.len(), 1);
        assert_eq!(incoming_markdown.edges[0].source.path, "source.md");
        assert_eq!(incoming_markdown.edges[0].target_status, "ready");
    }

    #[tokio::test]
    async fn targeted_collection_readme_update_replaces_folded_fragment() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        let readme = project.join("tasks/README.md");
        fs::write(&readme, "# Tasks\nOld body").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();
        fs::write(&readme, "# Tasks\nNew body").unwrap();
        update::update_entry(&state, project, &readme)
            .await
            .unwrap();
        let fragment: String =
            sqlx::query_scalar("SELECT text FROM knowledge_fragments WHERE source_path='tasks'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(fragment.contains("New body"));
        assert!(!fragment.contains("Old body"));
        let readme_nodes: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM knowledge_documents WHERE source_path='tasks/README.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(readme_nodes, 0);
    }
}
