//! Tauri adapters for collection schema and property mutations.

use super::*;

#[tauri::command]
pub async fn add_schema_column(
    space: String,
    collection_path: String,
    column: Column,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let materializes_unique_id = column.type_ == PropertyType::UniqueId;
    let default_message = if materializes_unique_id {
        format!("Add and materialize unique_id \"{}\"", column.name)
    } else {
        format!("Add column \"{}\"", column.name)
    };
    let paths = properties::schema_column_mutation_paths_with_project(
        &space,
        &collection_path,
        &column,
        materializes_unique_id,
        project_path.as_deref(),
    )?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::add_schema_column_with_project(
        &space,
        &collection_path,
        column,
        project_path.as_deref(),
    )?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn change_schema_type(
    space: String,
    collection_path: String,
    column_name: String,
    new_type: PropertyType,
    conversion_strategy: Option<serde_json::Value>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<ChangeSchemaTypeResult, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let default_message = format!(
        "Change column \"{column_name}\" type to {}",
        property_type_message(new_type)
    );
    let mut paths = properties::schema_column_name_mutation_paths_with_project(
        &space,
        &collection_path,
        &column_name,
        true,
        project_path.as_deref(),
    )?;
    let snapshotted = paths.clone();
    let snapshot = snapshot_paths(&snapshotted)?;
    let conversion_strategy = conversion_strategy.map(json_to_yaml_value).transpose()?;
    let (schema, warnings) = properties::change_schema_type_with_warnings_and_project(
        &space,
        &collection_path,
        &column_name,
        new_type,
        conversion_strategy,
        project_path.as_deref(),
    )?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        append_unsnapshotted_paths(
            &mut paths,
            &snapshotted,
            properties::schema_column_mutation_paths_with_project(
                &space,
                &collection_path,
                column,
                true,
                project_path.as_deref(),
            )?,
        );
    }
    let mut changed = changed_paths(snapshot)?;
    append_unsnapshotted_paths(&mut changed, &snapshotted, paths);
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        changed,
        schema_commit_message_with_previous(
            &schema,
            was_sensitive,
            default_message,
            "Update collection field",
        ),
    )
    .await;
    Ok(ChangeSchemaTypeResult { schema, warnings })
}

#[tauri::command]
pub async fn assign_unique_id(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let paths = properties::unique_id_mutation_paths_for_entry(&space, &file_path)?;
    let entry = properties::assign_unique_id(&space, &file_path)?;
    update_index_entry_or_reindex(
        &index_state,
        project_path.as_deref(),
        &space,
        &entry.path,
        "assign_unique_id",
    )
    .await;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        if entry_in_sensitive_collection(&space, &entry.path) {
            "Repair unique_id for collection entry".to_string()
        } else {
            format!("Repair unique_id for {}", entry_history_name(&entry.path))
        },
    )
    .await;
    Ok(entry)
}

#[tauri::command]
pub async fn normalize_unique_id_counter(
    space: String,
    collection_path: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::normalize_unique_id_counter(&space, &collection_path)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        "Normalize unique_id counter".to_string(),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_schema_column(
    space: String,
    collection_path: String,
    old_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let paths = properties::schema_column_name_mutation_paths_with_project(
        &space,
        &collection_path,
        &old_name,
        true,
        project_path.as_deref(),
    )?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::rename_schema_column_with_project(
        &space,
        &collection_path,
        &old_name,
        &new_name,
        project_path.as_deref(),
    )?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Rename column \"{old_name}\" → \"{new_name}\""),
        "Rename sensitive field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_schema_column(
    space: String,
    collection_path: String,
    column_name: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let mut paths = properties::schema_column_name_mutation_paths_with_project(
        &space,
        &collection_path,
        &column_name,
        false,
        project_path.as_deref(),
    )?;
    let snapshotted = paths.clone();
    let snapshot = snapshot_paths(&snapshotted)?;
    let patch = json_to_yaml_value(patch)?;
    let schema = properties::update_schema_column_with_project(
        &space,
        &collection_path,
        &column_name,
        patch,
        project_path.as_deref(),
    )?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        append_unsnapshotted_paths(
            &mut paths,
            &snapshotted,
            properties::schema_column_mutation_paths_with_project(
                &space,
                &collection_path,
                column,
                column.type_ == PropertyType::Relation,
                project_path.as_deref(),
            )?,
        );
    }
    let mut changed = changed_paths(snapshot)?;
    append_unsnapshotted_paths(&mut changed, &snapshotted, paths);
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Update column \"{column_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        changed,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_schema_column(
    space: String,
    collection_path: String,
    column_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let delete_values = delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::delete_schema_column_with_project(
        &space,
        &collection_path,
        &column_name,
        delete_values,
        project_path.as_deref(),
    )?;
    let paths = changed_paths(snapshot)?;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Delete column \"{column_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn add_option(
    space: String,
    collection_path: String,
    column_name: String,
    option: PropertyOption,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let default_message = format!("Add option \"{}\" to \"{column_name}\"", option.name);
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_option(&space, &collection_path, &column_name, option)?;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_option(
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, true)?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::rename_option(
        &space,
        &collection_path,
        &column_name,
        &old_option_name,
        &new_option_name,
    )?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message(
        &schema,
        format!("Rename option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_option(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let delete_values = delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::delete_option(
        &space,
        &collection_path,
        &column_name,
        &option_name,
        delete_values,
    )?;
    let paths = changed_paths(snapshot)?;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message(
        &schema,
        format!("Delete option \"{column_name}\": \"{option_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_option(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    option: Option<PropertyOption>,
    patch: Option<serde_json::Value>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let patch = patch.map(json_to_yaml_value).transpose()?;
    let schema = properties::update_option(
        &space,
        &collection_path,
        &column_name,
        &option_name,
        option,
        patch,
    )?;
    let message = schema_commit_message(
        &schema,
        format!("Update option \"{column_name}\": \"{option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn promote_orphan(
    space: String,
    collection_path: String,
    file_path: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::promote_orphan(&space, &collection_path, &file_path, &field)?;
    let message = schema_commit_message(
        &schema,
        format!("Add column \"{field}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn clear_field_values(
    space: String,
    collection_path: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::clear_field_values(&space, &collection_path, &field)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Clear field \"{field}\" values")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_option_values(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: Option<String>,
    option_names: Option<Vec<String>>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let mut names = option_names.unwrap_or_default();
    if let Some(option_name) = option_name {
        names.push(option_name);
    }
    names.sort();
    names.dedup();
    let paths = properties::clear_option_values(&space, &collection_path, &column_name, &names)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else if names.len() == 1 {
        format!("Clear option \"{column_name}\": \"{}\" values", names[0])
    } else {
        format!("Clear option \"{column_name}\" values")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
}

#[tauri::command]
pub async fn replace_option_values(
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::replace_option_values(
        &space,
        &collection_path,
        &column_name,
        &old_option_name,
        &new_option_name,
    )?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Replace option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\"")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
}

#[tauri::command]
pub async fn update_system_field_label(
    space: String,
    collection_path: String,
    field: String,
    label: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::update_system_field_label(&space, &collection_path, &field, label)?;
    let message = schema_commit_message(
        &schema,
        format!("Update system field \"{field}\""),
        "Update collection schema",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub fn get_collection_schema(
    space: String,
    collection_path: String,
) -> Result<CollectionSchema, AppError> {
    properties::read_collection_schema(&space, &collection_path)
}
