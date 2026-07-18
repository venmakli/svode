use super::*;

#[derive(Debug, Clone)]
pub(super) struct EntryQueryRow {
    pub(super) file_path: String,
    pub(super) title: String,
    pub(super) created: String,
    pub(super) updated: String,
}

pub(super) async fn query_entry_rows(
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
        FieldType::TextLike | FieldType::Actor => {
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

pub(super) fn filter_values(filter: &Filter) -> Result<Vec<Value>, AppError> {
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

pub(super) fn validate_ad_hoc_query(
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

pub(super) fn entries_from_rows(
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

pub(super) fn entry_parent_dir(file_path: &str) -> String {
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

pub(super) fn entry_order_name(file_path: &str) -> String {
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
