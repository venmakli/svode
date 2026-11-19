//! Shared S3 bindings, local agent configuration and credential resolution.
use super::config::AssetsS3Config;
use crate::variables::{self, Context, DeviceSecretStore, SecretStore, Service};
pub use crate::variables::{SecretPair as SecretBindings, SecretValues as Credentials};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
pub const CONFIG_REL: &str = ".svode/lfs-s3-agent.json";

/// Log targets of the S3 request signer, whose debug events print the
/// credentials they sign with. Every process log filter turns them off,
/// whatever `RUST_LOG` asks for, so a Secret value never reaches a log.
pub const CREDENTIAL_LOG_TARGETS: [&str; 2] = ["reqsign_core", "reqsign_aws_v4"];

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
    /// Saved agent config of `repo` for the current S3 `target`; a config
    /// written for another target needs setup again.
    pub fn read_for_target(repo: &Path, target: &AssetsS3Config) -> Result<Self, String> {
        let config = Self::read(repo)?;
        if config.endpoint != target.endpoint
            || config.bucket != target.bucket
            || config.region != target.region
            || config.prefix.as_deref() != Some(target.prefix.as_str())
        {
            return Err(SETUP_REQUIRED.into());
        }
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
    /// Credentials from the device store of the config directory the
    /// bindings were made in, which also holds the Global catalog.
    pub fn resolve(&self) -> Result<Credentials, String> {
        self.resolve_with_store(&DeviceSecretStore::new(&self.global_directory))
    }

    /// [`resolve`](Self::resolve) with the failure as the Secret a refusal
    /// names: its Variables error, the binding name and the secrets file of
    /// the device store.
    pub fn resolve_or_refuse(&self) -> Result<Credentials, SecretFailure> {
        let secrets = DeviceSecretStore::new(&self.global_directory);
        let file = secrets.file();
        let failure = |error, name: &str| SecretFailure {
            error,
            name: name.to_string(),
            file: file.clone(),
        };
        let context = self.context().map_err(|_| {
            failure(
                variables::Error::InvalidConfig,
                &self.bindings.access_key.name,
            )
        })?;
        let service = Service::new(&secrets);
        service
            .resolve_secret_pair(&context, &self.bindings)
            .map_err(|error| {
                // The pair fails as a whole; the access key alone tells
                // which binding the next step has to name.
                let access = SecretBindings {
                    access_key: self.bindings.access_key.clone(),
                    secret_key: self.bindings.access_key.clone(),
                };
                match service.resolve_secret_pair(&context, &access) {
                    Ok(_) => failure(error, &self.bindings.secret_key.name),
                    Err(error) => failure(error, &self.bindings.access_key.name),
                }
            })
    }

    /// Agent config of `bindings` for the S3 `target` of a storage scope:
    /// resolved from the Variables catalog of `catalog_dir`, the device config
    /// directory, in the context of `project_path` and `space_id`.
    pub fn for_target(
        catalog_dir: &Path,
        project_path: &Path,
        space_id: Option<&str>,
        target: &AssetsS3Config,
        bindings: SecretBindings,
    ) -> Self {
        Self {
            version: 2,
            endpoint: target.endpoint.clone(),
            bucket: target.bucket.clone(),
            region: target.region.clone(),
            prefix: Some(target.prefix.clone()),
            bindings,
            global_directory: catalog_dir.to_path_buf(),
            project_path: project_path.to_path_buf(),
            space_id: space_id.map(str::to_string),
        }
    }

    /// Agent config for `target` whose bindings resolve from `secrets`.
    pub fn prepare(
        catalog_dir: &Path,
        project_path: &Path,
        space_id: Option<&str>,
        target: &AssetsS3Config,
        bindings: SecretBindings,
        secrets: &dyn SecretStore,
    ) -> Result<Self, String> {
        let config = Self::for_target(catalog_dir, project_path, space_id, target, bindings);
        config.resolve_with_store(secrets)?;
        Ok(config)
    }

    /// Publish the config to `repo` once its bindings still resolve: the
    /// repository is recorded as an S3 owner of the catalog first, then the
    /// config is written atomically. Usage stores only the owner location;
    /// both roles are always read from the one published config, also after
    /// a failure.
    pub fn publish(
        &self,
        catalog_dir: &Path,
        repo: &Path,
        secrets: &dyn SecretStore,
    ) -> Result<(), String> {
        self.resolve_with_store(secrets)?;
        register_owner(catalog_dir, repo).map_err(|error| error.to_string())?;
        self.write(repo)
    }
}

/// A Secret of the S3 bindings that cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretFailure {
    pub error: variables::Error,
    /// Name of the binding whose value is missing or unreadable.
    pub name: String,
    /// Secrets file of the device store that resolved it.
    pub file: PathBuf,
}

/// Device settings key listing the repositories whose agent config binds
/// Secrets of this catalog.
const S3_OWNERS_KEY: &str = "s3VariableOwners";

/// Record `owner` as a repository whose S3 agent config uses Secrets of the
/// catalog in `catalog_dir`, under the Variables lock of the catalog.
pub fn register_owner(catalog_dir: &Path, owner: &Path) -> variables::Result<()> {
    let _guard = variables::files::lock(catalog_dir)?;
    variables::files::check_pending(catalog_dir)?;
    let path = catalog_dir.join("settings.json");
    let mut root = variables::files::read(&path, false)?;
    let mut owners = owners_in(&root)?;
    if owners.insert(owner.to_path_buf()) {
        root[S3_OWNERS_KEY] =
            serde_json::to_value(owners).map_err(|_| variables::Error::InvalidConfig)?;
        variables::files::atomic_write(&path, &root)?;
    }
    Ok(())
}

/// Repositories recorded by [`register_owner`] in the catalog of
/// `catalog_dir`.
pub fn owners(catalog_dir: &Path) -> variables::Result<BTreeSet<PathBuf>> {
    owners_in(&variables::files::read(
        &catalog_dir.join("settings.json"),
        false,
    )?)
}

fn owners_in(root: &serde_json::Value) -> variables::Result<BTreeSet<PathBuf>> {
    root.get(S3_OWNERS_KEY)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| variables::Error::InvalidConfig)
        .map(Option::unwrap_or_default)
}

/// OpenDAL operator of an S3 target with resolved credentials.
pub fn operator(
    endpoint: &str,
    bucket: &str,
    region: &str,
    credentials: &Credentials,
) -> Result<opendal::Operator, String> {
    let builder = opendal::services::S3::default()
        .bucket(bucket)
        .region(region)
        .endpoint(endpoint)
        .access_key_id(&credentials.access_key)
        .secret_access_key(&credentials.secret_key);
    opendal::Operator::new(builder).map_err(|e| format!("opendal build: {e}"))
}

/// Real S3 connection check with both credential roles: writes a small probe
/// object under `.svode-probe/`, reads it back and deletes it. `op.check()`
/// is not used, since it lists the root and trips on buckets that disallow
/// listing.
pub async fn check_connection(
    endpoint: &str,
    bucket: &str,
    region: &str,
    credentials: &Credentials,
) -> Result<(), String> {
    const PROBE: &[u8] = b"svode-probe";
    let op = operator(endpoint, bucket, region, credentials)?;
    let probe_key = format!(
        ".svode-probe/{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S%f")
    );
    op.write(&probe_key, PROBE.to_vec())
        .await
        .map_err(|e| format!("S3 probe write failed: {e}"))?;
    let read = op.read(&probe_key).await.map(|buffer| buffer.to_vec());
    let deleted = op.delete(&probe_key).await;
    if read.ok().as_deref() != Some(PROBE) {
        return Err(
            "S3 probe object missing after write — bucket likely misconfigured".to_string(),
        );
    }
    deleted.map_err(|e| format!("S3 probe delete failed: {e}"))
}
