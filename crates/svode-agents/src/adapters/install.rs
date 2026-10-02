use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use svode_core::agent_adapters::AgentAdapterKind;
use tokio::sync::Mutex;

use super::{AdapterError, AdapterPin, PackageSource};

/// Written last into a complete installation; a version directory without
/// it is not an installation.
const MARKER: &str = "svode-adapter.json";
const STAGING_PREFIX: &str = ".staging-";
const TRASH_PREFIX: &str = ".trash-";

#[derive(Debug, Deserialize)]
struct Manifest {
    packages: Vec<ManifestPackage>,
}

#[derive(Debug, Deserialize)]
struct ManifestPackage {
    path: String,
    resolved: String,
    integrity: String,
    #[serde(default)]
    optional: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    package: String,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AdapterInstallState {
    NotInstalled,
    Installed {
        version: String,
    },
    /// Another version than the current pin: the agent is not ready for
    /// chat until the adapter is updated.
    NeedsUpdate {
        installed_version: String,
    },
}

/// An installation of the current pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledAdapter {
    pub version: String,
    pub dir: PathBuf,
    /// The adapter's bin script, run by Node.js.
    pub entry: PathBuf,
}

/// Adapters installed under a device-local directory the host chooses,
/// one directory per agent and version, outside projects and other
/// clients' installations. The directory itself is the installed state.
pub struct AdapterStore {
    root: PathBuf,
    /// One install, update or removal at a time.
    lock: Mutex<()>,
}

impl AdapterStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            lock: Mutex::new(()),
        }
    }

    pub fn state(&self, pin: &AdapterPin) -> AdapterInstallState {
        let versions = installed_versions(&self.agent_dir(pin.agent), pin.package);
        if versions.iter().any(|version| version == pin.version) {
            AdapterInstallState::Installed {
                version: pin.version.to_string(),
            }
        } else if let Some(version) = versions.into_iter().next() {
            AdapterInstallState::NeedsUpdate {
                installed_version: version,
            }
        } else {
            AdapterInstallState::NotInstalled
        }
    }

    /// The installation of the current pin, if there is one.
    pub fn installed(&self, pin: &AdapterPin) -> Option<InstalledAdapter> {
        match self.state(pin) {
            AdapterInstallState::Installed { .. } => {
                let dir = self.agent_dir(pin.agent).join(pin.version);
                let entry = entry_path(&dir, pin);
                entry.is_file().then(|| InstalledAdapter {
                    version: pin.version.to_string(),
                    dir,
                    entry,
                })
            }
            _ => None,
        }
    }

    /// Installs the pinned tree beside the current installation and
    /// switches to it atomically; the previous version is removed after
    /// the switch. Any failure leaves the previous state. Package scripts
    /// are never run and optional packages (agents' platform binaries) are
    /// never installed.
    pub async fn install(
        &self,
        pin: &AdapterPin,
        source: &dyn PackageSource,
    ) -> Result<InstalledAdapter, AdapterError> {
        let _guard = self.lock.lock().await;
        let manifest = parse_manifest(pin)?;
        let agent_dir = self.agent_dir(pin.agent);
        fs::create_dir_all(&agent_dir)?;
        remove_leftovers(&agent_dir);
        let staging = agent_dir.join(format!("{STAGING_PREFIX}{}", ulid::Ulid::new()));
        if let Err(error) = fill(&staging, pin, &manifest, source).await {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let dir = switch(&agent_dir, &staging, pin.version)?;
        remove_other_versions(&agent_dir, pin.version);
        Ok(InstalledAdapter {
            version: pin.version.to_string(),
            entry: entry_path(&dir, pin),
            dir,
        })
    }

    /// Removes every file Svode manages for the agent's adapter and nothing
    /// else. Returns whether there was anything to remove.
    pub async fn uninstall(&self, agent: AgentAdapterKind) -> Result<bool, AdapterError> {
        let _guard = self.lock.lock().await;
        remove_leftovers(&self.root);
        let agent_dir = self.agent_dir(agent);
        if !agent_dir.exists() {
            return Ok(false);
        }
        let trash = self.root.join(format!(
            "{TRASH_PREFIX}{}-{}",
            agent.as_str(),
            ulid::Ulid::new()
        ));
        fs::rename(&agent_dir, &trash)?;
        fs::remove_dir_all(&trash)?;
        Ok(true)
    }

    fn agent_dir(&self, agent: AgentAdapterKind) -> PathBuf {
        self.root.join(agent.as_str())
    }
}

fn entry_path(dir: &Path, pin: &AdapterPin) -> PathBuf {
    dir.join("node_modules").join(pin.package).join(pin.entry)
}

fn parse_manifest(pin: &AdapterPin) -> Result<Manifest, AdapterError> {
    serde_json::from_str(pin.manifest).map_err(|error| AdapterError::Package {
        package: pin.package.to_string(),
        message: format!("pinned manifest is invalid: {error}"),
    })
}

fn installed_versions(agent_dir: &Path, package: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(agent_dir) else {
        return Vec::new();
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if name.starts_with('.') {
                return None;
            }
            let marker = fs::read(entry.path().join(MARKER)).ok()?;
            let marker: Marker = serde_json::from_slice(&marker).ok()?;
            (marker.package == package && marker.version == name).then_some(name)
        })
        .collect::<Vec<_>>();
    versions.sort();
    versions
}

async fn fill(
    staging: &Path,
    pin: &AdapterPin,
    manifest: &Manifest,
    source: &dyn PackageSource,
) -> Result<(), AdapterError> {
    fs::create_dir(staging)?;
    for package in manifest.packages.iter().filter(|package| !package.optional) {
        let name = package_name(&package.path).to_string();
        let target =
            staging.join(
                package_dir(&package.path).ok_or_else(|| AdapterError::Package {
                    package: name.clone(),
                    message: "unsafe package path".into(),
                })?,
            );
        let bytes =
            source
                .fetch(&package.resolved)
                .await
                .map_err(|message| AdapterError::Download {
                    package: name.clone(),
                    message,
                })?;
        if !integrity_matches(&bytes, &package.integrity) {
            return Err(AdapterError::Integrity { package: name });
        }
        tokio::task::spawn_blocking(move || unpack(&bytes, &target))
            .await
            .map_err(|error| AdapterError::Io {
                message: error.to_string(),
            })?
            .map_err(|message| AdapterError::Package {
                package: name,
                message,
            })?;
    }
    if !entry_path(staging, pin).is_file() {
        return Err(AdapterError::Package {
            package: pin.package.to_string(),
            message: "the adapter entry is missing".into(),
        });
    }
    let marker = serde_json::to_vec(&Marker {
        package: pin.package.to_string(),
        version: pin.version.to_string(),
    })
    .expect("marker serializes");
    fs::write(staging.join(MARKER), marker)?;
    Ok(())
}

/// `node_modules/a/node_modules/@scope/b` → `@scope/b`.
fn package_name(path: &str) -> &str {
    path.rsplit_once("node_modules/")
        .map_or(path, |(_, name)| name)
}

fn package_dir(path: &str) -> Option<&Path> {
    let path = Path::new(path);
    let safe = path.starts_with("node_modules")
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    safe.then_some(path)
}

fn integrity_matches(bytes: &[u8], integrity: &str) -> bool {
    let Some(expected) = integrity.strip_prefix("sha512-") else {
        return false;
    };
    base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)) == expected
}

/// Unpacks an npm tarball: its top directory is the package root. Only
/// regular files and directories are written; links and special entries
/// are not part of a package and are skipped.
fn unpack(bytes: &[u8], target: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let entries = archive.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        let relative = path.components().skip(1).collect::<PathBuf>();
        if relative.as_os_str().is_empty() {
            continue;
        }
        if !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(format!("unsafe path {}", path.display()));
        }
        let destination = target.join(&relative);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::File::create(&destination).map_err(|error| error.to_string())?;
        io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let executable = entry.header().mode().is_ok_and(|mode| mode & 0o111 != 0);
            let mode = if executable { 0o755 } else { 0o644 };
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Moves the complete staging directory to the version directory; a
/// reinstall of the same version swaps it out first and restores it if
/// the switch fails.
fn switch(agent_dir: &Path, staging: &Path, version: &str) -> Result<PathBuf, AdapterError> {
    let target = agent_dir.join(version);
    let trash = agent_dir.join(format!("{TRASH_PREFIX}{}", ulid::Ulid::new()));
    let replaced = target.exists();
    if replaced {
        if let Err(error) = fs::rename(&target, &trash) {
            let _ = fs::remove_dir_all(staging);
            return Err(error.into());
        }
    }
    if let Err(error) = fs::rename(staging, &target) {
        if replaced {
            let _ = fs::rename(&trash, &target);
        }
        let _ = fs::remove_dir_all(staging);
        return Err(error.into());
    }
    if replaced {
        let _ = fs::remove_dir_all(&trash);
    }
    Ok(target)
}

fn remove_other_versions(agent_dir: &Path, version: &str) {
    let Ok(entries) = fs::read_dir(agent_dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') && name != version {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Staging and trash directories of an interrupted install or removal.
fn remove_leftovers(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(STAGING_PREFIX) || name.starts_with(TRASH_PREFIX) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
