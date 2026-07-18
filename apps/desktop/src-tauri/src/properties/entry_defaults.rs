use super::*;

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
        if let Some(default) = column.default.clone() {
            let default = normalize_property_value_for_write(&column, default)?;
            if !default.is_null() {
                meta.extra.insert(column.name, default);
            }
            changed = true;
        }
    }
    Ok(changed)
}

pub fn apply_contextual_defaults_for_path(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<bool, AppError> {
    if contextual_defaults.is_empty() {
        return Ok(false);
    }

    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(false);
    };

    let mut changed = false;
    for (field, value) in contextual_defaults {
        let Some(column) = schema.columns.iter().find(|column| column.name == *field) else {
            continue;
        };
        let value = normalize_property_value_for_write(column, value.clone())?;
        if value.is_null() {
            meta.extra.remove(field);
        } else {
            meta.extra.insert(field.clone(), value);
        }
        changed = true;
    }
    Ok(changed)
}

pub fn apply_contextual_defaults_for_path_strict(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    contextual_defaults: &HashMap<String, Value>,
) -> Result<bool, AppError> {
    if contextual_defaults.is_empty() {
        return Ok(false);
    }

    let Some((schema, _)) = resolve_collection_schema_result(space, file_path)? else {
        return Err(schema_error(
            "contextual defaults require a collection schema",
        ));
    };

    let mut changed = false;
    for (field, value) in contextual_defaults {
        let column = schema
            .columns
            .iter()
            .find(|column| column.name == *field)
            .ok_or_else(|| schema_error(format!("unknown contextual default field '{field}'")))?;
        let value = normalize_property_value_for_write(column, value.clone())?;
        if value.is_null() {
            meta.extra.remove(field);
        } else {
            meta.extra.insert(field.clone(), value);
        }
        changed = true;
    }
    Ok(changed)
}

pub fn apply_schema_defaults_to_entry_tree(space: &Path, rel_path: &str) -> Result<(), AppError> {
    let abs = space.join(rel_path);
    if abs.is_dir() {
        for path in collect_md_files_in_space(space, &abs)? {
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
    let abs = space.join(rel_path);
    let raw = fs::read_to_string(&abs)?;
    let (mut meta, body) = match frontmatter::parse_status(&raw) {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        frontmatter::ParseStatus::Missing { body } => {
            let title = entry::title_from_stem(
                Path::new(rel_path)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("untitled"),
            );
            (
                EntryMeta::synthesized(title, String::new(), String::new()),
                body,
            )
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(AppError::FrontmatterParse(format!(
                "cannot apply schema defaults while frontmatter is malformed: {message}"
            )));
        }
    };
    let changed_defaults = apply_schema_defaults_for_path(&space_str, rel_path, &mut meta)?;
    let changed_unique_id = assign_unique_id_to_meta_for_path(&space_str, rel_path, &mut meta)?;
    if changed_defaults || changed_unique_id {
        fs::write(abs, frontmatter::serialize(&meta, &body))?;
    }
    Ok(())
}

pub fn unique_id_mutation_paths_for_entry(
    space: &str,
    file_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = vec![Path::new(space).join(normalize_rel_path(file_path))];
    if let Some(schema_path) = unique_id_schema_path_for_entry(space, file_path)? {
        paths.push(schema_path);
    }
    Ok(paths)
}

pub fn unique_id_mutation_paths_for_entry_tree(
    space: &Path,
    rel_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    for file in markdown_files_in_tree(space, rel_path)? {
        let rel = copy_rel_from_abs(space, &file);
        if let Some(schema_path) = unique_id_schema_path_for_entry(&space.to_string_lossy(), &rel)?
        {
            paths.push(file);
            paths.push(schema_path);
        }
    }
    dedupe_paths(paths)
}

pub fn unique_id_schema_path_for_entry(
    space: &str,
    file_path: &str,
) -> Result<Option<PathBuf>, AppError> {
    let Some((schema, root)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(None);
    };
    if schema
        .columns
        .iter()
        .any(|column| column.type_ == PropertyType::UniqueId)
    {
        Ok(Some(Path::new(space).join(root).join(SCHEMA_FILE)))
    } else {
        Ok(None)
    }
}

pub fn assign_unique_ids_to_entry_tree(
    space: &Path,
    rel_path: &str,
    force: bool,
) -> Result<(), AppError> {
    for file in markdown_files_in_tree(space, rel_path)? {
        let rel = copy_rel_from_abs(space, &file);
        assign_unique_id_to_file(&space.to_string_lossy(), &rel, force)?;
    }
    Ok(())
}

pub fn assign_unique_id(space: &str, file_path: &str) -> Result<entry::Entry, AppError> {
    let paths = unique_id_mutation_paths_for_entry(space, file_path)?;
    with_rollback(paths, || {
        assign_unique_id_to_file(space, file_path, true)?;
        entry::read(space, file_path)
    })
}

pub fn normalize_unique_id_counter(
    space: &str,
    collection_path: &str,
) -> Result<CollectionSchema, AppError> {
    let schema_path = collection_dir(space, collection_path).join(SCHEMA_FILE);
    with_rollback(vec![schema_path], || {
        let mut schema = read_schema_or_default(space, collection_path)?;
        let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.type_ == PropertyType::UniqueId)
            .cloned()
        else {
            return Ok(schema);
        };
        let values = collection_unique_id_values(space, collection_path, &column.name, None)?;
        let max_existing = values.iter().map(|(_, value)| *value).max().unwrap_or(0);
        let required_next = next_after(max_existing)?;
        let current_next = column.next.unwrap_or(1);
        if current_next < required_next {
            set_unique_id_next(&mut schema, &column.name, required_next)?;
            write_schema(space, collection_path, &schema)?;
        }
        read_schema_or_default(space, collection_path)
    })
}

fn assign_unique_id_to_file(space: &str, file_path: &str, force: bool) -> Result<bool, AppError> {
    let rel = normalize_rel_path(file_path);
    let abs = Path::new(space).join(&rel);
    let raw = fs::read_to_string(&abs)?;
    let (mut meta, body) = match frontmatter::parse_status(&raw) {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        frontmatter::ParseStatus::Missing { body } => {
            let title = entry::title_from_stem(
                Path::new(&rel)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("untitled"),
            );
            (
                EntryMeta::synthesized(title, String::new(), String::new()),
                body,
            )
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(AppError::FrontmatterParse(format!(
                "cannot assign unique_id while frontmatter is malformed: {message}"
            )));
        }
    };
    let changed = if force {
        force_assign_unique_id_to_meta(space, &rel, &mut meta)?
    } else {
        assign_unique_id_to_meta_for_path(space, &rel, &mut meta)?
    };
    if changed {
        fs::write(abs, frontmatter::serialize(&meta, &body))?;
    }
    Ok(changed)
}

pub fn assign_unique_id_to_meta_for_path(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
) -> Result<bool, AppError> {
    assign_unique_id_to_meta_inner(space, file_path, meta, false)
}

fn force_assign_unique_id_to_meta(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
) -> Result<bool, AppError> {
    assign_unique_id_to_meta_inner(space, file_path, meta, true)
}

fn assign_unique_id_to_meta_inner(
    space: &str,
    file_path: &str,
    meta: &mut EntryMeta,
    force: bool,
) -> Result<bool, AppError> {
    let Some((mut schema, root)) = resolve_collection_schema_result(space, file_path)? else {
        return Ok(false);
    };
    let collection_path = rel_path_string(&root);
    let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .cloned()
    else {
        return Ok(false);
    };
    let field = column.name.clone();
    let existing = meta.extra.get(&field).and_then(unique_id_value);
    let values = collection_unique_id_values(space, &collection_path, &field, Some(file_path))?;
    let duplicate = existing.is_some_and(|value| values.iter().any(|(_, other)| *other == value));
    let invalid_or_missing = existing.is_none();
    let mut changed = false;

    if force || invalid_or_missing || duplicate {
        let fresh = next_unique_id_value(&schema, &values)?;
        meta.extra.insert(field.clone(), yaml_u64(fresh));
        set_unique_id_next(&mut schema, &field, next_after(fresh)?)?;
        write_schema(space, &collection_path, &schema)?;
        return Ok(true);
    }

    if let Some(existing) = existing {
        let required_next = next_after(existing)?;
        if column.next.unwrap_or(1) < required_next {
            set_unique_id_next(&mut schema, &field, required_next)?;
            write_schema(space, &collection_path, &schema)?;
            changed = true;
        }
    }
    Ok(changed)
}

pub(super) fn materialize_unique_id_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
) -> Result<(), AppError> {
    let mut schema = read_schema_or_default(space, collection_path)?;
    let files = sorted_collection_markdown_files_for_unique_id(space, collection_path)?;
    let mut used = HashSet::new();
    let mut next = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
        .and_then(|column| column.next)
        .unwrap_or(1)
        .max(1);

    for file in files {
        let raw = fs::read_to_string(&file)?;
        let rel = copy_rel_from_abs(Path::new(space), &file);
        let (mut meta, body) = match frontmatter::parse_status(&raw) {
            frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
            frontmatter::ParseStatus::Missing { body } => {
                let title = entry::title_from_stem(
                    Path::new(&rel)
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("untitled"),
                );
                (
                    EntryMeta::synthesized(title, String::new(), String::new()),
                    body,
                )
            }
            frontmatter::ParseStatus::Malformed { message, .. } => {
                return Err(AppError::FrontmatterParse(format!(
                    "cannot assign unique_id while frontmatter is malformed: {message}"
                )));
            }
        };
        let existing = meta.extra.get(column_name).and_then(unique_id_value);
        let keep = existing.is_some_and(|value| used.insert(value));
        if keep {
            next = next.max(next_after(existing.unwrap())?);
            continue;
        }
        while used.contains(&next) {
            next = next_after(next)?;
        }
        let assigned = next;
        used.insert(assigned);
        meta.extra
            .insert(column_name.to_string(), yaml_u64(assigned));
        fs::write(&file, frontmatter::serialize(&meta, &body))?;
        next = next_after(assigned)?;
    }

    set_unique_id_next(&mut schema, column_name, next)?;
    write_schema(space, collection_path, &schema)
}

fn collection_unique_id_values(
    space: &str,
    collection_path: &str,
    field: &str,
    exclude_path: Option<&str>,
) -> Result<Vec<(String, u64)>, AppError> {
    let exclude = exclude_path.map(normalize_rel_path);
    let mut values = Vec::new();
    for file in collection_markdown_files(space, collection_path)? {
        let rel = copy_rel_from_abs(Path::new(space), &file);
        if exclude.as_deref() == Some(rel.as_str()) {
            continue;
        }
        let raw = fs::read_to_string(&file)?;
        let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
            continue;
        };
        if let Some(value) = meta.extra.get(field).and_then(unique_id_value) {
            values.push((rel, value));
        }
    }
    Ok(values)
}

fn next_unique_id_value(
    schema: &CollectionSchema,
    existing_values: &[(String, u64)],
) -> Result<u64, AppError> {
    let schema_next = schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .and_then(|column| column.next)
        .unwrap_or(1)
        .max(1);
    let max_existing = existing_values
        .iter()
        .map(|(_, value)| *value)
        .max()
        .unwrap_or(0);
    Ok(schema_next.max(next_after(max_existing)?))
}

fn set_unique_id_next(
    schema: &mut CollectionSchema,
    field: &str,
    next: u64,
) -> Result<(), AppError> {
    let column = schema
        .columns
        .iter_mut()
        .find(|column| column.name == field && column.type_ == PropertyType::UniqueId)
        .ok_or_else(|| schema_error(format!("unique_id column '{field}' not found")))?;
    column.next = Some(next.max(1));
    Ok(())
}

fn next_after(value: u64) -> Result<u64, AppError> {
    value
        .checked_add(1)
        .ok_or_else(|| schema_error("unique_id counter overflow"))
}

fn sorted_collection_markdown_files_for_unique_id(
    space: &str,
    collection_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let order = crate::files::tree::read_order(Path::new(space));
    let mut rows = Vec::new();
    for file in collection_markdown_files(space, collection_path)? {
        let rel = copy_rel_from_abs(Path::new(space), &file);
        let parent = entry_parent_dir(&rel);
        let order_name = entry_order_name(&rel);
        let order_index = order
            .get(if parent.is_empty() {
                "."
            } else {
                parent.as_str()
            })
            .and_then(|items| items.iter().position(|item| item == &order_name));
        let title = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| {
                frontmatter::try_parse(&raw)
                    .ok()
                    .flatten()
                    .map(|(meta, _)| meta.title)
            })
            .unwrap_or_default()
            .to_lowercase();
        rows.push((file, parent, order_index, title, rel));
    }
    rows.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.is_none().cmp(&b.2.is_none()))
            .then_with(|| a.2.unwrap_or(usize::MAX).cmp(&b.2.unwrap_or(usize::MAX)))
            .then_with(|| a.3.cmp(&b.3))
            .then_with(|| a.4.cmp(&b.4))
    });
    Ok(rows.into_iter().map(|row| row.0).collect())
}

fn markdown_files_in_tree(space: &Path, rel_path: &str) -> Result<Vec<PathBuf>, AppError> {
    let abs = space.join(normalize_rel_path(rel_path));
    if abs.is_dir() {
        collect_md_files_in_space(space, &abs)
    } else if abs.extension().and_then(|ext| ext.to_str()) == Some("md") {
        Ok(vec![abs])
    } else {
        Ok(Vec::new())
    }
}

pub(super) fn dedupe_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, AppError> {
    let mut seen = HashSet::new();
    Ok(paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect())
}
