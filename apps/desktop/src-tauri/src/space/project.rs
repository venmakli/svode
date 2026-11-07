use std::path::Path;

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative};
use svode_core::git::ops::SubmoduleConfig;
use svode_core::project::scaffold::{self, Storage, folder_name};
use svode_core::system_path;

use super::config;
use super::registry;
use super::types::{SpaceConfig, SpaceInfo, SpaceRef, SpaceStatus, Unreadable};
use svode_core::space_config::SpaceConfigError;
use svode_core::storage::lfs::LfsState;

/// A project or space that was opened or registered.
pub struct Registered {
    pub id: String,
    pub config: SpaceConfig,
    /// Why its existing config cannot be read; `config` then holds only the
    /// name of its folder.
    pub config_unreadable: Option<Unreadable>,
}

impl Registered {
    fn new(id: String, opened: scaffold::Opened) -> Self {
        Self {
            id,
            config: opened.config,
            config_unreadable: opened.config_unreadable,
        }
    }
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

/// Open or scaffold a root project folder and register it in spaces.json.
fn register_project(
    config_dir: &Path,
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
) -> Result<Registered, AppError> {
    let opened = scaffold::open(path, name, icon, description, Storage::Own)?;
    let id = scaffold::new_space_id();
    registry::add_space(config_dir, &id, &system_path::user_facing_path(path))?;
    Ok(Registered::new(id, opened))
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

    register_project(config_dir, path, name, icon, description)
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
        let opened = scaffold::open(path, &fallback_name, "", "", Storage::Own)?;
        return Ok(Registered::new(existing.id.clone(), opened));
    }

    register_project(config_dir, path, &fallback_name, "", "")
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

/// The info of a child space that is ready in its folder now: just created
/// or connected.
pub fn ready_space_info(
    id: String,
    config: SpaceConfig,
    config_unreadable: Option<Unreadable>,
    space_dir: &Path,
) -> SpaceInfo {
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
        create_project, delete_space, has_schema_capability, import_existing_submodule_spaces,
        list_spaces, open_project_folder, read_registered_config, reconcile_space_url,
        remove_missing_space,
    };
    use crate::space::registry;
    use crate::space::types::{SpaceStatus, Unreadable};
    use std::path::Path;
    use svode_core::git::ops::SubmoduleConfig;
    use svode_core::project::scaffold::{self, Storage};

    /// Connect an inline child space the way a registration does.
    fn connect_inline(project: &Path, folder: &str) -> String {
        std::fs::create_dir_all(project.join(folder)).expect("space dir");
        scaffold::connect_child(project, folder, folder, "", None)
            .expect("connect space")
            .id
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
        connect_inline(project, "docs");
        let (_, contents, reason) = unreadable_configs().remove(0);
        write_config(&project.join("docs"), contents);

        let spaces = list_spaces(project).expect("list spaces");

        assert_eq!(spaces[0].config_unreadable, Some(reason));
        assert_eq!(spaces[0].name, "docs");
    }

    fn git(repo: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
            .output()
            .expect("git")
    }

    fn commit_config(repo: &Path, name: &str) {
        write_config(
            repo,
            &format!("{{\n  \"name\": \"{name}\",\n  \"spaces\": []\n}}\n"),
        );
        assert!(git(repo, &["add", "-A"]).status.success());
        assert!(git(repo, &["commit", "-qm", name]).status.success());
    }

    /// DF-235 during 1.19: a project whose `config.json` is in a merge
    /// conflict opens, and opening it changes neither the file nor the merge,
    /// so the conflict is still resolved by places in "Changes".
    #[test]
    fn opening_a_project_during_a_config_conflict_keeps_the_file_and_the_merge() {
        for registered in [true, false] {
            let config_dir = tempfile::tempdir().expect("config dir");
            let parent = tempfile::tempdir().expect("parent dir");
            let project = parent.path().join("my-project");
            std::fs::create_dir_all(&project).expect("project dir");
            assert!(
                git(&project, &["init", "-q", "-b", "main"])
                    .status
                    .success()
            );
            commit_config(&project, "Base");
            assert!(
                git(&project, &["checkout", "-qb", "incoming"])
                    .status
                    .success()
            );
            commit_config(&project, "Theirs");
            assert!(git(&project, &["checkout", "-q", "main"]).status.success());
            commit_config(&project, "Ours");
            assert!(!git(&project, &["merge", "-q", "incoming"]).status.success());
            let contents = read_config(&project);
            assert!(contents.contains("<<<<<<<"), "{contents}");
            let status = git(&project, &["status", "--porcelain=v1", "-uall"]).stdout;
            if registered {
                registry::add_space(
                    config_dir.path(),
                    "registered-id",
                    &project.to_string_lossy(),
                )
                .expect("register project");
            }

            let opened = open_project_folder(config_dir.path(), &project).expect("open");

            assert_eq!(opened.config_unreadable, Some(Unreadable::Conflict));
            assert_eq!(opened.config.name, "my-project");
            assert_eq!(read_config(&project), contents);
            assert!(project.join(".git/MERGE_HEAD").exists());
            assert_eq!(
                git(&project, &["status", "--porcelain=v1", "-uall"]).stdout,
                status
            );
            let unmerged = git(&project, &["diff", "--name-only", "--diff-filter=U"]).stdout;
            assert_eq!(String::from_utf8_lossy(&unmerged), ".svode/config.json\n");
        }
    }

    #[test]
    fn writes_of_an_unreadable_config_refuse_without_paths() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        create_project(config_dir.path(), "Root", "", "", project).expect("create project");
        connect_inline(project, "docs");
        let (_, contents, _) = unreadable_configs().remove(0);
        write_config(project, contents);

        let refusals = [
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
        scaffold::scaffold(project_path, "Root", "", "", Storage::Inherited)
            .expect("root scaffold");

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

        connect_inline(project, "inline");
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

    #[test]
    fn open_existing_registered_folder_preserves_readme_content() {
        let config_dir = tempfile::tempdir().expect("config dir");
        let project_dir = tempfile::tempdir().expect("project dir");
        let project_path = project_dir.path();
        scaffold::scaffold(project_path, "Root", "", "", Storage::Inherited)
            .expect("root scaffold");
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

        let status = svode_core::page::space_reference_status(project_path, "foo", None);

        assert_eq!(status, svode_core::page::SpaceReadiness::Broken);
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
