//! Desktop view of the effective assets scope: the shared resolution rule plus
//! the default S3 prefix the storage settings surface presents.

use std::path::{Path, PathBuf};

use super::s3;
use crate::error::AppError;
use crate::index::{IndexKey, IndexState};
use crate::space::config::read_space_config;
use crate::space::types::AssetsSpaceConfig;
use svode_core::storage::scope::{self as core_scope, AssetsScope};

#[derive(Debug, Clone)]
pub struct AssetsStorageScope {
    pub pool_key: IndexKey,
    pub pool_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub config_dir: PathBuf,
    pub config: AssetsSpaceConfig,
    pub default_s3_prefix: String,
    pub inherited_from_project: bool,
}

pub async fn resolve_effective_storage_scope(
    index_state: &IndexState,
    project: &Path,
    space_id: Option<&str>,
) -> Result<AssetsStorageScope, AppError> {
    let scope = core_scope::resolve_assets_scope(&index_state.core, project, space_id).await?;
    Ok(with_default_s3_prefix(project, scope))
}

pub async fn resolve_effective_storage_scope_for_key(
    index_state: &IndexState,
    project: &Path,
    requested_key: IndexKey,
) -> Result<AssetsStorageScope, AppError> {
    let scope =
        core_scope::resolve_assets_scope_for_key(&index_state.core, project, requested_key).await?;
    Ok(with_default_s3_prefix(project, scope))
}

fn with_default_s3_prefix(project: &Path, scope: AssetsScope) -> AssetsStorageScope {
    let project_name = read_space_config(project).ok().map(|config| config.name);
    let default_s3_prefix =
        if matches!(&scope.pool_key, IndexKey::Root(_)) || scope.inherited_from_project {
            s3::default_root_prefix(project, project_name.as_deref())
        } else {
            s3::default_repo_space_prefix(project, project_name.as_deref(), &scope.repo_dir)
        };

    AssetsStorageScope {
        pool_key: scope.pool_key,
        pool_dir: scope.pool_dir,
        repo_dir: scope.repo_dir,
        config_dir: scope.config_dir,
        config: scope.config,
        default_s3_prefix,
        inherited_from_project: scope.inherited_from_project,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_effective_storage_scope;
    use crate::index::IndexState;
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

    #[tokio::test]
    async fn root_scope_uses_the_project_default_s3_prefix() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("Project");
        std::fs::create_dir_all(&project).expect("project dir");
        write_config(&project, "lfs-s3");

        let scope = resolve_effective_storage_scope(&IndexState::new(), &project, None)
            .await
            .expect("scope");

        assert_eq!(scope.default_s3_prefix, "project/root");
        assert_eq!(scope.repo_dir, project);
    }
}
