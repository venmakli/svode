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

#[derive(Clone, Copy)]
pub(super) enum FieldContext {
    Filter,
    Sort,
}

pub(super) fn validate_field_ref(
    _schema: &CollectionSchema,
    column_names: &HashSet<String>,
    field: &str,
    context: FieldContext,
) -> Result<(), AppError> {
    if column_names.contains(field) {
        return Ok(());
    }

    let allowed = match context {
        FieldContext::Filter => matches!(field, "title" | "description" | "created" | "updated"),
        FieldContext::Sort => matches!(field, "title" | "created" | "updated"),
    };
    if allowed {
        Ok(())
    } else {
        Err(schema_error(format!(
            "field '{field}' is not valid in this view context"
        )))
    }
}

pub(super) fn validate_filter_op(
    schema: &CollectionSchema,
    filter: &Filter,
) -> Result<(), AppError> {
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
        FieldType::Boolean => matches!(filter.op, FilterOp::Eq | FilterOp::Neq),
        FieldType::SelectLike | FieldType::Actor => matches!(
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
pub(super) enum FieldType {
    TextLike,
    Number,
    UniqueId,
    Date,
    Boolean,
    SelectLike,
    Multi,
    Status,
    Actor,
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

pub(super) fn single_filter_value(filter: &Filter) -> Result<&Value, AppError> {
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
        FieldType::Boolean => {
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
        FieldType::Actor | FieldType::ActorMulti => {
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

pub(super) fn status_group_name(group: StatusGroup) -> &'static str {
    match group {
        StatusGroup::Todo => "todo",
        StatusGroup::InProgress => "in_progress",
        StatusGroup::Done => "done",
    }
}

pub(super) fn field_type(
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
            PropertyType::Actor if actor_multiple(column) => FieldType::ActorMulti,
            PropertyType::Actor => FieldType::Actor,
            PropertyType::Boolean => FieldType::Boolean,
            PropertyType::Relation => FieldType::Multi,
        });
    }
    match field {
        "title" | "description" => Ok(FieldType::TextLike),
        "created" | "updated" => Ok(FieldType::Date),
        _ => Err(schema_error(format!("field '{field}' has no query type"))),
    }
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
