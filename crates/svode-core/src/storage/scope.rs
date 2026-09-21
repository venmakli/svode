//! Effective assets scope of a Space: which directory owns the repository and
//! which assets configuration actually applies.
//!
//! An inline child Space has no repository of its own, so it inherits the
//! Project pool, repository and assets configuration; a repo-owned child Space
//! keeps its own.

use std::path::{Path, PathBuf};

use crate::index::IndexError;
use crate::index::IndexKey;
use crate::index::state::IndexRuntimeState;

use super::config::{AssetsSpaceConfig, StorageConfigError, read_space_assets_config};

#[derive(Debug, thiserror::Error)]
pub enum AssetsScopeError {
    #[error(transparent)]
    Config(#[from] StorageConfigError),
    #[error(transparent)]
    Index(#[from] IndexError),
}

/// The assets facts a storage consumer needs for one requested Space.
#[derive(Debug, Clone)]
pub struct AssetsScope {
    pub pool_key: IndexKey,
    pub pool_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub config_dir: PathBuf,
    pub config: AssetsSpaceConfig,
    pub inherited_from_project: bool,
}

pub async fn resolve_assets_scope(
    index: &IndexRuntimeState,
    project: &Path,
    space_id: Option<&str>,
) -> Result<AssetsScope, AssetsScopeError> {
    let requested_key = index.key_for_project_space_id(project, space_id).await?;
    resolve_assets_scope_for_key(index, project, requested_key).await
}

pub async fn resolve_assets_scope_for_key(
    index: &IndexRuntimeState,
    project: &Path,
    requested_key: IndexKey,
) -> Result<AssetsScope, AssetsScopeError> {
    let requested_dir = index.dir_for_key(&requested_key).await?;
    Ok(build_assets_scope(project, requested_key, requested_dir)?)
}

fn build_assets_scope(
    project: &Path,
    requested_key: IndexKey,
    requested_dir: PathBuf,
) -> Result<AssetsScope, StorageConfigError> {
    let (pool_key, pool_dir, repo_dir, config_dir, inherited_from_project) = match &requested_key {
        IndexKey::Root(project_dir) => (
            requested_key.clone(),
            project_dir.clone(),
            project_dir.clone(),
            project_dir.clone(),
            false,
        ),
        IndexKey::Space { .. } if is_inline_space_dir(&requested_dir) => {
            let root_key = IndexKey::Root(project.to_path_buf());
            (
                root_key,
                project.to_path_buf(),
                project.to_path_buf(),
                project.to_path_buf(),
                true,
            )
        }
        IndexKey::Space { .. } => (
            requested_key.clone(),
            requested_dir.clone(),
            requested_dir.clone(),
            requested_dir.clone(),
            false,
        ),
    };

    let owner_config = read_space_assets_config(&config_dir)?;

    Ok(AssetsScope {
        pool_key,
        pool_dir,
        repo_dir,
        config_dir,
        config: owner_config.assets.unwrap_or_default(),
        inherited_from_project,
    })
}

fn is_inline_space_dir(space_dir: &Path) -> bool {
    space_dir.join(".git").symlink_metadata().is_err()
}

#[cfg(test)]
mod tests {
    use super::{AssetsScope, build_assets_scope, is_inline_space_dir};
    use crate::index::IndexKey;
    use crate::storage::config::AssetsStrategy;
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

    fn child_scope(project: &Path) -> AssetsScope {
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };
        build_assets_scope(project, key, project.join("child")).expect("scope")
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
    }
}
