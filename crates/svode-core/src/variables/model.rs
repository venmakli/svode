use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub const KEYCHAIN_SERVICE: &str = "app.svode.desktop.variables";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Variable,
    Secret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Local,
    Git,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase", deny_unknown_fields)]
pub enum SourceOwner {
    Project,
    Space { id: String },
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReference {
    pub owner: SourceOwner,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    InvalidConfig,
    UnsupportedVersion,
    InvalidOwner,
    InvalidName,
    InvalidValue,
    StaleRevision,
    Collision,
    PendingRecovery,
    Missing,
    WrongKind,
    SecretStore,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never include config contents, values, or provider diagnostics.
        f.write_str(match self {
            Self::Unavailable => "Variables storage is unavailable",
            Self::InvalidConfig => "Variables configuration is invalid",
            Self::UnsupportedVersion => "Unsupported Variables version",
            Self::InvalidOwner => "Variables owner is unavailable or outside this context",
            Self::InvalidName => "Variable names must match [A-Za-z_][A-Za-z0-9_]*",
            Self::InvalidValue => "An explicit value is required for this transition",
            Self::StaleRevision => "Variables changed; reload before saving",
            Self::Collision => "Local and Git declarations conflict; select which to keep",
            Self::PendingRecovery => "A Variables change needs recovery before reading or saving",
            Self::Missing => "Variable value is missing",
            Self::WrongKind => "This source is not a Secret",
            Self::SecretStore => "Cannot access the Variables secret store",
        })
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    fn remove(&self, account: &str) -> Result<()>;
}

pub struct KeyringSecretStore;
impl SecretStore for KeyringSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>> {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|_| Error::SecretStore)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::SecretStore),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| Error::SecretStore)
    }
    fn remove(&self, account: &str) -> Result<()> {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|_| Error::SecretStore)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::SecretStore),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub mode: Mode,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub has_value: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub revision: Revision,
    pub entries: Vec<Entry>,
    pub collisions: Vec<String>,
}

// Write inputs and runtime values deliberately implement neither Debug nor Serialize.
pub struct Save {
    pub name: String,
    pub mode: Mode,
    pub kind: Kind,
    pub value: Option<String>,
    pub revision: Revision,
    pub operation: SaveOperation,
    /// Explicitly choose the declaration to retain in a local/Git collision.
    pub keep: Option<Mode>,
}

#[derive(Clone)]
pub struct Resolved {
    pub source: SourceReference,
    pub kind: Kind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub owner_path: PathBuf,
    pub names: Vec<String>,
    pub revision: Revision,
    pub portable_changed: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SaveOperation {
    Create,
    Edit,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

pub(crate) type Section = BTreeMap<String, StoredEntry>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretPair {
    pub access_key: SourceReference,
    pub secret_key: SourceReference,
}

impl SecretPair {
    pub fn roles(&self) -> [(&'static str, &SourceReference); 2] {
        [
            ("Access Key", &self.access_key),
            ("Secret Key", &self.secret_key),
        ]
    }
}
