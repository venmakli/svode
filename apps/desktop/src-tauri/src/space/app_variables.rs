use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::AppError;
use crate::apps::environment;

use super::settings::{
    default_app_settings_value, read_app_settings_value, write_app_settings_value,
};

const KEYCHAIN_SERVICE: &str = "app.svode.desktop.variables";
const SETTINGS_KEY: &str = "variables";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppVariableKind {
    Variable,
    Secret,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableContextInput {
    pub project_path: String,
    pub space_id: Option<String>,
    pub owner_path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AppVariableOwnerContext {
    pub owner_key: String,
    pub owner_directory: String,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableUsage {
    pub owner_directory: String,
    pub reference_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableEntry {
    pub name: String,
    pub kind: AppVariableKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub has_value: bool,
    pub used_in: Vec<AppVariableUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableReference {
    pub reference_name: String,
    pub entry_name: String,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<AppVariableKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariablesCatalog {
    pub entries: Vec<AppVariableEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<AppVariableReference>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissingAppVariable {
    pub reference_name: String,
    pub entry_name: String,
}

pub(crate) struct ResolvedAppEnvironment {
    pub environment: BTreeMap<String, String>,
    pub missing: Vec<MissingAppVariable>,
    pub usage_changed: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredVariables {
    #[serde(default)]
    entries: BTreeMap<String, StoredVariable>,
    #[serde(default)]
    apps: BTreeMap<String, StoredAppUsage>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct StoredVariable {
    kind: AppVariableKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredAppUsage {
    owner_directory: String,
    #[serde(default)]
    references: Vec<String>,
    #[serde(default)]
    bindings: BTreeMap<String, String>,
}

pub(crate) trait SecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, AppError>;
    fn set(&self, name: &str, value: &str) -> Result<(), AppError>;
    fn remove(&self, name: &str) -> Result<(), AppError>;
}

pub(crate) struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, AppError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|error| {
            AppError::Storage(format!("Cannot access variable secret: {error}"))
        })?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AppError::Storage(format!(
                "Cannot read variable secret: {error}"
            ))),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), AppError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, name)
            .and_then(|entry| entry.set_password(value))
            .map_err(|error| AppError::Storage(format!("Cannot save variable secret: {error}")))
    }

    fn remove(&self, name: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|error| {
            AppError::Storage(format!("Cannot access variable secret: {error}"))
        })?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AppError::Storage(format!(
                "Cannot remove variable secret: {error}"
            ))),
        }
    }
}

pub(crate) fn get_catalog(
    config_dir: &Path,
    context: Option<&AppVariableOwnerContext>,
    secrets: &dyn SecretStore,
) -> Result<AppVariablesCatalog, AppError> {
    let (mut root, mut stored) = read(config_dir)?;
    if context.is_some_and(|context| sync_usage(&mut stored, context)) {
        write(config_dir, &mut root, &stored)?;
    }
    project_catalog(&stored, context, secrets)
}

pub(crate) fn clear_owner_usage(config_dir: &Path, owner_key: &str) -> Result<bool, AppError> {
    let (mut root, mut stored) = read(config_dir)?;
    let changed = stored.apps.remove(owner_key).is_some();
    if changed {
        write(config_dir, &mut root, &stored)?;
    }
    Ok(changed)
}

pub(crate) fn upsert(
    config_dir: &Path,
    name: &str,
    kind: AppVariableKind,
    value: Option<&str>,
    secrets: &dyn SecretStore,
) -> Result<(), AppError> {
    validate_name(name)?;
    let (mut root, mut stored) = read(config_dir)?;
    let previous = stored.entries.get(name).cloned();
    match kind {
        AppVariableKind::Variable => {
            let value = value
                .ok_or_else(|| AppError::General("A Variable value is required".to_string()))?;
            stored.entries.insert(
                name.to_string(),
                StoredVariable {
                    kind,
                    value: Some(value.to_string()),
                },
            );
            write(config_dir, &mut root, &stored)?;
            if matches!(
                previous,
                Some(StoredVariable {
                    kind: AppVariableKind::Secret,
                    ..
                })
            ) {
                secrets.remove(name)?;
            }
        }
        AppVariableKind::Secret => {
            let already_has_secret = secrets.get(name)?.is_some();
            let secret = value.filter(|value| !value.is_empty());
            if secret.is_none() && !already_has_secret {
                return Err(AppError::General("A Secret value is required".to_string()));
            }
            if let Some(secret) = secret {
                secrets.set(name, secret)?;
            }
            stored
                .entries
                .insert(name.to_string(), StoredVariable { kind, value: None });
            if let Err(error) = write(config_dir, &mut root, &stored) {
                if !already_has_secret {
                    let _ = secrets.remove(name);
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

pub(crate) fn remove(
    config_dir: &Path,
    name: &str,
    secrets: &dyn SecretStore,
) -> Result<(), AppError> {
    validate_name(name)?;
    let (mut root, mut stored) = read(config_dir)?;
    let removed = stored.entries.remove(name);
    write(config_dir, &mut root, &stored)?;
    if matches!(
        removed,
        Some(StoredVariable {
            kind: AppVariableKind::Secret,
            ..
        })
    ) {
        secrets.remove(name)?;
    }
    Ok(())
}

pub(crate) fn bind(
    config_dir: &Path,
    context: &AppVariableOwnerContext,
    reference_name: &str,
    entry_name: &str,
) -> Result<(), AppError> {
    validate_name(reference_name)?;
    validate_name(entry_name)?;
    let (mut root, mut stored) = read(config_dir)?;
    if !context.references.iter().any(|name| name == reference_name) {
        return Err(AppError::General(format!(
            "App does not declare variable reference {reference_name}"
        )));
    }
    if !stored.entries.contains_key(entry_name) {
        return Err(AppError::General(format!(
            "Variable entry does not exist: {entry_name}"
        )));
    }
    sync_usage(&mut stored, context);
    let usage = stored
        .apps
        .get_mut(&context.owner_key)
        .expect("usage synchronized");
    if reference_name == entry_name {
        usage.bindings.remove(reference_name);
    } else {
        usage
            .bindings
            .insert(reference_name.to_string(), entry_name.to_string());
    }
    write(config_dir, &mut root, &stored)
}

pub(crate) fn resolve_environment(
    config_dir: &Path,
    context: &AppVariableOwnerContext,
    declaration: &BTreeMap<String, String>,
    secrets: &dyn SecretStore,
) -> Result<ResolvedAppEnvironment, AppError> {
    let (mut root, mut stored) = read(config_dir)?;
    let usage_changed = sync_usage(&mut stored, context);
    if usage_changed {
        write(config_dir, &mut root, &stored)?;
    }
    let usage = stored.apps.get(&context.owner_key);
    let mut values = BTreeMap::new();
    let mut missing = Vec::new();
    for reference_name in &context.references {
        let entry_name = usage
            .and_then(|usage| usage.bindings.get(reference_name))
            .cloned()
            .unwrap_or_else(|| reference_name.clone());
        let value = match stored.entries.get(&entry_name) {
            Some(StoredVariable {
                kind: AppVariableKind::Variable,
                value,
            }) => value.clone(),
            Some(StoredVariable {
                kind: AppVariableKind::Secret,
                ..
            }) => secrets.get(&entry_name)?,
            None => None,
        };
        if let Some(value) = value {
            values.insert(reference_name.clone(), value);
        } else {
            missing.push(MissingAppVariable {
                reference_name: reference_name.clone(),
                entry_name,
            });
        }
    }
    let environment = if missing.is_empty() {
        environment::resolve(declaration, &values)
            .expect("all validated environment references were resolved")
    } else {
        BTreeMap::new()
    };
    Ok(ResolvedAppEnvironment {
        environment,
        missing,
        usage_changed,
    })
}

fn project_catalog(
    stored: &StoredVariables,
    context: Option<&AppVariableOwnerContext>,
    secrets: &dyn SecretStore,
) -> Result<AppVariablesCatalog, AppError> {
    let mut used_in: BTreeMap<&str, Vec<AppVariableUsage>> = BTreeMap::new();
    for usage in stored.apps.values() {
        for reference_name in &usage.references {
            let entry_name = usage
                .bindings
                .get(reference_name)
                .map(String::as_str)
                .unwrap_or(reference_name);
            used_in
                .entry(entry_name)
                .or_default()
                .push(AppVariableUsage {
                    owner_directory: usage.owner_directory.clone(),
                    reference_name: reference_name.clone(),
                });
        }
    }
    let mut entries = Vec::new();
    for (name, entry) in &stored.entries {
        let (value, has_value) = match entry.kind {
            AppVariableKind::Variable => (entry.value.clone(), entry.value.is_some()),
            AppVariableKind::Secret => (None, secrets.get(name)?.is_some()),
        };
        entries.push(AppVariableEntry {
            name: name.clone(),
            kind: entry.kind,
            value,
            has_value,
            used_in: used_in.remove(name.as_str()).unwrap_or_default(),
        });
    }
    let context = context.map(|context| {
        let usage = stored.apps.get(&context.owner_key);
        context
            .references
            .iter()
            .map(|reference_name| {
                let entry_name = usage
                    .and_then(|usage| usage.bindings.get(reference_name))
                    .cloned()
                    .unwrap_or_else(|| reference_name.clone());
                let entry = stored.entries.get(&entry_name);
                let resolved = match entry {
                    Some(StoredVariable {
                        kind: AppVariableKind::Variable,
                        value,
                    }) => value.is_some(),
                    Some(StoredVariable {
                        kind: AppVariableKind::Secret,
                        ..
                    }) => secrets.get(&entry_name).ok().flatten().is_some(),
                    None => false,
                };
                AppVariableReference {
                    reference_name: reference_name.clone(),
                    entry_name,
                    resolved,
                    kind: entry.map(|entry| entry.kind),
                }
            })
            .collect()
    });
    Ok(AppVariablesCatalog { entries, context })
}

fn sync_usage(stored: &mut StoredVariables, context: &AppVariableOwnerContext) -> bool {
    let references = context
        .references
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if references.is_empty() {
        return stored.apps.remove(&context.owner_key).is_some();
    }
    let usage = stored.apps.entry(context.owner_key.clone()).or_default();
    let previous = usage.clone();
    usage.owner_directory.clone_from(&context.owner_directory);
    usage.references = references;
    usage
        .bindings
        .retain(|reference, _| usage.references.contains(reference));
    *usage != previous
}

fn validate_name(name: &str) -> Result<(), AppError> {
    if environment::is_variable_name(name) {
        Ok(())
    } else {
        Err(AppError::General(
            "Variable names must match [A-Za-z_][A-Za-z0-9_]*".to_string(),
        ))
    }
}

fn read(config_dir: &Path) -> Result<(serde_json::Value, StoredVariables), AppError> {
    let root = read_app_settings_value(config_dir)?
        .map(Ok)
        .unwrap_or_else(default_app_settings_value)?;
    let stored = root
        .get(SETTINGS_KEY)
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    Ok((root, stored))
}

fn write(
    config_dir: &Path,
    root: &mut serde_json::Value,
    stored: &StoredVariables,
) -> Result<(), AppError> {
    let root = root
        .as_object_mut()
        .ok_or_else(|| AppError::General("app settings root must be an object".to_string()))?;
    root.insert(SETTINGS_KEY.to_string(), serde_json::to_value(stored)?);
    write_app_settings_value(config_dir, &serde_json::Value::Object(root.clone()))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tempfile::TempDir;

    use super::*;

    #[derive(Default)]
    struct MemorySecrets(Mutex<BTreeMap<String, String>>);

    impl SecretStore for MemorySecrets {
        fn get(&self, name: &str) -> Result<Option<String>, AppError> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }

        fn set(&self, name: &str, value: &str) -> Result<(), AppError> {
            self.0
                .lock()
                .unwrap()
                .insert(name.to_string(), value.to_string());
            Ok(())
        }

        fn remove(&self, name: &str) -> Result<(), AppError> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn context(references: &[&str]) -> AppVariableOwnerContext {
        AppVariableOwnerContext {
            owner_key: "/project/admin".to_string(),
            owner_directory: "/project/admin".to_string(),
            references: references.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn stores_plain_values_but_never_serializes_secret_values() {
        let directory = TempDir::new().unwrap();
        let secrets = MemorySecrets::default();
        upsert(
            directory.path(),
            "HOST",
            AppVariableKind::Variable,
            Some("localhost"),
            &secrets,
        )
        .unwrap();
        upsert(
            directory.path(),
            "TOKEN",
            AppVariableKind::Secret,
            Some("top-secret"),
            &secrets,
        )
        .unwrap();

        let source = std::fs::read_to_string(directory.path().join("settings.json")).unwrap();
        assert!(source.contains("localhost"));
        assert!(!source.contains("top-secret"));
        let catalog = get_catalog(directory.path(), None, &secrets).unwrap();
        assert_eq!(catalog.entries[1].value, None);
        assert!(catalog.entries[1].has_value);
    }

    #[test]
    fn resolves_bindings_tracks_usage_and_breaks_after_removal() {
        let directory = TempDir::new().unwrap();
        let secrets = MemorySecrets::default();
        upsert(
            directory.path(),
            "SHARED_TOKEN",
            AppVariableKind::Secret,
            Some("secret"),
            &secrets,
        )
        .unwrap();
        let context = context(&["TOKEN"]);
        bind(directory.path(), &context, "TOKEN", "SHARED_TOKEN").unwrap();
        let declaration = BTreeMap::from([("TOKEN".to_string(), "Bearer ${TOKEN}".to_string())]);

        let resolved =
            resolve_environment(directory.path(), &context, &declaration, &secrets).unwrap();
        assert_eq!(resolved.environment["TOKEN"], "Bearer secret");
        assert!(
            get_catalog(directory.path(), Some(&context), &secrets)
                .unwrap()
                .entries[0]
                .used_in
                .iter()
                .any(|usage| usage.reference_name == "TOKEN")
        );

        remove(directory.path(), "SHARED_TOKEN", &secrets).unwrap();
        let broken =
            resolve_environment(directory.path(), &context, &declaration, &secrets).unwrap();
        assert_eq!(broken.missing[0].entry_name, "SHARED_TOKEN");
        assert!(broken.environment.is_empty());
    }
}
