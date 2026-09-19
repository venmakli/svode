use super::CollectionError;
use super::model::*;
use crate::git::path::{RootMode, normalize_repo_relative};
use chrono::{NaiveDate, NaiveDateTime};
use serde_yml::Value;
use std::collections::HashSet;

pub(super) const RESERVED_FIELDS: &[&str] = &[
    "title",
    "icon",
    "description",
    "cover",
    "created",
    "updated",
];

pub(super) fn schema_error(message: impl Into<String>) -> CollectionError {
    CollectionError::Schema(message.into())
}

pub(super) fn unique_id_value(value: &Value) -> Option<u64> {
    value.as_u64().filter(|value| *value >= 1)
}

pub(super) fn trim_unique_id_prefix(prefix: Option<String>) -> Option<String> {
    prefix.and_then(|prefix| {
        let trimmed = prefix.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

pub(super) fn validate_unique_id_prefix(
    column_name: &str,
    prefix: &str,
) -> Result<(), CollectionError> {
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

pub(super) fn parse_unique_id_filter_value(
    column: &Column,
    value: &Value,
) -> Result<u64, CollectionError> {
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

pub(super) fn validate_property_value(
    column: &Column,
    value: &Value,
) -> Result<(), CollectionError> {
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

pub(super) fn validate_actor_value_shape(
    column: &Column,
    value: &Value,
) -> Result<(), CollectionError> {
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

pub(super) fn validate_relation_column_name(name: &str) -> Result<(), CollectionError> {
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

pub(super) fn validate_relation_path_shape(path: &str) -> Result<(), CollectionError> {
    normalize_repo_relative(path, RootMode::Allow)
        .map(|_| ())
        .map_err(|e| schema_error(e.to_string()))
}

pub fn validate_relation_value_shape(
    column: &Column,
    value: &Value,
) -> Result<Vec<String>, CollectionError> {
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

pub fn normalize_relation_value_shape(raw: &str) -> Result<String, CollectionError> {
    normalize_repo_relative(raw, RootMode::Reject).map_err(|e| schema_error(e.to_string()))
}

pub(super) fn option_names(column: &Column) -> HashSet<&str> {
    column
        .options
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|option| option.name.as_str())
        .collect()
}

pub(super) fn validate_date_value(field: &str, value: &Value) -> Result<(), CollectionError> {
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

pub(super) fn parse_date_cell(raw: &str) -> Option<bool> {
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

pub(super) fn today_macro_offset(raw: &str) -> Result<Option<i64>, CollectionError> {
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

pub(super) fn filter_values(filter: &Filter) -> Result<Vec<Value>, CollectionError> {
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

pub(super) fn is_actor_type(ty: PropertyType) -> bool {
    matches!(ty, PropertyType::Actor)
}

pub(super) fn actor_multiple(column: &Column) -> bool {
    column.multiple.unwrap_or(false)
}
