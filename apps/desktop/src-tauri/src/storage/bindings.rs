use std::path::{Path, PathBuf};

use serde::Serialize;
use svode_core::storage::s3::{AgentConfig, SecretBindings};
use tauri::{AppHandle, Manager, State};

use crate::AppError;
use crate::commands::app_variables::run_locked;
use crate::index::IndexState;
use crate::space::app_variables::{self, KeyringSecretStore, SecretStore};
use crate::space::settings::AppSettingsState;
use crate::space::types::AssetsS3Config;

pub(crate) fn prepare(
    catalog_dir: &Path,
    scope: &crate::space::app_variables::VariableScope,
    target: &AssetsS3Config,
    bindings: SecretBindings,
    secrets: &dyn SecretStore,
) -> Result<AgentConfig, AppError> {
    let config = AgentConfig {
        version: 2,
        endpoint: target.endpoint.clone(),
        bucket: target.bucket.clone(),
        region: target.region.clone(),
        prefix: Some(target.prefix.clone()),
        bindings,
        library_directory: catalog_dir.to_path_buf(),
        project_path: Some(PathBuf::from(&scope.project_path)),
        space_id: scope.space_id.clone(),
    };
    config
        .resolve_with_store(secrets)
        .map_err(AppError::Storage)?;
    Ok(config)
}

pub(crate) fn publish(
    catalog_dir: &Path,
    repo: &Path,
    config: &AgentConfig,
    secrets: &dyn SecretStore,
) -> Result<(), AppError> {
    config
        .resolve_with_store(secrets)
        .map_err(AppError::Storage)?;
    // Usage stores only the owner location. Both roles are always read from
    // the single atomically published agent config, including after a failure.
    app_variables::register_s3_owner(catalog_dir, repo)?;
    config.write(repo).map_err(AppError::Storage)
}

pub(crate) fn saved_config(repo: &Path, target: &AssetsS3Config) -> Result<AgentConfig, AppError> {
    let config = AgentConfig::read(repo).map_err(AppError::Storage)?;
    if config.endpoint != target.endpoint
        || config.bucket != target.bucket
        || config.region != target.region
        || config.prefix.as_deref() != Some(target.prefix.as_str())
    {
        return Err(AppError::Storage(
            svode_core::storage::s3::SETUP_REQUIRED.into(),
        ));
    }
    Ok(config)
}

pub(crate) fn resolve_saved(repo: &Path, target: &AssetsS3Config) -> Result<(), AppError> {
    saved_config(repo, target)?
        .resolve()
        .map_err(AppError::Storage)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct S3BindingState {
    bindings: Option<SecretBindings>,
    ready: bool,
    error: Option<String>,
}

#[tauri::command]
pub(crate) async fn get_s3_bindings(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
    state: State<'_, AppSettingsState>,
) -> Result<S3BindingState, AppError> {
    let scope = super::scope::resolve_effective_storage_scope(
        &index_state,
        Path::new(&project_path),
        space_id.as_deref(),
    )
    .await?;
    run_locked(&state, move || {
        let config = scope
            .config
            .s3
            .as_ref()
            .ok_or_else(|| AppError::Storage(svode_core::storage::s3::SETUP_REQUIRED.into()))
            .and_then(|target| saved_config(&scope.repo_dir, target));
        let (bindings, result) = match config {
            Ok(config) => (
                Some(config.bindings.clone()),
                config.resolve().map(|_| ()).map_err(AppError::Storage),
            ),
            Err(error) => (None, Err(error)),
        };
        Ok(S3BindingState {
            bindings,
            ready: result.is_ok(),
            error: result.err().map(|e| e.to_string()),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn check_s3_bindings(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    target: AssetsS3Config,
    bindings: SecretBindings,
    index_state: State<'_, IndexState>,
    state: State<'_, AppSettingsState>,
) -> Result<bool, AppError> {
    let scope = super::scope::resolve_effective_storage_scope(
        &index_state,
        Path::new(&project_path),
        space_id.as_deref(),
    )
    .await?;
    if scope.inherited_from_project {
        return Err(AppError::StrategyInherited);
    }
    let catalog_dir = catalog_dir(&app)?;
    let variable_scope = crate::space::app_variables::VariableScope {
        project_path,
        space_id,
    };
    let draft_target = target.clone();
    let credentials = run_locked(&state, move || {
        prepare(
            &catalog_dir,
            &variable_scope,
            &draft_target,
            bindings,
            &KeyringSecretStore,
        )?
        .resolve_with_store(&KeyringSecretStore)
        .map_err(AppError::Storage)
    })
    .await?;
    super::s3::check_connection(
        target.endpoint,
        target.bucket,
        target.region,
        credentials.access_key,
        credentials.secret_key,
    )
    .await
}

pub(crate) fn catalog_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::app_variables::{AppVariableKind, AppVariableOwnerContext, VariableScope};
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use svode_core::variables::{
        self as variables, Mode, Owner, Save, Service, SourceOwner, SourceReference,
    };

    #[derive(Default)]
    struct Secrets(Mutex<BTreeMap<String, String>>);
    impl SecretStore for Secrets {
        fn get(&self, name: &str) -> variables::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> variables::Result<()> {
            self.0.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn remove(&self, name: &str) -> variables::Result<()> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn upsert(
        config: &Path,
        name: &str,
        kind: AppVariableKind,
        value: Option<&str>,
        secrets: &dyn SecretStore,
    ) -> Result<(), AppError> {
        let owner = Owner::library(config).unwrap();
        let service = Service::new(secrets);
        let catalog = service.catalog(&owner).unwrap();
        service
            .save(
                &owner,
                Save {
                    name: name.into(),
                    mode: Mode::Local,
                    kind,
                    value: value.map(str::to_string),
                    identity: catalog
                        .entries
                        .iter()
                        .find(|e| e.name == name)
                        .map(|e| e.identity.clone()),
                    revision: catalog.revision,
                    keep: None,
                },
            )
            .map(|_| ())
            .map_err(app_variables::storage_error)
    }
    fn remove(config: &Path, name: &str, secrets: &dyn SecretStore) -> Result<(), AppError> {
        let owner = Owner::library(config).unwrap();
        let service = Service::new(secrets);
        let catalog = service.catalog(&owner).unwrap();
        let entry = catalog.entries.iter().find(|e| e.name == name).unwrap();
        service
            .remove(&owner, name, &entry.identity, &catalog.revision)
            .map(|_| ())
            .map_err(app_variables::storage_error)
    }
    fn target() -> AssetsS3Config {
        AssetsS3Config {
            endpoint: "https://s3.test".into(),
            bucket: "bucket".into(),
            region: "region".into(),
            prefix: "original/objects".into(),
        }
    }

    fn library(name: &str) -> SourceReference {
        SourceReference {
            owner: SourceOwner::Library,
            name: name.into(),
        }
    }
    fn prepare(
        config: &Path,
        target: &AssetsS3Config,
        bindings: SecretBindings,
        secrets: &dyn SecretStore,
    ) -> Result<AgentConfig, AppError> {
        let project = config.join("project");
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        let path = project.join(".svode/config.json");
        if !path.exists() {
            std::fs::write(path, "{}").unwrap();
        }
        super::prepare(
            config,
            &VariableScope {
                project_path: project.to_str().unwrap().into(),
                space_id: None,
            },
            target,
            bindings,
            secrets,
        )
    }
    fn pair() -> SecretBindings {
        SecretBindings {
            access_key: library("ACCESS"),
            secret_key: library("SECRET"),
        }
    }

    fn enroll(dir: &Path, secrets: &Secrets) {
        for (_, name) in pair().roles() {
            upsert(
                dir,
                &name.name,
                AppVariableKind::Secret,
                Some("private-value"),
                secrets,
            )
            .unwrap();
        }
    }

    #[test]
    fn s3_and_apps_share_catalog_values_but_not_owner_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::default();
        enroll(dir.path(), &secrets);
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::write(project.join(".svode/config.json"), "{}").unwrap();
        let project = project.canonicalize().unwrap();
        std::fs::create_dir_all(project.join("app")).unwrap();
        let app = AppVariableOwnerContext {
            scope: VariableScope {
                project_path: project.to_str().unwrap().into(),
                space_id: None,
            },
            owner_key: project.join("app").to_str().unwrap().into(),
            owner_directory: project.join("app").to_str().unwrap().into(),
            references: vec!["TOKEN".into()],
        };
        let catalog =
            app_variables::get_catalog(dir.path(), Some(&app.scope), Some(&app), &secrets).unwrap();
        app_variables::bind(
            dir.path(),
            &app,
            "TOKEN",
            Some(SourceReference {
                owner: SourceOwner::Library,
                name: "SECRET".into(),
            }),
            &catalog.binding_revision,
            &secrets,
        )
        .unwrap();
        let cfg = prepare(dir.path(), &target(), pair(), &secrets).unwrap();
        let root = dir.path().join("project");
        let repo = root.join("repo-space");
        publish(dir.path(), &root, &cfg, &secrets).unwrap();
        publish(dir.path(), &repo, &cfg, &secrets).unwrap();
        let catalog =
            app_variables::get_catalog(dir.path(), Some(&app.scope), Some(&app), &secrets).unwrap();
        let secret = catalog
            .entries
            .iter()
            .find(|e| e.entry.name == "SECRET")
            .unwrap();
        assert_eq!(secret.used_in.len(), 3);
        assert!(secret.used_in.iter().any(|u| u.reference_name == "TOKEN"));
        assert_eq!(
            secret
                .used_in
                .iter()
                .filter(|u| u.reference_name == "S3 Secret Key")
                .count(),
            2
        );
        assert!(
            !serde_json::to_string(&catalog)
                .unwrap()
                .contains("private-value")
        );
        let declaration = BTreeMap::from([("TOKEN".into(), "Bearer ${TOKEN}".into())]);
        let env =
            app_variables::resolve_environment(dir.path(), &app, &declaration, &secrets).unwrap();
        assert_eq!(env.environment["TOKEN"], "Bearer private-value");
        assert!(
            app_variables::bind(
                dir.path(),
                &app,
                "S3 Secret Key",
                Some(SourceReference {
                    owner: SourceOwner::Library,
                    name: "SECRET".into()
                }),
                &catalog.binding_revision,
                &secrets
            )
            .is_err()
        );
        let settings = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(!settings.contains("private-value"));
        let clone = dir.path().join("clone");
        assert!(saved_config(&clone, &target()).is_err());
    }

    #[test]
    fn rotation_removal_kind_change_and_recovery_match_agent_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::default();
        enroll(dir.path(), &secrets);
        let cfg = prepare(dir.path(), &target(), pair(), &secrets).unwrap();
        let repo = dir.path().join("repo");
        publish(dir.path(), &repo, &cfg, &secrets).unwrap();
        for value in ["first", "rotated"] {
            upsert(
                dir.path(),
                "SECRET",
                AppVariableKind::Secret,
                Some(value),
                &secrets,
            )
            .unwrap();
            let desktop = cfg.resolve_with_store(&secrets).unwrap();
            let agent = AgentConfig::read(&repo)
                .unwrap()
                .resolve_with_store(&secrets)
                .unwrap();
            assert_eq!(desktop.secret_key, value);
            assert_eq!(desktop.secret_key, agent.secret_key);
        }
        remove(dir.path(), "SECRET", &secrets).unwrap();
        assert!(cfg.resolve_with_store(&secrets).is_err());
        // Even an orphaned Keychain value must not make a removed entry usable.
        secrets.set("SECRET", "orphan").unwrap();
        assert!(cfg.resolve_with_store(&secrets).is_err());
        upsert(
            dir.path(),
            "SECRET",
            AppVariableKind::Variable,
            Some("plain"),
            &secrets,
        )
        .unwrap();
        assert!(prepare(dir.path(), &target(), pair(), &secrets).is_err());
        assert!(cfg.resolve_with_store(&secrets).is_err());
        upsert(
            dir.path(),
            "SECRET",
            AppVariableKind::Secret,
            Some("recovered"),
            &secrets,
        )
        .unwrap();
        assert_eq!(
            cfg.resolve_with_store(&secrets).unwrap().secret_key,
            "recovered"
        );
    }

    #[test]
    fn scoped_usage_and_resolution_do_not_leak_between_projects() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::default();
        for project_name in ["first", "second"] {
            let project = dir.path().join(project_name);
            std::fs::create_dir_all(project.join(".svode")).unwrap();
            std::fs::write(project.join(".svode/config.json"), "{}").unwrap();
            let scope = VariableScope {
                project_path: project.to_str().unwrap().into(),
                space_id: None,
            };
            let context = scope.context(dir.path()).unwrap();
            let owner = Owner::in_context(&context, &SourceOwner::Project).unwrap();
            let service = Service::new(&secrets);
            service
                .save(
                    &owner,
                    Save {
                        name: "KEY".into(),
                        mode: Mode::Git,
                        kind: AppVariableKind::Secret,
                        value: Some(project_name.into()),
                        revision: service.catalog(&owner).unwrap().revision,
                        identity: None,
                        keep: None,
                    },
                )
                .unwrap();
            let source = SourceReference {
                owner: SourceOwner::Project,
                name: "KEY".into(),
            };
            let config = super::prepare(
                dir.path(),
                &scope,
                &target(),
                SecretBindings {
                    access_key: source.clone(),
                    secret_key: source,
                },
                &secrets,
            )
            .unwrap();
            publish(dir.path(), &project, &config, &secrets).unwrap();
            assert_eq!(
                AgentConfig::read(&project)
                    .unwrap()
                    .resolve_with_store(&secrets)
                    .unwrap()
                    .access_key,
                project_name
            );
        }
        for project_name in ["first", "second"] {
            let scope = VariableScope {
                project_path: dir.path().join(project_name).to_str().unwrap().into(),
                space_id: None,
            };
            let catalog =
                app_variables::get_catalog(dir.path(), Some(&scope), None, &secrets).unwrap();
            let entry = catalog
                .entries
                .iter()
                .find(|e| e.entry.name == "KEY")
                .unwrap();
            assert_eq!(entry.used_in.len(), 2);
            assert!(
                entry
                    .used_in
                    .iter()
                    .all(|usage| usage.owner_directory.ends_with(project_name))
            );
        }
    }

    #[test]
    fn failed_save_preserves_pair_and_usage_and_retry_reuses_entries() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::default();
        enroll(dir.path(), &secrets);
        let repo = dir.path().join("repo");
        let original = prepare(dir.path(), &target(), pair(), &secrets).unwrap();
        publish(dir.path(), &repo, &original, &secrets).unwrap();
        upsert(
            dir.path(),
            "OTHER",
            AppVariableKind::Secret,
            Some("other"),
            &secrets,
        )
        .unwrap();
        let next = prepare(
            dir.path(),
            &target(),
            SecretBindings {
                access_key: library("ACCESS"),
                secret_key: library("OTHER"),
            },
            &secrets,
        )
        .unwrap();
        secrets.remove("OTHER").unwrap();
        assert!(publish(dir.path(), &repo, &next, &secrets).is_err());
        assert_eq!(AgentConfig::read(&repo).unwrap(), original);
        let catalog = app_variables::get_catalog(dir.path(), None, None, &secrets).unwrap();
        assert!(
            catalog
                .entries
                .iter()
                .find(|e| e.entry.name == "OTHER")
                .unwrap()
                .used_in
                .is_empty()
        );
        secrets.set("OTHER", "other").unwrap();
        publish(dir.path(), &repo, &next, &secrets).unwrap();
        let catalog = app_variables::get_catalog(dir.path(), None, None, &secrets).unwrap();
        assert_eq!(catalog.entries.len(), 3);
        assert!(
            catalog
                .entries
                .iter()
                .find(|e| e.entry.name == "SECRET")
                .unwrap()
                .used_in
                .is_empty()
        );
        assert_eq!(
            AgentConfig::read(&repo).unwrap().bindings.secret_key.name,
            "OTHER"
        );
        let mut changed_target = target();
        changed_target.bucket = "other-bucket".into();
        assert!(saved_config(&repo, &changed_target).is_err());
        changed_target = target();
        changed_target.prefix = "new-prefix".into();
        let next = prepare(dir.path(), &changed_target, next.bindings, &secrets).unwrap();
        publish(dir.path(), &repo, &next, &secrets).unwrap();
        assert_eq!(
            saved_config(&repo, &changed_target)
                .unwrap()
                .bindings
                .secret_key
                .name,
            "OTHER"
        );
    }
}
