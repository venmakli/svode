//! Shared S3 bindings, local agent configuration and credential resolution.
use crate::variables::{self, Context, KeyringSecretStore, SecretStore, Service, SourceOwner};
pub use crate::variables::{SecretPair as SecretBindings, SecretValues as Credentials};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
pub const CONFIG_REL: &str = ".svode/lfs-s3-agent.json";
pub const SETUP_REQUIRED: &str = "Configure S3 again: select two Secrets in Storage settings";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub version: u32,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub prefix: Option<String>,
    pub bindings: SecretBindings,
    pub library_directory: PathBuf,
    pub project_path: Option<PathBuf>,
    pub space_id: Option<String>,
}

impl AgentConfig {
    pub fn context(&self) -> Result<Context, String> {
        self.validate()?;
        match &self.project_path {
            Some(project) => {
                Context::new(project, self.space_id.as_deref(), &self.library_directory)
            }
            None => Context::library(&self.library_directory),
        }
        .map_err(|e| e.to_string())
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 2
            || !self.library_directory.is_absolute()
            || self.project_path.as_ref().is_some_and(|p| !p.is_absolute())
            || (self.project_path.is_none()
                && (self.space_id.is_some()
                    || self
                        .bindings
                        .roles()
                        .iter()
                        .any(|(_, r)| r.owner != SourceOwner::Library)))
            || self.endpoint.trim().is_empty()
            || self.bucket.trim().is_empty()
            || self.region.trim().is_empty()
            || self
                .bindings
                .roles()
                .iter()
                .any(|(_, r)| !variables::valid_name(&r.name))
        {
            return Err(SETUP_REQUIRED.into());
        }
        Ok(())
    }
    pub fn read(repo: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(repo.join(CONFIG_REL)).map_err(|_| SETUP_REQUIRED.to_string())?;
        let input: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| SETUP_REQUIRED.to_string())?;
        let config = match input.get("version").and_then(serde_json::Value::as_u64) {
            Some(1) => {
                let old =
                    variables::normalize_s3_v1(&input).map_err(|_| SETUP_REQUIRED.to_string())?;
                if old.catalog_path.file_name().and_then(|n| n.to_str()) != Some("settings.json") {
                    return Err(SETUP_REQUIRED.into());
                }
                Self {
                    version: 2,
                    endpoint: old.endpoint,
                    bucket: old.bucket,
                    region: old.region,
                    prefix: old.prefix,
                    bindings: old.bindings,
                    library_directory: old
                        .catalog_path
                        .parent()
                        .ok_or(SETUP_REQUIRED)?
                        .to_path_buf(),
                    project_path: None,
                    space_id: None,
                }
            }
            Some(2) => serde_json::from_value(input).map_err(|_| SETUP_REQUIRED.to_string())?,
            _ => return Err(SETUP_REQUIRED.into()),
        };
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

    pub fn resolve_with_store(&self, secrets: &dyn SecretStore) -> Result<Credentials, String> {
        Service::new(secrets)
            .resolve_secret_pair(&self.context()?, &self.bindings)
            .map_err(|e| {
                format!(
                    "S3 Access Key {} / Secret Key {}: {e}",
                    self.bindings.access_key.name, self.bindings.secret_key.name
                )
            })
    }
    pub fn resolve(&self) -> Result<Credentials, String> {
        self.resolve_with_store(&KeyringSecretStore)
    }
}
