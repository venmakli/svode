use super::*;

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
            PropertyType::Actor => {
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
pub(super) enum FieldContext {
    Filter,
    Sort,
    VisibleField,
    CardField,
    GroupBy,
    DateField,
    ColorField,
    CardCover,
}

pub(super) fn validate_field_ref(
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
        FieldType::Checkbox => matches!(filter.op, FilterOp::Eq | FilterOp::Neq),
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
    Checkbox,
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
