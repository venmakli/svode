use std::path::Path;

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative};
use svode_core::git::ops::SubmoduleConfig;
use svode_core::system_path;

use super::config;
use super::registry;
use super::scaffold;
use super::types::{SpaceConfig, SpaceGitType, SpaceInfo, SpaceRef, SpaceStatus, Unreadable};
use svode_core::space_config::SpaceConfigError;
use svode_core::storage::lfs::LfsState;

/// Where to register a newly created/opened space.
enum RegistrationTarget<'a> {
    /// Global registry (spaces.json) — for root projects.
    Registry(&'a Path),
    /// Parent space config.json — for child spaces.
    /// (parent_path, folder_name, repo_url, repository_owned)
    ParentSpace(&'a Path, String, Option<String>, bool),
}

/// A project or space that was opened or registered.
pub struct Registered {
    pub id: String,
    pub config: SpaceConfig,
    /// Why its existing config cannot be read; `config` then holds only the
    /// name of its folder.
    pub config_unreadable: Option<Unreadable>,
}

/// The name of a folder, the fallback name of its project or space.
pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string())
}

/// The config of a registered project or space. A missing file is an error;
/// one that cannot be read gives the name of its folder and the reason.
pub fn read_registered_config(path: &Path) -> Result<(SpaceConfig, Option<Unreadable>), AppError> {
    match svode_core::space_config::read(path) {
        Ok(config) => Ok((config, None)),
        Err(SpaceConfigError::Unreadable(reason)) => {
            Ok((SpaceConfig::named(&folder_name(path)), Some(reason)))
        }
        Err(error) => Err(error.into()),
    }
}

/// The config of a folder being opened or registered. Only a missing file is
/// scaffolded; a file that cannot be read stays as it is, byte for byte.
fn read_or_scaffold(
    path: &Path,
    scaffold: impl FnOnce() -> Result<SpaceConfig, AppError>,
) -> Result<(SpaceConfig, Option<Unreadable>), AppError> {
    match svode_core::space_config::read(path) {
        Ok(config) => {
            scaffold::ensure_readme(path, &config.name)?;
            Ok((config, None))
        }
        Err(SpaceConfigError::Missing(_)) => Ok((scaffold()?, None)),
        Err(SpaceConfigError::Unreadable(reason)) => {
            Ok((SpaceConfig::named(&folder_name(path)), Some(reason)))
        }
        Err(error) => Err(error.into()),
    }
}

/// Scaffold (if needed) + generate id + register.
///
/// The caller is responsible for pre-checks (path existence, slug collision,
/// duplicate detection) before calling this.
fn create_and_register(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
    target: RegistrationTarget,
) -> Result<Registered, AppError> {
    let repository_owned = match &target {
        RegistrationTarget::Registry(_) => true,
        RegistrationTarget::ParentSpace(_, _, _, repository_owned) => *repository_owned,
    };
    let (config, config_unreadable) = read_or_scaffold(path, || {
        if repository_owned {
            scaffold::scaffold_repository_space(path, name, icon, description)
        } else {
            scaffold::scaffold_space(path, name, icon, description)
        }
    })?;

    let id = ulid::Ulid::new().to_string().to_lowercase();

    match target {
        RegistrationTarget::Registry(config_dir) => {
            registry::add_space(config_dir, &id, &system_path::user_facing_path(path))?;
        }
        RegistrationTarget::ParentSpace(parent_path, folder_name, repo, _) => {
            let mut parent_config = config::read_space_config(parent_path)?;
            let spaces = parent_config.spaces.get_or_insert_with(Vec::new);
            spaces.push(SpaceRef {
                id: id.clone(),
                path: folder_name,
                repo,
                extensions: Default::default(),
            });
            config::write_space_config(parent_path, &parent_config)?;
        }
    }

    Ok(Registered {
        id,
        config,
        config_unreadable,
    })
}

pub fn normalize_space_folder(folder_name: &str) -> Result<String, AppError> {
    let normalized = normalize_repo_relative(&folder_name.replace('\\', "/"), RootMode::Reject)?;
    let is_single_ascii_segment = !normalized.contains('/')
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !is_single_ascii_segment {
        return Err(AppError::PathNotAccessible(folder_name.to_string()));
    }
    Ok(normalized)
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
) -> Result<Registered, AppError> {
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
pub fn open_project_folder(config_dir: &Path, path: &Path) -> Result<Registered, AppError> {
    if !path.exists() || !path.is_dir() {
        return Err(AppError::PathNotAccessible(system_path::user_facing_path(
            path,
        )));
    }

    let reg = registry::read_registry(config_dir)?;
    let path_str = system_path::user_facing_path(path);
    let fallback_name = folder_name(path);

    // Reopening a registered folder should follow the same contract as opening
    // an unregistered folder: if `.svode/config.json` is missing, recreate the
    // scaffold.
    if let Some(existing) = reg.spaces.iter().find(|w| w.path == path_str) {
        let (config, config_unreadable) = read_or_scaffold(path, || {
            scaffold::scaffold_repository_space(path, &fallback_name, "", "")
        })?;
        return Ok(Registered {
            id: existing.id.clone(),
            config,
            config_unreadable,
        });
    }

    create_and_register(
        path,
        &fallback_name,
        "",
        "",
        RegistrationTarget::Registry(config_dir),
    )
}

pub fn space_ref_status(parent_path: &Path, space_ref: &SpaceRef) -> SpaceStatus {
    match svode_core::page::space_reference_status(
        parent_path,
        &space_ref.path,
        space_ref.repo.as_deref(),
    ) {
        svode_core::page::SpaceReadiness::Ready => SpaceStatus::Ready,
        svode_core::page::SpaceReadiness::Missing => SpaceStatus::Missing,
        svode_core::page::SpaceReadiness::Broken => SpaceStatus::Broken,
    }
}

/// Return the Collection capability signal for a directory-backed Space.
///
/// Capability depends only on a direct child `schema.yaml` file. Schema
/// parsing and validation belong to the Collection surface.
pub fn has_schema_capability(path: &Path, status: SpaceStatus) -> bool {
    matches!(status, SpaceStatus::Ready) && crate::files::tree::has_direct_schema(path)
}

/// Return the App capability signal for a directory-backed Space.
///
/// Presence of the exact direct `app.yaml` marker is authoritative before
/// parsing so an invalid declaration can recover inside the App surface.
pub fn has_app_capability(path: &Path, status: SpaceStatus) -> bool {
    matches!(status, SpaceStatus::Ready)
        && svode_core::apps::manifest::has_direct_app_manifest(path)
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
            extensions: Default::default(),
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
///
/// The requested Git type decides the storage scaffold: the caller runs
/// `git init` for independent and submodule spaces only after this returns.
pub fn create_space(
    parent_path: &Path,
    name: &str,
    icon: &str,
    folder_name: &str,
    git_type: SpaceGitType,
) -> Result<SpaceInfo, AppError> {
    let folder_name = normalize_space_folder(folder_name)?;
    let space_dir = parent_path.join(&folder_name);
    if space_dir.exists() {
        return Err(AppError::FileAlreadyExists(system_path::user_facing_path(
            &space_dir,
        )));
    }
    std::fs::create_dir_all(&space_dir)?;

    let registered = create_and_register(
        &space_dir,
        name,
        icon,
        "",
        RegistrationTarget::ParentSpace(
            parent_path,
            folder_name.clone(),
            None,
            git_type != SpaceGitType::Inline,
        ),
    )?;

    Ok(registered_space_info(registered, &space_dir))
}

fn registered_space_info(registered: Registered, space_dir: &Path) -> SpaceInfo {
    let Registered {
        id,
        config,
        config_unreadable,
    } = registered;
    SpaceInfo {
        id,
        name: config.name,
        icon: config.icon,
        description: config.description,
        path: system_path::user_facing_path(space_dir),
        has_spaces: config.spaces.as_ref().is_some_and(|s| !s.is_empty()),
        has_schema: has_schema_capability(space_dir, SpaceStatus::Ready),
        has_app: has_app_capability(space_dir, SpaceStatus::Ready),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
        config_unreadable,
    }
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
    let folder_name = normalize_space_folder(folder_name)?;
    let space_dir = parent_path.join(&folder_name);
    if !space_dir.is_dir() {
        return Err(AppError::PathNotAccessible(system_path::user_facing_path(
            &space_dir,
        )));
    }

    // Check if already registered in parent
    let parent_config = config::read_space_config(parent_path)?;
    if let Some(spaces) = &parent_config.spaces {
        if let Some(existing) = spaces.iter().find(|s| s.path == folder_name) {
            let (config, config_unreadable) = read_or_scaffold(&space_dir, || {
                if space_dir.join(".git").symlink_metadata().is_ok() {
                    scaffold::scaffold_repository_space(&space_dir, fallback_name, icon, "")
                } else {
                    scaffold::scaffold_space(&space_dir, fallback_name, icon, "")
                }
            })?;
            let registered = Registered {
                id: existing.id.clone(),
                config,
                config_unreadable,
            };
            return Ok(registered_space_info(registered, &space_dir));
        }
    }

    let repository_owned = repo.is_some() || space_dir.join(".git").symlink_metadata().is_ok();
    let registered = create_and_register(
        &space_dir,
        fallback_name,
        icon,
        "",
        RegistrationTarget::ParentSpace(parent_path, folder_name.clone(), repo, repository_owned),
    )?;

    Ok(registered_space_info(registered, &space_dir))
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
        let _ = svode_core::git::ops::remove_independent_gitignore(parent_path, folder);
    }

    if let Some(ref mut spaces) = parent_config.spaces {
        spaces.retain(|s| s.id != space_id);
    }
    config::write_space_config(parent_path, &parent_config)
}

/// List spaces of a space by reading its config and resolving paths.
pub fn list_spaces(parent_path: &Path) -> Result<Vec<SpaceInfo>, AppError> {
    Ok(
        svode_core::content_tree::list_project_children(parent_path)?
            .into_iter()
            .map(|child| SpaceInfo {
                id: child.id,
                name: child.name,
                icon: child.icon,
                description: child.description,
                path: system_path::user_facing_path(&child.path),
                has_spaces: child.has_spaces,
                has_schema: child.has_schema,
                has_app: child.has_app,
                last_opened: None,
                status: match child.status {
                    svode_core::page::SpaceReadiness::Ready => SpaceStatus::Ready,
                    svode_core::page::SpaceReadiness::Missing => SpaceStatus::Missing,
                    svode_core::page::SpaceReadiness::Broken => SpaceStatus::Broken,
                },
                lfs_state: LfsState::NotApplicable,
                config_unreadable: child.config_unreadable,
            })
            .collect(),
    )
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
        create_project, create_space, delete_space, has_schema_capability,
        import_existing_submodule_spaces, list_spaces, normalize_space_folder, open_project_folder,
        read_registered_config, reconcile_space_url, register_cloned_space, remove_missing_space,
        space_ref_status,
    };
    use crate::space::registry;
    use crate::space::scaffold;
    use crate::space::types::{SpaceGitType, SpaceRef, SpaceStatus, Unreadable};
    use std::path::Path;
    use svode_core::git::ops::SubmoduleConfig;

    #[test]
    fn normalize_space_folder_allows_ascii_friendly_names() {
        assert_eq!(
            normalize_space_folder("Ops_2026-support-v2").expect("normalize"),
            "Ops_2026-support-v2"
        );
    }

    #[test]
    fn normalize_space_folder_rejects_paths_and_unsafe_names() {
        assert!(normalize_space_folder("testov/support").is_err());
        assert!(normalize_space_folder("testov\\support").is_err());
        assert!(normalize_space_folder("../support").is_err());
        assert!(normalize_space_folder("/support").is_err());
        assert!(normalize_space_folder("C:/support").is_err());
        assert!(normalize_space_folder("поддержка").is_err());
    }

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

        let opened =
            open_project_folder(config_dir.path(), project_path).expect("open project folder");

        assert_eq!(opened.id, "registered-id");
        assert_eq!(opened.config.name, fallback_name);
        assert!(opened.config_unreadable.is_none());
        assert!(project_path.join(".svode/config.json").is_file());
        assert!(project_path.join(".svode/local.json").is_file());
        assert!(project_path.join("README.md").is_file());
    }

    /// Configs that exist but cannot be read, with the reason each one gives.
    fn unreadable_configs() -> Vec<(&'static str, &'static str, Unreadable)> {
        let field = |field: &str| Unreadable::Field {
            field: field.to_string(),
        };
        vec![
            (
                "conflict markers",
                "{\n<<<<<<< HEAD\n  \"name\": \"Ours\"\n=======\n  \"name\": \"Theirs\"\n>>>>>>> origin/main\n}\n",
                Unreadable::Conflict,
            ),
            ("broken JSON", "{\"name\": \"Docs\",", Unreadable::NotJson),
            (
                "no name",
                "{\"icon\": \"x\", \"spaces\": []}",
                field("name"),
            ),
            (
                "field of another type",
                "{\"name\": \"Docs\", \"icon\": 7}",
                field("icon"),
            ),
            (
                "repeated key",
                "{\"name\": \"Ours\", \"name\": \"Theirs\"}",
                field("name"),
            ),
        ]
    }

    fn write_config(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.join(".svode")).expect("svode dir");
        std::fs::write(path.join(".svode/config.json"), contents).expect("config");
    }

    fn read_config(path: &Path) -> String {
        std::fs::read_to_string(path.join(".svode/config.json")).expect("config")
    }

    #[test]
    fn opening_a_project_with_an_unreadable_config_keeps_the_file() {
        for registered in [true, false] {
            for (case, contents, reason) in unreadable_configs() {
                let config_dir = tempfile::tempdir().expect("config dir");
                let parent = tempfile::tempdir().expect("parent dir");
                let project = parent.path().join("my-project");
                write_config(&project, contents);
                if registered {
                    registry::add_space(
                        config_dir.path(),
                        "registered-id",
                        &project.to_string_lossy(),
                    )
                    .expect("register project");
                }

                let opened = open_project_folder(config_dir.path(), &project).expect(case);

                assert_eq!(opened.config_unreadable, Some(reason), "{case}");
                assert_eq!(opened.config.name, "my-project", "{case}");
                assert!(opened.config.spaces.is_none(), "{case}");
                assert_eq!(read_config(&project), contents, "{case}");
                assert!(!project.join("README.md").exists(), "{case}");
                if registered {
                    assert_eq!(opened.id, "registered-id", "{case}");
                } else {
                    let found = registry::find_space(config_dir.path(), &opened.id)
                        .expect("registry")
                        .expect("registered");
                    assert_eq!(Path::new(&found.path), project, "{case}");
                }
            }
        }
    }

    #[test]
    fn connecting_a_space_with_an_unreadable_config_keeps_the_file() {
        for registered in [true, false] {
            for (case, contents, reason) in unreadable_configs() {
                let config_dir = tempfile::tempdir().expect("config dir");
                let project_dir = tempfile::tempdir().expect("project dir");
                let project = project_dir.path();
                create_project(config_dir.path(), "Root", "", "", project).expect("create project");
                let space = project.join("docs");
                std::fs::create_dir_all(space.join(".git")).expect("space git");
                write_config(&space, contents);
                if registered {
                    import_existing_submodule_spaces(
                        project,
                        &[SubmoduleConfig {
                            path: "docs".to_string(),
                            url: None,
                        }],
                    )
                    .expect("register space");
                }

                let info =
                    register_cloned_space(project, "docs", "Fallback", "", None).expect(case);

                assert_eq!(info.config_unreadable, Some(reason), "{case}");
                assert_eq!(info.name, "docs", "{case}");
                assert_eq!(info.status, SpaceStatus::Ready, "{case}");
                assert_eq!(read_config(&space), contents, "{case}");
                let listed = crate::space::config::read_space_config(project)
                    .expect("project config")
                    .spaces
                    .expect("spaces");
                assert_eq!(listed.len(), 1, "{case}");
                assert_eq!(listed[0].id, info.id, "{case}");
            }
        }
    }

    #[test]
    fn a_registered_project_opens_with_an_unreadable_config_but_not_without_one() {
        let parent = tempfile::tempdir().expect("parent dir");
        let project = parent.path().join("my-project");
        std::fs::create_dir_all(&project).expect("project dir");
        assert!(read_registered_config(&project).is_err());

        let (_, contents, reason) = unreadable_configs().remove(0);
        write_config(&project, contents);
        let (config, unreadable) = read_registered_config(&project).expect("open");

        assert_eq!(config.name, "my-project");
        assert_eq!(unreadable, Some(reason));
        assert_eq!(read_config(&project), contents);
    }

    #[test]
    fn a_listed_space_with_an_unreadable_config_carries_the_reason() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        create_project(config_dir.path(), "Root", "", "", project).expect("create project");
        create_space(project, "Docs", "", "docs", SpaceGitType::Inline).expect("create space");
        let (_, contents, reason) = unreadable_configs().remove(0);
        write_config(&project.join("docs"), contents);

        let spaces = list_spaces(project).expect("list spaces");

        assert_eq!(spaces[0].config_unreadable, Some(reason));
        assert_eq!(spaces[0].name, "docs");
    }

    #[test]
    fn writes_of_an_unreadable_config_refuse_without_paths() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        create_project(config_dir.path(), "Root", "", "", project).expect("create project");
        create_space(project, "Docs", "", "docs", SpaceGitType::Inline).expect("create space");
        let (_, contents, _) = unreadable_configs().remove(0);
        write_config(project, contents);

        let refusals = [
            create_space(project, "New", "", "new", SpaceGitType::Inline).map(|_| ()),
            delete_space(project, "missing", false),
            remove_missing_space(project, "missing"),
            reconcile_space_url(project, "missing", None),
            crate::space::config::write_space_config(
                project,
                &crate::space::types::SpaceConfig::named("Renamed"),
            ),
        ];

        for refusal in refusals {
            let message = refusal.expect_err("refused").to_string();
            assert_eq!(
                message,
                ".svode/config.json cannot be read: it is in a conflict after sync"
            );
        }
        assert_eq!(read_config(project), contents);
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
    fn space_registry_writers_keep_unknown_config_keys_and_strategy() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        std::fs::create_dir_all(project.join(".svode")).expect("svode dir");
        std::fs::write(
            project.join(".svode/config.json"),
            serde_json::json!({
                "name": "Root",
                "futureRoot": "kept",
                "assets": { "strategy": "lfs-future", "futureAssets": "kept" },
                "spaces": [
                    { "id": "missing", "path": "gone", "repo": null, "futureSpace": "missing" },
                    { "id": "kept", "path": "kept", "repo": null, "futureSpace": "kept" },
                    { "id": "deleted", "path": "deleted", "repo": null, "futureSpace": "deleted" }
                ]
            })
            .to_string(),
        )
        .expect("config");
        let raw = || -> serde_json::Value {
            serde_json::from_str(
                &std::fs::read_to_string(project.join(".svode/config.json")).expect("config"),
            )
            .expect("json")
        };
        let entry = |value: &serde_json::Value, id: &str| {
            value["spaces"]
                .as_array()
                .and_then(|entries| entries.iter().find(|entry| entry["id"] == id).cloned())
        };
        let assert_kept = |step: &str| {
            let value = raw();
            assert_eq!(value["futureRoot"], "kept", "{step}");
            assert_eq!(value["assets"]["futureAssets"], "kept", "{step}");
            assert_eq!(value["assets"]["strategy"], "lfs-future", "{step}");
            assert_eq!(
                entry(&value, "kept").unwrap()["futureSpace"],
                "kept",
                "{step}"
            );
            value
        };

        create_space(project, "Inline", "", "inline", SpaceGitType::Inline)
            .expect("register inline space");
        let value = assert_kept("registration");
        assert_eq!(entry(&value, "missing").unwrap()["futureSpace"], "missing");

        reconcile_space_url(project, "kept", Some("https://example.com/kept.git"))
            .expect("reconcile url");
        let value = assert_kept("url change");
        assert_eq!(
            entry(&value, "kept").unwrap()["repo"],
            "https://example.com/kept.git"
        );

        import_existing_submodule_spaces(
            project,
            &[SubmoduleConfig {
                path: "docs".to_string(),
                url: Some("https://example.com/docs.git".to_string()),
            }],
        )
        .expect("import submodule");
        assert_kept("submodule import");

        remove_missing_space(project, "missing").expect("remove missing");
        let value = assert_kept("missing removal");
        assert!(entry(&value, "missing").is_none());

        delete_space(project, "deleted", false).expect("delete space");
        let value = assert_kept("deletion");
        assert!(entry(&value, "deleted").is_none());
    }

    fn raw_config(path: &Path) -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(path.join(".svode/config.json")).expect("config"),
        )
        .expect("json")
    }

    #[test]
    fn create_space_scaffolds_storage_block_by_requested_git_type() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        create_project(config_dir.path(), "Root", "", "", project).expect("create project");
        let project_assets = raw_config(project)["assets"].clone();
        assert!(project_assets.is_object());

        for (folder, git_type) in [
            ("independent", SpaceGitType::Independent),
            ("submodule", SpaceGitType::Submodule),
        ] {
            create_space(project, folder, "", folder, git_type).expect("create space");
            let space = project.join(folder);
            assert!(space.join(".git").symlink_metadata().is_err());
            assert_eq!(raw_config(&space)["assets"], project_assets, "{folder}");
        }

        create_space(project, "Inline", "", "inline", SpaceGitType::Inline)
            .expect("create inline space");
        assert!(raw_config(&project.join("inline")).get("assets").is_none());
    }

    #[test]
    fn register_cloned_space_scaffolds_storage_block_only_without_config() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        create_project(config_dir.path(), "Root", "", "", project).expect("create project");
        let project_assets = raw_config(project)["assets"].clone();

        let fresh = project.join("fresh");
        std::fs::create_dir_all(fresh.join(".git")).expect("fresh git");
        register_cloned_space(project, "fresh", "Fresh", "", None).expect("register fresh");
        assert_eq!(raw_config(&fresh)["assets"], project_assets);

        let existing = project.join("existing");
        std::fs::create_dir_all(existing.join(".git")).expect("existing git");
        std::fs::create_dir_all(existing.join(".svode")).expect("existing svode");
        let config = r#"{"name":"Existing","icon":"x","description":""}"#;
        std::fs::write(existing.join(".svode/config.json"), config).expect("existing config");
        register_cloned_space(
            project,
            "existing",
            "Fallback",
            "",
            Some("https://example.com/existing.git".to_string()),
        )
        .expect("register existing");
        assert_eq!(
            std::fs::read_to_string(existing.join(".svode/config.json")).expect("config"),
            config
        );
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

        open_project_folder(config_dir.path(), project_path).expect("open project folder");

        assert_eq!(
            std::fs::read_to_string(project_path.join("README.md")).expect("read readme"),
            "custom home"
        );
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
                extensions: Default::default(),
            },
        );

        assert_eq!(status, SpaceStatus::Broken);
    }

    #[test]
    fn schema_capability_uses_direct_child_file_without_parsing() {
        let space_dir = tempfile::tempdir().expect("space dir");
        std::fs::write(space_dir.path().join("schema.yaml"), "not: [valid").expect("schema");

        assert!(has_schema_capability(space_dir.path(), SpaceStatus::Ready));
    }

    #[test]
    fn schema_capability_ignores_nested_schema() {
        let space_dir = tempfile::tempdir().expect("space dir");
        std::fs::create_dir(space_dir.path().join("nested")).expect("nested dir");
        std::fs::write(space_dir.path().join("nested/schema.yaml"), "type: object")
            .expect("nested schema");

        assert!(!has_schema_capability(space_dir.path(), SpaceStatus::Ready));
    }

    #[test]
    fn schema_capability_is_disabled_for_non_ready_spaces() {
        let space_dir = tempfile::tempdir().expect("space dir");
        std::fs::write(space_dir.path().join("schema.yaml"), "type: object").expect("schema");

        assert!(!has_schema_capability(
            space_dir.path(),
            SpaceStatus::Missing
        ));
        assert!(!has_schema_capability(
            space_dir.path(),
            SpaceStatus::Broken
        ));
    }
}
