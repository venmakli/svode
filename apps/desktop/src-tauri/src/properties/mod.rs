use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Duration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Deserializer, Serialize};
use serde_yml::{Mapping, Value};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::files::entry::{ColorName, EntryMeta};
use crate::files::{entry, frontmatter};
use crate::git::cli::GitCli;
use crate::repo_path::{RootMode, normalize_repo_relative};

const SCHEMA_FILE: &str = "schema.yaml";
const RESERVED_FIELDS: &[&str] = &[
    "title",
    "icon",
    "description",
    "cover",
    "created",
    "updated",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Text,
    Number,
    UniqueId,
    Select,
    MultiSelect,
    Status,
    Date,
    Relation,
    Actor,
    Person,
    Checkbox,
    Url,
    Email,
    Phone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnSensitivity {
    Pii,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationLimit {
    One,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusGroup {
    Todo,
    InProgress,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropertyOption {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorName>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<StatusGroup>,
}

impl<'de> Deserialize<'de> for PropertyOption {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct PropertyOptionObject {
            name: String,
            #[serde(default)]
            color: Option<ColorName>,
            #[serde(default)]
            icon: Option<String>,
            #[serde(default)]
            group: Option<StatusGroup>,
        }

        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(name) => Ok(Self {
                name,
                color: None,
                icon: None,
                group: None,
            }),
            Value::Mapping(_) => {
                let object: PropertyOptionObject =
                    serde_yml::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(Self {
                    name: object.name,
                    color: object.color,
                    icon: object.icon,
                    group: object.group,
                })
            }
            _ => Err(serde::de::Error::custom(
                "option must be a string or an object",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: PropertyType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitivity: Option<ColumnSensitivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<PropertyOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_by_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_by_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<RelationLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub two_way: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SystemFieldOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SystemFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<SystemFieldOverride>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct DocumentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TemplatesConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    NotContains,
    ContainsAny,
    NotContainsAny,
    In,
    NotIn,
    Gt,
    Lt,
    Gte,
    Lte,
    Before,
    After,
    IsEmpty,
    IsNotEmpty,
    GroupEq,
    GroupNeq,
    GroupIn,
    GroupNotIn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sort {
    pub field: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub desc: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum View {
    Table {
        name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        filter: Vec<Filter>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sort: Vec<Sort>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        visible_fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        show_nested: Option<bool>,
    },
    Board {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group_by: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        card_fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        filter: Vec<Filter>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sort: Vec<Sort>,
    },
    Calendar {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        date_field: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color_field: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_scope: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        card_fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        filter: Vec<Filter>,
    },
    List {
        name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        card_fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        density: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sort: Vec<Sort>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        filter: Vec<Filter>,
    },
    Gallery {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        card_cover: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cover_fit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cover_aspect: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        card_fields: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sort: Vec<Sort>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        filter: Vec<Filter>,
    },
}

impl View {
    pub fn name(&self) -> &str {
        match self {
            View::Table { name, .. }
            | View::Board { name, .. }
            | View::Calendar { name, .. }
            | View::List { name, .. }
            | View::Gallery { name, .. } => name,
        }
    }

    fn name_mut(&mut self) -> &mut String {
        match self {
            View::Table { name, .. }
            | View::Board { name, .. }
            | View::Calendar { name, .. }
            | View::List { name, .. }
            | View::Gallery { name, .. } => name,
        }
    }

    pub fn filters(&self) -> &[Filter] {
        match self {
            View::Table { filter, .. }
            | View::Board { filter, .. }
            | View::Calendar { filter, .. }
            | View::List { filter, .. }
            | View::Gallery { filter, .. } => filter,
        }
    }

    pub fn sorts(&self) -> &[Sort] {
        match self {
            View::Table { sort, .. }
            | View::Board { sort, .. }
            | View::List { sort, .. }
            | View::Gallery { sort, .. } => sort,
            View::Calendar { .. } => &[],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CollectionSchema {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_fields: Option<SystemFields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<DocumentConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub templates: Option<TemplatesConfig>,
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub views: Vec<View>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySchemaResponse {
    pub schema: CollectionSchema,
    pub collection_root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    pub name: String,
    pub last_commit_at: Option<i64>,
    pub commit_count: u64,
    pub is_me: bool,
}

#[derive(Default)]
pub struct PersonCacheState {
    cache: Mutex<HashMap<PersonCacheKey, Vec<Person>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PersonCacheKey {
    space_path: PathBuf,
    all_time: bool,
}

impl PersonCacheState {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, space_path: &Path, all_time: bool) -> Option<Vec<Person>> {
        self.cache.lock().ok().and_then(|cache| {
            cache
                .get(&PersonCacheKey {
                    space_path: space_path.to_path_buf(),
                    all_time,
                })
                .cloned()
        })
    }

    fn set(&self, space_path: &Path, all_time: bool, people: Vec<Person>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                PersonCacheKey {
                    space_path: space_path.to_path_buf(),
                    all_time,
                },
                people,
            );
        }
    }
}

fn schema_error(message: impl Into<String>) -> AppError {
    AppError::General(format!("schema error: {}", message.into()))
}

fn is_actor_type(ty: PropertyType) -> bool {
    matches!(ty, PropertyType::Actor | PropertyType::Person)
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

fn actor_multiple(column: &Column) -> bool {
    column.multiple.unwrap_or(false)
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

fn canonical_actor_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn warn_if_invalid_actor_email(raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains(char::is_whitespace)
        || !trimmed.contains('@')
        || trimmed.starts_with('@')
        || trimmed.ends_with('@')
    {
        tracing::warn!("actor value {:?} is not a valid email shape", raw);
    }
}

fn normalize_actor_value(column: &Column, value: Value) -> Result<Value, AppError> {
    if value.is_null() {
        return Ok(Value::Null);
    }

    if actor_multiple(column) {
        let raw_values: Vec<String> = match value {
            Value::Sequence(sequence) => sequence
                .into_iter()
                .map(|item| {
                    item.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        schema_error(format!("{} must contain only strings", column.name))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            other => vec![expect_string_value(&column.name, &other)?.to_string()],
        };
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for raw in raw_values {
            warn_if_invalid_actor_email(&raw);
            let email = canonical_actor_email(&raw);
            if !email.is_empty() && seen.insert(email.clone()) {
                normalized.push(Value::String(email));
            }
        }
        return Ok(Value::Sequence(normalized));
    }

    let raw = match &value {
        Value::Sequence(sequence) => sequence
            .iter()
            .find_map(Value::as_str)
            .ok_or_else(|| schema_error(format!("{} must contain an actor email", column.name)))?,
        _ => expect_string_value(&column.name, &value)?,
    };
    warn_if_invalid_actor_email(raw);
    Ok(Value::String(canonical_actor_email(raw)))
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
    space: &str,
    relation: &str,
    raw_value: &str,
) -> Result<String, AppError> {
    let value = normalize_relation_value_shape(raw_value)?;
    let full = join_collection_value(relation, &value);
    let abs = Path::new(space).join(&full);
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
    let actual = find_collection_root(Path::new(space), &target_rel).ok_or_else(|| {
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

fn ensure_compatible_reverse(
    reverse: &Column,
    current_collection: &str,
    current_column: &str,
) -> Result<(), AppError> {
    ensure_compatible_reverse_with_limit_policy(reverse, current_collection, current_column, false)
}

fn ensure_compatible_reverse_with_limit_policy(
    reverse: &Column,
    current_collection: &str,
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
    let mut schema = schema.clone();
    normalize_schema(&mut schema);
    validate_schema(&schema)?;
    validate_schema_relations_in_space(space, collection_path, &schema)?;
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
        let target = collection_dir(space, &relation);
        if !target.is_dir() || !target.join(SCHEMA_FILE).is_file() {
            return Err(schema_error(format!(
                "relation column '{}' points to missing collection '{}'",
                column.name, relation
            )));
        }
        if let Some(reverse_name) = column.two_way.as_deref() {
            validate_relation_column_name(reverse_name)?;
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

pub fn schema_column_mutation_paths(
    space: &str,
    collection_path: &str,
    column: &Column,
    include_markdown: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = schema_mutation_paths(space, collection_path, include_markdown)?;
    extend_relation_side_effect_paths(space, collection_path, column, &mut paths)?;
    Ok(paths)
}

pub fn schema_column_name_mutation_paths(
    space: &str,
    collection_path: &str,
    column_name: &str,
    include_markdown: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let schema = read_schema_or_default(space, collection_path)?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        return schema_column_mutation_paths(space, collection_path, column, include_markdown);
    }
    schema_mutation_paths(space, collection_path, include_markdown)
}

fn extend_relation_side_effect_paths(
    space: &str,
    collection_path: &str,
    column: &Column,
    paths: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation || column.two_way.is_none() {
        return Ok(());
    }
    let Some(relation) = column.relation.as_deref() else {
        return Ok(());
    };
    let relation = normalize_collection_path(relation)?;
    paths.push(collection_dir(space, &relation).join(SCHEMA_FILE));
    paths.extend(collection_markdown_files(space, collection_path)?);
    paths.extend(collection_markdown_files(space, &relation)?);
    Ok(())
}

fn normalize_column_relation_paths(column: &mut Column) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation {
        column.relation = None;
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
    column.two_way = column.two_way.take().and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    Ok(())
}

fn ensure_two_way_schema_and_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    if column.type_ != PropertyType::Relation {
        return Ok(());
    }
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    let relation = column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;
    let source_collection = collection_root_for_schema(collection_path);
    let mut reverse_schema = read_schema_or_default(space, relation)?;
    if let Some(existing) = reverse_schema
        .columns
        .iter_mut()
        .find(|existing| existing.name == reverse_name)
    {
        ensure_compatible_reverse(existing, &source_collection, &column.name)?;
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
            limit: None,
            two_way: Some(column.name.clone()),
            prefix: None,
            next: None,
            multiple: None,
        });
    }
    write_schema(space, relation, &reverse_schema)?;
    materialize_two_way_reverse_values(space, collection_path, column)
}

fn materialize_two_way_reverse_values(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_limit_policy(space, collection_path, column, false)
}

fn materialize_two_way_reverse_values_allowing_limit_one_reverse(
    space: &str,
    collection_path: &str,
    column: &Column,
) -> Result<(), AppError> {
    materialize_two_way_reverse_values_with_limit_policy(space, collection_path, column, true)
}

fn materialize_two_way_reverse_values_with_limit_policy(
    space: &str,
    collection_path: &str,
    column: &Column,
    allow_limit_one_reverse: bool,
) -> Result<(), AppError> {
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    let relation = column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;
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
            space,
            relation,
            reverse_name,
            &column.name,
            &source_collection,
            &source_value,
            &[],
            &values,
            allow_limit_one_reverse,
        )?;
    }
    Ok(())
}

fn update_reverse_pair_name(
    space: &str,
    collection_path: &str,
    old_column: &Column,
    new_name: &str,
) -> Result<(), AppError> {
    let Some(reverse_name) = old_column.two_way.as_deref() else {
        return Ok(());
    };
    let Some(relation) = old_column.relation.as_deref() else {
        return Ok(());
    };
    let mut reverse_schema = read_schema_or_default(space, relation)?;
    if let Some(reverse) = reverse_schema
        .columns
        .iter_mut()
        .find(|column| column.name == reverse_name && column.type_ == PropertyType::Relation)
    {
        ensure_compatible_reverse(
            reverse,
            &collection_root_for_schema(collection_path),
            &old_column.name,
        )?;
        reverse.two_way = Some(new_name.to_string());
        write_schema(space, relation, &reverse_schema)?;
    }
    Ok(())
}

fn detach_two_way_relation(
    space: &str,
    _collection_path: &str,
    column: &Column,
    delete_reverse_column: bool,
) -> Result<(), AppError> {
    let Some(reverse_name) = column.two_way.as_deref() else {
        return Ok(());
    };
    let Some(relation) = column.relation.as_deref() else {
        return Ok(());
    };
    if delete_reverse_column {
        let mut reverse_schema = read_schema_or_default(space, relation)?;
        let before = reverse_schema.columns.len();
        reverse_schema
            .columns
            .retain(|candidate| candidate.name != reverse_name);
        if reverse_schema.columns.len() != before {
            strip_string_refs_in_views(&mut reverse_schema.views, reverse_name);
            write_schema(space, relation, &reverse_schema)?;
        }
    } else {
        let mut reverse_schema = read_schema_or_default(space, relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter_mut()
            .find(|candidate| candidate.name == reverse_name)
        {
            reverse.two_way = None;
            write_schema(space, relation, &reverse_schema)?;
        }
    }
    for file in collection_markdown_files(space, relation)? {
        mutate_frontmatter(&file, |meta| {
            meta.extra.remove(reverse_name);
            Ok(())
        })?;
    }
    Ok(())
}

pub fn cascade_clean_deleted_entries(
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
                .filter(|column| column.type_ == PropertyType::Relation)
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
    for collection in list_collections(space)? {
        touched.push(collection_dir(space, &collection.path).join(SCHEMA_FILE));
        touched.extend(collection_markdown_files(space, &collection.path)?);
    }

    with_rollback(touched, || {
        if collection_rename {
            rewrite_relation_collection_paths(space, &old_collection_path, &new_collection_path)?;
        }

        for (old_file, new_file) in &moved_paths {
            let old_root = find_collection_root(space_path, old_file);
            let Some((_, new_root)) = resolve_collection_schema_result(space, new_file)? else {
                continue;
            };
            if let Some(old_root) = old_root.as_ref().filter(|old_root| *old_root != &new_root) {
                let relation = rel_path_string(old_root);
                if let Ok(old_value) = value_relative_to_collection(&relation, old_file) {
                    rewrite_relation_value_refs(space, &relation, &old_value, new_file)?;
                }
                continue;
            }
            let relation = rel_path_string(&new_root);
            let old_value = match value_relative_to_collection(&relation, old_file) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let new_value = value_relative_to_collection(&relation, new_file)?;
            rewrite_relation_value_refs(space, &relation, &old_value, &new_value)?;
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
        for file in collect_md_files(new_abs)? {
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
            validate_schema_relations_in_space(space, &collection_path, &schema)?;
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
            .filter(|column| column.type_ == PropertyType::Relation)
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

fn rewrite_relation_collection_paths(
    space: &str,
    old_collection: &str,
    new_collection: &str,
) -> Result<(), AppError> {
    let old_collection = collection_root_for_schema(old_collection);
    let new_collection = collection_root_for_schema(new_collection);
    for collection in list_collections(space)? {
        let mut schema = read_schema_or_default(space, &collection.path)?;
        let mut changed = false;
        for column in &mut schema.columns {
            if column.type_ == PropertyType::Relation
                && column.relation.as_deref() == Some(old_collection.as_str())
            {
                column.relation = Some(new_collection.clone());
                changed = true;
            }
        }
        if changed {
            write_schema(space, &collection.path, &schema)?;
        }
    }
    Ok(())
}

fn rewrite_relation_value_refs(
    space: &str,
    relation: &str,
    old_value: &str,
    new_value: &str,
) -> Result<(), AppError> {
    for collection in list_collections(space)? {
        let schema = read_schema_or_default(space, &collection.path)?;
        let columns: Vec<Column> = schema
            .columns
            .iter()
            .filter(|column| {
                column.type_ == PropertyType::Relation
                    && column.relation.as_deref() == Some(relation)
            })
            .cloned()
            .collect();
        if columns.is_empty() {
            continue;
        }
        for file in collection_markdown_files(space, &collection.path)? {
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
                        meta.extra.insert(
                            column.name.clone(),
                            relation_value_from_values(column, values),
                        );
                    }
                }
                Ok(())
            })?;
        }
    }
    Ok(())
}

pub fn validate_schema(schema: &CollectionSchema) -> Result<(), AppError> {
    let mut names = HashSet::new();
    let mut status_count = 0;
    let mut unique_id_count = 0;
    let mut column_names = HashSet::new();

    for column in &schema.columns {
        let trimmed = column.name.trim();
        if trimmed.is_empty() {
            return Err(schema_error("column name cannot be empty"));
        }
        if RESERVED_FIELDS.contains(&trimmed) {
            return Err(schema_error(format!("column name '{trimmed}' is reserved")));
        }
        if !names.insert(column.name.clone()) {
            return Err(schema_error(format!(
                "duplicate column name '{}'",
                column.name
            )));
        }
        column_names.insert(column.name.clone());

        match column.type_ {
            PropertyType::Select | PropertyType::MultiSelect => {
                let options = column.options.as_ref().ok_or_else(|| {
                    schema_error(format!("column '{}' requires options", column.name))
                })?;
                validate_options(&column.name, options, false)?;
            }
            PropertyType::Status => {
                status_count += 1;
                let options = column.options.as_ref().ok_or_else(|| {
                    schema_error(format!("status column '{}' requires options", column.name))
                })?;
                validate_options(&column.name, options, true)?;
            }
            PropertyType::Relation => {
                let relation = column.relation.as_deref().ok_or_else(|| {
                    schema_error(format!(
                        "relation column '{}' requires relation",
                        column.name
                    ))
                })?;
                validate_relation_path_shape(relation)?;
                if let Some(two_way) = column.two_way.as_deref() {
                    validate_relation_column_name(two_way)?;
                }
            }
            PropertyType::UniqueId => {
                unique_id_count += 1;
                let next = column.next.ok_or_else(|| {
                    schema_error(format!("unique_id column '{}' requires next", column.name))
                })?;
                if next < 1 {
                    return Err(schema_error(format!(
                        "unique_id column '{}' next must be >= 1",
                        column.name
                    )));
                }
                if let Some(prefix) = column.prefix.as_deref() {
                    validate_unique_id_prefix(&column.name, prefix)?;
                }
                if column.default.is_some() {
                    return Err(schema_error(format!(
                        "unique_id column '{}' cannot define default",
                        column.name
                    )));
                }
            }
            PropertyType::Actor | PropertyType::Person => {
                if let Some(default) = column.default.as_ref() {
                    validate_property_value(column, default)?;
                }
            }
            _ => {}
        }

        validate_column_display(column)?;

        if !is_actor_type(column.type_)
            && column.type_ != PropertyType::UniqueId
            && let Some(default) = column.default.as_ref()
        {
            validate_property_value(column, default)?;
        }
    }

    if status_count > 1 {
        return Err(schema_error("schema can contain at most one status column"));
    }
    if unique_id_count > 1 {
        return Err(schema_error(
            "schema can contain at most one unique_id column",
        ));
    }

    if let Some(system_fields) = schema.system_fields.as_ref() {
        if let Some(title) = system_fields.title.as_ref() {
            if title
                .label
                .as_deref()
                .is_some_and(|label| label.trim().is_empty())
            {
                return Err(schema_error("system_fields.title.label cannot be empty"));
            }
        }
    }

    validate_views(schema, &column_names)?;

    Ok(())
}

pub fn normalize_schema(schema: &mut CollectionSchema) {
    if let Some(system_fields) = schema.system_fields.as_mut() {
        if let Some(title) = system_fields.title.as_mut() {
            title.label = title.label.take().and_then(|label| {
                let trimmed = label.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        }
        if system_fields
            .title
            .as_ref()
            .is_some_and(|title| title.label.is_none())
        {
            system_fields.title = None;
        }
        if system_fields.title.is_none() {
            schema.system_fields = None;
        }
    }
    if let Some(document) = schema.document.as_mut() {
        document.label = document.label.take().and_then(|label| {
            let trimmed = label.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if document.label.is_none() {
            schema.document = None;
        }
    }
    if let Some(templates) = schema.templates.as_mut() {
        templates.default = templates.default.take().and_then(|default| {
            let trimmed = default.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if let Some(order) = templates.order.as_mut() {
            order.retain(|slug| !slug.trim().is_empty());
            if order.is_empty() {
                templates.order = None;
            }
        }
        if templates.default.is_none() && templates.order.is_none() {
            schema.templates = None;
        }
    }

    for column in &mut schema.columns {
        if column.type_ == PropertyType::Person {
            column.type_ = PropertyType::Actor;
            column.multiple.get_or_insert(false);
        }
        if column.sensitivity.is_none()
            && matches!(column.type_, PropertyType::Email | PropertyType::Phone)
        {
            column.sensitivity = Some(ColumnSensitivity::Pii);
        }
        if column.type_ == PropertyType::Actor {
            column.multiple = Some(column.multiple.unwrap_or(false));
        } else {
            column.multiple = None;
        }
        if column.type_ == PropertyType::UniqueId {
            column.prefix = trim_unique_id_prefix(column.prefix.take());
        } else {
            column.prefix = None;
            column.next = None;
        }
    }
    let autopick_board = autopick_board_group_by(schema);
    let autopick_date = autopick_calendar_date_field(schema);
    for view in &mut schema.views {
        normalize_view(view, autopick_board.as_deref(), autopick_date.as_deref());
    }
}

fn normalize_view(
    view: &mut View,
    board_group_by: Option<&str>,
    calendar_date_field: Option<&str>,
) {
    match view {
        View::Table { visible_fields, .. } => ensure_field(visible_fields, "title"),
        View::Board {
            group_by,
            card_fields,
            ..
        } => {
            if group_by.as_deref().is_none_or(str::is_empty) {
                *group_by = board_group_by.map(ToOwned::to_owned);
            }
            ensure_field(card_fields, "title");
        }
        View::Calendar {
            date_field,
            card_fields,
            ..
        } => {
            if date_field.as_deref().is_none_or(str::is_empty) {
                *date_field = calendar_date_field.map(ToOwned::to_owned);
            }
            ensure_field(card_fields, "title");
        }
        View::List { card_fields, .. } => ensure_field(card_fields, "title"),
        View::Gallery { card_cover, .. } => {
            if card_cover.is_none() {
                *card_cover = Some(vec!["cover".into(), "icon".into(), "title".into()]);
            }
        }
    }
}

fn ensure_field(fields: &mut Vec<String>, field: &str) {
    if !fields.iter().any(|item| item == field) {
        fields.insert(0, field.to_string());
    }
}

fn autopick_board_group_by(schema: &CollectionSchema) -> Option<String> {
    for ty in [
        PropertyType::Status,
        PropertyType::Select,
        PropertyType::Actor,
    ] {
        if let Some(column) = schema.columns.iter().find(|column| {
            column.type_ == ty && (ty != PropertyType::Actor || !actor_multiple(column))
        }) {
            return Some(column.name.clone());
        }
    }
    None
}

fn autopick_calendar_date_field(schema: &CollectionSchema) -> Option<String> {
    schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::Date)
        .map(|column| column.name.clone())
}

fn validate_views(
    schema: &CollectionSchema,
    column_names: &HashSet<String>,
) -> Result<(), AppError> {
    let mut view_names = HashSet::new();
    for view in &schema.views {
        let name = view.name().trim();
        if name.is_empty() {
            return Err(schema_error("view name cannot be empty"));
        }
        if !view_names.insert(view.name().to_string()) {
            return Err(schema_error(format!(
                "duplicate view name '{}'",
                view.name()
            )));
        }
        validate_view(schema, column_names, view)?;
    }
    Ok(())
}

fn validate_view(
    schema: &CollectionSchema,
    column_names: &HashSet<String>,
    view: &View,
) -> Result<(), AppError> {
    for filter in view.filters() {
        validate_field_ref(schema, column_names, &filter.field, FieldContext::Filter)?;
        validate_filter_op(schema, filter)?;
    }
    for sort in view.sorts() {
        validate_field_ref(schema, column_names, &sort.field, FieldContext::Sort)?;
    }

    match view {
        View::Table { visible_fields, .. } => {
            for field in visible_fields {
                validate_field_ref(schema, column_names, field, FieldContext::VisibleField)?;
            }
        }
        View::Board {
            group_by,
            card_fields,
            ..
        } => {
            if let Some(group_by) = group_by.as_deref().filter(|field| !field.is_empty()) {
                validate_field_ref(schema, column_names, group_by, FieldContext::GroupBy)?;
            }
            for field in card_fields {
                validate_field_ref(schema, column_names, field, FieldContext::CardField)?;
            }
        }
        View::Calendar {
            date_field,
            color_field,
            card_fields,
            ..
        } => {
            if let Some(date_field) = date_field.as_deref().filter(|field| !field.is_empty()) {
                validate_field_ref(schema, column_names, date_field, FieldContext::DateField)?;
            }
            if let Some(color_field) = color_field.as_deref().filter(|field| !field.is_empty()) {
                validate_field_ref(schema, column_names, color_field, FieldContext::ColorField)?;
            }
            for field in card_fields {
                validate_field_ref(schema, column_names, field, FieldContext::CardField)?;
            }
        }
        View::List { card_fields, .. } => {
            for field in card_fields {
                validate_field_ref(schema, column_names, field, FieldContext::CardField)?;
            }
        }
        View::Gallery {
            card_cover,
            card_fields,
            ..
        } => {
            if let Some(card_cover) = card_cover {
                for field in card_cover {
                    validate_field_ref(schema, column_names, field, FieldContext::CardCover)?;
                }
            }
            for field in card_fields {
                validate_field_ref(schema, column_names, field, FieldContext::CardField)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum FieldContext {
    Filter,
    Sort,
    VisibleField,
    CardField,
    GroupBy,
    DateField,
    ColorField,
    CardCover,
}

fn validate_field_ref(
    schema: &CollectionSchema,
    column_names: &HashSet<String>,
    field: &str,
    context: FieldContext,
) -> Result<(), AppError> {
    if column_names.contains(field) {
        return validate_custom_field_context(schema, field, context);
    }

    let allowed = match context {
        FieldContext::Filter => matches!(field, "title" | "description" | "created" | "updated"),
        FieldContext::Sort => matches!(field, "title" | "created" | "updated"),
        FieldContext::VisibleField => matches!(
            field,
            "title" | "icon" | "description" | "created" | "updated"
        ),
        FieldContext::CardField => matches!(
            field,
            "title" | "icon" | "description" | "created" | "updated"
        ),
        FieldContext::DateField => matches!(field, "created" | "updated"),
        FieldContext::CardCover => matches!(field, "cover" | "icon" | "title"),
        FieldContext::GroupBy | FieldContext::ColorField => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(schema_error(format!(
            "field '{field}' is not valid in this view context"
        )))
    }
}

fn validate_custom_field_context(
    schema: &CollectionSchema,
    field: &str,
    context: FieldContext,
) -> Result<(), AppError> {
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == field)
        .ok_or_else(|| schema_error(format!("field '{field}' not found")))?;
    let allowed = match context {
        FieldContext::Filter | FieldContext::VisibleField | FieldContext::CardField => true,
        FieldContext::Sort => true,
        FieldContext::GroupBy => {
            matches!(column.type_, PropertyType::Select | PropertyType::Status)
                || (is_actor_type(column.type_) && !actor_multiple(column))
        }
        FieldContext::DateField => column.type_ == PropertyType::Date,
        FieldContext::ColorField => {
            matches!(column.type_, PropertyType::Select | PropertyType::Status)
        }
        FieldContext::CardCover => matches!(column.type_, PropertyType::Url | PropertyType::Text),
    };
    if allowed {
        Ok(())
    } else {
        Err(schema_error(format!(
            "field '{field}' has incompatible type for this view context"
        )))
    }
}

fn validate_filter_op(schema: &CollectionSchema, filter: &Filter) -> Result<(), AppError> {
    let ty = field_type(schema, &filter.field, FieldContext::Filter)?;
    let op_allowed = match ty {
        FieldType::TextLike => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::Contains
                | FilterOp::NotContains
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::Number => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::Gt
                | FilterOp::Lt
                | FilterOp::Gte
                | FilterOp::Lte
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::UniqueId => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::In
                | FilterOp::NotIn
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::Date => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::Before
                | FilterOp::After
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::Checkbox => matches!(filter.op, FilterOp::Eq | FilterOp::Neq),
        FieldType::SelectLike | FieldType::Person => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::In
                | FilterOp::NotIn
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::Multi => matches!(
            filter.op,
            FilterOp::Contains
                | FilterOp::NotContains
                | FilterOp::ContainsAny
                | FilterOp::NotContainsAny
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::ActorMulti => matches!(
            filter.op,
            FilterOp::Contains
                | FilterOp::NotContains
                | FilterOp::ContainsAny
                | FilterOp::NotContainsAny
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
        ),
        FieldType::Status => matches!(
            filter.op,
            FilterOp::Eq
                | FilterOp::Neq
                | FilterOp::In
                | FilterOp::NotIn
                | FilterOp::IsEmpty
                | FilterOp::IsNotEmpty
                | FilterOp::GroupEq
                | FilterOp::GroupNeq
                | FilterOp::GroupIn
                | FilterOp::GroupNotIn
        ),
    };
    if !op_allowed {
        Err(schema_error(format!(
            "operator {:?} is not valid for field '{}'",
            filter.op, filter.field
        )))?
    }
    validate_filter_payload(schema, filter, ty)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldType {
    TextLike,
    Number,
    UniqueId,
    Date,
    Checkbox,
    SelectLike,
    Multi,
    Status,
    Person,
    ActorMulti,
}

enum FilterArity {
    None,
    One,
    Many,
}

fn validate_filter_payload(
    schema: &CollectionSchema,
    filter: &Filter,
    ty: FieldType,
) -> Result<(), AppError> {
    match filter_arity(filter.op) {
        FilterArity::None => {
            if filter.value.is_some() || filter.values.is_some() {
                return Err(schema_error(format!(
                    "filter '{}' does not accept values",
                    filter.field
                )));
            }
            Ok(())
        }
        FilterArity::One => {
            let value = single_filter_value(filter)?;
            validate_filter_value(schema, filter, ty, value)
        }
        FilterArity::Many => {
            let values = filter_values(filter)?;
            for value in &values {
                validate_filter_value(schema, filter, ty, value)?;
            }
            Ok(())
        }
    }
}

fn filter_arity(op: FilterOp) -> FilterArity {
    match op {
        FilterOp::IsEmpty | FilterOp::IsNotEmpty => FilterArity::None,
        FilterOp::In
        | FilterOp::NotIn
        | FilterOp::ContainsAny
        | FilterOp::NotContainsAny
        | FilterOp::GroupIn
        | FilterOp::GroupNotIn => FilterArity::Many,
        FilterOp::Eq
        | FilterOp::Neq
        | FilterOp::Contains
        | FilterOp::NotContains
        | FilterOp::Gt
        | FilterOp::Lt
        | FilterOp::Gte
        | FilterOp::Lte
        | FilterOp::Before
        | FilterOp::After
        | FilterOp::GroupEq
        | FilterOp::GroupNeq => FilterArity::One,
    }
}

fn single_filter_value(filter: &Filter) -> Result<&Value, AppError> {
    if let Some(values) = filter.values.as_ref() {
        if values.len() == 1 {
            return Ok(&values[0]);
        }
        return Err(schema_error(format!(
            "filter '{}' requires exactly one value",
            filter.field
        )));
    }
    let value = filter
        .value
        .as_ref()
        .ok_or_else(|| schema_error(format!("filter '{}' requires value", filter.field)))?;
    if matches!(value, Value::Sequence(_)) {
        return Err(schema_error(format!(
            "filter '{}' requires a scalar value",
            filter.field
        )));
    }
    Ok(value)
}

fn validate_filter_value(
    schema: &CollectionSchema,
    filter: &Filter,
    ty: FieldType,
    value: &Value,
) -> Result<(), AppError> {
    if matches!(
        filter.op,
        FilterOp::GroupEq | FilterOp::GroupNeq | FilterOp::GroupIn | FilterOp::GroupNotIn
    ) {
        let raw = value.as_str().ok_or_else(|| {
            schema_error(format!(
                "filter '{}' requires status group value",
                filter.field
            ))
        })?;
        parse_status_group_name(raw)
            .ok_or_else(|| schema_error(format!("invalid status group '{raw}'")))?;
        return Ok(());
    }

    match ty {
        FieldType::TextLike => {
            value.as_str().ok_or_else(|| {
                schema_error(format!("filter '{}' requires string value", filter.field))
            })?;
        }
        FieldType::Number => {
            if value.as_f64().is_none() {
                return Err(schema_error(format!(
                    "filter '{}' requires numeric value",
                    filter.field
                )));
            }
        }
        FieldType::UniqueId => {
            let column = schema
                .columns
                .iter()
                .find(|column| column.name == filter.field)
                .ok_or_else(|| schema_error(format!("field '{}' not found", filter.field)))?;
            parse_unique_id_filter_value(column, value)?;
        }
        FieldType::Date => validate_date_filter_value(&filter.field, value)?,
        FieldType::Checkbox => {
            if value.as_bool().is_none() {
                return Err(schema_error(format!(
                    "filter '{}' requires boolean value",
                    filter.field
                )));
            }
        }
        FieldType::SelectLike | FieldType::Status => {
            let raw = value.as_str().ok_or_else(|| {
                schema_error(format!("filter '{}' requires option value", filter.field))
            })?;
            validate_declared_option(schema, &filter.field, raw)?;
        }
        FieldType::Multi => {
            let raw = value.as_str().ok_or_else(|| {
                schema_error(format!("filter '{}' requires option value", filter.field))
            })?;
            validate_declared_option(schema, &filter.field, raw)?;
        }
        FieldType::Person | FieldType::ActorMulti => {
            value.as_str().ok_or_else(|| {
                schema_error(format!("filter '{}' requires actor email", filter.field))
            })?;
        }
    }
    Ok(())
}

fn validate_date_filter_value(field: &str, value: &Value) -> Result<(), AppError> {
    let raw = value
        .as_str()
        .ok_or_else(|| schema_error(format!("filter '{field}' requires date value")))?;
    if today_macro_offset(raw)?.is_some() {
        return Ok(());
    }
    parse_date_cell(raw)
        .ok_or_else(|| schema_error(format!("filter '{field}' requires ISO date or datetime")))?;
    Ok(())
}

fn validate_declared_option(
    schema: &CollectionSchema,
    field: &str,
    value: &str,
) -> Result<(), AppError> {
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(());
    };
    if option_names(column).contains(value) {
        Ok(())
    } else {
        Err(schema_error(format!(
            "filter '{}' value '{}' is not declared in options",
            field, value
        )))
    }
}

fn parse_status_group_name(raw: &str) -> Option<StatusGroup> {
    match raw {
        "todo" => Some(StatusGroup::Todo),
        "in_progress" => Some(StatusGroup::InProgress),
        "done" => Some(StatusGroup::Done),
        _ => None,
    }
}

fn status_group_name(group: StatusGroup) -> &'static str {
    match group {
        StatusGroup::Todo => "todo",
        StatusGroup::InProgress => "in_progress",
        StatusGroup::Done => "done",
    }
}

fn field_type(
    schema: &CollectionSchema,
    field: &str,
    _context: FieldContext,
) -> Result<FieldType, AppError> {
    if let Some(column) = schema.columns.iter().find(|column| column.name == field) {
        return Ok(match column.type_ {
            PropertyType::Text | PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
                FieldType::TextLike
            }
            PropertyType::Number => FieldType::Number,
            PropertyType::UniqueId => FieldType::UniqueId,
            PropertyType::Select => FieldType::SelectLike,
            PropertyType::MultiSelect => FieldType::Multi,
            PropertyType::Status => FieldType::Status,
            PropertyType::Date => FieldType::Date,
            PropertyType::Actor | PropertyType::Person if actor_multiple(column) => {
                FieldType::ActorMulti
            }
            PropertyType::Actor | PropertyType::Person => FieldType::Person,
            PropertyType::Checkbox => FieldType::Checkbox,
            PropertyType::Relation => FieldType::Multi,
        });
    }
    match field {
        "title" | "description" => Ok(FieldType::TextLike),
        "created" | "updated" => Ok(FieldType::Date),
        _ => Err(schema_error(format!("field '{field}' has no query type"))),
    }
}

fn validate_options(
    column_name: &str,
    options: &[PropertyOption],
    require_group: bool,
) -> Result<(), AppError> {
    if options.is_empty() {
        return Err(schema_error(format!(
            "column '{column_name}' must define at least one option"
        )));
    }

    let mut names = HashSet::new();
    for option in options {
        let trimmed = option.name.trim();
        if trimmed.is_empty() {
            return Err(schema_error(format!(
                "column '{column_name}' has an empty option name"
            )));
        }
        if !names.insert(option.name.clone()) {
            return Err(schema_error(format!(
                "column '{column_name}' has duplicate option '{}'",
                option.name
            )));
        }
        if require_group && option.group.is_none() {
            return Err(schema_error(format!(
                "status option '{}' in column '{column_name}' requires group",
                option.name
            )));
        }
    }
    Ok(())
}

fn validate_column_display(column: &Column) -> Result<(), AppError> {
    let Some(display) = column.display.as_deref() else {
        return Ok(());
    };
    let allowed = match column.type_ {
        PropertyType::Number => ["number", "percent", "bar", "ring"].contains(&display),
        PropertyType::Date => ["short", "medium", "long"].contains(&display),
        _ => true,
    };
    if !allowed {
        return Err(schema_error(format!(
            "invalid display '{display}' for column '{}'",
            column.name
        )));
    }
    Ok(())
}

pub fn validate_entry_field_value(
    space: &str,
    file_path: &str,
    field: &str,
    value: &Value,
) -> Result<(), AppError> {
    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(());
    };
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(());
    };
    validate_property_value(column, value)
}

pub fn ensure_entry_field_writable(
    space: &str,
    file_path: &str,
    field: &str,
) -> Result<(), AppError> {
    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(());
    };
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(());
    };
    if column.type_ == PropertyType::UniqueId {
        return Err(schema_error(format!(
            "unique_id field '{field}' is read-only"
        )));
    }
    Ok(())
}

pub fn normalize_entry_field_value(
    space: &str,
    file_path: &str,
    field: &str,
    value: Value,
) -> Result<Value, AppError> {
    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(value);
    };
    let Some(column) = schema.columns.iter().find(|column| column.name == field) else {
        return Ok(value);
    };
    normalize_property_value_for_write(column, value)
}

fn normalize_property_value_for_write(column: &Column, value: Value) -> Result<Value, AppError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    match column.type_ {
        PropertyType::UniqueId => Err(schema_error(format!(
            "unique_id field '{}' is read-only",
            column.name
        ))),
        PropertyType::Actor | PropertyType::Person => normalize_actor_value(column, value),
        _ => {
            validate_property_value(column, &value)?;
            Ok(value)
        }
    }
}

pub fn update_relation_entry_field(
    space: &str,
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
    let normalized = normalize_relation_update_value(space, column, relation, &value)?;
    let reverse_name = column.two_way.clone();
    let source_collection = rel_path_string(&collection_root);
    let source_value = value_relative_to_collection(&source_collection, &source_path)?;

    let mut touched = vec![source_abs.clone()];
    if reverse_name.is_some() {
        let old_values = read_relation_field_values_from_file(&source_abs, column)?;
        let new_values = relation_values_from_value(column, &normalized)?;
        for value in old_values.iter().chain(new_values.iter()) {
            touched.push(Path::new(space).join(join_collection_value(relation, value)));
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
                space,
                relation,
                reverse_name,
                field,
                &source_collection,
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
    space: &str,
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
        return canonicalize_relation_target_value(space, relation, raw).map(Value::String);
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
        let value = canonicalize_relation_target_value(space, relation, &raw)?;
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
    ensure_compatible_reverse_with_limit_policy(
        reverse_column,
        source_collection,
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
        PropertyType::Actor | PropertyType::Person => validate_actor_value_shape(column, value),
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

pub fn apply_schema_defaults_for_path(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
) -> Result<bool, AppError> {
    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(false);
    };
    let mut changed = false;
    for column in schema.columns {
        if meta.extra.contains_key(&column.name) {
            continue;
        }
        if let Some(default) = column.default.clone() {
            let default = normalize_property_value_for_write(&column, default)?;
            if !default.is_null() {
                meta.extra.insert(column.name, default);
            }
            changed = true;
        }
    }
    Ok(changed)
}

pub fn apply_contextual_defaults_for_path(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<bool, AppError> {
    if contextual_defaults.is_empty() {
        return Ok(false);
    }

    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(false);
    };

    let mut changed = false;
    for (field, value) in contextual_defaults {
        let Some(column) = schema.columns.iter().find(|column| column.name == *field) else {
            continue;
        };
        let value = normalize_property_value_for_write(column, value.clone())?;
        if value.is_null() {
            meta.extra.remove(field);
        } else {
            meta.extra.insert(field.clone(), value);
        }
        changed = true;
    }
    Ok(changed)
}

pub fn apply_contextual_defaults_for_path_strict(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<bool, AppError> {
    if contextual_defaults.is_empty() {
        return Ok(false);
    }

    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Err(schema_error(
            "contextual defaults require a collection schema",
        ));
    };

    let mut changed = false;
    for (field, value) in contextual_defaults {
        let column = schema
            .columns
            .iter()
            .find(|column| column.name == *field)
            .ok_or_else(|| schema_error(format!("unknown contextual default field '{field}'")))?;
        let value = normalize_property_value_for_write(column, value.clone())?;
        if value.is_null() {
            meta.extra.remove(field);
        } else {
            meta.extra.insert(field.clone(), value);
        }
        changed = true;
    }
    Ok(changed)
}

pub fn apply_schema_defaults_to_entry_tree(space: &Path, rel_path: &str) -> Result<(), AppError> {
    let abs = space.join(rel_path);
    if abs.is_dir() {
        for path in collect_md_files(&abs)? {
            let rel = path
                .strip_prefix(space)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            apply_schema_defaults_to_file(space, &rel)?;
        }
    } else if abs.extension().and_then(|ext| ext.to_str()) == Some("md") {
        apply_schema_defaults_to_file(space, rel_path)?;
    }
    Ok(())
}

fn apply_schema_defaults_to_file(space: &Path, rel_path: &str) -> Result<(), AppError> {
    let space_str = space.to_string_lossy();
    let abs = space.join(rel_path);
    let raw = fs::read_to_string(&abs)?;
    let (mut meta, body) = match frontmatter::parse_status(&raw) {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        frontmatter::ParseStatus::Missing { body } => {
            let title = entry::title_from_stem(
                Path::new(rel_path)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("untitled"),
            );
            (
                EntryMeta::synthesized(title, String::new(), String::new()),
                body,
            )
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(AppError::FrontmatterParse(format!(
                "cannot apply schema defaults while frontmatter is malformed: {message}"
            )));
        }
    };
    let changed_defaults = apply_schema_defaults_for_path(&space_str, rel_path, &mut meta)?;
    let changed_unique_id = assign_unique_id_to_meta_for_path(&space_str, rel_path, &mut meta)?;
    if changed_defaults || changed_unique_id {
        fs::write(abs, frontmatter::serialize(&meta, &body))?;
    }
    Ok(())
}

pub fn unique_id_mutation_paths_for_entry(
    space: &str,
    file_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = vec![Path::new(space).join(normalize_rel_path(file_path))];
    if let Some(schema_path) = unique_id_schema_path_for_entry(space, file_path)? {
        paths.push(schema_path);
    }
    Ok(paths)
}

pub fn unique_id_mutation_paths_for_entry_tree(
    space: &Path,
    rel_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    for file in markdown_files_in_tree(space, rel_path)? {
        let rel = copy_rel_from_abs(space, &file);
        if let Some(schema_path) = unique_id_schema_path_for_entry(&space.to_string_lossy(), &rel)?
        {
            paths.push(file);
            paths.push(schema_path);
        }
    }
    dedupe_paths(paths)
}

pub fn unique_id_schema_path_for_entry(
    space: &str,
    file_path: &str,
) -> Result<Option<PathBuf>, AppError> {
    let Some((schema, root)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(None);
    };
    if schema
        .columns
        .iter()
        .any(|column| column.type_ == PropertyType::UniqueId)
    {
        Ok(Some(Path::new(space).join(root).join(SCHEMA_FILE)))
    } else {
        Ok(None)
    }
}

pub fn assign_unique_ids_to_entry_tree(
    space: &Path,
    rel_path: &str,
    force: bool,
) -> Result<(), AppError> {
    for file in markdown_files_in_tree(space, rel_path)? {
        let rel = copy_rel_from_abs(space, &file);
        assign_unique_id_to_file(&space.to_string_lossy(), &rel, force)?;
    }
    Ok(())
}

pub fn assign_unique_id(space: &str, file_path: &str) -> Result<entry::Entry, AppError> {
    let paths = unique_id_mutation_paths_for_entry(space, file_path)?;
    with_rollback(paths, || {
        assign_unique_id_to_file(space, file_path, true)?;
        entry::read(space, file_path)
    })
}

pub fn normalize_unique_id_counter(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.type_ == PropertyType::UniqueId)
            .cloned()
        else {
            return Ok(schema);
        };
        let values = collection_unique_id_values(space, collection_path, &column.name, None)?;
        let max_existing = values.iter().map(|(_, value)| *value).max().unwrap_or(0);
        let required_next = next_after(max_existing)?;
        let current_next = column.next.unwrap_or(1);
        if current_next < required_next {
            set_unique_id_next(&mut schema, &column.name, required_next)?;
            write_schema(space, collection_path, &schema)?;
        }
        read_schema_or_default(space, collection_path)
    })
}

fn assign_unique_id_to_file(space: &str, file_path: &str, force: bool) -> Result<bool, AppError> {
    let rel = normalize_rel_path(file_path);
    let abs = Path::new(space).join(&rel);
    let raw = fs::read_to_string(&abs)?;
    let (mut meta, body) = match frontmatter::parse_status(&raw) {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        frontmatter::ParseStatus::Missing { body } => {
            let title = entry::title_from_stem(
                Path::new(&rel)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("untitled"),
            );
            (
                EntryMeta::synthesized(title, String::new(), String::new()),
                body,
            )
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(AppError::FrontmatterParse(format!(
                "cannot assign unique_id while frontmatter is malformed: {message}"
            )));
        }
    };
    let changed = if force {
        force_assign_unique_id_to_meta(space, &rel, &mut meta)?
    } else {
        assign_unique_id_to_meta_for_path(space, &rel, &mut meta)?
    };
    if changed {
        fs::write(abs, frontmatter::serialize(&meta, &body))?;
    }
    Ok(changed)
}

pub fn assign_unique_id_to_meta_for_path(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
) -> Result<bool, AppError> {
    assign_unique_id_to_meta_inner(space, file_path, meta, false)
}

fn force_assign_unique_id_to_meta(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
) -> Result<bool, AppError> {
    assign_unique_id_to_meta_inner(space, file_path, meta, true)
}

fn assign_unique_id_to_meta_inner(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    force: bool,
) -> Result<bool, AppError> {
    let Some((mut schema, root)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(false);
    };
    let collection_path = rel_path_string(&root);
    let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .cloned()
    else {
        return Ok(false);
    };
    let field = column.name.clone();
    let existing = meta.extra.get(&field).and_then(unique_id_value);
    let values = collection_unique_id_values(space, &collection_path, &field, Some(file_path))?;
    let duplicate = existing.is_some_and(|value| values.iter().any(|(_, other)| *other == value));
    let invalid_or_missing = existing.is_none();
    let mut changed = false;

    if force || invalid_or_missing || duplicate {
        let fresh = next_unique_id_value(&schema, &values)?;
        meta.extra.insert(field.clone(), yaml_u64(fresh));
        set_unique_id_next(&mut schema, &field, next_after(fresh)?)?;
        write_schema(space, &collection_path, &schema)?;
        return Ok(true);
    }

    if let Some(existing) = existing {
        let required_next = next_after(existing)?;
        if column.next.unwrap_or(1) < required_next {
            set_unique_id_next(&mut schema, &field, required_next)?;
            write_schema(space, &collection_path, &schema)?;
            changed = true;
        }
    }
    Ok(changed)
}

fn materialize_unique_id_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<(), AppError> {
    let mut schema = read_schema_or_default(space, collection_path)?;
    let files = sorted_collection_markdown_files_for_unique_id(space, collection_path)?;
    let mut used = HashSet::new();
    let mut next = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .and_then(|column| column.next)
        .unwrap_or(1)
        .max(1);

    for file in files {
        let raw = fs::read_to_string(&file)?;
        let rel = copy_rel_from_abs(Path::new(space), &file);
        let (mut meta, body) = match frontmatter::parse_status(&raw) {
            frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
            frontmatter::ParseStatus::Missing { body } => {
                let title = entry::title_from_stem(
                    Path::new(&rel)
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("untitled"),
                );
                (
                    EntryMeta::synthesized(title, String::new(), String::new()),
                    body,
                )
            }
            frontmatter::ParseStatus::Malformed { message, .. } => {
                return Err(AppError::FrontmatterParse(format!(
                    "cannot assign unique_id while frontmatter is malformed: {message}"
                )));
            }
        };
        let existing = meta.extra.get(column_name).and_then(unique_id_value);
        let keep = existing.is_some_and(|value| used.insert(value));
        if keep {
            next = next.max(next_after(existing.unwrap())?);
            continue;
        }
        while used.contains(&next) {
            next = next_after(next)?;
        }
        let assigned = next;
        used.insert(assigned);
        meta.extra
            .insert(column_name.to_string(), yaml_u64(assigned));
        fs::write(&file, frontmatter::serialize(&meta, &body))?;
        next = next_after(assigned)?;
    }

    set_unique_id_next(&mut schema, column_name, next)?;
    write_schema(space, collection_path, &schema)
}

fn collection_unique_id_values(
    space: &str,
    collection_path: &str,
    field: &str,
    exclude_path: Option<&str>,
) -> Result<Vec<(String, u64)>, AppError> {
    let exclude = exclude_path.map(normalize_rel_path);
    let mut values = Vec::new();
    for file in collection_markdown_files(space, collection_path)? {
        let rel = copy_rel_from_abs(Path::new(space), &file);
        if exclude.as_deref() == Some(rel.as_str()) {
            continue;
        }
        let raw = fs::read_to_string(&file)?;
        let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
            continue;
        };
        if let Some(value) = meta.extra.get(field).and_then(unique_id_value) {
            values.push((rel, value));
        }
    }
    Ok(values)
}

fn next_unique_id_value(
    schema: &CollectionSchema,
    existing_values: &[(String, u64)],
) -> Result<u64, AppError> {
    let schema_next = schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .and_then(|column| column.next)
        .unwrap_or(1)
        .max(1);
    let max_existing = existing_values
        .iter()
        .map(|(_, value)| *value)
        .max()
        .unwrap_or(0);
    Ok(schema_next.max(next_after(max_existing)?))
}

fn set_unique_id_next(
    schema: &mut CollectionSchema,
    field: &str,
    next: u64,
) -> Result<(), AppError> {
    let column = schema
        .columns
        .iter_mut()
        .find(|column| column.name == field && column.type_ == PropertyType::UniqueId)
        .ok_or_else(|| schema_error(format!("unique_id column '{field}' not found")))?;
    column.next = Some(next.max(1));
    Ok(())
}

fn next_after(value: u64) -> Result<u64, AppError> {
    value
        .checked_add(1)
        .ok_or_else(|| schema_error("unique_id counter overflow"))
}

fn sorted_collection_markdown_files_for_unique_id(
    space: &str,
    collection_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let order = crate::files::tree::read_order(Path::new(space));
    let mut rows = Vec::new();
    for file in collection_markdown_files(space, collection_path)? {
        let rel = copy_rel_from_abs(Path::new(space), &file);
        let parent = entry_parent_dir(&rel);
        let order_name = entry_order_name(&rel);
        let order_index = order
            .get(if parent.is_empty() {
                "."
            } else {
                parent.as_str()
            })
            .and_then(|items| items.iter().position(|item| item == &order_name));
        let title = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| {
                frontmatter::try_parse(&raw)
                    .ok()
                    .flatten()
                    .map(|(meta, _)| meta.title)
            })
            .unwrap_or_default()
            .to_lowercase();
        rows.push((file, parent, order_index, title, rel));
    }
    rows.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.is_none().cmp(&b.2.is_none()))
            .then_with(|| a.2.unwrap_or(usize::MAX).cmp(&b.2.unwrap_or(usize::MAX)))
            .then_with(|| a.3.cmp(&b.3))
            .then_with(|| a.4.cmp(&b.4))
    });
    Ok(rows.into_iter().map(|row| row.0).collect())
}

fn markdown_files_in_tree(space: &Path, rel_path: &str) -> Result<Vec<PathBuf>, AppError> {
    let abs = space.join(normalize_rel_path(rel_path));
    if abs.is_dir() {
        collect_md_files(&abs)
    } else if abs.extension().and_then(|ext| ext.to_str()) == Some("md") {
        Ok(vec![abs])
    } else {
        Ok(Vec::new())
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, AppError> {
    let mut seen = HashSet::new();
    Ok(paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect())
}

pub fn add_schema_column(
    space: &str,
    collection_path: &str,
    mut column: Column,
) -> Result<CollectionSchema, AppError> {
    if column.type_ == PropertyType::Status && column.options.is_none() {
        column.options = Some(default_status_options());
    }
    if column.type_ == PropertyType::Person {
        column.type_ = PropertyType::Actor;
    }
    if column.type_ == PropertyType::Actor {
        column.multiple = Some(column.multiple.unwrap_or(false));
    }
    if column.type_ == PropertyType::UniqueId {
        column.next = Some(column.next.unwrap_or(1).max(1));
        column.prefix = trim_unique_id_prefix(column.prefix.take());
    }
    let mut touched = vec![collection_dir(space, collection_path).join(SCHEMA_FILE)];
    if column.type_ == PropertyType::UniqueId {
        touched.extend(collection_markdown_files(space, collection_path)?);
    }
    extend_relation_side_effect_paths(space, collection_path, &column, &mut touched)?;
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema
            .columns
            .iter()
            .any(|existing| existing.name == column.name)
        {
            return Err(schema_error(format!(
                "column '{}' already exists",
                column.name
            )));
        }
        normalize_column_relation_paths(&mut column)?;
        schema.columns.push(column.clone());
        validate_schema(&schema)?;
        write_schema(space, collection_path, &schema)?;
        if column.type_ == PropertyType::UniqueId {
            materialize_unique_id_column(space, collection_path, &column.name)?;
            schema = read_schema_or_default(space, collection_path)?;
        }
        ensure_two_way_schema_and_values(space, collection_path, &column)?;
        Ok(schema)
    })
}

#[allow(dead_code)]
pub fn change_schema_type(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
) -> Result<CollectionSchema, AppError> {
    change_schema_type_with_warnings(
        space,
        collection_path,
        column_name,
        new_type,
        conversion_strategy,
    )
    .map(|(schema, _)| schema)
}

pub fn change_schema_type_with_warnings(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
) -> Result<(CollectionSchema, Vec<SchemaMutationWarning>), AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(old_column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            extend_relation_side_effect_paths(space, collection_path, old_column, &mut touched)?;
            let mut new_column = old_column.clone();
            new_column.type_ = new_type;
            normalize_column_for_new_type(&mut new_column, conversion_strategy.as_ref())?;
            normalize_column_relation_paths(&mut new_column)?;
            extend_relation_side_effect_paths(space, collection_path, &new_column, &mut touched)?;
        }
    }
    with_rollback(touched, || {
        let mut warnings = Vec::new();
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
            .cloned();
        let column = find_column_mut(&mut schema, column_name)?;
        column.type_ = new_type;
        normalize_column_for_new_type(column, conversion_strategy.as_ref())?;
        normalize_column_relation_paths(column)?;
        let column_snapshot = column.clone();
        validate_schema(&schema)?;

        let files = collection_markdown_files(space, collection_path)?;
        let unconverted_relation_field = if column_snapshot.type_ == PropertyType::Relation {
            Some(unique_extra_field_name(
                space,
                collection_path,
                &schema,
                &format!("{column_name} (unconverted)"),
            )?)
        } else {
            None
        };
        let mut unconverted_relation_rows = 0usize;
        for file in &files {
            mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.remove(column_name) {
                    if let Some(extra_field) = unconverted_relation_field.as_deref() {
                        let (converted, extra) =
                            convert_value_for_relation_change(space, &column_snapshot, value)?;
                        if let Some(converted) = converted {
                            meta.extra.insert(column_name.to_string(), converted);
                        }
                        if let Some(extra) = extra {
                            meta.extra.insert(extra_field.to_string(), extra);
                            unconverted_relation_rows += 1;
                        }
                    } else {
                        meta.extra.insert(
                            column_name.to_string(),
                            convert_value_for_type_from_old(
                                value,
                                old_column.as_ref(),
                                &column_snapshot,
                            ),
                        );
                    }
                }
                Ok(())
            })?;
        }
        if let Some(field) = unconverted_relation_field {
            if unconverted_relation_rows > 0 {
                warnings.push(SchemaMutationWarning {
                    code: "relation_unconverted_values".to_string(),
                    field,
                    count: unconverted_relation_rows,
                });
            }
        }

        enforce_relation_limit_one_existing_values(space, collection_path, &column_snapshot)?;
        write_schema(space, collection_path, &schema)?;
        if column_snapshot.type_ == PropertyType::UniqueId {
            materialize_unique_id_column(space, collection_path, &column_snapshot.name)?;
            schema = read_schema_or_default(space, collection_path)?;
        }
        if old_column
            .as_ref()
            .is_some_and(|old| old.type_ == PropertyType::Relation && old.two_way.is_some())
            && column_snapshot.type_ != PropertyType::Relation
        {
            detach_two_way_relation(space, collection_path, old_column.as_ref().unwrap(), true)?;
        }
        ensure_two_way_schema_and_values(space, collection_path, &column_snapshot)?;
        Ok((schema, warnings))
    })
}

pub fn rename_schema_column(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(old_column) = schema.columns.iter().find(|column| column.name == old_name) {
            extend_relation_side_effect_paths(space, collection_path, old_column, &mut touched)?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == new_name) {
            return Err(schema_error(format!("column '{new_name}' already exists")));
        }
        let old_column = find_column_mut(&mut schema, old_name)?.clone();
        find_column_mut(&mut schema, old_name)?.name = new_name.to_string();
        replace_string_refs_in_views(&mut schema.views, old_name, new_name);
        validate_schema(&schema)?;

        let files = collection_markdown_files(space, collection_path)?;
        for file in &files {
            mutate_frontmatter(file, |meta| {
                if !meta.extra.contains_key(new_name) {
                    if let Some(value) = meta.extra.remove(old_name) {
                        meta.extra.insert(new_name.to_string(), value);
                    }
                }
                Ok(())
            })?;
        }

        write_schema(space, collection_path, &schema)?;
        if old_column.type_ == PropertyType::Relation {
            update_reverse_pair_name(space, collection_path, &old_column, new_name)?;
        }
        Ok(schema)
    })
}

pub fn update_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: Value,
) -> Result<CollectionSchema, AppError> {
    let mut touched = vec![collection_dir(space, collection_path).join(SCHEMA_FILE)];
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            if column.type_ == PropertyType::Relation {
                touched.extend(collection_markdown_files(space, collection_path)?);
            }
            extend_relation_side_effect_paths(space, collection_path, column, &mut touched)?;
            let mut patched = column.clone();
            apply_column_patch(&mut patched, patch.clone())?;
            normalize_column_relation_paths(&mut patched)?;
            if is_actor_cardinality_change(column, &patched) {
                touched.extend(collection_markdown_files(space, collection_path)?);
            }
            extend_relation_side_effect_paths(space, collection_path, &patched, &mut touched)?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = find_column_mut(&mut schema, column_name)?.clone();
        let column = find_column_mut(&mut schema, column_name)?;
        apply_column_patch(column, patch)?;
        normalize_column_relation_paths(column)?;
        let new_column = column.clone();
        validate_schema(&schema)?;
        rewrite_actor_cardinality_values(space, collection_path, &old_column, &new_column)?;
        enforce_relation_limit_one_existing_values(space, collection_path, &new_column)?;
        write_schema(space, collection_path, &schema)?;
        if old_column.type_ == PropertyType::Relation
            && old_column.two_way.is_some()
            && (new_column.type_ != PropertyType::Relation
                || new_column.two_way != old_column.two_way
                || new_column.relation != old_column.relation)
        {
            detach_two_way_relation(space, collection_path, &old_column, true)?;
        }
        ensure_two_way_schema_and_values(space, collection_path, &new_column)?;
        Ok(schema)
    })
}

fn is_actor_cardinality_change(old_column: &Column, new_column: &Column) -> bool {
    is_actor_type(old_column.type_)
        && is_actor_type(new_column.type_)
        && actor_multiple(old_column) != actor_multiple(new_column)
}

fn rewrite_actor_cardinality_values(
    space: &str,
    collection_path: &str,
    old_column: &Column,
    new_column: &Column,
) -> Result<(), AppError> {
    if !is_actor_cardinality_change(old_column, new_column) {
        return Ok(());
    }

    for file in collection_markdown_files(space, collection_path)? {
        mutate_frontmatter(&file, |meta| {
            let Some(value) = meta.extra.get(&new_column.name).cloned() else {
                return Ok(());
            };
            let next = actor_value_for_cardinality_toggle(new_column, value)?;
            if next.is_null()
                || next
                    .as_sequence()
                    .is_some_and(|sequence| sequence.is_empty())
            {
                meta.extra.remove(&new_column.name);
            } else {
                meta.extra.insert(new_column.name.clone(), next);
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn actor_value_for_cardinality_toggle(column: &Column, value: Value) -> Result<Value, AppError> {
    if actor_multiple(column) {
        return normalize_actor_value(column, value);
    }
    if let Value::Sequence(sequence) = &value {
        let values: Vec<&Value> = sequence.iter().filter(|item| !item.is_null()).collect();
        if values.is_empty() {
            return Ok(Value::Null);
        }
        if values.len() > 1 {
            return Err(schema_error(format!(
                "actor column '{}' has multiple values; choose one before disabling multiple",
                column.name
            )));
        }
        return normalize_actor_value(column, values[0].clone());
    }
    normalize_actor_value(column, value)
}

pub fn delete_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    delete_values: bool,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    if delete_values {
        touched.extend(collection_markdown_files(space, collection_path)?);
    }
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            extend_relation_side_effect_paths(space, collection_path, column, &mut touched)?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
            .cloned();
        let before = schema.columns.len();
        schema.columns.retain(|column| column.name != column_name);
        if schema.columns.len() == before {
            return Err(schema_error(format!("column '{column_name}' not found")));
        }
        strip_string_refs_in_views(&mut schema.views, column_name);
        validate_schema(&schema)?;

        if delete_values {
            let files = collection_markdown_files(space, collection_path)?;
            for file in &files {
                mutate_frontmatter(file, |meta| {
                    meta.extra.remove(column_name);
                    Ok(())
                })?;
            }
        }

        write_schema(space, collection_path, &schema)?;
        if let Some(old_column) = old_column
            .as_ref()
            .filter(|column| column.type_ == PropertyType::Relation && column.two_way.is_some())
        {
            detach_two_way_relation(space, collection_path, old_column, true)?;
        }
        Ok(schema)
    })
}

pub fn add_option(
    space: &str,
    collection_path: &str,
    column_name: &str,
    option: PropertyOption,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        ensure_option_column(column)?;
        let options = column.options.get_or_insert_with(Vec::new);
        if options.iter().any(|existing| existing.name == option.name) {
            return Err(schema_error(format!(
                "option '{}' already exists",
                option.name
            )));
        }
        options.push(option);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn rename_option(
    space: &str,
    collection_path: &str,
    column_name: &str,
    old_option_name: &str,
    new_option_name: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        ensure_option_column(column)?;
        let options = column.options.as_mut().unwrap();
        if options.iter().any(|option| option.name == new_option_name) {
            return Err(schema_error(format!(
                "option '{new_option_name}' already exists"
            )));
        }
        let option = options
            .iter_mut()
            .find(|option| option.name == old_option_name)
            .ok_or_else(|| schema_error(format!("option '{old_option_name}' not found")))?;
        option.name = new_option_name.to_string();
        replace_string_refs_in_views(&mut schema.views, old_option_name, new_option_name);
        validate_schema(&schema)?;

        let files = collection_markdown_files(space, collection_path)?;
        for file in &files {
            mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    replace_option_value(value, old_option_name, new_option_name);
                }
                Ok(())
            })?;
        }

        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn delete_option(
    space: &str,
    collection_path: &str,
    column_name: &str,
    option_name: &str,
    delete_values: bool,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    if delete_values {
        touched.extend(collection_markdown_files(space, collection_path)?);
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        ensure_option_column(column)?;
        let options = column.options.as_mut().unwrap();
        let before = options.len();
        options.retain(|option| option.name != option_name);
        if options.len() == before {
            return Err(schema_error(format!("option '{option_name}' not found")));
        }
        validate_schema(&schema)?;

        if delete_values {
            let files = collection_markdown_files(space, collection_path)?;
            for file in &files {
                mutate_frontmatter(file, |meta| {
                    if let Some(value) = meta.extra.get_mut(column_name) {
                        delete_option_value(value, option_name);
                        if value.is_null()
                            || value
                                .as_sequence()
                                .is_some_and(|sequence| sequence.is_empty())
                        {
                            meta.extra.remove(column_name);
                        }
                    }
                    Ok(())
                })?;
            }
        }

        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn clear_field_values(
    space: &str,
    collection_path: &str,
    field: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                meta.extra.remove(field);
                Ok(())
            })?;
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn clear_option_values(
    space: &str,
    collection_path: &str,
    column_name: &str,
    option_names: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if option_names.is_empty() {
        return Ok(Vec::new());
    }
    let schema = read_schema_or_default(space, collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .ok_or_else(|| schema_error(format!("column '{column_name}' not found")))?;
    ensure_option_column(column)?;

    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    for option_name in option_names {
                        delete_option_value(value, option_name);
                    }
                    if value.is_null()
                        || value
                            .as_sequence()
                            .is_some_and(|sequence| sequence.is_empty())
                    {
                        meta.extra.remove(column_name);
                    }
                }
                Ok(())
            })?;
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn replace_option_values(
    space: &str,
    collection_path: &str,
    column_name: &str,
    old_option_name: &str,
    new_option_name: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let schema = read_schema_or_default(space, collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .ok_or_else(|| schema_error(format!("column '{column_name}' not found")))?;
    ensure_option_column(column)?;
    if !column
        .options
        .as_ref()
        .is_some_and(|options| options.iter().any(|option| option.name == new_option_name))
    {
        return Err(schema_error(format!(
            "option '{new_option_name}' not found"
        )));
    }

    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    replace_option_value(value, old_option_name, new_option_name);
                }
                Ok(())
            })?;
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn update_option(
    space: &str,
    collection_path: &str,
    column_name: &str,
    option_name: &str,
    option: Option<PropertyOption>,
    patch: Option<Value>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        ensure_option_column(column)?;
        let target = column
            .options
            .as_mut()
            .unwrap()
            .iter_mut()
            .find(|option| option.name == option_name)
            .ok_or_else(|| schema_error(format!("option '{option_name}' not found")))?;

        if let Some(option) = option {
            target.color = option.color;
            target.icon = option.icon;
            target.group = option.group;
        }
        if let Some(patch) = patch {
            apply_option_patch(target, patch)?;
        }

        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn promote_orphan(
    space: &str,
    collection_path: &str,
    file_path: &str,
    field: &str,
) -> Result<CollectionSchema, AppError> {
    if matches!(field, "created" | "updated") {
        return Err(schema_error(format!(
            "orphan field '{field}' conflicts with derived system metadata; rename it before promoting or delete it"
        )));
    }
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == field) {
            return Err(schema_error(format!("column '{field}' already exists")));
        }
        let value = find_entry_extra_by_path(space, collection_path, file_path, field)?
            .ok_or_else(|| schema_error(format!("orphan field '{field}' not found")))?;
        schema.columns.push(infer_column(field, &value));
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn update_system_field_label(
    space: &str,
    collection_path: &str,
    field: &str,
    label: Option<String>,
) -> Result<CollectionSchema, AppError> {
    if field != "title" {
        return Err(schema_error("only title system field can be relabeled"));
    }
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let normalized = label.and_then(|label| {
            let trimmed = label.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if let Some(label) = normalized {
            schema
                .system_fields
                .get_or_insert_with(SystemFields::default)
                .title
                .get_or_insert_with(SystemFieldOverride::default)
                .label = Some(label);
        } else if let Some(system_fields) = schema.system_fields.as_mut() {
            if let Some(title) = system_fields.title.as_mut() {
                title.label = None;
            }
            if system_fields
                .title
                .as_ref()
                .is_some_and(|title| title.label.is_none())
            {
                system_fields.title = None;
            }
            if system_fields.title.is_none() {
                schema.system_fields = None;
            }
        }
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn update_document_label(
    space: &str,
    collection_path: &str,
    label: Option<String>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let normalized = label.and_then(|label| {
            let trimmed = label.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if let Some(label) = normalized {
            schema
                .document
                .get_or_insert_with(DocumentConfig::default)
                .label = Some(label);
        } else {
            schema.document = None;
        }
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn set_default_template(
    space: &str,
    collection_path: &str,
    template_slug: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        schema
            .templates
            .get_or_insert_with(TemplatesConfig::default)
            .default = template_slug.map(ToOwned::to_owned);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn reorder_templates(
    space: &str,
    collection_path: &str,
    new_order: Vec<String>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        schema
            .templates
            .get_or_insert_with(TemplatesConfig::default)
            .order = Some(new_order);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn rename_template_slug_references(
    space: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), AppError> {
    let Some((old_collection, old_slug)) = template_root_context(old_path) else {
        return Ok(());
    };
    let Some((new_collection, new_slug)) = template_root_context(new_path) else {
        return Ok(());
    };
    if old_collection != new_collection || old_slug == new_slug {
        return Ok(());
    }

    let schema_path = collection_dir(space, &old_collection).join(SCHEMA_FILE);
    if !schema_path.is_file() {
        return Ok(());
    }

    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, &old_collection)?;
        let Some(templates) = schema.templates.as_mut() else {
            return Ok(());
        };

        let mut changed = false;
        if templates.default.as_deref() == Some(old_slug.as_str()) {
            templates.default = Some(new_slug.clone());
            changed = true;
        }
        if let Some(order) = templates.order.as_mut() {
            for item in order {
                if item == &old_slug {
                    *item = new_slug.clone();
                    changed = true;
                }
            }
        }

        if changed {
            write_schema(space, &old_collection, &schema)?;
        }
        Ok(())
    })
}

fn template_root_context(path: &str) -> Option<(String, String)> {
    let rel = normalize_rel_path(path);
    let parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let marker = parts.iter().position(|part| *part == ".templates")?;
    let after = &parts[marker + 1..];

    let slug = match after {
        [file] if file.ends_with(".md") => file.strip_suffix(".md")?.to_string(),
        [slug, readme] if readme.eq_ignore_ascii_case("README.md") => slug.to_string(),
        _ => return None,
    };

    let collection = if marker == 0 {
        ".".to_string()
    } else {
        parts[..marker].join("/")
    };
    Some((collection, slug))
}

pub fn default_collection_schema() -> CollectionSchema {
    CollectionSchema {
        system_fields: None,
        document: None,
        templates: None,
        columns: Vec::new(),
        views: vec![View::Table {
            name: "Все".to_string(),
            filter: Vec::new(),
            sort: Vec::new(),
            visible_fields: vec!["title".to_string()],
            show_nested: None,
        }],
    }
}

pub fn write_default_collection_schema(space: &str, collection_path: &str) -> Result<(), AppError> {
    write_schema(space, collection_path, &default_collection_schema())
}

pub fn add_view(
    space: &str,
    collection_path: &str,
    mut view: View,
    position: Option<usize>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let base_name = {
            let trimmed = view.name().trim();
            if trimmed.is_empty() { "Table" } else { trimmed }
        };
        if schema
            .views
            .iter()
            .any(|existing| existing.name() == base_name)
        {
            let existing_names: HashSet<String> = schema
                .views
                .iter()
                .map(|existing| existing.name().to_string())
                .collect();
            let mut index = 2;
            let mut next_name = format!("{base_name} {index}");
            while existing_names.contains(&next_name) {
                index += 1;
                next_name = format!("{base_name} {index}");
            }
            *view.name_mut() = next_name;
        } else {
            *view.name_mut() = base_name.to_string();
        }
        normalize_view_for_schema(&schema, &mut view);
        let index = position
            .unwrap_or(schema.views.len())
            .min(schema.views.len());
        schema.views.insert(index, view);
        normalize_schema(&mut schema);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn rename_view(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.views.iter().any(|view| view.name() == new_name) {
            return Err(schema_error(format!("view '{new_name}' already exists")));
        }
        let view = find_view_mut(&mut schema, old_name)?;
        *view.name_mut() = new_name.trim().to_string();
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn update_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
    patch: Value,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let pos = schema
            .views
            .iter()
            .position(|view| view.name() == view_name)
            .ok_or_else(|| schema_error(format!("view '{view_name}' not found")))?;
        let mut raw = serde_yml::to_value(&schema.views[pos])
            .map_err(|e| schema_error(format!("could not encode view: {e}")))?;
        merge_mapping_patch(&mut raw, patch)?;
        let mut view: View = serde_yml::from_value(raw)
            .map_err(|e| schema_error(format!("invalid view patch: {e}")))?;
        normalize_view_for_schema(&schema, &mut view);
        schema.views[pos] = view;
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn delete_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let before = schema.views.len();
        schema.views.retain(|view| view.name() != view_name);
        if schema.views.len() == before {
            return Err(schema_error(format!("view '{view_name}' not found")));
        }
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn duplicate_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
    new_name: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.views.iter().any(|view| view.name() == new_name) {
            return Err(schema_error(format!("view '{new_name}' already exists")));
        }
        let mut view = schema
            .views
            .iter()
            .find(|view| view.name() == view_name)
            .cloned()
            .ok_or_else(|| schema_error(format!("view '{view_name}' not found")))?;
        *view.name_mut() = new_name.trim().to_string();
        schema.views.push(view);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn reorder_views(
    space: &str,
    collection_path: &str,
    new_order: Vec<String>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if new_order.len() != schema.views.len() {
            return Err(schema_error(
                "view order must include every view exactly once",
            ));
        }
        let mut reordered = Vec::with_capacity(schema.views.len());
        let mut seen = HashSet::new();
        for name in new_order {
            if !seen.insert(name.clone()) {
                return Err(schema_error(format!("duplicate view in order '{name}'")));
            }
            let idx = schema
                .views
                .iter()
                .position(|view| view.name() == name)
                .ok_or_else(|| schema_error(format!("view '{name}' not found")))?;
            reordered.push(schema.views[idx].clone());
        }
        schema.views = reordered;
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

fn find_view_mut<'a>(
    schema: &'a mut CollectionSchema,
    view_name: &str,
) -> Result<&'a mut View, AppError> {
    schema
        .views
        .iter_mut()
        .find(|view| view.name() == view_name)
        .ok_or_else(|| schema_error(format!("view '{view_name}' not found")))
}

fn normalize_view_for_schema(schema: &CollectionSchema, view: &mut View) {
    let group_by = autopick_board_group_by(schema);
    let date_field = autopick_calendar_date_field(schema);
    normalize_view(view, group_by.as_deref(), date_field.as_deref());
}

fn merge_mapping_patch(target: &mut Value, patch: Value) -> Result<(), AppError> {
    let target = target
        .as_mapping_mut()
        .ok_or_else(|| schema_error("view target must be an object"))?;
    let patch = patch
        .as_mapping()
        .ok_or_else(|| schema_error("view patch must be an object"))?;
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub path: String,
    pub title: String,
    pub row_count: usize,
    pub nested: bool,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMutationWarning {
    pub code: String,
    pub field: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RelationEdge {
    source_value: String,
    target_value: String,
}

pub fn list_collections(space: &str) -> Result<Vec<CollectionInfo>, AppError> {
    let root = Path::new(space);
    let mut infos = Vec::new();
    if root.join(SCHEMA_FILE).is_file() {
        infos.push(CollectionInfo {
            path: ".".to_string(),
            title: collection_title(
                root,
                root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Collection"),
            ),
            row_count: collection_markdown_files(space, ".")?.len(),
            nested: false,
        });
    }
    collect_collections(root, root, &mut infos)?;
    infos.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(infos)
}

fn collect_collections(
    space: &Path,
    dir: &Path,
    out: &mut Vec<CollectionInfo>,
) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if !path.is_dir() {
            continue;
        }

        if path.join(SCHEMA_FILE).is_file() {
            let rel = path
                .strip_prefix(space)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let title = collection_title(&path, &name);
            let row_count = collection_markdown_files(&space.to_string_lossy(), &rel)?.len();
            let nested =
                find_collection_root(space, &format!("{}/README.md", normalize_rel_path(&rel)))
                    .is_some();
            out.push(CollectionInfo {
                path: rel.clone(),
                title,
                row_count,
                nested,
            });
        }

        collect_collections(space, &path, out)?;
    }
    Ok(())
}

fn collection_title(collection_dir: &Path, fallback_name: &str) -> String {
    let readme = collection_dir.join("README.md");
    if let Ok(raw) = fs::read_to_string(readme) {
        if let Ok(Some((meta, _))) = frontmatter::try_parse(&raw) {
            if !meta.title.trim().is_empty() {
                return meta.title;
            }
        }
    }
    fallback_name.replace(['-', '_'], " ")
}

async fn resolve_query_filters(
    git_cli: Option<&GitCli>,
    space_path: &Path,
    schema: &CollectionSchema,
    filters: &[Filter],
) -> Result<Vec<Filter>, AppError> {
    let me_email = if query_filters_need_me(schema, filters)? {
        Some(resolve_current_person_email(git_cli, space_path).await?)
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
        FieldType::Person | FieldType::ActorMulti => {
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
            FieldType::Person | FieldType::ActorMulti
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

async fn resolve_current_person_email(
    git_cli: Option<&GitCli>,
    space_path: &Path,
) -> Result<String, AppError> {
    let cli = git_cli.ok_or_else(|| schema_error("@me requires Git to be available"))?;
    let (name, email) = current_git_person(cli, space_path)
        .await?
        .ok_or_else(|| schema_error("@me requires git user.email"))?;
    canonicalize_person(cli, space_path, &name, &email).await
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
        FieldType::Person | FieldType::ActorMulti if raw == "@me" => me_email
            .map(|email| Value::String(email.to_string()))
            .ok_or_else(|| schema_error("@me requires git user.email")),
        FieldType::Person | FieldType::ActorMulti => Ok(Value::String(canonical_actor_email(raw))),
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

pub fn diagnose_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
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
    let choices = if let Some(relation) = relation.as_deref() {
        compatible_reverse_choices(space, &collection_path, column_name, relation)?
    } else {
        Vec::new()
    };

    let mut schema_status = RelationTwoWaySchemaStatus::NotTwoWay;
    let mut schema_message = None;
    let mut drift = RelationDriftSummary::default();

    if let (Some(relation), Some(reverse_name)) = (relation.as_deref(), reverse_column.as_deref()) {
        let reverse_schema = read_schema_or_default(space, relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter()
            .find(|candidate| candidate.name == reverse_name)
        {
            match ensure_compatible_reverse_with_limit_policy(
                reverse,
                &collection_path,
                column_name,
                true,
            ) {
                Ok(()) if reverse.two_way.as_deref() == Some(column_name) => {
                    schema_status = RelationTwoWaySchemaStatus::Ok;
                    drift = detect_relation_value_drift(
                        space,
                        &collection_path,
                        &column,
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
    column_name: &str,
    relation: &str,
) -> Result<Vec<CompatibleReverseChoice>, AppError> {
    let mut choices = Vec::new();
    let reverse_schema = read_schema_or_default(space, relation)?;
    for candidate in &reverse_schema.columns {
        if candidate.type_ != PropertyType::Relation {
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
    space: &str,
    collection_path: &str,
    column: &Column,
    relation: &str,
    reverse: &Column,
) -> Result<RelationDriftSummary, AppError> {
    let source_edges = relation_edges_for_column(space, collection_path, column)?;
    let reverse_edges = relation_edges_for_column(space, relation, reverse)?
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

pub fn relation_repair_mutation_paths(
    space: &str,
    collection_path: &str,
    column_name: &str,
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
        if let Some(relation) = column.relation.as_deref() {
            let relation = normalize_collection_path(relation)?;
            paths.push(collection_dir(space, &relation).join(SCHEMA_FILE));
            paths.extend(collection_markdown_files(space, &relation)?);
        }
    }
    dedupe_paths(paths)
}

pub fn repair_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
    strategy: &str,
    reverse_column: Option<&str>,
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
    let relation = column.relation.as_deref().ok_or_else(|| {
        schema_error(format!("relation column '{column_name}' requires relation"))
    })?;
    let mut touched = Vec::new();
    touched.extend(collection_markdown_files(space, collection_path)?);
    touched.extend(collection_markdown_files(space, relation)?);
    touched.push(collection_dir(space, collection_path).join(SCHEMA_FILE));
    touched.push(collection_dir(space, relation).join(SCHEMA_FILE));
    with_rollback(touched, || match strategy {
        "from_this_side" => {
            for file in collection_markdown_files(space, relation)? {
                mutate_frontmatter(&file, |meta| {
                    meta.extra.remove(reverse_name);
                    Ok(())
                })?;
            }
            materialize_two_way_reverse_values(space, collection_path, &column)
        }
        "from_related_side" => {
            for file in collection_markdown_files(space, collection_path)? {
                mutate_frontmatter(&file, |meta| {
                    meta.extra.remove(column_name);
                    Ok(())
                })?;
            }
            let reverse_schema = read_schema_or_default(space, relation)?;
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
            materialize_two_way_reverse_values_allowing_limit_one_reverse(space, relation, &reverse)
        }
        "choose_reverse_column" => {
            let reverse_name = required_reverse_repair_column(reverse_column)?;
            choose_two_way_reverse_column(space, collection_path, column_name, reverse_name)
        }
        "create_reverse_column" => {
            let reverse_name = reverse_column.unwrap_or(reverse_name);
            create_two_way_reverse_column(space, collection_path, column_name, reverse_name)
        }
        "detach_two_way" => detach_current_two_way_relation(
            space,
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
    collection_path: &str,
    column_name: &str,
    reverse_name: &str,
) -> Result<(), AppError> {
    validate_relation_column_name(reverse_name)?;
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let relation = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        column
            .relation
            .as_deref()
            .map(normalize_collection_path)
            .transpose()?
            .ok_or_else(|| {
                schema_error(format!("relation column '{column_name}' requires relation"))
            })?
    };
    let mut reverse_schema = read_schema_or_default(space, &relation)?;
    let reverse = reverse_schema
        .columns
        .iter_mut()
        .find(|candidate| candidate.name == reverse_name)
        .ok_or_else(|| schema_error(format!("reverse column '{reverse_name}' not found")))?;
    ensure_compatible_reverse(reverse, &source_collection, column_name)?;

    find_column_mut(&mut schema, column_name)?.two_way = Some(reverse_name.to_string());
    reverse.two_way = Some(column_name.to_string());
    write_schema(space, collection_path, &schema)?;
    write_schema(space, &relation, &reverse_schema)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    materialize_two_way_reverse_values(space, collection_path, &column)
}

fn create_two_way_reverse_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    reverse_name: &str,
) -> Result<(), AppError> {
    validate_relation_column_name(reverse_name)?;
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let relation = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        column
            .relation
            .as_deref()
            .map(normalize_collection_path)
            .transpose()?
            .ok_or_else(|| {
                schema_error(format!("relation column '{column_name}' requires relation"))
            })?
    };
    let mut reverse_schema = read_schema_or_default(space, &relation)?;
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
        limit: None,
        two_way: Some(column_name.to_string()),
        prefix: None,
        next: None,
        multiple: None,
    });
    write_schema(space, collection_path, &schema)?;
    write_schema(space, &relation, &reverse_schema)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .cloned()
        .ok_or_else(|| schema_error(format!("relation column '{column_name}' not found")))?;
    materialize_two_way_reverse_values(space, collection_path, &column)
}

fn detach_current_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
    reverse_column: Option<&str>,
) -> Result<(), AppError> {
    let source_collection = collection_root_for_schema(collection_path);
    let mut schema = read_schema_or_default(space, collection_path)?;
    let (relation, old_reverse_name) = {
        let column = find_column_mut(&mut schema, column_name)?;
        if column.type_ != PropertyType::Relation {
            return Err(schema_error(format!(
                "column '{column_name}' is not a relation"
            )));
        }
        let relation = column
            .relation
            .as_deref()
            .map(normalize_collection_path)
            .transpose()?
            .ok_or_else(|| {
                schema_error(format!("relation column '{column_name}' requires relation"))
            })?;
        let old_reverse_name = column.two_way.take();
        (relation, old_reverse_name)
    };
    write_schema(space, collection_path, &schema)?;

    let reverse_name = reverse_column
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(old_reverse_name);
    if let Some(reverse_name) = reverse_name {
        let mut reverse_schema = read_schema_or_default(space, &relation)?;
        if let Some(reverse) = reverse_schema
            .columns
            .iter_mut()
            .find(|candidate| candidate.name == reverse_name)
        {
            if ensure_compatible_reverse(reverse, &source_collection, column_name).is_ok() {
                reverse.two_way = None;
                write_schema(space, &relation, &reverse_schema)?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct EntryQueryRow {
    file_path: String,
    title: String,
    created: String,
    updated: String,
}

async fn query_entry_rows(
    pool: &SqlitePool,
    schema: &CollectionSchema,
    collection_path: &str,
    filters: &[Filter],
    sort: &[Sort],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<EntryQueryRow>, AppError> {
    let collection = collection_root_for_sql(collection_path);
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT file_path, title, created, updated FROM entries WHERE collection_root_path = ",
    );
    query.push_bind(collection);
    query.push(" AND in_collection = 1 AND is_entry_head = 1");
    for filter in filters {
        push_filter_sql(&mut query, schema, filter)?;
    }
    if !sort.is_empty() {
        query.push(" ORDER BY ");
        for (idx, item) in sort.iter().enumerate() {
            if idx > 0 {
                query.push(", ");
            }
            push_sort_sql(&mut query, schema, &item.field, item.desc)?;
        }
    }
    if let Some(limit) = limit {
        query.push(" LIMIT ");
        query.push_bind(limit.max(0));
    }
    if let Some(offset) = offset {
        query.push(" OFFSET ");
        query.push_bind(offset.max(0));
    }

    let rows = query
        .build()
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::Index(format!("collection query failed: {e}")))?;
    Ok(rows
        .into_iter()
        .map(|row| EntryQueryRow {
            file_path: row.get("file_path"),
            title: row.get("title"),
            created: row.get("created"),
            updated: row.get("updated"),
        })
        .collect())
}

fn push_filter_sql(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
) -> Result<(), AppError> {
    validate_filter_op(schema, filter)?;
    let ty = field_type(schema, &filter.field, FieldContext::Filter)?;
    query.push(" AND ");
    match filter.op {
        FilterOp::Eq if ty == FieldType::Date => {
            push_date_range_eq_filter(query, schema, filter, false)?
        }
        FilterOp::Neq if ty == FieldType::Date => {
            push_date_range_eq_filter(query, schema, filter, true)?
        }
        FilterOp::Eq => push_binary_filter(query, schema, filter, ty, "=")?,
        FilterOp::Neq => push_binary_filter(query, schema, filter, ty, "!=")?,
        FilterOp::Contains if matches!(ty, FieldType::Multi | FieldType::ActorMulti) => {
            push_array_contains_filter(query, schema, filter, false)?
        }
        FilterOp::NotContains if matches!(ty, FieldType::Multi | FieldType::ActorMulti) => {
            push_array_contains_filter(query, schema, filter, true)?
        }
        FilterOp::Contains => push_like_filter(query, schema, filter, false)?,
        FilterOp::NotContains => push_like_filter(query, schema, filter, true)?,
        FilterOp::In => push_in_filter(query, schema, filter, false)?,
        FilterOp::NotIn => push_in_filter(query, schema, filter, true)?,
        FilterOp::After => push_date_cmp_filter(query, filter, false, ">")?,
        FilterOp::Before => push_date_cmp_filter(query, filter, true, "<")?,
        FilterOp::Gt => push_cmp_filter(query, schema, filter, ty, ">")?,
        FilterOp::Lt => push_cmp_filter(query, schema, filter, ty, "<")?,
        FilterOp::Gte => push_cmp_filter(query, schema, filter, ty, ">=")?,
        FilterOp::Lte => push_cmp_filter(query, schema, filter, ty, "<=")?,
        FilterOp::IsEmpty => {
            push_empty_expr(query, schema, &filter.field)?;
        }
        FilterOp::IsNotEmpty => {
            push_not_empty_expr(query, schema, &filter.field)?;
        }
        FilterOp::ContainsAny | FilterOp::NotContainsAny => push_array_contains_filter(
            query,
            schema,
            filter,
            matches!(filter.op, FilterOp::NotContainsAny),
        )?,
        FilterOp::GroupEq | FilterOp::GroupNeq | FilterOp::GroupIn | FilterOp::GroupNotIn => {
            push_status_group_filter(query, schema, filter)?
        }
    }
    Ok(())
}

fn push_field_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    match field {
        "title" | "description" | "created" | "updated" => {
            query.push(field);
        }
        _ => {
            query.push("json_extract(fields, ");
            query.push_bind(json_path(field));
            query.push(")");
        }
    }
}

fn push_date_field_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    match field {
        "created" | "updated" => push_field_expr(query, field),
        _ => {
            query.push("COALESCE(json_extract(fields, ");
            query.push_bind(json_nested_path(field, "start"));
            query.push("), ");
            push_field_expr(query, field);
            query.push(")");
        }
    }
}

fn push_date_end_field_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    match field {
        "created" | "updated" => push_field_expr(query, field),
        _ => {
            query.push("COALESCE(json_extract(fields, ");
            query.push_bind(json_nested_path(field, "end"));
            query.push("), ");
            push_field_expr(query, field);
            query.push(")");
        }
    }
}

fn push_number_field_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    query.push("CAST(");
    push_field_expr(query, field);
    query.push(" AS REAL)");
}

fn push_filter_field_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str, ty: FieldType) {
    match ty {
        FieldType::Number | FieldType::UniqueId => push_number_field_expr(query, field),
        FieldType::Date => push_date_field_expr(query, field),
        _ => push_field_expr(query, field),
    }
}

fn push_text_sort_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    query.push("LOWER(CAST(");
    push_field_expr(query, field);
    query.push(" AS TEXT)) COLLATE NOCASE");
}

fn push_empty_expr(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    field: &str,
) -> Result<(), AppError> {
    let ty = field_type(schema, field, FieldContext::Filter)?;
    query.push("(");
    push_field_expr(query, field);
    query.push(" IS NULL OR ");
    match ty {
        FieldType::Multi | FieldType::ActorMulti => {
            query.push("json_array_length(");
            push_field_expr(query, field);
            query.push(") = 0");
        }
        _ => {
            push_field_expr(query, field);
            query.push(" = ''");
        }
    }
    query.push(")");
    Ok(())
}

fn push_not_empty_expr(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    field: &str,
) -> Result<(), AppError> {
    query.push("NOT ");
    push_empty_expr(query, schema, field)
}

fn push_filter_value(
    query: &mut QueryBuilder<'_, Sqlite>,
    filter: &Filter,
) -> Result<(), AppError> {
    let value = filter
        .value
        .as_ref()
        .or_else(|| filter.values.as_ref().and_then(|values| values.first()))
        .ok_or_else(|| schema_error(format!("filter '{}' requires value", filter.field)))?;
    push_yaml_value(query, value);
    Ok(())
}

fn push_yaml_value(query: &mut QueryBuilder<'_, Sqlite>, value: &Value) {
    if let Some(value) = value.as_str() {
        query.push_bind(value.to_string());
    } else if let Some(value) = value.as_bool() {
        query.push_bind(value);
    } else if let Some(value) = value.as_i64() {
        query.push_bind(value);
    } else if let Some(value) = value.as_f64() {
        query.push_bind(value);
    } else {
        query.push_bind(serde_json::to_string(value).unwrap_or_default());
    }
}

fn push_binary_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
    ty: FieldType,
    op: &str,
) -> Result<(), AppError> {
    if op == "!=" {
        push_not_empty_expr(query, schema, &filter.field)?;
        query.push(" AND ");
    }
    push_filter_field_expr(query, &filter.field, ty);
    query.push(" ");
    query.push(op);
    query.push(" ");
    push_filter_value(query, filter)
}

fn push_date_range_eq_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
    negated: bool,
) -> Result<(), AppError> {
    if negated {
        push_not_empty_expr(query, schema, &filter.field)?;
        query.push(" AND NOT ");
    }
    query.push("(");
    push_date_field_expr(query, &filter.field);
    query.push(" <= ");
    push_filter_value(query, filter)?;
    query.push(" AND ");
    push_date_end_field_expr(query, &filter.field);
    query.push(" >= ");
    push_filter_value(query, filter)?;
    query.push(")");
    Ok(())
}

fn push_like_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
    negated: bool,
) -> Result<(), AppError> {
    let value = single_filter_value(filter)?
        .as_str()
        .ok_or_else(|| schema_error(format!("filter '{}' requires string value", filter.field)))?;
    if negated {
        push_not_empty_expr(query, schema, &filter.field)?;
        query.push(" AND ");
    }
    query.push("CAST(");
    push_field_expr(query, &filter.field);
    query.push(" AS TEXT)");
    if negated {
        query.push(" NOT");
    }
    query.push(" LIKE ");
    query.push_bind(format!("%{}%", escape_like(value)));
    query.push(" ESCAPE '\\'");
    Ok(())
}

fn push_in_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
    negated: bool,
) -> Result<(), AppError> {
    let values = filter_values(filter)?;
    let ty = field_type(schema, &filter.field, FieldContext::Filter)?;
    if negated {
        push_not_empty_expr(query, schema, &filter.field)?;
        query.push(" AND ");
    }
    push_filter_field_expr(query, &filter.field, ty);
    if negated {
        query.push(" NOT");
    }
    query.push(" IN (");
    for (idx, value) in values.iter().enumerate() {
        if idx > 0 {
            query.push(", ");
        }
        push_yaml_value(query, value);
    }
    query.push(")");
    Ok(())
}

fn push_cmp_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    _schema: &CollectionSchema,
    filter: &Filter,
    ty: FieldType,
    op: &str,
) -> Result<(), AppError> {
    push_filter_field_expr(query, &filter.field, ty);
    query.push(" ");
    query.push(op);
    query.push(" ");
    push_filter_value(query, filter)
}

fn push_date_cmp_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    filter: &Filter,
    use_end: bool,
    op: &str,
) -> Result<(), AppError> {
    if use_end {
        push_date_end_field_expr(query, &filter.field);
    } else {
        push_date_field_expr(query, &filter.field);
    }
    query.push(" ");
    query.push(op);
    query.push(" ");
    push_filter_value(query, filter)
}

fn push_array_contains_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
    negated: bool,
) -> Result<(), AppError> {
    let values = filter_values(filter)?;
    if negated {
        push_not_empty_expr(query, schema, &filter.field)?;
        query.push(" AND NOT ");
    }
    query.push("EXISTS (SELECT 1 FROM json_each(");
    push_field_expr(query, &filter.field);
    query.push(") WHERE json_each.value IN (");
    for (idx, value) in values.iter().enumerate() {
        if idx > 0 {
            query.push(", ");
        }
        push_yaml_value(query, value);
    }
    query.push("))");
    Ok(())
}

fn push_status_group_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    filter: &Filter,
) -> Result<(), AppError> {
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == filter.field)
        .ok_or_else(|| schema_error(format!("status field '{}' not found", filter.field)))?;
    let wanted: HashSet<String> = filter_values(filter)?
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect();
    let mut option_names = Vec::new();
    for option in column.options.as_deref().unwrap_or_default() {
        let Some(group) = option.group else { continue };
        if wanted.contains(status_group_name(group)) {
            option_names.push(Value::String(option.name.clone()));
        }
    }
    if option_names.is_empty() {
        if matches!(filter.op, FilterOp::GroupNeq | FilterOp::GroupNotIn) {
            push_not_empty_expr(query, schema, &filter.field)?;
        } else {
            query.push("0 = 1");
        }
        return Ok(());
    }
    let rewritten = Filter {
        field: filter.field.clone(),
        op: match filter.op {
            FilterOp::GroupNeq | FilterOp::GroupNotIn => FilterOp::NotIn,
            _ => FilterOp::In,
        },
        value: None,
        values: Some(option_names),
    };
    push_in_filter(
        query,
        schema,
        &rewritten,
        matches!(rewritten.op, FilterOp::NotIn),
    )
}

fn push_sort_sql(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    field: &str,
    desc: bool,
) -> Result<(), AppError> {
    let ty = field_type(schema, field, FieldContext::Sort)?;
    push_empty_expr(query, schema, field)?;
    query.push(" ASC, ");
    match ty {
        FieldType::TextLike | FieldType::Person => {
            push_text_sort_expr(query, field);
            query.push(sort_direction(desc));
        }
        FieldType::Number | FieldType::UniqueId => {
            push_number_field_expr(query, field);
            query.push(sort_direction(desc));
        }
        FieldType::Date => {
            push_date_field_expr(query, field);
            query.push(sort_direction(desc));
        }
        FieldType::Checkbox => {
            push_field_expr(query, field);
            query.push(sort_direction(desc));
        }
        FieldType::SelectLike | FieldType::Status => {
            push_option_sort_sql(query, schema, field, desc)?;
        }
        FieldType::Multi => {
            push_multi_select_sort_sql(query, schema, field, desc)?;
        }
        FieldType::ActorMulti => {
            push_actor_multi_sort_sql(query, field, desc);
        }
    }
    Ok(())
}

fn sort_direction(desc: bool) -> &'static str {
    if desc { " DESC" } else { " ASC" }
}

fn column_for_field<'a>(schema: &'a CollectionSchema, field: &str) -> Result<&'a Column, AppError> {
    schema
        .columns
        .iter()
        .find(|column| column.name == field)
        .ok_or_else(|| schema_error(format!("field '{field}' not found")))
}

fn push_option_sort_sql(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    field: &str,
    desc: bool,
) -> Result<(), AppError> {
    let column = column_for_field(schema, field)?;
    push_option_index_expr(query, field, column);
    query.push(" IS NULL ASC, ");
    push_option_index_expr(query, field, column);
    query.push(sort_direction(desc));
    query.push(", ");
    push_text_sort_expr(query, field);
    query.push(sort_direction(desc));
    Ok(())
}

fn push_option_index_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str, column: &Column) {
    query.push("(CASE ");
    push_field_expr(query, field);
    for (idx, option) in column
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        query.push(" WHEN ");
        query.push_bind(option.name.clone());
        query.push(" THEN ");
        query.push(idx.to_string());
    }
    query.push(" ELSE NULL END)");
}

fn push_multi_select_sort_sql(
    query: &mut QueryBuilder<'_, Sqlite>,
    schema: &CollectionSchema,
    field: &str,
    desc: bool,
) -> Result<(), AppError> {
    let column = column_for_field(schema, field)?;
    push_multi_valid_key_expr(query, field, column);
    query.push(" IS NULL ASC, ");
    push_multi_valid_key_expr(query, field, column);
    query.push(sort_direction(desc));
    query.push(", ");
    push_multi_lex_key_expr(query, field);
    query.push(sort_direction(desc));
    Ok(())
}

fn push_multi_valid_key_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str, column: &Column) {
    query.push(
        "(SELECT group_concat(CASE WHEN option_index IS NOT NULL THEN printf('%08d', option_index) END, ',') FROM (SELECT ",
    );
    push_json_each_option_index_case(query, column);
    query.push(" AS option_index FROM json_each(");
    push_field_expr(query, field);
    query.push(") ORDER BY option_index))");
}

fn push_json_each_option_index_case(query: &mut QueryBuilder<'_, Sqlite>, column: &Column) {
    query.push("CASE json_each.value");
    for (idx, option) in column
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        query.push(" WHEN ");
        query.push_bind(option.name.clone());
        query.push(" THEN ");
        query.push(idx.to_string());
    }
    query.push(" ELSE NULL END");
}

fn push_multi_lex_key_expr(query: &mut QueryBuilder<'_, Sqlite>, field: &str) {
    query.push(
        "(SELECT group_concat(value, ',') FROM (SELECT LOWER(CAST(json_each.value AS TEXT)) AS value FROM json_each(",
    );
    push_field_expr(query, field);
    query.push(") ORDER BY value))");
}

fn push_actor_multi_sort_sql(query: &mut QueryBuilder<'_, Sqlite>, field: &str, desc: bool) {
    query.push("(SELECT LOWER(CAST(json_each.value AS TEXT)) FROM json_each(");
    push_field_expr(query, field);
    query.push(") ORDER BY json_each.key LIMIT 1)");
    query.push(sort_direction(desc));
}

fn filter_values(filter: &Filter) -> Result<Vec<Value>, AppError> {
    if let Some(values) = filter.values.clone() {
        if values.is_empty() {
            return Err(schema_error(format!(
                "filter '{}' requires non-empty values",
                filter.field
            )));
        }
        return Ok(values);
    }
    filter
        .value
        .clone()
        .map(|value| match value {
            Value::Sequence(values) => values,
            value => vec![value],
        })
        .filter(|values| !values.is_empty())
        .ok_or_else(|| schema_error(format!("filter '{}' requires values", filter.field)))
}

fn validate_ad_hoc_query(
    schema: &CollectionSchema,
    filters: &[Filter],
    sort: &[Sort],
) -> Result<(), AppError> {
    let column_names: HashSet<String> = schema.columns.iter().map(|c| c.name.clone()).collect();
    for filter in filters {
        validate_field_ref(schema, &column_names, &filter.field, FieldContext::Filter)?;
        validate_filter_op(schema, filter)?;
    }
    for sort in sort {
        validate_field_ref(schema, &column_names, &sort.field, FieldContext::Sort)?;
    }
    Ok(())
}

fn entries_from_rows(
    space: &str,
    collection_path: &str,
    rows: Vec<EntryQueryRow>,
    include_nested: bool,
    manual_order: bool,
) -> Result<Vec<entry::Entry>, AppError> {
    let collection = collection_root_for_sql(collection_path);
    let mut entries = Vec::new();
    for row in rows {
        if !include_nested && entry_parent_dir(&row.file_path) != collection {
            continue;
        }
        let mut entry = entry::read(space, &row.file_path)?;
        entry.meta.created = row.created.clone();
        entry.meta.updated = row.updated.clone();
        entries.push((row, entry));
    }
    if manual_order {
        return order_entries(space, &collection, entries, include_nested);
    }
    Ok(entries.into_iter().map(|(_, entry)| entry).collect())
}

#[allow(dead_code)]
pub fn reorder_visible_entry_names(
    full_order: &[String],
    visible_order: &[String],
    moved_name: &str,
    to_visible_index: usize,
) -> Result<Vec<String>, AppError> {
    let mut visible = HashSet::new();
    for name in visible_order {
        if !visible.insert(name.as_str()) {
            return Err(schema_error(format!("duplicate visible entry '{name}'")));
        }
        if !full_order.iter().any(|item| item == name) {
            return Err(schema_error(format!(
                "visible entry '{name}' is not in order"
            )));
        }
    }
    if !visible.contains(moved_name) {
        return Err(schema_error(format!(
            "moved entry '{moved_name}' is not visible"
        )));
    }

    let mut next: Vec<String> = full_order
        .iter()
        .filter(|name| name.as_str() != moved_name)
        .cloned()
        .collect();
    let visible_without_moved: Vec<&String> = full_order
        .iter()
        .filter(|name| visible.contains(name.as_str()) && name.as_str() != moved_name)
        .collect();
    let target = to_visible_index.min(visible_without_moved.len());

    if let Some(anchor) = visible_without_moved.get(target) {
        let insert_at = next
            .iter()
            .position(|name| name == *anchor)
            .unwrap_or(next.len());
        next.insert(insert_at, moved_name.to_string());
    } else {
        next.push(moved_name.to_string());
    }
    Ok(next)
}

fn order_entries(
    space: &str,
    collection: &str,
    entries: Vec<(EntryQueryRow, entry::Entry)>,
    include_nested: bool,
) -> Result<Vec<entry::Entry>, AppError> {
    let order = crate::files::tree::read_order(Path::new(space));
    if !include_nested {
        let mut entries = entries;
        sort_sibling_entries(&mut entries, &order, collection);
        return Ok(entries.into_iter().map(|(_, entry)| entry).collect());
    }

    let mut by_parent: HashMap<String, Vec<(EntryQueryRow, entry::Entry)>> = HashMap::new();
    for item in entries {
        by_parent
            .entry(entry_parent_dir(&item.0.file_path))
            .or_default()
            .push(item);
    }
    let mut out = Vec::new();
    flatten_ordered(collection, &order, &mut by_parent, &mut out);
    Ok(out)
}

fn flatten_ordered(
    dir: &str,
    order: &HashMap<String, Vec<String>>,
    by_parent: &mut HashMap<String, Vec<(EntryQueryRow, entry::Entry)>>,
    out: &mut Vec<entry::Entry>,
) {
    let mut entries = by_parent.remove(dir).unwrap_or_default();
    sort_sibling_entries(&mut entries, order, dir);
    for (row, entry) in entries {
        let child_dir = entry_folder_dir(&row.file_path);
        out.push(entry);
        if let Some(child_dir) = child_dir {
            flatten_ordered(&child_dir, order, by_parent, out);
        }
    }
}

fn sort_sibling_entries(
    entries: &mut [(EntryQueryRow, entry::Entry)],
    order: &HashMap<String, Vec<String>>,
    dir: &str,
) {
    let key = if dir.is_empty() { "." } else { dir };
    let positions: HashMap<&str, usize> = order
        .get(key)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(idx, name)| (name.as_str(), idx))
        .collect();
    entries.sort_by(|a, b| {
        let an = entry_order_name(&a.0.file_path);
        let bn = entry_order_name(&b.0.file_path);
        match (positions.get(an.as_str()), positions.get(bn.as_str())) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => an
                .to_lowercase()
                .cmp(&bn.to_lowercase())
                .then_with(|| a.0.title.to_lowercase().cmp(&b.0.title.to_lowercase())),
        }
    });
}

fn entry_parent_dir(file_path: &str) -> String {
    let path = Path::new(file_path);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        path.parent()
            .and_then(Path::parent)
            .map(|p| normalize_rel_path(&p.to_string_lossy()))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ".".to_string())
    } else {
        path.parent()
            .map(|p| normalize_rel_path(&p.to_string_lossy()))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ".".to_string())
    }
}

fn entry_folder_dir(file_path: &str) -> Option<String> {
    let path = Path::new(file_path);
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
        .then(|| {
            path.parent()
                .map(|p| normalize_rel_path(&p.to_string_lossy()))
                .unwrap_or_default()
        })
        .filter(|p| !p.is_empty())
}

fn entry_order_name(file_path: &str) -> String {
    let path = Path::new(file_path);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "README.md".to_string());
    }
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string())
}

fn collection_root_for_sql(collection_path: &str) -> String {
    let rel = normalize_rel_path(collection_path);
    if rel.is_empty() { ".".to_string() } else { rel }
}

fn json_path(field: &str) -> String {
    format!("$.\"{}\"", field.replace('"', "\\\""))
}

fn json_nested_path(field: &str, nested: &str) -> String {
    format!("{}.\"{}\"", json_path(field), nested.replace('"', "\\\""))
}

fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn find_column_mut<'a>(
    schema: &'a mut CollectionSchema,
    column_name: &str,
) -> Result<&'a mut Column, AppError> {
    schema
        .columns
        .iter_mut()
        .find(|column| column.name == column_name)
        .ok_or_else(|| schema_error(format!("column '{column_name}' not found")))
}

fn ensure_option_column(column: &Column) -> Result<(), AppError> {
    match column.type_ {
        PropertyType::Select | PropertyType::MultiSelect | PropertyType::Status => Ok(()),
        _ => Err(schema_error(format!(
            "column '{}' does not support options",
            column.name
        ))),
    }
}

fn normalize_column_for_new_type(
    column: &mut Column,
    strategy: Option<&Value>,
) -> Result<(), AppError> {
    match column.type_ {
        PropertyType::Status => {
            if let Some(options) = strategy.and_then(|value| value.get("options")).cloned() {
                column.options = Some(
                    serde_yml::from_value(options)
                        .map_err(|e| schema_error(format!("invalid status options: {e}")))?,
                );
            } else if let Some(groups) = strategy.and_then(|value| value.get("groups")) {
                apply_status_groups(column, groups)?;
            } else if column.options.is_none() {
                column.options = Some(default_status_options());
            } else if column
                .options
                .as_ref()
                .is_some_and(|options| options.iter().any(|option| option.group.is_none()))
            {
                return Err(schema_error(
                    "changing to status requires group for every option",
                ));
            }
        }
        PropertyType::Select | PropertyType::MultiSelect => {
            if column.options.is_none() {
                column.options = Some(Vec::new());
            }
            for option in column.options.iter_mut().flatten() {
                option.group = None;
            }
            column.relation = None;
            column.limit = None;
            column.two_way = None;
        }
        PropertyType::Relation => {
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.prefix = None;
            column.next = None;
            column.multiple = None;
            if let Some(relation) = strategy.and_then(|value| value.get("relation")) {
                column.relation = relation.as_str().map(ToOwned::to_owned);
            }
            if let Some(limit) = strategy.and_then(|value| value.get("limit")) {
                column.limit = if limit.is_null() {
                    None
                } else {
                    Some(
                        serde_yml::from_value(limit.clone())
                            .map_err(|e| schema_error(format!("invalid relation limit: {e}")))?,
                    )
                };
            }
            if let Some(two_way) = strategy.and_then(|value| value.get("two_way")) {
                column.two_way = two_way.as_str().map(ToOwned::to_owned);
            }
        }
        PropertyType::UniqueId => {
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.relation = None;
            column.limit = None;
            column.two_way = None;
            column.multiple = None;
            column.prefix = strategy
                .and_then(|value| value.get("prefix"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| column.prefix.clone());
            column.prefix = trim_unique_id_prefix(column.prefix.take());
            column.next = Some(column.next.unwrap_or(1).max(1));
        }
        PropertyType::Actor | PropertyType::Person => {
            column.type_ = PropertyType::Actor;
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.relation = None;
            column.limit = None;
            column.two_way = None;
            column.prefix = None;
            column.next = None;
            let multiple = strategy
                .and_then(|value| value.get("multiple"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| column.multiple.unwrap_or(false));
            column.multiple = Some(multiple);
        }
        _ => {
            column.options = None;
            column.relation = None;
            column.limit = None;
            column.two_way = None;
            column.prefix = None;
            column.next = None;
            column.multiple = None;
        }
    }
    Ok(())
}

fn apply_status_groups(column: &mut Column, groups: &Value) -> Result<(), AppError> {
    let mapping = groups
        .as_mapping()
        .ok_or_else(|| schema_error("groups strategy must be an object"))?;
    let options = column.options.get_or_insert_with(Vec::new);
    for option in options {
        let Some(group_value) = mapping.get(option.name.as_str()) else {
            continue;
        };
        option.group = Some(
            serde_yml::from_value(group_value.clone())
                .map_err(|e| schema_error(format!("invalid status group: {e}")))?,
        );
    }
    Ok(())
}

fn convert_value_for_type_from_old(
    value: Value,
    old_column: Option<&Column>,
    column: &Column,
) -> Value {
    if old_column.is_some_and(|old| old.type_ == PropertyType::UniqueId)
        && column.type_ == PropertyType::Text
        && let Some(number) = unique_id_value(&value)
    {
        return Value::String(unique_id_display_value(old_column.unwrap(), number));
    }
    convert_value_for_type(value, column)
}

fn unique_id_display_value(column: &Column, number: u64) -> String {
    if let Some(prefix) = column.prefix.as_deref().filter(|prefix| !prefix.is_empty()) {
        format!("{prefix}-{number}")
    } else {
        number.to_string()
    }
}

fn convert_value_for_type(value: Value, column: &Column) -> Value {
    let original = value.clone();
    let converted = match column.type_ {
        PropertyType::Text => value_to_scalar_string(&value).map(Value::String),
        PropertyType::Number => {
            value_to_f64(&value).and_then(|number| serde_yml::to_value(number).ok())
        }
        PropertyType::UniqueId => value_to_unique_id_number(&value).map(yaml_u64),
        PropertyType::Select | PropertyType::Status => {
            value_to_first_string(&value).map(Value::String)
        }
        PropertyType::MultiSelect => match value {
            Value::Sequence(sequence) => Some(Value::Sequence(
                sequence
                    .into_iter()
                    .filter_map(|item| value_to_scalar_string(&item).map(Value::String))
                    .collect(),
            )),
            other => value_to_scalar_string(&other)
                .map(|item| Value::Sequence(vec![Value::String(item)])),
        },
        PropertyType::Checkbox => value_to_bool(&value).map(Value::Bool),
        PropertyType::Date => {
            if validate_date_value(&column.name, &value).is_ok() {
                Some(value)
            } else {
                value_to_scalar_string(&value).map(Value::String)
            }
        }
        PropertyType::Actor | PropertyType::Person => normalize_actor_value(column, value).ok(),
        PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
            value_to_scalar_string(&value).map(Value::String)
        }
        PropertyType::Relation => convert_value_for_relation(value, column),
    };

    converted
        .filter(|converted| validate_property_value(column, converted).is_ok())
        .unwrap_or(original)
}

fn value_to_scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_to_first_string(value: &Value) -> Option<String> {
    match value {
        Value::Sequence(sequence) => sequence.iter().find_map(value_to_scalar_string),
        other => value_to_scalar_string(other),
    }
}

fn value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(_) => value.as_f64(),
        Value::String(value) => value.trim().parse::<f64>().ok(),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn value_to_unique_id_number(value: &Value) -> Option<u64> {
    match value {
        Value::Number(_) => unique_id_value(value),
        Value::String(value) => value
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|number| *number >= 1),
        _ => None,
    }
}

fn value_to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(_) => value.as_f64().map(|number| number != 0.0),
        Value::String(value) => match value.trim().to_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn convert_value_for_relation(value: Value, column: &Column) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    if column.limit == Some(RelationLimit::One) {
        return value_to_first_string(&value)
            .and_then(|raw| normalize_relation_value_shape(&raw).ok())
            .map(Value::String);
    }
    match value {
        Value::Sequence(sequence) => {
            let mut seen = HashSet::new();
            let values = sequence
                .into_iter()
                .filter_map(|item| value_to_scalar_string(&item))
                .filter_map(|raw| normalize_relation_value_shape(&raw).ok())
                .filter(|normalized| seen.insert(normalized.clone()))
                .map(Value::String)
                .collect();
            Some(Value::Sequence(values))
        }
        other => value_to_scalar_string(&other)
            .and_then(|raw| normalize_relation_value_shape(&raw).ok())
            .map(|item| Value::Sequence(vec![Value::String(item)])),
    }
}

fn convert_value_for_relation_change(
    space: &str,
    column: &Column,
    value: Value,
) -> Result<(Option<Value>, Option<Value>), AppError> {
    if value.is_null() {
        return Ok((None, None));
    }
    let relation = column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;

    if column.limit == Some(RelationLimit::One) {
        let mut converted = None;
        let mut extra = Vec::new();
        let items = match value {
            Value::Sequence(sequence) => sequence,
            other => vec![other],
        };
        for item in items {
            let Some(raw) = value_to_scalar_string(&item) else {
                extra.push(item);
                continue;
            };
            match canonicalize_relation_target_value(space, relation, &raw) {
                Ok(value) if converted.is_none() => {
                    converted = Some(Value::String(value));
                }
                Ok(_) | Err(_) => extra.push(Value::String(raw)),
            }
        }
        let extra = match extra.len() {
            0 => None,
            1 => Some(extra.remove(0)),
            _ => Some(Value::Sequence(extra)),
        };
        return Ok((converted, extra));
    }

    let mut seen = HashSet::new();
    let mut converted = Vec::new();
    let mut extra = Vec::new();
    match value {
        Value::Sequence(sequence) => {
            for item in sequence {
                let Some(raw) = value_to_scalar_string(&item) else {
                    extra.push(item);
                    continue;
                };
                match canonicalize_relation_target_value(space, relation, &raw) {
                    Ok(value) if seen.insert(value.clone()) => {
                        converted.push(Value::String(value));
                    }
                    Ok(_) => {}
                    Err(_) => extra.push(Value::String(raw)),
                }
            }
        }
        other => {
            let Some(raw) = value_to_scalar_string(&other) else {
                return Ok((None, Some(other)));
            };
            match canonicalize_relation_target_value(space, relation, &raw) {
                Ok(value) => converted.push(Value::String(value)),
                Err(_) => extra.push(Value::String(raw)),
            }
        }
    }

    let converted = (!converted.is_empty()).then_some(Value::Sequence(converted));
    let extra = match extra.len() {
        0 => None,
        1 => Some(extra.remove(0)),
        _ => Some(Value::Sequence(extra)),
    };
    Ok((converted, extra))
}

fn unique_extra_field_name(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
    base: &str,
) -> Result<String, AppError> {
    let mut used: HashSet<String> = schema
        .columns
        .iter()
        .map(|column| column.name.clone())
        .collect();
    for file in collection_markdown_files(space, collection_path)? {
        let raw = fs::read_to_string(file)?;
        if let Some((meta, _)) = frontmatter::try_parse(&raw)? {
            used.extend(meta.extra.keys().cloned());
        }
    }
    if !used.contains(base) {
        return Ok(base.to_string());
    }
    for index in 2..=1000 {
        let candidate = format!("{base} {index}");
        if !used.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "{base} {}",
        ulid::Ulid::new().to_string().to_lowercase()
    ))
}

fn replace_string_refs_in_views(views: &mut [View], old: &str, new: &str) {
    for view in views {
        replace_string_refs_in_view(view, old, new);
    }
}

fn replace_string_refs_in_view(view: &mut View, old: &str, new: &str) {
    for filter in filters_mut(view) {
        if filter.field == old {
            filter.field = new.to_string();
        }
    }
    replace_sort_refs_in_view(view, old, new);
    match view {
        View::Table { visible_fields, .. } => replace_field_list(visible_fields, old, new),
        View::Board {
            group_by,
            card_fields,
            ..
        } => {
            replace_opt_field(group_by, old, new);
            replace_field_list(card_fields, old, new);
        }
        View::Calendar {
            date_field,
            color_field,
            card_fields,
            ..
        } => {
            replace_opt_field(date_field, old, new);
            replace_opt_field(color_field, old, new);
            replace_field_list(card_fields, old, new);
        }
        View::List { card_fields, .. } => replace_field_list(card_fields, old, new),
        View::Gallery {
            card_cover,
            card_fields,
            ..
        } => {
            if let Some(card_cover) = card_cover {
                replace_field_list(card_cover, old, new);
            }
            replace_field_list(card_fields, old, new);
        }
    }
}

fn filters_mut(view: &mut View) -> &mut Vec<Filter> {
    match view {
        View::Table { filter, .. }
        | View::Board { filter, .. }
        | View::Calendar { filter, .. }
        | View::List { filter, .. }
        | View::Gallery { filter, .. } => filter,
    }
}

fn replace_sort_refs_in_view(view: &mut View, old: &str, new: &str) {
    let sorts = match view {
        View::Table { sort, .. }
        | View::Board { sort, .. }
        | View::List { sort, .. }
        | View::Gallery { sort, .. } => Some(sort),
        View::Calendar { .. } => None,
    };
    if let Some(sorts) = sorts {
        for sort in sorts {
            if sort.field == old {
                sort.field = new.to_string();
            }
        }
    }
}

fn retain_sort_refs_in_view(view: &mut View, target: &str) {
    let sorts = match view {
        View::Table { sort, .. }
        | View::Board { sort, .. }
        | View::List { sort, .. }
        | View::Gallery { sort, .. } => Some(sort),
        View::Calendar { .. } => None,
    };
    if let Some(sorts) = sorts {
        sorts.retain(|sort| sort.field != target);
    }
}

fn replace_field_list(fields: &mut [String], old: &str, new: &str) {
    for field in fields {
        if field == old {
            *field = new.to_string();
        }
    }
}

fn replace_opt_field(field: &mut Option<String>, old: &str, new: &str) {
    if field.as_deref() == Some(old) {
        *field = Some(new.to_string());
    }
}

fn strip_string_refs_in_views(views: &mut [View], target: &str) {
    for view in views {
        strip_string_refs_in_view(view, target);
    }
}

fn strip_string_refs_in_view(view: &mut View, target: &str) {
    filters_mut(view).retain(|filter| filter.field != target);
    retain_sort_refs_in_view(view, target);
    match view {
        View::Table { visible_fields, .. } => retain_not_field(visible_fields, target),
        View::Board {
            group_by,
            card_fields,
            ..
        } => {
            if group_by.as_deref() == Some(target) {
                *group_by = None;
            }
            retain_not_field(card_fields, target);
        }
        View::Calendar {
            date_field,
            color_field,
            card_fields,
            ..
        } => {
            if date_field.as_deref() == Some(target) {
                *date_field = None;
            }
            if color_field.as_deref() == Some(target) {
                *color_field = None;
            }
            retain_not_field(card_fields, target);
        }
        View::List { card_fields, .. } => retain_not_field(card_fields, target),
        View::Gallery {
            card_cover,
            card_fields,
            ..
        } => {
            if let Some(card_cover) = card_cover {
                retain_not_field(card_cover, target);
            }
            retain_not_field(card_fields, target);
        }
    }
}

fn retain_not_field(fields: &mut Vec<String>, target: &str) {
    fields.retain(|field| field != target);
}

fn replace_option_value(value: &mut Value, old: &str, new: &str) {
    match value {
        Value::String(value) if value == old => *value = new.to_string(),
        Value::Sequence(sequence) => {
            for item in sequence {
                replace_option_value(item, old, new);
            }
        }
        _ => {}
    }
}

fn delete_option_value(value: &mut Value, option_name: &str) {
    if value.as_str() == Some(option_name) {
        *value = Value::Null;
        return;
    }
    if let Value::Sequence(sequence) = value {
        sequence.retain(|item| item.as_str() != Some(option_name));
    }
}

fn apply_option_patch(option: &mut PropertyOption, patch: Value) -> Result<(), AppError> {
    let mapping = patch
        .as_mapping()
        .ok_or_else(|| schema_error("option patch must be an object"))?;

    if mapping.contains_key("color") {
        option.color = nullable_from_mapping(mapping, "color")?;
    }
    if mapping.contains_key("icon") {
        option.icon = nullable_from_mapping(mapping, "icon")?;
    }
    if mapping.contains_key("group") {
        option.group = nullable_from_mapping(mapping, "group")?;
    }
    Ok(())
}

fn apply_column_patch(column: &mut Column, patch: Value) -> Result<(), AppError> {
    let mapping = patch
        .as_mapping()
        .ok_or_else(|| schema_error("column patch must be an object"))?;

    if mapping.contains_key("display") {
        column.display = nullable_from_mapping(mapping, "display")?;
    }
    if mapping.contains_key("min") {
        column.min = nullable_from_mapping(mapping, "min")?;
    }
    if mapping.contains_key("max") {
        column.max = nullable_from_mapping(mapping, "max")?;
    }
    if mapping.contains_key("color") {
        column.color = nullable_from_mapping(mapping, "color")?;
    }
    if mapping.contains_key("sensitivity") {
        column.sensitivity = nullable_from_mapping(mapping, "sensitivity")?;
    }
    if mapping.contains_key("time_by_default") {
        column.time_by_default = nullable_from_mapping(mapping, "time_by_default")?;
    }
    if mapping.contains_key("range_by_default") {
        column.range_by_default = nullable_from_mapping(mapping, "range_by_default")?;
    }
    if mapping.contains_key("options") {
        column.options = nullable_from_mapping(mapping, "options")?;
    }
    if mapping.contains_key("relation") {
        column.relation = nullable_from_mapping(mapping, "relation")?;
    }
    if mapping.contains_key("limit") {
        column.limit = nullable_from_mapping(mapping, "limit")?;
    }
    if mapping.contains_key("two_way") {
        column.two_way = nullable_from_mapping(mapping, "two_way")?;
    }
    if mapping.contains_key("prefix") {
        column.prefix = nullable_from_mapping(mapping, "prefix")?;
        column.prefix = trim_unique_id_prefix(column.prefix.take());
    }
    if mapping.contains_key("multiple") {
        column.multiple = nullable_from_mapping(mapping, "multiple")?;
    }
    Ok(())
}

fn nullable_from_mapping<T>(mapping: &Mapping, key: &str) -> Result<Option<T>, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let Some(value) = mapping.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        Ok(None)
    } else {
        serde_yml::from_value(value.clone())
            .map(Some)
            .map_err(|e| schema_error(format!("invalid {key}: {e}")))
    }
}

fn collection_markdown_files(space: &str, collection_path: &str) -> Result<Vec<PathBuf>, AppError> {
    let collection_root = collection_rel(collection_path);
    let root = collection_dir(space, collection_path);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for file in collect_md_files(&root)? {
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

fn collect_md_files(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    collect_md_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_md_files_inner(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_md_files_inner(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
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

pub async fn list_persons(
    cache: &PersonCacheState,
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<Person>, AppError> {
    if let Some(people) = cache.get(space_path, all_time) {
        return Ok(people);
    }
    refresh_persons(cache, cli, space_path, all_time).await
}

pub async fn refresh_persons(
    cache: &PersonCacheState,
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<Person>, AppError> {
    let people = load_persons(cli, space_path, all_time).await?;
    cache.set(space_path, all_time, people.clone());
    Ok(people)
}

async fn load_persons(
    cli: &GitCli,
    space_path: &Path,
    all_time: bool,
) -> Result<Vec<Person>, AppError> {
    let mut args = vec!["log", "--use-mailmap", "--all", "--format=%aN|%aE|%at"];
    if !all_time {
        args.push("--since=6 months ago");
    }

    let mut people: HashMap<String, Person> = HashMap::new();
    let output = cli.exec(space_path, &args).await?;
    if output.exit_code == 0 {
        for line in output.stdout.lines() {
            let mut parts = line.splitn(3, '|');
            let name = parts.next().unwrap_or("").trim();
            let email = parts.next().unwrap_or("").trim();
            let ts = parts.next().unwrap_or("").trim().parse::<i64>().ok();
            if email.is_empty() {
                continue;
            }
            let canonical = canonicalize_person(cli, space_path, name, email).await?;
            let entry = people.entry(canonical.clone()).or_insert_with(|| Person {
                email: canonical,
                name: if name.is_empty() {
                    email.to_string()
                } else {
                    name.to_string()
                },
                last_commit_at: ts,
                commit_count: 0,
                is_me: false,
            });
            entry.commit_count += 1;
            if ts > entry.last_commit_at {
                entry.last_commit_at = ts;
                if !name.is_empty() {
                    entry.name = name.to_string();
                }
            }
        }
    }

    let me = current_git_person(cli, space_path).await?;
    let me_email = if let Some((name, email)) = me {
        let canonical = canonicalize_person(cli, space_path, &name, &email).await?;
        let entry = people.entry(canonical.clone()).or_insert_with(|| Person {
            email: canonical.clone(),
            name: if name.is_empty() {
                canonical.clone()
            } else {
                name
            },
            last_commit_at: None,
            commit_count: 0,
            is_me: true,
        });
        entry.is_me = true;
        Some(canonical)
    } else {
        None
    };

    let mut people: Vec<Person> = people.into_values().collect();
    if let Some(me_email) = me_email {
        for person in &mut people {
            person.is_me = person.email == me_email;
        }
    }

    people.sort_by(|a, b| {
        b.is_me
            .cmp(&a.is_me)
            .then_with(|| b.last_commit_at.cmp(&a.last_commit_at))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.email.cmp(&b.email))
    });

    Ok(people)
}

async fn current_git_person(
    cli: &GitCli,
    space_path: &Path,
) -> Result<Option<(String, String)>, AppError> {
    let name = git_config_value(cli, space_path, "user.name").await?;
    let email = git_config_value(cli, space_path, "user.email").await?;
    Ok(email.map(|email| (name.unwrap_or_default(), email)))
}

async fn git_config_value(
    cli: &GitCli,
    space_path: &Path,
    key: &str,
) -> Result<Option<String>, AppError> {
    let output = cli.exec(space_path, &["config", "--get", key]).await?;
    if output.exit_code != 0 {
        return Ok(None);
    }
    let value = output.stdout.trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

async fn canonicalize_person(
    cli: &GitCli,
    space_path: &Path,
    name: &str,
    email: &str,
) -> Result<String, AppError> {
    let identity = if name.trim().is_empty() {
        format!("<{}>", email.trim())
    } else {
        format!("{} <{}>", name.trim(), email.trim())
    };
    let output = cli.exec(space_path, &["check-mailmap", &identity]).await?;
    if output.exit_code == 0 {
        if let Some((_, mapped_email)) = parse_identity(output.stdout.trim()) {
            return Ok(mapped_email.to_lowercase());
        }
    }
    Ok(email.trim().to_lowercase())
}

fn parse_identity(raw: &str) -> Option<(String, String)> {
    let end = raw.rfind('>')?;
    let start = raw[..end].rfind('<')?;
    let name = raw[..start].trim().to_string();
    let email = raw[start + 1..end].trim().to_string();
    (!email.is_empty()).then_some((name, email))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_column(name: &str, type_: PropertyType) -> Column {
        Column {
            name: name.into(),
            type_,
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
            limit: None,
            two_way: None,
            prefix: None,
            next: None,
            multiple: None,
        }
    }

    #[test]
    fn schema_roundtrips_utf8_names_and_mixed_options() {
        let raw = r#"
columns:
  - name: "Статус"
    type: status
    default: "В работе"
    options:
      - { name: "Сделать", group: todo, color: blue }
      - { name: "В работе", group: in_progress, color: yellow }
      - { name: "Готово", group: done, color: green }
  - name: "Метки"
    type: multi_select
    options:
      - "Баг"
      - { name: "Фича", color: purple, icon: "▶" }
views: []
"#;
        let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
        validate_schema(&schema).unwrap();
        assert_eq!(schema.columns[0].name, "Статус");
        assert_eq!(schema.columns[1].options.as_ref().unwrap()[0].name, "Баг");

        let serialized = serde_yml::to_string(&schema).unwrap();
        let parsed: CollectionSchema = serde_yml::from_str(&serialized).unwrap();
        assert_eq!(parsed.columns[0].name, "Статус");
        assert_eq!(parsed.columns[1].options.as_ref().unwrap()[1].name, "Фича");
    }

    #[test]
    fn relation_schema_roundtrips_yaml_shape() {
        let raw = r#"
columns:
  - name: Sprint
    type: relation
    relation: sprints
    limit: one
    two_way: Tasks
views: []
"#;
        let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
        validate_schema(&schema).unwrap();
        let column = &schema.columns[0];
        assert_eq!(column.type_, PropertyType::Relation);
        assert_eq!(column.relation.as_deref(), Some("sprints"));
        assert_eq!(column.limit, Some(RelationLimit::One));
        assert_eq!(column.two_way.as_deref(), Some("Tasks"));

        let serialized = serde_yml::to_string(&schema).unwrap();
        assert!(serialized.contains("type: relation"));
        assert!(serialized.contains("relation: sprints"));
        assert!(serialized.contains("limit: one"));
        assert!(serialized.contains("two_way: Tasks"));
    }

    #[test]
    fn sensitivity_defaults_phone_email_and_preserves_explicit_none() {
        let mut schema: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Email, type: email }
  - { name: Phone, type: phone }
  - { name: PublicPhone, type: phone, sensitivity: none }
  - { name: Owner, type: actor }
  - { name: Notes, type: text }
views: []
"#,
        )
        .unwrap();

        normalize_schema(&mut schema);

        assert_eq!(schema.columns[0].sensitivity, Some(ColumnSensitivity::Pii));
        assert_eq!(schema.columns[1].sensitivity, Some(ColumnSensitivity::Pii));
        assert_eq!(schema.columns[2].sensitivity, Some(ColumnSensitivity::None));
        assert_eq!(
            column_effective_sensitivity(&schema.columns[2]),
            ColumnSensitivity::None
        );
        assert_eq!(schema.columns[3].sensitivity, None);
        assert_eq!(
            column_effective_sensitivity(&schema.columns[3]),
            ColumnSensitivity::None
        );
        assert_eq!(schema.columns[4].sensitivity, None);
        assert!(schema_has_sensitive_columns(&schema));
    }

    #[test]
    fn read_schema_applies_sensitivity_defaults_and_accepts_legacy_schema() {
        let tmp = TempDir::new().unwrap();
        let schema_path = tmp.path().join("schema.yaml");
        fs::write(
            &schema_path,
            "columns:\n  - { name: Email, type: email }\n  - { name: Title, type: text }\nviews: []\n",
        )
        .unwrap();

        let schema = read_schema_at(&schema_path).unwrap();
        assert_eq!(schema.columns[0].sensitivity, Some(ColumnSensitivity::Pii));
        assert_eq!(schema.columns[1].sensitivity, None);
    }

    #[test]
    fn relation_value_shape_normalizes_unique_many_and_rejects_dot_segments() {
        let column = Column {
            name: "Tasks".into(),
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
            relation: Some("tasks".into()),
            limit: None,
            two_way: None,
            prefix: None,
            next: None,
            multiple: None,
        };
        let value: Value = serde_yml::from_str("[a.md, a.md, folder/README.md]").unwrap();
        let normalized = validate_relation_value_shape(&column, &value).unwrap();
        assert_eq!(normalized, vec!["a.md", "folder/README.md"]);

        let bad: Value = serde_yml::from_str("../a.md").unwrap();
        assert!(validate_relation_value_shape(&column, &bad).is_err());
    }

    #[test]
    fn copy_rewrite_updates_internal_relation_values_in_same_collection() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks/folder")).unwrap();
        fs::create_dir_all(space.join("tasks/folder-copy")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Related\n    type: relation\n    relation: tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nRelated:\n  - folder/b.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder/b.md"),
            "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder-copy/a.md"),
            "---\nid: a2\ntitle: A copy\ncreated: now\nupdated: now\nRelated:\n  - folder/b.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder-copy/b.md"),
            "---\nid: b2\ntitle: B copy\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        rewrite_internal_relation_refs_for_copy(
            space.to_str().unwrap(),
            "tasks/folder",
            "tasks/folder-copy",
        )
        .unwrap();

        let raw = fs::read_to_string(space.join("tasks/folder-copy/a.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        let related = meta.extra.get("Related").unwrap().as_sequence().unwrap();
        assert_eq!(related[0].as_str(), Some("folder-copy/b.md"));
    }

    #[test]
    fn move_rewrite_updates_descendant_relation_values_in_same_collection() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks/folder/sub")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Related\n    type: relation\n    relation: tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/links.md"),
            "---\nid: links\ntitle: Links\ncreated: now\nupdated: now\nRelated:\n  - folder/a.md\n  - folder/sub/b.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/folder/sub/b.md"),
            "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::rename(space.join("tasks/folder"), space.join("tasks/moved")).unwrap();

        rewrite_relation_paths_for_move(space.to_str().unwrap(), "tasks/folder", "tasks/moved")
            .unwrap();

        let raw = fs::read_to_string(space.join("tasks/links.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        let related: Vec<_> = meta
            .extra
            .get("Related")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(related, vec!["moved/a.md", "moved/sub/b.md"]);
    }

    #[tokio::test]
    async fn move_to_another_collection_keeps_old_relation_out_of_scope() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("archive")).unwrap();
        fs::create_dir_all(space.join("projects")).unwrap();
        fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
        fs::write(
            space.join("archive/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("projects/schema.yaml"),
            "columns:\n  - name: Work\n    type: relation\n    relation: tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("projects/p.md"),
            "---\nid: p\ntitle: Project\ncreated: now\nupdated: now\nWork: a.md\n---\n",
        )
        .unwrap();
        fs::rename(space.join("tasks/a.md"), space.join("archive/a.md")).unwrap();

        rewrite_relation_paths_for_move(space.to_str().unwrap(), "tasks/a.md", "archive/a.md")
            .unwrap();

        let raw = fs::read_to_string(space.join("projects/p.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        let work_values: Vec<_> = meta
            .extra
            .get("Work")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(work_values, vec!["archive/a.md"]);

        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                icon TEXT,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO entries (
                file_path, title, icon, description, created, updated, collection_root_path,
                in_collection, is_entry_head, fields
            ) VALUES ('archive/a.md', 'A', NULL, NULL, '2026-01-01', '2026-01-01', 'archive', 1, 1, '{}')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let resolved = resolve_relation(&pool, "tasks", "archive/a.md")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved.file_path, "archive/a.md");
        assert_eq!(resolved.collection_root_path, "archive");

        let batch = resolve_relations_batch(&pool, "tasks", &["archive/a.md".to_string()])
            .await
            .unwrap();
        assert_eq!(batch[0].as_ref().unwrap().file_path, "archive/a.md");
    }

    #[test]
    fn change_schema_type_to_relation_preserves_unconverted_values_as_orphan_extra() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: text\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-1.md"),
            "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/b.md"),
            "---\nid: b\ntitle: B\ncreated: now\nupdated: now\nSprint: missing.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/c.md"),
            "---\nid: c\ntitle: C\ncreated: now\nupdated: now\nSprint:\n  - sprint-1.md\n  - missing-2.md\n---\n",
        )
        .unwrap();

        let strategy: Value = serde_yml::from_str("relation: sprints\nlimit: one\n").unwrap();
        let (schema, warnings) = change_schema_type_with_warnings(
            space.to_str().unwrap(),
            "tasks",
            "Sprint",
            PropertyType::Relation,
            Some(strategy),
        )
        .unwrap();

        assert_eq!(schema.columns[0].type_, PropertyType::Relation);
        assert_eq!(schema.columns[0].relation.as_deref(), Some("sprints"));
        assert_eq!(schema.columns[0].limit, Some(RelationLimit::One));
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, "relation_unconverted_values");
        assert_eq!(warnings[0].field, "Sprint (unconverted)");
        assert_eq!(warnings[0].count, 2);

        let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra.get("Sprint").and_then(Value::as_str),
            Some("sprint-1.md")
        );
        assert!(!meta.extra.contains_key("Sprint (unconverted)"));

        let raw = fs::read_to_string(space.join("tasks/b.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert!(!meta.extra.contains_key("Sprint"));
        assert_eq!(
            meta.extra
                .get("Sprint (unconverted)")
                .and_then(Value::as_str),
            Some("missing.md")
        );

        let raw = fs::read_to_string(space.join("tasks/c.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra.get("Sprint").and_then(Value::as_str),
            Some("sprint-1.md")
        );
        assert_eq!(
            meta.extra
                .get("Sprint (unconverted)")
                .and_then(Value::as_str),
            Some("missing-2.md")
        );
    }

    #[test]
    fn two_way_relation_rejects_limit_one_reverse_column() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    limit: one\nviews: []\n",
        )
        .unwrap();

        let column = Column {
            name: "Sprint".into(),
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
            relation: Some("sprints".into()),
            limit: None,
            two_way: Some("Tasks".into()),
            prefix: None,
            next: None,
            multiple: None,
        };

        assert!(add_schema_column(space.to_str().unwrap(), "tasks", column).is_err());
    }

    #[test]
    fn two_way_relation_diagnoses_and_creates_missing_reverse_column() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-1.md"),
            "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        let diagnostics =
            diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
        assert_eq!(
            diagnostics.schema_status,
            RelationTwoWaySchemaStatus::MissingReverse
        );
        assert_eq!(diagnostics.reverse_column.as_deref(), Some("Tasks"));

        repair_two_way_relation(
            space.to_str().unwrap(),
            "tasks",
            "Sprint",
            "create_reverse_column",
            Some("Tasks"),
        )
        .unwrap();

        let source_schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
        let reverse_schema = read_collection_schema(space.to_str().unwrap(), "sprints").unwrap();
        assert_eq!(source_schema.columns[0].two_way.as_deref(), Some("Tasks"));
        let reverse = reverse_schema
            .columns
            .iter()
            .find(|column| column.name == "Tasks")
            .unwrap();
        assert_eq!(reverse.type_, PropertyType::Relation);
        assert_eq!(reverse.relation.as_deref(), Some("tasks"));
        assert_eq!(reverse.two_way.as_deref(), Some("Sprint"));

        let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        let tasks: Vec<_> = meta
            .extra
            .get("Tasks")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(tasks, vec!["a.md"]);

        let diagnostics =
            diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
        assert_eq!(diagnostics.schema_status, RelationTwoWaySchemaStatus::Ok);
        assert_eq!(diagnostics.drift.missing_reverse_count, 0);
        assert_eq!(diagnostics.drift.missing_source_count, 0);
    }

    #[test]
    fn two_way_relation_detects_and_repairs_value_drift() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: Sprint\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-1.md"),
            "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        let diagnostics =
            diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
        assert_eq!(diagnostics.schema_status, RelationTwoWaySchemaStatus::Ok);
        assert_eq!(diagnostics.drift.missing_reverse_count, 1);
        assert_eq!(diagnostics.drift.missing_source_count, 0);

        repair_two_way_relation(
            space.to_str().unwrap(),
            "tasks",
            "Sprint",
            "from_this_side",
            None,
        )
        .unwrap();
        let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra
                .get("Tasks")
                .unwrap()
                .as_sequence()
                .unwrap()
                .first()
                .unwrap()
                .as_str(),
            Some("a.md")
        );

        mutate_frontmatter(&space.join("tasks/a.md"), |meta| {
            meta.extra.remove("Sprint");
            Ok(())
        })
        .unwrap();
        let diagnostics =
            diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
        assert_eq!(diagnostics.drift.missing_reverse_count, 0);
        assert_eq!(diagnostics.drift.missing_source_count, 1);

        repair_two_way_relation(
            space.to_str().unwrap(),
            "tasks",
            "Sprint",
            "from_related_side",
            None,
        )
        .unwrap();
        let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra.get("Sprint").and_then(Value::as_str),
            Some("sprint-1.md")
        );
    }

    #[test]
    fn two_way_relation_reverse_side_update_allows_paired_limit_one() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: Sprint\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-1.md"),
            "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-2.md"),
            "---\nid: s2\ntitle: Sprint 2\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        update_relation_entry_field(
            space.to_str().unwrap(),
            "sprints/sprint-1.md",
            "Tasks",
            serde_yml::to_value(vec!["a.md"]).unwrap(),
        )
        .unwrap();

        let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra.get("Sprint").and_then(Value::as_str),
            Some("sprint-1.md")
        );

        let conflict = update_relation_entry_field(
            space.to_str().unwrap(),
            "sprints/sprint-2.md",
            "Tasks",
            serde_yml::to_value(vec!["a.md"]).unwrap(),
        );
        assert!(conflict.is_err());
    }

    #[test]
    fn two_way_relation_can_choose_compatible_reverse_column() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join("sprints")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Missing\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Work\n    type: relation\n    relation: tasks\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("sprints/sprint-1.md"),
            "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        let diagnostics =
            diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
        assert_eq!(
            diagnostics.schema_status,
            RelationTwoWaySchemaStatus::MissingReverse
        );
        assert_eq!(diagnostics.compatible_reverse_choices[0].name, "Work");

        repair_two_way_relation(
            space.to_str().unwrap(),
            "tasks",
            "Sprint",
            "choose_reverse_column",
            Some("Work"),
        )
        .unwrap();

        let source_schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
        let reverse_schema = read_collection_schema(space.to_str().unwrap(), "sprints").unwrap();
        assert_eq!(source_schema.columns[0].two_way.as_deref(), Some("Work"));
        assert_eq!(reverse_schema.columns[0].two_way.as_deref(), Some("Sprint"));

        let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
        let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
        assert_eq!(
            meta.extra
                .get("Work")
                .unwrap()
                .as_sequence()
                .unwrap()
                .first()
                .unwrap()
                .as_str(),
            Some("a.md")
        );
    }

    #[test]
    fn copy_rewrite_updates_relation_schema_roots_inside_copied_tree() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("source/a")).unwrap();
        fs::create_dir_all(space.join("source/b")).unwrap();
        fs::create_dir_all(space.join("copy/a")).unwrap();
        fs::create_dir_all(space.join("copy/b")).unwrap();
        fs::write(
            space.join("source/a/schema.yaml"),
            "columns:\n  - name: B\n    type: relation\n    relation: source/b\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("source/b/schema.yaml"),
            "columns:\n  - name: A\n    type: relation\n    relation: source/a\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("copy/a/schema.yaml"),
            "columns:\n  - name: B\n    type: relation\n    relation: source/b\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("copy/b/schema.yaml"),
            "columns:\n  - name: A\n    type: relation\n    relation: source/a\nviews: []\n",
        )
        .unwrap();

        rewrite_internal_relation_refs_for_copy(space.to_str().unwrap(), "source", "copy").unwrap();

        let schema_a = read_collection_schema(space.to_str().unwrap(), "copy/a").unwrap();
        let schema_b = read_collection_schema(space.to_str().unwrap(), "copy/b").unwrap();
        assert_eq!(schema_a.columns[0].relation.as_deref(), Some("copy/b"));
        assert_eq!(schema_b.columns[0].relation.as_deref(), Some("copy/a"));
    }

    #[test]
    fn schema_validation_rejects_reserved_duplicates_and_bad_status() {
        let duplicate = r#"
columns:
  - { name: title, type: text }
views: []
"#;
        let schema: CollectionSchema = serde_yml::from_str(duplicate).unwrap();
        assert!(validate_schema(&schema).is_err());

        let bad_status = r#"
columns:
  - name: Status
    type: status
    options: ["Todo"]
views: []
"#;
        let schema: CollectionSchema = serde_yml::from_str(bad_status).unwrap();
        assert!(validate_schema(&schema).is_err());
    }

    #[test]
    fn unique_id_and_actor_schema_shape_validate_and_normalize() {
        let raw = r#"
columns:
  - name: Key
    type: unique_id
    prefix: " ISSUE "
    next: 7
  - name: Assignee
    type: actor
    multiple: false
  - name: Reviewers
    type: actor
    multiple: true
views: []
"#;
        let mut schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
        normalize_schema(&mut schema);
        validate_schema(&schema).unwrap();
        assert_eq!(schema.columns[0].prefix.as_deref(), Some("ISSUE"));
        assert_eq!(schema.columns[1].multiple, Some(false));
        assert_eq!(schema.columns[2].multiple, Some(true));

        let hyphen_prefix: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Key, type: unique_id, prefix: "ISSUE-KEY", next: 1 }
views: []
"#,
        )
        .unwrap();
        validate_schema(&hyphen_prefix).unwrap();

        let bad_prefix: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Key, type: unique_id, prefix: "ISSUE KEY", next: 1 }
views: []
"#,
        )
        .unwrap();
        assert!(validate_schema(&bad_prefix).is_err());

        let duplicate_unique_id: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Key, type: unique_id, next: 1 }
  - { name: Other, type: unique_id, next: 2 }
views: []
"#,
        )
        .unwrap();
        assert!(validate_schema(&duplicate_unique_id).is_err());

        let mut legacy_person: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Owner, type: person }
views: []
"#,
        )
        .unwrap();
        normalize_schema(&mut legacy_person);
        assert_eq!(legacy_person.columns[0].type_, PropertyType::Actor);
        assert_eq!(legacy_person.columns[0].multiple, Some(false));
    }

    #[test]
    fn add_unique_id_materializes_existing_rows_and_sets_next() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::create_dir_all(space.join(".svode")).unwrap();
        fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
        fs::write(
            space.join(".svode/order.json"),
            r#"{"tasks":["b.md","a.md"]}"#,
        )
        .unwrap();
        fs::write(
            space.join("tasks/a.md"),
            "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/b.md"),
            "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
        )
        .unwrap();

        let mut column = test_column("Key", PropertyType::UniqueId);
        column.prefix = Some("ISSUE".into());
        let schema = add_schema_column(space.to_str().unwrap(), "tasks", column).unwrap();
        assert_eq!(schema.columns[0].next, Some(3));

        let b = entry::read(space.to_str().unwrap(), "tasks/b.md").unwrap();
        let a = entry::read(space.to_str().unwrap(), "tasks/a.md").unwrap();
        assert_eq!(b.meta.extra.get("Key").and_then(unique_id_value), Some(1));
        assert_eq!(a.meta.extra.get("Key").and_then(unique_id_value), Some(2));
    }

    #[test]
    fn unique_id_create_delete_duplicate_and_repair_do_not_reuse_numbers() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Key\n    type: unique_id\n    prefix: ISSUE\n    next: 1\nviews: []\n",
        )
        .unwrap();

        let first = entry::create(space.to_str().unwrap(), Some("tasks"), "First").unwrap();
        assert_eq!(
            first.meta.extra.get("Key").and_then(unique_id_value),
            Some(1)
        );
        fs::remove_file(space.join(&first.path)).unwrap();
        let second = entry::create(space.to_str().unwrap(), Some("tasks"), "Second").unwrap();
        assert_eq!(
            second.meta.extra.get("Key").and_then(unique_id_value),
            Some(2)
        );

        let duplicated = entry::duplicate_entry(space, &second.path).unwrap();
        assert_eq!(
            duplicated.meta.extra.get("Key").and_then(unique_id_value),
            Some(3)
        );

        let schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
        assert_eq!(schema.columns[0].next, Some(4));

        mutate_frontmatter(&space.join(&duplicated.path), |meta| {
            meta.extra.insert("Key".into(), yaml_u64(2));
            Ok(())
        })
        .unwrap();
        let repaired = assign_unique_id(space.to_str().unwrap(), &duplicated.path).unwrap();
        assert_eq!(
            repaired.meta.extra.get("Key").and_then(unique_id_value),
            Some(4)
        );
        let schema = normalize_unique_id_counter(space.to_str().unwrap(), "tasks").unwrap();
        assert_eq!(schema.columns[0].next, Some(5));
    }

    #[test]
    fn unique_id_update_is_readonly_and_actor_values_are_normalized() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, next: 1 }\n  - { name: Owner, type: actor, multiple: false }\n  - { name: Reviewers, type: actor, multiple: true }\nviews: []\n",
        )
        .unwrap();
        let created = entry::create(space.to_str().unwrap(), Some("tasks"), "Task").unwrap();

        assert!(
            entry::update_field(
                space.to_str().unwrap(),
                &created.path,
                "Key",
                serde_json::json!(99),
            )
            .is_err()
        );

        let updated = entry::update_field(
            space.to_str().unwrap(),
            &created.path,
            "Owner",
            serde_json::json!(" ME@EXAMPLE.COM "),
        )
        .unwrap();
        assert_eq!(
            updated.meta.extra.get("Owner").and_then(Value::as_str),
            Some("me@example.com")
        );

        let updated = entry::update_field(
            space.to_str().unwrap(),
            &created.path,
            "Reviewers",
            serde_json::json!(["A@Example.com", "a@example.com", "bad value"]),
        )
        .unwrap();
        let reviewers: Vec<_> = updated
            .meta
            .extra
            .get("Reviewers")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(reviewers, vec!["a@example.com", "bad value"]);
    }

    #[tokio::test]
    async fn unique_id_and_actor_query_filters_use_numeric_and_multi_semantics() {
        let schema: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - { name: Key, type: unique_id, prefix: ISSUE, next: 4 }
  - { name: Owner, type: actor, multiple: false }
  - { name: Reviewers, type: actor, multiple: true }
views: []
"#,
        )
        .unwrap();
        validate_schema(&schema).unwrap();

        let mut display_filter = Filter {
            field: "Key".into(),
            op: FilterOp::Eq,
            value: Some(Value::String("ISSUE-2".into())),
            values: None,
        };
        validate_filter_op(&schema, &display_filter).unwrap();
        normalize_filter_values_for_query(&schema, &mut display_filter).unwrap();
        assert_eq!(
            display_filter.value.as_ref().and_then(unique_id_value),
            Some(2)
        );

        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        for (path, title, fields) in [
            (
                "tasks/a.md",
                "A",
                serde_json::json!({"Key":10,"Owner":"me@example.com","Reviewers":["a@example.com"]}),
            ),
            (
                "tasks/b.md",
                "B",
                serde_json::json!({"Key":2,"Owner":"other@example.com","Reviewers":["me@example.com"]}),
            ),
            (
                "tasks/c.md",
                "C",
                serde_json::json!({"Key":3,"Owner":"me@example.com","Reviewers":["other@example.com"]}),
            ),
            (
                "tasks/d.md",
                "D",
                serde_json::json!({"Key":11,"Owner":"other@example.com","Reviewers":["z@example.com","a@example.com"]}),
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO entries (
                    file_path, title, description, created, updated, collection_root_path,
                    in_collection, is_entry_head, fields
                ) VALUES (?, ?, NULL, '2026-01-01', '2026-01-01', 'tasks', 1, 1, ?)
                "#,
            )
            .bind(path)
            .bind(title)
            .bind(fields.to_string())
            .execute(&pool)
            .await
            .unwrap();
        }

        let filters = vec![Filter {
            field: "Reviewers".into(),
            op: FilterOp::Contains,
            value: Some(Value::String("me@example.com".into())),
            values: None,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &filters, &[], None, None)
            .await
            .unwrap();
        let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["B"]);

        let sort = vec![Sort {
            field: "Key".into(),
            desc: false,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &[], &sort, None, None)
            .await
            .unwrap();
        let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["B", "C", "A", "D"]);

        let sort = vec![Sort {
            field: "Reviewers".into(),
            desc: false,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &[], &sort, None, None)
            .await
            .unwrap();
        let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["A", "B", "C", "D"]);
    }

    #[test]
    fn resolver_uses_readme_parent_exception() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks/sub")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Priority\n    type: text\nviews: []\n",
        )
        .unwrap();
        fs::write(
            space.join("tasks/sub/schema.yaml"),
            "columns:\n  - name: Inner\n    type: text\nviews: []\n",
        )
        .unwrap();

        let (_, root) =
            resolve_collection_schema_result(space.to_str().unwrap(), "tasks/sub/README.md")
                .unwrap()
                .unwrap();
        assert_eq!(root, PathBuf::from("tasks"));

        let (_, root) =
            resolve_collection_schema_result(space.to_str().unwrap(), "tasks/sub/item.md")
                .unwrap()
                .unwrap();
        assert_eq!(root, PathBuf::from("tasks/sub"));
    }

    #[test]
    fn date_range_must_be_homogeneous() {
        let column = Column {
            name: "Due".into(),
            type_: PropertyType::Date,
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
            limit: None,
            two_way: None,
            prefix: None,
            next: None,
            multiple: None,
        };
        let ok: Value = serde_yml::from_str("start: 2026-04-20\nend: 2026-04-22\n").unwrap();
        validate_property_value(&column, &ok).unwrap();

        let bad: Value = serde_yml::from_str("start: 2026-04-20T09:00\nend: 2026-04-22\n").unwrap();
        assert!(validate_property_value(&column, &bad).is_err());
    }

    #[test]
    fn query_validation_enforces_operator_matrix_and_macros() {
        let raw = r#"
columns:
  - { name: Effort, type: number }
  - { name: Due, type: date }
  - name: Status
    type: status
    options:
      - { name: Todo, group: todo }
      - { name: Doing, group: in_progress }
      - { name: Done, group: done }
  - name: Tags
    type: multi_select
    options: [Bug, Feature]
views:
  - type: table
    name: Valid
    filter:
      - { field: Due, op: before, value: "@today+3" }
      - { field: Status, op: group_in, values: [todo, done] }
    sort:
      - { field: Tags }
    visible_fields: [title]
"#;
        let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
        validate_schema(&schema).unwrap();

        let bad_op = r#"
columns:
  - { name: Effort, type: number }
views:
  - type: table
    name: Bad
    filter:
      - { field: Effort, op: contains, value: "1" }
"#;
        let schema: CollectionSchema = serde_yml::from_str(bad_op).unwrap();
        assert!(validate_schema(&schema).is_err());

        let bad_macro = r#"
columns:
  - { name: Due, type: date }
views:
  - type: table
    name: Bad
    filter:
      - { field: Due, op: before, value: "@today+soon" }
"#;
        let schema: CollectionSchema = serde_yml::from_str(bad_macro).unwrap();
        assert!(validate_schema(&schema).is_err());
    }

    #[test]
    fn filtered_reorder_inserts_against_visible_positions() {
        let full = vec![
            "a.md".to_string(),
            "hidden-1.md".to_string(),
            "b.md".to_string(),
            "hidden-2.md".to_string(),
            "c.md".to_string(),
        ];
        let visible = vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()];

        let reordered = reorder_visible_entry_names(&full, &visible, "c.md", 1).unwrap();
        assert_eq!(
            reordered,
            vec![
                "a.md".to_string(),
                "hidden-1.md".to_string(),
                "c.md".to_string(),
                "b.md".to_string(),
                "hidden-2.md".to_string(),
            ]
        );

        let reordered = reorder_visible_entry_names(&full, &visible, "a.md", 2).unwrap();
        assert_eq!(
            reordered,
            vec![
                "hidden-1.md".to_string(),
                "b.md".to_string(),
                "hidden-2.md".to_string(),
                "c.md".to_string(),
                "a.md".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn query_sql_filters_groups_and_sorts_option_indexes() {
        let schema: CollectionSchema = serde_yml::from_str(
            r#"
columns:
  - name: Priority
    type: select
    options: [Low, High]
  - name: Status
    type: status
    options:
      - { name: Todo, group: todo }
      - { name: Doing, group: in_progress }
      - { name: Done, group: done }
  - name: Tags
    type: multi_select
    options: [Bug, Feature]
  - name: Due
    type: date
views: []
"#,
        )
        .unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        for (path, title, fields) in [
            (
                "tasks/a.md",
                "A",
                serde_json::json!({"Priority":"High","Status":"Doing","Tags":["Feature"],"Due":{"start":"2026-01-10","end":"2026-01-20"}}),
            ),
            (
                "tasks/b.md",
                "B",
                serde_json::json!({"Priority":"Low","Status":"Doing","Tags":["Feature"],"Due":"2026-01-05"}),
            ),
            (
                "tasks/c.md",
                "C",
                serde_json::json!({"Priority":"Unknown","Status":"Doing","Tags":["Feature"],"Due":{"start":"2026-02-01","end":"2026-02-03"}}),
            ),
            (
                "tasks/d.md",
                "D",
                serde_json::json!({"Status":"Doing","Tags":["Feature"]}),
            ),
            (
                "tasks/e.md",
                "E",
                serde_json::json!({"Priority":"Low","Status":"Todo","Tags":["Feature"],"Due":"2025-12-31"}),
            ),
        ] {
            sqlx::query(
                r#"
                INSERT INTO entries (
                    file_path, title, description, created, updated, collection_root_path,
                    in_collection, is_entry_head, fields
                ) VALUES (?, ?, NULL, '2026-01-01', '2026-01-01', 'tasks', 1, 1, ?)
                "#,
            )
            .bind(path)
            .bind(title)
            .bind(fields.to_string())
            .execute(&pool)
            .await
            .unwrap();
        }

        let filters = vec![
            Filter {
                field: "Status".into(),
                op: FilterOp::GroupEq,
                value: Some(Value::String("in_progress".into())),
                values: None,
            },
            Filter {
                field: "Tags".into(),
                op: FilterOp::Contains,
                value: Some(Value::String("Feature".into())),
                values: None,
            },
        ];
        let sort = vec![Sort {
            field: "Priority".into(),
            desc: false,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &filters, &sort, None, None)
            .await
            .unwrap();
        let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["B", "A", "C", "D"]);

        let date_eq = vec![Filter {
            field: "Due".into(),
            op: FilterOp::Eq,
            value: Some(Value::String("2026-01-15".into())),
            values: None,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &date_eq, &[], None, None)
            .await
            .unwrap();
        let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["A"]);

        let date_before = vec![Filter {
            field: "Due".into(),
            op: FilterOp::Before,
            value: Some(Value::String("2026-01-06".into())),
            values: None,
        }];
        let title_sort = vec![Sort {
            field: "title".into(),
            desc: false,
        }];
        let rows = query_entry_rows(
            &pool,
            &schema,
            "tasks",
            &date_before,
            &title_sort,
            None,
            None,
        )
        .await
        .unwrap();
        let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["B", "E"]);

        let date_after = vec![Filter {
            field: "Due".into(),
            op: FilterOp::After,
            value: Some(Value::String("2026-01-31".into())),
            values: None,
        }];
        let rows = query_entry_rows(&pool, &schema, "tasks", &date_after, &[], None, None)
            .await
            .unwrap();
        let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
        assert_eq!(titles, vec!["C"]);
    }
}
