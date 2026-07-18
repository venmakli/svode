//! Tauri adapters for tree UI state and document-link resolution.

use super::*;

#[tauri::command]
pub fn read_tree_order(space: String) -> Result<HashMap<String, Vec<String>>, AppError> {
    Ok(tree::read_order(Path::new(&space)))
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReorderEntriesCommandResult {
    pub parent_path: String,
    pub previous_order: Vec<String>,
    pub ordered_children: Vec<String>,
}

pub fn reorder_entries_shared(
    space: &str,
    parent_path: &str,
    ordered_children: Vec<String>,
) -> Result<ReorderEntriesCommandResult, AppError> {
    let parent_path = tree::normalize_tree_parent_path(Some(parent_path))?;
    let actual_children = tree::list_tree_children(space, Some(&parent_path))?;
    let previous_order = actual_children
        .iter()
        .map(|child| child.path.clone())
        .collect::<Vec<_>>();
    let expected = previous_order
        .iter()
        .collect::<std::collections::HashSet<_>>();
    let proposed = ordered_children
        .iter()
        .collect::<std::collections::HashSet<_>>();

    if proposed.len() != ordered_children.len() {
        return Err(AppError::General(
            "orderedChildren contains duplicate paths".to_string(),
        ));
    }
    if proposed != expected {
        return Err(AppError::General(
            "orderedChildren must contain each current direct child exactly once".to_string(),
        ));
    }

    let names = ordered_children
        .iter()
        .map(|path| {
            actual_children
                .iter()
                .find(|child| child.path == *path)
                .map(|child| child.name.clone())
                .ok_or_else(|| AppError::General(format!("unknown child path: {path}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut order = tree::read_order(Path::new(space));
    order.insert(parent_path.clone(), names);
    tree::write_order(Path::new(space), &order)?;

    Ok(ReorderEntriesCommandResult {
        parent_path: if parent_path == "." {
            String::new()
        } else {
            parent_path
        },
        previous_order,
        ordered_children,
    })
}

#[tauri::command]
pub fn save_tree_order(
    space: String,
    order: HashMap<String, Vec<String>>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    tree::write_order(Path::new(&space), &order)?;
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Reorder,
        vec![order_path(&space)],
    );
    Ok(())
}

#[tauri::command]
pub fn get_expanded_paths(space: String) -> Result<Vec<String>, AppError> {
    let local = config::read_local_config(Path::new(&space))?;
    Ok(local.expanded_paths)
}

#[tauri::command]
pub fn save_expanded_paths(space: String, paths: Vec<String>) -> Result<(), AppError> {
    let mut local = config::read_local_config(Path::new(&space))?;
    local.expanded_paths = paths;
    config::write_local_config(Path::new(&space), &local)
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
    Ok(crate::files::backlinks::make_relative_link_between(
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
