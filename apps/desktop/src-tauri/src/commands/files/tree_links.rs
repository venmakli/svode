//! Tauri adapters for tree UI state and document-link resolution.

use super::*;

#[tauri::command]
pub fn read_tree_order(space: String) -> Result<HashMap<String, Vec<String>>, AppError> {
    Ok(crate::space::content_tree::read_order(Path::new(&space)))
}

#[tauri::command]
pub async fn save_tree_order(
    app: AppHandle,
    space: String,
    order: HashMap<String, Vec<String>>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    require_repository_mutation(&app, Path::new(&space)).await?;
    let changed = crate::space::content_tree::replace_order(Path::new(&space), order)?;
    if changed {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Reorder,
            vec![order_path(&space)],
        );
    }
    Ok(())
}

#[tauri::command]
pub fn get_expanded_paths(space: String) -> Result<Vec<String>, AppError> {
    let local = config::read_local_config(Path::new(&space))?;
    Ok(local.expanded_paths)
}

#[tauri::command]
pub fn save_expanded_paths(space: String, paths: Vec<String>) -> Result<(), AppError> {
    config::mutate_local_config(Path::new(&space), |local| {
        local.expanded_paths = paths;
        Ok(())
    })
}

#[tauri::command]
pub async fn resolve_doc_link(
    project_path: String,
    source_space_id: Option<String>,
    source_path: String,
    url: String,
    index_state: State<'_, IndexState>,
) -> Result<ResolvedDocLink, AppError> {
    index_state
        .resolve_doc_link(
            Path::new(&project_path),
            source_space_id.as_deref(),
            &source_path,
            &url,
        )
        .await
}

#[tauri::command]
pub fn make_relative_link(
    source_doc_path: String,
    target_doc_path: String,
) -> Result<String, AppError> {
    Ok(svode_core::index::backlinks::make_relative_link_between(
        Path::new(&source_doc_path),
        Path::new(&target_doc_path),
    ))
}

#[tauri::command]
pub async fn suggest_link_fix(
    project_path: String,
    target_space_id: Option<String>,
    broken_path: String,
    index_state: State<'_, IndexState>,
    git_state: State<'_, GitState>,
) -> Result<Vec<LinkFixSuggestion>, AppError> {
    let project = Path::new(&project_path);
    let target_dir = index_state
        .space_path_of(project, target_space_id.as_deref())
        .await?;
    let broken_path = normalize_repo_relative(&broken_path, RootMode::Reject)?;

    let cli = require_cli(&git_state).ok();
    link_fix::suggestions(cli.as_ref(), &target_dir, &broken_path).await
}
