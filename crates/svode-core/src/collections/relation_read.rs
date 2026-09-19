use super::list::list_collections;
use super::model::{CollectionSchema, Column, PropertyType, RelationLimit, RelationScope};
use super::schema::read_schema_at;
use super::traversal::collection_markdown_files;
use crate::page::{ParsedMarkdown, parse_markdown};
use serde::Deserialize;
use serde_yml::Value;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::CollectionError;
use super::schema::normalize_rel_path;
pub use super::schema_support::normalize_relation_value_shape;
use super::schema_support::schema_error;
pub use super::schema_support::validate_relation_value_shape;
use crate::git::path::{RootMode, normalize_repo_relative};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRelation {
    pub title: String,
    pub icon: Option<String>,
    pub file_path: String,
    pub collection_root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationBacklink {
    pub file_path: String,
    pub collection_root_path: String,
    pub column: String,
    pub value: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationTwoWaySchemaStatus {
    Ok,
    NotTwoWay,
    MissingReverse,
    IncompatibleReverse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibleReverseChoice {
    pub name: String,
    pub two_way: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationDriftKind {
    MissingReverse,
    MissingSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationDriftRow {
    pub kind: RelationDriftKind,
    pub source_file_path: String,
    pub target_file_path: String,
    pub source_value: String,
    pub target_value: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelationDriftSummary {
    pub missing_reverse_count: usize,
    pub missing_source_count: usize,
    pub rows: Vec<RelationDriftRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTwoWayDiagnostics {
    pub collection_path: String,
    pub column: String,
    pub relation: Option<String>,
    pub reverse_column: Option<String>,
    pub schema_status: RelationTwoWaySchemaStatus,
    pub schema_message: Option<String>,
    pub compatible_reverse_choices: Vec<CompatibleReverseChoice>,
    pub drift: RelationDriftSummary,
}

pub fn normalize_collection_path(path: &str) -> Result<String, CollectionError> {
    normalize_repo_relative(path, RootMode::Allow)
        .map_err(|error| schema_error(error.to_string()))
        .map(|rel| if rel.is_empty() { ".".to_string() } else { rel })
}

pub fn collection_root_for_fs(collection_path: &str) -> String {
    let rel = normalize_rel_path(collection_path);
    if rel == "." { String::new() } else { rel }
}

pub fn join_collection_value(collection_path: &str, value: &str) -> String {
    let collection = collection_root_for_fs(collection_path);
    if collection.is_empty() {
        value.to_string()
    } else {
        format!("{collection}/{value}")
    }
}

pub fn value_relative_to_collection(
    collection_path: &str,
    file_path: &str,
) -> Result<String, CollectionError> {
    let collection = collection_root_for_fs(collection_path);
    let file = normalize_rel_path(file_path);
    let value = if collection.is_empty() {
        file
    } else {
        file.strip_prefix(&format!("{collection}/"))
            .ok_or_else(|| {
                schema_error(format!(
                    "entry '{file}' is outside collection '{collection_path}'"
                ))
            })?
            .to_string()
    };
    normalize_relation_value_shape(&value)
}

pub async fn resolve_relation(
    pool: &SqlitePool,
    relation: &str,
    value: &str,
) -> Result<Option<ResolvedRelation>, CollectionError> {
    let relation = normalize_collection_path(relation)?;
    let value = normalize_relation_value_shape(value)?;
    let file_path = join_collection_value(&relation, &value);
    let resolved = fetch_resolved_relation(pool, &file_path).await?;
    if resolved.is_some() || value == file_path {
        return Ok(resolved);
    }
    fetch_resolved_relation(pool, &value).await
}

pub async fn resolve_relations_batch(
    pool: &SqlitePool,
    relation: &str,
    values: &[String],
) -> Result<Vec<Option<ResolvedRelation>>, CollectionError> {
    let relation = normalize_collection_path(relation)?;
    let mut candidates = Vec::with_capacity(values.len());
    let mut lookup_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    for value in values {
        let value = normalize_relation_value_shape(value)?;
        let primary = join_collection_value(&relation, &value);
        let fallback = if value == primary { None } else { Some(value) };
        if seen_paths.insert(primary.clone()) {
            lookup_paths.push(primary.clone());
        }
        if let Some(fallback_path) = fallback.as_ref() {
            if seen_paths.insert(fallback_path.clone()) {
                lookup_paths.push(fallback_path.clone());
            }
        }
        candidates.push((primary, fallback));
    }
    if lookup_paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT title, icon, file_path, collection_root_path FROM entries WHERE file_path IN (",
    );
    let mut separated = query.separated(", ");
    for file_path in &lookup_paths {
        separated.push_bind(file_path);
    }
    separated.push_unseparated(")");
    let rows = query.build().fetch_all(pool).await?;
    let mut by_path = HashMap::new();
    for row in rows {
        let file_path: String = row.get("file_path");
        by_path.insert(file_path, resolved_relation_from_row(row));
    }
    Ok(candidates
        .iter()
        .map(|(primary, fallback)| {
            by_path.get(primary).cloned().or_else(|| {
                fallback
                    .as_ref()
                    .and_then(|fallback_path| by_path.get(fallback_path).cloned())
            })
        })
        .collect())
}

async fn fetch_resolved_relation(
    pool: &SqlitePool,
    file_path: &str,
) -> Result<Option<ResolvedRelation>, CollectionError> {
    let row = sqlx::query(
        "SELECT title, icon, file_path, collection_root_path FROM entries WHERE file_path = ? LIMIT 1",
    )
    .bind(file_path)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(resolved_relation_from_row))
}

fn resolved_relation_from_row(row: sqlx::sqlite::SqliteRow) -> ResolvedRelation {
    let collection_root_path: Option<String> = row.get("collection_root_path");
    ResolvedRelation {
        title: row.get("title"),
        icon: row.get("icon"),
        file_path: row.get("file_path"),
        collection_root_path: collection_root_path.unwrap_or_default(),
    }
}

pub fn collection_root_for_schema(collection_path: &str) -> String {
    let rel = normalize_rel_path(collection_path);
    if rel.is_empty() { ".".into() } else { rel }
}

pub fn read_schema_or_default(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, CollectionError> {
    let path = Path::new(space)
        .join(collection_root_for_fs(collection_path))
        .join("schema.yaml");
    if path.is_file() {
        read_schema_at(&path)
    } else {
        Ok(CollectionSchema::default())
    }
}

pub fn query_relation_backlinks(
    space: &str,
    target_path: &str,
    source_collection_path: Option<&str>,
    source_column: Option<&str>,
) -> Result<Vec<RelationBacklink>, CollectionError> {
    let target = normalize_rel_path(target_path);
    let mut out = Vec::new();
    for collection in list_collections(space)? {
        if source_collection_path
            .map(collection_root_for_schema)
            .as_deref()
            .is_some_and(|source| source != collection.path)
        {
            continue;
        }
        let schema = read_schema_or_default(space, &collection.path)?;
        let columns: Vec<Column> = schema
            .columns
            .iter()
            .filter(|column| {
                column.type_ == PropertyType::Relation
                    && relation_is_current_scope(column)
                    && source_column.is_none_or(|name| name == column.name)
            })
            .cloned()
            .collect();
        for column in columns {
            let Some(relation) = column.relation.as_deref() else {
                continue;
            };
            let Ok(target_value) = value_relative_to_collection(relation, &target) else {
                continue;
            };
            for file in collection_markdown_files(space, &collection.path)? {
                let raw = fs::read_to_string(&file)?;
                let meta = match parse_markdown(&raw, &file.to_string_lossy()) {
                    ParsedMarkdown::Missing(_) => continue,
                    ParsedMarkdown::Valid(meta, _) => meta,
                    ParsedMarkdown::Malformed(message, _) => {
                        return Err(CollectionError::FrontmatterParse(message));
                    }
                };
                let values = validate_relation_value_shape(
                    &column,
                    meta.extra.get(&column.name).unwrap_or(&Value::Null),
                )?;
                if values.iter().any(|value| value == &target_value) {
                    let file_path = file
                        .strip_prefix(space)
                        .unwrap_or(&file)
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.push(RelationBacklink {
                        file_path,
                        collection_root_path: collection.path.clone(),
                        column: column.name.clone(),
                        value: target_value.clone(),
                        title: meta.title,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| {
        a.collection_root_path
            .cmp(&b.collection_root_path)
            .then_with(|| a.column.cmp(&b.column))
            .then_with(|| a.file_path.cmp(&b.file_path))
    });
    Ok(out)
}

pub fn relation_is_current_scope(column: &Column) -> bool {
    column.relation_scope.is_none()
}

pub fn project_relation_scan_spaces(
    space: &str,
    project_path: Option<&str>,
) -> Result<Vec<String>, CollectionError> {
    let mut spaces = Vec::new();
    let mut push_space = |candidate: String| {
        if !spaces
            .iter()
            .any(|existing: &String| same_fs_path(existing, &candidate))
        {
            spaces.push(candidate);
        }
    };
    push_space(space.to_string());
    let Some(project) = project_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(spaces);
    };
    push_space(project.to_string());
    for reference in read_relation_space_refs(Path::new(project))? {
        push_space(
            Path::new(project)
                .join(reference.path)
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(spaces)
}

#[derive(Deserialize)]
struct RelationSpaceConfig {
    #[serde(rename = "name")]
    _name: String,
    spaces: Option<Vec<RelationSpaceRef>>,
}

#[derive(Deserialize)]
struct RelationSpaceRef {
    id: String,
    path: String,
    #[serde(rename = "repo")]
    _repo: Option<String>,
}

fn read_relation_space_refs(project: &Path) -> Result<Vec<RelationSpaceRef>, CollectionError> {
    let path = project.join(".svode/config.json");
    if !path.exists() {
        return Err(CollectionError::FileNotFound(path.display().to_string()));
    }
    let data = fs::read_to_string(path)?;
    let config: RelationSpaceConfig = serde_json::from_str(&data)?;
    Ok(config.spaces.unwrap_or_default())
}

pub fn relation_target_space_path(
    space: &str,
    project_path: Option<&str>,
    scope: Option<&RelationScope>,
) -> Result<Option<String>, CollectionError> {
    match scope {
        None => Ok(Some(space.to_string())),
        Some(RelationScope::Root) => Ok(project_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned)),
        Some(RelationScope::Space { id }) => {
            let project = project_path
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(space);
            let references = match read_relation_space_refs(Path::new(project)) {
                Ok(references) => references,
                Err(error) if project_path.is_none() => {
                    tracing::warn!(
                        "relation target scope space '{}' could not read project config: {error}",
                        id
                    );
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            let Some(reference) = references.iter().find(|reference| reference.id == *id) else {
                if project_path.is_none() {
                    return Ok(None);
                }
                return Err(schema_error(format!(
                    "relation target space '{}' is not registered",
                    id
                )));
            };
            Ok(Some(
                Path::new(project)
                    .join(&reference.path)
                    .to_string_lossy()
                    .to_string(),
            ))
        }
    }
}

pub fn required_relation_target_space_path(
    space: &str,
    project_path: Option<&str>,
    scope: Option<&RelationScope>,
) -> Result<String, CollectionError> {
    relation_target_space_path(space, project_path, scope)?
        .ok_or_else(|| schema_error("project_path is required to resolve relation target scope"))
}

pub fn same_fs_path(left: &str, right: &str) -> bool {
    let normalize = |path: &str| {
        Path::new(path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    normalize(left) == normalize(right)
}

pub fn space_scope_from_project(
    space: &str,
    project_path: Option<&str>,
) -> Result<Option<RelationScope>, CollectionError> {
    let Some(project) = project_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    if same_fs_path(space, project) {
        return Ok(Some(RelationScope::Root));
    }
    for reference in read_relation_space_refs(Path::new(project))? {
        let candidate = Path::new(project).join(&reference.path);
        if same_fs_path(space, &candidate.to_string_lossy()) {
            return Ok(Some(RelationScope::Space { id: reference.id }));
        }
    }
    Ok(None)
}

pub fn reverse_relation_scope_for_target(
    space: &str,
    project_path: Option<&str>,
    target_scope: Option<&RelationScope>,
) -> Result<Option<RelationScope>, CollectionError> {
    let target_space = required_relation_target_space_path(space, project_path, target_scope)?;
    if same_fs_path(space, &target_space) {
        return Ok(None);
    }
    match space_scope_from_project(space, project_path)? {
        Some(RelationScope::Root) => Ok(Some(RelationScope::Root)),
        Some(RelationScope::Space { id }) => Ok(Some(RelationScope::Space { id })),
        None => Err(schema_error(
            "source space is not registered in project; cannot create cross-scope two-way relation",
        )),
    }
}

pub fn relation_target_pair(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
) -> Result<Option<(String, String, Option<RelationScope>)>, CollectionError> {
    if column.type_ != PropertyType::Relation {
        return Ok(None);
    }
    let Some(relation) = column.relation.as_deref() else {
        return Ok(None);
    };
    let relation = normalize_collection_path(relation)?;
    let target_space =
        required_relation_target_space_path(space, project_path, column.relation_scope.as_ref())?;
    let reverse_scope =
        reverse_relation_scope_for_target(space, project_path, column.relation_scope.as_ref())?;
    Ok(Some((target_space, relation, reverse_scope)))
}

pub fn ensure_compatible_reverse_with_scope(
    reverse: &Column,
    current_collection: &str,
    expected_relation_scope: Option<&RelationScope>,
    current_column: &str,
    allow_limit_one: bool,
) -> Result<(), CollectionError> {
    if reverse.type_ != PropertyType::Relation {
        return Err(schema_error(format!(
            "reverse column '{}' is not a relation",
            reverse.name
        )));
    }
    let relation = reverse.relation.as_deref().ok_or_else(|| {
        schema_error(format!("reverse column '{}' has no relation", reverse.name))
    })?;
    if normalize_collection_path(relation)? != collection_root_for_schema(current_collection) {
        return Err(schema_error(format!(
            "reverse column '{}' points to '{}', expected '{}'",
            reverse.name, relation, current_collection
        )));
    }
    if reverse.relation_scope.as_ref() != expected_relation_scope {
        return Err(schema_error(format!(
            "reverse column '{}' points to a different relation scope",
            reverse.name
        )));
    }
    if !current_column.is_empty()
        && reverse
            .two_way
            .as_deref()
            .is_some_and(|paired| paired != current_column)
    {
        return Err(schema_error(format!(
            "reverse column '{}' is paired with another column",
            reverse.name
        )));
    }
    if reverse.limit == Some(RelationLimit::One) && !allow_limit_one {
        return Err(schema_error(format!(
            "reverse column '{}' cannot be limited to one item",
            reverse.name
        )));
    }
    Ok(())
}

pub fn read_relation_field_values_from_file(
    path: &Path,
    column: &Column,
) -> Result<Vec<String>, CollectionError> {
    let raw = fs::read_to_string(path)?;
    let meta = match parse_markdown(&raw, &path.to_string_lossy()) {
        ParsedMarkdown::Missing(_) => return Ok(Vec::new()),
        ParsedMarkdown::Valid(meta, _) => meta,
        ParsedMarkdown::Malformed(message, _) => {
            return Err(CollectionError::FrontmatterParse(message));
        }
    };
    validate_relation_value_shape(column, meta.extra.get(&column.name).unwrap_or(&Value::Null))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RelationEdge {
    source_value: String,
    target_value: String,
}

#[allow(dead_code)]
pub fn diagnose_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<RelationTwoWayDiagnostics, CollectionError> {
    diagnose_two_way_relation_with_project(space, collection_path, column_name, None)
}

pub fn diagnose_two_way_relation_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    project_path: Option<&str>,
) -> Result<RelationTwoWayDiagnostics, CollectionError> {
    let collection_path = collection_root_for_schema(collection_path);
    let schema = read_schema_or_default(space, &collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name && column.type_ == PropertyType::Relation)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    let relation = column
        .relation
        .as_deref()
        .map(normalize_collection_path)
        .transpose()?;
    let reverse_column = column.two_way.clone();
    let target_pair = if relation.is_some() {
        relation_target_pair(space, project_path, &column)?
    } else {
        None
    };
    let choices = if let Some((target_space, relation, reverse_scope)) = target_pair.as_ref() {
        compatible_reverse_choices(
            target_space,
            &collection_path,
            reverse_scope.as_ref(),
            column_name,
            relation,
        )?
    } else {
        Vec::new()
    };

    let mut schema_status = RelationTwoWaySchemaStatus::NotTwoWay;
    let mut schema_message = None;
    let mut drift = RelationDriftSummary::default();

    if let (Some((target_space, relation, reverse_scope)), Some(reverse_name)) =
        (target_pair.as_ref(), reverse_column.as_deref())
    {
        let reverse_schema = read_schema_or_default(target_space, relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter()
            .find(|candidate| candidate.name == reverse_name)
        {
            match ensure_compatible_reverse_with_scope(
                reverse,
                &collection_path,
                reverse_scope.as_ref(),
                column_name,
                true,
            ) {
                Ok(()) if reverse.two_way.as_deref() == Some(column_name) => {
                    schema_status = RelationTwoWaySchemaStatus::Ok;
                    drift = detect_relation_value_drift(
                        space,
                        &collection_path,
                        &column,
                        target_space,
                        relation,
                        reverse,
                    )?;
                }
                Ok(()) => {
                    schema_status = RelationTwoWaySchemaStatus::IncompatibleReverse;
                    schema_message = Some(format!(
                        "reverse column '{reverse_name}' is not paired with '{column_name}'"
                    ));
                }
                Err(error) => {
                    schema_status = RelationTwoWaySchemaStatus::IncompatibleReverse;
                    schema_message = Some(error.to_string());
                }
            }
        } else {
            schema_status = RelationTwoWaySchemaStatus::MissingReverse;
            schema_message = Some(format!("reverse column '{reverse_name}' not found"));
        }
    }

    Ok(RelationTwoWayDiagnostics {
        collection_path,
        column: column_name.to_string(),
        relation,
        reverse_column,
        schema_status,
        schema_message,
        compatible_reverse_choices: choices,
        drift,
    })
}

fn compatible_reverse_choices(
    space: &str,
    collection_path: &str,
    expected_relation_scope: Option<&RelationScope>,
    column_name: &str,
    relation: &str,
) -> Result<Vec<CompatibleReverseChoice>, CollectionError> {
    let mut choices = Vec::new();
    let reverse_schema = read_schema_or_default(space, relation)?;
    for candidate in &reverse_schema.columns {
        if candidate.type_ != PropertyType::Relation {
            continue;
        }
        if candidate.relation_scope.as_ref() != expected_relation_scope {
            continue;
        }
        if candidate.limit == Some(RelationLimit::One) {
            continue;
        }
        let Some(candidate_relation) = candidate.relation.as_deref() else {
            continue;
        };
        if normalize_collection_path(candidate_relation)
            .ok()
            .as_deref()
            != Some(collection_path)
        {
            continue;
        }
        if candidate
            .two_way
            .as_deref()
            .is_some_and(|paired| paired != column_name)
        {
            continue;
        }
        choices.push(CompatibleReverseChoice {
            name: candidate.name.clone(),
            two_way: candidate.two_way.clone(),
        });
    }
    choices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(choices)
}

fn detect_relation_value_drift(
    source_space: &str,
    collection_path: &str,
    column: &Column,
    target_space: &str,
    relation: &str,
    reverse: &Column,
) -> Result<RelationDriftSummary, CollectionError> {
    let source_edges = relation_edges_for_column(source_space, collection_path, column)?;
    let reverse_edges = relation_edges_for_column(target_space, relation, reverse)?
        .into_iter()
        .map(|edge| RelationEdge {
            source_value: edge.target_value,
            target_value: edge.source_value,
        })
        .collect::<HashSet<_>>();

    let mut rows = Vec::new();
    for edge in source_edges.difference(&reverse_edges) {
        rows.push(RelationDriftRow {
            kind: RelationDriftKind::MissingReverse,
            source_file_path: join_collection_value(collection_path, &edge.source_value),
            target_file_path: join_collection_value(relation, &edge.target_value),
            source_value: edge.source_value.clone(),
            target_value: edge.target_value.clone(),
        });
    }
    let missing_reverse_count = rows.len();
    for edge in reverse_edges.difference(&source_edges) {
        rows.push(RelationDriftRow {
            kind: RelationDriftKind::MissingSource,
            source_file_path: join_collection_value(collection_path, &edge.source_value),
            target_file_path: join_collection_value(relation, &edge.target_value),
            source_value: edge.source_value.clone(),
            target_value: edge.target_value.clone(),
        });
    }
    let missing_source_count = rows.len() - missing_reverse_count;
    rows.sort_by(|a, b| {
        a.source_file_path
            .cmp(&b.source_file_path)
            .then_with(|| a.target_file_path.cmp(&b.target_file_path))
            .then_with(|| a.kind.cmp(&b.kind))
    });

    Ok(RelationDriftSummary {
        missing_reverse_count,
        missing_source_count,
        rows,
    })
}

fn relation_edges_for_column(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<HashSet<RelationEdge>, CollectionError> {
    let source_collection = collection_root_for_schema(collection_path);
    let mut edges = HashSet::new();
    for file in collection_markdown_files(space, collection_path)? {
        let file_path = file
            .strip_prefix(space)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let source_value = value_relative_to_collection(&source_collection, &file_path)?;
        for target_value in read_relation_field_values_from_file(&file, column)? {
            edges.insert(RelationEdge {
                source_value: source_value.clone(),
                target_value,
            });
        }
    }
    Ok(edges)
}
