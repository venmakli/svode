//! The stable location on disk: paths, runtime directories and the atomic
//! switches of its links and launchers.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::InstallError;
use crate::{LAUNCHERS, PAYLOAD};

const CURRENT: &str = "current";
const STANDALONE: &str = "standalone";
const RUNTIMES: &str = "runtimes";
const RECORD: &str = "runtime.json";
const STAGING: &str = ".staging-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Desktop,
    Standalone,
}

/// `runtime.json` of a runtime directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecord {
    pub kind: RuntimeKind,
    pub version: String,
    /// Directory of the desktop app binaries that a desktop runtime links to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binaries: Option<PathBuf>,
}

/// One runtime directory under `runtimes/`.
#[derive(Debug, Clone)]
pub struct Runtime {
    pub dir: PathBuf,
    pub record: RuntimeRecord,
}

impl Runtime {
    pub fn binary(&self, name: &str) -> PathBuf {
        self.dir.join("bin").join(name)
    }

    /// Whether `name` of this runtime can be started: false for a desktop
    /// runtime whose app was removed or moved.
    pub fn runs(&self, name: &str) -> bool {
        is_executable(&self.binary(name))
    }

    pub(crate) fn has_payload(&self) -> bool {
        self.dir
            .join(PAYLOAD)
            .join(".claude-plugin/plugin.json")
            .is_file()
    }
}

/// Which launchers an installation step writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Launchers {
    /// The owner of the active installation: every launcher is its own.
    Owner,
    /// Another installation is active: only launchers that do not exist.
    Missing,
}

/// The stable location of one user.
#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    /// `~/.svode` of the user running the process.
    pub fn user() -> Result<Self, InstallError> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .ok_or_else(|| {
                InstallError::new("HOME_UNAVAILABLE", "HOME is not set to an absolute path")
            })?;
        Ok(Self::at(home.join(".svode")))
    }

    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Launcher `name` that client configs and skills refer to.
    pub fn launcher(&self, name: &str) -> PathBuf {
        self.root.join("bin").join(name)
    }

    /// Binary `name` of the active runtime, addressed through `current`.
    pub fn active_binary(&self, name: &str) -> PathBuf {
        self.root.join(CURRENT).join("bin").join(name)
    }

    /// Stable address of the plugin payload of the active runtime.
    pub fn payload(&self) -> PathBuf {
        self.root.join(CURRENT).join(PAYLOAD)
    }

    pub fn active(&self) -> Option<Runtime> {
        self.runtime_behind(CURRENT)
    }

    pub fn standalone(&self) -> Option<Runtime> {
        self.runtime_behind(STANDALONE)
    }

    fn runtime_behind(&self, link: &str) -> Option<Runtime> {
        let target = fs::read_link(self.root.join(link)).ok()?;
        let dir = self.root.join(target);
        let record = serde_json::from_slice(&fs::read(dir.join(RECORD)).ok()?).ok()?;
        Some(Runtime { dir, record })
    }

    /// The stable location must never sit inside a Svode project: when the
    /// home directory already is one, `~/.svode` is its metadata folder.
    pub(crate) fn check_not_project(&self) -> Result<(), InstallError> {
        let config = self.root.join("config.json");
        if config.exists() {
            return Err(InstallError::new(
                "STABLE_LOCATION_IS_PROJECT",
                format!(
                    "{} exists: the home directory is a Svode project, so {} cannot hold the Svode runtime",
                    config.display(),
                    self.root.display()
                ),
            ));
        }
        Ok(())
    }

    /// Builds a runtime directory aside and publishes it under its final
    /// name only when complete, so a link never points to a partial one.
    pub(crate) fn create_runtime(
        &self,
        record: &RuntimeRecord,
        fill: impl FnOnce(&Path) -> Result<(), InstallError>,
    ) -> Result<Runtime, InstallError> {
        if !record
            .version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        {
            return Err(InstallError::new(
                "INVALID_RUNTIME",
                format!("unexpected runtime version {:?}", record.version),
            ));
        }
        let runtimes = self.root.join(RUNTIMES);
        let kind = match record.kind {
            RuntimeKind::Desktop => "desktop",
            RuntimeKind::Standalone => "standalone",
        };
        let id = format!("{kind}-{}-{}", record.version, unique());
        let staging = runtimes.join(format!("{STAGING}{id}"));
        let built = (|| {
            create_dir(&staging.join("bin"))?;
            fill(&staging)?;
            let json = serde_json::to_vec_pretty(record)
                .map_err(|error| InstallError::new("INSTALL_IO_ERROR", error.to_string()))?;
            write(&staging.join(RECORD), &json)
        })();
        if let Err(error) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let dir = runtimes.join(&id);
        fs::rename(&staging, &dir).map_err(|error| InstallError::io(&dir, error))?;
        Ok(Runtime {
            dir,
            record: record.clone(),
        })
    }

    pub(crate) fn activate(&self, runtime: &Runtime) -> Result<(), InstallError> {
        self.switch(CURRENT, runtime)
    }

    pub(crate) fn set_standalone(&self, runtime: &Runtime) -> Result<(), InstallError> {
        self.switch(STANDALONE, runtime)
    }

    /// Points `link` at `runtime` with one rename(2) over the old link, so a
    /// reader sees either the old or the new runtime.
    fn switch(&self, link: &str, runtime: &Runtime) -> Result<(), InstallError> {
        let target = runtime
            .dir
            .strip_prefix(&self.root)
            .unwrap_or(&runtime.dir)
            .to_path_buf();
        let path = self.root.join(link);
        let temporary = self.root.join(format!(".{link}.{}", unique()));
        symlink(&target, &temporary).map_err(|error| InstallError::io(&temporary, error))?;
        fs::rename(&temporary, &path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            InstallError::io(&path, error)
        })
    }

    pub(crate) fn remove_standalone_link(&self) -> Result<(), InstallError> {
        remove_file(&self.root.join(STANDALONE))
    }

    /// Writes the launchers as copies of `source`, each replaced by rename
    /// so a launcher that is starting keeps working.
    pub(crate) fn install_launchers(
        &self,
        source: &Path,
        which: Launchers,
    ) -> Result<(), InstallError> {
        let bin = self.root.join("bin");
        create_dir(&bin)?;
        let content = fs::read(source).map_err(|error| InstallError::io(source, error))?;
        for name in LAUNCHERS {
            let path = bin.join(name);
            let current = fs::read(&path).ok();
            let skip = match which {
                Launchers::Missing => current.is_some(),
                Launchers::Owner => current.as_deref() == Some(content.as_slice()),
            };
            if skip {
                continue;
            }
            let temporary = bin.join(format!(".{name}.{}", unique()));
            write(&temporary, &content)?;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))
                .and_then(|()| fs::rename(&temporary, &path))
                .map_err(|error| {
                    let _ = fs::remove_file(&temporary);
                    InstallError::io(&path, error)
                })?;
        }
        Ok(())
    }

    /// Removes runtime directories that neither link points to, including
    /// staging left by an interrupted step. A process started from a removed
    /// runtime keeps running.
    pub(crate) fn collect_garbage(&self) -> Result<(), InstallError> {
        let runtimes = self.root.join(RUNTIMES);
        let Ok(entries) = fs::read_dir(&runtimes) else {
            return Ok(());
        };
        let keep = [self.active(), self.standalone()]
            .into_iter()
            .flatten()
            .map(|runtime| runtime.dir)
            .collect::<HashSet<_>>();
        for entry in entries.flatten() {
            let path = entry.path();
            if !keep.contains(&path) {
                fs::remove_dir_all(&path).map_err(|error| InstallError::io(&path, error))?;
            }
        }
        Ok(())
    }

    /// Removes everything the stable location holds: launchers, links and
    /// runtimes. Unknown files stay, and so does a directory holding them.
    pub(crate) fn remove_all(&self) -> Result<(), InstallError> {
        for name in LAUNCHERS {
            remove_file(&self.launcher(name))?;
        }
        remove_file(&self.root.join(CURRENT))?;
        remove_file(&self.root.join(STANDALONE))?;
        let runtimes = self.root.join(RUNTIMES);
        if runtimes.exists() {
            fs::remove_dir_all(&runtimes).map_err(|error| InstallError::io(&runtimes, error))?;
        }
        for dir in [self.root.join("bin"), self.root.clone()] {
            let _ = fs::remove_dir(dir);
        }
        Ok(())
    }
}

/// Copies a runtime source into `dir`: binaries as links for a desktop
/// runtime, as files for a standalone one, and the payload always as files.
pub(crate) fn fill_runtime(
    dir: &Path,
    binaries: &Path,
    payload: &Path,
    link_binaries: bool,
) -> Result<(), InstallError> {
    for name in crate::RUNTIME_BINARIES {
        let (source, target) = (binaries.join(name), dir.join("bin").join(name));
        if link_binaries {
            symlink(&source, &target).map_err(|error| InstallError::io(&target, error))?;
        } else {
            fs::copy(&source, &target).map_err(|error| InstallError::io(&source, error))?;
        }
    }
    copy_tree(payload, &dir.join(PAYLOAD))
}

/// A complete runtime source: every binary and the payload of the version.
pub(crate) fn check_source(binaries: &Path, payload: &Path) -> Result<(), InstallError> {
    for name in crate::RUNTIME_BINARIES {
        if !is_executable(&binaries.join(name)) {
            return Err(InstallError::new(
                "INVALID_RUNTIME",
                format!(
                    "{} is missing or not executable",
                    binaries.join(name).display()
                ),
            ));
        }
    }
    let manifest = payload.join(".claude-plugin/plugin.json");
    if !manifest.is_file() {
        return Err(InstallError::new(
            "INVALID_RUNTIME",
            format!(
                "the plugin payload is incomplete: {} is missing",
                manifest.display()
            ),
        ));
    }
    Ok(())
}

pub(crate) fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), InstallError> {
    create_dir(target)?;
    let entries = fs::read_dir(source).map_err(|error| InstallError::io(source, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| InstallError::io(source, error))?;
        let (from, to) = (entry.path(), target.join(entry.file_name()));
        let kind = entry
            .file_type()
            .map_err(|error| InstallError::io(&from, error))?;
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else if kind.is_symlink() {
            let link = fs::read_link(&from).map_err(|error| InstallError::io(&from, error))?;
            symlink(link, &to).map_err(|error| InstallError::io(&to, error))?;
        } else {
            fs::copy(&from, &to).map_err(|error| InstallError::io(&from, error))?;
        }
    }
    Ok(())
}

fn create_dir(path: &Path) -> Result<(), InstallError> {
    fs::create_dir_all(path).map_err(|error| InstallError::io(path, error))
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    fs::write(path, bytes).map_err(|error| InstallError::io(path, error))
}

fn remove_file(path: &Path) -> Result<(), InstallError> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(InstallError::io(path, error))
        }
        _ => Ok(()),
    }
}

/// Name suffix no other step of this or another process uses.
fn unique() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}{:x}", std::process::id())
}
