use super::*;

pub fn validate_schema(schema: &CollectionSchema) -> Result<(), AppError> {
    Ok(svode_core::collections::schema_validation::validate_schema(
        schema,
    )?)
}

pub fn normalize_schema(schema: &mut CollectionSchema) {
    svode_core::collections::schema_validation::normalize_schema(schema);
}

pub(super) fn normalize_view(
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

pub(super) fn autopick_board_group_by(schema: &CollectionSchema) -> Option<String> {
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

pub(super) fn autopick_calendar_date_field(schema: &CollectionSchema) -> Option<String> {
    schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::Date)
        .map(|column| column.name.clone())
}

pub(super) use svode_core::collections::schema_validation::{FieldContext, FieldType, field_type};

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

pub(super) fn normalize_property_value_for_write(
    column: &Column,
    value: Value,
) -> Result<Value, AppError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    match column.type_ {
        PropertyType::UniqueId => Err(schema_error(format!(
            "unique_id field '{}' is read-only",
            column.name
        ))),
        PropertyType::Actor => normalize_actor_value(column, value),
        _ => {
            validate_property_value(column, &value)?;
            Ok(value)
        }
    }
}
