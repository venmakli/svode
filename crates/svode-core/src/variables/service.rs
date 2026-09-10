use super::{
    files,
    model::{Declaration, LocalSection, Section},
    *,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

/// Validated hierarchy; source paths are resolved again for each operation.
pub struct Context {
    project: PathBuf,
    space_id: Option<String>,
    library: PathBuf,
}

impl Context {
    pub fn new(project: &Path, space_id: Option<&str>, library: &Path) -> Result<Self> {
        if !project.is_absolute() || !library.is_absolute() {
            return Err(Error::InvalidOwner);
        }
        let context = Self {
            project: project.canonicalize().map_err(|_| Error::InvalidOwner)?,
            space_id: space_id.map(str::to_string),
            library: library.to_path_buf(),
        };
        context.owner(&SourceOwner::Project)?;
        if let Some(id) = &context.space_id {
            context.owner(&SourceOwner::Space { id: id.clone() })?;
        }
        Ok(context)
    }

    fn owner(&self, owner: &SourceOwner) -> Result<Owner> {
        match owner {
            SourceOwner::Library => Owner::library(&self.library),
            SourceOwner::Project => Owner::scoped(&self.project),
            SourceOwner::Space { id } => {
                if self.space_id.as_ref() != Some(id) {
                    return Err(Error::InvalidOwner);
                }
                let config = files::read(&self.project.join(".svode/config.json"), true)?;
                let spaces = config
                    .get("spaces")
                    .and_then(Value::as_array)
                    .ok_or(Error::InvalidOwner)?;
                let matching: Vec<_> = spaces
                    .iter()
                    .filter(|space| space.get("id").and_then(Value::as_str) == Some(id))
                    .collect();
                if matching.len() != 1 {
                    return Err(Error::InvalidOwner);
                }
                let relative = matching[0]
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or(Error::InvalidOwner)?;
                let relative = Path::new(relative);
                if relative.is_absolute()
                    || relative
                        .components()
                        .any(|c| !matches!(c, std::path::Component::Normal(_)))
                {
                    return Err(Error::InvalidOwner);
                }
                let path = self
                    .project
                    .join(relative)
                    .canonicalize()
                    .map_err(|_| Error::InvalidOwner)?;
                if path == self.project || !path.starts_with(&self.project) {
                    return Err(Error::InvalidOwner);
                }
                Owner::scoped(&path)
            }
        }
    }
}

#[derive(Clone)]
pub struct Owner {
    directory: PathBuf,
    library: bool,
}

impl Owner {
    pub fn library(config_directory: &Path) -> Result<Self> {
        if !config_directory.is_absolute() {
            return Err(Error::InvalidOwner);
        }
        Ok(Self {
            directory: config_directory.to_path_buf(),
            library: true,
        })
    }
    fn scoped(path: &Path) -> Result<Self> {
        let directory = path.join(".svode");
        files::read(&directory.join("config.json"), true)?;
        Ok(Self {
            directory,
            library: false,
        })
    }
    pub fn in_context(context: &Context, source: &SourceOwner) -> Result<Self> {
        context.owner(source)
    }
    pub fn scope_path(&self) -> Result<&Path> {
        if self.library {
            return Err(Error::InvalidOwner);
        }
        self.directory.parent().ok_or(Error::InvalidOwner)
    }
    fn portable_path(&self) -> PathBuf {
        self.directory.join(if self.library {
            "settings.json"
        } else {
            "config.json"
        })
    }
    fn local_path(&self) -> PathBuf {
        self.directory.join("local.json")
    }
}

struct Snapshot {
    portable: Value,
    local: Value,
    git: Section,
    device: LocalSection,
    library_entries: BTreeMap<String, Declaration>,
    revision: Revision,
}

fn decode<T: serde::de::DeserializeOwned + Default>(value: Option<&Value>) -> Result<T> {
    let Some(value) = value else {
        return Ok(T::default());
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(Error::UnsupportedVersion);
    }
    serde_json::from_value(value.clone()).map_err(|_| Error::InvalidConfig)
}

fn valid_id(id: &str) -> bool {
    ulid::Ulid::from_string(id).is_ok()
}

fn validate_entries(entries: &BTreeMap<String, Declaration>) -> Result<()> {
    let mut ids = BTreeSet::new();
    for (name, entry) in entries {
        if !valid_name(name)
            || !valid_id(&entry.id)
            || !ids.insert(&entry.id)
            || (entry.kind == Kind::Secret && entry.value.is_some())
            || (entry.kind == Kind::Variable && entry.value.is_none())
        {
            return Err(Error::InvalidConfig);
        }
    }
    Ok(())
}

impl Snapshot {
    fn read(owner: &Owner) -> Result<Self> {
        files::check_pending(&owner.directory)?;
        let portable = files::read(&owner.portable_path(), !owner.library)?;
        let local = if owner.library {
            json!({})
        } else {
            files::read(&owner.local_path(), false)?
        };
        Self::parse(owner, portable, local)
    }

    fn parse(owner: &Owner, portable: Value, local: Value) -> Result<Self> {
        if !portable.is_object() || !local.is_object() {
            return Err(Error::InvalidConfig);
        }
        let revision = Revision(files::digest(&json!([portable, local])));
        let mut snapshot = Self {
            portable,
            local,
            git: Section::default(),
            device: LocalSection::default(),
            library_entries: BTreeMap::new(),
            revision,
        };
        if owner.library {
            if let Some(variables) = snapshot.portable.get("variables") {
                if !variables.is_object() {
                    return Err(Error::InvalidConfig);
                }
                if let Some(version) = variables.get("version")
                    && version.as_u64() != Some(1)
                {
                    return Err(Error::UnsupportedVersion);
                }
                if let Some(entries) = variables.get("entries") {
                    let entries = entries.as_object().ok_or(Error::InvalidConfig)?;
                    for (name, value) in entries {
                        let kind: Kind = serde_json::from_value(
                            value.get("kind").cloned().ok_or(Error::InvalidConfig)?,
                        )
                        .map_err(|_| Error::InvalidConfig)?;
                        let ordinary = value
                            .get("value")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        if !valid_name(name)
                            || (kind == Kind::Secret
                                && value.get("value").is_some_and(|v| !v.is_null()))
                            || (kind == Kind::Variable && ordinary.is_none())
                        {
                            return Err(Error::InvalidConfig);
                        }
                        let id = match value.get("id") {
                            Some(id) => {
                                let id = id
                                    .as_str()
                                    .filter(|id| valid_id(id))
                                    .ok_or(Error::InvalidConfig)?;
                                id.to_string()
                            }
                            // Existing entries keep both their metadata and their Keychain account.
                            None => format!("library:{name}"),
                        };
                        snapshot.library_entries.insert(
                            name.clone(),
                            Declaration {
                                id,
                                kind,
                                value: ordinary,
                            },
                        );
                    }
                }
            }
        } else {
            snapshot.git = decode(snapshot.portable.get("variables"))?;
            snapshot.device = decode(snapshot.local.get("variables"))?;
            validate_entries(&snapshot.git.entries)?;
            validate_entries(&snapshot.device.entries)?;
            if !valid_id(&snapshot.device.copy_id)
                || snapshot
                    .device
                    .secrets
                    .iter()
                    .any(|(id, token)| !valid_id(id) || !valid_id(token))
            {
                return Err(Error::InvalidConfig);
            }
            for (name, local) in &snapshot.device.entries {
                if snapshot
                    .git
                    .entries
                    .iter()
                    .any(|(other, git)| other != name && git.id == local.id)
                {
                    return Err(Error::InvalidConfig);
                }
            }
        }
        Ok(snapshot)
    }

    fn entries(&self, owner: &Owner) -> Vec<(&String, Mode, &Declaration)> {
        if owner.library {
            self.library_entries
                .iter()
                .map(|(n, e)| (n, Mode::Local, e))
                .collect()
        } else {
            self.git
                .entries
                .iter()
                .map(|(n, e)| (n, Mode::Git, e))
                .chain(self.device.entries.iter().map(|(n, e)| (n, Mode::Local, e)))
                .collect()
        }
    }

    fn declaration(&self, owner: &Owner, name: &str) -> Result<Option<(Mode, &Declaration)>> {
        if owner.library {
            return Ok(self
                .library_entries
                .get(name)
                .map(|entry| (Mode::Local, entry)));
        }
        match (self.git.entries.get(name), self.device.entries.get(name)) {
            (Some(_), Some(_)) => Err(Error::Collision),
            (Some(entry), None) => Ok(Some((Mode::Git, entry))),
            (None, Some(entry)) => Ok(Some((Mode::Local, entry))),
            _ => Ok(None),
        }
    }

    fn account(&self, owner: &Owner, name: &str, entry: &Declaration) -> Option<String> {
        if entry.kind != Kind::Secret {
            return None;
        }
        if owner.library {
            return Some(name.into());
        }
        self.device
            .secrets
            .get(&entry.id)
            .map(|token| format!("scoped:{}:{}:{token}", self.device.copy_id, entry.id))
    }
}

pub struct Service<'a> {
    secrets: &'a dyn SecretStore,
    #[cfg(test)]
    pub(crate) interrupt: std::cell::Cell<u8>,
}
impl<'a> Service<'a> {
    pub fn new(secrets: &'a dyn SecretStore) -> Self {
        Self {
            secrets,
            #[cfg(test)]
            interrupt: std::cell::Cell::new(0),
        }
    }

    /// Materializes the local copy identity before attaching device-local consumers.
    pub fn local_identity(&self, owner: &Owner) -> Result<String> {
        if owner.library {
            return Err(Error::InvalidOwner);
        }
        let _guard = files::lock(&owner.directory)?;
        let mut snapshot = Snapshot::read(owner)?;
        if snapshot.local.get("variables").is_none() {
            snapshot.local["variables"] =
                serde_json::to_value(&snapshot.device).map_err(|_| Error::InvalidConfig)?;
            files::atomic_write(&owner.local_path(), &snapshot.local)?;
        }
        Ok(snapshot.device.copy_id)
    }

    pub fn catalog(&self, owner: &Owner) -> Result<Catalog> {
        let _guard = files::lock(&owner.directory)?;
        let snapshot = Snapshot::read(owner)?;
        let collisions = snapshot
            .git
            .entries
            .keys()
            .filter(|name| snapshot.device.entries.contains_key(*name))
            .cloned()
            .collect();
        let mut entries = Vec::new();
        for (name, mode, entry) in snapshot.entries(owner) {
            let has_value = if entry.kind == Kind::Variable {
                true
            } else if let Some(account) = snapshot.account(owner, name, entry) {
                self.secrets
                    .get(&account)
                    .map_err(|_| Error::SecretStore)?
                    .is_some_and(|v| !v.is_empty())
            } else {
                false
            };
            entries.push(Entry {
                name: name.clone(),
                identity: entry.id.clone(),
                mode,
                kind: entry.kind,
                value: entry.value.clone(),
                has_value,
            });
        }
        Ok(Catalog {
            revision: snapshot.revision,
            entries,
            collisions,
        })
    }

    pub fn save(&self, owner: &Owner, input: Save) -> Result<Change> {
        if !valid_name(&input.name) {
            return Err(Error::InvalidName);
        }
        if owner.library && input.mode != Mode::Local {
            return Err(Error::InvalidOwner);
        }
        let _guard = files::lock(&owner.directory)?;
        let mut snapshot = Snapshot::read(owner)?;
        if input.revision != snapshot.revision {
            return Err(Error::StaleRevision);
        }
        let previous = match snapshot.declaration(owner, &input.name) {
            Err(Error::Collision) => match input.keep {
                Some(Mode::Git) => snapshot.git.entries.get(&input.name).cloned(),
                Some(Mode::Local) => snapshot.device.entries.get(&input.name).cloned(),
                None => return Err(Error::Collision),
            },
            Err(error) => return Err(error),
            Ok(entry) => {
                if input.keep.is_some() {
                    return Err(Error::StaleRevision);
                }
                entry.map(|(_, e)| e.clone())
            }
        };
        if previous.as_ref().map(|p| &p.id) != input.identity.as_ref() {
            return Err(Error::StaleRevision);
        }
        let id = previous
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| ulid::Ulid::new().to_string());
        let mut next = Declaration {
            id,
            kind: input.kind,
            value: None,
        };
        let mut secret_value = None;
        if input.kind == Kind::Variable {
            next.value = Some(match input.value {
                Some(value) => value,
                None if previous.as_ref().is_some_and(|p| p.kind == Kind::Variable) => previous
                    .as_ref()
                    .and_then(|p| p.value.clone())
                    .ok_or(Error::InvalidValue)?,
                None => return Err(Error::InvalidValue),
            });
        } else {
            secret_value = input.value.filter(|v| !v.is_empty());
            if secret_value.is_none() && previous.as_ref().is_some_and(|p| p.kind == Kind::Variable)
            {
                secret_value = previous
                    .as_ref()
                    .and_then(|p| p.value.clone())
                    .filter(|v| !v.is_empty());
                if secret_value.is_none() {
                    return Err(Error::InvalidValue);
                }
            }
            if secret_value.is_none() && input.mode == Mode::Local {
                let configured = previous
                    .as_ref()
                    .and_then(|p| snapshot.account(owner, &input.name, p))
                    .map(|account| self.secrets.get(&account).map_err(|_| Error::SecretStore))
                    .transpose()?
                    .flatten()
                    .is_some_and(|v| !v.is_empty());
                if !configured {
                    return Err(Error::InvalidValue);
                }
            }
        }
        let before_portable = files::digest(&snapshot.portable);
        let before_local = files::digest(&snapshot.local);
        let old_accounts: Vec<_> = snapshot
            .entries(owner)
            .iter()
            .filter(|(name, _, _)| *name == &input.name)
            .filter_map(|(name, _, entry)| snapshot.account(owner, name, entry))
            .collect();
        let mut publish = None;
        let mut stage = None;
        if let Some(value) = secret_value {
            let token = ulid::Ulid::new().to_string();
            let account = if owner.library {
                format!("staged:{token}")
            } else {
                format!("scoped:{}:{}:{token}", snapshot.device.copy_id, next.id)
            };
            self.secrets
                .set(&account, &value)
                .map_err(|_| Error::SecretStore)?;
            if owner.library {
                publish = Some((account.clone(), input.name.clone()));
                stage = Some(account);
            } else {
                snapshot.device.secrets.insert(next.id.clone(), token);
            }
        }
        if input.kind == Kind::Variable {
            snapshot.device.secrets.remove(&next.id);
        }
        let active_account = snapshot.account(owner, &input.name, &next);
        let cleanup = old_accounts
            .into_iter()
            .filter(|account| Some(account) != active_account.as_ref())
            .collect();
        if owner.library {
            let variables = snapshot
                .portable
                .as_object_mut()
                .ok_or(Error::InvalidConfig)?
                .entry("variables")
                .or_insert_with(|| json!({"entries":{}}));
            let variables = variables.as_object_mut().ok_or(Error::InvalidConfig)?;
            variables.insert("version".into(), json!(1));
            variables.insert("revision".into(), json!(ulid::Ulid::new().to_string()));
            let entries = variables
                .entry("entries")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or(Error::InvalidConfig)?;
            let mut entry = serde_json::to_value(&next).map_err(|_| Error::InvalidConfig)?;
            if next.id.starts_with("library:") {
                entry.as_object_mut().unwrap().remove("id");
            }
            entries.insert(input.name.clone(), entry);
        } else {
            snapshot.git.entries.remove(&input.name);
            snapshot.device.entries.remove(&input.name);
            match input.mode {
                Mode::Git => {
                    snapshot.git.entries.insert(input.name.clone(), next);
                }
                Mode::Local => {
                    snapshot.device.entries.insert(input.name.clone(), next);
                }
            }
            if !snapshot.git.entries.is_empty() || snapshot.portable.get("variables").is_some() {
                snapshot.portable["variables"] =
                    serde_json::to_value(&snapshot.git).map_err(|_| Error::InvalidConfig)?;
            }
            snapshot.local["variables"] =
                serde_json::to_value(&snapshot.device).map_err(|_| Error::InvalidConfig)?;
        }
        self.commit(
            owner,
            snapshot,
            before_portable,
            before_local,
            vec![input.name],
            publish,
            cleanup,
            stage,
        )
    }

    pub fn remove(
        &self,
        owner: &Owner,
        name: &str,
        identity: &str,
        revision: &Revision,
    ) -> Result<Change> {
        let _guard = files::lock(&owner.directory)?;
        let mut snapshot = Snapshot::read(owner)?;
        if &snapshot.revision != revision {
            return Err(Error::StaleRevision);
        }
        let (_, entry) = snapshot.declaration(owner, name)?.ok_or(Error::Missing)?;
        if entry.id != identity {
            return Err(Error::StaleRevision);
        }
        let cleanup = snapshot.account(owner, name, entry).into_iter().collect();
        let id = entry.id.clone();
        let before_portable = files::digest(&snapshot.portable);
        let before_local = files::digest(&snapshot.local);
        if owner.library {
            snapshot.portable["variables"]["entries"]
                .as_object_mut()
                .ok_or(Error::InvalidConfig)?
                .remove(name);
            snapshot.portable["variables"]["revision"] = json!(ulid::Ulid::new().to_string());
        } else {
            snapshot.git.entries.remove(name);
            snapshot.device.entries.remove(name);
            snapshot.device.secrets.remove(&id);
            if !snapshot.git.entries.is_empty() || snapshot.portable.get("variables").is_some() {
                snapshot.portable["variables"] =
                    serde_json::to_value(&snapshot.git).map_err(|_| Error::InvalidConfig)?;
            }
            snapshot.local["variables"] =
                serde_json::to_value(&snapshot.device).map_err(|_| Error::InvalidConfig)?;
        }
        self.commit(
            owner,
            snapshot,
            before_portable,
            before_local,
            vec![name.into()],
            None,
            cleanup,
            None,
        )
    }

    fn resolve_locked(
        &self,
        owner: &Owner,
        snapshot: &Snapshot,
        source: SourceReference,
    ) -> Result<Option<Resolved>> {
        let Some((_, entry)) = snapshot.declaration(owner, &source.name)? else {
            return Ok(None);
        };
        let value = if entry.kind == Kind::Variable {
            entry.value.clone()
        } else if let Some(account) = snapshot.account(owner, &source.name, entry) {
            self.secrets.get(&account).map_err(|_| Error::SecretStore)?
        } else {
            None
        };
        let value = value
            .filter(|v| entry.kind == Kind::Variable || !v.is_empty())
            .ok_or(Error::Missing)?;
        Ok(Some(Resolved {
            source,
            kind: entry.kind,
            value,
        }))
    }

    /// Resolves only the caller's declared references. Explicit sources never fall back.
    pub fn resolve(
        &self,
        context: &Context,
        names: &[String],
        bindings: &BTreeMap<String, SourceReference>,
    ) -> Result<BTreeMap<String, Resolved>> {
        self.resolve_references(context, names, bindings, false)
    }

    fn resolve_references(
        &self,
        context: &Context,
        names: &[String],
        bindings: &BTreeMap<String, SourceReference>,
        secrets_only: bool,
    ) -> Result<BTreeMap<String, Resolved>> {
        let mut sources = BTreeSet::new();
        for name in names {
            if !valid_name(name) {
                return Err(Error::InvalidName);
            }
            if let Some(source) = bindings.get(name) {
                if !valid_name(&source.name) {
                    return Err(Error::InvalidName);
                }
                sources.insert(source.owner.clone());
            } else {
                sources.insert(SourceOwner::Project);
                if let Some(id) = &context.space_id {
                    sources.insert(SourceOwner::Space { id: id.clone() });
                }
            }
        }
        let mut owners = sources
            .into_iter()
            .map(|source| Ok((source.clone(), context.owner(&source)?)))
            .collect::<Result<Vec<_>>>()?;
        owners.sort_by(|a, b| a.1.directory.cmp(&b.1.directory));
        let directories = owners
            .iter()
            .map(|(_, owner)| &owner.directory)
            .collect::<BTreeSet<_>>();
        let _guards = directories
            .into_iter()
            .map(|directory| files::lock(directory))
            .collect::<Result<Vec<_>>>()?;
        let snapshots = owners
            .iter()
            .map(|(source, owner)| Ok((source.clone(), (owner, Snapshot::read(owner)?))))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let mut selected = BTreeMap::new();
        for name in names {
            let candidates = if let Some(source) = bindings.get(name) {
                vec![source.clone()]
            } else {
                let mut candidates = Vec::new();
                if let Some(id) = &context.space_id {
                    candidates.push(SourceReference {
                        owner: SourceOwner::Space { id: id.clone() },
                        name: name.clone(),
                    });
                }
                candidates.push(SourceReference {
                    owner: SourceOwner::Project,
                    name: name.clone(),
                });
                candidates
            };
            let mut selected_source = None;
            for source in candidates {
                let (owner, snapshot) = snapshots.get(&source.owner).ok_or(Error::InvalidOwner)?;
                if let Some((_, entry)) = snapshot.declaration(owner, &source.name)? {
                    if secrets_only && entry.kind != Kind::Secret {
                        return Err(Error::WrongKind);
                    }
                    selected_source = Some(source);
                    break;
                }
            }
            selected.insert(name.clone(), selected_source.ok_or(Error::Missing)?);
        }
        // Validate all declarations first, then read each selected source once.
        let mut values: BTreeMap<SourceReference, Resolved> = BTreeMap::new();
        let mut result = BTreeMap::new();
        for (name, source) in selected {
            let value = match values.get(&source) {
                Some(value) => value.clone(),
                None => {
                    let (owner, snapshot) =
                        snapshots.get(&source.owner).ok_or(Error::InvalidOwner)?;
                    let value = self
                        .resolve_locked(owner, snapshot, source.clone())?
                        .ok_or(Error::Missing)?;
                    values.insert(source, value.clone());
                    value
                }
            };
            result.insert(name, value);
        }
        // Git does not participate in our locks: reject an observed external change.
        for (owner, snapshot) in snapshots.values() {
            if Snapshot::read(owner)?.revision != snapshot.revision {
                return Err(Error::StaleRevision);
            }
        }
        Ok(result)
    }

    pub fn resolve_secret_pair(
        &self,
        context: &Context,
        pair: &SecretPair,
    ) -> Result<SecretValues> {
        let bindings = BTreeMap::from([
            ("ACCESS".into(), pair.access_key.clone()),
            ("SECRET".into(), pair.secret_key.clone()),
        ]);
        let mut resolved = self.resolve_references(
            context,
            &["ACCESS".into(), "SECRET".into()],
            &bindings,
            true,
        )?;
        if resolved.values().any(|v| v.value.trim().is_empty()) {
            return Err(Error::Missing);
        }
        Ok(SecretValues {
            access_key: resolved.remove("ACCESS").unwrap().value,
            secret_key: resolved.remove("SECRET").unwrap().value,
        })
    }
}

pub struct SecretValues {
    pub access_key: String,
    pub secret_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u32,
    before_portable: String,
    before_local: String,
    portable: Value,
    local: Value,
    names: Vec<String>,
    publish: Option<(String, String)>,
    cleanup: Vec<String>,
    stage: Option<String>,
}

impl Service<'_> {
    #[allow(clippy::too_many_arguments)]
    fn commit(
        &self,
        owner: &Owner,
        snapshot: Snapshot,
        before_portable: String,
        before_local: String,
        names: Vec<String>,
        publish: Option<(String, String)>,
        cleanup: Vec<String>,
        stage: Option<String>,
    ) -> Result<Change> {
        // No prior config image is journaled: ordinary -> Secret must not duplicate plaintext.
        let current = Snapshot::read(owner)?;
        if current.revision != snapshot.revision {
            return Err(Error::StaleRevision);
        }
        let journal = Journal {
            version: 1,
            before_portable,
            before_local,
            portable: snapshot.portable,
            local: snapshot.local,
            names,
            publish,
            cleanup,
            stage,
        };
        files::atomic_write(
            &owner.directory.join(files::PENDING_FILE),
            &serde_json::to_value(&journal).map_err(|_| Error::InvalidConfig)?,
        )?;
        #[cfg(test)]
        if self.interrupt.get() == 1 {
            return Err(Error::PendingRecovery);
        }
        self.finish(owner, &journal)
    }

    /// Idempotently finishes a prepared operation. A new save still needs a fresh revision.
    pub fn recover(&self, owner: &Owner) -> Result<Option<Change>> {
        let _guard = files::lock(&owner.directory)?;
        if files::check_pending(&owner.directory).is_ok() {
            return Ok(None);
        }
        let value = files::read(&owner.directory.join(files::PENDING_FILE), true)?;
        let journal: Journal = serde_json::from_value(value).map_err(|_| Error::InvalidConfig)?;
        if journal.version != 1 {
            return Err(Error::UnsupportedVersion);
        }
        self.finish(owner, &journal).map(Some)
    }

    fn finish(&self, owner: &Owner, journal: &Journal) -> Result<Change> {
        let candidate = Snapshot::parse(owner, journal.portable.clone(), journal.local.clone())?;
        if journal.names.iter().any(|name| !valid_name(name))
            || journal.stage.is_some() != journal.publish.is_some()
            || (owner.library && journal.local != json!({}))
        {
            return Err(Error::InvalidConfig);
        }
        let prefix = format!("scoped:{}:", candidate.device.copy_id);
        for account in &journal.cleanup {
            let valid = if owner.library {
                journal.names.contains(account) && valid_name(account)
            } else {
                account.strip_prefix(&prefix).is_some_and(|suffix| {
                    let parts = suffix.split(':').collect::<Vec<_>>();
                    parts.len() == 2 && parts.iter().all(|part| valid_id(part))
                })
            };
            if !valid {
                return Err(Error::InvalidConfig);
            }
        }
        let portable = files::read(&owner.portable_path(), !owner.library)?;
        let local = if owner.library {
            json!({})
        } else {
            files::read(&owner.local_path(), false)?
        };
        let next_portable = files::digest(&journal.portable);
        let next_local = files::digest(&journal.local);
        if !owner.library
            && local
                .get("variables")
                .and_then(|v| v.get("copyId"))
                .is_some_and(|id| id.as_str() != Some(&candidate.device.copy_id))
        {
            return Err(Error::InvalidConfig);
        }
        if ![&journal.before_portable, &next_portable].contains(&&files::digest(&portable))
            || ![&journal.before_local, &next_local].contains(&&files::digest(&local))
        {
            return Err(Error::StaleRevision);
        }
        if let Some((stage, target)) = &journal.publish {
            if !owner.library
                || !stage.strip_prefix("staged:").is_some_and(valid_id)
                || !valid_name(target)
                || !journal.names.contains(target)
                || journal.stage.as_ref() != Some(stage)
                || candidate
                    .library_entries
                    .get(target)
                    .is_none_or(|entry| entry.kind != Kind::Secret)
            {
                return Err(Error::InvalidConfig);
            }
            let value = self
                .secrets
                .get(stage)
                .map_err(|_| Error::SecretStore)?
                .ok_or(Error::PendingRecovery)?;
            self.secrets
                .set(target, &value)
                .map_err(|_| Error::SecretStore)?;
        }
        if files::digest(&portable) != next_portable {
            files::atomic_write(&owner.portable_path(), &journal.portable)?;
        }
        #[cfg(test)]
        if self.interrupt.get() == 2 {
            return Err(Error::PendingRecovery);
        }
        if !owner.library && files::digest(&local) != next_local {
            files::atomic_write(&owner.local_path(), &journal.local)?;
        }
        for account in &journal.cleanup {
            self.secrets
                .remove(account)
                .map_err(|_| Error::SecretStore)?;
        }
        std::fs::remove_file(owner.directory.join(files::PENDING_FILE))
            .map_err(|_| Error::Unavailable)?;
        files::sync(&owner.directory)?;
        if let Some(stage) = &journal.stage {
            let _ = self.secrets.remove(stage);
        }
        Ok(Change {
            owner_path: owner.directory.clone(),
            names: journal.names.clone(),
            revision: Revision(files::digest(&json!([journal.portable, journal.local]))),
            portable_changed: !owner.library && journal.before_portable != next_portable,
        })
    }
}
