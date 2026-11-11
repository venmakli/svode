//! Tauri adapters for page reads, writes, and structural mutations.

use super::*;

#[tauri::command]
pub async fn list_content_tree(space: String) -> Result<Vec<TreeNode>, AppError> {
    off_main_thread(move || list_content_tree_logged(&space)).await?
}

fn list_content_tree_logged(space: &str) -> Result<Vec<TreeNode>, AppError> {
    let started = Instant::now();
    let space_name = path_name(space);
    let result = crate::space::content_tree::list_recursive(space);
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "list_content_tree",
            space = %space_name,
            node_count = count_tree_nodes(nodes),
            duration_ms,
            "list_content_tree completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "list_content_tree",
            space = %space_name,
            duration_ms,
            error_kind = error.kind(),
            "list_content_tree failed"
        ),
    }

    result
}

#[tauri::command]
pub async fn list_tree_children(
    space: String,
    parent_path: Option<String>,
) -> Result<Vec<tree::TreeChildNode>, tree::TreeLoadError> {
    off_main_thread(move || list_tree_children_logged(&space, parent_path.as_deref()))
        .await
        .map_err(|source| tree::TreeLoadError::Unavailable {
            message: source.to_string(),
            source,
        })?
}

fn list_tree_children_logged(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<tree::TreeChildNode>, tree::TreeLoadError> {
    let started = Instant::now();
    let space_name = path_name(space);
    let parent_scope = if parent_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .is_some()
    {
        "child"
    } else {
        "root"
    };
    let result = crate::space::content_tree::list_children_checked(space, parent_path);
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
pub fn get_scope_owner_facts(
    space: String,
    path: String,
) -> Result<svode_core::content_tree::owner::ScopeOwnerFacts, AppError> {
    Ok(svode_core::content_tree::owner::scope_owner_facts(
        Path::new(&space),
        &path,
    )?)
}

#[tauri::command]
pub async fn get_page_detail_state(
    space: String,
    path: String,
) -> Result<store::PageDetailState, AppError> {
    off_main_thread(move || Ok(store::page_detail_state(Path::new(&space), &path)?)).await?
}

#[tauri::command]
pub async fn create_page(
    app: AppHandle,
    space: String,
    parent_path: Option<String>,
    title: String,
    contextual_defaults: Option<indexmap::IndexMap<String, serde_json::Value>>,
    allocate_unique_title: Option<bool>,
    as_readme: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Page, AppError> {
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
    if engine::unique_id_schema_path_for_item(&space, &created.path)?.is_some() {
        let mut paths = engine::unique_id_mutation_paths_for_item(&space, &created.path)?;
        paths.push(order_path(&space));
        let message = if page_in_sensitive_collection(&space, &created.path) {
            "Create collection entry with unique_id".to_string()
        } else {
            format!("Create {} with unique_id", basename(&created.path))
        };
        maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    } else {
        schedule_created_page(&autocommit, project_path.as_deref(), &space, &created.path);
    }
    Ok(created)
}

/// Register a created page for its group of creation (Stage 11 1.G): the
/// page is the created object, the order file its tail.
pub(crate) fn schedule_created_page(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space: &str,
    path: &str,
) {
    maybe_autocommit_structural_paths(
        autocommit,
        project_path,
        space,
        StructuralChange::new(StructuralOp::Create(page_commit_name(space, path)))
            .creating(page_entity(space, path)),
        page_paths_with_order(space, [abs_page_path(space, path)]),
    );
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
) -> Result<Page, AppError> {
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

/// A page with the version of the bytes it was read from, the baseline
/// of the editor's next body write.
#[derive(Debug, Serialize)]
pub struct PageRead {
    #[serde(flatten)]
    page: Page,
    source_version: Option<String>,
}

impl From<Page> for PageRead {
    fn from(page: Page) -> Self {
        let source_version = page
            .source_version
            .as_ref()
            .map(|version| version.as_str().to_string());
        Self {
            page,
            source_version,
        }
    }
}

#[tauri::command]
pub async fn read_page(
    space: String,
    path: String,
    index_state: State<'_, IndexState>,
) -> Result<PageRead, AppError> {
    let mut page = store::read(&space, &path)?;
    apply_indexed_page_dates(&index_state, &space, &path, &mut page).await;
    Ok(page.into())
}

/// The schema of a Collection item with the other item that holds its
/// `unique_id` number.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSchemaRead {
    #[serde(flatten)]
    response: ItemSchemaResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    unique_id_duplicate: Option<UniqueIdDuplicate>,
}

#[tauri::command]
pub async fn get_page_schema(
    space: String,
    file_path: String,
    index_state: State<'_, IndexState>,
) -> Result<Option<PageSchemaRead>, AppError> {
    page_schema_read(&index_state, &space, &file_path).await
}

pub(super) async fn page_schema_read(
    index_state: &IndexState,
    space: &str,
    file_path: &str,
) -> Result<Option<PageSchemaRead>, AppError> {
    let Some(response) = engine::schema_response(space, file_path)? else {
        return Ok(None);
    };
    let unique_id_duplicate = indexed_unique_id_duplicate(index_state, space, file_path).await;
    Ok(Some(PageSchemaRead {
        response,
        unique_id_duplicate,
    }))
}

#[tauri::command]
pub async fn update_page_field(
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
) -> Result<Page, AppError> {
    let fields = std::collections::BTreeMap::from([(field, value)]);
    let authorization_space = space.clone();
    // A title change may rename the Page file.
    let _changing = crate::navigation::path_change(&space);
    let outcome = crate::page::update_fields(
        PageFieldUpdate {
            space: &space,
            path: &file_path,
            project: project_path.as_deref().filter(|path| !path.is_empty()),
            values: &fields,
            intent: ItemFieldBatchIntent::Literal,
        },
        &index_state,
        &index_updates,
        &nonces,
        Some(&autocommit),
        |paths| require_planned_mutation_paths(&app, &authorization_space, paths),
    )
    .await?;
    // An editor edit during an agent turn keeps its own group (1.E).
    svode_core::git::versions::turns::editor_wrote(&outcome.changed_paths);
    if outcome.page.path != file_path {
        crate::navigation::artifact_moved(&app, &space, &file_path, &outcome.page.path);
    }
    Ok(outcome.page)
}

#[tauri::command]
pub async fn write_page_body(
    app: AppHandle,
    space: String,
    path: String,
    content: String,
    project_path: Option<String>,
    source_version: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
) -> Result<WriteResult, AppError> {
    write_page_body_shared(
        WritePageAuthorization::App(&app),
        space,
        path,
        content,
        project_path,
        source_version,
        &index_state,
        &index_updates,
        &nonces,
    )
    .await
}

#[derive(Clone, Copy)]
pub(super) enum WritePageAuthorization<'a> {
    App(&'a AppHandle),
    #[cfg(test)]
    Preauthorized,
}

/// Writes the body of a Page. The title, metadata and filename are not part
/// of a body write; they change through the Page field update.
pub(super) async fn write_page_body_shared(
    authorization: WritePageAuthorization<'_>,
    space: String,
    path: String,
    content: String,
    project_path: Option<String>,
    source_version: Option<String>,
    index_state: &IndexState,
    index_updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
) -> Result<WriteResult, AppError> {
    let source_version = source_version.map(svode_core::page::SourceVersion::from_token);
    let request = svode_core::page::write::PageWrite {
        space: &space,
        path: &path,
        content: &content,
        title: None,
        icon: None,
        extra: None,
        metadata: None,
        field_batch: None,
        skip_rename: true,
        project: project_path.as_deref().filter(|path| !path.is_empty()),
        source_version: source_version.as_ref(),
    };
    let authorization_space = &space;
    crate::page::write(
        request,
        index_state,
        index_updates,
        nonces,
        |paths| async move {
            match authorization {
                WritePageAuthorization::App(app) => {
                    require_planned_mutation_paths(app, authorization_space, paths).await
                }
                #[cfg(test)]
                WritePageAuthorization::Preauthorized => {
                    let mut paths = paths;
                    paths.push(PathBuf::from(authorization_space));
                    Ok(paths)
                }
            }
        },
    )
    .await
    .map(|outcome| {
        // An editor edit during an agent turn keeps its own group (1.E).
        svode_core::git::versions::turns::editor_wrote(&outcome.changed_paths);
        outcome.result
    })
}

#[tauri::command]
pub async fn delete_content(
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
    crate::navigation::artifact_removed(&app, &space);
    Ok(())
}

#[tauri::command]
pub async fn rename_content(
    app: AppHandle,
    space: String,
    from: String,
    to: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    let authorized_paths = require_page_rename_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &from,
        &to,
    )
    .await?;
    let _changing = crate::navigation::path_change(&space);
    let modified = scope_authorized_mutation_paths(authorized_paths, async {
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
    .await?;
    crate::navigation::artifact_moved(&app, &space, &from, &to);
    Ok(modified)
}

#[tauri::command]
pub async fn move_content(
    app: AppHandle,
    space: String,
    from: String,
    to_parent: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<MoveContentCommandResult, AppError> {
    let authorized_paths = require_page_move_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &from,
        &to_parent,
    )
    .await?;
    let _changing = crate::navigation::path_change(&space);
    let moved = scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::move_page(
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
    .await?;
    crate::navigation::artifact_moved(&app, &space, &from, &moved.new_path);
    // The parents the move converted follow like a conversion of their own.
    for converted in &moved.converted_parents {
        crate::navigation::artifact_moved(&app, &space, &converted.old_path, &converted.new_path);
    }
    Ok(moved)
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
        validate_project_links(&index_state, Path::new(proj), Path::new(&space), &path).await
    } else {
        Ok(svode_core::index::backlinks::validate_links(
            Path::new(&space),
            &path,
        )?)
    }
}

/// Validate the links of one Page against the whole Project, so links into
/// other Spaces resolve.
pub(super) async fn validate_project_links(
    index_state: &IndexState,
    project: &Path,
    space: &Path,
    path: &str,
) -> Result<Vec<LinkValidation>, AppError> {
    let source_space_id = index_state.core.space_id_for_dir(space).await;
    let abs = space.join(path);
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
            .resolve_doc_link_path(project, source_space_id.as_deref(), path, &url)
            .await?;
        out.push(LinkValidation {
            url,
            exists: resolved.exists,
        });
    }
    Ok(out)
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
