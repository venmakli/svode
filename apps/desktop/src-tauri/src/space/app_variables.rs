use crate::{AppError, apps::environment};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use svode_core::variables::{self as core, Context, Owner, Service, SourceOwner, SourceReference};

pub(crate) mod mutations;
mod registry;
pub(crate) use core::{KeyringSecretStore, Kind as AppVariableKind, SecretStore};

pub(crate) fn storage_error(error: core::Error) -> AppError {
    AppError::Storage(error.to_string())
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VariableScope {
    pub project_path: String,
    pub space_id: Option<String>,
}
impl VariableScope {
    pub fn context(&self, config: &Path) -> Result<Context, AppError> {
        Context::new(
            Path::new(&self.project_path),
            self.space_id.as_deref(),
            config,
        )
        .map_err(storage_error)
    }
    pub fn owner(&self) -> SourceOwner {
        self.space_id
            .as_ref()
            .map(|id| SourceOwner::Space { id: id.clone() })
            .unwrap_or(SourceOwner::Project)
    }
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
    pub scope: VariableScope,
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
    #[serde(flatten)]
    pub entry: core::Entry,
    pub source: SourceReference,
    pub revision: core::Revision,
    pub owner_label: String,
    pub collision: bool,
    pub inherited: bool,
    pub used_in: Vec<AppVariableUsage>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableReference {
    pub reference_name: String,
    pub entry_name: String,
    pub source: SourceReference,
    pub explicit: bool,
    pub resolved: bool,
    pub kind: Option<AppVariableKind>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogOwner {
    pub owner: SourceOwner,
    pub label: String,
    pub revision: Option<core::Revision>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariablesCatalog {
    pub entries: Vec<AppVariableEntry>,
    pub owners: Vec<CatalogOwner>,
    pub default_owner: SourceOwner,
    pub binding_revision: String,
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

pub(crate) fn owner(
    config: &Path,
    scope: Option<&VariableScope>,
    source: &SourceOwner,
) -> Result<Owner, AppError> {
    match scope {
        Some(scope) => Owner::in_context(&scope.context(config)?, source).map_err(storage_error),
        None if *source == SourceOwner::Global => Owner::global(config).map_err(storage_error),
        None => Err(storage_error(core::Error::InvalidOwner)),
    }
}

fn owner_label(scope: Option<&VariableScope>, source: &SourceOwner) -> String {
    match source {
        SourceOwner::Global => "Svode".into(),
        SourceOwner::Project => scope.map(|s| s.project_path.clone()).unwrap_or_default(),
        SourceOwner::Space { id } => scope
            .and_then(|s| {
                let root =
                    core::files::read(&Path::new(&s.project_path).join(".svode/config.json"), true)
                        .ok()?;
                let space = root
                    .get("spaces")?
                    .as_array()?
                    .iter()
                    .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id))?;
                space
                    .get("name")
                    .or_else(|| space.get("path"))?
                    .as_str()
                    .map(str::to_string)
            })
            .unwrap_or_else(|| id.clone()),
    }
}

pub(crate) fn get_catalog(
    config: &Path,
    scope: Option<&VariableScope>,
    context: Option<&AppVariableOwnerContext>,
    secrets: &dyn SecretStore,
) -> Result<AppVariablesCatalog, AppError> {
    read_catalog(config, scope, context, context.is_some(), secrets)
}

pub(crate) fn get_source_catalog(
    config: &Path,
    scope: Option<&VariableScope>,
    secrets: &dyn SecretStore,
) -> Result<AppVariablesCatalog, AppError> {
    read_catalog(config, scope, None, true, secrets)
}

fn read_catalog(
    config: &Path,
    scope: Option<&VariableScope>,
    context: Option<&AppVariableOwnerContext>,
    include_global: bool,
    secrets: &dyn SecretStore,
) -> Result<AppVariablesCatalog, AppError> {
    let prepared = context
        .map(|c| registry::prepare_context(config, c))
        .transpose()?;
    let context = prepared.as_ref();
    let registry = registry::read(config)?;
    if let Some(scope) = scope {
        scope.context(config)?;
    }
    let default_owner = scope
        .map(VariableScope::owner)
        .unwrap_or(SourceOwner::Global);
    let mut sources = vec![default_owner.clone()];
    if scope.is_some_and(|s| s.space_id.is_some()) {
        sources.push(SourceOwner::Project);
    }
    if include_global && default_owner != SourceOwner::Global {
        sources.push(SourceOwner::Global);
    }
    let service = Service::new(secrets);
    let mut entries = Vec::new();
    let mut owners = Vec::new();
    for source in sources {
        let label = owner_label(scope, &source);
        match owner(config, scope, &source).and_then(|o| service.catalog(&o).map_err(storage_error))
        {
            Ok(catalog) => {
                owners.push(CatalogOwner {
                    owner: source.clone(),
                    label: label.clone(),
                    revision: Some(catalog.revision.clone()),
                    error: None,
                });
                for entry in catalog.entries {
                    let reference = SourceReference {
                        owner: source.clone(),
                        name: entry.name.clone(),
                    };
                    let mut used_in = Vec::new();
                    for (app_key, usage) in &registry.usage {
                        if source != SourceOwner::Global
                            && scope.is_none_or(|s| s.project_path != usage.scope.project_path)
                        {
                            continue;
                        }
                        for (name, selected) in &usage.sources {
                            let selected = registry
                                .bindings
                                .owners
                                .get(app_key)
                                .and_then(|bindings| bindings.get(name))
                                .unwrap_or(selected);
                            if selected == &reference {
                                used_in.push(AppVariableUsage {
                                    owner_directory: usage.owner_directory.clone(),
                                    reference_name: name.clone(),
                                });
                            }
                        }
                    }
                    used_in.extend(s3_usage(config, scope, &reference)?);
                    entries.push(AppVariableEntry {
                        collision: catalog.collisions.contains(&entry.name),
                        entry,
                        source: reference,
                        revision: catalog.revision.clone(),
                        owner_label: label.clone(),
                        inherited: source != default_owner,
                        used_in,
                    });
                }
            }
            Err(error) => owners.push(CatalogOwner {
                owner: source,
                label,
                revision: None,
                error: Some(error.to_string()),
            }),
        }
    }
    let mut catalog = AppVariablesCatalog {
        entries,
        owners,
        default_owner,
        binding_revision: registry::revision(&registry),
        context: None,
    };
    if let Some(context) = context {
        let bindings = registry
            .bindings
            .owners
            .get(&context.owner_key)
            .cloned()
            .unwrap_or_default();
        let hierarchy = context.scope.context(config)?;
        let references: Vec<_> = context
            .references
            .iter()
            .map(|name| {
                let explicit = bindings.get(name);
                let selected = explicit
                    .cloned()
                    .or_else(|| {
                        catalog
                            .owners
                            .iter()
                            .find(|o| o.owner == context.scope.owner() && o.error.is_some())
                            .map(|o| SourceReference {
                                owner: o.owner.clone(),
                                name: name.clone(),
                            })
                    })
                    .or_else(|| {
                        catalog
                            .entries
                            .iter()
                            .find(|e| {
                                e.entry.name == *name && e.source.owner != SourceOwner::Global
                            })
                            .map(|e| e.source.clone())
                    })
                    .unwrap_or(SourceReference {
                        owner: context.scope.owner(),
                        name: name.clone(),
                    });
                let entry = catalog.entries.iter().find(|e| e.source == selected);
                let result = service.resolve(&hierarchy, std::slice::from_ref(name), &bindings);
                AppVariableReference {
                    reference_name: name.clone(),
                    entry_name: selected.name.clone(),
                    source: selected,
                    explicit: explicit.is_some(),
                    resolved: result.is_ok(),
                    kind: entry.map(|e| e.entry.kind),
                    error: result.err().map(|e| e.to_string()),
                }
            })
            .collect();
        let changed = registry::sync(
            config,
            context,
            references
                .iter()
                .map(|r| (r.reference_name.clone(), r.source.clone()))
                .collect(),
        )?;
        if changed
            && catalog
                .owners
                .iter()
                .any(|o| o.owner == SourceOwner::Global && o.error.is_none())
        {
            let revision = service
                .catalog(&Owner::global(config).map_err(storage_error)?)
                .map_err(storage_error)?
                .revision;
            for entry in &mut catalog.entries {
                if entry.source.owner == SourceOwner::Global {
                    entry.revision = revision.clone();
                }
            }
            for owner in &mut catalog.owners {
                if owner.owner == SourceOwner::Global {
                    owner.revision = Some(revision.clone());
                }
            }
        }
        // Include this read's current references before presenting shared-source impact.
        // The persisted usage snapshot may describe an older manifest or directory.
        for entry in &mut catalog.entries {
            entry.used_in.retain(|usage| {
                usage.owner_directory != context.owner_directory
                    && registry
                        .usage
                        .get(&context.owner_key)
                        .is_none_or(|previous| usage.owner_directory != previous.owner_directory)
            });
            entry.used_in.extend(
                references
                    .iter()
                    .filter(|r| r.source == entry.source)
                    .map(|r| AppVariableUsage {
                        owner_directory: context.owner_directory.clone(),
                        reference_name: r.reference_name.clone(),
                    }),
            );
        }
        catalog.context = Some(references);
        catalog.binding_revision = registry::revision(&registry::read(config)?);
    }
    Ok(catalog)
}

pub(crate) fn bind(
    config: &Path,
    context: &AppVariableOwnerContext,
    name: &str,
    source: Option<SourceReference>,
    revision: &str,
    secrets: &dyn SecretStore,
) -> Result<(), AppError> {
    let context = &registry::prepare_context(config, context)?;
    if !context.references.iter().any(|r| r == name) {
        return Err(storage_error(core::Error::InvalidName));
    }
    if let Some(source) = &source {
        let catalog = Service::new(secrets)
            .catalog(&owner(config, Some(&context.scope), &source.owner)?)
            .map_err(storage_error)?;
        if !catalog.entries.iter().any(|e| e.name == source.name)
            || catalog.collisions.contains(&source.name)
        {
            return Err(storage_error(core::Error::Missing));
        }
    }
    registry::update(config, |registry| {
        if registry::revision(registry) != revision {
            return Err(storage_error(core::Error::StaleRevision));
        }
        let bindings = registry
            .bindings
            .owners
            .entry(context.owner_key.clone())
            .or_default();
        match source {
            Some(source) => {
                bindings.insert(name.into(), source);
            }
            None => {
                bindings.remove(name);
            }
        }
        Ok(())
    })?;
    Ok(())
}

pub(crate) fn clear_owner_usage(config: &Path, key: &str) -> Result<bool, AppError> {
    let mut changed = false;
    registry::update(config, |registry| {
        let keys: Vec<_> = registry
            .usage
            .iter()
            .filter(|(_, u)| u.owner_directory == key)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            registry.usage.remove(&key);
            registry.bindings.owners.remove(&key);
            changed = true;
        }
        Ok(())
    })?;
    Ok(changed)
}

pub(crate) fn resolve_environment(
    config: &Path,
    context: &AppVariableOwnerContext,
    declaration: &BTreeMap<String, String>,
    secrets: &dyn SecretStore,
) -> Result<ResolvedAppEnvironment, AppError> {
    let context = &registry::prepare_context(config, context)?;
    let registry = registry::read(config)?;
    let bindings = registry
        .bindings
        .owners
        .get(&context.owner_key)
        .cloned()
        .unwrap_or_default();
    let hierarchy = context.scope.context(config)?;
    let service = Service::new(secrets);
    let mut missing = Vec::new();
    let mut sources = BTreeMap::new();
    let values = match service.resolve(&hierarchy, &context.references, &bindings) {
        Ok(values) => values
            .into_iter()
            .map(|(name, resolved)| {
                sources.insert(name.clone(), resolved.source);
                (name, resolved.value)
            })
            .collect(),
        Err(_) => {
            for name in &context.references {
                match service.resolve(&hierarchy, std::slice::from_ref(name), &bindings) {
                    Ok(value) => {
                        sources.insert(name.clone(), value[name].source.clone());
                    }
                    Err(_) => missing.push(MissingAppVariable {
                        reference_name: name.clone(),
                        entry_name: bindings
                            .get(name)
                            .map(|s| s.name.clone())
                            .unwrap_or_else(|| name.clone()),
                    }),
                }
            }
            // A concurrent external edit cannot turn the failed snapshot into a partial success.
            if missing.is_empty() {
                return Err(storage_error(core::Error::StaleRevision));
            }
            BTreeMap::new()
        }
    };
    let usage_changed = registry::sync(config, context, sources)?;
    let environment = if missing.is_empty() {
        environment::resolve(declaration, &values)
            .map_err(|_| storage_error(core::Error::Missing))?
    } else {
        BTreeMap::new()
    };
    Ok(ResolvedAppEnvironment {
        environment,
        missing,
        usage_changed,
    })
}

pub(crate) fn register_s3_owner(config: &Path, owner: &Path) -> Result<(), AppError> {
    let _guard = core::files::lock(config).map_err(storage_error)?;
    core::files::check_pending(config).map_err(storage_error)?;
    let path = config.join("settings.json");
    let mut root = core::files::read(&path, false).map_err(storage_error)?;
    let mut owners: BTreeSet<PathBuf> = root
        .get("s3VariableOwners")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    if owners.insert(owner.to_path_buf()) {
        root["s3VariableOwners"] = serde_json::to_value(owners)?;
        core::files::atomic_write(&path, &root).map_err(storage_error)?;
    }
    Ok(())
}
fn s3_usage(
    config: &Path,
    scope: Option<&VariableScope>,
    reference: &SourceReference,
) -> Result<Vec<AppVariableUsage>, AppError> {
    let root = core::files::read(&config.join("settings.json"), false).map_err(storage_error)?;
    let owners: BTreeSet<PathBuf> = root
        .get("s3VariableOwners")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let mut usage = Vec::new();
    for owner in owners {
        if let Ok(agent) = svode_core::storage::s3::AgentConfig::read(&owner) {
            if agent.global_directory.canonicalize().ok() != config.canonicalize().ok() {
                continue;
            }
            for (role, entry) in agent.bindings.roles() {
                let same_project = scope.is_some_and(|scope| {
                    agent.project_path.canonicalize().ok()
                        == Path::new(&scope.project_path).canonicalize().ok()
                });
                if entry == reference && (reference.owner == SourceOwner::Global || same_project) {
                    usage.push(AppVariableUsage {
                        owner_directory: crate::system_path::user_facing_path(&owner),
                        reference_name: format!("S3 {role}"),
                    });
                }
            }
        }
    }
    Ok(usage)
}

#[cfg(test)]
mod tests;
