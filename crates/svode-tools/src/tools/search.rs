//! Page search and Knowledge reads over the host-prepared index snapshots:
//! bounded limits and text budget, frozen Space/Project scope and explicit
//! freshness. No crawler or rebuild runs for a request.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::git::path::{RootMode, normalize_repo_relative};
use svode_core::index::knowledge::{
    KnowledgeFilters, KnowledgeResponse, KnowledgeScope, KnowledgeSource,
};
use svode_core::index::service::{self, SearchScope};
use svode_core::index::state::IndexRuntimeState;

use crate::args::{clamp_limit, offset};
use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::result::ToolCallResult;
use crate::target::{ROOT_SPACE_ID, index_key, is_root_space_id, resolve_space};

const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 50;
const DEFAULT_NEIGHBOR_LIMIT: usize = 20;
const MAX_NEIGHBOR_LIMIT: usize = 100;
const DEFAULT_CONTEXT_LIMIT: usize = 8;
const MAX_CONTEXT_LIMIT: usize = 20;
const DEFAULT_TEXT_BUDGET: usize = 4_000;
const MAX_TEXT_BUDGET: usize = 16_000;
const MAX_QUERY_CHARS: usize = 512;
const MAX_RESPONSE_FRESHNESS: usize = 100;
const MAX_RESPONSE_DIAGNOSTICS: usize = 100;
const NODE_KINDS: [&str; 4] = ["page", "collection", "agent_instruction", "skill"];
const EDGE_KINDS: [&str; 4] = ["links_to", "relation", "member_of", "references"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchArgs {
    #[serde(default)]
    space_id: Option<String>,
    query: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum McpKnowledgeScope {
    #[default]
    Space,
    Project,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SearchKnowledgeArgs {
    query: String,
    #[serde(default)]
    scope: Option<McpKnowledgeScope>,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    node_kinds: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeNodeArgs {
    node_id: String,
    #[serde(default)]
    scope: Option<McpKnowledgeScope>,
    #[serde(default)]
    space_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeNeighborsArgs {
    node_id: String,
    #[serde(default)]
    scope: Option<McpKnowledgeScope>,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    edge_kinds: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RelatedContextArgs {
    query: String,
    #[serde(default)]
    scope: Option<McpKnowledgeScope>,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    text_budget: Option<usize>,
    #[serde(default)]
    node_kinds: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeStatusArgs {
    #[serde(default)]
    scope: Option<McpKnowledgeScope>,
    #[serde(default)]
    space_id: Option<String>,
}

struct ResolvedScope {
    project: PathBuf,
    scope: KnowledgeScope,
    response: Value,
}

pub(crate) async fn search_pages(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: SearchArgs,
) -> Result<ToolCallResult, ToolError> {
    resolve_space(target, args.space_id.as_deref())?;
    let key = index_key(target, args.space_id.as_deref());
    let limit = clamp_limit(args.limit);
    let start = offset(args.offset);
    let response = service::search_content(
        host.read_runtime().index,
        PathBuf::from(&target.project_path),
        args.query,
        None,
        None,
        Some(SearchScope::Space {
            space_id: IndexRuntimeState::space_id_for_key(&key),
        }),
        Some(limit.saturating_add(start as i64)),
    )
    .await?;
    let total = response.items.len();
    let results = response
        .items
        .into_iter()
        .skip(start)
        .take(limit as usize)
        .collect::<Vec<_>>();
    Ok(ToolCallResult::ok(
        format!("Found {} matching Pages.", results.len()),
        json!({ "items": results, "total": total, "limit": limit, "offset": start }),
    ))
}

pub(crate) async fn search_knowledge(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: SearchKnowledgeArgs,
) -> Result<ToolCallResult, ToolError> {
    let query = validate_query(&args.query)?.to_string();
    let limit = bounded_limit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, "limit")?;
    let node_kinds = validate_kinds(args.node_kinds, &NODE_KINDS, "nodeKinds")?;
    let resolved = resolve_scope(host, target, args.scope, args.space_id).await?;
    let mut response = read_effective_snapshot(
        host,
        &resolved,
        Some(&query),
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
    truncated |= truncate_response_metadata(&mut response);
    let structured = json!({
        "scope": resolved.response,
        "query": query,
        "items": response.search_items,
        "status": response.status,
        "diagnostics": response.diagnostics,
        "freshness": response.freshness,
        "truncated": truncated,
        "limit": limit,
    });
    json_result(structured)
}

pub(crate) async fn get_knowledge_node(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: KnowledgeNodeArgs,
) -> Result<ToolCallResult, ToolError> {
    let source = parse_node_id(&args.node_id)?;
    let resolved = resolve_scope(host, target, args.scope, args.space_id).await?;
    let mut response =
        read_effective_snapshot(host, &resolved, None, 1, 1, 1, node_filters(source)).await;
    let metadata_truncated = truncate_response_metadata(&mut response);
    let Some(node) = response.nodes.into_iter().next() else {
        return Err(node_not_found());
    };
    let search_item = response.search_items.into_iter().next();
    let structured = json!({
        "scope": resolved.response,
        "node": node,
        "summary": search_item.as_ref().and_then(|item| item.snippet.as_deref()),
        "summaryTruncated": search_item.as_ref().is_some_and(|item| item.snippet_truncated),
        "freshness": response.freshness,
        "diagnostics": response.diagnostics,
        "truncated": metadata_truncated || search_item.as_ref().is_some_and(|item| item.snippet_truncated),
    });
    json_result(structured)
}

pub(crate) async fn get_knowledge_neighbors(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: KnowledgeNeighborsArgs,
) -> Result<ToolCallResult, ToolError> {
    let source = parse_node_id(&args.node_id)?;
    let limit = bounded_limit(
        args.limit,
        DEFAULT_NEIGHBOR_LIMIT,
        MAX_NEIGHBOR_LIMIT,
        "limit",
    )?;
    let edge_kinds = validate_kinds(args.edge_kinds, &EDGE_KINDS, "edgeKinds")?;
    let resolved = resolve_scope(host, target, args.scope, args.space_id).await?;
    let existing =
        read_effective_snapshot(host, &resolved, None, 1, 1, 1, node_filters(source.clone())).await;
    if existing.nodes.is_empty() {
        return Err(node_not_found());
    }
    let mut response = read_effective_snapshot(
        host,
        &resolved,
        None,
        1,
        limit.saturating_add(1),
        1,
        KnowledgeFilters {
            node_kinds: Some(Vec::new()),
            edge_kinds,
            edge_source_kinds: None,
            neighbor: Some(source),
            neighbor_limit: Some(limit.saturating_add(1)),
            source: None,
            sources: None,
            edge_sources: None,
        },
    )
    .await;
    let mut truncated = response.edges.len() > limit || response.truncated;
    response.edges.truncate(limit);
    truncated |= truncate_response_metadata(&mut response);
    let structured = json!({
        "scope": resolved.response,
        "nodeId": args.node_id,
        "neighbors": response.edges,
        "status": response.status,
        "diagnostics": response.diagnostics,
        "truncated": truncated,
        "limit": limit,
    });
    json_result(structured)
}

pub(crate) async fn get_related_context(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: RelatedContextArgs,
) -> Result<ToolCallResult, ToolError> {
    let query = validate_query(&args.query)?.to_string();
    let limit = bounded_limit(
        args.limit,
        DEFAULT_CONTEXT_LIMIT,
        MAX_CONTEXT_LIMIT,
        "limit",
    )?;
    let budget = bounded_limit(
        args.text_budget,
        DEFAULT_TEXT_BUDGET,
        MAX_TEXT_BUDGET,
        "textBudget",
    )?;
    let node_kinds = validate_kinds(args.node_kinds, &NODE_KINDS, "nodeKinds")?;
    let resolved = resolve_scope(host, target, args.scope, args.space_id).await?;
    let mut response = service::read_related_context(
        host.read_runtime().index,
        &resolved.project,
        resolved.scope.clone(),
        &query,
        limit,
        budget,
        node_kinds,
    )
    .await;
    let diagnostics_truncated = response.diagnostics.len() > MAX_RESPONSE_DIAGNOSTICS;
    response.diagnostics.truncate(MAX_RESPONSE_DIAGNOSTICS);
    let structured = json!({
        "scope": resolved.response,
        "query": query,
        "context": response.context,
        "neighbors": response.neighbors,
        "textBudget": response.text_budget,
        "usedBudget": response.used_budget,
        "truncated": response.truncated || diagnostics_truncated,
        "status": response.status,
        "diagnostics": response.diagnostics,
    });
    json_result(structured)
}

pub(crate) async fn get_knowledge_status(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: KnowledgeStatusArgs,
) -> Result<ToolCallResult, ToolError> {
    let resolved = resolve_scope(host, target, args.scope, args.space_id).await?;
    let mut response =
        read_effective_snapshot(host, &resolved, None, 1, 1, 1, KnowledgeFilters::default()).await;
    let truncated = truncate_response_metadata(&mut response);
    let structured = json!({
        "scope": resolved.response,
        "status": response.status,
        "counts": {
            "nodes": response.total_node_count,
            "edges": response.total_edge_count,
            "readablePools": response.readable_pools,
            "totalPools": response.total_pools,
        },
        "freshness": response.freshness,
        "diagnostics": response.diagnostics,
        "truncated": truncated,
    });
    json_result(structured)
}

fn node_filters(source: KnowledgeSource) -> KnowledgeFilters {
    KnowledgeFilters {
        node_kinds: Some(vec![source.kind.clone()]),
        edge_kinds: Some(Vec::new()),
        edge_source_kinds: Some(Vec::new()),
        neighbor: None,
        neighbor_limit: None,
        source: Some(source),
        sources: None,
        edge_sources: None,
    }
}

fn node_not_found() -> ToolError {
    ToolError::new(
        "KNOWLEDGE_NODE_NOT_FOUND",
        "the requested knowledge node is unavailable in this scope",
    )
}

/// Knowledge scope inside the frozen request target: the default Space of
/// the request unless `spaceId` or Project scope is explicit.
async fn resolve_scope(
    host: &impl ToolHost,
    target: &RequestTarget,
    scope: Option<McpKnowledgeScope>,
    space_id: Option<String>,
) -> Result<ResolvedScope, ToolError> {
    let project = PathBuf::from(&target.project_path);
    match scope.unwrap_or_default() {
        McpKnowledgeScope::Project => {
            if space_id.is_some() {
                return Err(ToolError::new(
                    "INVALID_KNOWLEDGE_SCOPE",
                    "spaceId is only valid when scope is space",
                ));
            }
            Ok(ResolvedScope {
                project,
                scope: KnowledgeScope::Project,
                response: json!({ "kind": "project" }),
            })
        }
        McpKnowledgeScope::Space => {
            let effective_space_id = match space_id {
                Some(space_id) => normalize_space_id(&space_id)?,
                None => target.default_space_id.clone(),
            };
            if let Some(space_id) = effective_space_id.as_deref() {
                host.read_runtime()
                    .index
                    .key_for_project_space_id(&project, Some(space_id))
                    .await?;
            }
            Ok(ResolvedScope {
                project,
                response: json!({
                    "kind": "space",
                    "spaceId": effective_space_id.as_deref().unwrap_or(ROOT_SPACE_ID),
                }),
                scope: KnowledgeScope::Space {
                    space_id: effective_space_id,
                },
            })
        }
    }
}

async fn read_effective_snapshot(
    host: &impl ToolHost,
    resolved: &ResolvedScope,
    query: Option<&str>,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    service::read_scoped_knowledge(
        host.read_runtime().index,
        Path::new(&resolved.project),
        resolved.scope.clone(),
        query,
        node_limit,
        edge_limit,
        search_limit,
        filters,
    )
    .await
}

fn normalize_space_id(space_id: &str) -> Result<Option<String>, ToolError> {
    let space_id = space_id.trim();
    if space_id.is_empty() {
        return Err(ToolError::new(
            "INVALID_SPACE_ID",
            "spaceId must not be empty",
        ));
    }
    Ok((!is_root_space_id(space_id)).then(|| space_id.to_string()))
}

fn parse_node_id(node_id: &str) -> Result<KnowledgeSource, ToolError> {
    let mut parts = node_id.splitn(3, ':');
    let kind = parts.next().unwrap_or_default();
    let space = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    if !NODE_KINDS.contains(&kind) || space.is_empty() || path.is_empty() {
        return Err(ToolError::new(
            "INVALID_KNOWLEDGE_NODE_ID",
            "nodeId must be kind:spaceId:path using a published knowledge kind",
        ));
    }
    let path = normalize_repo_relative(path, RootMode::Allow).map_err(|_| {
        ToolError::new(
            "INVALID_KNOWLEDGE_NODE_ID",
            "nodeId contains an invalid public source path",
        )
    })?;
    Ok(KnowledgeSource {
        space_id: (space != ROOT_SPACE_ID).then(|| space.to_string()),
        path,
        kind: kind.to_string(),
    })
}

fn validate_query(query: &str) -> Result<&str, ToolError> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
        return Err(ToolError::new(
            "INVALID_KNOWLEDGE_QUERY",
            format!("query must contain 1 to {MAX_QUERY_CHARS} characters"),
        ));
    }
    Ok(query)
}

fn validate_kinds(
    kinds: Option<Vec<String>>,
    allowed: &[&str],
    field: &str,
) -> Result<Option<Vec<String>>, ToolError> {
    let Some(mut kinds) = kinds else {
        return Ok(None);
    };
    if kinds.iter().any(|kind| !allowed.contains(&kind.as_str())) {
        return Err(ToolError::new(
            "INVALID_KNOWLEDGE_FILTER",
            format!("{field} contains an unsupported value"),
        ));
    }
    kinds.sort();
    kinds.dedup();
    Ok(Some(kinds))
}

fn bounded_limit(
    value: Option<usize>,
    default: usize,
    maximum: usize,
    field: &str,
) -> Result<usize, ToolError> {
    let value = value.unwrap_or(default);
    if value == 0 || value > maximum {
        return Err(ToolError::new(
            "INVALID_KNOWLEDGE_LIMIT",
            format!("{field} must be between 1 and {maximum}"),
        ));
    }
    Ok(value)
}

fn truncate_response_metadata(response: &mut KnowledgeResponse) -> bool {
    let truncated = response.freshness.len() > MAX_RESPONSE_FRESHNESS
        || response.diagnostics.len() > MAX_RESPONSE_DIAGNOSTICS;
    response.freshness.truncate(MAX_RESPONSE_FRESHNESS);
    response.diagnostics.truncate(MAX_RESPONSE_DIAGNOSTICS);
    truncated
}

fn json_result(structured: Value) -> Result<ToolCallResult, ToolError> {
    let text = serde_json::to_string(&structured)?;
    Ok(ToolCallResult::ok(text, structured))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_and_scope_inputs_are_strict() {
        assert!(parse_node_id("page:root:notes/a.md").is_ok());
        assert!(parse_node_id("page:root:../secret.md").is_err());
        assert!(parse_node_id("canvas:root:a.md").is_err());
        assert!(
            serde_json::from_value::<SearchKnowledgeArgs>(json!({
                "query": "x",
                "scope": "workspace",
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<KnowledgeStatusArgs>(json!({
                "scope": "space",
                "unexpected": true,
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<SearchKnowledgeArgs>(json!({
                "query": "x",
                "limit": -1,
            }))
            .is_err()
        );
        assert!(bounded_limit(Some(0), 20, 50, "limit").is_err());
        assert!(bounded_limit(Some(51), 20, 50, "limit").is_err());
        assert!(validate_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(
            validate_kinds(Some(vec!["canvas".to_string()]), &NODE_KINDS, "nodeKinds").is_err()
        );
    }
}
