use std::path::Path;

use crate::error::AppError;
use crate::files::entry::slugify;

use super::config;
use super::registry;
use super::scaffold;
use super::types::{ChildRef, WorkspaceConfig, WorkspaceInfo};

/// Create a new root workspace: scaffold folder, register in workspaces.json.
pub fn create_workspace(
    config_dir: &Path,
    name: &str,
    icon: &str,
    description: &str,
    path: &Path,
) -> Result<(String, WorkspaceConfig), AppError> {
    // Ensure path exists
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    if !path.is_dir() {
        return Err(AppError::PathNotAccessible(
            path.to_string_lossy().to_string(),
        ));
    }

    let ws_config = scaffold::scaffold_workspace(path, name, icon, description)?;

    let id = ulid::Ulid::new().to_string().to_lowercase();
    registry::add_workspace(config_dir, &id, &path.to_string_lossy())?;

    Ok((id, ws_config))
}

/// Register an existing folder as a root workspace (open folder).
pub fn open_workspace_folder(
    config_dir: &Path,
    path: &Path,
) -> Result<(String, WorkspaceConfig), AppError> {
    if !path.exists() || !path.is_dir() {
        return Err(AppError::PathNotAccessible(
            path.to_string_lossy().to_string(),
        ));
    }

    // Check if already registered
    let reg = registry::read_registry(config_dir)?;
    let path_str = path.to_string_lossy().to_string();
    if let Some(existing) = reg.workspaces.iter().find(|w| w.path == path_str) {
        let cfg = config::read_workspace_config(path)?;
        return Ok((existing.id.clone(), cfg));
    }

    // Read existing config or scaffold
    let cfg = match config::read_workspace_config(path) {
        Ok(cfg) => cfg,
        Err(_) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Workspace".to_string());
            scaffold::scaffold_workspace(path, &name, "", "")?
        }
    };

    let id = ulid::Ulid::new().to_string().to_lowercase();
    registry::add_workspace(config_dir, &id, &path_str)?;

    Ok((id, cfg))
}

/// Delete a root workspace: remove from registry, optionally delete files.
pub fn delete_workspace(
    config_dir: &Path,
    id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    if delete_files {
        if let Some(ws_ref) = registry::find_workspace(config_dir, id)? {
            let path = Path::new(&ws_ref.path);
            if path.exists() {
                std::fs::remove_dir_all(path)?;
            }
        }
    }
    registry::remove_workspace(config_dir, id)
}

/// Create a child workspace inside a parent workspace folder.
pub fn create_child(
    parent_path: &Path,
    name: &str,
    icon: &str,
) -> Result<WorkspaceInfo, AppError> {
    let slug = slugify(name);

    // Handle collision: try slug, slug-1, slug-2, etc.
    let mut folder_name = slug.clone();
    let mut counter = 1u32;
    while parent_path.join(&folder_name).exists() {
        folder_name = format!("{}-{}", slug, counter);
        counter += 1;
    }

    let child_dir = parent_path.join(&folder_name);
    std::fs::create_dir_all(&child_dir)?;

    let ws_config = scaffold::scaffold_workspace(&child_dir, name, icon, "")?;

    let child_id = ulid::Ulid::new().to_string().to_lowercase();
    let child_ref = ChildRef {
        id: child_id.clone(),
        path: folder_name,
        repo: None,
    };

    // Add to parent config
    let mut parent_config = config::read_workspace_config(parent_path)?;
    let children = parent_config.children.get_or_insert_with(Vec::new);
    children.push(child_ref.clone());
    config::write_workspace_config(parent_path, &parent_config)?;

    Ok(WorkspaceInfo {
        id: child_id,
        name: ws_config.name,
        icon: ws_config.icon,
        description: ws_config.description,
        path: child_dir.to_string_lossy().to_string(),
        has_children: false,
        last_opened: None,
    })
}

/// Delete a child workspace: remove from parent config, optionally delete files.
pub fn delete_child(
    parent_path: &Path,
    child_id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    let mut parent_config = config::read_workspace_config(parent_path)?;

    if delete_files {
        if let Some(children) = &parent_config.children {
            if let Some(child_ref) = children.iter().find(|c| c.id == child_id) {
                let child_path = parent_path.join(&child_ref.path);
                if child_path.exists() && child_path.is_dir() {
                    std::fs::remove_dir_all(&child_path)?;
                }
            }
        }
    }

    if let Some(ref mut children) = parent_config.children {
        children.retain(|c| c.id != child_id);
    }
    config::write_workspace_config(parent_path, &parent_config)
}

/// List children of a workspace by reading its config and resolving paths.
pub fn list_children(parent_path: &Path) -> Result<Vec<WorkspaceInfo>, AppError> {
    let parent_config = config::read_workspace_config(parent_path)?;
    let mut result = Vec::new();

    if let Some(children) = &parent_config.children {
        for child_ref in children {
            let child_path = parent_path.join(&child_ref.path);
            let exists = child_path.exists();
            let child_config = if exists {
                config::read_workspace_config(&child_path).ok()
            } else {
                None
            };

            result.push(WorkspaceInfo {
                id: child_ref.id.clone(),
                name: child_config
                    .as_ref()
                    .map(|c| c.name.clone())
                    .unwrap_or_else(|| {
                        child_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    }),
                icon: child_config
                    .as_ref()
                    .map(|c| c.icon.clone())
                    .unwrap_or_default(),
                description: child_config
                    .as_ref()
                    .map(|c| c.description.clone())
                    .unwrap_or_default(),
                path: child_path.to_string_lossy().to_string(),
                has_children: child_config
                    .as_ref()
                    .and_then(|c| c.children.as_ref())
                    .map(|ch| !ch.is_empty())
                    .unwrap_or(false),
                last_opened: None,
            });
        }
    }

    Ok(result)
}
