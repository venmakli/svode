//! The Secret value store of the device: `SVODE_SECRET_<NAME>` over the one
//! active store of the OS account. The secrets file is active while it
//! exists, otherwise the system password store; values are never read from
//! the inactive one.

use super::{Error, Result, SecretStore};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// File name of the secrets file in the device config directory.
pub const SECRETS_FILE: &str = "secrets.json";
/// Serializes writers of the secrets file; separate from `variables.lock`.
pub const SECRETS_LOCK_FILE: &str = "secrets.lock";
/// Prefix of the environment variables that override a declared Secret.
pub const SECRET_ENVIRONMENT_PREFIX: &str = "SVODE_SECRET_";

const KEYCHAIN_SERVICE: &str = "app.svode.desktop.variables";
const FILE_VERSION: u64 = 1;

/// The store that holds Secret values on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreKind {
    System,
    File,
}

/// Path of the secrets file in the device config directory `config_dir`.
pub fn secrets_file(config_dir: &Path) -> PathBuf {
    config_dir.join(SECRETS_FILE)
}

/// Whether `key` names a Secret override, which processes Svode launches for
/// agents, Routines, Apps and terminals do not inherit.
pub fn is_secret_environment(key: &OsStr) -> bool {
    let Some(key) = key.to_str() else {
        return false;
    };
    let prefix = SECRET_ENVIRONMENT_PREFIX;
    key.len() > prefix.len()
        && if cfg!(windows) {
            key.get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        } else {
            key.starts_with(prefix)
        }
}

/// Secret overrides of this process that a child would inherit.
pub fn inherited_secret_environment() -> Vec<OsString> {
    std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| is_secret_environment(key))
        .collect()
}

/// Removes the Secret overrides `command` would pass to its process: the
/// inherited ones and those already set on it. Variables set afterwards stay.
pub fn strip_secret_environment(command: &mut std::process::Command) {
    let explicit: Vec<OsString> = command
        .get_envs()
        .map(|(key, _)| key.to_os_string())
        .filter(|key| is_secret_environment(key))
        .collect();
    for key in inherited_secret_environment().into_iter().chain(explicit) {
        command.env_remove(key);
    }
}

enum Environment {
    Process,
    Fixed(BTreeMap<String, String>),
}

/// The device store of Secret values for the device config directory.
pub struct DeviceSecretStore {
    config_dir: PathBuf,
    environment: Environment,
}

/// The active store of the device and the path of its secrets file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveStore {
    pub kind: StoreKind,
    pub file: PathBuf,
}

/// The active store, whether it can be used and how many values the file
/// holds. Values themselves are never part of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreStatus {
    pub kind: StoreKind,
    pub file: PathBuf,
    /// Why the active store cannot be used: `SecretStore` for the system
    /// store, `SecretFileUnsafe` or `SecretFileInvalid` for the file.
    pub problem: Option<Error>,
    /// Number of values in a usable file; the system store cannot list them.
    pub values: Option<usize>,
}

/// Result of turning the secrets file on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UseFile {
    /// An empty file was created; values were not moved from the system store.
    Created,
    /// The file already existed and was usable; nothing changed.
    AlreadyActive { values: usize },
}

/// Result of returning to the system store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UseSystem {
    /// No secrets file existed; nothing changed.
    AlreadyActive,
    /// The file was removed with the values it held.
    Restored { deleted_values: usize },
    /// The file holds values and was kept: they are removed only explicitly.
    HasValues { values: usize },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileImage {
    version: u64,
    values: BTreeMap<String, String>,
}

impl DeviceSecretStore {
    /// Store of the device config directory `config_dir`, with Secret
    /// overrides from this process environment.
    pub fn new(config_dir: &Path) -> Self {
        Self {
            config_dir: config_dir.to_path_buf(),
            environment: Environment::Process,
        }
    }

    /// Store of the install's device config directory
    /// ([`crate::runtime::device::config_dir`]); `None` without one.
    pub fn of_device() -> Option<Self> {
        Some(Self::new(&crate::runtime::device::config_dir()?))
    }

    /// Store with fixed Secret overrides `variables` instead of the process
    /// environment, for hosts and tests that must not read it.
    pub fn with_environment(
        config_dir: &Path,
        variables: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        Self {
            config_dir: config_dir.to_path_buf(),
            environment: Environment::Fixed(variables.into_iter().collect()),
        }
    }

    pub fn file(&self) -> PathBuf {
        secrets_file(&self.config_dir)
    }

    /// The active store: the file while anything exists at its path, a
    /// symbolic link or unsafe file included, so the file to fix is known.
    pub fn active(&self) -> ActiveStore {
        let file = self.file();
        ActiveStore {
            kind: if file_present(&file) {
                StoreKind::File
            } else {
                StoreKind::System
            },
            file,
        }
    }

    pub fn status(&self) -> StoreStatus {
        let ActiveStore { kind, file } = self.active();
        let (problem, values) = match kind {
            StoreKind::File => match read_file(&file) {
                Ok(Some(image)) => (None, Some(image.values.len())),
                Ok(None) => (None, Some(0)),
                Err(error) => (Some(error), None),
            },
            StoreKind::System => (system_probe().err(), None),
        };
        StoreStatus {
            kind,
            file,
            problem,
            values,
        }
    }

    /// Turns the secrets file on: creates an empty `0600` file in a `0700`
    /// directory. A usable existing file is left as it is; an unsafe or
    /// invalid one is refused and never repaired. Not available on Windows.
    #[cfg(unix)]
    pub fn use_file(&self) -> Result<UseFile> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let parent = self.config_dir.parent().ok_or(Error::Unavailable)?;
        fs::create_dir_all(parent).map_err(|_| Error::Unavailable)?;
        match fs::DirBuilder::new().mode(0o700).create(&self.config_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Error::Unavailable),
        }
        fs::set_permissions(&self.config_dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Unavailable)?;
        let _guard = self.lock()?;
        let file = self.file();
        if let Some(image) = read_file(&file)? {
            return Ok(UseFile::AlreadyActive {
                values: image.values.len(),
            });
        }
        write_file(&file, &BTreeMap::new(), false)?;
        Ok(UseFile::Created)
    }

    /// Returns to the system store by removing the secrets file. A file with
    /// values is kept unless `delete_values`; an unsafe or invalid file is
    /// refused unless `delete_values`, since its values cannot be counted.
    pub fn use_system(&self, delete_values: bool) -> Result<UseSystem> {
        let file = self.file();
        if !file_present(&file) {
            return Ok(UseSystem::AlreadyActive);
        }
        let _guard = self.lock()?;
        let values = match read_file(&file) {
            Ok(Some(image)) => image.values.len(),
            Ok(None) => return Ok(UseSystem::AlreadyActive),
            Err(error) if !delete_values => return Err(error),
            Err(_) => 0,
        };
        if values > 0 && !delete_values {
            return Ok(UseSystem::HasValues { values });
        }
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Unavailable),
        }
        super::files::sync(&self.config_dir)?;
        Ok(UseSystem::Restored {
            deleted_values: values,
        })
    }

    fn lock(&self) -> Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options
            .open(self.config_dir.join(SECRETS_LOCK_FILE))
            .map_err(|_| Error::SecretStore)?;
        file.lock().map_err(|_| Error::SecretStore)?;
        Ok(file)
    }

    /// Changes one value in the file under the file lock; `false` when no
    /// file exists, so the system store is the active one.
    fn change_file(&self, account: &str, value: Option<&str>) -> Result<bool> {
        let file = self.file();
        if !file_present(&file) {
            return Ok(false);
        }
        let _guard = self.lock()?;
        let Some(mut image) = read_file(&file)? else {
            return Ok(false);
        };
        let changed = match value {
            Some(value) => image.values.insert(account.into(), value.into()) != Some(value.into()),
            None => image.values.remove(account).is_some(),
        };
        if changed {
            write_file(&file, &image.values, true)?;
        }
        Ok(true)
    }
}

impl SecretStore for DeviceSecretStore {
    fn environment_value(&self, name: &str) -> Result<Option<String>> {
        let key = format!("{SECRET_ENVIRONMENT_PREFIX}{name}");
        let value = match &self.environment {
            Environment::Fixed(variables) => variables.get(&key).cloned(),
            Environment::Process => match std::env::var(&key) {
                Ok(value) => Some(value),
                Err(std::env::VarError::NotPresent) => None,
                // Set but unusable: the value is not looked up elsewhere.
                Err(std::env::VarError::NotUnicode(_)) => return Err(Error::Missing),
            },
        };
        Ok(value.filter(|value| !value.is_empty()))
    }

    fn get(&self, account: &str) -> Result<Option<String>> {
        match read_file(&self.file())? {
            Some(mut image) => Ok(image.values.remove(account)),
            None => system_get(account),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<()> {
        if self.change_file(account, Some(value))? {
            return Ok(());
        }
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| Error::SecretStore)
    }

    fn remove(&self, account: &str) -> Result<()> {
        if self.change_file(account, None)? {
            return Ok(());
        }
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|_| Error::SecretStore)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::SecretStore),
        }
    }
}

fn system_get(account: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|_| Error::SecretStore)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(Error::SecretStore),
    }
}

/// Reads an account that is never written, so only access is checked.
fn system_probe() -> Result<()> {
    system_get("secret:00000000000000000000000000").map(|_| ())
}

/// The file is the active store on Unix while anything exists at its path.
/// On Windows the file is never used: its access cannot be checked there.
fn file_present(file: &Path) -> bool {
    cfg!(unix)
        && match fs::symlink_metadata(file) {
            Ok(_) => true,
            Err(error) => error.kind() != io::ErrorKind::NotFound,
        }
}

/// The file image, `None` when no file exists. The access checks run on the
/// opened file, so a file swapped after the check is never read.
#[cfg(unix)]
fn read_file(file: &Path) -> Result<Option<FileImage>> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut opened = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(file)
    {
        Ok(opened) => opened,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error)
            if error.kind() == io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(libc::ELOOP) =>
        {
            return Err(Error::SecretFileUnsafe);
        }
        Err(_) => return Err(Error::SecretStore),
    };
    let metadata = opened.metadata().map_err(|_| Error::SecretStore)?;
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let user = unsafe { libc::geteuid() };
    if !metadata.is_file() || metadata.uid() != user || metadata.mode() & 0o077 != 0 {
        return Err(Error::SecretFileUnsafe);
    }
    let mut bytes = Vec::new();
    opened
        .read_to_end(&mut bytes)
        .map_err(|_| Error::SecretStore)?;
    parse(&bytes).map(Some)
}

#[cfg(not(unix))]
fn read_file(_: &Path) -> Result<Option<FileImage>> {
    Ok(None)
}

#[cfg(unix)]
fn parse(bytes: &[u8]) -> Result<FileImage> {
    use super::service::valid_ref;
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| Error::SecretFileInvalid)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(FILE_VERSION) {
        return Err(Error::SecretFileInvalid);
    }
    let image: FileImage = serde_json::from_value(value).map_err(|_| Error::SecretFileInvalid)?;
    if image.values.keys().any(|account| !valid_ref(account)) {
        return Err(Error::SecretFileInvalid);
    }
    Ok(image)
}

/// Writes the whole file atomically with `0600`; `replace` is false only
/// when creating it, so an existing path is never overwritten then.
fn write_file(file: &Path, values: &BTreeMap<String, String>, replace: bool) -> Result<()> {
    let directory = file.parent().ok_or(Error::Unavailable)?;
    let image = FileImage {
        version: FILE_VERSION,
        values: values.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&image).map_err(|_| Error::SecretStore)?;
    // `tempfile` creates the staged file with `0600` on Unix.
    let mut staged = tempfile::Builder::new()
        .prefix("secrets.tmp-")
        .tempfile_in(directory)
        .map_err(|_| Error::SecretStore)?;
    staged
        .write_all(&bytes)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| Error::SecretStore)?;
    if replace {
        staged.persist(file).map_err(|_| Error::SecretStore)?;
    } else {
        staged
            .persist_noclobber(file)
            .map_err(|_| Error::SecretFileUnsafe)?;
    }
    super::files::sync(directory)
}

#[cfg(test)]
#[path = "device_tests.rs"]
mod tests;
