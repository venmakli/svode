use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::git::ops::SubmoduleConfig;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::system_path;

use super::config;
use super::registry;
use super::scaffold;
use super::types::{SpaceConfig, SpaceInfo, SpaceRef, SpaceStatus};
use crate::storage::lfs::LfsState;

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
        Ok(cfg) => {
            scaffold::ensure_readme(path, &cfg.name)?;
            cfg
        }
        Err(_) => scaffold::scaffold_space(path, name, icon, description)?,
    };

    let id = ulid::Ulid::new().to_string().to_lowercase();

    match target {
        RegistrationTarget::Registry(config_dir) => {
            registry::add_space(config_dir, &id, &system_path::user_facing_path(path))?;
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

/// Ensure an existing root project or child space has a scope home README.
///
/// Returns `true` only when README.md was created.
pub fn ensure_scope_readme(path: &Path, fallback_title: &str) -> Result<bool, AppError> {
    let title = config::read_space_config(path)
        .map(|cfg| cfg.name)
        .unwrap_or_else(|_| fallback_title.to_string());
    scaffold::ensure_readme(path, &title)
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
        return Err(AppError::PathNotAccessible(system_path::user_facing_path(
            path,
        )));
    }

    create_and_register(
        path,
        name,
        icon,
        description,
        RegistrationTarget::Registry(config_dir),
    )
}

/// Register an existing folder as a root project (open folder).
pub fn open_project_folder(
    config_dir: &Path,
    path: &Path,
) -> Result<(String, SpaceConfig), AppError> {
    if !path.exists() || !path.is_dir() {
        return Err(AppError::PathNotAccessible(system_path::user_facing_path(
            path,
        )));
    }

    let reg = registry::read_registry(config_dir)?;
    let path_str = system_path::user_facing_path(path);
    let fallback_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string());

    // Reopening a registered folder should follow the same contract as opening
    // an unregistered folder: if `.svode/` is missing, recreate the scaffold.
    if let Some(existing) = reg.spaces.iter().find(|w| w.path == path_str) {
        let cfg = match config::read_space_config(path) {
            Ok(cfg) => {
                scaffold::ensure_readme(path, &cfg.name)?;
                cfg
            }
            Err(_) => scaffold::scaffold_space(path, &fallback_name, "", "")?,
        };
        return Ok((existing.id.clone(), cfg));
    }

    create_and_register(
        path,
        &fallback_name,
        "",
        "",
        RegistrationTarget::Registry(config_dir),
    )
}

fn gitmodules_contains_path(parent_path: &Path, space_path: &str) -> bool {
    let gitmodules = parent_path.join(".gitmodules");
    if !gitmodules.exists() {
        return false;
    }
    let content = std::fs::read_to_string(gitmodules).unwrap_or_default();
    content.lines().any(|line| {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("path") else {
            return false;
        };
        let Some((_, value)) = rest.split_once('=') else {
            return false;
        };
        value.trim() == space_path
    })
}

fn submodule_checkout_ready(parent_path: &Path, space_path: &str) -> bool {
    parent_path
        .join(space_path)
        .join(".git")
        .symlink_metadata()
        .is_ok()
}

pub fn space_ref_status(parent_path: &Path, space_ref: &SpaceRef) -> SpaceStatus {
    let space_path = parent_path.join(&space_ref.path);
    let is_submodule = gitmodules_contains_path(parent_path, &space_ref.path);

    if space_path.exists() {
        if is_submodule && !submodule_checkout_ready(parent_path, &space_ref.path) {
            SpaceStatus::Missing
        } else {
            SpaceStatus::Ready
        }
    } else if space_ref.repo.is_some() || is_submodule {
        SpaceStatus::Missing
    } else {
        SpaceStatus::Broken
    }
}

/// Register direct git submodules from an existing project as Svode spaces.
///
/// This is intentionally conservative: nested submodule paths are skipped
/// because the current resolver treats project spaces as direct children.
pub fn import_existing_submodule_spaces(
    parent_path: &Path,
    submodules: &[SubmoduleConfig],
) -> Result<usize, AppError> {
    if submodules.is_empty() {
        return Ok(0);
    }

    let mut parent_config = config::read_space_config(parent_path)?;
    let spaces = parent_config.spaces.get_or_insert_with(Vec::new);
    let mut imported = 0usize;

    for submodule in submodules {
        let normalized =
            match normalize_repo_relative(&submodule.path.replace('\\', "/"), RootMode::Reject) {
                Ok(path) => path,
                Err(e) => {
                    tracing::warn!("Skipping invalid submodule path {}: {e}", submodule.path);
                    continue;
                }
            };

        if normalized.contains('/') {
            tracing::warn!(
                "Skipping nested submodule path {} during Svode import",
                normalized
            );
            continue;
        }

        if spaces.iter().any(|space| space.path == normalized) {
            continue;
        }

        spaces.push(SpaceRef {
            id: ulid::Ulid::new().to_string().to_lowercase(),
            path: normalized,
            // For submodules, `.gitmodules` remains the source of truth.
            repo: None,
        });
        imported += 1;
    }

    if imported > 0 {
        config::write_space_config(parent_path, &parent_config)?;
    }

    Ok(imported)
}

/// Delete a root project: remove from registry, optionally delete files.
pub fn delete_project(config_dir: &Path, id: &str, delete_files: bool) -> Result<(), AppError> {
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
        return Err(AppError::FileAlreadyExists(system_path::user_facing_path(
            &space_dir,
        )));
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
        path: system_path::user_facing_path(&space_dir),
        has_spaces: false,
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

/// Register a freshly-cloned directory as a space.
///
/// Called by the clone flow after `git clone` completes. Reads or
/// scaffolds `.svode/config.json` inside the cloned folder, then adds a
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
        return Err(AppError::PathNotAccessible(system_path::user_facing_path(
            &space_dir,
        )));
    }

    // Check if already registered in parent
    let parent_config = config::read_space_config(parent_path)?;
    if let Some(spaces) = &parent_config.spaces {
        if let Some(existing) = spaces.iter().find(|s| s.path == folder_name) {
            let cfg = match config::read_space_config(&space_dir) {
                Ok(cfg) => {
                    scaffold::ensure_readme(&space_dir, &cfg.name)?;
                    cfg
                }
                Err(_) => scaffold::scaffold_space(&space_dir, fallback_name, icon, "")?,
            };
            return Ok(SpaceInfo {
                id: existing.id.clone(),
                name: cfg.name,
                icon: cfg.icon,
                description: cfg.description,
                path: system_path::user_facing_path(&space_dir),
                has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
                last_opened: None,
                status: SpaceStatus::Ready,
                lfs_state: LfsState::NotApplicable,
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
        path: system_path::user_facing_path(&space_dir),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
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
            let status = space_ref_status(parent_path, space_ref);

            if matches!(status, SpaceStatus::Ready) {
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
                    path: system_path::user_facing_path(&space_path),
                    has_spaces: space_config
                        .as_ref()
                        .and_then(|c| c.spaces.as_ref())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false),
                    last_opened: None,
                    status,
                    lfs_state: LfsState::NotApplicable,
                });
            } else {
                result.push(SpaceInfo {
                    id: space_ref.id.clone(),
                    name: space_ref.path.clone(),
                    icon: String::new(),
                    description: String::new(),
                    path: system_path::user_facing_path(&space_path),
                    has_spaces: false,
                    last_opened: None,
                    status,
                    lfs_state: LfsState::NotApplicable,
                });
            }
        }
    }

    Ok(result)
}

/// Reorder child spaces in the root project's `.svode/config.json`.
///
/// The root project is not part of the input. The input must contain exactly
/// the current child-space ids, with no duplicates, missing ids, or unknown ids.
pub fn reorder_spaces(
    parent_path: &Path,
    ordered_space_ids: Vec<String>,
) -> Result<Vec<SpaceInfo>, AppError> {
    let mut parent_config = config::read_space_config(parent_path)?;
    let current_spaces = parent_config.spaces.clone().unwrap_or_default();

    if ordered_space_ids.len() != current_spaces.len() {
        return Err(AppError::General(format!(
            "space reorder expected {} ids, got {}",
            current_spaces.len(),
            ordered_space_ids.len()
        )));
    }

    let mut seen = HashSet::with_capacity(ordered_space_ids.len());
    for id in &ordered_space_ids {
        if !seen.insert(id.clone()) {
            return Err(AppError::General(format!(
                "space reorder contains duplicate id: {id}"
            )));
        }
    }

    let current_ids: HashSet<String> = current_spaces
        .iter()
        .map(|space| space.id.clone())
        .collect();
    let ordered_ids: HashSet<String> = ordered_space_ids.iter().cloned().collect();

    let missing: Vec<String> = current_ids.difference(&ordered_ids).cloned().collect();
    if !missing.is_empty() {
        return Err(AppError::General(format!(
            "space reorder is missing ids: {}",
            missing.join(", ")
        )));
    }

    let unknown: Vec<String> = ordered_ids.difference(&current_ids).cloned().collect();
    if !unknown.is_empty() {
        return Err(AppError::General(format!(
            "space reorder contains unknown ids: {}",
            unknown.join(", ")
        )));
    }

    let mut by_id: HashMap<String, SpaceRef> = current_spaces
        .into_iter()
        .map(|space| (space.id.clone(), space))
        .collect();
    let mut reordered = Vec::with_capacity(ordered_space_ids.len());
    for id in ordered_space_ids {
        let space_ref = by_id
            .remove(&id)
            .ok_or_else(|| AppError::General(format!("space reorder contains unknown id: {id}")))?;
        reordered.push(space_ref);
    }

    parent_config.spaces = Some(reordered);
    config::write_space_config(parent_path, &parent_config)?;

    list_spaces(parent_path)
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

#[cfg(test)]
mod tests {
    use super::{
        import_existing_submodule_spaces, open_project_folder, reorder_spaces, space_ref_status,
    };
    use crate::git::ops::SubmoduleConfig;
    use crate::space::registry;
    use crate::space::scaffold;
    use crate::space::types::{SpaceRef, SpaceStatus};

    #[test]
    fn open_registered_folder_without_svode_recreates_scaffold() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        let project_path_str = project_path.to_string_lossy().to_string();
        let fallback_name = project_path
            .file_name()
            .expect("folder name")
            .to_string_lossy()
            .to_string();

        registry::add_space(config_dir.path(), "registered-id", &project_path_str)
            .expect("register project");

        let (id, cfg) =
            open_project_folder(config_dir.path(), project_path).expect("open project folder");

        assert_eq!(id, "registered-id");
        assert_eq!(cfg.name, fallback_name);
        assert!(project_path.join(".svode/config.json").is_file());
        assert!(project_path.join(".svode/local.json").is_file());
        assert!(project_path.join("README.md").is_file());
    }

    #[test]
    fn import_submodules_registers_only_direct_children_without_scaffolding() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        std::fs::create_dir(project_path.join("docs")).expect("docs dir");
        scaffold::scaffold_space(project_path, "Root", "", "").expect("root scaffold");

        let imported = import_existing_submodule_spaces(
            project_path,
            &[
                SubmoduleConfig {
                    path: "docs".to_string(),
                    url: Some("https://example.com/docs.git".to_string()),
                },
                SubmoduleConfig {
                    path: "libs/nested".to_string(),
                    url: Some("https://example.com/nested.git".to_string()),
                },
            ],
        )
        .expect("import submodules");

        let cfg = crate::space::config::read_space_config(project_path).expect("read root config");
        let spaces = cfg.spaces.expect("spaces");

        assert_eq!(imported, 1);
        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].path, "docs");
        assert_eq!(spaces[0].repo, None);
        assert!(!project_path.join("docs/.svode/config.json").exists());
    }

    #[test]
    fn open_existing_registered_folder_preserves_readme_content() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        scaffold::scaffold_space(project_path, "Root", "", "").expect("root scaffold");
        std::fs::write(project_path.join("README.md"), "custom home").expect("readme");
        registry::add_space(
            config_dir.path(),
            "registered-id",
            &project_path.to_string_lossy(),
        )
        .expect("register project");

        let (_id, _cfg) =
            open_project_folder(config_dir.path(), project_path).expect("open project folder");

        assert_eq!(
            std::fs::read_to_string(project_path.join("README.md")).expect("read readme"),
            "custom home"
        );
    }

    #[test]
    fn reorder_spaces_persists_saved_order() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        scaffold::scaffold_space(project_path, "Root", "", "").expect("root scaffold");

        let mut cfg = crate::space::config::read_space_config(project_path).expect("read config");
        cfg.spaces = Some(vec![
            SpaceRef {
                id: "a".to_string(),
                path: "alpha".to_string(),
                repo: None,
            },
            SpaceRef {
                id: "b".to_string(),
                path: "beta".to_string(),
                repo: Some("https://example.com/beta.git".to_string()),
            },
        ]);
        crate::space::config::write_space_config(project_path, &cfg).expect("write config");

        let spaces =
            reorder_spaces(project_path, vec!["b".to_string(), "a".to_string()]).expect("reorder");
        let cfg = crate::space::config::read_space_config(project_path).expect("read config");
        let refs = cfg.spaces.expect("spaces");

        assert_eq!(refs[0].id, "b");
        assert_eq!(
            refs[0].repo,
            Some("https://example.com/beta.git".to_string())
        );
        assert_eq!(refs[1].id, "a");
        assert_eq!(
            spaces
                .iter()
                .map(|space| space.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }

    #[test]
    fn reorder_spaces_rejects_duplicate_missing_and_unknown_ids() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        scaffold::scaffold_space(project_path, "Root", "", "").expect("root scaffold");

        let mut cfg = crate::space::config::read_space_config(project_path).expect("read config");
        cfg.spaces = Some(vec![
            SpaceRef {
                id: "a".to_string(),
                path: "alpha".to_string(),
                repo: None,
            },
            SpaceRef {
                id: "b".to_string(),
                path: "beta".to_string(),
                repo: None,
            },
        ]);
        crate::space::config::write_space_config(project_path, &cfg).expect("write config");

        assert!(reorder_spaces(project_path, vec!["a".to_string(), "a".to_string()]).is_err());
        assert!(reorder_spaces(project_path, vec!["a".to_string()]).is_err());
        assert!(reorder_spaces(project_path, vec!["a".to_string(), "c".to_string()]).is_err());
    }

    #[test]
    fn submodule_status_matches_gitmodules_path_exactly() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        std::fs::write(
            project_path.join(".gitmodules"),
            "[submodule \"foobar\"]\n\tpath = foobar\n\turl = https://example.com/foobar.git\n",
        )
        .expect("gitmodules");

        let status = space_ref_status(
            project_path,
            &SpaceRef {
                id: "foo-id".to_string(),
                path: "foo".to_string(),
                repo: None,
            },
        );

        assert_eq!(status, SpaceStatus::Broken);
    }
}
