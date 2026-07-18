//! Tauri adapters for collection templates, views, queries, relations, and actors.

use super::*;

#[tauri::command]
pub fn list_templates(
    space: String,
    collection_path: String,
) -> Result<Vec<TemplateInfo>, AppError> {
    templates::list(&space, &collection_path)
}

#[tauri::command]
pub async fn create_template(
    space: String,
    collection_path: String,
    title: String,
    kind: TemplateKind,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let path = templates::create(&space, &collection_path, &title, kind)?;
    let root = root_path_for_head(&path);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::CreateTemplate(template_name_for_commit(&space, &collection_path, title)),
        vec![abs_entry_path(&space, root)],
    );
    Ok(path)
}

#[tauri::command]
pub async fn delete_template(
    space: String,
    collection_path: String,
    template_slug: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let deleted = templates::delete(&space, &collection_path, &template_slug)?;
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::DeleteTemplate(template_name_for_commit(
            &space,
            &collection_path,
            deleted.title,
        )),
        vec![abs_entry_path(&space, &deleted.root_path)],
    );
    Ok(())
}

#[tauri::command]
pub async fn duplicate_template(
    space: String,
    collection_path: String,
    template_slug: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let duplicated = templates::duplicate(&space, &collection_path, &template_slug)?;
    let root = root_path_for_head(&duplicated.head_path);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::DuplicateTemplate {
            old: template_name_for_commit(&space, &collection_path, duplicated.old_title),
            new: template_name_for_commit(&space, &collection_path, duplicated.new_title),
        },
        vec![abs_entry_path(&space, root)],
    );
    Ok(duplicated.head_path)
}

#[tauri::command]
pub async fn instantiate_template(
    space: String,
    collection_path: String,
    template_slug: String,
    parent_dir: String,
    initial_title: Option<String>,
    force_folder: bool,
    contextual_defaults: Option<HashMap<String, serde_json::Value>>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let contextual_defaults = contextual_defaults
        .map(|defaults| {
            defaults
                .into_iter()
                .map(|(field, value)| Ok((field, json_to_yaml_value(value)?)))
                .collect::<Result<HashMap<_, _>, AppError>>()
        })
        .transpose()?;
    let instantiated = templates::instantiate(
        &space,
        &collection_path,
        &template_slug,
        &parent_dir,
        initial_title,
        force_folder,
        contextual_defaults,
    )?;
    let root = root_path_for_head(&instantiated.entry.path);
    update_index_tree_or_reindex(
        &index_state,
        project_path.as_deref(),
        &space,
        root,
        "instantiate_template",
    )
    .await;
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::InstantiateTemplate {
            title: template_name_for_commit(&space, &collection_path, instantiated.template_title),
            parent: if collection_has_sensitive_columns(&space, &collection_path) {
                "collection".to_string()
            } else {
                parent_dir
            },
        },
        entry_paths_with_order(&space, [abs_entry_path(&space, root)]),
    );
    Ok(instantiated.entry)
}

#[tauri::command]
pub async fn set_default_template(
    space: String,
    collection_path: String,
    template_slug: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    if let Some(template_slug) = template_slug.as_deref() {
        templates::ensure_template_exists(&space, &collection_path, template_slug)?;
    }
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema =
        properties::set_default_template(&space, &collection_path, template_slug.as_deref())?;
    let message = schema_commit_message(
        &schema,
        "Update collection templates",
        "Update collection templates",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn reorder_templates(
    space: String,
    collection_path: String,
    new_order: Vec<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    templates::validate_template_order(&space, &collection_path, &new_order)?;
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::reorder_templates(&space, &collection_path, new_order)?;
    let message = schema_commit_message(
        &schema,
        "Update collection templates",
        "Update collection templates",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn add_view(
    space: String,
    collection_path: String,
    view: View,
    position: Option<usize>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let default_message = format!("Add view \"{}\"", view.name());
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_view(&space, &collection_path, view, position)?;
    let message = schema_commit_message(&schema, default_message, "Update collection view");
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_view(
    space: String,
    collection_path: String,
    old_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::rename_view(&space, &collection_path, &old_name, &new_name)?;
    let message = schema_commit_message(
        &schema,
        format!("Rename view \"{old_name}\" \u{2192} \"{new_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_view(
    space: String,
    collection_path: String,
    view_name: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let patch = json_to_yaml_value(patch)?;
    let schema = properties::update_view(&space, &collection_path, &view_name, patch)?;
    let message = schema_commit_message(
        &schema,
        format!("Update view \"{view_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_view(
    space: String,
    collection_path: String,
    view_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::delete_view(&space, &collection_path, &view_name)?;
    let message = schema_commit_message(
        &schema,
        format!("Delete view \"{view_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn duplicate_view(
    space: String,
    collection_path: String,
    view_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::duplicate_view(&space, &collection_path, &view_name, &new_name)?;
    let message = schema_commit_message(
        &schema,
        format!("Duplicate view \"{view_name}\" \u{2192} \"{new_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn reorder_views(
    space: String,
    collection_path: String,
    new_order: Vec<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::reorder_views(&space, &collection_path, new_order)?;
    let message = schema_commit_message(&schema, "Reorder views", "Update collection view");
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn list_entries_for_view(
    space: String,
    collection_path: String,
    view_name: String,
    include_nested: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    git_state: State<'_, GitState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    let git_cli = git_state.cli.clone();
    properties::list_entries_for_view(
        &pool,
        git_cli.as_ref(),
        &space,
        &collection_path,
        &view_name,
        include_nested,
    )
    .await
}

#[tauri::command]
pub async fn query_entries(
    space: String,
    collection_path: String,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    include_nested: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    git_state: State<'_, GitState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    let git_cli = git_state.cli.clone();
    properties::query_entries(
        &pool,
        git_cli.as_ref(),
        &space,
        &collection_path,
        filters,
        sort,
        include_nested,
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn resolve_relation(
    space: String,
    relation: String,
    value: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Option<ResolvedRelation>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::resolve_relation(&pool, &relation, &value).await
}

#[tauri::command]
pub async fn resolve_relations_batch(
    space: String,
    relation: String,
    values: Vec<String>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Option<ResolvedRelation>>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::resolve_relations_batch(&pool, &relation, &values).await
}

#[tauri::command]
pub fn query_relation_backlinks(
    space: String,
    target_path: String,
    source_collection_path: Option<String>,
    source_column: Option<String>,
) -> Result<Vec<RelationBacklink>, AppError> {
    properties::query_relation_backlinks(
        &space,
        &target_path,
        source_collection_path.as_deref(),
        source_column.as_deref(),
    )
}

#[tauri::command]
pub fn diagnose_two_way_relation(
    space: String,
    collection_path: String,
    column: String,
    project_path: Option<String>,
) -> Result<RelationTwoWayDiagnostics, AppError> {
    properties::diagnose_two_way_relation_with_project(
        &space,
        &collection_path,
        &column,
        project_path.as_deref(),
    )
}

#[tauri::command]
pub async fn repair_two_way_relation(
    app: AppHandle,
    space: String,
    collection_path: String,
    column: String,
    strategy: String,
    reverse_column: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::relation_repair_mutation_paths_with_project(
        &space,
        &collection_path,
        &column,
        project_path.as_deref(),
    )?;
    let snapshot = snapshot_paths(&paths)?;
    properties::repair_two_way_relation_with_project(
        &space,
        &collection_path,
        &column,
        &strategy,
        reverse_column.as_deref(),
        project_path.as_deref(),
    )?;
    let paths = changed_paths(snapshot)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Repair two-way relation \"{column}\"")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    let reindex_space = space.clone();
    tauri::async_runtime::spawn(async move {
        let index_state = app.state::<IndexState>();
        tracing::info!(
            "repair_two_way_relation: scheduling background full space reindex after relation repair"
        );
        reindex_space_dir(&index_state, &reindex_space).await;
    });
    Ok(())
}

#[tauri::command]
pub fn list_collections(space: String) -> Result<Vec<CollectionInfo>, AppError> {
    properties::list_collections(&space)
}

#[tauri::command]
pub async fn list_actors(
    space_path: String,
    all_time: Option<bool>,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, properties::ActorCatalogState>,
) -> Result<Vec<ActorCandidate>, AppError> {
    let cli = require_cli(&git_state)?;
    properties::list_actors(
        &actor_catalog,
        &cli,
        Path::new(&space_path),
        all_time.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn refresh_actors(
    space_path: String,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, properties::ActorCatalogState>,
) -> Result<Vec<ActorCandidate>, AppError> {
    let cli = require_cli(&git_state)?;
    properties::refresh_actors(&actor_catalog, &cli, Path::new(&space_path), false).await
}
