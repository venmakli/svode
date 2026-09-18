use super::*;

pub struct PreparedCollectionMutation<T> {
    paths: Vec<PathBuf>,
    apply: Box<dyn FnOnce() -> Result<T, AppError> + Send>,
}

#[derive(Debug)]
pub struct CollectionMutationOutcome<T> {
    pub value: T,
    pub changed_paths: Vec<PathBuf>,
}

impl<T> PreparedCollectionMutation<T> {
    fn new(
        mut paths: Vec<PathBuf>,
        apply: impl FnOnce() -> Result<T, AppError> + Send + 'static,
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

    pub fn apply(self) -> Result<CollectionMutationOutcome<T>, AppError> {
        let snapshot = MutationSnapshot::capture(&self.paths)?;
        let value = (self.apply)()?;
        Ok(CollectionMutationOutcome {
            value,
            changed_paths: snapshot.changed_paths()?,
        })
    }
}

struct MutationSnapshot(Vec<(PathBuf, Option<Vec<u8>>)>);

impl MutationSnapshot {
    fn capture(paths: &[PathBuf]) -> Result<Self, AppError> {
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

    fn changed_paths(self) -> Result<Vec<PathBuf>, AppError> {
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
}

pub fn prepare_add_schema_column(
    space: &str,
    collection_path: &str,
    column: Column,
    project_path: Option<&str>,
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<(CollectionSchema, Vec<SchemaMutationWarning>)>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<()>, AppError> {
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
) -> Result<PreparedCollectionMutation<()>, AppError> {
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
) -> Result<PreparedCollectionMutation<()>, AppError> {
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
) -> Result<PreparedCollectionMutation<entry::Entry>, AppError> {
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
) -> Result<PreparedCollectionMutation<CollectionSchema>, AppError> {
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
) -> Result<PreparedCollectionMutation<()>, AppError> {
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
