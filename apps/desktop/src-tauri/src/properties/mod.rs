use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Duration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_yml::{Mapping, Value};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::files::entry::{ColorName, EntryMeta};
use crate::files::tree::child_folder_names;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::files::{entry, frontmatter};
use crate::git::cli::GitCli;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;

const SCHEMA_FILE: &str = "schema.yaml";
const RESERVED_FIELDS: &[&str] = &[
    "title",
    "icon",
    "description",
    "cover",
    "created",
    "updated",
];

mod model;
pub use model::*;

mod actors;
pub use actors::{ActorCandidate, ActorCatalogState, list_actors, refresh_actors};
use actors::{
    actor_multiple, canonical_actor_email, canonicalize_actor, current_git_actor, is_actor_type,
    normalize_actor_value,
};

mod entry_defaults;
pub use entry_defaults::{
    apply_contextual_defaults_for_path, apply_contextual_defaults_for_path_strict,
    apply_schema_defaults_for_path, apply_schema_defaults_to_entry_tree, assign_unique_id,
    assign_unique_id_to_meta_for_path, assign_unique_ids_to_entry_tree,
    normalize_unique_id_counter, unique_id_mutation_paths_for_entry,
    unique_id_mutation_paths_for_entry_tree, unique_id_schema_path_for_entry,
};
use entry_defaults::{dedupe_paths, materialize_unique_id_column};

mod integrity;
#[allow(unused_imports)] // Stable properties facade for Tauri/backend callers.
pub use integrity::{
    CollectionInfo, CollectionIntegrityIssue, CollectionIntegrityReport,
    CollectionIntegritySeverity, list_collections, validate_collection_integrity_with_project,
};
use integrity::{is_collection_traversal_ignored, is_registered_child_space_rel};

mod query;
#[allow(unused_imports)] // Stable properties facade; primarily used by focused tests today.
pub use query::reorder_visible_entry_names;
use query::{
    entries_from_rows, entry_order_name, entry_parent_dir, filter_values, query_entry_rows,
    validate_ad_hoc_query,
};

mod schema_validation;
use schema_validation::{
    FieldContext, FieldType, autopick_board_group_by, autopick_calendar_date_field, field_type,
    normalize_property_value_for_write, normalize_view, single_filter_value, status_group_name,
    validate_field_ref, validate_filter_op,
};
pub use schema_validation::{
    ensure_entry_field_writable, normalize_entry_field_value, normalize_schema,
    validate_entry_field_value, validate_schema,
};

mod schema_mutations;
#[allow(unused_imports)] // Stable properties facade; wrappers remain part of the backend API.
pub use schema_mutations::{
    SchemaMutationWarning, add_option, add_schema_column, add_schema_column_with_project, add_view,
    change_schema_type, change_schema_type_with_warnings,
    change_schema_type_with_warnings_and_project, clear_field_values, clear_option_values,
    default_collection_schema, delete_option, delete_schema_column,
    delete_schema_column_with_project, delete_view, duplicate_view, promote_orphan, rename_option,
    rename_schema_column, rename_schema_column_with_project, rename_template_slug_references,
    rename_view, reorder_templates, reorder_views, replace_option_values, set_default_template,
    update_option, update_schema_column, update_schema_column_with_project,
    update_system_field_label, update_view, write_default_collection_schema,
};
use schema_mutations::{find_column_mut, strip_string_refs_in_views};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySchemaResponse {
    pub schema: CollectionSchema,
    pub collection_root_path: String,
}

fn schema_error(message: impl Into<String>) -> AppError {
    AppError::General(format!("schema error: {}", message.into()))
}

pub fn column_effective_sensitivity(column: &Column) -> ColumnSensitivity {
    if let Some(sensitivity) = column.sensitivity {
        return sensitivity;
    }
    match column.type_ {
        PropertyType::Email | PropertyType::Phone => ColumnSensitivity::Pii,
        _ => ColumnSensitivity::None,
    }
}

pub fn schema_has_sensitive_columns(schema: &CollectionSchema) -> bool {
    schema
        .columns
        .iter()
        .any(|column| column_effective_sensitivity(column) == ColumnSensitivity::Pii)
}

fn yaml_u64(value: u64) -> Value {
    serde_yml::to_value(value).unwrap_or(Value::Null)
}

fn unique_id_value(value: &Value) -> Option<u64> {
    value.as_u64().filter(|value| *value >= 1)
}

fn trim_unique_id_prefix(prefix: Option<String>) -> Option<String> {
    prefix.and_then(|prefix| {
        let trimmed = prefix.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn validate_unique_id_prefix(column_name: &str, prefix: &str) -> Result<(), AppError> {
    if prefix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Ok(())
    } else {
        Err(schema_error(format!(
            "unique_id column '{column_name}' prefix can contain only ASCII letters, digits, '_' or '-'"
        )))
    }
}

fn parse_unique_id_filter_value(column: &Column, value: &Value) -> Result<u64, AppError> {
    if let Some(number) = unique_id_value(value) {
        return Ok(number);
    }
    let Some(raw) = value.as_str() else {
        return Err(schema_error(format!(
            "filter '{}' requires positive integer or display id",
            column.name
        )));
    };
    let trimmed = raw.trim();
    let numeric = if let Some(prefix) = column.prefix.as_deref().filter(|prefix| !prefix.is_empty())
    {
        trimmed
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('-'))
            .ok_or_else(|| {
                schema_error(format!(
                    "filter '{}' display id must use prefix '{}'",
                    column.name, prefix
                ))
            })?
    } else {
        trimmed
    };
    numeric
        .parse::<u64>()
        .ok()
        .filter(|value| *value >= 1)
        .ok_or_else(|| {
            schema_error(format!(
                "filter '{}' requires positive integer or display id",
                column.name
            ))
        })
}

pub fn default_status_options() -> Vec<PropertyOption> {
    vec![
        PropertyOption {
            name: "Backlog".into(),
            color: Some(ColorName::Gray),
            icon: None,
            group: Some(StatusGroup::Todo),
        },
        PropertyOption {
            name: "Todo".into(),
            color: Some(ColorName::Blue),
            icon: None,
            group: Some(StatusGroup::Todo),
        },
        PropertyOption {
            name: "In progress".into(),
            color: Some(ColorName::Yellow),
            icon: None,
            group: Some(StatusGroup::InProgress),
        },
        PropertyOption {
            name: "Done".into(),
            color: Some(ColorName::Green),
            icon: None,
            group: Some(StatusGroup::Done),
        },
    ]
}

pub fn resolve_collection_schema(
    space: &str,
    file_path: &str,
) -> Option<(CollectionSchema, PathBuf)> {
    resolve_collection_schema_result(space, file_path)
        .ok()
        .flatten()
}

pub fn resolve_collection_schema_result(
    space: &str,
    file_path: &str,
) -> Result<Option<(CollectionSchema, PathBuf)>, AppError> {
    let space_path = Path::new(space);
    let Some(root) = find_collection_root(space_path, file_path) else {
        return Ok(None);
    };
    let schema = read_schema_at(&space_path.join(&root).join(SCHEMA_FILE))?;
    Ok(Some((schema, root)))
}

pub fn schema_response(
    space: &str,
    file_path: &str,
) -> Result<Option<EntrySchemaResponse>, AppError> {
    Ok(
        resolve_collection_schema_result(space, file_path)?.map(|(schema, root)| {
            EntrySchemaResponse {
                schema,
                collection_root_path: rel_path_string(&root),
            }
        }),
    )
}

fn find_collection_root(space: &Path, file_path: &str) -> Option<PathBuf> {
    let rel = normalize_rel_path(file_path);
    let rel_path = Path::new(&rel);
    let mut dir = rel_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_default();

    if rel_path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("README.md"))
    {
        dir = dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default();
    }

    loop {
        if space.join(&dir).join(SCHEMA_FILE).is_file() {
            return Some(dir);
        }

        if dir.as_os_str().is_empty() {
            break;
        }
        dir = dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default();
    }

    None
}

fn normalize_rel_path(path: &str) -> String {
    normalize_repo_relative(path, RootMode::Allow).unwrap_or_else(|_| {
        path.trim_matches('/')
            .replace('\\', "/")
            .trim_start_matches("./")
            .to_string()
    })
}

fn rel_path_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

fn collection_dir(space: &str, collection_path: &str) -> PathBuf {
    let rel = normalize_rel_path(collection_path);
    if rel.is_empty() || rel == "." {
        PathBuf::from(space)
    } else {
        Path::new(space).join(rel)
    }
}

fn collection_rel(collection_path: &str) -> PathBuf {
    let rel = normalize_rel_path(collection_path);
    if rel.is_empty() || rel == "." {
        PathBuf::new()
    } else {
        PathBuf::from(rel)
    }
}

fn collection_root_for_schema(collection_path: &str) -> String {
    let rel = normalize_rel_path(collection_path);
    if rel.is_empty() { ".".to_string() } else { rel }
}

fn collection_root_for_fs(collection_path: &str) -> String {
    let rel = normalize_rel_path(collection_path);
    if rel == "." { String::new() } else { rel }
}

fn normalize_collection_path(path: &str) -> Result<String, AppError> {
    normalize_repo_relative(path, RootMode::Allow)
        .map_err(|e| schema_error(e.to_string()))
        .map(|rel| if rel.is_empty() { ".".to_string() } else { rel })
}

fn normalize_relation_scope(
    scope: Option<RelationScope>,
) -> Result<Option<RelationScope>, AppError> {
    match scope {
        Some(RelationScope::Root) => Ok(Some(RelationScope::Root)),
        Some(RelationScope::Space { id }) => {
            let id = id.trim();
            if id.is_empty() {
                return Err(schema_error("relation_scope.id cannot be empty"));
            }
            Ok(Some(RelationScope::Space { id: id.to_string() }))
        }
        None => Ok(None),
    }
}

fn relation_target_space_path(
    space: &str,
    project_path: Option<&str>,
    scope: Option<&RelationScope>,
) -> Result<Option<String>, AppError> {
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
            let config = match config::read_space_config(Path::new(project)) {
                Ok(config) => config,
                Err(error) if project_path.is_none() => {
                    tracing::warn!(
                        "relation target scope space '{}' could not read project config: {error}",
                        id
                    );
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            let Some(space_ref) = config
                .spaces
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|space_ref| space_ref.id == *id)
            else {
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
                    .join(&space_ref.path)
                    .to_string_lossy()
                    .to_string(),
            ))
        }
    }
}

fn required_relation_target_space_path(
    space: &str,
    project_path: Option<&str>,
    scope: Option<&RelationScope>,
) -> Result<String, AppError> {
    relation_target_space_path(space, project_path, scope)?
        .ok_or_else(|| schema_error("project_path is required to resolve relation target scope"))
}

fn relation_is_current_scope(column: &Column) -> bool {
    column.relation_scope.is_none()
}

fn same_fs_path(left: &str, right: &str) -> bool {
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

fn space_scope_from_project(
    space: &str,
    project_path: Option<&str>,
) -> Result<Option<RelationScope>, AppError> {
    let Some(project) = project_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    if same_fs_path(space, project) {
        return Ok(Some(RelationScope::Root));
    }
    let config = config::read_space_config(Path::new(project))?;
    for space_ref in config.spaces.as_deref().unwrap_or(&[]) {
        let candidate = Path::new(project).join(&space_ref.path);
        if same_fs_path(space, &candidate.to_string_lossy()) {
            return Ok(Some(RelationScope::Space {
                id: space_ref.id.clone(),
            }));
        }
    }
    Ok(None)
}

fn reverse_relation_scope_for_target(
    space: &str,
    project_path: Option<&str>,
    target_scope: Option<&RelationScope>,
) -> Result<Option<RelationScope>, AppError> {
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

fn validate_physical_two_way_relation_scope(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
) -> Result<(), AppError> {
    if column.two_way.is_none() {
        return Ok(());
    }
    let Some(RelationScope::Space {
        id: target_space_id,
    }) = column.relation_scope.as_ref()
    else {
        return Ok(());
    };
    if let Some(RelationScope::Space {
        id: source_space_id,
    }) = space_scope_from_project(space, project_path)?
    {
        if source_space_id != *target_space_id {
            return Err(schema_error(format!(
                "relation column '{}' cannot be two-way between sibling spaces",
                column.name
            )));
        }
    }
    Ok(())
}

fn relation_target_pair(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
) -> Result<Option<(String, String, Option<RelationScope>)>, AppError> {
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

fn project_relation_scan_spaces(
    space: &str,
    project_path: Option<&str>,
) -> Result<Vec<String>, AppError> {
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
    let config = config::read_space_config(Path::new(project))?;
    for space_ref in config.spaces.as_deref().unwrap_or(&[]) {
        push_space(
            Path::new(project)
                .join(&space_ref.path)
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(spaces)
}

fn relation_column_targets_space(
    source_space: &str,
    project_path: Option<&str>,
    column: &Column,
    target_space: &str,
) -> Result<Option<String>, AppError> {
    if column.type_ != PropertyType::Relation {
        return Ok(None);
    }
    let Some(relation) = column.relation.as_deref() else {
        return Ok(None);
    };
    let Some(resolved_target_space) =
        relation_target_space_path(source_space, project_path, column.relation_scope.as_ref())?
    else {
        return Ok(None);
    };
    if !same_fs_path(&resolved_target_space, target_space) {
        return Ok(None);
    }
    Ok(Some(normalize_collection_path(relation)?))
}

fn join_collection_value(collection_path: &str, value: &str) -> String {
    let collection = collection_root_for_fs(collection_path);
    if collection.is_empty() {
        value.to_string()
    } else {
        format!("{collection}/{value}")
    }
}

fn value_relative_to_collection(
    collection_path: &str,
    file_path: &str,
) -> Result<String, AppError> {
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

fn canonicalize_relation_target_value(
    target_space: &str,
    relation: &str,
    raw_value: &str,
) -> Result<String, AppError> {
    let value = normalize_relation_value_shape(raw_value)?;
    let full = join_collection_value(relation, &value);
    let abs = Path::new(target_space).join(&full);
    let (target_abs, target_rel) = if abs.is_dir() {
        let readme = abs.join("README.md");
        if !readme.is_file() {
            return Err(schema_error(format!(
                "relation target '{}' has no README.md",
                full
            )));
        }
        (readme, format!("{full}/README.md"))
    } else {
        (abs, full)
    };
    if !target_abs.is_file() {
        return Err(AppError::FileNotFound(target_rel));
    }
    let expected = collection_rel(relation);
    let actual = find_collection_root(Path::new(target_space), &target_rel).ok_or_else(|| {
        schema_error(format!(
            "relation target '{}' is not in a collection",
            target_rel
        ))
    })?;
    if actual != expected {
        return Err(schema_error(format!(
            "relation target '{}' is outside linked collection '{}'",
            target_rel,
            collection_root_for_schema(relation)
        )));
    }
    value_relative_to_collection(relation, &target_rel)
}

#[allow(dead_code)]
fn ensure_compatible_reverse(
    reverse: &Column,
    current_collection: &str,
    current_column: &str,
) -> Result<(), AppError> {
    ensure_compatible_reverse_with_scope(reverse, current_collection, None, current_column, false)
}

#[allow(dead_code)]
fn ensure_compatible_reverse_with_limit_policy(
    reverse: &Column,
    current_collection: &str,
    current_column: &str,
    allow_limit_one: bool,
) -> Result<(), AppError> {
    ensure_compatible_reverse_with_scope(
        reverse,
        current_collection,
        None,
        current_column,
        allow_limit_one,
    )
}

fn ensure_compatible_reverse_with_scope(
    reverse: &Column,
    current_collection: &str,
    expected_relation_scope: Option<&RelationScope>,
    current_column: &str,
    allow_limit_one: bool,
) -> Result<(), AppError> {
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

fn read_schema_at(path: &Path) -> Result<CollectionSchema, AppError> {
    let raw = fs::read_to_string(path)?;
    let mut schema: CollectionSchema =
        serde_yml::from_str(&raw).map_err(|e| schema_error(format!("invalid schema YAML: {e}")))?;
    normalize_schema(&mut schema);
    validate_schema(&schema)?;
    Ok(schema)
}

fn read_schema_or_default(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, AppError> {
    let path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    if path.is_file() {
        read_schema_at(&path)
    } else {
        Ok(CollectionSchema::default())
    }
}

pub fn read_collection_schema(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, AppError> {
    read_schema_at(&collection_dir(space, collection_path).join(SCHEMA_FILE))
}

fn write_schema(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), AppError> {
    write_schema_with_project(space, collection_path, schema, None)
}

fn write_schema_with_project(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
    project_path: Option<&str>,
) -> Result<(), AppError> {
    let mut schema = schema.clone();
    normalize_schema(&mut schema);
    validate_schema(&schema)?;
    validate_schema_relations_in_space(space, project_path, collection_path, &schema)?;
    let dir = collection_dir(space, collection_path);
    fs::create_dir_all(&dir)?;
    let yaml = serde_yml::to_string(&schema)
        .map_err(|e| schema_error(format!("could not serialize schema: {e}")))?;
    fs::write(dir.join(SCHEMA_FILE), yaml)?;
    Ok(())
}

pub fn write_collection_schema(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), AppError> {
    write_schema(space, collection_path, schema)
}

fn validate_schema_relations_in_space(
    space: &str,
    project_path: Option<&str>,
    _collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), AppError> {
    for column in &schema.columns {
        if column.type_ != PropertyType::Relation {
            continue;
        }
        let relation = column.relation.as_deref().ok_or_else(|| {
            schema_error(format!(
                "relation column '{}' requires relation",
                column.name
            ))
        })?;
        let relation = normalize_collection_path(relation)?;
        let Some(target_space) =
            relation_target_space_path(space, project_path, column.relation_scope.as_ref())?
        else {
            continue;
        };
        let target = collection_dir(&target_space, &relation);
        if !target.is_dir() || !target.join(SCHEMA_FILE).is_file() {
            return Err(schema_error(format!(
                "relation column '{}' points to missing collection '{}'",
                column.name, relation
            )));
        }
        if let Some(reverse_name) = column.two_way.as_deref() {
            validate_relation_column_name(reverse_name)?;
            validate_physical_two_way_relation_scope(space, project_path, column)?;
        }
    }
    Ok(())
}

pub fn schema_mutation_paths(
    space: &str,
    collection_path: &str,
    include_markdown: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = vec![collection_dir(space, collection_path).join(SCHEMA_FILE)];
    if include_markdown {
        paths.extend(collection_markdown_files(space, collection_path)?);
    }
    Ok(paths)
}

#[allow(dead_code)]
pub fn schema_column_mutation_paths(
    space: &str,
    collection_path: &str,
    column: &Column,
    include_markdown: bool,
) -> Result<Vec<PathBuf>, AppError> {
    schema_column_mutation_paths_with_project(
        space,
        collection_path,
        column,
        include_markdown,
        None,
    )
}

pub fn schema_column_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column: &Column,
    include_markdown: bool,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = schema_mutation_paths(space, collection_path, include_markdown)?;
    extend_relation_side_effect_paths(space, project_path, collection_path, column, &mut paths)?;
    Ok(paths)
}

#[allow(dead_code)]
pub fn schema_column_name_mutation_paths(
    space: &str,
    collection_path: &str,
    column_name: &str,
    include_markdown: bool,
) -> Result<Vec<PathBuf>, AppError> {
    schema_column_name_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        include_markdown,
        None,
    )
}

pub fn schema_column_name_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    include_markdown: bool,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    let schema = read_schema_or_default(space, collection_path)?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        return schema_column_mutation_paths_with_project(
            space,
            collection_path,
            column,
            include_markdown,
            project_path,
        );
    }
    schema_mutation_paths(space, collection_path, include_markdown)
}

fn extend_relation_side_effect_paths(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
    paths: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation || column.two_way.is_none() {
        return Ok(());
    }
    let Some((target_space, relation, _)) = relation_target_pair(space, project_path, column)?
    else {
        return Ok(());
    };
    paths.push(collection_dir(&target_space, &relation).join(SCHEMA_FILE));
    paths.extend(collection_markdown_files(space, collection_path)?);
    paths.extend(collection_markdown_files(&target_space, &relation)?);
    Ok(())
}

fn normalize_column_relation_paths(column: &mut Column) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation {
        column.relation = None;
        column.relation_scope = None;
        column.limit = None;
        column.two_way = None;
        return Ok(());
    }
    column.prefix = None;
    column.next = None;
    column.multiple = None;
    if let Some(relation) = column.relation.take() {
        column.relation = Some(normalize_collection_path(&relation)?);
    }
    column.relation_scope = normalize_relation_scope(column.relation_scope.take())?;
    column.two_way = column.two_way.take().and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    Ok(())
}

#[allow(dead_code)]
fn ensure_two_way_schema_and_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    ensure_two_way_schema_and_values_with_project(space, collection_path, column, None)
}

fn ensure_two_way_schema_and_values_with_project(
    space: &str,
    collection_path: &str,
    column: &Column,
    project_path: Option<&str>,
) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation {
        return Ok(());
    }
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, column)?
    else {
        return Ok(());
    };
    let source_collection = collection_root_for_schema(collection_path);
    let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
    if let Some(existing) = reverse_schema
        .columns
        .iter_mut()
        .find(|existing| existing.name == reverse_name)
    {
        ensure_compatible_reverse_with_scope(
            existing,
            &source_collection,
            reverse_scope.as_ref(),
            &column.name,
            false,
        )?;
        existing.two_way = Some(column.name.clone());
    } else {
        reverse_schema.columns.push(Column {
            name: reverse_name.to_string(),
            type_: PropertyType::Relation,
            sensitivity: None,
            default: None,
            options: None,
            display: None,
            min: None,
            max: None,
            color: None,
            time_by_default: None,
            range_by_default: None,
            relation: Some(source_collection.clone()),
            relation_scope: reverse_scope.clone(),
            limit: None,
            two_way: Some(column.name.clone()),
            prefix: None,
            next: None,
            multiple: None,
        });
    }
    write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
    materialize_two_way_reverse_values_with_project(space, project_path, collection_path, column)
}

#[allow(dead_code)]
fn materialize_two_way_reverse_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_project(space, None, collection_path, column)
}

fn materialize_two_way_reverse_values_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_limit_policy(
        space,
        project_path,
        collection_path,
        column,
        false,
    )
}

#[allow(dead_code)]
fn materialize_two_way_reverse_values_allowing_limit_one_reverse(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_limit_policy(space, None, collection_path, column, true)
}

fn materialize_two_way_reverse_values_allowing_limit_one_reverse_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_limit_policy(
        space,
        project_path,
        collection_path,
        column,
        true,
    )
}

fn materialize_two_way_reverse_values_with_limit_policy(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
    allow_limit_one_reverse: bool,
) -> Result<(), AppError> {
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, column)?
    else {
        return Ok(());
    };
    let source_collection = collection_root_for_schema(collection_path);
    for file in collection_markdown_files(space, collection_path)? {
        let rel = file
            .strip_prefix(space)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let source_value = value_relative_to_collection(&source_collection, &rel)?;
        let values = read_relation_field_values_from_file(&file, column)?;
        sync_reverse_relation_values_with_limit_policy(
            &target_space,
            &relation,
            reverse_name,
            &column.name,
            &source_collection,
            reverse_scope.as_ref(),
            &source_value,
            &[],
            &values,
            allow_limit_one_reverse,
        )?;
    }
    Ok(())
}

#[allow(dead_code)]
fn update_reverse_pair_name(
    space: &str,
    collection_path: &str,
    old_column: &Column,
    new_name: &str,
) -> Result<(), AppError> {
    update_reverse_pair_name_with_project(space, None, collection_path, old_column, new_name)
}

fn update_reverse_pair_name_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    old_column: &Column,
    new_name: &str,
) -> Result<(), AppError> {
    let Some(reverse_name) = old_column.two_way.as_deref() else {
        return Ok(());
    };
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, old_column)?
    else {
        return Ok(());
    };
    let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
    if let Some(reverse) = reverse_schema
        .columns
        .iter_mut()
        .find(|column| column.name == reverse_name && column.type_ == PropertyType::Relation)
    {
        ensure_compatible_reverse_with_scope(
            reverse,
            &collection_root_for_schema(collection_path),
            reverse_scope.as_ref(),
            &old_column.name,
            false,
        )?;
        reverse.two_way = Some(new_name.to_string());
        write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
    }
    Ok(())
}

#[allow(dead_code)]
fn detach_two_way_relation(
    space: &str,
    _collection_path: &str,
    column: &Column,
    delete_reverse_column: bool,
) -> Result<(), AppError> {
    detach_two_way_relation_with_project(space, None, column, delete_reverse_column)
}

fn detach_two_way_relation_with_project(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
    delete_reverse_column: bool,
) -> Result<(), AppError> {
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    let Some((target_space, relation, _)) = relation_target_pair(space, project_path, column)?
    else {
        return Ok(());
    };
    if delete_reverse_column {
        let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
        let before = reverse_schema.columns.len();
        reverse_schema
            .columns
            .retain(|candidate| candidate.name != reverse_name);
        if reverse_schema.columns.len() != before {
            strip_string_refs_in_views(&mut reverse_schema.views, reverse_name);
            write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
        }
    } else {
        let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter_mut()
            .find(|candidate| candidate.name == reverse_name)
        {
            reverse.two_way = None;
            write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
        }
    }
    for file in collection_markdown_files(&target_space, &relation)? {
        mutate_frontmatter(&file, |meta| {
            meta.extra.remove(reverse_name);
            Ok(())
        })?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn cascade_clean_deleted_entries(
    space: &str,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    cascade_clean_deleted_entries_with_project(space, None, deleted_paths)
}

pub fn cascade_clean_deleted_entries_with_project(
    space: &str,
    project_path: Option<&str>,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if deleted_paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut touched = Vec::new();
    let scan_spaces = project_relation_scan_spaces(space, project_path)?;
    for source_space in &scan_spaces {
        for collection in list_collections(source_space)? {
            touched.extend(collection_markdown_files(source_space, &collection.path)?);
        }
    }
    let mut changed = Vec::new();
    with_rollback(touched, || {
        for source_space in &scan_spaces {
            for collection in list_collections(source_space)? {
                let schema = read_schema_or_default(source_space, &collection.path)?;
                let relation_columns: Vec<(Column, String)> = schema
                    .columns
                    .iter()
                    .filter_map(|column| {
                        relation_column_targets_space(source_space, project_path, column, space)
                            .transpose()
                            .map(|relation| relation.map(|relation| (column.clone(), relation)))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if relation_columns.is_empty() {
                    continue;
                }
                for file in collection_markdown_files(source_space, &collection.path)? {
                    let did_change = mutate_frontmatter(&file, |meta| {
                        for (column, relation) in &relation_columns {
                            let deleted_values = deleted_paths
                                .iter()
                                .filter_map(|path| {
                                    value_relative_to_collection(relation, path).ok()
                                })
                                .collect::<HashSet<_>>();
                            if deleted_values.is_empty() {
                                continue;
                            }
                            let Some(existing) = meta.extra.get(&column.name).cloned() else {
                                continue;
                            };
                            let mut values = relation_values_from_value(column, &existing)?;
                            let before = values.len();
                            values.retain(|value| !deleted_values.contains(value));
                            if values.len() != before {
                                let next = relation_value_from_values(column, values);
                                if next.is_null()
                                    || next
                                        .as_sequence()
                                        .is_some_and(|sequence| sequence.is_empty())
                                {
                                    meta.extra.remove(&column.name);
                                } else {
                                    meta.extra.insert(column.name.clone(), next);
                                }
                            }
                        }
                        Ok(())
                    })?;
                    if did_change {
                        changed.push(file);
                    }
                }
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

#[allow(dead_code)]
fn cascade_clean_deleted_entries_current_scope(
    space: &str,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if deleted_paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut touched = Vec::new();
    for collection in list_collections(space)? {
        touched.extend(collection_markdown_files(space, &collection.path)?);
    }
    let mut changed = Vec::new();
    with_rollback(touched, || {
        for collection in list_collections(space)? {
            let schema = read_schema_or_default(space, &collection.path)?;
            let relation_columns: Vec<Column> = schema
                .columns
                .iter()
                .filter(|column| {
                    column.type_ == PropertyType::Relation && relation_is_current_scope(column)
                })
                .cloned()
                .collect();
            if relation_columns.is_empty() {
                continue;
            }
            for file in collection_markdown_files(space, &collection.path)? {
                let did_change = mutate_frontmatter(&file, |meta| {
                    for column in &relation_columns {
                        let Some(relation) = column.relation.as_deref() else {
                            continue;
                        };
                        let deleted_values = deleted_paths
                            .iter()
                            .filter_map(|path| value_relative_to_collection(relation, path).ok())
                            .collect::<HashSet<_>>();
                        if deleted_values.is_empty() {
                            continue;
                        }
                        let Some(existing) = meta.extra.get(&column.name).cloned() else {
                            continue;
                        };
                        let mut values = relation_values_from_value(column, &existing)?;
                        let before = values.len();
                        values.retain(|value| !deleted_values.contains(value));
                        if values.len() != before {
                            let next = relation_value_from_values(column, values);
                            if next.is_null()
                                || next
                                    .as_sequence()
                                    .is_some_and(|sequence| sequence.is_empty())
                            {
                                meta.extra.remove(&column.name);
                            } else {
                                meta.extra.insert(column.name.clone(), next);
                            }
                        }
                    }
                    Ok(())
                })?;
                if did_change {
                    changed.push(file);
                }
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn rewrite_relation_paths_for_move(
    space: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), AppError> {
    rewrite_relation_paths_for_move_with_project(space, None, old_path, new_path)
}

pub fn rewrite_relation_paths_for_move_with_project(
    space: &str,
    project_path: Option<&str>,
    old_path: &str,
    new_path: &str,
) -> Result<(), AppError> {
    let old_path = normalize_rel_path(old_path);
    let new_path = normalize_rel_path(new_path);
    if old_path == new_path {
        return Ok(());
    }

    let space_path = Path::new(space);
    let new_abs = space_path.join(&new_path);
    let collection_rename = new_abs.is_dir() && new_abs.join(SCHEMA_FILE).is_file();
    let old_collection_path = old_path.clone();
    let new_collection_path = new_path.clone();
    let moved_paths = moved_markdown_path_pairs(space_path, &old_path, &new_path, &new_abs)?;
    let mut touched = Vec::new();
    for source_space in project_relation_scan_spaces(space, project_path)? {
        for collection in list_collections(&source_space)? {
            touched.push(collection_dir(&source_space, &collection.path).join(SCHEMA_FILE));
            touched.extend(collection_markdown_files(&source_space, &collection.path)?);
        }
    }

    with_rollback(touched, || {
        if collection_rename {
            rewrite_relation_collection_paths_for_target_space(
                space,
                project_path,
                &old_collection_path,
                &new_collection_path,
            )?;
        }

        for (old_file, new_file) in &moved_paths {
            let old_root = find_collection_root(space_path, old_file);
            let Some((_, new_root)) = resolve_collection_schema_result(space, new_file)? else {
                continue;
            };
            if let Some(old_root) = old_root.as_ref().filter(|old_root| *old_root != &new_root) {
                let relation = rel_path_string(old_root);
                if let Ok(old_value) = value_relative_to_collection(&relation, old_file) {
                    rewrite_relation_value_refs_for_target_space(
                        space,
                        project_path,
                        &relation,
                        &old_value,
                        new_file,
                    )?;
                }
                continue;
            }
            let relation = rel_path_string(&new_root);
            let old_value = match value_relative_to_collection(&relation, old_file) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let new_value = value_relative_to_collection(&relation, new_file)?;
            rewrite_relation_value_refs_for_target_space(
                space,
                project_path,
                &relation,
                &old_value,
                &new_value,
            )?;
        }
        Ok(())
    })
}

fn moved_markdown_path_pairs(
    space: &Path,
    old_path: &str,
    new_path: &str,
    new_abs: &Path,
) -> Result<Vec<(String, String)>, AppError> {
    if new_abs.is_dir() {
        let new_prefix = normalize_rel_path(new_path);
        let old_prefix = normalize_rel_path(old_path);
        let mut pairs = Vec::new();
        for file in collect_md_files_in_space(space, new_abs)? {
            let new_file = rel_path_string(file.strip_prefix(space).unwrap_or(&file));
            let suffix = new_file
                .strip_prefix(&format!("{new_prefix}/"))
                .unwrap_or(&new_file);
            let old_file = if old_prefix.is_empty() {
                suffix.to_string()
            } else {
                format!("{old_prefix}/{suffix}")
            };
            pairs.push((old_file, new_file));
        }
        return Ok(pairs);
    }
    if new_abs.extension().and_then(|ext| ext.to_str()) == Some("md") {
        return Ok(vec![(
            normalize_rel_path(old_path),
            normalize_rel_path(new_path),
        )]);
    }
    Ok(Vec::new())
}

pub fn rewrite_internal_relation_refs_for_copy(
    space: &str,
    source_root: &str,
    dest_root: &str,
) -> Result<(), AppError> {
    let space_path = Path::new(space);
    let source_rel = normalize_rel_path(source_root);
    let dest_rel = normalize_rel_path(dest_root);
    let source_abs = if source_rel.is_empty() || source_rel == "." {
        space_path.to_path_buf()
    } else {
        space_path.join(&source_rel)
    };
    let dest_abs = if dest_rel.is_empty() || dest_rel == "." {
        space_path.to_path_buf()
    } else {
        space_path.join(&dest_rel)
    };
    if !source_abs.exists() || !dest_abs.exists() {
        return Ok(());
    }

    let mut file_map = HashMap::new();
    collect_copied_markdown_path_map(space_path, &source_abs, &dest_abs, &mut file_map)?;
    let mut schema_dirs = Vec::new();
    collect_copied_collection_dirs(space_path, &source_abs, &dest_abs, &mut schema_dirs)?;

    if file_map.is_empty() && schema_dirs.is_empty() {
        return Ok(());
    }

    let collection_map = schema_dirs
        .iter()
        .map(|(old_collection, new_collection, _)| (old_collection.clone(), new_collection.clone()))
        .collect::<HashMap<_, _>>();
    let mut touched = file_map
        .values()
        .map(|path| space_path.join(path))
        .collect::<Vec<_>>();
    touched.extend(schema_dirs.iter().map(|(_, _, dir)| dir.join(SCHEMA_FILE)));

    with_rollback(touched, || {
        let changed_collections =
            rewrite_copied_schema_relation_roots(space, &schema_dirs, &collection_map)?;
        rewrite_copied_relation_values(space, &file_map)?;
        for collection_path in changed_collections {
            let schema = read_schema_or_default(space, &collection_path)?;
            validate_schema_relations_in_space(space, None, &collection_path, &schema)?;
        }
        Ok(())
    })
}

fn collect_copied_markdown_path_map(
    space: &Path,
    source_abs: &Path,
    dest_abs: &Path,
    out: &mut HashMap<String, String>,
) -> Result<(), AppError> {
    if source_abs.is_file() {
        if dest_abs.is_file() && is_markdown_path(source_abs) && is_markdown_path(dest_abs) {
            out.insert(
                copy_rel_from_abs(space, source_abs),
                copy_rel_from_abs(space, dest_abs),
            );
        }
        return Ok(());
    }

    if !source_abs.is_dir() || !dest_abs.is_dir() {
        return Ok(());
    }

    for item in fs::read_dir(source_abs)? {
        let item = item?;
        let source_child = item.path();
        let dest_child = dest_abs.join(item.file_name());
        if source_child.is_dir() {
            collect_copied_markdown_path_map(space, &source_child, &dest_child, out)?;
        } else if source_child.is_file()
            && dest_child.is_file()
            && is_markdown_path(&source_child)
            && is_markdown_path(&dest_child)
        {
            out.insert(
                copy_rel_from_abs(space, &source_child),
                copy_rel_from_abs(space, &dest_child),
            );
        }
    }
    Ok(())
}

fn collect_copied_collection_dirs(
    space: &Path,
    source_abs: &Path,
    dest_abs: &Path,
    out: &mut Vec<(String, String, PathBuf)>,
) -> Result<(), AppError> {
    if !source_abs.is_dir() || !dest_abs.is_dir() {
        return Ok(());
    }

    if source_abs.join(SCHEMA_FILE).is_file() && dest_abs.join(SCHEMA_FILE).is_file() {
        out.push((
            copy_rel_from_abs(space, source_abs),
            copy_rel_from_abs(space, dest_abs),
            dest_abs.to_path_buf(),
        ));
    }

    for item in fs::read_dir(source_abs)? {
        let item = item?;
        let source_child = item.path();
        if source_child.is_dir() {
            collect_copied_collection_dirs(
                space,
                &source_child,
                &dest_abs.join(item.file_name()),
                out,
            )?;
        }
    }
    Ok(())
}

fn rewrite_copied_schema_relation_roots(
    space: &str,
    schema_dirs: &[(String, String, PathBuf)],
    collection_map: &HashMap<String, String>,
) -> Result<Vec<String>, AppError> {
    let mut changed_collections = Vec::new();
    for (_, new_collection, _) in schema_dirs {
        let mut schema = read_schema_or_default(space, new_collection)?;
        let mut changed = false;
        for column in &mut schema.columns {
            if column.type_ != PropertyType::Relation {
                continue;
            }
            if !relation_is_current_scope(column) {
                continue;
            }
            let Some(relation) = column.relation.as_deref() else {
                continue;
            };
            let relation = normalize_collection_path(relation)?;
            if let Some(new_relation) = collection_map.get(&relation) {
                column.relation = Some(new_relation.clone());
                changed = true;
            }
        }
        if changed {
            write_schema_without_relation_validation(space, new_collection, &schema)?;
            changed_collections.push(new_collection.clone());
        }
    }
    Ok(changed_collections)
}

fn rewrite_copied_relation_values(
    space: &str,
    file_map: &HashMap<String, String>,
) -> Result<(), AppError> {
    let mut dest_files = file_map.values().cloned().collect::<Vec<_>>();
    dest_files.sort();
    dest_files.dedup();

    for dest_rel in dest_files {
        let Some((schema, _)) = resolve_collection_schema_result(space, &dest_rel)? else {
            continue;
        };
        let columns = schema
            .columns
            .iter()
            .filter(|column| {
                column.type_ == PropertyType::Relation && relation_is_current_scope(column)
            })
            .cloned()
            .collect::<Vec<_>>();
        if columns.is_empty() {
            continue;
        }

        let dest_abs = Path::new(space).join(&dest_rel);
        mutate_frontmatter(&dest_abs, |meta| {
            for column in &columns {
                let Some(relation) = column.relation.as_deref() else {
                    continue;
                };
                let relation = normalize_collection_path(relation)?;
                let Some(existing) = meta.extra.get(&column.name).cloned() else {
                    continue;
                };
                let mut values = relation_values_from_value(column, &existing)?;
                let mut changed = false;
                for value in &mut values {
                    let old_full = join_collection_value(&relation, value);
                    if let Some(new_full) = file_map.get(&old_full) {
                        *value = value_relative_to_collection(&relation, new_full)?;
                        changed = true;
                    }
                }
                if changed {
                    let mut seen = HashSet::new();
                    values.retain(|value| seen.insert(value.clone()));
                    let next = relation_value_from_values(column, values);
                    if next.is_null()
                        || next
                            .as_sequence()
                            .is_some_and(|sequence| sequence.is_empty())
                    {
                        meta.extra.remove(&column.name);
                    } else {
                        meta.extra.insert(column.name.clone(), next);
                    }
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn write_schema_without_relation_validation(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), AppError> {
    let mut schema = schema.clone();
    normalize_schema(&mut schema);
    validate_schema(&schema)?;
    let dir = collection_dir(space, collection_path);
    fs::create_dir_all(&dir)?;
    let yaml = serde_yml::to_string(&schema)
        .map_err(|e| schema_error(format!("could not serialize schema: {e}")))?;
    fs::write(dir.join(SCHEMA_FILE), yaml)?;
    Ok(())
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("md")
}

fn copy_rel_from_abs(space: &Path, path: &Path) -> String {
    let rel = path
        .strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    if rel.is_empty() { ".".to_string() } else { rel }
}

#[allow(dead_code)]
fn rewrite_relation_collection_paths(
    space: &str,
    old_collection: &str,
    new_collection: &str,
) -> Result<(), AppError> {
    rewrite_relation_collection_paths_for_target_space(space, None, old_collection, new_collection)
}

fn rewrite_relation_collection_paths_for_target_space(
    target_space: &str,
    project_path: Option<&str>,
    old_collection: &str,
    new_collection: &str,
) -> Result<(), AppError> {
    let old_collection = collection_root_for_schema(old_collection);
    let new_collection = collection_root_for_schema(new_collection);
    for source_space in project_relation_scan_spaces(target_space, project_path)? {
        for collection in list_collections(&source_space)? {
            let mut schema = read_schema_or_default(&source_space, &collection.path)?;
            let mut changed = false;
            for column in &mut schema.columns {
                let Some(relation) = relation_column_targets_space(
                    &source_space,
                    project_path,
                    column,
                    target_space,
                )?
                else {
                    continue;
                };
                if relation == old_collection {
                    column.relation = Some(new_collection.clone());
                    changed = true;
                }
            }
            if changed {
                write_schema_with_project(&source_space, &collection.path, &schema, project_path)?;
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn rewrite_relation_value_refs(
    space: &str,
    relation: &str,
    old_value: &str,
    new_value: &str,
) -> Result<(), AppError> {
    rewrite_relation_value_refs_for_target_space(space, None, relation, old_value, new_value)
}

fn rewrite_relation_value_refs_for_target_space(
    target_space: &str,
    project_path: Option<&str>,
    relation: &str,
    old_value: &str,
    new_value: &str,
) -> Result<(), AppError> {
    let relation = normalize_collection_path(relation)?;
    for source_space in project_relation_scan_spaces(target_space, project_path)? {
        for collection in list_collections(&source_space)? {
            let schema = read_schema_or_default(&source_space, &collection.path)?;
            let columns: Vec<Column> = schema
                .columns
                .iter()
                .filter_map(|column| {
                    match relation_column_targets_space(
                        &source_space,
                        project_path,
                        column,
                        target_space,
                    ) {
                        Ok(Some(target_relation)) if target_relation == relation => {
                            Some(Ok(column.clone()))
                        }
                        Ok(_) => None,
                        Err(error) => Some(Err(error)),
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            if columns.is_empty() {
                continue;
            }
            for file in collection_markdown_files(&source_space, &collection.path)? {
                mutate_frontmatter(&file, |meta| {
                    for column in &columns {
                        let Some(existing) = meta.extra.get(&column.name).cloned() else {
                            continue;
                        };
                        let mut values = relation_values_from_value(column, &existing)?;
                        let mut changed = false;
                        for value in &mut values {
                            if value == old_value {
                                *value = new_value.to_string();
                                changed = true;
                            }
                        }
                        if changed {
                            let mut seen = HashSet::new();
                            values.retain(|value| seen.insert(value.clone()));
                            let next = relation_value_from_values(column, values);
                            if next.is_null()
                                || next
                                    .as_sequence()
                                    .is_some_and(|sequence| sequence.is_empty())
                            {
                                meta.extra.remove(&column.name);
                            } else {
                                meta.extra.insert(column.name.clone(), next);
                            }
                        }
                    }
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

pub fn update_relation_entry_field(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    field: &str,
    value: Value,
) -> Result<Option<entry::Entry>, AppError> {
    let Some((schema, collection_root)) = resolve_collection_schema_result(space, file_path)?
    else {
        return Ok(None);
    };
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(None);
    };
    if column.type_ != PropertyType::Relation {
        return Ok(None);
    }

    let source_path = normalize_rel_path(file_path);
    let source_abs = Path::new(space).join(&source_path);
    let relation = column
        .relation
        .as_deref()
        .ok_or_else(|| schema_error(format!("relation column '{field}' requires relation")))?;
    let target_space =
        required_relation_target_space_path(space, project_path, column.relation_scope.as_ref())?;
    let normalized = normalize_relation_update_value(&target_space, column, relation, &value)?;
    let reverse_name = column.two_way.clone();
    let reverse_scope = if reverse_name.is_some() {
        validate_physical_two_way_relation_scope(space, project_path, column)?;
        reverse_relation_scope_for_target(space, project_path, column.relation_scope.as_ref())?
    } else {
        None
    };
    let source_collection = rel_path_string(&collection_root);
    let source_value = value_relative_to_collection(&source_collection, &source_path)?;

    let mut touched = vec![source_abs.clone()];
    if reverse_name.is_some() {
        let old_values = read_relation_field_values_from_file(&source_abs, column)?;
        let new_values = relation_values_from_value(column, &normalized)?;
        for value in old_values.iter().chain(new_values.iter()) {
            touched.push(Path::new(&target_space).join(join_collection_value(relation, value)));
        }
    }

    with_rollback(touched, || {
        let raw = fs::read_to_string(&source_abs)?;
        let Some((mut meta, body)) = frontmatter::try_parse(&raw)? else {
            return Err(AppError::FrontmatterParse(
                "relation fields require frontmatter".to_string(),
            ));
        };
        let old_values =
            relation_values_from_value(column, meta.extra.get(field).unwrap_or(&Value::Null))?;
        let new_values = relation_values_from_value(column, &normalized)?;
        if let Some(reverse_name) = reverse_name.as_deref() {
            sync_reverse_relation_values(
                &target_space,
                relation,
                reverse_name,
                field,
                &source_collection,
                reverse_scope.as_ref(),
                &source_value,
                &old_values,
                &new_values,
            )?;
        }
        if normalized.is_null()
            || normalized
                .as_sequence()
                .is_some_and(|sequence| sequence.is_empty())
        {
            meta.extra.remove(field);
        } else {
            meta.extra.insert(field.to_string(), normalized);
        }
        fs::write(&source_abs, frontmatter::serialize(&meta, &body))?;
        Ok(Some(entry::Entry {
            meta,
            body,
            path: source_path.clone(),
            warnings: Vec::new(),
        }))
    })
}

fn normalize_relation_update_value(
    target_space: &str,
    column: &Column,
    relation: &str,
    value: &Value,
) -> Result<Value, AppError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if column.limit == Some(RelationLimit::One) {
        let raw = value.as_str().ok_or_else(|| {
            schema_error(format!(
                "{} must be a relation path string or null",
                column.name
            ))
        })?;
        return canonicalize_relation_target_value(target_space, relation, raw).map(Value::String);
    }

    let raw_values: Vec<String> = if let Some(raw) = value.as_str() {
        vec![raw.to_string()]
    } else {
        value
            .as_sequence()
            .ok_or_else(|| {
                schema_error(format!(
                    "{} must be a relation path string or array",
                    column.name
                ))
            })?
            .iter()
            .map(|item| {
                item.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                    schema_error(format!("{} must contain only strings", column.name))
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in raw_values {
        let value = canonicalize_relation_target_value(target_space, relation, &raw)?;
        if seen.insert(value.clone()) {
            normalized.push(Value::String(value));
        }
    }
    Ok(Value::Sequence(normalized))
}

fn read_relation_field_values_from_file(
    path: &Path,
    column: &Column,
) -> Result<Vec<String>, AppError> {
    let raw = fs::read_to_string(path)?;
    let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
        return Ok(Vec::new());
    };
    relation_values_from_value(column, meta.extra.get(&column.name).unwrap_or(&Value::Null))
}

fn relation_values_from_value(column: &Column, value: &Value) -> Result<Vec<String>, AppError> {
    validate_relation_value_shape(column, value)
}

fn sync_reverse_relation_values(
    space: &str,
    target_collection: &str,
    reverse_name: &str,
    source_column_name: &str,
    source_collection: &str,
    expected_reverse_scope: Option<&RelationScope>,
    source_value: &str,
    old_values: &[String],
    new_values: &[String],
) -> Result<(), AppError> {
    sync_reverse_relation_values_with_limit_policy(
        space,
        target_collection,
        reverse_name,
        source_column_name,
        source_collection,
        expected_reverse_scope,
        source_value,
        old_values,
        new_values,
        true,
    )
}

fn sync_reverse_relation_values_with_limit_policy(
    space: &str,
    target_collection: &str,
    reverse_name: &str,
    source_column_name: &str,
    source_collection: &str,
    expected_reverse_scope: Option<&RelationScope>,
    source_value: &str,
    old_values: &[String],
    new_values: &[String],
    allow_limit_one_reverse: bool,
) -> Result<(), AppError> {
    let old: HashSet<&str> = old_values.iter().map(String::as_str).collect();
    let new: HashSet<&str> = new_values.iter().map(String::as_str).collect();
    for removed in old.difference(&new) {
        let target_path = join_collection_value(target_collection, removed);
        mutate_relation_reverse_file_with_limit_policy(
            space,
            &target_path,
            reverse_name,
            source_column_name,
            source_collection,
            expected_reverse_scope,
            source_value,
            false,
            allow_limit_one_reverse,
        )?;
    }
    for added in new.difference(&old) {
        let target_path = join_collection_value(target_collection, added);
        mutate_relation_reverse_file_with_limit_policy(
            space,
            &target_path,
            reverse_name,
            source_column_name,
            source_collection,
            expected_reverse_scope,
            source_value,
            true,
            allow_limit_one_reverse,
        )?;
    }
    Ok(())
}

fn mutate_relation_reverse_file_with_limit_policy(
    space: &str,
    target_path: &str,
    reverse_name: &str,
    source_column_name: &str,
    source_collection: &str,
    expected_reverse_scope: Option<&RelationScope>,
    source_value: &str,
    add: bool,
    allow_limit_one_reverse: bool,
) -> Result<(), AppError> {
    let target_abs = Path::new(space).join(target_path);
    if !target_abs.is_file() {
        return Ok(());
    }
    let Some((target_schema, _)) = resolve_collection_schema_result(space, target_path)? else {
        return Ok(());
    };
    let Some(reverse_column) = target_schema
        .columns
        .iter()
        .find(|column| column.name == reverse_name && column.type_ == PropertyType::Relation)
    else {
        return Ok(());
    };
    ensure_compatible_reverse_with_scope(
        reverse_column,
        source_collection,
        expected_reverse_scope,
        source_column_name,
        allow_limit_one_reverse,
    )?;
    mutate_frontmatter(&target_abs, |meta| {
        let mut values = relation_values_from_value(
            reverse_column,
            meta.extra.get(reverse_name).unwrap_or(&Value::Null),
        )?;
        if add {
            if reverse_column.limit == Some(RelationLimit::One)
                && values.iter().any(|value| value != source_value)
            {
                return Err(schema_error(format!(
                    "relation column '{}' cannot contain multiple reverse values",
                    reverse_column.name
                )));
            }
            if !values.iter().any(|value| value == source_value) {
                values.push(source_value.to_string());
            }
        } else {
            values.retain(|value| value != source_value);
        }
        let next = relation_value_from_values(reverse_column, values);
        if next.is_null()
            || next
                .as_sequence()
                .is_some_and(|sequence| sequence.is_empty())
        {
            meta.extra.remove(reverse_name);
        } else {
            meta.extra.insert(reverse_name.to_string(), next);
        }
        Ok(())
    })?;
    Ok(())
}

fn relation_value_from_values(column: &Column, values: Vec<String>) -> Value {
    if column.limit == Some(RelationLimit::One) {
        values
            .into_iter()
            .next()
            .map(Value::String)
            .unwrap_or(Value::Null)
    } else {
        Value::Sequence(values.into_iter().map(Value::String).collect())
    }
}

pub fn validate_property_value(column: &Column, value: &Value) -> Result<(), AppError> {
    if value.is_null() {
        return Ok(());
    }

    match column.type_ {
        PropertyType::Text => expect_string_value(&column.name, value).map(|_| ()),
        PropertyType::Number => {
            if value.as_f64().is_some() {
                Ok(())
            } else {
                Err(schema_error(format!("{} must be a number", column.name)))
            }
        }
        PropertyType::UniqueId => {
            if unique_id_value(value).is_some() {
                Ok(())
            } else {
                Err(schema_error(format!(
                    "{} must be a positive integer",
                    column.name
                )))
            }
        }
        PropertyType::Select | PropertyType::Status => {
            let value = expect_string_value(&column.name, value)?;
            if option_names(column).contains(value) {
                Ok(())
            } else {
                Err(schema_error(format!(
                    "{} value '{}' is not declared in options",
                    column.name, value
                )))
            }
        }
        PropertyType::MultiSelect => {
            let allowed = option_names(column);
            let values = value.as_sequence().ok_or_else(|| {
                schema_error(format!("{} must be an array of option names", column.name))
            })?;
            for item in values {
                let item = expect_string_value(&column.name, item)?;
                if !allowed.contains(item) {
                    return Err(schema_error(format!(
                        "{} value '{}' is not declared in options",
                        column.name, item
                    )));
                }
            }
            Ok(())
        }
        PropertyType::Date => validate_date_value(&column.name, value),
        PropertyType::Actor => validate_actor_value_shape(column, value),
        PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
            expect_string_value(&column.name, value).map(|_| ())
        }
        PropertyType::Relation => validate_relation_value_shape(column, value).map(|_| ()),
        PropertyType::Checkbox => {
            if value.as_bool().is_some() {
                Ok(())
            } else {
                Err(schema_error(format!("{} must be a boolean", column.name)))
            }
        }
    }
}

fn expect_string_value<'a>(field: &str, value: &'a Value) -> Result<&'a str, AppError> {
    value
        .as_str()
        .ok_or_else(|| schema_error(format!("{field} must be a string")))
}

fn validate_actor_value_shape(column: &Column, value: &Value) -> Result<(), AppError> {
    if actor_multiple(column) {
        let values = value.as_sequence().ok_or_else(|| {
            schema_error(format!("{} must be an array of actor emails", column.name))
        })?;
        for item in values {
            expect_string_value(&column.name, item)?;
        }
        Ok(())
    } else {
        expect_string_value(&column.name, value).map(|_| ())
    }
}

fn validate_relation_column_name(name: &str) -> Result<(), AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(schema_error("two_way column name cannot be empty"));
    }
    if RESERVED_FIELDS.contains(&trimmed) {
        return Err(schema_error(format!(
            "two_way column name '{trimmed}' is reserved"
        )));
    }
    Ok(())
}

fn validate_relation_path_shape(path: &str) -> Result<(), AppError> {
    normalize_repo_relative(path, RootMode::Allow)
        .map(|_| ())
        .map_err(|e| schema_error(e.to_string()))
}

fn validate_relation_value_shape(column: &Column, value: &Value) -> Result<Vec<String>, AppError> {
    if value.is_null() {
        return Ok(Vec::new());
    }

    if column.limit == Some(RelationLimit::One) {
        let raw = value.as_str().ok_or_else(|| {
            schema_error(format!(
                "{} must be a relation path string or null",
                column.name
            ))
        })?;
        return Ok(vec![normalize_relation_value_shape(raw)?]);
    }

    if let Some(raw) = value.as_str() {
        return Ok(vec![normalize_relation_value_shape(raw)?]);
    }

    let sequence = value.as_sequence().ok_or_else(|| {
        schema_error(format!(
            "{} must be an array of relation path strings",
            column.name
        ))
    })?;
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for item in sequence {
        let raw = item.as_str().ok_or_else(|| {
            schema_error(format!(
                "{} must contain only relation path strings",
                column.name
            ))
        })?;
        let normalized = normalize_relation_value_shape(raw)?;
        if seen.insert(normalized.clone()) {
            values.push(normalized);
        }
    }
    Ok(values)
}

fn enforce_relation_limit_one_existing_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation || column.limit != Some(RelationLimit::One) {
        return Ok(());
    }
    let mut many_column = column.clone();
    many_column.limit = None;
    for file in collection_markdown_files(space, collection_path)? {
        mutate_frontmatter(&file, |meta| {
            let existing = meta.extra.get(&column.name).cloned().unwrap_or(Value::Null);
            let values = relation_values_from_value(&many_column, &existing)?;
            if values.len() > 1 {
                let rel = file
                    .strip_prefix(space)
                    .unwrap_or(&file)
                    .to_string_lossy()
                    .replace('\\', "/");
                return Err(schema_error(format!(
                    "relation column '{}' cannot be limited to one item while '{}' has {} values",
                    column.name,
                    rel,
                    values.len()
                )));
            }
            let next = relation_value_from_values(column, values);
            if next.is_null() {
                meta.extra.remove(&column.name);
            } else {
                meta.extra.insert(column.name.clone(), next);
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn normalize_relation_value_shape(raw: &str) -> Result<String, AppError> {
    normalize_repo_relative(raw, RootMode::Reject).map_err(|e| schema_error(e.to_string()))
}

fn option_names(column: &Column) -> HashSet<&str> {
    column
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|option| option.name.as_str())
        .collect()
}

fn validate_date_value(field: &str, value: &Value) -> Result<(), AppError> {
    if let Some(raw) = value.as_str() {
        parse_date_cell(raw)
            .ok_or_else(|| schema_error(format!("{field} must be an ISO date or datetime")))?;
        return Ok(());
    }

    let Some(mapping) = value.as_mapping() else {
        return Err(schema_error(format!(
            "{field} must be an ISO scalar or {{start, end}} object"
        )));
    };

    let start = mapping
        .get("start")
        .and_then(Value::as_str)
        .ok_or_else(|| schema_error(format!("{field}.start must be an ISO date or datetime")))?;
    let end = mapping
        .get("end")
        .and_then(Value::as_str)
        .ok_or_else(|| schema_error(format!("{field}.end must be an ISO date or datetime")))?;
    let start_has_time = parse_date_cell(start)
        .ok_or_else(|| schema_error(format!("{field}.start must be an ISO date or datetime")))?;
    let end_has_time = parse_date_cell(end)
        .ok_or_else(|| schema_error(format!("{field}.end must be an ISO date or datetime")))?;

    if start_has_time != end_has_time {
        return Err(schema_error(format!(
            "{field} range must not mix date-only and datetime values"
        )));
    }
    Ok(())
}

fn parse_date_cell(raw: &str) -> Option<bool> {
    if NaiveDate::parse_from_str(raw, "%Y-%m-%d").is_ok() {
        return Some(false);
    }

    let has_tz = raw.ends_with('Z')
        || raw
            .rfind(['+', '-'])
            .is_some_and(|idx| idx > raw.find('T').unwrap_or(raw.len()));
    if has_tz {
        return None;
    }

    for fmt in [
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if NaiveDateTime::parse_from_str(raw, fmt).is_ok() {
            return Some(true);
        }
    }

    None
}

fn today_macro_offset(raw: &str) -> Result<Option<i64>, AppError> {
    let Some(rest) = raw.strip_prefix("@today") else {
        return Ok(None);
    };
    if rest.is_empty() {
        return Ok(Some(0));
    }

    let (sign, digits) = rest.split_at(1);
    if digits.is_empty() || !matches!(sign, "+" | "-") {
        return Err(schema_error(format!("invalid @today macro '{raw}'")));
    }

    let offset = digits
        .parse::<i64>()
        .map_err(|_| schema_error(format!("invalid @today macro '{raw}'")))?;
    Ok(Some(if sign == "-" { -offset } else { offset }))
}

fn resolve_today_macro(raw: &str) -> Result<Option<String>, AppError> {
    let Some(offset) = today_macro_offset(raw)? else {
        return Ok(None);
    };
    Ok(Some(
        (Local::now().date_naive() + Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string(),
    ))
}

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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RelationEdge {
    source_value: String,
    target_value: String,
}

async fn resolve_query_filters(
    git_cli: Option<&GitCli>,
    space_path: &Path,
    schema: &CollectionSchema,
    filters: &[Filter],
) -> Result<Vec<Filter>, AppError> {
    let me_email = if query_filters_need_me(schema, filters)? {
        Some(resolve_current_actor_email(git_cli, space_path).await?)
    } else {
        None
    };

    let mut resolved = Vec::with_capacity(filters.len());
    for filter in filters {
        let ty = field_type(schema, &filter.field, FieldContext::Filter)?;
        let mut filter = filter.clone();
        if let Some(value) = filter.value.as_mut() {
            resolve_filter_macro_container(ty, value, me_email.as_deref())?;
        }
        if let Some(values) = filter.values.as_mut() {
            for value in values {
                resolve_filter_macro_container(ty, value, me_email.as_deref())?;
            }
        }
        normalize_filter_values_for_query(schema, &mut filter)?;
        resolved.push(filter);
    }
    Ok(resolved)
}

fn normalize_filter_values_for_query(
    schema: &CollectionSchema,
    filter: &mut Filter,
) -> Result<(), AppError> {
    let ty = field_type(schema, &filter.field, FieldContext::Filter)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == filter.field);
    if let Some(value) = filter.value.as_mut() {
        normalize_filter_value_for_query(column, ty, value)?;
    }
    if let Some(values) = filter.values.as_mut() {
        for value in values {
            normalize_filter_value_for_query(column, ty, value)?;
        }
    }
    Ok(())
}

fn normalize_filter_value_for_query(
    column: Option<&Column>,
    ty: FieldType,
    value: &mut Value,
) -> Result<(), AppError> {
    match ty {
        FieldType::UniqueId => {
            let column = column.ok_or_else(|| schema_error("unique_id field not found"))?;
            *value = yaml_u64(parse_unique_id_filter_value(column, value)?);
        }
        FieldType::Actor | FieldType::ActorMulti => {
            if let Some(raw) = value.as_str() {
                *value = Value::String(canonical_actor_email(raw));
            }
        }
        _ => {}
    }
    Ok(())
}

fn query_filters_need_me(schema: &CollectionSchema, filters: &[Filter]) -> Result<bool, AppError> {
    for filter in filters {
        if !matches!(
            field_type(schema, &filter.field, FieldContext::Filter)?,
            FieldType::Actor | FieldType::ActorMulti
        ) {
            continue;
        }
        if filter_value_refs(filter)
            .into_iter()
            .any(|value| value.as_str() == Some("@me"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn filter_value_refs(filter: &Filter) -> Vec<&Value> {
    let mut values = Vec::new();
    if let Some(value) = filter.value.as_ref() {
        collect_filter_value_refs(value, &mut values);
    }
    if let Some(items) = filter.values.as_ref() {
        for value in items {
            collect_filter_value_refs(value, &mut values);
        }
    }
    values
}

fn collect_filter_value_refs<'a>(value: &'a Value, values: &mut Vec<&'a Value>) {
    if let Some(sequence) = value.as_sequence() {
        values.extend(sequence);
    } else {
        values.push(value);
    }
}

async fn resolve_current_actor_email(
    git_cli: Option<&GitCli>,
    space_path: &Path,
) -> Result<String, AppError> {
    let cli = git_cli.ok_or_else(|| schema_error("@me requires Git to be available"))?;
    let (name, email) = current_git_actor(cli, space_path)
        .await?
        .ok_or_else(|| schema_error("@me requires git user.email"))?;
    canonicalize_actor(cli, space_path, &name, &email).await
}

fn resolve_filter_macro_value(
    ty: FieldType,
    value: &Value,
    me_email: Option<&str>,
) -> Result<Value, AppError> {
    let Some(raw) = value.as_str() else {
        return Ok(value.clone());
    };
    match ty {
        FieldType::Date => resolve_today_macro(raw)
            .map(|resolved| resolved.map(Value::String).unwrap_or_else(|| value.clone())),
        FieldType::Actor | FieldType::ActorMulti if raw == "@me" => me_email
            .map(|email| Value::String(email.to_string()))
            .ok_or_else(|| schema_error("@me requires git user.email")),
        FieldType::Actor | FieldType::ActorMulti => Ok(Value::String(canonical_actor_email(raw))),
        _ => Ok(value.clone()),
    }
}

fn resolve_filter_macro_container(
    ty: FieldType,
    value: &mut Value,
    me_email: Option<&str>,
) -> Result<(), AppError> {
    if let Value::Sequence(sequence) = value {
        for item in sequence {
            *item = resolve_filter_macro_value(ty, item, me_email)?;
        }
    } else {
        *value = resolve_filter_macro_value(ty, value, me_email)?;
    }
    Ok(())
}

pub async fn list_entries_for_view(
    pool: &SqlitePool,
    git_cli: Option<&GitCli>,
    space: &str,
    collection_path: &str,
    view_name: &str,
    include_nested: Option<bool>,
) -> Result<Vec<entry::Entry>, AppError> {
    let schema = read_schema_at(&collection_dir(space, collection_path).join(SCHEMA_FILE))?;
    let view = schema
        .views
        .iter()
        .find(|view| view.name() == view_name)
        .ok_or_else(|| schema_error(format!("view '{view_name}' not found")))?;
    let include_nested = include_nested.unwrap_or_else(|| match view {
        View::Table { show_nested, .. } => show_nested.unwrap_or(true),
        _ => false,
    });
    let filters = resolve_query_filters(git_cli, Path::new(space), &schema, view.filters()).await?;
    let rows = query_entry_rows(
        pool,
        &schema,
        collection_path,
        &filters,
        view.sorts(),
        None,
        None,
    )
    .await?;
    entries_from_rows(
        space,
        collection_path,
        rows,
        include_nested,
        view.sorts().is_empty(),
    )
}

pub async fn query_entries(
    pool: &SqlitePool,
    git_cli: Option<&GitCli>,
    space: &str,
    collection_path: &str,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    include_nested: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<entry::Entry>, AppError> {
    let schema = read_schema_at(&collection_dir(space, collection_path).join(SCHEMA_FILE))?;
    let filters = filters.unwrap_or_default();
    let sort = sort.unwrap_or_default();
    let include_nested = include_nested.unwrap_or(false);
    validate_ad_hoc_query(&schema, &filters, &sort)?;
    let filters = resolve_query_filters(git_cli, Path::new(space), &schema, &filters).await?;
    let rows = query_entry_rows(
        pool,
        &schema,
        collection_path,
        &filters,
        &sort,
        limit,
        offset,
    )
    .await?;
    entries_from_rows(
        space,
        collection_path,
        rows,
        include_nested,
        sort.is_empty(),
    )
}

pub async fn resolve_relation(
    pool: &SqlitePool,
    relation: &str,
    value: &str,
) -> Result<Option<ResolvedRelation>, AppError> {
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
) -> Result<Vec<Option<ResolvedRelation>>, AppError> {
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
) -> Result<Option<ResolvedRelation>, AppError> {
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

pub fn query_relation_backlinks(
    space: &str,
    target_path: &str,
    source_collection_path: Option<&str>,
    source_column: Option<&str>,
) -> Result<Vec<RelationBacklink>, AppError> {
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
                let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
                    continue;
                };
                let values = relation_values_from_value(
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

#[allow(dead_code)]
pub fn diagnose_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<RelationTwoWayDiagnostics, AppError> {
    diagnose_two_way_relation_with_project(space, collection_path, column_name, None)
}

pub fn diagnose_two_way_relation_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    project_path: Option<&str>,
) -> Result<RelationTwoWayDiagnostics, AppError> {
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
) -> Result<Vec<CompatibleReverseChoice>, AppError> {
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
) -> Result<RelationDriftSummary, AppError> {
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
) -> Result<HashSet<RelationEdge>, AppError> {
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

#[allow(dead_code)]
pub fn relation_repair_mutation_paths(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<Vec<PathBuf>, AppError> {
    relation_repair_mutation_paths_with_project(space, collection_path, column_name, None)
}

pub fn relation_repair_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    paths.push(collection_dir(space, collection_path).join(SCHEMA_FILE));
    paths.extend(collection_markdown_files(space, collection_path)?);
    let schema = read_schema_or_default(space, collection_path)?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name && column.type_ == PropertyType::Relation)
    {
        if let Some((target_space, relation, _)) =
            relation_target_pair(space, project_path, column)?
        {
            paths.push(collection_dir(&target_space, &relation).join(SCHEMA_FILE));
            paths.extend(collection_markdown_files(&target_space, &relation)?);
        }
    }
    dedupe_paths(paths)
}

#[allow(dead_code)]
pub fn repair_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
    strategy: &str,
    reverse_column: Option<&str>,
) -> Result<(), AppError> {
    repair_two_way_relation_with_project(
        space,
        collection_path,
        column_name,
        strategy,
        reverse_column,
        None,
    )
}

pub fn repair_two_way_relation_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    strategy: &str,
    reverse_column: Option<&str>,
    project_path: Option<&str>,
) -> Result<(), AppError> {
    let schema = read_schema_or_default(space, collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name && column.type_ == PropertyType::Relation)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    let reverse_name = column
        .two_way
        .as_deref()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' is not two-way")))?;
    let Some((target_space, relation, _reverse_scope)) =
        relation_target_pair(space, project_path, &column)?
    else {
        return Err(schema_error(format!(
            "relation column '{column_name}' requires relation"
        )));
    };
    let mut touched = Vec::new();
    touched.extend(collection_markdown_files(space, collection_path)?);
    touched.extend(collection_markdown_files(&target_space, &relation)?);
    touched.push(collection_dir(space, collection_path).join(SCHEMA_FILE));
    touched.push(collection_dir(&target_space, &relation).join(SCHEMA_FILE));
    with_rollback(touched, || match strategy {
        "from_this_side" => {
            for file in collection_markdown_files(&target_space, &relation)? {
                mutate_frontmatter(&file, |meta| {
                    meta.extra.remove(reverse_name);
                    Ok(())
                })?;
            }
            materialize_two_way_reverse_values_with_project(
                space,
                project_path,
                collection_path,
                &column,
            )
        }
        "from_related_side" => {
            for file in collection_markdown_files(space, collection_path)? {
                mutate_frontmatter(&file, |meta| {
                    meta.extra.remove(column_name);
                    Ok(())
                })?;
            }
            let reverse_schema = read_schema_or_default(&target_space, &relation)?;
            let reverse = reverse_schema
                .columns
                .iter()
                .find(|candidate| {
                    candidate.name == reverse_name && candidate.type_ == PropertyType::Relation
                })
                .cloned()
                .ok_or_else(|| {
                    schema_error(format!("reverse column '{reverse_name}' not found"))
                })?;
            materialize_two_way_reverse_values_allowing_limit_one_reverse_with_project(
                &target_space,
                project_path,
                &relation,
                &reverse,
            )
        }
        "choose_reverse_column" => {
            let reverse_name = required_reverse_repair_column(reverse_column)?;
            choose_two_way_reverse_column(
                space,
                project_path,
                collection_path,
                column_name,
                reverse_name,
            )
        }
        "create_reverse_column" => {
            let reverse_name = reverse_column.unwrap_or(reverse_name);
            create_two_way_reverse_column(
                space,
                project_path,
                collection_path,
                column_name,
                reverse_name,
            )
        }
        "detach_two_way" => detach_current_two_way_relation(
            space,
            project_path,
            collection_path,
            column_name,
            reverse_column.or(Some(reverse_name)),
        ),
        _ => Err(schema_error(format!(
            "unknown relation repair strategy '{strategy}'"
        ))),
    })
}

fn required_reverse_repair_column<'a>(
    reverse_column: Option<&'a str>,
) -> Result<&'a str, AppError> {
    reverse_column
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| schema_error("reverse column is required for this repair strategy"))
}

fn choose_two_way_reverse_column(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column_name: &str,
    reverse_name: &str,
) -> Result<(), AppError> {
    validate_relation_column_name(reverse_name)?;
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let column_snapshot = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        column.clone()
    };
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, &column_snapshot)?
    else {
        return Err(schema_error(format!(
            "relation column '{column_name}' requires relation"
        )));
    };
    let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
    let reverse = reverse_schema
        .columns
        .iter_mut()
        .find(|candidate| candidate.name == reverse_name)
        .ok_or_else(|| schema_error(format!("reverse column '{reverse_name}' not found")))?;
    ensure_compatible_reverse_with_scope(
        reverse,
        &source_collection,
        reverse_scope.as_ref(),
        column_name,
        false,
    )?;

    find_column_mut(&mut schema, column_name)?.two_way = Some(reverse_name.to_string());
    reverse.two_way = Some(column_name.to_string());
    write_schema_with_project(space, collection_path, &schema, project_path)?;
    write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    materialize_two_way_reverse_values_with_project(space, project_path, collection_path, &column)
}

fn create_two_way_reverse_column(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column_name: &str,
    reverse_name: &str,
) -> Result<(), AppError> {
    validate_relation_column_name(reverse_name)?;
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let column_snapshot = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        column.clone()
    };
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, &column_snapshot)?
    else {
        return Err(schema_error(format!(
            "relation column '{column_name}' requires relation"
        )));
    };
    let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
    if reverse_schema
        .columns
        .iter()
        .any(|candidate| candidate.name == reverse_name)
    {
        return Err(schema_error(format!(
            "reverse column '{reverse_name}' already exists"
        )));
    }

    find_column_mut(&mut schema, column_name)?.two_way = Some(reverse_name.to_string());
    reverse_schema.columns.push(Column {
        name: reverse_name.to_string(),
        type_: PropertyType::Relation,
        sensitivity: None,
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
        relation: Some(source_collection),
        relation_scope: reverse_scope,
        limit: None,
        two_way: Some(column_name.to_string()),
        prefix: None,
        next: None,
        multiple: None,
    });
    write_schema_with_project(space, collection_path, &schema, project_path)?;
    write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    materialize_two_way_reverse_values_with_project(space, project_path, collection_path, &column)
}

fn detach_current_two_way_relation(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column_name: &str,
    reverse_column: Option<&str>,
) -> Result<(), AppError> {
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let (column_snapshot, old_reverse_name) = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        let column_snapshot = column.clone();
        let old_reverse_name = column.two_way.take();
        (column_snapshot, old_reverse_name)
    };
    write_schema_with_project(space, collection_path, &schema, project_path)?;
    let Some((target_space, relation, reverse_scope)) =
        relation_target_pair(space, project_path, &column_snapshot)?
    else {
        return Ok(());
    };

    let reverse_name = reverse_column
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(old_reverse_name);
    if let Some(reverse_name) = reverse_name {
        let mut reverse_schema = read_schema_or_default(&target_space, &relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter_mut()
            .find(|candidate| candidate.name == reverse_name)
        {
            if ensure_compatible_reverse_with_scope(
                reverse,
                &source_collection,
                reverse_scope.as_ref(),
                column_name,
                true,
            )
            .is_ok()
            {
                reverse.two_way = None;
                write_schema_with_project(&target_space, &relation, &reverse_schema, project_path)?;
            }
        }
    }
    Ok(())
}

fn collection_markdown_files(space: &str, collection_path: &str) -> Result<Vec<PathBuf>, AppError> {
    let space_root = Path::new(space);
    let collection_root = collection_rel(collection_path);
    let collection_root_rel = rel_path_string(&collection_root);
    let skip_dirs = child_folder_names(space_root);
    if is_registered_child_space_rel(&collection_root_rel, &skip_dirs) {
        return Ok(Vec::new());
    }

    let root = collection_dir(space, collection_path);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let mut files = Vec::new();
    for file in collect_md_files(space_root, &root, &skip_dirs, &policy)? {
        let rel = file
            .strip_prefix(space)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let belongs = resolve_collection_schema(space, &rel)
            .map(|(_, root)| root == collection_root)
            .unwrap_or(false);
        if belongs {
            files.push(file);
        }
    }
    Ok(files)
}

fn collect_md_files_in_space(space: &Path, root: &Path) -> Result<Vec<PathBuf>, AppError> {
    // Collection-side scans must honor the same scope boundaries as tree/index.
    // Root project collections must not recurse into registered child spaces.
    let root_rel = root
        .strip_prefix(space)
        .map(rel_path_string)
        .unwrap_or_else(|_| rel_path_string(root));
    let skip_dirs = child_folder_names(space);
    if is_registered_child_space_rel(&root_rel, &skip_dirs) {
        return Ok(Vec::new());
    }

    let policy = TreeIgnorePolicy::from_space_root(space);
    collect_md_files(space, root, &skip_dirs, &policy)
}

fn collect_md_files(
    space: &Path,
    root: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    collect_md_files_inner(space, root, skip_dirs, policy, &mut files)?;
    Ok(files)
}

fn collect_md_files_inner(
    space: &Path,
    dir: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
    out: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink()
            || is_collection_traversal_ignored(space, &path, &meta, skip_dirs, policy)
        {
            continue;
        }

        if meta.is_dir() {
            collect_md_files_inner(space, &path, skip_dirs, policy, out)?;
        } else if meta.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn mutate_frontmatter<F>(path: &Path, mut f: F) -> Result<bool, AppError>
where
    F: FnMut(&mut EntryMeta) -> Result<(), AppError>,
{
    let raw = fs::read_to_string(path)?;
    let Some((mut meta, body)) = frontmatter::try_parse(&raw)? else {
        return Ok(false);
    };
    let before = meta.extra.clone();
    f(&mut meta)?;
    if meta.extra != before {
        fs::write(path, frontmatter::serialize(&meta, &body))?;
        return Ok(true);
    }
    Ok(false)
}

fn with_rollback<T, F>(paths: Vec<PathBuf>, f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError>,
{
    let mut seen = HashSet::new();
    let mut snapshots = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let content = if path.exists() {
            Some(fs::read(&path)?)
        } else {
            None
        };
        snapshots.push((path, content));
    }

    match f() {
        Ok(value) => Ok(value),
        Err(error) => {
            for (path, content) in snapshots {
                if let Some(content) = content {
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(path, content);
                } else if path.exists() {
                    let _ = fs::remove_file(path);
                }
            }
            Err(error)
        }
    }
}

fn find_entry_extra_by_path(
    space: &str,
    collection_path: &str,
    file_path: &str,
    field: &str,
) -> Result<Option<Value>, AppError> {
    let target = normalize_rel_path(file_path);
    for file in collection_markdown_files(space, collection_path)? {
        let rel = copy_rel_from_abs(Path::new(space), &file);
        if rel != target {
            continue;
        }
        let raw = fs::read_to_string(&file)?;
        let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
            continue;
        };
        return Ok(meta.extra.get(field).cloned());
    }
    Ok(None)
}

fn infer_column(field: &str, value: &Value) -> Column {
    let mut column = Column {
        name: field.to_string(),
        type_: infer_type(value),
        sensitivity: None,
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
        relation: None,
        relation_scope: None,
        limit: None,
        two_way: None,
        prefix: None,
        next: None,
        multiple: None,
    };

    if column.type_ == PropertyType::MultiSelect {
        if let Some(sequence) = value.as_sequence() {
            let mut seen = HashSet::new();
            let options: Vec<PropertyOption> = sequence
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| seen.insert((*value).to_string()))
                .map(|name| PropertyOption {
                    name: name.to_string(),
                    color: None,
                    icon: None,
                    group: None,
                })
                .collect();
            if !options.is_empty() {
                column.options = Some(options);
            }
        }
    }

    column
}

fn infer_type(value: &Value) -> PropertyType {
    if value.as_bool().is_some() {
        return PropertyType::Checkbox;
    }
    if value.as_f64().is_some() {
        return PropertyType::Number;
    }
    if value
        .as_sequence()
        .is_some_and(|sequence| sequence.iter().all(|item| item.as_str().is_some()))
    {
        return PropertyType::MultiSelect;
    }
    if validate_date_value("value", value).is_ok() {
        return PropertyType::Date;
    }
    if let Some(value) = value.as_str() {
        let lower = value.to_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return PropertyType::Url;
        }
        if value.contains('@') {
            return PropertyType::Email;
        }
        if value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' ' | '(' | ')'))
            && value.chars().any(|c| c.is_ascii_digit())
        {
            return PropertyType::Phone;
        }
    }
    PropertyType::Text
}

#[cfg(test)]
mod tests;
