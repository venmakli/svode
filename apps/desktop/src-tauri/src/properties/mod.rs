use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Deserializer, Serialize};
use serde_yml::{Mapping, Value};

use crate::error::AppError;
use crate::files::entry::{ColorName, EntryMeta};
use crate::files::{entry, frontmatter};
use crate::git::cli::GitCli;

const SCHEMA_FILE: &str = "schema.yaml";
const RESERVED_FIELDS: &[&str] = &[
    "id",
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
    Select,
    MultiSelect,
    Status,
    Date,
    Person,
    Checkbox,
    Url,
    Email,
    Phone,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SystemFieldOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SystemFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<SystemFieldOverride>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DocumentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TemplatesConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
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
    pub views: Vec<Value>,
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
    path.trim_matches('/')
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
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

fn read_schema_at(path: &Path) -> Result<CollectionSchema, AppError> {
    let raw = fs::read_to_string(path)?;
    let schema: CollectionSchema =
        serde_yml::from_str(&raw).map_err(|e| schema_error(format!("invalid schema YAML: {e}")))?;
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

fn write_schema(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
) -> Result<(), AppError> {
    validate_schema(schema)?;
    let dir = collection_dir(space, collection_path);
    fs::create_dir_all(&dir)?;
    let yaml = serde_yml::to_string(schema)
        .map_err(|e| schema_error(format!("could not serialize schema: {e}")))?;
    fs::write(dir.join(SCHEMA_FILE), yaml)?;
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

pub fn validate_schema(schema: &CollectionSchema) -> Result<(), AppError> {
    let mut names = HashSet::new();
    let mut status_count = 0;

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
            _ => {}
        }

        validate_column_display(column)?;

        if let Some(default) = column.default.as_ref() {
            validate_property_value(column, default)?;
        }
    }

    if status_count > 1 {
        return Err(schema_error("schema can contain at most one status column"));
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

    Ok(())
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
        PropertyType::Person | PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
            expect_string_value(&column.name, value).map(|_| ())
        }
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
        if let Some(default) = column.default {
            meta.extra.insert(column.name, default);
            changed = true;
        }
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
    let entry = entry::read(&space_str, rel_path)?;
    let mut meta = entry.meta;
    if apply_schema_defaults_for_path(&space_str, rel_path, &mut meta)? {
        fs::write(
            space.join(rel_path),
            frontmatter::serialize(&meta, &entry.body),
        )?;
    }
    Ok(())
}

pub fn add_schema_column(
    space: &str,
    collection_path: &str,
    mut column: Column,
) -> Result<CollectionSchema, AppError> {
    if column.type_ == PropertyType::Status && column.options.is_none() {
        column.options = Some(default_status_options());
    }
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
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
        schema.columns.push(column);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn change_schema_type(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        column.type_ = new_type;
        normalize_column_for_new_type(column, conversion_strategy.as_ref())?;
        let column_snapshot = column.clone();
        validate_schema(&schema)?;

        let files = collection_markdown_files(space, collection_path)?;
        for file in &files {
            mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    *value = convert_value_for_type(value.clone(), &column_snapshot);
                }
                Ok(())
            })?;
        }

        write_schema(space, collection_path, &schema)?;
        Ok(schema)
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
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == new_name) {
            return Err(schema_error(format!("column '{new_name}' already exists")));
        }
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
        Ok(schema)
    })
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
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
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
    entry_id: &str,
    field: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == field) {
            return Err(schema_error(format!("column '{field}' already exists")));
        }
        let value = find_entry_extra_by_id(space, collection_path, entry_id, field)?
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
        }
        _ => {
            column.options = None;
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

fn convert_value_for_type(value: Value, column: &Column) -> Value {
    let original = value.clone();
    let converted = match column.type_ {
        PropertyType::Text => value_to_scalar_string(&value).map(Value::String),
        PropertyType::Number => {
            value_to_f64(&value).and_then(|number| serde_yml::to_value(number).ok())
        }
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
        PropertyType::Person | PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
            value_to_scalar_string(&value).map(Value::String)
        }
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

fn replace_string_refs_in_views(views: &mut [Value], old: &str, new: &str) {
    for view in views {
        replace_string_ref(view, old, new);
    }
}

fn replace_string_ref(value: &mut Value, old: &str, new: &str) {
    match value {
        Value::String(value) if value == old => *value = new.to_string(),
        Value::Sequence(sequence) => {
            for item in sequence {
                replace_string_ref(item, old, new);
            }
        }
        Value::Mapping(mapping) => {
            for (_, item) in mapping.iter_mut() {
                replace_string_ref(item, old, new);
            }
        }
        _ => {}
    }
}

fn strip_string_refs_in_views(views: &mut [Value], target: &str) {
    for view in views {
        strip_string_ref(view, target);
    }
}

fn strip_string_ref(value: &mut Value, target: &str) {
    match value {
        Value::String(value) if value == target => *value = String::new(),
        Value::Sequence(sequence) => {
            sequence.retain(|item| item.as_str() != Some(target));
            for item in sequence {
                strip_string_ref(item, target);
            }
        }
        Value::Mapping(mapping) => {
            let keys: Vec<Value> = mapping
                .iter()
                .filter_map(|(key, value)| {
                    let key_name = key.as_str()?;
                    let removable_key = matches!(
                        key_name,
                        "field" | "group_by" | "date_field" | "color_field"
                    );
                    (removable_key && value.as_str() == Some(target)).then(|| key.clone())
                })
                .collect();
            for key in keys {
                mapping.remove(key);
            }
            for (_, item) in mapping.iter_mut() {
                strip_string_ref(item, target);
            }
        }
        _ => {}
    }
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
        if name == ".git" || name == ".combai" || name == ".assets" {
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

fn mutate_frontmatter<F>(path: &Path, mut f: F) -> Result<(), AppError>
where
    F: FnMut(&mut EntryMeta) -> Result<(), AppError>,
{
    let raw = fs::read_to_string(path)?;
    let Some((mut meta, body)) = frontmatter::try_parse(&raw)? else {
        return Ok(());
    };
    let before = meta.extra.clone();
    f(&mut meta)?;
    if meta.extra != before {
        fs::write(path, frontmatter::serialize(&meta, &body))?;
    }
    Ok(())
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

fn find_entry_extra_by_id(
    space: &str,
    collection_path: &str,
    entry_id: &str,
    field: &str,
) -> Result<Option<Value>, AppError> {
    for file in collection_markdown_files(space, collection_path)? {
        let raw = fs::read_to_string(&file)?;
        let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
            continue;
        };
        if meta.id == entry_id {
            return Ok(meta.extra.get(field).cloned());
        }
    }
    Ok(None)
}

fn infer_column(field: &str, value: &Value) -> Column {
    let mut column = Column {
        name: field.to_string(),
        type_: infer_type(value),
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
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
            default: None,
            options: None,
            display: None,
            min: None,
            max: None,
            color: None,
            time_by_default: None,
            range_by_default: None,
        };
        let ok: Value = serde_yml::from_str("start: 2026-04-20\nend: 2026-04-22\n").unwrap();
        validate_property_value(&column, &ok).unwrap();

        let bad: Value = serde_yml::from_str("start: 2026-04-20T09:00\nend: 2026-04-22\n").unwrap();
        assert!(validate_property_value(&column, &bad).is_err());
    }
}
