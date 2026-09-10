//! Shared S3 bindings, local agent configuration and credential resolution.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const VARIABLES_SERVICE: &str = "app.svode.desktop.variables";
pub const CONFIG_REL: &str = ".svode/lfs-s3-agent.json";
pub const SETUP_REQUIRED: &str = "Configure S3 again: select two Secrets in Storage settings";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretBindings {
    pub access_key: String,
    pub secret_key: String,
}

impl SecretBindings {
    pub fn roles(&self) -> [(&'static str, &str); 2] {
        [
            ("Access Key", &self.access_key),
            ("Secret Key", &self.secret_key),
        ]
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub version: u32,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: Option<String>,
    pub bindings: SecretBindings,
    pub catalog_path: PathBuf,
}

// Deliberately neither Debug nor Serialize: this is a session-only snapshot.
pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
}

pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl AgentConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || !self.catalog_path.is_absolute()
            || self.endpoint.trim().is_empty()
            || self.bucket.trim().is_empty()
            || self.region.trim().is_empty()
            || self
                .bindings
                .roles()
                .iter()
                .any(|(_, name)| !valid_name(name))
        {
            return Err(SETUP_REQUIRED.into());
        }
        Ok(())
    }

    pub fn read(repo: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(repo.join(CONFIG_REL)).map_err(|_| SETUP_REQUIRED.to_string())?;
        let config: Self =
            serde_json::from_slice(&bytes).map_err(|_| SETUP_REQUIRED.to_string())?;
        config.validate()?;
        Ok(config)
    }

    pub fn write(&self, repo: &Path) -> Result<(), String> {
        self.validate()?;
        let path = repo.join(CONFIG_REL);
        let parent = path.parent().expect("config parent");
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot prepare S3 config: {e}"))?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| format!("Cannot stage S3 config: {e}"))?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| SETUP_REQUIRED.to_string())?;
        staged
            .write_all(&bytes)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|e| format!("Cannot write S3 config: {e}"))?;
        staged
            .persist(path)
            .map_err(|e| format!("Cannot publish S3 config: {}", e.error))?;
        Ok(())
    }

    pub fn resolve_with(
        &self,
        get: impl FnMut(&str) -> Result<Option<String>, String>,
    ) -> Result<Credentials, String> {
        self.validate()?;
        let catalog = std::fs::read(&self.catalog_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(|| format!("{SETUP_REQUIRED}; Variables catalog is unavailable"))?;
        resolve_pair(&self.bindings, &catalog, get)
    }

    pub fn resolve(&self) -> Result<Credentials, String> {
        self.resolve_with(read_secret)
    }
}

pub fn read_secret(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(VARIABLES_SERVICE, name)
        .map_err(|_| "Keychain is unavailable".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Keychain access failed".into()),
    }
}

pub fn resolve_pair(
    bindings: &SecretBindings,
    catalog: &serde_json::Value,
    mut get: impl FnMut(&str) -> Result<Option<String>, String>,
) -> Result<Credentials, String> {
    for (role, name) in bindings.roles() {
        if !valid_name(name)
            || catalog
                .get("variables")
                .and_then(|v| v.get("entries"))
                .and_then(|v| v.get(name))
                .and_then(|v| v.get("kind"))
                .and_then(|v| v.as_str())
                != Some("secret")
        {
            return Err(format!("S3 {role}: {name} is missing or is not a Secret"));
        }
    }
    let mut resolve = |role: &str, name: &str| {
        get(name)
            .map_err(|_| format!("S3 {role}: cannot access Keychain for {name}"))?
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("S3 {role}: Secret {name} has no value"))
    };
    let access_key = resolve("Access Key", &bindings.access_key)?;
    let secret_key = if bindings.access_key == bindings.secret_key {
        access_key.clone()
    } else {
        resolve("Secret Key", &bindings.secret_key)?
    };
    Ok(Credentials {
        access_key,
        secret_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bindings() -> SecretBindings {
        SecretBindings {
            access_key: "ACCESS".into(),
            secret_key: "SECRET".into(),
        }
    }

    fn catalog() -> serde_json::Value {
        json!({"variables": {"entries": {"ACCESS": {"kind": "secret"}, "SECRET": {"kind": "secret"}}}})
    }

    #[test]
    fn validates_both_kinds_before_reading_any_values() {
        for kind in [json!("variable"), json!(null), json!("future")] {
            let mut catalog = catalog();
            catalog["variables"]["entries"]["SECRET"]["kind"] = kind;
            let error = resolve_pair(&bindings(), &catalog, |_| panic!("must not read Keychain"))
                .err()
                .unwrap();
            assert!(error.contains("Secret Key") && error.contains("SECRET"));
        }
    }

    #[test]
    fn missing_empty_and_denied_secrets_never_resolve_or_expose_values() {
        for bad in [
            Ok(None),
            Ok(Some(String::new())),
            Ok(Some("  ".into())),
            Err("sensitive diagnostic".into()),
        ] {
            let error = resolve_pair(&bindings(), &catalog(), |name| {
                if name == "ACCESS" {
                    Ok(Some("private-access".into()))
                } else {
                    bad.clone()
                }
            })
            .err()
            .unwrap();
            assert!(error.contains("Secret Key") && error.contains("SECRET"));
            assert!(!error.contains("private-access") && !error.contains("sensitive diagnostic"));
        }
    }

    #[test]
    fn shared_source_is_read_once_per_snapshot() {
        let bindings = SecretBindings {
            access_key: "ACCESS".into(),
            secret_key: "ACCESS".into(),
        };
        let mut reads = 0;
        let resolved = resolve_pair(&bindings, &catalog(), |_| {
            reads += 1;
            Ok(Some("shared".into()))
        })
        .unwrap();
        assert_eq!(reads, 1);
        assert_eq!(resolved.access_key, resolved.secret_key);
    }

    #[test]
    fn new_sessions_observe_rotation_and_catalog_changes_without_desktop() {
        let dir = tempfile::tempdir().unwrap();
        let catalog_path = dir.path().join("settings.json");
        std::fs::write(&catalog_path, catalog().to_string()).unwrap();
        let config = AgentConfig {
            version: 1,
            endpoint: "https://s3.test".into(),
            bucket: "bucket".into(),
            region: "region".into(),
            prefix: Some("same/objects".into()),
            bindings: bindings(),
            catalog_path: catalog_path.clone(),
        };
        config.write(dir.path()).unwrap();
        let config = AgentConfig::read(dir.path()).unwrap();
        let old = config.resolve_with(|_| Ok(Some("first".into()))).unwrap();
        let next = config.resolve_with(|_| Ok(Some("rotated".into()))).unwrap();
        assert_eq!(old.secret_key, "first");
        assert_eq!(next.secret_key, "rotated");
        std::fs::write(catalog_path, "{}").unwrap();
        assert!(
            config
                .resolve_with(|_| panic!("orphaned Keychain value must not be read"))
                .is_err()
        );
        let source = std::fs::read_to_string(dir.path().join(CONFIG_REL)).unwrap();
        assert!(
            !source.contains("first")
                && !source.contains("rotated")
                && !source.contains("keychainAccount")
        );
    }

    #[test]
    fn old_corrupt_and_future_configs_require_setup() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".svode")).unwrap();
        for source in ["{", r#"{"keychainAccount":"old"}"#, r#"{"version":2}"#] {
            std::fs::write(dir.path().join(CONFIG_REL), source).unwrap();
            assert_eq!(AgentConfig::read(dir.path()).unwrap_err(), SETUP_REQUIRED);
        }
    }

    #[test]
    fn failed_publication_does_not_leave_a_partial_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AgentConfig {
            version: 1,
            endpoint: "https://s3.test".into(),
            bucket: "bucket".into(),
            region: "region".into(),
            prefix: None,
            bindings: bindings(),
            catalog_path: dir.path().join("settings.json"),
        };
        config.write(dir.path()).unwrap();
        let old = AgentConfig::read(dir.path()).unwrap();
        config.bindings.secret_key = String::new();
        assert!(config.write(dir.path()).is_err());
        assert_eq!(AgentConfig::read(dir.path()).unwrap(), old);
        config.bindings = bindings();
        let blocked = dir.path().join("blocked");
        std::fs::create_dir_all(blocked.join(CONFIG_REL)).unwrap();
        assert!(config.write(&blocked).is_err());
        assert_eq!(
            std::fs::read_dir(blocked.join(".svode")).unwrap().count(),
            1
        );
    }
}
