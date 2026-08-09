use std::collections::{BTreeSet, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path};
use std::sync::atomic::Ordering;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool, Transaction};

use crate::agent_context::projection::ProjectKnowledgeArtifact;
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
const NODE_KINDS: [&str; 5] = [
    "document",
    "collection",
    "entry",
    "agent_instruction",
    "skill",
];
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

pub(crate) fn build_file_artifact(
    source_path: &str,
    title: &str,
    source_updated_at: &str,
    raw: &str,
    body: &str,
    collection_root: Option<&str>,
    relations: &[KnowledgeRelationProjection],
) -> Option<KnowledgeArtifact> {
    if is_excluded_source(source_path)
        || is_agent_context_source(source_path)
        || is_collection_readme(source_path, collection_root)
    {
        return None;
    }
    let kind = if collection_root.is_some() {
        "entry"
    } else {
        "document"
    };
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
            target_kind: Some("entry".to_string()),
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
        serde_json::json!({
            "canonicalSourcePath": projection.canonical_source_path,
            "aliases": projection.aliases,
            "availability": projection.availability,
            "discovery": projection.discovery,
            "truncated": projection.truncated,
        }),
        projection.text.clone(),
        edges,
    )
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

fn is_collection_readme(source_path: &str, collection_root: Option<&str>) -> bool {
    collection_root.is_some_and(|root| {
        source_path.eq_ignore_ascii_case(
            &crate::properties::knowledge_projection::collection_readme_path(root),
        )
    })
}

pub(crate) async fn replace_all(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
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
    for artifact in artifacts {
        insert_artifact(tx, artifact).await?;
    }
    refresh_manifest(tx, skipped_count, failure_count).await
}

pub(crate) async fn replace_agent_context(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
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
    if existing == next {
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
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
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

async fn refresh_manifest_preserving_diagnostics(
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
    pub neighbor: Option<KnowledgeSource>,
    pub neighbor_limit: Option<usize>,
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
    pub node_id: String,
    pub source: KnowledgeSource,
    pub space_name: String,
    pub title: String,
    pub snippet: Option<String>,
    pub location_path: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePoolFreshness {
    pub space_id: Option<String>,
    pub checked_at: String,
    pub document_count: usize,
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
        let space_id = IndexState::space_id_for_key(&key);
        let stale = state.reindex_active_flag(&key).await.load(Ordering::SeqCst);
        if stale {
            saw_stale = true;
            diagnostics.push(KnowledgeDiagnostic {
                space_id: space_id.clone(),
                code: "pool_stale".to_string(),
                message: "A previous prepared snapshot is being refreshed".to_string(),
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
        let pool_node_count = count_nodes(&pool, &node_kinds).await.unwrap_or(0);
        let pool_edge_count = count_edges(&pool, &edge_kinds, filters.neighbor.as_ref(), &key)
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
                filters.neighbor.as_ref(),
            )
            .await
            {
                Ok(mut rows) => raw_edges.append(&mut rows),
                Err(error) => diagnostics.push(read_diagnostic(&key, "pool_read_failed", &error)),
            }
        }
        match read_pool_search(&pool, &key, query, search_limit, &node_kinds).await {
            Ok(mut rows) => searches.append(&mut rows),
            Err(error) => diagnostics.push(read_diagnostic(&key, "pool_search_failed", &error)),
        }
        if edge_kinds.iter().any(|kind| kind == "links_to") {
            if let Some(neighbor) = filters.neighbor.as_ref() {
                match read_incoming_markdown_links(
                    state,
                    project,
                    &pool,
                    &key,
                    neighbor,
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
                    Err(error) => diagnostics.push(read_diagnostic(
                        &key,
                        "incoming_links_read_failed",
                        &error,
                    )),
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
        left.title
            .to_lowercase()
            .cmp(&right.title.to_lowercase())
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
                node_id: node_id(&source),
                source,
                space_name: space_names.get(&row.key).cloned().unwrap_or_default(),
                title: row.title,
                snippet: row.snippet,
                location_path: row.location_path,
                line_start: row.line_start.map(|value| value as usize),
                line_end: row.line_end.map(|value| value as usize),
            }
        })
        .collect();
    let omitted_node_count = total_nodes.saturating_sub(nodes.len());
    let omitted_edge_count = total_edges.saturating_sub(edges.len());
    let next_node_cursor = node_offset.saturating_add(node_limit).min(total_nodes);
    let next_edge_cursor = edge_offset.saturating_add(edge_limit).min(total_edges);
    let has_more_nodes = next_node_cursor < total_nodes;
    let has_more_edges = next_edge_cursor < total_edges;
    let hard_diagnostics = diagnostics.iter().any(|item| item.code != "pool_stale");
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

async fn count_nodes(pool: &SqlitePool, kinds: &[String]) -> Result<usize, AppError> {
    if kinds.is_empty() {
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
    let count: i64 = query.build_query_scalar().fetch_one(pool).await?;
    Ok(count as usize)
}

async fn count_edges(
    pool: &SqlitePool,
    kinds: &[String],
    neighbor: Option<&KnowledgeSource>,
    key: &IndexKey,
) -> Result<usize, AppError> {
    if kinds.is_empty() {
        return Ok(0);
    }
    let mut query = edge_query("SELECT COUNT(*)", kinds, neighbor, key);
    let count: i64 = query.build_query_scalar().fetch_one(pool).await?;
    Ok(count as usize)
}

fn edge_query<'a>(
    select: &str,
    kinds: &'a [String],
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
) -> Result<Vec<PoolNode>, AppError> {
    if kinds.is_empty() {
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
    neighbor: Option<&KnowledgeSource>,
) -> Result<Vec<PoolEdge>, AppError> {
    if kinds.is_empty() {
        return Ok(Vec::new());
    }
    let mut query = edge_query(
        "SELECT l.source_path,d.node_kind,l.edge_kind,l.target_url,l.target_scope,l.target_path,l.target_kind,l.field_name,l.location_path,l.byte_start,l.byte_end",
        kinds,
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
) -> Result<Vec<PoolSearchItem>, AppError> {
    if kinds.is_empty() {
        return Ok(Vec::new());
    }
    let query_text = query_text.unwrap_or("").trim();
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT d.source_path,d.node_kind,d.title,substr(f.text,1,240),f.location_path,f.line_start,f.line_end FROM knowledge_documents d LEFT JOIN knowledge_fragments f ON f.source_path=d.source_path AND f.ordinal=0 WHERE d.node_kind IN (",
    );
    let mut separated = query.separated(",");
    for kind in kinds {
        separated.push_bind(kind);
    }
    separated.push_unseparated(")");
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
        })
        .collect())
}

async fn read_incoming_markdown_links(
    state: &IndexState,
    project: &Path,
    pool: &SqlitePool,
    key: &IndexKey,
    neighbor: &KnowledgeSource,
    scan_limit: usize,
) -> Result<(Vec<PoolEdge>, usize, bool), AppError> {
    let fetch_limit = scan_limit.saturating_add(1).min(MAX_INCOMING_LINK_SCAN + 1);
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT l.source_path,d.node_kind,l.edge_kind,l.target_url,l.target_scope,l.target_path,l.target_kind,l.field_name,l.location_path,l.byte_start,l.byte_end \
         FROM knowledge_links l JOIN knowledge_documents d ON d.source_path=l.source_path \
         WHERE l.edge_kind='links_to'",
    );
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
        document_count: row.1 as usize,
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
    use crate::index::{reindex::full_reindex, update};
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn templates_are_excluded_and_unlinked_entries_remain_nodes() {
        let temp = TempDir::new().unwrap();
        let project = temp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join(".templates")).unwrap();
        fs::create_dir_all(project.join("tasks")).unwrap();
        fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        fs::write(project.join("tasks/item.md"), "Unlinked body").unwrap();
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
                ("tasks/item.md".to_string(), "entry".to_string())
            ]
        );
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
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "entry".to_string(),
                }),
                neighbor_limit: Some(10),
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
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "tasks/item.md".to_string(),
                    kind: "entry".to_string(),
                }),
                neighbor_limit: Some(10),
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
