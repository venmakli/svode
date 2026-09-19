use super::*;

pub struct PreparedCollectionMutation<T> {
    paths: Vec<PathBuf>,
    apply: Box<dyn FnOnce() -> Result<T, CollectionError> + Send>,
}

#[derive(Debug)]
pub struct CollectionMutationOutcome<T> {
    pub value: T,
    pub changed_paths: Vec<PathBuf>,
}

impl<T> PreparedCollectionMutation<T> {
    pub fn new(
        mut paths: Vec<PathBuf>,
        apply: impl FnOnce() -> Result<T, CollectionError> + Send + 'static,
    ) -> Self {
        paths.sort();
        paths.dedup();
        Self {
            paths,
            apply: Box::new(apply),
        }
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    pub fn apply(self) -> Result<CollectionMutationOutcome<T>, CollectionError> {
        let snapshot = MutationSnapshot::capture(&self.paths)?;
        let value = match (self.apply)() {
            Ok(value) => value,
            Err(error) => return Err(snapshot.rollback(error)),
        };
        Ok(CollectionMutationOutcome {
            value,
            changed_paths: snapshot.changed_paths()?,
        })
    }
}

struct MutationSnapshot(Vec<(PathBuf, Option<Vec<u8>>)>);

impl MutationSnapshot {
    fn capture(paths: &[PathBuf]) -> Result<Self, CollectionError> {
        let mut snapshot = Vec::with_capacity(paths.len());
        for path in paths {
            let bytes = match fs::read(path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            snapshot.push((path.clone(), bytes));
        }
        Ok(Self(snapshot))
    }

    fn changed_paths(self) -> Result<Vec<PathBuf>, CollectionError> {
        let mut changed = Vec::new();
        for (path, before) in self.0 {
            let after = match fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if before != after {
                changed.push(path);
            }
        }
        Ok(changed)
    }

    fn rollback(&self, cause: CollectionError) -> CollectionError {
        let mut failed = Vec::new();
        for (path, original) in self.0.iter().rev() {
            let restored = match original {
                Some(bytes) => {
                    if let Some(parent) = path.parent()
                        && let Err(error) = fs::create_dir_all(parent)
                    {
                        failed.push(format!("{}: {error}", parent.display()));
                        continue;
                    }
                    fs::write(path, bytes)
                }
                None => match fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error),
                },
            };
            if let Err(error) = restored {
                failed.push(format!("{}: {error}", path.display()));
            }
        }
        if failed.is_empty() {
            cause
        } else {
            CollectionError::Recovery {
                cause: cause.to_string(),
                paths: failed,
            }
        }
    }
}

pub fn prepare_initial_collection_schema(
    space: &str,
    collection_path: &str,
    mut schema: CollectionSchema,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    normalize_schema(&mut schema);
    validate_schema(&schema)?;
    validate_schema_relations_in_space(space, project_path, collection_path, &schema)?;
    let mut paths = schema_mutation_paths(space, collection_path, false)?;
    for column in &schema.columns {
        paths.extend(schema_column_mutation_paths_with_project(
            space,
            collection_path,
            column,
            false,
            project_path,
        )?);
    }
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        let columns = schema.columns.clone();
        let views = schema.views.clone();
        let mut seed = default_collection_schema();
        seed.system_fields = schema.system_fields.clone();
        seed.templates = schema.templates.clone();
        write_schema_with_project(&space, &collection_path, &seed, project_path.as_deref())?;
        for column in columns {
            add_schema_column_with_project(
                &space,
                &collection_path,
                column,
                project_path.as_deref(),
            )?;
        }
        let mut result = read_schema_or_default(&space, &collection_path)?;
        result.views = views;
        write_schema_with_project(&space, &collection_path, &result, project_path.as_deref())?;
        read_schema_or_default(&space, &collection_path)
    }))
}

pub fn prepare_add_schema_column(
    space: &str,
    collection_path: &str,
    column: Column,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_column_mutation_paths_with_project(
        space,
        collection_path,
        &column,
        column.type_ == PropertyType::UniqueId,
        project_path,
    )?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        add_schema_column_with_project(&space, &collection_path, column, project_path.as_deref())
    }))
}

pub fn prepare_change_schema_type(
    space: &str,
    collection_path: &str,
    column_name: &str,
    new_type: PropertyType,
    conversion_strategy: Option<Value>,
    project_path: Option<&str>,
) -> Result<
    PreparedCollectionMutation<(CollectionSchema, Vec<SchemaMutationWarning>)>,
    CollectionError,
> {
    let mut paths = schema_column_name_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        true,
        project_path,
    )?;
    paths.extend(schema_type_target_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        new_type,
        conversion_strategy.as_ref(),
        project_path,
    )?);
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let column_name = column_name.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        change_schema_type_with_warnings_and_project(
            &space,
            &collection_path,
            &column_name,
            new_type,
            conversion_strategy,
            project_path.as_deref(),
        )
    }))
}

pub fn prepare_rename_schema_column(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_column_name_mutation_paths_with_project(
        space,
        collection_path,
        old_name,
        true,
        project_path,
    )?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let old_name = old_name.to_string();
    let new_name = new_name.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        rename_schema_column_with_project(
            &space,
            &collection_path,
            &old_name,
            &new_name,
            project_path.as_deref(),
        )
    }))
}

pub fn prepare_update_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    patch: Value,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let mut paths = schema_column_name_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        true,
        project_path,
    )?;
    paths.extend(schema_column_patch_target_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        &patch,
        project_path,
    )?);
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let column_name = column_name.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        update_schema_column_with_project(
            &space,
            &collection_path,
            &column_name,
            patch,
            project_path.as_deref(),
        )
    }))
}

pub fn prepare_delete_schema_column(
    space: &str,
    collection_path: &str,
    column_name: &str,
    delete_values: bool,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let mut paths = schema_mutation_paths(space, collection_path, delete_values)?;
    paths.extend(schema_column_name_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        delete_values,
        project_path,
    )?);
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let column_name = column_name.to_string();
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        delete_schema_column_with_project(
            &space,
            &collection_path,
            &column_name,
            delete_values,
            project_path.as_deref(),
        )
    }))
}

pub fn prepare_add_option(
    space: &str,
    collection_path: &str,
    column_name: String,
    option: PropertyOption,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        add_option(&space, &collection_path, &column_name, option)
    }))
}

pub fn prepare_update_option(
    space: &str,
    collection_path: &str,
    column_name: String,
    option_name: String,
    option: Option<PropertyOption>,
    patch: Option<Value>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        update_option(
            &space,
            &collection_path,
            &column_name,
            &option_name,
            option,
            patch,
        )
    }))
}

pub fn prepare_promote_orphan(
    space: &str,
    collection_path: &str,
    file_path: String,
    field: String,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        promote_orphan(&space, &collection_path, &file_path, &field)
    }))
}

pub fn prepare_update_system_field_label(
    space: &str,
    collection_path: &str,
    field: String,
    label: Option<String>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        update_system_field_label(&space, &collection_path, &field, label)
    }))
}

pub fn prepare_rename_option(
    space: &str,
    collection_path: &str,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, true)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        rename_option(
            &space,
            &collection_path,
            &column_name,
            &old_option_name,
            &new_option_name,
        )
    }))
}

pub fn prepare_delete_option(
    space: &str,
    collection_path: &str,
    column_name: String,
    option_name: String,
    delete_values: bool,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, delete_values)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        delete_option(
            &space,
            &collection_path,
            &column_name,
            &option_name,
            delete_values,
        )
    }))
}

pub fn prepare_clear_field_values(
    space: &str,
    collection_path: &str,
    field: String,
) -> Result<PreparedCollectionMutation<()>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, true)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        clear_field_values(&space, &collection_path, &field).map(|_| ())
    }))
}

pub fn prepare_clear_option_values(
    space: &str,
    collection_path: &str,
    column_name: String,
    option_names: Vec<String>,
) -> Result<PreparedCollectionMutation<()>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, true)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        clear_option_values(&space, &collection_path, &column_name, &option_names).map(|_| ())
    }))
}

pub fn prepare_replace_option_values(
    space: &str,
    collection_path: &str,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
) -> Result<PreparedCollectionMutation<()>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, true)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        replace_option_values(
            &space,
            &collection_path,
            &column_name,
            &old_option_name,
            &new_option_name,
        )
        .map(|_| ())
    }))
}

pub fn prepare_assign_unique_id(
    space: &str,
    file_path: &str,
) -> Result<PreparedCollectionMutation<()>, CollectionError> {
    let paths = unique_id_mutation_paths_for_entry(space, file_path)?;
    let space = space.to_string();
    let file_path = file_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        assign_unique_id(&space, &file_path)
    }))
}

pub fn prepare_normalize_unique_id_counter(
    space: &str,
    collection_path: &str,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        normalize_unique_id_counter(&space, &collection_path)
    }))
}

pub fn prepare_repair_two_way_relation(
    space: &str,
    collection_path: &str,
    column_name: &str,
    strategy: &str,
    reverse_column: Option<&str>,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<()>, CollectionError> {
    let paths = relation_repair_mutation_paths_with_project(
        space,
        collection_path,
        column_name,
        project_path,
    )?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let column_name = column_name.to_string();
    let strategy = strategy.to_string();
    let reverse_column = reverse_column.map(str::to_string);
    let project_path = project_path.map(str::to_string);
    Ok(PreparedCollectionMutation::new(paths, move || {
        repair_two_way_relation_with_project(
            &space,
            &collection_path,
            &column_name,
            &strategy,
            reverse_column.as_deref(),
            project_path.as_deref(),
        )
    }))
}

pub fn prepare_add_view(
    space: &str,
    collection_path: &str,
    view: View,
    position: Option<usize>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        add_view(&space, &collection_path, view, position)
    }))
}

pub fn prepare_rename_view(
    space: &str,
    collection_path: &str,
    old_name: &str,
    new_name: &str,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let old_name = old_name.to_string();
    let new_name = new_name.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        rename_view(&space, &collection_path, &old_name, &new_name)
    }))
}

pub fn prepare_update_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
    patch: Value,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let view_name = view_name.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        update_view(&space, &collection_path, &view_name, patch)
    }))
}

pub fn prepare_delete_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let view_name = view_name.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        delete_view(&space, &collection_path, &view_name)
    }))
}

pub fn prepare_duplicate_view(
    space: &str,
    collection_path: &str,
    view_name: &str,
    new_name: &str,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    let view_name = view_name.to_string();
    let new_name = new_name.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        duplicate_view(&space, &collection_path, &view_name, &new_name)
    }))
}

pub fn prepare_reorder_views(
    space: &str,
    collection_path: &str,
    new_order: Vec<String>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, CollectionError> {
    let paths = schema_mutation_paths(space, collection_path, false)?;
    let space = space.to_string();
    let collection_path = collection_path.to_string();
    Ok(PreparedCollectionMutation::new(paths, move || {
        reorder_views(&space, &collection_path, new_order)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn table(name: &str) -> View {
        View::Table {
            name: name.to_string(),
            filter: Vec::new(),
            sort: Vec::new(),
            visible_fields: vec!["title".to_string()],
            show_nested: None,
        }
    }

    #[test]
    fn prepared_view_operations_report_actual_schema_changes() {
        let temp = TempDir::new().unwrap();
        let space = temp.path().to_string_lossy().to_string();
        fs::create_dir(temp.path().join("tasks")).unwrap();
        write_default_collection_schema(&space, "tasks").unwrap();
        let schema_path = temp.path().join("tasks/schema.yaml");

        let added = prepare_add_view(&space, "tasks", table("Board"), None)
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(added.changed_paths, [schema_path.clone()]);

        let renamed = prepare_rename_view(&space, "tasks", "Board", "Roadmap")
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(renamed.changed_paths, [schema_path.clone()]);

        let patch: Value = serde_yml::from_str("show_nested: false\n").unwrap();
        let updated = prepare_update_view(&space, "tasks", "Roadmap", patch.clone())
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(updated.changed_paths, [schema_path.clone()]);
        let unchanged = prepare_update_view(&space, "tasks", "Roadmap", patch)
            .unwrap()
            .apply()
            .unwrap();
        assert!(unchanged.changed_paths.is_empty());

        prepare_duplicate_view(&space, "tasks", "Roadmap", "Roadmap copy")
            .unwrap()
            .apply()
            .unwrap();
        prepare_reorder_views(
            &space,
            "tasks",
            vec![
                "Roadmap copy".to_string(),
                "Все".to_string(),
                "Roadmap".to_string(),
            ],
        )
        .unwrap()
        .apply()
        .unwrap();
        let deleted = prepare_delete_view(&space, "tasks", "Roadmap copy")
            .unwrap()
            .apply()
            .unwrap();
        assert_eq!(deleted.changed_paths, [schema_path.clone()]);

        let before = fs::read(&schema_path).unwrap();
        let invalid = prepare_reorder_views(&space, "tasks", vec!["Roadmap".to_string()])
            .unwrap()
            .apply();
        assert!(invalid.is_err());
        assert_eq!(fs::read(schema_path).unwrap(), before);
    }
}
