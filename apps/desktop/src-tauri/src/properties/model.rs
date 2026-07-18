use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_yml::Value;

use crate::files::entry::ColorName;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelationScope {
    Root,
    Space { id: String },
}

impl Serialize for RelationScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            RelationScope::Root => serializer.serialize_str("root"),
            RelationScope::Space { id } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "space")?;
                map.serialize_entry("id", id)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for RelationScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(value) if value == "root" => Ok(Self::Root),
            Value::Mapping(mapping) => {
                let type_ = mapping
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::custom("relation_scope.type is required"))?;
                match type_ {
                    "root" => Ok(Self::Root),
                    "space" => {
                        let id = mapping
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|id| !id.is_empty())
                            .ok_or_else(|| {
                                serde::de::Error::custom("relation_scope.id is required")
                            })?;
                        Ok(Self::Space { id: id.to_string() })
                    }
                    other => Err(serde::de::Error::custom(format!(
                        "unsupported relation_scope.type '{other}'"
                    ))),
                }
            }
            _ => Err(serde::de::Error::custom(
                "relation_scope must be 'root' or an object",
            )),
        }
    }
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
    pub relation_scope: Option<RelationScope>,
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

    pub(super) fn name_mut(&mut self) -> &mut String {
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
    pub templates: Option<TemplatesConfig>,
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub views: Vec<View>,
}
