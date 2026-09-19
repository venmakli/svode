use super::*;

/// Resolves view/ad-hoc filter macros, actor aliases and typed filter values.
pub async fn resolve_query_filters(
    actor_catalog: &crate::actors::resolver::ActorCatalogState,
    git_cli: Option<&crate::git::cli::GitCli>,
    space_path: &Path,
    schema: &CollectionSchema,
    filters: &[Filter],
) -> Result<Vec<Filter>, CollectionError> {
    let needs_actor_resolver = query_filters_need_actor_resolver(schema, filters)?;
    let needs_me = query_filters_need_me(schema, filters)?;
    let actor_snapshot = match (needs_actor_resolver, git_cli) {
        (true, Some(cli)) => match actor_catalog.snapshot(cli, space_path).await {
            Ok(snapshot) => Some(snapshot),
            Err(error) if needs_me => return Err(error.into()),
            Err(error) => {
                tracing::warn!(
                    "actor resolver unavailable for explicit query values in {}: {error}",
                    space_path.display()
                );
                None
            }
        },
        _ => None,
    };
    let me_email = if needs_me {
        Some(
            actor_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.current_email())
                .ok_or_else(|| schema_error("@me requires git user.email"))?
                .to_string(),
        )
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
        if let Some(snapshot) = actor_snapshot.as_deref() {
            expand_actor_filter_aliases(ty, &mut filter, snapshot);
        }
        resolved.push(filter);
    }
    Ok(resolved)
}

fn query_filters_need_actor_resolver(
    schema: &CollectionSchema,
    filters: &[Filter],
) -> Result<bool, CollectionError> {
    for filter in filters {
        if !matches!(
            field_type(schema, &filter.field, FieldContext::Filter)?,
            FieldType::Actor | FieldType::ActorMulti
        ) {
            continue;
        }
        if !filter_value_refs(filter).is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn expand_actor_filter_aliases(
    ty: FieldType,
    filter: &mut Filter,
    snapshot: &crate::actors::resolver::ActorSnapshot,
) {
    if !matches!(ty, FieldType::Actor | FieldType::ActorMulti) {
        return;
    }
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for value in filter_value_refs(filter) {
        let Some(email) = value.as_str() else {
            continue;
        };
        for equivalent in snapshot.equivalent_emails(email) {
            if seen.insert(equivalent.clone()) {
                values.push(Value::String(equivalent));
            }
        }
    }
    if values.is_empty() {
        return;
    }
    match filter.op {
        FilterOp::Eq => filter.op = FilterOp::In,
        FilterOp::Neq => filter.op = FilterOp::NotIn,
        FilterOp::Contains => filter.op = FilterOp::ContainsAny,
        FilterOp::NotContains => filter.op = FilterOp::NotContainsAny,
        _ => {}
    }
    filter.value = None;
    filter.values = Some(values);
}

pub(super) fn normalize_filter_values_for_query(
    schema: &CollectionSchema,
    filter: &mut Filter,
) -> Result<(), CollectionError> {
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
) -> Result<(), CollectionError> {
    match ty {
        FieldType::UniqueId => {
            let column = column.ok_or_else(|| schema_error("unique_id field not found"))?;
            *value = yaml_u64(parse_unique_id_filter_value(column, value)?);
        }
        FieldType::Actor | FieldType::ActorMulti => {
            if let Some(raw) = value.as_str() {
                *value = Value::String(canonical_actor_email(raw));
            }
        }
        _ => {}
    }
    Ok(())
}

fn query_filters_need_me(
    schema: &CollectionSchema,
    filters: &[Filter],
) -> Result<bool, CollectionError> {
    for filter in filters {
        if !matches!(
            field_type(schema, &filter.field, FieldContext::Filter)?,
            FieldType::Actor | FieldType::ActorMulti
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

fn resolve_filter_macro_value(
    ty: FieldType,
    value: &Value,
    me_email: Option<&str>,
) -> Result<Value, CollectionError> {
    let Some(raw) = value.as_str() else {
        return Ok(value.clone());
    };
    match ty {
        FieldType::Date => resolve_today_macro(raw)
            .map(|resolved| resolved.map(Value::String).unwrap_or_else(|| value.clone())),
        FieldType::Actor | FieldType::ActorMulti if raw == "@me" => me_email
            .map(|email| Value::String(email.to_string()))
            .ok_or_else(|| schema_error("@me requires git user.email")),
        FieldType::Actor | FieldType::ActorMulti => Ok(Value::String(canonical_actor_email(raw))),
        _ => Ok(value.clone()),
    }
}

fn resolve_filter_macro_container(
    ty: FieldType,
    value: &mut Value,
    me_email: Option<&str>,
) -> Result<(), CollectionError> {
    if let Value::Sequence(sequence) = value {
        for item in sequence {
            *item = resolve_filter_macro_value(ty, item, me_email)?;
        }
    } else {
        *value = resolve_filter_macro_value(ty, value, me_email)?;
    }
    Ok(())
}
