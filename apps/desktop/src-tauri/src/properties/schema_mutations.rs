use super::*;

#[allow(dead_code)]
pub fn add_schema_column(
    space: &str,
    collection_path: &str,
    column: Column,
) -> Result<CollectionSchema, AppError> {
    add_schema_column_with_project(space, collection_path, column, None)
}

pub fn add_schema_column_with_project(
    space: &str,
    collection_path: &str,
    mut column: Column,
    project_path: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    if column.type_ == PropertyType::Status && column.options.is_none() {
        column.options = Some(default_status_options());
    }
    if column.type_ == PropertyType::Actor {
        column.multiple = Some(column.multiple.unwrap_or(false));
    }
    if column.type_ == PropertyType::UniqueId {
        column.next = Some(column.next.unwrap_or(1).max(1));
        column.prefix = trim_unique_id_prefix(column.prefix.take());
    }
    let mut touched = vec![collection_dir(space, collection_path).join(SCHEMA_FILE)];
    if column.type_ == PropertyType::UniqueId {
        touched.extend(collection_markdown_files(space, collection_path)?);
    }
    extend_relation_side_effect_paths(space, project_path, collection_path, &column, &mut touched)?;
    with_rollback(touched, || {
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
        normalize_column_relation_paths(&mut column)?;
        schema.columns.push(column.clone());
        validate_schema(&schema)?;
        write_schema_with_project(space, collection_path, &schema, project_path)?;
        if column.type_ == PropertyType::UniqueId {
            materialize_unique_id_column(space, collection_path, &column.name)?;
            schema = read_schema_or_default(space, collection_path)?;
        }
        ensure_two_way_schema_and_values_with_project(
            space,
            collection_path,
            &column,
            project_path,
        )?;
        Ok(schema)
    })
}

#[allow(dead_code)]
pub fn change_schema_type(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
) -> Result<CollectionSchema, AppError> {
    change_schema_type_with_warnings(
        space,
        collection_path,
        column_name,
        new_type,
        conversion_strategy,
    )
    .map(|(schema, _)| schema)
}

pub fn change_schema_type_with_warnings(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
) -> Result<(CollectionSchema, Vec<SchemaMutationWarning>), AppError> {
    change_schema_type_with_warnings_and_project(
        space,
        collection_path,
        column_name,
        new_type,
        conversion_strategy,
        None,
    )
}

pub fn change_schema_type_with_warnings_and_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
    project_path: Option<&str>,
) -> Result<(CollectionSchema, Vec<SchemaMutationWarning>), AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(old_column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                old_column,
                &mut touched,
            )?;
            let mut new_column = old_column.clone();
            new_column.type_ = new_type;
            normalize_column_for_new_type(&mut new_column, conversion_strategy.as_ref())?;
            normalize_column_relation_paths(&mut new_column)?;
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                &new_column,
                &mut touched,
            )?;
        }
    }
    with_rollback(touched, || {
        let mut warnings = Vec::new();
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
            .cloned();
        let column = find_column_mut(&mut schema, column_name)?;
        column.type_ = new_type;
        normalize_column_for_new_type(column, conversion_strategy.as_ref())?;
        normalize_column_relation_paths(column)?;
        let column_snapshot = column.clone();
        validate_schema(&schema)?;

        let files = collection_markdown_files(space, collection_path)?;
        let (unconverted_relation_field, relation_target_space) =
            if column_snapshot.type_ == PropertyType::Relation {
                (
                    Some(unique_extra_field_name(
                        space,
                        collection_path,
                        &schema,
                        &format!("{column_name} (unconverted)"),
                    )?),
                    Some(required_relation_target_space_path(
                        space,
                        project_path,
                        column_snapshot.relation_scope.as_ref(),
                    )?),
                )
            } else {
                (None, None)
            };
        let mut unconverted_relation_rows = 0usize;
        for file in &files {
            mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.remove(column_name) {
                    if let Some(extra_field) = unconverted_relation_field.as_deref() {
                        let relation_target_space =
                            relation_target_space.as_deref().ok_or_else(|| {
                                schema_error(format!(
                                    "relation column '{}' requires target space",
                                    column_snapshot.name
                                ))
                            })?;
                        let (converted, extra) = convert_value_for_relation_change(
                            relation_target_space,
                            &column_snapshot,
                            value,
                        )?;
                        if let Some(converted) = converted {
                            meta.extra.insert(column_name.to_string(), converted);
                        }
                        if let Some(extra) = extra {
                            meta.extra.insert(extra_field.to_string(), extra);
                            unconverted_relation_rows += 1;
                        }
                    } else {
                        meta.extra.insert(
                            column_name.to_string(),
                            convert_value_for_type_from_old(
                                value,
                                old_column.as_ref(),
                                &column_snapshot,
                            ),
                        );
                    }
                }
                Ok(())
            })?;
        }
        if let Some(field) = unconverted_relation_field {
            if unconverted_relation_rows > 0 {
                warnings.push(SchemaMutationWarning {
                    code: "relation_unconverted_values".to_string(),
                    field,
                    count: unconverted_relation_rows,
                });
            }
        }

        enforce_relation_limit_one_existing_values(space, collection_path, &column_snapshot)?;
        write_schema_with_project(space, collection_path, &schema, project_path)?;
        if column_snapshot.type_ == PropertyType::UniqueId {
            materialize_unique_id_column(space, collection_path, &column_snapshot.name)?;
            schema = read_schema_or_default(space, collection_path)?;
        }
        if old_column
            .as_ref()
            .is_some_and(|old| old.type_ == PropertyType::Relation && old.two_way.is_some())
            && column_snapshot.type_ != PropertyType::Relation
        {
            detach_two_way_relation_with_project(
                space,
                project_path,
                old_column.as_ref().unwrap(),
                true,
            )?;
        }
        ensure_two_way_schema_and_values_with_project(
            space,
            collection_path,
            &column_snapshot,
            project_path,
        )?;
        Ok((schema, warnings))
    })
}

#[allow(dead_code)]
pub fn rename_schema_column(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
) -> Result<CollectionSchema, AppError> {
    rename_schema_column_with_project(space, collection_path, old_name, new_name, None)
}

pub fn rename_schema_column_with_project(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
    project_path: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    touched.extend(collection_markdown_files(space, collection_path)?);
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(old_column) = schema.columns.iter().find(|column| column.name == old_name) {
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                old_column,
                &mut touched,
            )?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == new_name) {
            return Err(schema_error(format!("column '{new_name}' already exists")));
        }
        let old_column = find_column_mut(&mut schema, old_name)?.clone();
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
        if old_column.type_ == PropertyType::Relation {
            update_reverse_pair_name_with_project(
                space,
                project_path,
                collection_path,
                &old_column,
                new_name,
            )?;
        }
        Ok(schema)
    })
}

#[allow(dead_code)]
pub fn update_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: Value,
) -> Result<CollectionSchema, AppError> {
    update_schema_column_with_project(space, collection_path, column_name, patch, None)
}

pub fn update_schema_column_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: Value,
    project_path: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    let mut touched = vec![collection_dir(space, collection_path).join(SCHEMA_FILE)];
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            if column.type_ == PropertyType::Relation {
                touched.extend(collection_markdown_files(space, collection_path)?);
            }
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                column,
                &mut touched,
            )?;
            let mut patched = column.clone();
            apply_column_patch(&mut patched, patch.clone())?;
            normalize_column_relation_paths(&mut patched)?;
            if is_actor_cardinality_change(column, &patched) {
                touched.extend(collection_markdown_files(space, collection_path)?);
            }
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                &patched,
                &mut touched,
            )?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = find_column_mut(&mut schema, column_name)?.clone();
        let column = find_column_mut(&mut schema, column_name)?;
        apply_column_patch(column, patch)?;
        normalize_column_relation_paths(column)?;
        let new_column = column.clone();
        validate_schema(&schema)?;
        rewrite_actor_cardinality_values(space, collection_path, &old_column, &new_column)?;
        enforce_relation_limit_one_existing_values(space, collection_path, &new_column)?;
        write_schema_with_project(space, collection_path, &schema, project_path)?;
        if old_column.type_ == PropertyType::Relation
            && old_column.two_way.is_some()
            && (new_column.type_ != PropertyType::Relation
                || new_column.two_way != old_column.two_way
                || new_column.relation != old_column.relation
                || new_column.relation_scope != old_column.relation_scope)
        {
            detach_two_way_relation_with_project(space, project_path, &old_column, true)?;
        }
        ensure_two_way_schema_and_values_with_project(
            space,
            collection_path,
            &new_column,
            project_path,
        )?;
        Ok(schema)
    })
}

fn is_actor_cardinality_change(old_column: &Column, new_column: &Column) -> bool {
    is_actor_type(old_column.type_)
        && is_actor_type(new_column.type_)
        && actor_multiple(old_column) != actor_multiple(new_column)
}

fn rewrite_actor_cardinality_values(
    space: &str,
    collection_path: &str,
    old_column: &Column,
    new_column: &Column,
) -> Result<(), AppError> {
    if !is_actor_cardinality_change(old_column, new_column) {
        return Ok(());
    }

    for file in collection_markdown_files(space, collection_path)? {
        mutate_frontmatter(&file, |meta| {
            let Some(value) = meta.extra.get(&new_column.name).cloned() else {
                return Ok(());
            };
            let next = actor_value_for_cardinality_toggle(new_column, value)?;
            if next.is_null()
                || next
                    .as_sequence()
                    .is_some_and(|sequence| sequence.is_empty())
            {
                meta.extra.remove(&new_column.name);
            } else {
                meta.extra.insert(new_column.name.clone(), next);
            }
            Ok(())
        })?;
    }
    Ok(())
}

fn actor_value_for_cardinality_toggle(column: &Column, value: Value) -> Result<Value, AppError> {
    if actor_multiple(column) {
        return normalize_actor_value(column, value);
    }
    if let Value::Sequence(sequence) = &value {
        let values: Vec<&Value> = sequence.iter().filter(|item| !item.is_null()).collect();
        if values.is_empty() {
            return Ok(Value::Null);
        }
        if values.len() > 1 {
            return Err(schema_error(format!(
                "actor column '{}' has multiple values; choose one before disabling multiple",
                column.name
            )));
        }
        return normalize_actor_value(column, values[0].clone());
    }
    normalize_actor_value(column, value)
}

#[allow(dead_code)]
pub fn delete_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    delete_values: bool,
) -> Result<CollectionSchema, AppError> {
    delete_schema_column_with_project(space, collection_path, column_name, delete_values, None)
}

pub fn delete_schema_column_with_project(
    space: &str,
    collection_path: &str,
    column_name: &str,
    delete_values: bool,
    project_path: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    let mut touched = vec![schema_path];
    if delete_values {
        touched.extend(collection_markdown_files(space, collection_path)?);
    }
    {
        let schema = read_schema_or_default(space, collection_path)?;
        if let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
        {
            extend_relation_side_effect_paths(
                space,
                project_path,
                collection_path,
                column,
                &mut touched,
            )?;
        }
    }
    with_rollback(touched, || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let old_column = schema
            .columns
            .iter()
            .find(|column| column.name == column_name)
            .cloned();
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
        if let Some(old_column) = old_column
            .as_ref()
            .filter(|column| column.type_ == PropertyType::Relation && column.two_way.is_some())
        {
            detach_two_way_relation_with_project(space, project_path, old_column, true)?;
        }
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

pub fn clear_field_values(
    space: &str,
    collection_path: &str,
    field: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                meta.extra.remove(field);
                Ok(())
            })?;
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn clear_option_values(
    space: &str,
    collection_path: &str,
    column_name: &str,
    option_names: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if option_names.is_empty() {
        return Ok(Vec::new());
    }
    let schema = read_schema_or_default(space, collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .ok_or_else(|| schema_error(format!("column '{column_name}' not found")))?;
    ensure_option_column(column)?;

    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    for option_name in option_names {
                        delete_option_value(value, option_name);
                    }
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
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
}

pub fn replace_option_values(
    space: &str,
    collection_path: &str,
    column_name: &str,
    old_option_name: &str,
    new_option_name: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let schema = read_schema_or_default(space, collection_path)?;
    let column = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .ok_or_else(|| schema_error(format!("column '{column_name}' not found")))?;
    ensure_option_column(column)?;
    if !column
        .options
        .as_ref()
        .is_some_and(|options| options.iter().any(|option| option.name == new_option_name))
    {
        return Err(schema_error(format!(
            "option '{new_option_name}' not found"
        )));
    }

    let files = collection_markdown_files(space, collection_path)?;
    let mut changed = Vec::new();
    with_rollback(files.clone(), || {
        for file in &files {
            let did_change = mutate_frontmatter(file, |meta| {
                if let Some(value) = meta.extra.get_mut(column_name) {
                    replace_option_value(value, old_option_name, new_option_name);
                }
                Ok(())
            })?;
            if did_change {
                changed.push(file.clone());
            }
        }
        Ok(())
    })?;
    Ok(changed)
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
    file_path: &str,
    field: &str,
) -> Result<CollectionSchema, AppError> {
    if matches!(field, "created" | "updated") {
        return Err(schema_error(format!(
            "orphan field '{field}' conflicts with derived system metadata; rename it before promoting or delete it"
        )));
    }
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        if schema.columns.iter().any(|column| column.name == field) {
            return Err(schema_error(format!("column '{field}' already exists")));
        }
        let value = find_entry_extra_by_path(space, collection_path, file_path, field)?
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

pub fn set_default_template(
    space: &str,
    collection_path: &str,
    template_slug: Option<&str>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        schema
            .templates
            .get_or_insert_with(TemplatesConfig::default)
            .default = template_slug.map(ToOwned::to_owned);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn reorder_templates(
    space: &str,
    collection_path: &str,
    new_order: Vec<String>,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        schema
            .templates
            .get_or_insert_with(TemplatesConfig::default)
            .order = Some(new_order);
        write_schema(space, collection_path, &schema)?;
        Ok(schema)
    })
}

pub fn rename_template_slug_references(
    space: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), AppError> {
    let Some((old_collection, old_slug)) = template_root_context(old_path) else {
        return Ok(());
    };
    let Some((new_collection, new_slug)) = template_root_context(new_path) else {
        return Ok(());
    };
    if old_collection != new_collection || old_slug == new_slug {
        return Ok(());
    }

    let schema_path = collection_dir(space, &old_collection).join(SCHEMA_FILE);
    if !schema_path.is_file() {
        return Ok(());
    }

    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, &old_collection)?;
        let Some(templates) = schema.templates.as_mut() else {
            return Ok(());
        };

        let mut changed = false;
        if templates.default.as_deref() == Some(old_slug.as_str()) {
            templates.default = Some(new_slug.clone());
            changed = true;
        }
        if let Some(order) = templates.order.as_mut() {
            for item in order {
                if item == &old_slug {
                    *item = new_slug.clone();
                    changed = true;
                }
            }
        }

        if changed {
            write_schema(space, &old_collection, &schema)?;
        }
        Ok(())
    })
}

fn template_root_context(path: &str) -> Option<(String, String)> {
    let rel = normalize_rel_path(path);
    let parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let marker = parts.iter().position(|part| *part == ".templates")?;
    let after = &parts[marker + 1..];

    let slug = match after {
        [file] if file.ends_with(".md") => file.strip_suffix(".md")?.to_string(),
        [slug, readme] if readme.eq_ignore_ascii_case("README.md") => slug.to_string(),
        _ => return None,
    };

    let collection = if marker == 0 {
        ".".to_string()
    } else {
        parts[..marker].join("/")
    };
    Some((collection, slug))
}

pub fn default_collection_schema() -> CollectionSchema {
    CollectionSchema {
        system_fields: None,
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
pub struct SchemaMutationWarning {
    pub code: String,
    pub field: String,
    pub count: usize,
}

pub(super) fn find_column_mut<'a>(
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
            column.relation = None;
            column.relation_scope = None;
            column.limit = None;
            column.two_way = None;
        }
        PropertyType::Relation => {
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.prefix = None;
            column.next = None;
            column.multiple = None;
            if let Some(relation) = strategy.and_then(|value| value.get("relation")) {
                column.relation = relation.as_str().map(ToOwned::to_owned);
            }
            if let Some(scope) = strategy.and_then(|value| value.get("relation_scope")) {
                column.relation_scope = if scope.is_null() {
                    None
                } else {
                    Some(
                        serde_yml::from_value(scope.clone())
                            .map_err(|e| schema_error(format!("invalid relation_scope: {e}")))?,
                    )
                };
            }
            if let Some(limit) = strategy.and_then(|value| value.get("limit")) {
                column.limit = if limit.is_null() {
                    None
                } else {
                    Some(
                        serde_yml::from_value(limit.clone())
                            .map_err(|e| schema_error(format!("invalid relation limit: {e}")))?,
                    )
                };
            }
            if let Some(two_way) = strategy.and_then(|value| value.get("two_way")) {
                column.two_way = two_way.as_str().map(ToOwned::to_owned);
            }
        }
        PropertyType::UniqueId => {
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.relation = None;
            column.relation_scope = None;
            column.limit = None;
            column.two_way = None;
            column.multiple = None;
            column.prefix = strategy
                .and_then(|value| value.get("prefix"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| column.prefix.clone());
            column.prefix = trim_unique_id_prefix(column.prefix.take());
            column.next = Some(column.next.unwrap_or(1).max(1));
        }
        PropertyType::Actor => {
            column.type_ = PropertyType::Actor;
            column.options = None;
            column.display = None;
            column.min = None;
            column.max = None;
            column.color = None;
            column.time_by_default = None;
            column.range_by_default = None;
            column.relation = None;
            column.relation_scope = None;
            column.limit = None;
            column.two_way = None;
            column.prefix = None;
            column.next = None;
            let multiple = strategy
                .and_then(|value| value.get("multiple"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| column.multiple.unwrap_or(false));
            column.multiple = Some(multiple);
        }
        _ => {
            column.options = None;
            column.relation = None;
            column.relation_scope = None;
            column.limit = None;
            column.two_way = None;
            column.prefix = None;
            column.next = None;
            column.multiple = None;
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

fn convert_value_for_type_from_old(
    value: Value,
    old_column: Option<&Column>,
    column: &Column,
) -> Value {
    if old_column.is_some_and(|old| old.type_ == PropertyType::UniqueId)
        && column.type_ == PropertyType::Text
        && let Some(number) = unique_id_value(&value)
    {
        return Value::String(unique_id_display_value(old_column.unwrap(), number));
    }
    convert_value_for_type(value, column)
}

fn unique_id_display_value(column: &Column, number: u64) -> String {
    if let Some(prefix) = column.prefix.as_deref().filter(|prefix| !prefix.is_empty()) {
        format!("{prefix}-{number}")
    } else {
        number.to_string()
    }
}

fn convert_value_for_type(value: Value, column: &Column) -> Value {
    let original = value.clone();
    let converted = match column.type_ {
        PropertyType::Text => value_to_scalar_string(&value).map(Value::String),
        PropertyType::Number => {
            value_to_f64(&value).and_then(|number| serde_yml::to_value(number).ok())
        }
        PropertyType::UniqueId => value_to_unique_id_number(&value).map(yaml_u64),
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
        PropertyType::Actor => normalize_actor_value(column, value).ok(),
        PropertyType::Url | PropertyType::Email | PropertyType::Phone => {
            value_to_scalar_string(&value).map(Value::String)
        }
        PropertyType::Relation => convert_value_for_relation(value, column),
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

fn value_to_unique_id_number(value: &Value) -> Option<u64> {
    match value {
        Value::Number(_) => unique_id_value(value),
        Value::String(value) => value
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|number| *number >= 1),
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

fn convert_value_for_relation(value: Value, column: &Column) -> Option<Value> {
    if value.is_null() {
        return Some(Value::Null);
    }
    if column.limit == Some(RelationLimit::One) {
        return value_to_first_string(&value)
            .and_then(|raw| normalize_relation_value_shape(&raw).ok())
            .map(Value::String);
    }
    match value {
        Value::Sequence(sequence) => {
            let mut seen = HashSet::new();
            let values = sequence
                .into_iter()
                .filter_map(|item| value_to_scalar_string(&item))
                .filter_map(|raw| normalize_relation_value_shape(&raw).ok())
                .filter(|normalized| seen.insert(normalized.clone()))
                .map(Value::String)
                .collect();
            Some(Value::Sequence(values))
        }
        other => value_to_scalar_string(&other)
            .and_then(|raw| normalize_relation_value_shape(&raw).ok())
            .map(|item| Value::Sequence(vec![Value::String(item)])),
    }
}

fn convert_value_for_relation_change(
    space: &str,
    column: &Column,
    value: Value,
) -> Result<(Option<Value>, Option<Value>), AppError> {
    if value.is_null() {
        return Ok((None, None));
    }
    let relation = column.relation.as_deref().ok_or_else(|| {
        schema_error(format!(
            "relation column '{}' requires relation",
            column.name
        ))
    })?;

    if column.limit == Some(RelationLimit::One) {
        let mut converted = None;
        let mut extra = Vec::new();
        let items = match value {
            Value::Sequence(sequence) => sequence,
            other => vec![other],
        };
        for item in items {
            let Some(raw) = value_to_scalar_string(&item) else {
                extra.push(item);
                continue;
            };
            match canonicalize_relation_target_value(space, relation, &raw) {
                Ok(value) if converted.is_none() => {
                    converted = Some(Value::String(value));
                }
                Ok(_) | Err(_) => extra.push(Value::String(raw)),
            }
        }
        let extra = match extra.len() {
            0 => None,
            1 => Some(extra.remove(0)),
            _ => Some(Value::Sequence(extra)),
        };
        return Ok((converted, extra));
    }

    let mut seen = HashSet::new();
    let mut converted = Vec::new();
    let mut extra = Vec::new();
    match value {
        Value::Sequence(sequence) => {
            for item in sequence {
                let Some(raw) = value_to_scalar_string(&item) else {
                    extra.push(item);
                    continue;
                };
                match canonicalize_relation_target_value(space, relation, &raw) {
                    Ok(value) if seen.insert(value.clone()) => {
                        converted.push(Value::String(value));
                    }
                    Ok(_) => {}
                    Err(_) => extra.push(Value::String(raw)),
                }
            }
        }
        other => {
            let Some(raw) = value_to_scalar_string(&other) else {
                return Ok((None, Some(other)));
            };
            match canonicalize_relation_target_value(space, relation, &raw) {
                Ok(value) => converted.push(Value::String(value)),
                Err(_) => extra.push(Value::String(raw)),
            }
        }
    }

    let converted = (!converted.is_empty()).then_some(Value::Sequence(converted));
    let extra = match extra.len() {
        0 => None,
        1 => Some(extra.remove(0)),
        _ => Some(Value::Sequence(extra)),
    };
    Ok((converted, extra))
}

fn unique_extra_field_name(
    space: &str,
    collection_path: &str,
    schema: &CollectionSchema,
    base: &str,
) -> Result<String, AppError> {
    let mut used: HashSet<String> = schema
        .columns
        .iter()
        .map(|column| column.name.clone())
        .collect();
    for file in collection_markdown_files(space, collection_path)? {
        let raw = fs::read_to_string(file)?;
        if let Some((meta, _)) = frontmatter::try_parse(&raw)? {
            used.extend(meta.extra.keys().cloned());
        }
    }
    if !used.contains(base) {
        return Ok(base.to_string());
    }
    for index in 2..=1000 {
        let candidate = format!("{base} {index}");
        if !used.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "{base} {}",
        ulid::Ulid::new().to_string().to_lowercase()
    ))
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

pub(super) fn strip_string_refs_in_views(views: &mut [View], target: &str) {
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
    if mapping.contains_key("sensitivity") {
        column.sensitivity = nullable_from_mapping(mapping, "sensitivity")?;
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
    if mapping.contains_key("relation") {
        column.relation = nullable_from_mapping(mapping, "relation")?;
    }
    if mapping.contains_key("relation_scope") {
        column.relation_scope = nullable_from_mapping(mapping, "relation_scope")?;
    }
    if mapping.contains_key("limit") {
        column.limit = nullable_from_mapping(mapping, "limit")?;
    }
    if mapping.contains_key("two_way") {
        column.two_way = nullable_from_mapping(mapping, "two_way")?;
    }
    if mapping.contains_key("prefix") {
        column.prefix = nullable_from_mapping(mapping, "prefix")?;
        column.prefix = trim_unique_id_prefix(column.prefix.take());
    }
    if mapping.contains_key("multiple") {
        column.multiple = nullable_from_mapping(mapping, "multiple")?;
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
