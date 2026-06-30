use std::path::{Path, PathBuf};

use super::s3;
use crate::error::AppError;
use crate::index::{IndexKey, IndexState};
use crate::space::config::read_space_config;
use crate::space::types::{AssetsSpaceConfig, SpaceGitType};

#[derive(Debug, Clone)]
pub struct AssetsStorageScope {
    pub pool_key: IndexKey,
    pub pool_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub config_dir: PathBuf,
    pub config: AssetsSpaceConfig,
    pub default_s3_prefix: String,
    pub git_type: Option<SpaceGitType>,
    pub inherited_from_project: bool,
}

pub async fn resolve_effective_storage_scope(
    index_state: &IndexState,
    project: &Path,
    space_id: Option<&str>,
) -> Result<AssetsStorageScope, AppError> {
    let requested_key = index_state
        .key_for_project_space_id(project, space_id)
        .await?;
    resolve_effective_storage_scope_for_key(index_state, project, requested_key).await
}

pub async fn resolve_effective_storage_scope_for_key(
    index_state: &IndexState,
    project: &Path,
    requested_key: IndexKey,
) -> Result<AssetsStorageScope, AppError> {
    let requested_dir = index_state.dir_for_key(&requested_key).await?;
    build_effective_storage_scope(project, requested_key, requested_dir)
}

fn build_effective_storage_scope(
    project: &Path,
    requested_key: IndexKey,
    requested_dir: PathBuf,
) -> Result<AssetsStorageScope, AppError> {
    let (pool_key, pool_dir, repo_dir, config_dir, git_type, inherited_from_project) =
        match &requested_key {
            IndexKey::Root(project_dir) => (
                requested_key.clone(),
                project_dir.clone(),
                project_dir.clone(),
                project_dir.clone(),
                None,
                false,
            ),
            IndexKey::Space { .. } if is_inline_space_dir(&requested_dir) => {
                let root_key = IndexKey::Root(project.to_path_buf());
                (
                    root_key,
                    project.to_path_buf(),
                    project.to_path_buf(),
                    project.to_path_buf(),
                    Some(SpaceGitType::Inline),
                    true,
                )
            }
            IndexKey::Space { .. } => {
                let git_type = detect_repo_owned_space_type(project, &requested_dir);
                (
                    requested_key.clone(),
                    requested_dir.clone(),
                    requested_dir.clone(),
                    requested_dir.clone(),
                    Some(git_type),
                    false,
                )
            }
        };

    let owner_config = read_space_config(&config_dir)?;
    let project_name = read_space_config(project).ok().map(|config| config.name);
    let default_s3_prefix = if matches!(&pool_key, IndexKey::Root(_)) || inherited_from_project {
        s3::default_root_prefix(project, project_name.as_deref())
    } else {
        s3::default_repo_space_prefix(project, project_name.as_deref(), &repo_dir)
    };
    let config = owner_config.assets.unwrap_or_default();

    Ok(AssetsStorageScope {
        pool_key,
        pool_dir,
        repo_dir,
        config_dir,
        config,
        default_s3_prefix,
        git_type,
        inherited_from_project,
    })
}

fn is_inline_space_dir(space_dir: &Path) -> bool {
    space_dir.join(".git").symlink_metadata().is_err()
}

fn detect_repo_owned_space_type(project: &Path, space_dir: &Path) -> SpaceGitType {
    let Some(folder) = space_dir.file_name().and_then(|name| name.to_str()) else {
        return SpaceGitType::Independent;
    };
    let gitmodules = project.join(".gitmodules");
    let Ok(contents) = std::fs::read_to_string(gitmodules) else {
        return SpaceGitType::Independent;
    };

    if contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .any(|(key, value)| {
            let key = key.trim();
            (key == "path" || key.ends_with(".path")) && value.trim() == folder
        })
    {
        SpaceGitType::Submodule
    } else {
        SpaceGitType::Independent
    }
}

#[cfg(test)]
mod tests {
    use super::{AssetsStorageScope, build_effective_storage_scope};
    use super::{detect_repo_owned_space_type, is_inline_space_dir};
    use crate::index::IndexKey;
    use crate::space::types::AssetsStrategy;
    use crate::space::types::SpaceGitType;
    use std::path::Path;

    fn write_config(dir: &Path, strategy: &str) {
        std::fs::create_dir_all(dir.join(".svode")).expect("svode dir");
        std::fs::write(
            dir.join(".svode").join("config.json"),
            format!(
                r#"{{
                    "name": "Scope",
                    "assets": {{ "strategy": "{strategy}" }}
                }}"#
            ),
        )
        .expect("config");
    }

    fn child_scope(project: &Path) -> AssetsStorageScope {
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };
        build_effective_storage_scope(project, key, project.join("child")).expect("scope")
    }

    #[test]
    fn inline_space_dir_has_no_git_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let space = temp.path().join("notes");
        std::fs::create_dir_all(&space).expect("space dir");

        assert!(is_inline_space_dir(&space));
    }

    #[test]
    fn repo_owned_space_dir_has_git_entry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let space = temp.path().join("notes");
        std::fs::create_dir_all(space.join(".git")).expect("git dir");

        assert!(!is_inline_space_dir(&space));
    }

    #[test]
    fn repo_owned_space_type_detects_submodule_from_gitmodules() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path();
        let space = project.join("docs");
        std::fs::create_dir_all(space.join(".git")).expect("git dir");
        std::fs::write(
            project.join(".gitmodules"),
            "[submodule \"docs\"]\n\tpath = docs\n\turl = https://example.test/docs.git\n",
        )
        .expect("gitmodules");

        assert_eq!(
            detect_repo_owned_space_type(project, &space),
            SpaceGitType::Submodule
        );
    }

    #[test]
    fn effective_scope_ignores_stale_inline_child_assets_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("Project");
        let child = project.join("child");
        std::fs::create_dir_all(&child).expect("child dir");
        write_config(&project, "in-git");
        write_config(&child, "lfs-s3");

        let scope = child_scope(&project);

        assert!(scope.inherited_from_project);
        assert_eq!(scope.pool_key, IndexKey::Root(project.to_path_buf()));
        assert_eq!(scope.config.strategy, AssetsStrategy::InGit);
        assert_eq!(scope.default_s3_prefix, "project/root");
        assert_eq!(scope.git_type, Some(SpaceGitType::Inline));
    }

    #[test]
    fn effective_scope_uses_repo_owned_child_assets_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("Project");
        let child = project.join("child");
        std::fs::create_dir_all(child.join(".git")).expect("git dir");
        write_config(&project, "in-git");
        write_config(&child, "lfs-remote");

        let scope = child_scope(&project);

        assert!(!scope.inherited_from_project);
        assert_eq!(
            scope.pool_key,
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "child-space".to_string()
            }
        );
        assert_eq!(scope.config.strategy, AssetsStrategy::LfsRemote);
        assert_eq!(scope.default_s3_prefix, "project/child");
        assert_eq!(scope.git_type, Some(SpaceGitType::Independent));
    }
}
