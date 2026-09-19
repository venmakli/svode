//! Collection field, relation, schema, view and integrity rules with their
//! source persistence. Transport adapters only map requests, access and effects.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Duration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_yml::{Mapping, Value};

use super::CollectionError;
use crate::collections::relation_read::collection_root_for_fs;
use crate::collections::relation_read::ensure_compatible_reverse_with_scope;
use crate::collections::relation_read::join_collection_value;
use crate::collections::relation_read::normalize_collection_path;
use crate::collections::relation_read::normalize_relation_value_shape;
use crate::collections::relation_read::project_relation_scan_spaces;
use crate::collections::relation_read::read_relation_field_values_from_file;
use crate::collections::relation_read::read_schema_or_default;
use crate::collections::relation_read::relation_is_current_scope;
use crate::collections::relation_read::relation_target_pair;
use crate::collections::relation_read::relation_target_space_path;
use crate::collections::relation_read::required_relation_target_space_path;
use crate::collections::relation_read::reverse_relation_scope_for_target;
use crate::collections::relation_read::same_fs_path;
use crate::collections::relation_read::space_scope_from_project;
use crate::collections::relation_read::validate_relation_value_shape;
use crate::collections::relation_read::value_relative_to_collection;
use crate::collections::schema::find_collection_root;
use crate::collections::schema::normalize_rel_path;
use crate::collections::schema::read_schema_at;
use crate::collections::traversal::collect_md_files_in_space;
use crate::collections::traversal::collection_markdown_files;
use crate::content_tree::child_folder_names;
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::page::ColorName;
use crate::page::frontmatter::{self, EntryMeta};

const SCHEMA_FILE: &str = "schema.yaml";
const RESERVED_FIELDS: &[&str] = &[
    "title",
    "icon",
    "description",
    "cover",
    "created",
    "updated",
];

pub use super::model::*;
pub use super::relation_read::{
    CompatibleReverseChoice, RelationBacklink, RelationDriftKind, RelationDriftRow,
    RelationDriftSummary, RelationTwoWayDiagnostics, RelationTwoWaySchemaStatus, ResolvedRelation,
    diagnose_two_way_relation, diagnose_two_way_relation_with_project, query_relation_backlinks,
    resolve_relation, resolve_relations_batch,
};

mod actor_values;
use actor_values::{actor_multiple, canonical_actor_email, is_actor_type, normalize_actor_value};

mod defaults;
pub use defaults::{
    apply_contextual_defaults_for_path, apply_contextual_defaults_for_path_strict,
    apply_schema_defaults_for_path, apply_schema_defaults_to_entry_tree, assign_unique_id,
    assign_unique_id_to_meta_for_path, assign_unique_ids_to_entry_tree,
    normalize_unique_id_counter, unique_id_mutation_paths_for_entry,
    unique_id_mutation_paths_for_entry_tree, unique_id_schema_path_for_entry,
};
use defaults::{dedupe_paths, materialize_unique_id_column};

mod integrity;
pub use integrity::{
    CollectionInfo, CollectionIntegrityIssue, CollectionIntegrityReport,
    CollectionIntegritySeverity, list_collections, validate_collection_integrity_with_project,
};

mod mutations;
pub use mutations::*;

mod query_filters;
pub use query_filters::resolve_query_filters;

mod field_rules;
use field_rules::{
    FieldContext, FieldType, autopick_board_group_by, autopick_calendar_date_field, field_type,
    normalize_property_value_for_write, normalize_view,
};
pub use field_rules::{
    ensure_entry_field_writable, normalize_entry_field_value, normalize_schema,
    validate_entry_field_value, validate_schema,
};

mod schema_mutations;
pub use schema_mutations::{
    SchemaMutationWarning, add_option, add_schema_column, add_schema_column_with_project, add_view,
    change_schema_type, change_schema_type_with_warnings,
    change_schema_type_with_warnings_and_project, clear_field_values, clear_option_values,
    default_collection_schema, delete_option, delete_schema_column,
    delete_schema_column_with_project, delete_view, duplicate_view, promote_orphan, rename_option,
    rename_schema_column, rename_schema_column_with_project, rename_view, reorder_templates,
    reorder_views, replace_option_values, set_default_template, update_option,
    update_schema_column, update_schema_column_with_project, update_system_field_label,
    update_view, write_default_collection_schema,
};
use schema_mutations::{find_column_mut, strip_string_refs_in_views};

mod templates;
pub use templates::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySchemaResponse {
    pub schema: CollectionSchema,
    pub collection_root_path: String,
}

fn schema_error(message: impl Into<String>) -> CollectionError {
    CollectionError::Schema(message.into())
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

fn parse_unique_id_filter_value(column: &Column, value: &Value) -> Result<u64, CollectionError> {
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

pub fn resolve_collection_schema_result(
    space: &str,
    file_path: &str,
) -> Result<Option<(CollectionSchema, PathBuf)>, CollectionError> {
    crate::collections::schema::resolve_collection_schema_result(Path::new(space), file_path)
}

pub fn schema_response(
    space: &str,
    file_path: &str,
) -> Result<Option<EntrySchemaResponse>, CollectionError> {
    Ok(
        resolve_collection_schema_result(space, file_path)?.map(|(schema, root)| {
            EntrySchemaResponse {
                schema,
                collection_root_path: rel_path_string(&root),
            }
        }),
    )
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

fn normalize_relation_scope(
    scope: Option<RelationScope>,
) -> Result<Option<RelationScope>, CollectionError> {
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

fn validate_physical_two_way_relation_scope(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
) -> Result<(), CollectionError> {
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

fn relation_column_targets_space(
    source_space: &str,
    project_path: Option<&str>,
    column: &Column,
    target_space: &str,
) -> Result<Option<String>, CollectionError> {
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

fn canonicalize_relation_target_value(
    target_space: &str,
    relation: &str,
    raw_value: &str,
) -> Result<String, CollectionError> {
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
        return Err(CollectionError::FileNotFound(target_rel));
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
) -> Result<(), CollectionError> {
    ensure_compatible_reverse_with_scope(reverse, current_collection, None, current_column, false)
}

#[allow(dead_code)]
fn ensure_compatible_reverse_with_limit_policy(
    reverse: &Column,
    current_collection: &str,
    current_column: &str,
    allow_limit_one: bool,
) -> Result<(), CollectionError> {
    ensure_compatible_reverse_with_scope(
        reverse,
        current_collection,
        None,
        current_column,
        allow_limit_one,
    )
}

pub fn read_collection_schema(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, CollectionError> {
    read_schema_at(&collection_dir(space, collection_path).join(SCHEMA_FILE))
}

fn write_schema(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), CollectionError> {
    write_schema_with_project(space, collection_path, schema, None)
}

fn write_schema_with_project(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
    project_path: Option<&str>,
) -> Result<(), CollectionError> {
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

#[cfg(test)]
pub fn write_collection_schema(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), CollectionError> {
    write_schema(space, collection_path, schema)
}

fn validate_schema_relations_in_space(
    space: &str,
    project_path: Option<&str>,
    _collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
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

pub fn schema_type_target_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<&Value>,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, CollectionError> {
    if new_type != PropertyType::Relation {
        return Ok(Vec::new());
    }
    let schema = read_schema_or_default(space, collection_path)?;
    let Some(mut column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
    else {
        return Ok(Vec::new());
    };
    column.type_ = PropertyType::Relation;
    if let Some(strategy) = conversion_strategy {
        if let Some(relation) = strategy.get("relation") {
            column.relation = relation.as_str().map(ToOwned::to_owned);
        }
        if let Some(scope) = strategy.get("relation_scope") {
            column.relation_scope =
                if scope.is_null() {
                    None
                } else {
                    Some(serde_yml::from_value(scope.clone()).map_err(|error| {
                        schema_error(format!("invalid relation_scope: {error}"))
                    })?)
                };
        }
        if let Some(two_way) = strategy.get("two_way") {
            column.two_way = two_way.as_str().map(ToOwned::to_owned);
        }
    }
    let mut paths = Vec::new();
    extend_relation_side_effect_paths(space, project_path, collection_path, &column, &mut paths)?;
    dedupe_paths(paths)
}

pub fn schema_column_patch_target_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: &Value,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, CollectionError> {
    let schema = read_schema_or_default(space, collection_path)?;
    let Some(mut column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
    else {
        return Ok(Vec::new());
    };
    if let Some(relation) = patch.get("relation") {
        column.relation = relation.as_str().map(ToOwned::to_owned);
    }
    if let Some(scope) = patch.get("relation_scope") {
        column.relation_scope = if scope.is_null() {
            None
        } else {
            Some(
                serde_yml::from_value(scope.clone())
                    .map_err(|error| schema_error(format!("invalid relation_scope: {error}")))?,
            )
        };
    }
    if let Some(two_way) = patch.get("two_way") {
        column.two_way = two_way.as_str().map(ToOwned::to_owned);
    }
    let mut paths = Vec::new();
    extend_relation_side_effect_paths(space, project_path, collection_path, &column, &mut paths)?;
    dedupe_paths(paths)
}

fn extend_relation_side_effect_paths(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
    paths: &mut Vec<PathBuf>,
) -> Result<(), CollectionError> {
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

fn normalize_column_relation_paths(column: &mut Column) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    ensure_two_way_schema_and_values_with_project(space, collection_path, column, None)
}

fn ensure_two_way_schema_and_values_with_project(
    space: &str,
    collection_path: &str,
    column: &Column,
    project_path: Option<&str>,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    materialize_two_way_reverse_values_with_project(space, None, collection_path, column)
}

fn materialize_two_way_reverse_values_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    materialize_two_way_reverse_values_with_limit_policy(space, None, collection_path, column, true)
}

fn materialize_two_way_reverse_values_allowing_limit_one_reverse_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    column: &Column,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    update_reverse_pair_name_with_project(space, None, collection_path, old_column, new_name)
}

fn update_reverse_pair_name_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    old_column: &Column,
    new_name: &str,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    detach_two_way_relation_with_project(space, None, column, delete_reverse_column)
}

fn detach_two_way_relation_with_project(
    space: &str,
    project_path: Option<&str>,
    column: &Column,
    delete_reverse_column: bool,
) -> Result<(), CollectionError> {
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
) -> Result<Vec<PathBuf>, CollectionError> {
    cascade_clean_deleted_entries_with_project(space, None, deleted_paths)
}

pub fn cascade_clean_deleted_entries_with_project(
    space: &str,
    project_path: Option<&str>,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, CollectionError> {
    if deleted_paths.is_empty() {
        return Ok(Vec::new());
    }
    let touched = cascade_clean_deleted_entries_mutation_paths_with_project(
        space,
        project_path,
        deleted_paths,
    )?;
    let scan_spaces = project_relation_scan_spaces(space, project_path)?;
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

pub fn cascade_clean_deleted_entries_mutation_paths_with_project(
    space: &str,
    project_path: Option<&str>,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, CollectionError> {
    if deleted_paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for source_space in project_relation_scan_spaces(space, project_path)? {
        for collection in list_collections(&source_space)? {
            let schema = read_schema_or_default(&source_space, &collection.path)?;
            let relation_columns = schema
                .columns
                .iter()
                .filter_map(|column| {
                    relation_column_targets_space(&source_space, project_path, column, space)
                        .transpose()
                        .map(|relation| relation.map(|relation| (column, relation)))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if relation_columns.is_empty() {
                continue;
            }
            for file in collection_markdown_files(&source_space, &collection.path)? {
                let raw = fs::read_to_string(&file)?;
                let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
                    continue;
                };
                let mut changes = false;
                for (column, relation) in &relation_columns {
                    let deleted_values = deleted_paths
                        .iter()
                        .filter_map(|path| value_relative_to_collection(relation, path).ok())
                        .collect::<HashSet<_>>();
                    let Some(existing) = meta.extra.get(&column.name) else {
                        continue;
                    };
                    let values = relation_values_from_value(column, existing)?;
                    if values.iter().any(|value| deleted_values.contains(value)) {
                        changes = true;
                        break;
                    }
                }
                if changes {
                    paths.push(file);
                }
            }
        }
    }
    dedupe_paths(paths)
}

#[allow(dead_code)]
fn cascade_clean_deleted_entries_current_scope(
    space: &str,
    deleted_paths: &[String],
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<(), CollectionError> {
    rewrite_relation_paths_for_move_with_project(space, None, old_path, new_path)
}

pub fn rewrite_relation_paths_for_move_with_project(
    space: &str,
    project_path: Option<&str>,
    old_path: &str,
    new_path: &str,
) -> Result<(), CollectionError> {
    rewrite_relation_paths_for_move_with_project_plan(space, project_path, old_path, new_path, None)
}

pub fn rewrite_relation_paths_for_move_with_authorized_plan(
    space: &str,
    project_path: Option<&str>,
    old_path: &str,
    new_path: &str,
    authorized_paths: &[PathBuf],
) -> Result<(), CollectionError> {
    rewrite_relation_paths_for_move_with_project_plan(
        space,
        project_path,
        old_path,
        new_path,
        Some(authorized_paths),
    )
}

fn rewrite_relation_paths_for_move_with_project_plan(
    space: &str,
    project_path: Option<&str>,
    old_path: &str,
    new_path: &str,
    authorized_paths: Option<&[PathBuf]>,
) -> Result<(), CollectionError> {
    let old_path = normalize_rel_path(old_path);
    let new_path = normalize_rel_path(new_path);
    if old_path == new_path {
        return Ok(());
    }

    if !relation_move_may_affect_collections(Path::new(space), &old_path, &new_path)? {
        if authorized_paths.is_some_and(|paths| !paths.is_empty()) {
            return Err(CollectionError::General(
                "relation mutation plan changed before execution".to_string(),
            ));
        }
        return Ok(());
    }

    let space_path = Path::new(space);
    let new_abs = space_path.join(&new_path);
    let collection_rename = new_abs.is_dir() && new_abs.join(SCHEMA_FILE).is_file();
    let old_collection_path = old_path.clone();
    let new_collection_path = new_path.clone();
    let moved_paths = moved_markdown_path_pairs(space_path, &old_path, &new_path, &new_abs)?;
    let mut touched = relation_move_mutation_paths_from_pairs(
        space,
        project_path,
        &old_path,
        &new_path,
        collection_rename,
        &moved_paths,
    )?;
    if let Some(authorized_paths) = authorized_paths {
        let mut expected = authorized_paths.to_vec();
        expected.sort();
        expected.dedup();
        touched.sort();
        touched.dedup();
        if touched != expected {
            return Err(CollectionError::General(
                "relation mutation plan changed before execution".to_string(),
            ));
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

pub fn relation_move_mutation_paths_with_project(
    space: &str,
    project_path: Option<&str>,
    old_path: &str,
    new_path: &str,
) -> Result<Vec<PathBuf>, CollectionError> {
    let old_path = normalize_rel_path(old_path);
    let new_path = normalize_rel_path(new_path);
    if old_path == new_path {
        return Ok(Vec::new());
    }
    let space_path = Path::new(space);
    if !relation_move_may_affect_collections(space_path, &old_path, &new_path)? {
        return Ok(Vec::new());
    }
    let old_abs = space_path.join(&old_path);
    let collection_rename = old_abs.is_dir() && old_abs.join(SCHEMA_FILE).is_file();
    let moved_paths =
        moved_markdown_path_pairs_before_move(space_path, &old_path, &new_path, &old_abs)?;
    let paths = relation_move_mutation_paths_from_pairs(
        space,
        project_path,
        &old_path,
        &new_path,
        collection_rename,
        &moved_paths,
    )?;
    let new_abs = space_path.join(&new_path);
    dedupe_paths(
        paths
            .into_iter()
            .map(|path| {
                path.strip_prefix(&old_abs)
                    .map(|suffix| new_abs.join(suffix))
                    .unwrap_or(path)
            })
            .collect(),
    )
}

// Check topology on both sides of the move, before or after filesystem rename.
// A README owner or an empty nested collection is still a relation boundary;
// neither schema parsing nor the indexed Markdown inventory can prove a no-op.
fn relation_move_may_affect_collections(
    space: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<bool, CollectionError> {
    let child_spaces = child_folder_names(space);
    for path in [old_path, new_path] {
        let rel = Path::new(path);
        if child_spaces
            .iter()
            .any(|child| rel.starts_with(child) || Path::new(child).starts_with(rel))
        {
            return Ok(true);
        }
        for ancestor in rel.parent().unwrap_or(Path::new("")).ancestors() {
            if space.join(ancestor).join(SCHEMA_FILE).try_exists()? {
                return Ok(true);
            }
        }
        if moved_tree_has_collection_capability(&space.join(rel))? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn moved_tree_has_collection_capability(path: &Path) -> Result<bool, CollectionError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    if !metadata.is_dir() {
        return Ok(false);
    }
    if path.join(SCHEMA_FILE).try_exists()? {
        return Ok(true);
    }
    for child in fs::read_dir(path)? {
        if moved_tree_has_collection_capability(&child?.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn moved_markdown_path_pairs_before_move(
    space: &Path,
    old_path: &str,
    new_path: &str,
    old_abs: &Path,
) -> Result<Vec<(String, String)>, CollectionError> {
    if old_abs.is_dir() {
        let old_prefix = normalize_rel_path(old_path);
        let new_prefix = normalize_rel_path(new_path);
        let mut pairs = Vec::new();
        for file in collect_md_files_in_space(space, old_abs)? {
            let old_file = rel_path_string(file.strip_prefix(space).unwrap_or(&file));
            let suffix = old_file
                .strip_prefix(&format!("{old_prefix}/"))
                .unwrap_or(&old_file)
                .to_string();
            pairs.push((old_file, format!("{new_prefix}/{suffix}")));
        }
        return Ok(pairs);
    }
    if old_abs.extension().and_then(|extension| extension.to_str()) == Some("md") {
        return Ok(vec![(old_path.to_string(), new_path.to_string())]);
    }
    Ok(Vec::new())
}

fn relation_move_mutation_paths_from_pairs(
    target_space: &str,
    project_path: Option<&str>,
    old_path: &str,
    _new_path: &str,
    collection_rename: bool,
    moved_paths: &[(String, String)],
) -> Result<Vec<PathBuf>, CollectionError> {
    let old_collection = normalize_collection_path(old_path).unwrap_or_else(|_| old_path.into());
    let mut paths = Vec::new();
    for source_space in project_relation_scan_spaces(target_space, project_path)? {
        for collection in list_collections(&source_space)? {
            let schema = read_schema_or_default(&source_space, &collection.path)?;
            let relation_columns = schema
                .columns
                .iter()
                .filter_map(|column| {
                    relation_column_targets_space(&source_space, project_path, column, target_space)
                        .transpose()
                        .map(|relation| relation.map(|relation| (column, relation)))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if collection_rename
                && relation_columns
                    .iter()
                    .any(|(_, relation)| relation == &old_collection)
            {
                paths.push(collection_dir(&source_space, &collection.path).join(SCHEMA_FILE));
            }
            if relation_columns.is_empty() || moved_paths.is_empty() {
                continue;
            }
            for file in collection_markdown_files(&source_space, &collection.path)? {
                let raw = fs::read_to_string(&file)?;
                let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
                    continue;
                };
                let changes = relation_columns.iter().any(|(column, relation)| {
                    let Some(existing) = meta.extra.get(&column.name) else {
                        return false;
                    };
                    let Ok(values) = relation_values_from_value(column, existing) else {
                        return false;
                    };
                    moved_paths.iter().any(|(old_file, _)| {
                        value_relative_to_collection(relation, old_file)
                            .is_ok_and(|old_value| values.iter().any(|value| value == &old_value))
                    })
                });
                if changes {
                    paths.push(file);
                }
            }
        }
    }
    dedupe_paths(paths)
}

fn moved_markdown_path_pairs(
    space: &Path,
    old_path: &str,
    new_path: &str,
    new_abs: &Path,
) -> Result<Vec<(String, String)>, CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<Vec<String>, CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    rewrite_relation_collection_paths_for_target_space(space, None, old_collection, new_collection)
}

fn rewrite_relation_collection_paths_for_target_space(
    target_space: &str,
    project_path: Option<&str>,
    old_collection: &str,
    new_collection: &str,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    rewrite_relation_value_refs_for_target_space(space, None, relation, old_value, new_value)
}

fn rewrite_relation_value_refs_for_target_space(
    target_space: &str,
    project_path: Option<&str>,
    relation: &str,
    old_value: &str,
    new_value: &str,
) -> Result<(), CollectionError> {
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

/// Writes one relation field and its two-way reverse values as a single
/// rollback scope. Returns `None` when the field is not a schema relation.
pub fn update_relation_entry_field(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    field: &str,
    value: Value,
) -> Result<Option<(EntryMeta, String)>, CollectionError> {
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
            return Err(CollectionError::FrontmatterParse(
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
        Ok(Some((meta, body)))
    })
}

#[derive(Clone, Copy)]
pub enum EntryFieldBatchIntent {
    Literal,
    Routine,
}

struct PreparedRelationFieldUpdate {
    target_space: String,
    relation: String,
    reverse_name: String,
    source_column_name: String,
    source_collection: String,
    reverse_scope: Option<RelationScope>,
    source_value: String,
    old_values: Vec<String>,
    new_values: Vec<String>,
}

struct PreparedRelationField {
    normalized: Value,
    reverse_update: Option<PreparedRelationFieldUpdate>,
    mutation_paths: Vec<PathBuf>,
}

pub struct PreparedEntryFieldBatch {
    metadata: EntryMeta,
    title: Option<String>,
    relation_updates: Vec<PreparedRelationFieldUpdate>,
    mutation_paths: Vec<PathBuf>,
}

impl PreparedEntryFieldBatch {
    pub fn into_metadata(self) -> EntryMeta {
        self.metadata
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn mutation_paths(&self) -> &[PathBuf] {
        &self.mutation_paths
    }
}

pub fn prepare_entry_field_batch(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    values: &std::collections::BTreeMap<String, serde_json::Value>,
    intent: EntryFieldBatchIntent,
) -> Result<PreparedEntryFieldBatch, CollectionError> {
    let mut metadata = frontmatter::read_page_meta(Path::new(space), file_path)?;
    let mut title = None;
    let mut relation_updates = Vec::new();
    let mut mutation_paths = vec![Path::new(space).join(normalize_rel_path(file_path))];

    for (field, raw) in values {
        let is_system = matches!(
            field.as_str(),
            "title" | "icon" | "description" | "cover" | "created" | "updated"
        );
        if matches!(intent, EntryFieldBatchIntent::Routine) && is_system {
            return Err(schema_error(format!(
                "routine property batch cannot update system field '{field}'"
            )));
        }
        let value = match intent {
            EntryFieldBatchIntent::Literal => raw.clone(),
            EntryFieldBatchIntent::Routine => resolve_routine_runtime_value(raw),
        };
        if is_system {
            frontmatter::apply_entry_field_update(&mut metadata, field, value)?;
            if field == "title" {
                title = Some(metadata.title.clone());
            }
            continue;
        }

        ensure_entry_field_writable(space, file_path, field)?;
        let yaml_value = serde_yml::to_value(value)
            .map_err(|error| schema_error(format!("{field}: {error}")))?;
        let prepared_relation = prepare_relation_field_update(
            space,
            project_path,
            file_path,
            field,
            &metadata,
            &yaml_value,
        )?;
        let (normalized, relation_update) = match prepared_relation {
            Some(prepared) => {
                mutation_paths.extend(prepared.mutation_paths);
                (prepared.normalized, prepared.reverse_update)
            }
            None => {
                let normalized = normalize_entry_field_value(space, file_path, field, yaml_value)?;
                validate_entry_field_value(space, file_path, field, &normalized)?;
                (normalized, None)
            }
        };
        if normalized.is_null()
            || normalized
                .as_sequence()
                .is_some_and(|sequence| sequence.is_empty())
        {
            metadata.extra.remove(field);
        } else {
            metadata.extra.insert(field.clone(), normalized);
        }
        if let Some(update) = relation_update {
            relation_updates.push(update);
        }
    }

    Ok(PreparedEntryFieldBatch {
        metadata,
        title,
        relation_updates,
        mutation_paths: dedupe_paths(mutation_paths)?,
    })
}

fn prepare_relation_field_update(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    field: &str,
    metadata: &EntryMeta,
    value: &Value,
) -> Result<Option<PreparedRelationField>, CollectionError> {
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
    let relation = column
        .relation
        .as_deref()
        .ok_or_else(|| schema_error(format!("relation column '{field}' requires relation")))?;
    let target_space =
        required_relation_target_space_path(space, project_path, column.relation_scope.as_ref())?;
    let normalized = normalize_relation_update_value(&target_space, column, relation, value)?;
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(Some(PreparedRelationField {
            normalized,
            reverse_update: None,
            mutation_paths: Vec::new(),
        }));
    };
    validate_physical_two_way_relation_scope(space, project_path, column)?;
    let reverse_scope =
        reverse_relation_scope_for_target(space, project_path, column.relation_scope.as_ref())?;
    let source_collection = rel_path_string(&collection_root);
    let source_path = normalize_rel_path(file_path);
    let source_value = value_relative_to_collection(&source_collection, &source_path)?;
    let old_values =
        relation_values_from_value(column, metadata.extra.get(field).unwrap_or(&Value::Null))?;
    let new_values = relation_values_from_value(column, &normalized)?;
    let mut paths = vec![Path::new(space).join(&source_path)];
    for value in old_values.iter().chain(new_values.iter()) {
        paths.push(Path::new(&target_space).join(join_collection_value(relation, value)));
    }
    Ok(Some(PreparedRelationField {
        normalized,
        reverse_update: Some(PreparedRelationFieldUpdate {
            target_space,
            relation: relation.to_string(),
            reverse_name: reverse_name.to_string(),
            source_column_name: field.to_string(),
            source_collection,
            reverse_scope,
            source_value,
            old_values,
            new_values,
        }),
        mutation_paths: dedupe_paths(paths)?,
    }))
}

pub fn apply_prepared_entry_field_relations(
    batch: &PreparedEntryFieldBatch,
) -> Result<(), CollectionError> {
    for update in &batch.relation_updates {
        sync_reverse_relation_values(
            &update.target_space,
            &update.relation,
            &update.reverse_name,
            &update.source_column_name,
            &update.source_collection,
            update.reverse_scope.as_ref(),
            &update.source_value,
            &update.old_values,
            &update.new_values,
        )?;
    }
    Ok(())
}

/// Plans every file that may be touched by an entry property batch.  The
/// returned set is suitable for the repository access gate and is re-used by
/// the atomic executor below.
pub fn entry_property_batch_mutation_paths_with_project(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    values: &std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Vec<PathBuf>, CollectionError> {
    prepare_entry_field_batch(
        space,
        project_path,
        file_path,
        values,
        EntryFieldBatchIntent::Routine,
    )
    .map(|batch| batch.mutation_paths)
}

fn resolve_routine_runtime_value(value: &serde_json::Value) -> serde_json::Value {
    match value.as_str() {
        Some("{{date}}") => {
            serde_json::Value::String(Local::now().date_naive().format("%Y-%m-%d").to_string())
        }
        Some("{{datetime}}") => {
            serde_json::Value::String(Local::now().format("%Y-%m-%dT%H:%M:%S").to_string())
        }
        _ => value.clone(),
    }
}

pub fn relation_field_target_mutation_paths_for_value_with_project(
    space: &str,
    project_path: Option<&str>,
    collection_path: &str,
    field: &str,
    value: Value,
) -> Result<Vec<PathBuf>, CollectionError> {
    let schema = read_schema_or_default(space, collection_path)?;
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(Vec::new());
    };
    if column.type_ != PropertyType::Relation || column.two_way.is_none() {
        return Ok(Vec::new());
    }
    let relation = column
        .relation
        .as_deref()
        .ok_or_else(|| schema_error(format!("relation column '{field}' requires relation")))?;
    let target_space =
        required_relation_target_space_path(space, project_path, column.relation_scope.as_ref())?;
    let normalized = normalize_relation_update_value(&target_space, column, relation, &value)?;
    let values = relation_values_from_value(column, &normalized)?;
    dedupe_paths(
        values
            .iter()
            .map(|value| Path::new(&target_space).join(join_collection_value(relation, value)))
            .collect(),
    )
}

fn normalize_relation_update_value(
    target_space: &str,
    column: &Column,
    relation: &str,
    value: &Value,
) -> Result<Value, CollectionError> {
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

fn relation_values_from_value(
    column: &Column,
    value: &Value,
) -> Result<Vec<String>, CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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

pub fn validate_property_value(column: &Column, value: &Value) -> Result<(), CollectionError> {
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
        PropertyType::Boolean => {
            if value.as_bool().is_some() {
                Ok(())
            } else {
                Err(schema_error(format!("{} must be a boolean", column.name)))
            }
        }
    }
}

fn expect_string_value<'a>(field: &str, value: &'a Value) -> Result<&'a str, CollectionError> {
    value
        .as_str()
        .ok_or_else(|| schema_error(format!("{field} must be a string")))
}

fn validate_actor_value_shape(column: &Column, value: &Value) -> Result<(), CollectionError> {
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

fn validate_relation_column_name(name: &str) -> Result<(), CollectionError> {
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

fn enforce_relation_limit_one_existing_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), CollectionError> {
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

fn option_names(column: &Column) -> HashSet<&str> {
    column
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|option| option.name.as_str())
        .collect()
}

fn validate_date_value(field: &str, value: &Value) -> Result<(), CollectionError> {
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

fn today_macro_offset(raw: &str) -> Result<Option<i64>, CollectionError> {
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

fn resolve_today_macro(raw: &str) -> Result<Option<String>, CollectionError> {
    let Some(offset) = today_macro_offset(raw)? else {
        return Ok(None);
    };
    Ok(Some(
        (Local::now().date_naive() + Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string(),
    ))
}

#[allow(dead_code)]
pub fn relation_repair_mutation_paths(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<Vec<PathBuf>, CollectionError> {
    relation_repair_mutation_paths_with_project(space, collection_path, column_name, None)
}

pub fn relation_repair_mutation_paths_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<&'a str, CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
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

fn mutate_frontmatter<F>(path: &Path, mut f: F) -> Result<bool, CollectionError>
where
    F: FnMut(&mut EntryMeta) -> Result<(), CollectionError>,
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

/// Runs `f` after the repository access gate, restoring every listed path when
/// `f` fails. A failed restore is reported instead of the original error.
fn with_rollback<T, F>(paths: Vec<PathBuf>, f: F) -> Result<T, CollectionError>
where
    F: FnOnce() -> Result<T, CollectionError>,
{
    with_rollback_as(paths, f)
}

/// [`with_rollback`] for callers whose own operation reports a host error.
pub fn with_rollback_as<T, E, F>(paths: Vec<PathBuf>, f: F) -> Result<T, E>
where
    E: From<CollectionError> + std::fmt::Display,
    F: FnOnce() -> Result<T, E>,
{
    ensure_mutation_paths_were_authorized(&paths).map_err(CollectionError::from)?;
    let mut seen = HashSet::new();
    let mut snapshots = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let content = if path.exists() {
            Some(fs::read(&path).map_err(CollectionError::from)?)
        } else {
            None
        };
        snapshots.push((path, content));
    }

    match f() {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut failed = Vec::new();
            for (path, content) in snapshots {
                let restored = if let Some(content) = content {
                    if let Some(parent) = path.parent() {
                        if let Err(restore_error) = fs::create_dir_all(parent) {
                            let _ = restore_error;
                            failed.push(path.display().to_string());
                            continue;
                        }
                    }
                    fs::write(&path, content)
                } else if path.exists() {
                    fs::remove_file(&path)
                } else {
                    Ok(())
                };
                if restored.is_err() {
                    failed.push(path.display().to_string());
                }
            }
            if failed.is_empty() {
                Err(error)
            } else {
                Err(CollectionError::Recovery {
                    cause: error.to_string(),
                    paths: failed,
                }
                .into())
            }
        }
    }
}

fn find_entry_extra_by_path(
    space: &str,
    collection_path: &str,
    file_path: &str,
    field: &str,
) -> Result<Option<Value>, CollectionError> {
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
        return PropertyType::Boolean;
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
