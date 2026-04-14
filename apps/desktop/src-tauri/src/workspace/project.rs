use std::path::Path;

use crate::error::AppError;
use crate::files::entry::slugify;

use super::config;
use super::registry;
use super::scaffold;
use super::types::{SpaceRef, WorkspaceConfig, WorkspaceInfo};

/// Where to register a newly created/opened workspace.
enum RegistrationTarget<'a> {
    /// Global registry (workspaces.json) — for root projects.
    Registry(&'a Path),
    /// Parent workspace config.json — for child spaces.
    ParentSpace(&'a Path, String),
}

/// Scaffold (if needed) + generate id + register.
///
/// Returns `(id, config)`. The caller is responsible for pre-checks
/// (path existence, slug collision, duplicate detection) before calling this.
fn create_and_register(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
    target: RegistrationTarget,
) -> Result<(String, WorkspaceConfig), AppError> {
    let cfg = match config::read_workspace_config(path) {
        Ok(cfg) => cfg,
        Err(_) => scaffold::scaffold_workspace(path, name, icon, description)?,
    };

    let id = ulid::Ulid::new().to_string().to_lowercase();

    match target {
        RegistrationTarget::Registry(config_dir) => {
            registry::add_workspace(config_dir, &id, &path.to_string_lossy())?;
        }
        RegistrationTarget::ParentSpace(parent_path, folder_name) => {
            let mut parent_config = config::read_workspace_config(parent_path)?;
            let spaces = parent_config.spaces.get_or_insert_with(Vec::new);
            spaces.push(SpaceRef {
                id: id.clone(),
                path: folder_name,
                repo: None,
            });
            config::write_workspace_config(parent_path, &parent_config)?;
        }
    }

    Ok((id, cfg))
}

/// Create a new root workspace: scaffold folder, register in workspaces.json.
pub fn create_workspace(
    config_dir: &Path,
    name: &str,
    icon: &str,
    description: &str,
    path: &Path,
) -> Result<(String, WorkspaceConfig), AppError> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    if !path.is_dir() {
        return Err(AppError::PathNotAccessible(
            path.to_string_lossy().to_string(),
        ));
    }

    create_and_register(path, name, icon, description, RegistrationTarget::Registry(config_dir))
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

    let fallback_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Workspace".to_string());

    create_and_register(path, &fallback_name, "", "", RegistrationTarget::Registry(config_dir))
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

/// Create a space inside a parent workspace folder.
pub fn create_space(
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

    let space_dir = parent_path.join(&folder_name);
    std::fs::create_dir_all(&space_dir)?;

    let (id, cfg) = create_and_register(
        &space_dir,
        name,
        icon,
        "",
        RegistrationTarget::ParentSpace(parent_path, folder_name),
    )?;

    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: space_dir.to_string_lossy().to_string(),
        has_spaces: false,
        last_opened: None,
    })
}

/// Register a freshly-cloned directory as a space.
///
/// Called by the clone flow after `git clone` completes. Reads or
/// scaffolds `.combai/config.json` inside the cloned folder, then adds a
/// `SpaceRef` entry to the parent's `spaces` list.
pub fn register_cloned_space(
    parent_path: &Path,
    folder_name: &str,
    fallback_name: &str,
    icon: &str,
) -> Result<WorkspaceInfo, AppError> {
    let space_dir = parent_path.join(folder_name);
    if !space_dir.is_dir() {
        return Err(AppError::PathNotAccessible(
            space_dir.to_string_lossy().to_string(),
        ));
    }

    // Check if already registered in parent
    let parent_config = config::read_workspace_config(parent_path)?;
    if let Some(spaces) = &parent_config.spaces {
        if let Some(existing) = spaces.iter().find(|s| s.path == folder_name) {
            let cfg = match config::read_workspace_config(&space_dir) {
                Ok(cfg) => cfg,
                Err(_) => scaffold::scaffold_workspace(&space_dir, fallback_name, icon, "")?,
            };
            return Ok(WorkspaceInfo {
                id: existing.id.clone(),
                name: cfg.name,
                icon: cfg.icon,
                description: cfg.description,
                path: space_dir.to_string_lossy().to_string(),
                has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
                last_opened: None,
            });
        }
    }

    let (id, cfg) = create_and_register(
        &space_dir,
        fallback_name,
        icon,
        "",
        RegistrationTarget::ParentSpace(parent_path, folder_name.to_string()),
    )?;

    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: space_dir.to_string_lossy().to_string(),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        last_opened: None,
    })
}

/// Delete a space: remove from parent config, optionally delete files.
pub fn delete_space(
    parent_path: &Path,
    space_id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    let mut parent_config = config::read_workspace_config(parent_path)?;

    if delete_files {
        if let Some(spaces) = &parent_config.spaces {
            if let Some(space_ref) = spaces.iter().find(|s| s.id == space_id) {
                let space_path = parent_path.join(&space_ref.path);
                if space_path.exists() && space_path.is_dir() {
                    std::fs::remove_dir_all(&space_path)?;
                }
            }
        }
    }

    if let Some(ref mut spaces) = parent_config.spaces {
        spaces.retain(|s| s.id != space_id);
    }
    config::write_workspace_config(parent_path, &parent_config)
}

/// List spaces of a workspace by reading its config and resolving paths.
pub fn list_spaces(parent_path: &Path) -> Result<Vec<WorkspaceInfo>, AppError> {
    let parent_config = config::read_workspace_config(parent_path)?;
    let mut result = Vec::new();

    if let Some(spaces) = &parent_config.spaces {
        for space_ref in spaces {
            let space_path = parent_path.join(&space_ref.path);
            let exists = space_path.exists();
            let space_config = if exists {
                config::read_workspace_config(&space_path).ok()
            } else {
                None
            };

            result.push(WorkspaceInfo {
                id: space_ref.id.clone(),
                name: space_config
                    .as_ref()
                    .map(|c| c.name.clone())
                    .unwrap_or_else(|| {
                        space_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    }),
                icon: space_config
                    .as_ref()
                    .map(|c| c.icon.clone())
                    .unwrap_or_default(),
                description: space_config
                    .as_ref()
                    .map(|c| c.description.clone())
                    .unwrap_or_default(),
                path: space_path.to_string_lossy().to_string(),
                has_spaces: space_config
                    .as_ref()
                    .and_then(|c| c.spaces.as_ref())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false),
                last_opened: None,
            });
        }
    }

    Ok(result)
}
