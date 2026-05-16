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
    let dir = collection_dir(space, collection_path);
    fs::create_dir_all(&dir)?;
    let yaml = serde_yml::to_string(&schema)
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
        PropertyType::Person,
    ] {
        if let Some(column) = schema.columns.iter().find(|column| column.type_ == ty) {
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
        FieldContext::GroupBy => matches!(
            column.type_,
            PropertyType::Select | PropertyType::Status | PropertyType::Person
        ),
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
    Date,
    Checkbox,
    SelectLike,
    Multi,
    Status,
    Person,
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
        FieldType::Person => {
            value.as_str().ok_or_else(|| {
                schema_error(format!("filter '{}' requires person email", filter.field))
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
            PropertyType::Select => FieldType::SelectLike,
            PropertyType::MultiSelect => FieldType::Multi,
            PropertyType::Status => FieldType::Status,
            PropertyType::Date => FieldType::Date,
            PropertyType::Person => FieldType::Person,
            PropertyType::Checkbox => FieldType::Checkbox,
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

pub fn update_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: Value,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let column = find_column_mut(&mut schema, column_name)?;
        apply_column_patch(column, patch)?;
        validate_schema(&schema)?;
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
        resolved.push(filter);
    }
    Ok(resolved)
}

fn query_filters_need_me(schema: &CollectionSchema, filters: &[Filter]) -> Result<bool, AppError> {
    for filter in filters {
        if field_type(schema, &filter.field, FieldContext::Filter)? != FieldType::Person {
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
        FieldType::Person if raw == "@me" => me_email
            .map(|email| Value::String(email.to_string()))
            .ok_or_else(|| schema_error("@me requires git user.email")),
        FieldType::Person => Ok(Value::String(raw.to_lowercase())),
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

#[derive(Debug, Clone)]
struct EntryQueryRow {
    file_path: String,
    title: String,
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
        "SELECT file_path, title FROM entries WHERE collection_root_path = ",
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
        FilterOp::Contains if ty == FieldType::Multi => {
            push_array_contains_filter(query, schema, filter, false)?
        }
        FilterOp::NotContains if ty == FieldType::Multi => {
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
        FieldType::Number => push_number_field_expr(query, field),
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
        FieldType::Multi => {
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
        FieldType::Number => {
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
        let entry = entry::read(space, &row.file_path)?;
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
    if mapping.contains_key("time_by_default") {
        column.time_by_default = nullable_from_mapping(mapping, "time_by_default")?;
    }
    if mapping.contains_key("range_by_default") {
        column.range_by_default = nullable_from_mapping(mapping, "range_by_default")?;
    }
    if mapping.contains_key("options") {
        column.options = nullable_from_mapping(mapping, "options")?;
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
