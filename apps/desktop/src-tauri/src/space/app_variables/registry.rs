use super::*;
use serde_json::Value;
use svode_core::variables::files;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registry {
    pub bindings: AppBindings,
    #[serde(default)]
    pub usage: BTreeMap<String, Usage>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Usage {
    pub owner_directory: String,
    pub scope: VariableScope,
    pub references: Vec<String>,
    pub sources: BTreeMap<String, SourceReference>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AppBindings {
    pub version: u32,
    pub owners: BTreeMap<String, BTreeMap<String, SourceReference>>,
}
impl Default for AppBindings {
    fn default() -> Self {
        Self {
            version: 2,
            owners: BTreeMap::new(),
        }
    }
}

pub(super) fn prepare_context(
    config: &Path,
    context: &AppVariableOwnerContext,
) -> Result<AppVariableOwnerContext, AppError> {
    read(config)?;
    let project = crate::space::registry::find_project_by_path(
        config,
        Path::new(&context.scope.project_path),
    )?;
    let scope_owner = owner(config, Some(&context.scope), &context.scope.owner())?;
    let scope_path = scope_owner
        .scope_path()
        .map_err(storage_error)?
        .canonicalize()?;
    let app_path = Path::new(&context.owner_directory).canonicalize()?;
    let relative = app_path
        .strip_prefix(&scope_path)
        .map_err(|_| storage_error(core::Error::InvalidOwner))?;
    let mut prepared = context.clone();
    prepared.owner_key = serde_json::to_string(&(project.id, &context.scope.space_id, relative))?;
    Ok(prepared)
}

fn decode(root: &Value) -> Result<Registry, AppError> {
    let registry: Registry = root
        .get("appVariableRegistry")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| storage_error(core::Error::InvalidConfig))?
        .unwrap_or_default();
    if registry.bindings.version != 2 {
        return Err(storage_error(core::Error::UnsupportedVersion));
    }
    Ok(registry)
}

pub(super) fn read(config: &Path) -> Result<Registry, AppError> {
    let _guard = files::lock(config).map_err(storage_error)?;
    files::check_pending(config).map_err(storage_error)?;
    decode(&files::read(&config.join("settings.json"), false).map_err(storage_error)?)
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
    let mut registry = decode(&root)?;
    change(&mut registry)?;
    root["appVariableRegistry"] = serde_json::to_value(&registry)?;
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
