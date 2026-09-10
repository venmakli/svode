use super::*;
use serde_json::{Value, json};
use svode_core::variables::{AppBindings, files, normalize_app_bindings};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registry {
    pub bindings: AppBindings,
    #[serde(default)]
    pub usage: BTreeMap<String, Usage>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Usage {
    pub owner_directory: String,
    pub scope: VariableScope,
    pub references: Vec<String>,
    pub sources: BTreeMap<String, SourceReference>,
}

pub(super) fn prepare_context(
    config: &Path,
    context: &AppVariableOwnerContext,
    secrets: &dyn SecretStore,
) -> Result<AppVariableOwnerContext, AppError> {
    read(config)?;
    let scope_owner = owner(config, Some(&context.scope), &context.scope.owner())?;
    let copy_id = Service::new(secrets)
        .local_identity(&scope_owner)
        .map_err(storage_error)?;
    let scope_path =
        crate::system_path::user_facing_path(scope_owner.scope_path().map_err(storage_error)?);
    let relative = Path::new(&context.owner_directory)
        .strip_prefix(&scope_path)
        .map_err(|_| storage_error(core::Error::InvalidOwner))?;
    let mut prepared = context.clone();
    prepared.owner_key = format!("{copy_id}:{}", relative.to_string_lossy());
    update(config, |registry| {
        if let Some(legacy) = registry.bindings.owners.remove(&context.owner_directory) {
            let bindings = registry
                .bindings
                .owners
                .entry(prepared.owner_key.clone())
                .or_default();
            for (name, source) in legacy {
                bindings.entry(name).or_insert(source);
            }
        }
        Ok(())
    })?;
    Ok(prepared)
}

pub(super) fn read(config: &Path) -> Result<Registry, AppError> {
    update(config, |_| Ok(()))
}

pub(super) fn update(
    config: &Path,
    change: impl FnOnce(&mut Registry) -> Result<(), AppError>,
) -> Result<Registry, AppError> {
    let _guard = files::lock(config).map_err(storage_error)?;
    files::check_pending(config).map_err(storage_error)?;
    let path = config.join("settings.json");
    let mut root = files::read(&path, false).map_err(storage_error)?;
    let before = root.clone();
    let mut registry: Registry = root
        .get("appVariableRegistry")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    registry.bindings = normalize_app_bindings(
        root.get("variables").unwrap_or(&json!({})),
        Some(registry.bindings),
    )
    .map_err(storage_error)?;
    change(&mut registry)?;
    root["appVariableRegistry"] = serde_json::to_value(&registry)?;
    // The original snapshot is consumed once; new usage never enters the legacy registry.
    if let Some(variables) = root.get_mut("variables").and_then(Value::as_object_mut) {
        variables.remove("apps");
    }
    if root != before {
        files::atomic_write(&path, &root).map_err(storage_error)?;
    }
    Ok(registry)
}

pub(super) fn revision(registry: &Registry) -> String {
    files::digest(&serde_json::to_value(&registry.bindings).expect("bindings"))
}

pub(super) fn sync(
    config: &Path,
    context: &AppVariableOwnerContext,
    sources: BTreeMap<String, SourceReference>,
) -> Result<bool, AppError> {
    let previous = read(config)?;
    let before = serde_json::to_value(&previous)?;
    let next = update(config, |registry| {
        registry.usage.insert(
            context.owner_key.clone(),
            Usage {
                owner_directory: context.owner_directory.clone(),
                scope: context.scope.clone(),
                references: context.references.clone(),
                sources,
            },
        );
        if let Some(bindings) = registry.bindings.owners.get_mut(&context.owner_key) {
            bindings.retain(|name, _| context.references.contains(name));
        }
        Ok(())
    })?;
    Ok(before != serde_json::to_value(next)?)
}
