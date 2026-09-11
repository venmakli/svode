//! Shared S3 bindings, local agent configuration and credential resolution.
use crate::variables::{self, Context, KeyringSecretStore, SecretStore, Service};
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
    pub global_directory: PathBuf,
    pub project_path: PathBuf,
    pub space_id: Option<String>,
}

impl AgentConfig {
    pub fn context(&self) -> Result<Context, String> {
        self.validate()?;
        Context::new(
            &self.project_path,
            self.space_id.as_deref(),
            &self.global_directory,
        )
        .map_err(|e| e.to_string())
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 2
            || !self.global_directory.is_absolute()
            || !self.project_path.is_absolute()
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
        let config: Self = serde_json::from_value(input).map_err(|_| SETUP_REQUIRED.to_string())?;
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
