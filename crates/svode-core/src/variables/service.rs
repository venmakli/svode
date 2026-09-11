use super::{
    files,
    model::{Section, StoredEntry},
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
    global: PathBuf,
}

impl Context {
    pub fn new(project: &Path, space_id: Option<&str>, global: &Path) -> Result<Self> {
        if !project.is_absolute() || !global.is_absolute() {
            return Err(Error::InvalidOwner);
        }
        let context = Self {
            project: project.canonicalize().map_err(|_| Error::InvalidOwner)?,
            space_id: space_id.map(str::to_string),
            global: global.to_path_buf(),
        };
        context.owner(&SourceOwner::Project)?;
        if let Some(id) = &context.space_id {
            context.owner(&SourceOwner::Space { id: id.clone() })?;
        }
        Ok(context)
    }

    fn owner(&self, owner: &SourceOwner) -> Result<Owner> {
        match owner {
            SourceOwner::Global => Owner::global(&self.global),
            SourceOwner::Project => Owner::scoped(&self.project),
            SourceOwner::Space { id } => {
                if self.space_id.as_ref() != Some(id) {
                    return Err(Error::InvalidOwner);
                }
                let project = &self.project;
                let config = files::read(&project.join(".svode/config.json"), true)?;
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
                let path = project
                    .join(relative)
                    .canonicalize()
                    .map_err(|_| Error::InvalidOwner)?;
                if path == *project || !path.starts_with(project) {
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
    global: bool,
}

impl Owner {
    pub fn global(config_directory: &Path) -> Result<Self> {
        if !config_directory.is_absolute() {
            return Err(Error::InvalidOwner);
        }
        Ok(Self {
            directory: config_directory.to_path_buf(),
            global: true,
        })
    }
    fn scoped(path: &Path) -> Result<Self> {
        let directory = path.join(".svode");
        files::read(&directory.join("config.json"), true)?;
        Ok(Self {
            directory,
            global: false,
        })
    }
    pub fn in_context(context: &Context, source: &SourceOwner) -> Result<Self> {
        context.owner(source)
    }
    pub fn scope_path(&self) -> Result<&Path> {
        if self.global {
            return Err(Error::InvalidOwner);
        }
        self.directory.parent().ok_or(Error::InvalidOwner)
    }
    fn portable_path(&self) -> PathBuf {
        self.directory.join(if self.global {
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
    device: Section,
    revision: Revision,
}

fn valid_ref(reference: &str) -> bool {
    reference
        .strip_prefix("secret:")
        .is_some_and(|token| ulid::Ulid::from_string(token).is_ok())
}

fn decode(value: Option<&Value>, portable: bool, global: bool) -> Result<Section> {
    let Some(value) = value else {
        return Ok(Section::default());
    };
    let entries: Section =
        serde_json::from_value(value.clone()).map_err(|_| Error::InvalidConfig)?;
    // Reject null option fields as well as unknown/legacy shapes without reserving names.
    if serde_json::to_value(&entries).map_err(|_| Error::InvalidConfig)? != *value {
        return Err(Error::InvalidConfig);
    }
    for (name, entry) in &entries {
        let valid = match entry.kind {
            Some(Kind::Variable) => entry.value.is_some() && entry.secret_ref.is_none(),
            Some(Kind::Secret) => {
                entry.value.is_none()
                    && if portable {
                        entry.secret_ref.is_none()
                    } else {
                        entry.secret_ref.is_some()
                    }
            }
            None => !portable && !global && entry.value.is_none() && entry.secret_ref.is_some(),
        };
        if !valid_name(name) || !valid || entry.secret_ref.as_deref().is_some_and(|r| !valid_ref(r))
        {
            return Err(Error::InvalidConfig);
        }
    }
    Ok(entries)
}

fn write_section(root: &mut Value, entries: &Section) -> Result<()> {
    if entries.is_empty() {
        root.as_object_mut()
            .ok_or(Error::InvalidConfig)?
            .remove("variables");
    } else {
        root["variables"] = serde_json::to_value(entries).map_err(|_| Error::InvalidConfig)?;
    }
    Ok(())
}

impl Snapshot {
    fn read(owner: &Owner) -> Result<Self> {
        files::check_pending(&owner.directory)?;
        let portable = files::read(&owner.portable_path(), !owner.global)?;
        let local = if owner.global {
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
        let git = if owner.global {
            Section::default()
        } else {
            decode(portable.get("variables"), true, false)?
        };
        let device = decode(
            if owner.global {
                portable.get("variables")
            } else {
                local.get("variables")
            },
            false,
            owner.global,
        )?;
        Ok(Self {
            portable,
            local,
            git,
            device,
            revision,
        })
    }

    fn entries(&self) -> Vec<(&String, Mode, &StoredEntry)> {
        self.git
            .iter()
            .map(|(n, e)| (n, Mode::Git, e))
            .chain(
                self.device
                    .iter()
                    .filter(|(_, e)| e.kind.is_some())
                    .map(|(n, e)| (n, Mode::Local, e)),
            )
            .collect()
    }

    fn declaration(&self, name: &str) -> Result<Option<(Mode, &StoredEntry)>> {
        match (
            self.git.get(name),
            self.device.get(name).filter(|e| e.kind.is_some()),
        ) {
            (Some(_), Some(_)) => Err(Error::Collision),
            (Some(entry), None) => Ok(Some((Mode::Git, entry))),
            (None, Some(entry)) => Ok(Some((Mode::Local, entry))),
            _ => Ok(None),
        }
    }

    fn account(&self, name: &str, mode: Mode, entry: &StoredEntry) -> Option<String> {
        if entry.kind != Some(Kind::Secret) {
            return None;
        }
        if mode == Mode::Local {
            return entry.secret_ref.clone();
        }
        self.device
            .get(name)
            .filter(|e| e.kind.is_none())
            .and_then(|e| e.secret_ref.clone())
    }

    fn publish_sections(&mut self, owner: &Owner) -> Result<()> {
        if owner.global {
            write_section(&mut self.portable, &self.device)
        } else {
            write_section(&mut self.portable, &self.git)?;
            write_section(&mut self.local, &self.device)
        }
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

    pub fn catalog(&self, owner: &Owner) -> Result<Catalog> {
        let _guard = files::lock(&owner.directory)?;
        let snapshot = Snapshot::read(owner)?;
        let collisions = snapshot
            .git
            .keys()
            .filter(|name| snapshot.device.get(*name).is_some_and(|e| e.kind.is_some()))
            .cloned()
            .collect();
        let mut entries = Vec::new();
        for (name, mode, entry) in snapshot.entries() {
            let kind = entry.kind.ok_or(Error::InvalidConfig)?;
            let has_value = if kind == Kind::Variable {
                true
            } else if let Some(account) = snapshot.account(name, mode, entry) {
                self.secrets
                    .get(&account)
                    .map_err(|_| Error::SecretStore)?
                    .is_some_and(|v| !v.is_empty())
            } else {
                false
            };
            entries.push(Entry {
                name: name.clone(),
                mode,
                kind,
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
        if owner.global && input.mode != Mode::Local {
            return Err(Error::InvalidOwner);
        }
        let _guard = files::lock(&owner.directory)?;
        let mut snapshot = Snapshot::read(owner)?;
        if input.revision != snapshot.revision {
            return Err(Error::StaleRevision);
        }
        let previous = match snapshot.declaration(&input.name) {
            Err(Error::Collision) => match input.keep {
                Some(Mode::Git) => snapshot
                    .git
                    .get(&input.name)
                    .map(|e| (Mode::Git, e.clone())),
                Some(Mode::Local) => snapshot
                    .device
                    .get(&input.name)
                    .map(|e| (Mode::Local, e.clone())),
                None => return Err(Error::Collision),
            },
            Err(error) => return Err(error),
            Ok(entry) => {
                if input.keep.is_some() {
                    return Err(Error::StaleRevision);
                }
                entry.map(|(mode, e)| (mode, e.clone()))
            }
        };
        if previous.is_some() != (input.operation == SaveOperation::Edit) {
            return Err(Error::StaleRevision);
        }
        let mut next = StoredEntry {
            kind: Some(input.kind),
            value: None,
            secret_ref: None,
        };
        let mut secret_value = None;
        if input.kind == Kind::Variable {
            next.value = Some(match input.value {
                Some(value) => value,
                None => previous
                    .as_ref()
                    .filter(|(_, p)| p.kind == Some(Kind::Variable))
                    .and_then(|(_, p)| p.value.clone())
                    .ok_or(Error::InvalidValue)?,
            });
        } else {
            secret_value = input.value.filter(|v| !v.is_empty());
            if secret_value.is_none()
                && previous
                    .as_ref()
                    .is_some_and(|(_, p)| p.kind == Some(Kind::Variable))
            {
                secret_value = previous
                    .as_ref()
                    .and_then(|(_, p)| p.value.clone())
                    .filter(|v| !v.is_empty());
                if secret_value.is_none() {
                    return Err(Error::InvalidValue);
                }
            }
            next.secret_ref = previous
                .as_ref()
                .and_then(|(mode, p)| snapshot.account(&input.name, *mode, p));
            if secret_value.is_none() && input.mode == Mode::Local {
                let configured = next
                    .secret_ref
                    .as_ref()
                    .map(|r| self.secrets.get(r).map_err(|_| Error::SecretStore))
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
        let old_account = snapshot
            .device
            .get(&input.name)
            .and_then(|e| e.secret_ref.clone());
        if let Some(value) = secret_value {
            let account = format!("secret:{}", ulid::Ulid::new());
            self.secrets
                .set(&account, &value)
                .map_err(|_| Error::SecretStore)?;
            next.secret_ref = Some(account);
        }
        let cleanup = old_account
            .into_iter()
            .filter(|account| Some(account) != next.secret_ref.as_ref())
            .collect();
        snapshot.git.remove(&input.name);
        snapshot.device.remove(&input.name);
        match input.mode {
            Mode::Git => {
                if let Some(reference) = next.secret_ref.take() {
                    snapshot.device.insert(
                        input.name.clone(),
                        StoredEntry {
                            kind: None,
                            value: None,
                            secret_ref: Some(reference),
                        },
                    );
                }
                snapshot.git.insert(input.name.clone(), next);
            }
            Mode::Local => {
                snapshot.device.insert(input.name.clone(), next);
            }
        }
        snapshot.publish_sections(owner)?;
        self.commit(
            owner,
            snapshot,
            before_portable,
            before_local,
            vec![input.name],
            cleanup,
        )
    }

    pub fn remove(&self, owner: &Owner, name: &str, revision: &Revision) -> Result<Change> {
        if !valid_name(name) {
            return Err(Error::InvalidName);
        }
        let _guard = files::lock(&owner.directory)?;
        let mut snapshot = Snapshot::read(owner)?;
        if &snapshot.revision != revision {
            return Err(Error::StaleRevision);
        }
        snapshot.declaration(name)?.ok_or(Error::Missing)?;
        let cleanup = snapshot
            .device
            .get(name)
            .and_then(|e| e.secret_ref.clone())
            .into_iter()
            .collect();
        let before_portable = files::digest(&snapshot.portable);
        let before_local = files::digest(&snapshot.local);
        snapshot.git.remove(name);
        snapshot.device.remove(name);
        snapshot.publish_sections(owner)?;
        self.commit(
            owner,
            snapshot,
            before_portable,
            before_local,
            vec![name.into()],
            cleanup,
        )
    }

    fn resolve_locked(
        &self,
        snapshot: &Snapshot,
        source: SourceReference,
    ) -> Result<Option<Resolved>> {
        let Some((mode, entry)) = snapshot.declaration(&source.name)? else {
            return Ok(None);
        };
        let value = if entry.kind == Some(Kind::Variable) {
            entry.value.clone()
        } else if let Some(account) = snapshot.account(&source.name, mode, entry) {
            self.secrets.get(&account).map_err(|_| Error::SecretStore)?
        } else {
            None
        };
        let value = value
            .filter(|v| entry.kind == Some(Kind::Variable) || !v.is_empty())
            .ok_or(Error::Missing)?;
        Ok(Some(Resolved {
            source,
            kind: entry.kind.ok_or(Error::InvalidConfig)?,
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
                let (_, snapshot) = snapshots.get(&source.owner).ok_or(Error::InvalidOwner)?;
                if let Some((_, entry)) = snapshot.declaration(&source.name)? {
                    if secrets_only && entry.kind != Some(Kind::Secret) {
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
                    let (_, snapshot) = snapshots.get(&source.owner).ok_or(Error::InvalidOwner)?;
                    let value = self
                        .resolve_locked(snapshot, source.clone())?
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
    cleanup: Vec<String>,
}

impl Service<'_> {
    fn commit(
        &self,
        owner: &Owner,
        snapshot: Snapshot,
        before_portable: String,
        before_local: String,
        names: Vec<String>,
        cleanup: Vec<String>,
    ) -> Result<Change> {
        // No prior config image is journaled: ordinary -> Secret must not duplicate plaintext.
        let current = Snapshot::read(owner)?;
        if current.revision != snapshot.revision {
            return Err(Error::StaleRevision);
        }
        if before_portable == files::digest(&snapshot.portable)
            && before_local == files::digest(&snapshot.local)
            && cleanup.is_empty()
        {
            return Ok(Change {
                owner_path: owner.directory.clone(),
                names,
                revision: snapshot.revision,
                portable_changed: false,
            });
        }
        let journal = Journal {
            version: 2,
            before_portable,
            before_local,
            portable: snapshot.portable,
            local: snapshot.local,
            names,
            cleanup,
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
        if journal.version != 2 {
            return Err(Error::UnsupportedVersion);
        }
        self.finish(owner, &journal).map(Some)
    }

    fn finish(&self, owner: &Owner, journal: &Journal) -> Result<Change> {
        let candidate = Snapshot::parse(owner, journal.portable.clone(), journal.local.clone())?;
        if journal.names.iter().any(|name| !valid_name(name))
            || (owner.global && journal.local != json!({}))
            || journal.cleanup.iter().any(|account| {
                !valid_ref(account)
                    || candidate
                        .device
                        .values()
                        .any(|e| e.secret_ref.as_ref() == Some(account))
            })
        {
            return Err(Error::InvalidConfig);
        }
        let portable = files::read(&owner.portable_path(), !owner.global)?;
        let local = if owner.global {
            json!({})
        } else {
            files::read(&owner.local_path(), false)?
        };
        let next_portable = files::digest(&journal.portable);
        let next_local = files::digest(&journal.local);
        if ![&journal.before_portable, &next_portable].contains(&&files::digest(&portable))
            || ![&journal.before_local, &next_local].contains(&&files::digest(&local))
        {
            return Err(Error::StaleRevision);
        }
        if files::digest(&portable) != next_portable {
            files::atomic_write(&owner.portable_path(), &journal.portable)?;
        }
        #[cfg(test)]
        if self.interrupt.get() == 2 {
            return Err(Error::PendingRecovery);
        }
        if !owner.global && files::digest(&local) != next_local {
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
        Ok(Change {
            owner_path: owner.directory.clone(),
            names: journal.names.clone(),
            revision: Revision(files::digest(&json!([journal.portable, journal.local]))),
            portable_changed: !owner.global && journal.before_portable != next_portable,
        })
    }
}
