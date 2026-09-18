//! Tauri adapters for collection schema and property mutations.

use super::*;

#[tauri::command]
pub async fn add_schema_column(
    app: AppHandle,
    space: String,
    collection_path: String,
    column: Column,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let default_message = if column.type_ == PropertyType::UniqueId {
        format!("Add and materialize unique_id \"{}\"", column.name)
    } else {
        format!("Add column \"{}\"", column.name)
    };
    let mutation = properties::prepare_add_schema_column(
        &space,
        &collection_path,
        column,
        project_path.as_deref(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn change_schema_type(
    app: AppHandle,
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
    let conversion_strategy = conversion_strategy.map(json_to_yaml_value).transpose()?;
    let mutation = properties::prepare_change_schema_type(
        &space,
        &collection_path,
        &column_name,
        new_type,
        conversion_strategy,
        project_path.as_deref(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let (schema, warnings) = outcome.value;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
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
    app: AppHandle,
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let mutation = properties::prepare_assign_unique_id(&space, &file_path)?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let entry = outcome.value;
    update_index_entry_or_reindex(
        &index_state,
        &index_updates,
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
        outcome.changed_paths,
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
    app: AppHandle,
    space: String,
    collection_path: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let mutation = properties::prepare_normalize_unique_id_counter(&space, &collection_path)?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        "Normalize unique_id counter".to_string(),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_schema_column(
    app: AppHandle,
    space: String,
    collection_path: String,
    old_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let mutation = properties::prepare_rename_schema_column(
        &space,
        &collection_path,
        &old_name,
        &new_name,
        project_path.as_deref(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Rename column \"{old_name}\" → \"{new_name}\""),
        "Rename sensitive field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_schema_column(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let patch = json_to_yaml_value(patch)?;
    let mutation = properties::prepare_update_schema_column(
        &space,
        &collection_path,
        &column_name,
        patch,
        project_path.as_deref(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
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
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_schema_column(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let delete_values = delete_values.unwrap_or(false);
    let mutation = properties::prepare_delete_schema_column(
        &space,
        &collection_path,
        &column_name,
        delete_values,
        project_path.as_deref(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Delete column \"{column_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn add_option(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    option: PropertyOption,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let default_message = format!("Add option \"{}\" to \"{column_name}\"", option.name);
    let mutation = properties::prepare_add_option(&space, &collection_path, column_name, option)?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_option(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let mutation = properties::prepare_rename_option(
        &space,
        &collection_path,
        column_name.clone(),
        old_option_name.clone(),
        new_option_name.clone(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(
        &schema,
        format!("Rename option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_option(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let delete_values = delete_values.unwrap_or(false);
    let mutation = properties::prepare_delete_option(
        &space,
        &collection_path,
        column_name.clone(),
        option_name.clone(),
        delete_values,
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message(
        &schema,
        format!("Delete option \"{column_name}\": \"{option_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_option(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    option: Option<PropertyOption>,
    patch: Option<serde_json::Value>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let patch = patch.map(json_to_yaml_value).transpose()?;
    let mutation = properties::prepare_update_option(
        &space,
        &collection_path,
        column_name.clone(),
        option_name.clone(),
        option,
        patch,
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(
        &schema,
        format!("Update option \"{column_name}\": \"{option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn promote_orphan(
    app: AppHandle,
    space: String,
    collection_path: String,
    file_path: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let mutation =
        properties::prepare_promote_orphan(&space, &collection_path, file_path, field.clone())?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(
        &schema,
        format!("Add column \"{field}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn clear_field_values(
    app: AppHandle,
    space: String,
    collection_path: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let mutation = properties::prepare_clear_field_values(&space, &collection_path, field.clone())?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Clear field \"{field}\" values")
    };
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn clear_option_values(
    app: AppHandle,
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
    let mutation = properties::prepare_clear_option_values(
        &space,
        &collection_path,
        column_name.clone(),
        names.clone(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else if names.len() == 1 {
        format!("Clear option \"{column_name}\": \"{}\" values", names[0])
    } else {
        format!("Clear option \"{column_name}\" values")
    };
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn replace_option_values(
    app: AppHandle,
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let mutation = properties::prepare_replace_option_values(
        &space,
        &collection_path,
        column_name.clone(),
        old_option_name.clone(),
        new_option_name.clone(),
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Replace option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\"")
    };
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn update_system_field_label(
    app: AppHandle,
    space: String,
    collection_path: String,
    field: String,
    label: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let mutation = properties::prepare_update_system_field_label(
        &space,
        &collection_path,
        field.clone(),
        label,
    )?;
    let outcome = apply_collection_mutation(&app, &space, mutation).await?;
    let schema = outcome.value;
    let message = schema_commit_message(
        &schema,
        format!("Update system field \"{field}\""),
        "Update collection schema",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        outcome.changed_paths,
        message,
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub fn get_collection_schema(
    space: String,
    collection_path: String,
) -> Result<CollectionSchema, AppError> {
    properties::read::collection_schema(&space, &collection_path)
}
