use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_norway::{Mapping, Value};

use crate::page::ColorName;

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
    Boolean,
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

/// Target of a relation column outside its own Space. Unknown keys of the
/// object form stay with the scope, so a root scope that has them is written
/// as an object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelationScope {
    Root { unknown_keys: Mapping },
    Space { id: String, unknown_keys: Mapping },
}

impl RelationScope {
    pub fn root() -> Self {
        Self::Root {
            unknown_keys: Mapping::new(),
        }
    }

    pub fn space(id: impl Into<String>) -> Self {
        Self::Space {
            id: id.into(),
            unknown_keys: Mapping::new(),
        }
    }

    pub fn unknown_keys(&self) -> &Mapping {
        match self {
            Self::Root { unknown_keys } | Self::Space { unknown_keys, .. } => unknown_keys,
        }
    }

    fn unknown_keys_mut(&mut self) -> &mut Mapping {
        match self {
            Self::Root { unknown_keys } | Self::Space { unknown_keys, .. } => unknown_keys,
        }
    }

    /// Whether both scopes name the same target; unknown keys do not change it.
    pub fn same_target(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Root { .. }, Self::Root { .. }) => true,
            (Self::Space { id: left, .. }, Self::Space { id: right, .. }) => left == right,
            _ => false,
        }
    }

    /// [`Self::same_target`] over optional scopes, where `None` is the own Space.
    pub fn same_optional_target(left: Option<&Self>, right: Option<&Self>) -> bool {
        match (left, right) {
            (Some(left), Some(right)) => left.same_target(right),
            (None, None) => true,
            _ => false,
        }
    }
}

impl Serialize for RelationScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            RelationScope::Root { unknown_keys } if unknown_keys.is_empty() => {
                serializer.serialize_str("root")
            }
            RelationScope::Root { unknown_keys } => {
                let mut map = serializer.serialize_map(Some(1 + unknown_keys.len()))?;
                map.serialize_entry("type", "root")?;
                for (key, value) in unknown_keys {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
            RelationScope::Space { id, unknown_keys } => {
                let mut map = serializer.serialize_map(Some(2 + unknown_keys.len()))?;
                map.serialize_entry("type", "space")?;
                map.serialize_entry("id", id)?;
                for (key, value) in unknown_keys {
                    map.serialize_entry(key, value)?;
                }
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
            Value::String(value) if value == "root" => Ok(Self::root()),
            Value::Mapping(mut mapping) => {
                let type_ = mapping
                    .remove("type")
                    .and_then(|type_| type_.as_str().map(ToOwned::to_owned))
                    .ok_or_else(|| serde::de::Error::custom("relation_scope.type is required"))?;
                match type_.as_str() {
                    "root" => Ok(Self::Root {
                        unknown_keys: mapping,
                    }),
                    "space" => {
                        let id = mapping
                            .remove("id")
                            .as_ref()
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|id| !id.is_empty())
                            .map(ToOwned::to_owned)
                            .ok_or_else(|| {
                                serde::de::Error::custom("relation_scope.id is required")
                            })?;
                        Ok(Self::Space {
                            id,
                            unknown_keys: mapping,
                        })
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
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
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
            #[serde(flatten)]
            unknown_keys: Mapping,
        }

        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(name) => Ok(Self {
                name,
                color: None,
                icon: None,
                group: None,
                unknown_keys: Mapping::new(),
            }),
            Value::Mapping(_) => {
                let object: PropertyOptionObject =
                    serde_norway::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(Self {
                    name: object.name,
                    color: object.color,
                    icon: object.icon,
                    group: object.group,
                    unknown_keys: object.unknown_keys,
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
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SystemFieldOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SystemFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<SystemFieldOverride>,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TemplatesConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
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
pub struct Filter {
    pub field: String,
    pub op: FilterOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<Value>>,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sort {
    pub field: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub desc: bool,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
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
        #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
        unknown_keys: Mapping,
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
        #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
        unknown_keys: Mapping,
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
        #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
        unknown_keys: Mapping,
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
        #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
        unknown_keys: Mapping,
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
        #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
        unknown_keys: Mapping,
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

    pub fn name_mut(&mut self) -> &mut String {
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

    pub fn unknown_keys(&self) -> &Mapping {
        match self {
            View::Table { unknown_keys, .. }
            | View::Board { unknown_keys, .. }
            | View::Calendar { unknown_keys, .. }
            | View::List { unknown_keys, .. }
            | View::Gallery { unknown_keys, .. } => unknown_keys,
        }
    }

    fn unknown_keys_mut(&mut self) -> &mut Mapping {
        match self {
            View::Table { unknown_keys, .. }
            | View::Board { unknown_keys, .. }
            | View::Calendar { unknown_keys, .. }
            | View::List { unknown_keys, .. }
            | View::Gallery { unknown_keys, .. } => unknown_keys,
        }
    }

    fn filters_and_sorts_mut(&mut self) -> (&mut Vec<Filter>, Option<&mut Vec<Sort>>) {
        match self {
            View::Table { filter, sort, .. }
            | View::Board { filter, sort, .. }
            | View::List { filter, sort, .. }
            | View::Gallery { filter, sort, .. } => (filter, Some(sort)),
            View::Calendar { filter, .. } => (filter, None),
        }
    }

    /// Drops the unknown keys of the view, its filters and sorts.
    pub fn discard_unknown_keys(&mut self) {
        self.unknown_keys_mut().clear();
        let (filters, sorts) = self.filters_and_sorts_mut();
        filters
            .iter_mut()
            .for_each(|filter| filter.unknown_keys.clear());
        sorts
            .into_iter()
            .flatten()
            .for_each(|sort| sort.unknown_keys.clear());
    }

    /// Gives this view, built from operation input, the unknown keys of the
    /// stored `previous` view: its own keys, except the ones this view now
    /// sets as known fields, and those of each filter and sort it keeps
    /// unchanged. Keys of the input are dropped.
    pub fn keep_unknown_keys_of(&mut self, previous: &View) {
        self.discard_unknown_keys();
        let known = serde_norway::to_value(&*self)
            .ok()
            .and_then(|value| value.as_mapping().cloned())
            .unwrap_or_default();
        let mut unknown_keys = previous.unknown_keys().clone();
        unknown_keys.retain(|key, _| !known.contains_key(key));
        *self.unknown_keys_mut() = unknown_keys;
        let (filters, sorts) = self.filters_and_sorts_mut();
        keep_unknown_keys_of_unchanged(filters, previous.filters(), |filter| {
            &mut filter.unknown_keys
        });
        if let Some(sorts) = sorts {
            keep_unknown_keys_of_unchanged(sorts, previous.sorts(), |sort| &mut sort.unknown_keys);
        }
    }
}

/// Each item of `items` that equals, apart from unknown keys, a not yet
/// matched item of `previous` takes that item's unknown keys.
fn keep_unknown_keys_of_unchanged<T: Clone + PartialEq>(
    items: &mut [T],
    previous: &[T],
    unknown_keys: impl Fn(&mut T) -> &mut Mapping,
) {
    let mut unmatched = previous.to_vec();
    for item in items {
        let position = unmatched.iter_mut().position(|candidate| {
            let keys = std::mem::take(unknown_keys(candidate));
            let same = candidate == item;
            *unknown_keys(candidate) = keys;
            same
        });
        if let Some(position) = position {
            let mut matched = unmatched.remove(position);
            *unknown_keys(item) = std::mem::take(unknown_keys(&mut matched));
        }
    }
}

impl PropertyOption {
    /// Gives each option the unknown keys of the stored option with the same
    /// name; keys of the input are dropped.
    pub fn keep_unknown_keys_of(options: &mut [PropertyOption], previous: &[PropertyOption]) {
        for option in options {
            option.unknown_keys = previous
                .iter()
                .find(|stored| stored.name == option.name)
                .map(|stored| stored.unknown_keys.clone())
                .unwrap_or_default();
        }
    }
}

impl Column {
    /// Drops the unknown keys of the column, its options and relation scope.
    pub fn discard_unknown_keys(&mut self) {
        self.unknown_keys.clear();
        for option in self.options.iter_mut().flatten() {
            option.unknown_keys.clear();
        }
        if let Some(scope) = self.relation_scope.as_mut() {
            scope.unknown_keys_mut().clear();
        }
    }

    /// Sets the relation scope from operation input: the scope keeps the
    /// unknown keys of the stored scope when it names the same target.
    pub fn set_relation_scope(&mut self, mut scope: Option<RelationScope>) {
        if let Some(scope) = scope.as_mut() {
            *scope.unknown_keys_mut() = self
                .relation_scope
                .as_ref()
                .filter(|stored| stored.same_target(scope))
                .map(|stored| stored.unknown_keys().clone())
                .unwrap_or_default();
        }
        self.relation_scope = scope;
    }

    /// Sets the options from operation input: see
    /// [`PropertyOption::keep_unknown_keys_of`].
    pub fn set_options(&mut self, mut options: Option<Vec<PropertyOption>>) {
        if let Some(options) = options.as_mut() {
            PropertyOption::keep_unknown_keys_of(
                options,
                self.options.as_deref().unwrap_or_default(),
            );
        }
        self.options = options;
    }
}

impl CollectionSchema {
    /// Drops every unknown key of a schema built from operation input.
    pub fn discard_unknown_keys(&mut self) {
        self.unknown_keys.clear();
        if let Some(system_fields) = self.system_fields.as_mut() {
            system_fields.unknown_keys.clear();
            if let Some(title) = system_fields.title.as_mut() {
                title.unknown_keys.clear();
            }
        }
        if let Some(templates) = self.templates.as_mut() {
            templates.unknown_keys.clear();
        }
        self.columns
            .iter_mut()
            .for_each(Column::discard_unknown_keys);
        self.views.iter_mut().for_each(View::discard_unknown_keys);
    }
}

/// The `schema.yaml` format. Every object keeps the keys this version does
/// not know in `unknown_keys` and writes them back after its known keys, so a
/// write by an older Svode keeps what a newer one added. Operation input
/// never brings unknown keys into the file: the operations drop them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CollectionSchema {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_fields: Option<SystemFields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub templates: Option<TemplatesConfig>,
    /// Pages below the direct children of the root are items too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nested_items: bool,
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub views: Vec<View>,
    #[serde(flatten, skip_serializing_if = "Mapping::is_empty")]
    pub unknown_keys: Mapping,
}
