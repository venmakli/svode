//! Installed speech models: device-local application data, outside Git,
//! projects and portable state.
//!
//! ```text
//! <root>/models/<id>/<file>        the model file of the catalog
//! <root>/models/<id>/model.json    which catalog file it is
//! <root>/models/.staging-<id>/     an install in progress
//! <root>/settings.json             the active model and the measurements
//! ```
//!
//! An install writes the file into a staging directory, checks its size and
//! SHA-256 against the catalog and only then puts the directory in place, so
//! a failure, a cancel or a wrong hash leaves the previous state: no model,
//! or the previous file of an updated one. Several models may be installed;
//! one is active.

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::catalog::{Catalog, CatalogModel};
use crate::protocol::Backend;

const MANIFEST: &str = "model.json";
const STAGING: &str = ".staging-";
const REPLACED: &str = ".replaced-";
const REMOVED: &str = ".removed-";

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("the catalog has no model {0}")]
    UnknownModel(String),
    #[error("model {0} is not installed")]
    NotInstalled(String),
    #[error("model {0} is already installed")]
    AlreadyInstalled(String),
    #[error("model {0} is being installed")]
    Busy(String),
    /// The file does not match the catalog: wrong size or SHA-256.
    #[error("downloaded model does not match the catalog")]
    Integrity,
    #[error("model files: {0}")]
    Disk(#[from] io::Error),
}

/// One installed model, as its manifest records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

/// How an installed model stands against the catalog of this release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Installation {
    /// The file of the catalog.
    Current,
    /// The release replaced the file; the installed one works until the
    /// user updates it.
    Outdated,
    /// The release dropped the model: it can only be removed.
    Unsupported,
}

/// How long a model took to recognize the reference recording after it was
/// prepared. Device-local.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub seconds: f64,
    pub backend: Backend,
    /// The Svode version it was measured with.
    pub version: String,
}

impl Measurement {
    /// A measurement holds until a Svode update, and one made on a GPU
    /// until the device refuses acceleration.
    pub fn is_current(&self, version: &str, acceleration_refused: bool) -> bool {
        self.version == version && !(acceleration_refused && self.backend.is_accelerated())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    pub active_model: Option<String>,
    #[serde(default)]
    pub measurements: BTreeMap<String, Measurement>,
}

pub struct ModelStore {
    root: PathBuf,
    settings: Mutex<()>,
    installing: Arc<Mutex<HashSet<String>>>,
}

impl ModelStore {
    /// Opens the store at `root` and finishes what an interrupted install or
    /// removal left behind.
    pub fn open(root: PathBuf) -> Self {
        let store = Self {
            root,
            settings: Mutex::new(()),
            installing: Arc::default(),
        };
        if let Err(error) = store.recover() {
            tracing::warn!("failed to recover speech model files: {error}");
        }
        store
    }

    pub fn model_dir(&self, id: &str) -> PathBuf {
        self.models_dir().join(id)
    }

    pub fn model_path(&self, model: &InstalledModel) -> PathBuf {
        self.model_dir(&model.id).join(&model.file)
    }

    pub fn installed(&self) -> Vec<InstalledModel> {
        let Ok(entries) = std::fs::read_dir(self.models_dir()) else {
            return Vec::new();
        };
        let mut models: Vec<_> = entries
            .flatten()
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|entry| read_manifest(&entry.path()))
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models
    }

    pub fn installation(model: &InstalledModel, catalog: &Catalog) -> Installation {
        match catalog.get(&model.id) {
            None => Installation::Unsupported,
            Some(entry) if entry.sha256 == model.sha256 => Installation::Current,
            Some(_) => Installation::Outdated,
        }
    }

    pub fn settings(&self) -> ModelSettings {
        let _guard = self.settings.lock().expect("speech settings lock");
        self.read_settings()
    }

    /// The active model, when it is installed and the catalog still
    /// supports it.
    pub fn active(&self, catalog: &Catalog) -> Option<InstalledModel> {
        let id = self.settings().active_model?;
        catalog.get(&id)?;
        read_manifest(&self.model_dir(&id))
    }

    pub fn activate(&self, id: &str, catalog: &Catalog) -> Result<(), ModelError> {
        if catalog.get(id).is_none() {
            return Err(ModelError::UnknownModel(id.to_string()));
        }
        if read_manifest(&self.model_dir(id)).is_none() {
            return Err(ModelError::NotInstalled(id.to_string()));
        }
        self.update_settings(|settings| settings.active_model = Some(id.to_string()))
    }

    pub fn record_measurement(&self, id: &str, measurement: Measurement) -> Result<(), ModelError> {
        self.update_settings(|settings| {
            settings.measurements.insert(id.to_string(), measurement);
        })
    }

    /// Starts installing the catalog file of `model`: a model that is not
    /// installed yet, or an update of an outdated one.
    pub fn begin_install(&self, model: &CatalogModel) -> Result<Install<'_>, ModelError> {
        if read_manifest(&self.model_dir(&model.id))
            .is_some_and(|installed| installed.sha256 == model.sha256)
        {
            return Err(ModelError::AlreadyInstalled(model.id.clone()));
        }
        if !self
            .installing
            .lock()
            .expect("speech installs lock")
            .insert(model.id.clone())
        {
            return Err(ModelError::Busy(model.id.clone()));
        }
        let claim = InstallClaim {
            id: model.id.clone(),
            installing: self.installing.clone(),
        };
        let staging = self.models_dir().join(format!("{STAGING}{}", model.id));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        let file = std::fs::File::create(staging.join(&model.file))?;
        Ok(Install {
            models_dir: self.models_dir(),
            store: self,
            model: model.clone(),
            staging,
            file: Some(tokio::fs::File::from_std(file)),
            hasher: Sha256::new(),
            received: 0,
            _claim: claim,
        })
    }

    /// Removes the files of model `id` and nothing else; removing the
    /// active model leaves no active model.
    pub fn delete(&self, id: &str) -> Result<(), ModelError> {
        let dir = self.model_dir(id);
        if read_manifest(&dir).is_none() {
            return Err(ModelError::NotInstalled(id.to_string()));
        }
        let removed = self.models_dir().join(format!("{REMOVED}{id}"));
        let _ = std::fs::remove_dir_all(&removed);
        std::fs::rename(&dir, &removed)?;
        self.update_settings(|settings| {
            if settings.active_model.as_deref() == Some(id) {
                settings.active_model = None;
            }
            settings.measurements.remove(id);
        })?;
        if let Err(error) = std::fs::remove_dir_all(&removed) {
            tracing::warn!("failed to remove speech model files: {error}");
        }
        Ok(())
    }

    fn models_dir(&self) -> PathBuf {
        self.root.join("models")
    }

    fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    fn read_settings(&self) -> ModelSettings {
        std::fs::read(self.settings_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn update_settings(&self, change: impl FnOnce(&mut ModelSettings)) -> Result<(), ModelError> {
        let _guard = self.settings.lock().expect("speech settings lock");
        let mut settings = self.read_settings();
        change(&mut settings);
        write_atomically(
            &self.settings_path(),
            &serde_json::to_vec_pretty(&settings).map_err(io::Error::other)?,
        )?;
        Ok(())
    }

    fn recover(&self) -> io::Result<()> {
        let Ok(entries) = std::fs::read_dir(self.models_dir()) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with(STAGING) || name.starts_with(REMOVED) {
                std::fs::remove_dir_all(&path)?;
            } else if let Some(id) = name.strip_prefix(REPLACED) {
                // Interrupted between the two renames of an update: keep the
                // new directory if it is in place, else bring the old one back.
                let dir = self.model_dir(id);
                if dir.exists() {
                    std::fs::remove_dir_all(&path)?;
                } else {
                    std::fs::rename(&path, &dir)?;
                }
            }
        }
        Ok(())
    }
}

/// An install in progress. Dropping it without [`Install::finish`] (a
/// cancel or a failed download) removes what it wrote.
pub struct Install<'a> {
    models_dir: PathBuf,
    store: &'a ModelStore,
    model: CatalogModel,
    staging: PathBuf,
    file: Option<tokio::fs::File>,
    hasher: Sha256,
    received: u64,
    _claim: InstallClaim,
}

impl Install<'_> {
    pub fn model(&self) -> &CatalogModel {
        &self.model
    }

    pub fn received(&self) -> u64 {
        self.received
    }

    pub async fn write(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        self.received += chunk.len() as u64;
        if self.received > self.model.size {
            return Err(ModelError::Integrity);
        }
        self.hasher.update(chunk);
        let file = self.file.as_mut().expect("file open until finish");
        file.write_all(chunk).await?;
        Ok(())
    }

    /// Checks the file against the catalog and puts it in place. A model
    /// that was not installed before becomes the active one: the user chose
    /// it by downloading it. An update keeps the active model and drops the
    /// measurement of the replaced file.
    pub async fn finish(mut self) -> Result<InstalledModel, ModelError> {
        let mut file = self.file.take().expect("file open until finish");
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        let digest = hex(&std::mem::take(&mut self.hasher).finalize());
        if self.received != self.model.size || digest != self.model.sha256 {
            return Err(ModelError::Integrity);
        }
        let installed = InstalledModel {
            id: self.model.id.clone(),
            file: self.model.file.clone(),
            sha256: digest,
            size: self.received,
        };
        std::fs::write(
            self.staging.join(MANIFEST),
            serde_json::to_vec_pretty(&installed).map_err(io::Error::other)?,
        )?;
        let dir = self.models_dir.join(&installed.id);
        let update = dir.exists();
        if update {
            let replaced = self.models_dir.join(format!("{REPLACED}{}", installed.id));
            let _ = std::fs::remove_dir_all(&replaced);
            std::fs::rename(&dir, &replaced)?;
            if let Err(error) = std::fs::rename(&self.staging, &dir) {
                std::fs::rename(&replaced, &dir)?;
                return Err(error.into());
            }
            if let Err(error) = std::fs::remove_dir_all(&replaced) {
                tracing::warn!("failed to remove the replaced speech model file: {error}");
            }
        } else {
            std::fs::rename(&self.staging, &dir)?;
        }
        self.store.update_settings(|settings| {
            settings.measurements.remove(&installed.id);
            if !update {
                settings.active_model = Some(installed.id.clone());
            }
        })?;
        Ok(installed)
    }
}

impl Drop for Install<'_> {
    fn drop(&mut self) {
        drop(self.file.take());
        if self.staging.exists() {
            let _ = std::fs::remove_dir_all(&self.staging);
        }
    }
}

struct InstallClaim {
    id: String,
    installing: Arc<Mutex<HashSet<String>>>,
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        if let Ok(mut installing) = self.installing.lock() {
            installing.remove(&self.id);
        }
    }
}

fn read_manifest(dir: &Path) -> Option<InstalledModel> {
    let bytes = std::fs::read(dir.join(MANIFEST)).ok()?;
    let model: InstalledModel = serde_json::from_slice(&bytes).ok()?;
    dir.join(&model.file).is_file().then_some(model)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, bytes)?;
    std::fs::rename(&partial, path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
