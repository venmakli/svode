//! Tauri adapters for entry reads, writes, and structural mutations.

use super::*;

#[tauri::command]
pub fn list_entries(space: String) -> Result<Vec<TreeNode>, AppError> {
    let started = Instant::now();
    let space_name = path_name(&space);
    let result = crate::space::content_tree::list_recursive(&space);
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "list_entries",
            space = %space_name,
            node_count = count_tree_nodes(nodes),
            duration_ms,
            "list_entries completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "list_entries",
            space = %space_name,
            duration_ms,
            error_kind = error.kind(),
            "list_entries failed"
        ),
    }

    result
}

#[tauri::command]
pub fn list_tree_children(
    space: String,
    parent_path: Option<String>,
) -> Result<Vec<tree::TreeChildNode>, tree::TreeLoadError> {
    let started = Instant::now();
    let space_name = path_name(&space);
    let parent_scope = if parent_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .is_some()
    {
        "child"
    } else {
        "root"
    };
    let result = crate::space::content_tree::list_children_checked(&space, parent_path.as_deref());
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "list_tree_children",
            space = %space_name,
            parent_scope,
            node_count = nodes.len(),
            duration_ms,
            "list_tree_children completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "list_tree_children",
            space = %space_name,
            parent_scope,
            duration_ms,
            error = ?error,
            "list_tree_children failed"
        ),
    }

    result
}

#[tauri::command]
pub fn get_entry_detail_state(
    space: String,
    path: String,
) -> Result<entry::EntryDetailState, AppError> {
    Ok(entry::entry_detail_state(Path::new(&space), &path)?)
}

#[tauri::command]
pub async fn create_entry(
    app: AppHandle,
    space: String,
    parent_path: Option<String>,
    title: String,
    contextual_defaults: Option<HashMap<String, serde_json::Value>>,
    allocate_unique_title: Option<bool>,
    as_readme: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    require_repository_mutation(&app, Path::new(&space)).await?;
    let created = crate::page::create(
        svode_core::page::create::PageCreate {
            space: space.clone(),
            parent_path,
            title,
            body: None,
            icon: None,
            description: None,
            cover: None,
            properties: contextual_defaults,
            contextual_defaults: true,
            allocate_unique_title: allocate_unique_title.unwrap_or(false),
            as_readme: as_readme.unwrap_or(false),
            project: project_path.clone(),
            publish_projection: true,
        },
        &index_state,
        &index_updates,
        |paths| require_planned_mutation_paths(&app, &space, paths),
    )
    .await?
    .page;
    if engine::unique_id_schema_path_for_entry(&space, &created.path)?.is_some() {
        let mut paths = engine::unique_id_mutation_paths_for_entry(&space, &created.path)?;
        paths.push(order_path(&space));
        let message = if entry_in_sensitive_collection(&space, &created.path) {
            "Create collection entry with unique_id".to_string()
        } else {
            format!("Create {} with unique_id", basename(&created.path))
        };
        maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    } else {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Create(entry_commit_name(&space, &created.path)),
            entry_paths_with_order(&space, [abs_entry_path(&space, &created.path)]),
        );
    }
    Ok(created)
}

#[tauri::command]
pub async fn create_collection(
    app: AppHandle,
    space: String,
    parent_path: Option<String>,
    title: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let authorization_space = space.clone();
    let outcome = crate::structure::create_collection(
        crate::structure::CollectionCreate {
            space,
            parent_path,
            title,
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: engine::default_collection_schema(),
            allocate_unique_title: true,
            project: project_path,
        },
        &index_state,
        &index_updates,
        Some(&autocommit),
        |paths| require_planned_mutation_paths(&app, &authorization_space, paths),
    )
    .await?;
    Ok(outcome.collection)
}

#[tauri::command]
pub async fn create_folder(
    app: AppHandle,
    space: String,
    parent_path: Option<String>,
    name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    require_repository_mutation(&app, Path::new(&space)).await?;
    crate::structure::create_folder(
        &space,
        parent_path.as_deref(),
        &name,
        project_path.as_deref(),
        Some(&autocommit),
    )
}

#[tauri::command]
pub async fn read_entry(
    space: String,
    path: String,
    index_state: State<'_, IndexState>,
) -> Result<Entry, AppError> {
    let mut entry = entry::read(&space, &path)?;
    apply_indexed_entry_dates(&index_state, &space, &path, &mut entry).await;
    Ok(entry)
}

#[tauri::command]
pub fn get_entry_schema(
    space: String,
    file_path: String,
) -> Result<Option<EntrySchemaResponse>, AppError> {
    Ok(engine::schema_response(&space, &file_path)?)
}

#[tauri::command]
pub async fn update_entry_field(
    app: AppHandle,
    space: String,
    file_path: String,
    field: String,
    value: serde_json::Value,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let fields = std::collections::BTreeMap::from([(field, value)]);
    let authorization_space = space.clone();
    let outcome = crate::page::update_fields(
        PageFieldUpdate {
            space: &space,
            path: &file_path,
            project: project_path.as_deref().filter(|path| !path.is_empty()),
            values: &fields,
            intent: EntryFieldBatchIntent::Literal,
        },
        &index_state,
        &index_updates,
        &nonces,
        Some(&autocommit),
        |paths| require_planned_mutation_paths(&app, &authorization_space, paths),
    )
    .await?;
    Ok(outcome.page)
}

#[tauri::command]
pub async fn write_entry(
    app: AppHandle,
    space: String,
    path: String,
    content: String,
    title: Option<String>,
    icon: Option<String>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    existing_id: Option<String>,
    skip_rename: Option<bool>,
    project_path: Option<String>,
    source_version: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<WriteResult, AppError> {
    if skip_rename != Some(true)
        && let Some(project) = project_path.as_deref().filter(|path| !path.is_empty())
    {
        let cli = crate::git::require_cli(&app.state::<crate::git::GitState>())?;
        if svode_core::git::ops::detect_space_git_type(&cli, Path::new(project), Path::new(&space))
            .await?
            == crate::space::types::SpaceGitType::Submodule
        {
            require_repository_mutation(&app, Path::new(project)).await?;
        }
    }
    write_entry_shared(
        WriteEntryAuthorization::App(&app),
        space,
        path,
        content,
        title,
        icon,
        extra,
        existing_id,
        skip_rename,
        project_path,
        source_version,
        &index_state,
        &index_updates,
        &nonces,
        Some(&autocommit),
    )
    .await
}

pub(super) enum WriteEntryAuthorization<'a> {
    App(&'a AppHandle),
    #[cfg(test)]
    Preauthorized,
}

#[cfg(test)]
pub(super) async fn update_entry_title_shared(
    authorization: WriteEntryAuthorization<'_>,
    space: String,
    file_path: String,
    title: String,
    project_path: Option<String>,
    index_state: &IndexState,
    index_updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let current = entry::read(&space, &file_path)?;
    if current.meta.title == title
        && entry::planned_write_rename(&space, &file_path, Some(&title), false)?.is_none()
    {
        return Ok(current);
    }
    let result = write_entry_shared(
        authorization,
        space.clone(),
        file_path.clone(),
        current.body,
        Some(title),
        None,
        None,
        None,
        Some(false),
        project_path,
        None,
        index_state,
        index_updates,
        nonces,
        autocommit,
    )
    .await?;
    let current_path = result.new_path.as_deref().unwrap_or(&file_path);
    let mut updated = entry::read(&space, current_path)?;
    updated.warnings = result.warnings;
    Ok(updated)
}

pub(super) async fn write_entry_shared(
    authorization: WriteEntryAuthorization<'_>,
    space: String,
    path: String,
    content: String,
    title: Option<String>,
    icon: Option<String>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    existing_id: Option<String>,
    skip_rename: Option<bool>,
    project_path: Option<String>,
    source_version: Option<String>,
    index_state: &IndexState,
    index_updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
    autocommit: Option<&AutocommitService>,
) -> Result<WriteResult, AppError> {
    let source_version = source_version.map(svode_core::page::SourceVersion::from_token);
    let request = svode_core::page::write::PageWrite {
        space: &space,
        path: &path,
        content: &content,
        title: title.as_deref(),
        icon: icon.as_deref(),
        extra,
        metadata: None,
        field_batch: None,
        skip_rename: skip_rename.unwrap_or(false),
        project: project_path.as_deref().filter(|path| !path.is_empty()),
        source_version: source_version.as_ref(),
    };
    let _ = existing_id;
    let authorization_space = &space;
    crate::page::write(
        request,
        index_state,
        index_updates,
        nonces,
        autocommit,
        |paths| async move {
            match authorization {
                WriteEntryAuthorization::App(app) => {
                    require_planned_mutation_paths(app, authorization_space, paths).await
                }
                #[cfg(test)]
                WriteEntryAuthorization::Preauthorized => {
                    let mut paths = paths;
                    paths.push(PathBuf::from(authorization_space));
                    Ok(paths)
                }
            }
        },
    )
    .await
    .map(|outcome| outcome.result)
}

#[tauri::command]
pub async fn delete_entry(
    app: AppHandle,
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let authorized_paths =
        crate::structure::delete_mutation_paths(&space, project_path.as_deref(), &path)?;
    require_repository_mutation_paths(&app, authorized_paths.clone()).await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::delete(
            &space,
            &path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    app: AppHandle,
    space: String,
    from: String,
    to: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    let authorized_paths = require_entry_move_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &from,
        &to,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::rename(
            &space,
            &from,
            &to,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn move_entry(
    app: AppHandle,
    space: String,
    from: String,
    to_parent: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let file_name = Path::new(&from)
        .file_name()
        .ok_or_else(|| AppError::General("invalid source path".to_string()))?
        .to_string_lossy();
    let to = if to_parent.is_empty() {
        file_name.to_string()
    } else {
        format!("{to_parent}/{file_name}")
    };
    let authorized_paths = require_entry_move_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &from,
        &to,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::move_entry(
            &space,
            &from,
            &to_parent,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn get_backlinks(
    space: String,
    target_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    let backlink_index = index_state
        .core
        .backlinks_for_space_dir(Path::new(&space))
        .await;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        index_state
            .ensure_project_backlinks_built(Path::new(proj))
            .await?;
    } else if !backlink_index.is_built() {
        backlink_index.build(Path::new(&space))?;
    }
    Ok(backlink_index.get_backlinks(&target_path))
}

#[tauri::command]
pub async fn rebuild_backlinks(
    space: String,
    index_state: State<'_, IndexState>,
) -> Result<(), AppError> {
    let backlink_index = index_state
        .core
        .backlinks_for_space_dir(Path::new(&space))
        .await;
    Ok(backlink_index.build(Path::new(&space))?)
}

#[tauri::command]
pub async fn validate_links(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<LinkValidation>, AppError> {
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let source_space_id = index_state.core.space_id_for_dir(Path::new(&space)).await;
        let abs = Path::new(&space).join(&path);
        if !abs.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(abs)?;
        let links = svode_core::index::backlinks::parse_markdown_links(&content);
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (url, _) in links {
            if !seen.insert(url.clone()) {
                continue;
            }
            let resolved = index_state
                .resolve_doc_link(Path::new(proj), source_space_id.as_deref(), &path, &url)
                .await?;
            out.push(LinkValidation {
                url,
                exists: resolved.exists,
            });
        }
        Ok(out)
    } else {
        Ok(svode_core::index::backlinks::validate_links(
            Path::new(&space),
            &path,
        )?)
    }
}

#[tauri::command]
pub fn watch_space(
    space: String,
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
    watcher.watch(space, app)
}

#[tauri::command]
pub fn unwatch_space(space: String, watcher: State<'_, FileWatcher>) -> Result<(), AppError> {
    watcher.unwatch(&space)
}
