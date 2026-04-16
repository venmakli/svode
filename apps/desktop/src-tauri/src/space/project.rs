use std::path::Path;

use crate::error::AppError;

use super::config;
use super::registry;
use super::scaffold;
use super::types::{SpaceConfig, SpaceInfo, SpaceRef, SpaceStatus};

/// Where to register a newly created/opened space.
enum RegistrationTarget<'a> {
    /// Global registry (spaces.json) — for root projects.
    Registry(&'a Path),
    /// Parent space config.json — for child spaces.
    /// (parent_path, folder_name, repo_url)
    ParentSpace(&'a Path, String, Option<String>),
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
) -> Result<(String, SpaceConfig), AppError> {
    let cfg = match config::read_space_config(path) {
        Ok(cfg) => cfg,
        Err(_) => scaffold::scaffold_space(path, name, icon, description)?,
    };

    let id = ulid::Ulid::new().to_string().to_lowercase();

    match target {
        RegistrationTarget::Registry(config_dir) => {
            registry::add_space(config_dir, &id, &path.to_string_lossy())?;
        }
        RegistrationTarget::ParentSpace(parent_path, folder_name, repo) => {
            let mut parent_config = config::read_space_config(parent_path)?;
            let spaces = parent_config.spaces.get_or_insert_with(Vec::new);
            spaces.push(SpaceRef {
                id: id.clone(),
                path: folder_name,
                repo,
            });
            config::write_space_config(parent_path, &parent_config)?;
        }
    }

    Ok((id, cfg))
}

/// Create a new root project: scaffold folder, register in spaces.json.
pub fn create_project(
    config_dir: &Path,
    name: &str,
    icon: &str,
    description: &str,
    path: &Path,
) -> Result<(String, SpaceConfig), AppError> {
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

/// Register an existing folder as a root project (open folder).
pub fn open_project_folder(
    config_dir: &Path,
    path: &Path,
) -> Result<(String, SpaceConfig), AppError> {
    if !path.exists() || !path.is_dir() {
        return Err(AppError::PathNotAccessible(
            path.to_string_lossy().to_string(),
        ));
    }

    // Check if already registered
    let reg = registry::read_registry(config_dir)?;
    let path_str = path.to_string_lossy().to_string();
    if let Some(existing) = reg.spaces.iter().find(|w| w.path == path_str) {
        let cfg = config::read_space_config(path)?;
        return Ok((existing.id.clone(), cfg));
    }

    let fallback_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string());

    create_and_register(path, &fallback_name, "", "", RegistrationTarget::Registry(config_dir))
}

/// Delete a root project: remove from registry, optionally delete files.
pub fn delete_project(
    config_dir: &Path,
    id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    if delete_files {
        if let Some(sp_ref) = registry::find_space(config_dir, id)? {
            let path = Path::new(&sp_ref.path);
            if path.exists() {
                std::fs::remove_dir_all(path)?;
            }
        }
    }
    registry::remove_space(config_dir, id)
}

/// Create a space inside a parent space folder.
pub fn create_space(
    parent_path: &Path,
    name: &str,
    icon: &str,
    folder_name: &str,
) -> Result<SpaceInfo, AppError> {
    let space_dir = parent_path.join(folder_name);
    if space_dir.exists() {
        return Err(AppError::FileAlreadyExists(
            space_dir.to_string_lossy().to_string(),
        ));
    }
    std::fs::create_dir_all(&space_dir)?;

    let (id, cfg) = create_and_register(
        &space_dir,
        name,
        icon,
        "",
        RegistrationTarget::ParentSpace(parent_path, folder_name.to_string(), None),
    )?;

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: space_dir.to_string_lossy().to_string(),
        has_spaces: false,
        last_opened: None,
        status: SpaceStatus::Ready,
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
    repo: Option<String>,
) -> Result<SpaceInfo, AppError> {
    let space_dir = parent_path.join(folder_name);
    if !space_dir.is_dir() {
        return Err(AppError::PathNotAccessible(
            space_dir.to_string_lossy().to_string(),
        ));
    }

    // Check if already registered in parent
    let parent_config = config::read_space_config(parent_path)?;
    if let Some(spaces) = &parent_config.spaces {
        if let Some(existing) = spaces.iter().find(|s| s.path == folder_name) {
            let cfg = match config::read_space_config(&space_dir) {
                Ok(cfg) => cfg,
                Err(_) => scaffold::scaffold_space(&space_dir, fallback_name, icon, "")?,
            };
            return Ok(SpaceInfo {
                id: existing.id.clone(),
                name: cfg.name,
                icon: cfg.icon,
                description: cfg.description,
                path: space_dir.to_string_lossy().to_string(),
                has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
                last_opened: None,
                status: SpaceStatus::Ready,
            });
        }
    }

    let (id, cfg) = create_and_register(
        &space_dir,
        fallback_name,
        icon,
        "",
        RegistrationTarget::ParentSpace(parent_path, folder_name.to_string(), repo),
    )?;

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: space_dir.to_string_lossy().to_string(),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
    })
}

/// Delete a space: remove from parent config, optionally delete files.
pub fn delete_space(
    parent_path: &Path,
    space_id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    let mut parent_config = config::read_space_config(parent_path)?;

    let folder_name = parent_config
        .spaces
        .as_ref()
        .and_then(|spaces| spaces.iter().find(|s| s.id == space_id))
        .map(|s| s.path.clone());

    if let Some(ref folder) = folder_name {
        if delete_files {
            let space_path = parent_path.join(folder);
            if space_path.exists() && space_path.is_dir() {
                std::fs::remove_dir_all(&space_path)?;
            }
        }
        let _ = crate::git::ops::remove_independent_gitignore(parent_path, folder);
    }

    if let Some(ref mut spaces) = parent_config.spaces {
        spaces.retain(|s| s.id != space_id);
    }
    config::write_space_config(parent_path, &parent_config)
}

/// List spaces of a space by reading its config and resolving paths.
pub fn list_spaces(parent_path: &Path) -> Result<Vec<SpaceInfo>, AppError> {
    let parent_config = config::read_space_config(parent_path)?;
    let mut result = Vec::new();

    if let Some(spaces) = &parent_config.spaces {
        for space_ref in spaces {
            let space_path = parent_path.join(&space_ref.path);
            let exists = space_path.exists();

            if exists {
                let space_config = config::read_space_config(&space_path).ok();
                result.push(SpaceInfo {
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
                    status: SpaceStatus::Ready,
                });
            } else {
                // Ghost state: folder missing
                let status = if space_ref.repo.is_some() {
                    SpaceStatus::Missing
                } else {
                    let gitmodules = parent_path.join(".gitmodules");
                    if gitmodules.exists() {
                        let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
                        if content.contains(&format!("path = {}", space_ref.path)) {
                            SpaceStatus::Missing
                        } else {
                            SpaceStatus::Broken
                        }
                    } else {
                        SpaceStatus::Broken
                    }
                };
                result.push(SpaceInfo {
                    id: space_ref.id.clone(),
                    name: space_ref.path.clone(),
                    icon: String::new(),
                    description: String::new(),
                    path: space_path.to_string_lossy().to_string(),
                    has_spaces: false,
                    last_opened: None,
                    status,
                });
            }
        }
    }

    Ok(result)
}

/// Update the repo URL for a space in the parent config.
pub fn reconcile_space_url(
    parent_path: &Path,
    space_id: &str,
    actual_url: Option<&str>,
) -> Result<(), AppError> {
    let mut parent_config = config::read_space_config(parent_path)?;
    if let Some(ref mut spaces) = parent_config.spaces {
        if let Some(space_ref) = spaces.iter_mut().find(|s| s.id == space_id) {
            let new_repo = actual_url.map(|u| u.to_string());
            if space_ref.repo != new_repo {
                space_ref.repo = new_repo;
                config::write_space_config(parent_path, &parent_config)?;
            }
        }
    }
    Ok(())
}

/// Remove a missing space entry from the parent config (no file deletion).
pub fn remove_missing_space(parent_path: &Path, space_id: &str) -> Result<(), AppError> {
    let mut parent_config = config::read_space_config(parent_path)?;
    if let Some(ref mut spaces) = parent_config.spaces {
        spaces.retain(|s| s.id != space_id);
    }
    config::write_space_config(parent_path, &parent_config)
}
