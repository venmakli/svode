use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::atomic::Ordering;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::files::backlinks::parse_markdown_links;
use crate::index::{IndexKey, IndexState};
use crate::space::types::SpaceStatus;

const DEFAULT_NODE_LIMIT: usize = 200;
const DEFAULT_EDGE_LIMIT: usize = 400;
const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_NODE_LIMIT: usize = 1_000;
const MAX_EDGE_LIMIT: usize = 2_000;
const MAX_SEARCH_LIMIT: usize = 100;

#[derive(Debug, Clone)]
pub(crate) struct KnowledgeArtifact {
    pub source_path: String,
    pub title: String,
    pub content_hash: String,
    pub source_updated_at: String,
    pub checked_at: String,
    pub fragment: String,
    pub links: Vec<KnowledgeLinkArtifact>,
}

#[derive(Debug, Clone)]
pub(crate) struct KnowledgeLinkArtifact {
    target_url: String,
    byte_start: i64,
    byte_end: i64,
}

pub(crate) fn build_artifact(
    source_path: &str,
    title: &str,
    source_updated_at: &str,
    raw: &str,
    fragment: &str,
) -> KnowledgeArtifact {
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    let links = parse_markdown_links(raw)
        .into_iter()
        .map(|(target_url, span)| KnowledgeLinkArtifact {
            target_url,
            byte_start: span.byte_start as i64,
            byte_end: span.byte_end as i64,
        })
        .collect();
    KnowledgeArtifact {
        source_path: source_path.to_string(),
        title: title.to_string(),
        content_hash: format!("{:016x}", hasher.finish()),
        source_updated_at: source_updated_at.to_string(),
        checked_at: now(),
        fragment: fragment.to_string(),
        links,
    }
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

pub(crate) async fn upsert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<bool, AppError> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT content_hash FROM knowledge_documents WHERE source_path = ?")
            .bind(&artifact.source_path)
            .fetch_optional(&mut **tx)
            .await?;
    if existing.as_deref() == Some(&artifact.content_hash) {
        return Ok(false);
    }

    sqlx::query("DELETE FROM knowledge_links WHERE source_path = ?")
        .bind(&artifact.source_path)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_fragments WHERE source_path = ?")
        .bind(&artifact.source_path)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_documents WHERE source_path = ?")
        .bind(&artifact.source_path)
        .execute(&mut **tx)
        .await?;
    insert_artifact(tx, artifact).await?;
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
}

pub(crate) async fn delete_artifact(
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
    let deleted = sqlx::query("DELETE FROM knowledge_documents WHERE source_path = ?")
        .bind(source_path)
        .execute(&mut **tx)
        .await?
        .rows_affected()
        > 0;
    if deleted {
        refresh_manifest_preserving_diagnostics(tx).await?;
    }
    Ok(deleted)
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO knowledge_documents \
         (source_path, title, content_hash, source_updated_at, checked_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&artifact.source_path)
    .bind(&artifact.title)
    .bind(&artifact.content_hash)
    .bind(&artifact.source_updated_at)
    .bind(&artifact.checked_at)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO knowledge_fragments (source_path, ordinal, text, content_hash) \
         VALUES (?, 0, ?, ?)",
    )
    .bind(&artifact.source_path)
    .bind(&artifact.fragment)
    .bind(&artifact.content_hash)
    .execute(&mut **tx)
    .await?;
    for link in &artifact.links {
        sqlx::query(
            "INSERT OR IGNORE INTO knowledge_links \
             (source_path, target_url, byte_start, byte_end, origin) \
             VALUES (?, ?, ?, ?, 'explicit')",
        )
        .bind(&artifact.source_path)
        .bind(&link.target_url)
        .bind(link.byte_start)
        .bind(link.byte_end)
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
    let document_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_documents")
        .fetch_one(&mut **tx)
        .await?;
    let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_links")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO knowledge_manifest \
         (singleton, checked_at, document_count, link_count, skipped_count, failure_count) \
         VALUES (1, ?, ?, ?, ?, ?) \
         ON CONFLICT(singleton) DO UPDATE SET \
         checked_at = excluded.checked_at, document_count = excluded.document_count, \
         link_count = excluded.link_count, skipped_count = excluded.skipped_count, \
         failure_count = excluded.failure_count",
    )
    .bind(now())
    .bind(document_count)
    .bind(link_count)
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEdge {
    pub source_id: String,
    pub source: KnowledgeSource,
    pub target_id: Option<String>,
    pub target: Option<KnowledgeSource>,
    pub target_url: String,
    pub target_status: String,
    pub origin: String,
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
struct PoolDocument {
    key: IndexKey,
    path: String,
    title: String,
    content_hash: String,
    source_updated_at: String,
    checked_at: String,
}

#[derive(Debug)]
struct PoolLink {
    key: IndexKey,
    source_path: String,
    target_url: String,
    byte_start: i64,
    byte_end: i64,
}

#[derive(Debug)]
struct PoolSearchItem {
    key: IndexKey,
    path: String,
    title: String,
    snippet: Option<String>,
}

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
    let node_offset = node_offset.unwrap_or(0);
    let edge_offset = edge_offset.unwrap_or(0);
    let node_limit = node_limit
        .unwrap_or(DEFAULT_NODE_LIMIT)
        .clamp(1, MAX_NODE_LIMIT);
    let edge_limit = edge_limit
        .unwrap_or(DEFAULT_EDGE_LIMIT)
        .clamp(1, MAX_EDGE_LIMIT);
    let search_limit = search_limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let (mut keys, mut diagnostics, total_pools) = scoped_keys(state, project, scope).await;
    keys.sort_by_key(key_sort);
    let mut documents = Vec::new();
    let mut links = Vec::new();
    let mut searches = Vec::new();
    let mut freshness = Vec::new();
    let mut total_nodes = 0usize;
    let mut total_edges = 0usize;
    let mut readable_pools = 0usize;
    let mut node_skip = node_offset;
    let mut edge_skip = edge_offset;
    let mut node_page_remaining = node_limit;
    let mut edge_page_remaining = edge_limit;

    for key in keys {
        let space_id = IndexState::space_id_for_key(&key);
        let flag = state.reindex_active_flag(&key).await;
        if flag.load(Ordering::SeqCst) {
            diagnostics.push(KnowledgeDiagnostic {
                space_id,
                code: "pool_reindexing".to_string(),
                message: "The prepared snapshot is temporarily unavailable".to_string(),
            });
            continue;
        }
        let pool = match state.existing_pool(&key).await {
            Some(pool) => pool,
            None => {
                diagnostics.push(KnowledgeDiagnostic {
                    space_id,
                    code: "pool_unavailable".to_string(),
                    message: "The prepared snapshot pool is not open".to_string(),
                });
                continue;
            }
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
                tracing::warn!(
                    "knowledge snapshot manifest read failed for {:?}: {error}",
                    key
                );
                diagnostics.push(KnowledgeDiagnostic {
                    space_id,
                    code: "pool_unavailable".to_string(),
                    message: "The prepared snapshot could not be read".to_string(),
                });
                continue;
            }
        };
        readable_pools += 1;
        let pool_node_count = manifest.document_count;
        let pool_edge_count = manifest.link_count;
        total_nodes += pool_node_count;
        total_edges += pool_edge_count;
        freshness.push(KnowledgePoolFreshness {
            space_id: IndexState::space_id_for_key(&key),
            ..manifest
        });
        let pool_node_offset = node_skip.min(pool_node_count);
        node_skip -= pool_node_offset;
        let pool_node_limit = node_page_remaining.min(pool_node_count - pool_node_offset);
        if pool_node_limit > 0 {
            node_page_remaining -= pool_node_limit;
            match read_pool_documents(&pool, &key, pool_node_offset, pool_node_limit).await {
                Ok(mut rows) => documents.append(&mut rows),
                Err(error) => {
                    tracing::warn!("knowledge document read failed for {:?}: {error}", key);
                    diagnostics.push(KnowledgeDiagnostic {
                        space_id: IndexState::space_id_for_key(&key),
                        code: "pool_read_failed".to_string(),
                        message: "Document nodes could not be read".to_string(),
                    });
                }
            }
        }
        let pool_edge_offset = edge_skip.min(pool_edge_count);
        edge_skip -= pool_edge_offset;
        let pool_edge_limit = edge_page_remaining.min(pool_edge_count - pool_edge_offset);
        if pool_edge_limit > 0 {
            edge_page_remaining -= pool_edge_limit;
            match read_pool_links(&pool, &key, pool_edge_offset, pool_edge_limit).await {
                Ok(mut rows) => links.append(&mut rows),
                Err(error) => {
                    tracing::warn!("knowledge link read failed for {:?}: {error}", key);
                    diagnostics.push(KnowledgeDiagnostic {
                        space_id: IndexState::space_id_for_key(&key),
                        code: "pool_read_failed".to_string(),
                        message: "Document links could not be read".to_string(),
                    });
                }
            }
        }
        match read_pool_search(&pool, &key, query, search_limit).await {
            Ok(mut rows) => searches.append(&mut rows),
            Err(error) => {
                tracing::warn!("knowledge search read failed for {:?}: {error}", key);
                diagnostics.push(KnowledgeDiagnostic {
                    space_id: IndexState::space_id_for_key(&key),
                    code: "pool_search_failed".to_string(),
                    message: "The search projection could not be read".to_string(),
                });
            }
        }
    }

    searches.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    searches.truncate(search_limit);

    let mut space_names = HashMap::new();
    for document in &documents {
        space_names
            .entry(document.key.clone())
            .or_insert(state.space_name(&document.key).await);
    }
    for item in &searches {
        if !space_names.contains_key(&item.key) {
            space_names.insert(item.key.clone(), state.space_name(&item.key).await);
        }
    }
    let nodes = documents
        .into_iter()
        .map(|row| {
            let source = source_for(&row.key, &row.path);
            KnowledgeNode {
                id: node_id(&source),
                source,
                space_name: space_names.get(&row.key).cloned().unwrap_or_default(),
                title: row.title,
                content_hash: row.content_hash,
                source_updated_at: row.source_updated_at,
                checked_at: row.checked_at,
            }
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::with_capacity(links.len());
    for row in links {
        let source = source_for(&row.key, &row.source_path);
        let resolved = state
            .resolve_link_target_key(
                project,
                source.space_id.as_deref(),
                &source.path,
                &row.target_url,
            )
            .await;
        let (target, target_status) = match resolved {
            Ok(Some((target_key, target_path))) => {
                let target = source_for(&target_key, &target_path);
                let available = match state.existing_pool(&target_key).await {
                    Some(pool) => document_exists(&pool, &target_path).await.unwrap_or(false),
                    None => false,
                };
                (Some(target), if available { "ready" } else { "broken" })
            }
            _ => (None, "broken"),
        };
        edges.push(KnowledgeEdge {
            source_id: node_id(&source),
            source,
            target_id: target.as_ref().map(node_id),
            target,
            target_url: row.target_url,
            target_status: target_status.to_string(),
            origin: "explicit".to_string(),
            byte_start: row.byte_start as usize,
            byte_end: row.byte_end as usize,
        });
    }
    let search_items = searches
        .into_iter()
        .map(|row| {
            let source = source_for(&row.key, &row.path);
            KnowledgeSearchItem {
                node_id: node_id(&source),
                source,
                space_name: space_names.get(&row.key).cloned().unwrap_or_default(),
                title: row.title,
                snippet: row.snippet,
            }
        })
        .collect::<Vec<_>>();
    let omitted_node_count = total_nodes.saturating_sub(nodes.len());
    let omitted_edge_count = total_edges.saturating_sub(edges.len());
    let next_node_cursor = node_offset.saturating_add(node_limit).min(total_nodes);
    let next_edge_cursor = edge_offset.saturating_add(edge_limit).min(total_edges);
    let has_more_nodes = next_node_cursor < total_nodes;
    let has_more_edges = next_edge_cursor < total_edges;
    let status = if readable_pools == 0 && !diagnostics.is_empty() {
        "error"
    } else if !diagnostics.is_empty() || readable_pools < total_pools {
        "partial"
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
        truncated: omitted_node_count > 0 || omitted_edge_count > 0,
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

async fn scoped_keys(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
) -> (Vec<IndexKey>, Vec<KnowledgeDiagnostic>, usize) {
    match scope {
        Some(KnowledgeScope::Space { space_id }) => {
            let key = match space_id {
                None => Some(IndexKey::Root(project.to_path_buf())),
                Some(ref id) => state
                    .key_for_project_space_id(project, Some(&id))
                    .await
                    .ok(),
            };
            match key {
                Some(key) => (vec![key], Vec::new(), 1),
                None => (
                    Vec::new(),
                    vec![KnowledgeDiagnostic {
                        space_id,
                        code: "space_unavailable".to_string(),
                        message: "The requested Space is not ready".to_string(),
                    }],
                    1,
                ),
            }
        }
        Some(KnowledgeScope::Project) | None => {
            let keys = state.keys_for_project(&project.to_path_buf()).await;
            let cache = state.spaces_cache.lock().await;
            let mut diagnostics = Vec::new();
            let mut unavailable = 0usize;
            if let Some(cache) = cache.get(project) {
                for (space_id, status) in &cache.status_by_id {
                    if !matches!(status, SpaceStatus::Ready) {
                        unavailable += 1;
                        diagnostics.push(KnowledgeDiagnostic {
                            space_id: Some(space_id.clone()),
                            code: "space_unavailable".to_string(),
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

async fn read_manifest(pool: &SqlitePool) -> Result<Option<KnowledgePoolFreshness>, AppError> {
    let row: Option<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT checked_at, document_count, link_count, skipped_count, failure_count \
         FROM knowledge_manifest WHERE singleton = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| KnowledgePoolFreshness {
        space_id: None,
        checked_at: row.0,
        document_count: row.1 as usize,
        link_count: row.2 as usize,
        skipped_count: row.3 as usize,
        failure_count: row.4 as usize,
    }))
}

async fn read_pool_documents(
    pool: &SqlitePool,
    key: &IndexKey,
    offset: usize,
    limit: usize,
) -> Result<Vec<PoolDocument>, AppError> {
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT source_path, title, content_hash, source_updated_at, checked_at \
         FROM knowledge_documents ORDER BY source_path LIMIT ? OFFSET ?",
    )
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PoolDocument {
            key: key.clone(),
            path: row.0,
            title: row.1,
            content_hash: row.2,
            source_updated_at: row.3,
            checked_at: row.4,
        })
        .collect())
}

async fn read_pool_links(
    pool: &SqlitePool,
    key: &IndexKey,
    offset: usize,
    limit: usize,
) -> Result<Vec<PoolLink>, AppError> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT source_path, target_url, byte_start, byte_end FROM knowledge_links \
         ORDER BY source_path, byte_start, target_url LIMIT ? OFFSET ?",
    )
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PoolLink {
            key: key.clone(),
            source_path: row.0,
            target_url: row.1,
            byte_start: row.2,
            byte_end: row.3,
        })
        .collect())
}

async fn read_pool_search(
    pool: &SqlitePool,
    key: &IndexKey,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<PoolSearchItem>, AppError> {
    let query = query.unwrap_or("").trim();
    let rows: Vec<(String, String, Option<String>)> = if query.is_empty() {
        sqlx::query_as(
            "SELECT d.source_path, d.title, substr(f.text, 1, 240) \
             FROM knowledge_documents d LEFT JOIN knowledge_fragments f \
             ON f.source_path = d.source_path AND f.ordinal = 0 \
             ORDER BY d.source_updated_at DESC, d.source_path LIMIT ?",
        )
        .bind(limit as i64)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT d.source_path, d.title, substr(f.text, 1, 240) \
             FROM knowledge_documents d LEFT JOIN knowledge_fragments f \
             ON f.source_path = d.source_path AND f.ordinal = 0 \
             WHERE instr(lower(d.title), lower(?)) > 0 \
                OR instr(lower(COALESCE(f.text, '')), lower(?)) > 0 \
             ORDER BY CASE WHEN instr(lower(d.title), lower(?)) = 1 THEN 0 ELSE 1 END, \
                      d.source_updated_at DESC, d.source_path LIMIT ?",
        )
        .bind(query)
        .bind(query)
        .bind(query)
        .bind(limit as i64)
        .fetch_all(pool)
        .await?
    };
    Ok(rows
        .into_iter()
        .map(|row| PoolSearchItem {
            key: key.clone(),
            path: row.0,
            title: row.1,
            snippet: row.2,
        })
        .collect())
}

async fn document_exists(pool: &SqlitePool, path: &str) -> Result<bool, AppError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_documents WHERE source_path = ?")
            .bind(path)
            .fetch_one(pool)
            .await?;
    Ok(count > 0)
}

fn source_for(key: &IndexKey, path: &str) -> KnowledgeSource {
    KnowledgeSource {
        space_id: IndexState::space_id_for_key(key),
        path: path.to_string(),
        kind: "document".to_string(),
    }
}

fn node_id(source: &KnowledgeSource) -> String {
    format!(
        "document:{}:{}",
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
    use std::collections::HashSet;
    use std::fs;
    use tempfile::TempDir;

    async fn install_space_cache(state: &IndexState, project: &Path, child_status: SpaceStatus) {
        state.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([("child".to_string(), "child-space".to_string())]),
                folder_by_id: HashMap::from([("child-space".to_string(), "child".to_string())]),
                status_by_id: HashMap::from([("child-space".to_string(), child_status)]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([("child-space".to_string(), "Child".to_string())]),
            },
        );
    }

    #[tokio::test]
    async fn project_snapshot_merges_root_child_and_cross_space_links() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let child = project.join("child");
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(child.join(".svode")).unwrap();
        fs::write(project.join("root.md"), "See [child](child/child.md)").unwrap();
        fs::write(child.join("child.md"), "Child document").unwrap();
        let state = IndexState::new();
        install_space_cache(&state, project, SpaceStatus::Ready).await;
        let root_key = IndexKey::Root(project.to_path_buf());
        let child_key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };
        let root_pool = state.get_or_create(&root_key).await.unwrap();
        let child_pool = state.get_or_create(&child_key).await.unwrap();
        full_reindex(&root_pool, project, &["child".to_string()])
            .await
            .unwrap();
        full_reindex(&child_pool, &child, &[]).await.unwrap();

        let response =
            read_project_snapshot(&state, project, None, None, None, None, None, None, None).await;
        assert_eq!(response.status, "complete");
        assert_eq!(response.nodes.len(), 2);
        assert_eq!(response.edges.len(), 1);
        assert_eq!(response.edges[0].target_status, "ready");
        assert_eq!(
            response.edges[0]
                .target
                .as_ref()
                .unwrap()
                .space_id
                .as_deref(),
            Some("child-space")
        );
    }

    #[tokio::test]
    async fn space_scope_returns_only_the_selected_child_pool() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let bigquest = project.join("bigquest");
        let develop = project.join("develop");
        for directory in [project, bigquest.as_path(), develop.as_path()] {
            fs::create_dir_all(directory.join(".svode")).unwrap();
        }
        fs::write(project.join("root.md"), "Root only").unwrap();
        fs::write(bigquest.join("bigquest.md"), "Bigquest only").unwrap();
        fs::write(develop.join("develop.md"), "Develop only").unwrap();

        let state = IndexState::new();
        state.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([
                    ("bigquest".to_string(), "space-bigquest".to_string()),
                    ("develop".to_string(), "space-develop".to_string()),
                ]),
                folder_by_id: HashMap::from([
                    ("space-bigquest".to_string(), "bigquest".to_string()),
                    ("space-develop".to_string(), "develop".to_string()),
                ]),
                status_by_id: HashMap::from([
                    ("space-bigquest".to_string(), SpaceStatus::Ready),
                    ("space-develop".to_string(), SpaceStatus::Ready),
                ]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([
                    ("space-bigquest".to_string(), "Bigquest".to_string()),
                    ("space-develop".to_string(), "Develop".to_string()),
                ]),
            },
        );
        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let bigquest_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "space-bigquest".to_string(),
            })
            .await
            .unwrap();
        let develop_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "space-develop".to_string(),
            })
            .await
            .unwrap();
        full_reindex(
            &root_pool,
            project,
            &["bigquest".to_string(), "develop".to_string()],
        )
        .await
        .unwrap();
        full_reindex(&bigquest_pool, &bigquest, &[]).await.unwrap();
        full_reindex(&develop_pool, &develop, &[]).await.unwrap();

        let bigquest_scope: KnowledgeScope = serde_json::from_value(serde_json::json!({
            "kind": "space",
            "spaceId": "space-bigquest"
        }))
        .expect("deserialize frontend bigquest scope payload");
        let develop_scope: KnowledgeScope = serde_json::from_value(serde_json::json!({
            "kind": "space",
            "spaceId": "space-develop"
        }))
        .expect("deserialize frontend develop scope payload");
        let bigquest_response = read_project_snapshot(
            &state,
            project,
            Some(bigquest_scope),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        let develop_response = read_project_snapshot(
            &state,
            project,
            Some(develop_scope),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;

        assert_eq!(bigquest_response.status, "complete");
        assert_eq!(develop_response.status, "complete");
        assert_eq!(bigquest_response.nodes.len(), 1);
        assert_eq!(develop_response.nodes.len(), 1);
        assert_eq!(bigquest_response.nodes[0].source.path, "bigquest.md");
        assert_eq!(develop_response.nodes[0].source.path, "develop.md");
        assert_eq!(
            bigquest_response.nodes[0].source.space_id.as_deref(),
            Some("space-bigquest")
        );
        assert_eq!(
            develop_response.nodes[0].source.space_id.as_deref(),
            Some("space-develop")
        );
        assert_ne!(bigquest_response.nodes[0].id, develop_response.nodes[0].id);
    }

    #[tokio::test]
    async fn project_pages_cover_all_pools_once_and_offsets_past_end_are_empty() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let alpha = project.join("alpha");
        let beta = project.join("beta");
        for directory in [project, alpha.as_path(), beta.as_path()] {
            fs::create_dir_all(directory.join(".svode")).unwrap();
        }
        for (directory, names) in [
            (project, vec!["root-a.md", "root-b.md"]),
            (
                alpha.as_path(),
                vec!["alpha-a.md", "alpha-b.md", "alpha-c.md"],
            ),
            (beta.as_path(), vec!["beta-a.md", "beta-b.md"]),
        ] {
            for name in names {
                fs::write(directory.join(name), format!("[Self]({name})")).unwrap();
            }
        }

        let state = IndexState::new();
        state.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([
                    ("alpha".to_string(), "space-alpha".to_string()),
                    ("beta".to_string(), "space-beta".to_string()),
                ]),
                folder_by_id: HashMap::from([
                    ("space-alpha".to_string(), "alpha".to_string()),
                    ("space-beta".to_string(), "beta".to_string()),
                ]),
                status_by_id: HashMap::from([
                    ("space-alpha".to_string(), SpaceStatus::Ready),
                    ("space-beta".to_string(), SpaceStatus::Ready),
                ]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([
                    ("space-alpha".to_string(), "Alpha".to_string()),
                    ("space-beta".to_string(), "Beta".to_string()),
                ]),
            },
        );
        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let alpha_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "space-alpha".to_string(),
            })
            .await
            .unwrap();
        let beta_pool = state
            .get_or_create(&IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "space-beta".to_string(),
            })
            .await
            .unwrap();
        full_reindex(
            &root_pool,
            project,
            &["alpha".to_string(), "beta".to_string()],
        )
        .await
        .unwrap();
        full_reindex(&alpha_pool, &alpha, &[]).await.unwrap();
        full_reindex(&beta_pool, &beta, &[]).await.unwrap();

        let mut node_offset = 0usize;
        let mut node_ids = Vec::new();
        let mut node_sources = Vec::new();
        loop {
            let page = read_project_snapshot(
                &state,
                project,
                None,
                None,
                Some(node_offset),
                Some(usize::MAX),
                Some(2),
                Some(3),
                None,
            )
            .await;
            assert_eq!(page.total_node_count, 7);
            assert_eq!(page.total_edge_count, 7);
            node_ids.extend(page.nodes.iter().map(|node| node.id.clone()));
            node_sources.extend(
                page.nodes
                    .iter()
                    .map(|node| (node.source.space_id.clone(), node.source.path.clone())),
            );
            let Some(next) = page.next_node_offset else {
                assert!(!page.has_more_nodes);
                break;
            };
            assert!(page.has_more_nodes);
            node_offset = next;
        }
        assert_eq!(node_ids.len(), 7);
        assert_eq!(node_ids.iter().collect::<HashSet<_>>().len(), 7);
        assert_eq!(
            node_sources,
            vec![
                (None, "root-a.md".to_string()),
                (None, "root-b.md".to_string()),
                (Some("space-alpha".to_string()), "alpha-a.md".to_string()),
                (Some("space-alpha".to_string()), "alpha-b.md".to_string()),
                (Some("space-alpha".to_string()), "alpha-c.md".to_string()),
                (Some("space-beta".to_string()), "beta-a.md".to_string()),
                (Some("space-beta".to_string()), "beta-b.md".to_string()),
            ]
        );

        let mut edge_offset = 0usize;
        let mut edge_keys = Vec::new();
        loop {
            let page = read_project_snapshot(
                &state,
                project,
                None,
                None,
                Some(usize::MAX),
                Some(edge_offset),
                Some(2),
                Some(3),
                None,
            )
            .await;
            edge_keys.extend(page.edges.iter().map(|edge| {
                (
                    edge.source_id.clone(),
                    edge.target_url.clone(),
                    edge.byte_start,
                )
            }));
            let Some(next) = page.next_edge_offset else {
                assert!(!page.has_more_edges);
                break;
            };
            assert!(page.has_more_edges);
            edge_offset = next;
        }
        assert_eq!(edge_keys.len(), 7);
        assert_eq!(edge_keys.iter().collect::<HashSet<_>>().len(), 7);

        let past_end = read_project_snapshot(
            &state,
            project,
            None,
            None,
            Some(99),
            Some(99),
            Some(2),
            Some(3),
            None,
        )
        .await;
        assert_eq!(past_end.status, "complete");
        assert!(past_end.nodes.is_empty());
        assert!(past_end.edges.is_empty());
        assert_eq!(past_end.total_node_count, 7);
        assert_eq!(past_end.total_edge_count, 7);
        assert_eq!(past_end.omitted_node_count, 7);
        assert_eq!(past_end.omitted_edge_count, 7);
        assert_eq!(past_end.next_node_offset, None);
        assert_eq!(past_end.next_edge_offset, None);
        assert!(!past_end.has_more_nodes);
        assert!(!past_end.has_more_edges);
    }

    #[tokio::test]
    async fn unavailable_child_is_reported_as_partial() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("root.md"), "Root").unwrap();
        let state = IndexState::new();
        install_space_cache(&state, project, SpaceStatus::Missing).await;
        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&root_pool, project, &["child".to_string()])
            .await
            .unwrap();

        let response =
            read_project_snapshot(&state, project, None, None, None, None, None, None, None).await;
        assert_eq!(response.status, "partial");
        assert_eq!(response.readable_pools, 1);
        assert_eq!(response.total_pools, 2);
        assert!(
            response
                .diagnostics
                .iter()
                .any(|item| item.code == "space_unavailable")
        );
    }

    #[tokio::test]
    async fn graph_limits_report_omitted_nodes_and_edges() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("a.md"), "[B](b.md) [C](c.md)").unwrap();
        fs::write(project.join("b.md"), "B").unwrap();
        fs::write(project.join("c.md"), "C").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();

        let response = read_project_snapshot(
            &state,
            project,
            None,
            None,
            None,
            None,
            Some(1),
            Some(1),
            None,
        )
        .await;
        assert!(response.truncated);
        assert_eq!(response.total_node_count, 3);
        assert_eq!(response.total_edge_count, 2);
        assert_eq!(response.omitted_node_count, 2);
        assert_eq!(response.omitted_edge_count, 1);
        assert_eq!(response.next_node_offset, Some(1));
        assert_eq!(response.next_edge_offset, Some(1));
        assert!(response.has_more_nodes);
        assert!(response.has_more_edges);
    }

    #[tokio::test]
    async fn targeted_update_and_delete_keep_graph_rows_coherent() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        let source = project.join("source.md");
        fs::write(&source, "[Old](old.md)").unwrap();
        let state = IndexState::new();
        update::update_entry(&state, project, &source)
            .await
            .unwrap();
        fs::write(&source, "[New](new.md)").unwrap();
        update::update_entry(&state, project, &source)
            .await
            .unwrap();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let targets: Vec<String> =
            sqlx::query_scalar("SELECT target_url FROM knowledge_links ORDER BY target_url")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(targets, vec!["new.md"]);

        fs::remove_file(&source).unwrap();
        update::delete_entry(&state, project, &source)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_documents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn no_op_targeted_update_does_not_revise_knowledge_snapshot() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        let source = project.join("source.md");
        fs::write(&source, "Unchanged").unwrap();
        let state = IndexState::new();
        update::update_entry(&state, project, &source)
            .await
            .unwrap();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        sqlx::query("UPDATE knowledge_documents SET checked_at = 'sentinel'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE knowledge_manifest SET checked_at = 'sentinel'")
            .execute(&pool)
            .await
            .unwrap();

        update::update_entry(&state, project, &source)
            .await
            .unwrap();

        let document_checked_at: String =
            sqlx::query_scalar("SELECT checked_at FROM knowledge_documents")
                .fetch_one(&pool)
                .await
                .unwrap();
        let manifest_checked_at: String =
            sqlx::query_scalar("SELECT checked_at FROM knowledge_manifest")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(document_checked_at, "sentinel");
        assert_eq!(manifest_checked_at, "sentinel");
    }

    #[tokio::test]
    async fn snapshot_read_never_builds_an_unprepared_pool() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("not-indexed.md"), "Must not be crawled").unwrap();
        let state = IndexState::new();

        let response =
            read_project_snapshot(&state, project, None, None, None, None, None, None, None).await;

        assert_eq!(response.status, "error");
        assert!(response.nodes.is_empty());
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let manifest_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_manifest")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(manifest_count, 0);
    }

    #[tokio::test]
    async fn templates_are_absent_from_knowledge_snapshot() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join(".templates")).unwrap();
        fs::write(project.join("visible.md"), "Visible").unwrap();
        fs::write(project.join(".templates/hidden.md"), "Hidden").unwrap();
        let state = IndexState::new();
        let pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        full_reindex(&pool, project, &[]).await.unwrap();
        let paths: Vec<String> =
            sqlx::query_scalar("SELECT source_path FROM knowledge_documents ORDER BY source_path")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["visible.md"]);
    }
}
