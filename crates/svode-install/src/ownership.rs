//! Who owns the active installation. The desktop app takes it at every
//! start; the standalone runtime is active only without a desktop app, and
//! a launcher falls back to it when the desktop app is gone.

use std::path::{Path, PathBuf};

use crate::error::InstallError;
use crate::layout::{self, Launchers, Layout, Runtime, RuntimeKind, RuntimeRecord};
use crate::{LAUNCHER_BINARY, PAYLOAD};

/// The runtime of a running desktop app.
#[derive(Debug, Clone)]
pub struct DesktopRuntime<'a> {
    /// Directory of the app binaries, inside the installed bundle.
    pub binaries: &'a Path,
    /// The plugin payload shipped in the bundle.
    pub payload: &'a Path,
    pub version: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ownership {
    /// The stable location already pointed to this desktop runtime.
    Unchanged,
    /// The stable location now points to this desktop runtime.
    Taken { previous: Option<RuntimeRecord> },
}

/// Makes the desktop runtime the active one, also over a standalone runtime
/// of a newer version, which stays installed and inactive.
pub fn take_desktop_ownership(
    layout: &Layout,
    desktop: &DesktopRuntime<'_>,
) -> Result<Ownership, InstallError> {
    layout.check_not_project()?;
    layout::check_source(desktop.binaries, desktop.payload)?;
    let launcher = desktop.binaries.join(LAUNCHER_BINARY);
    let record = RuntimeRecord {
        kind: RuntimeKind::Desktop,
        version: desktop.version.to_string(),
        binaries: Some(desktop.binaries.to_path_buf()),
    };
    let previous = layout.active();
    if let Some(active) = &previous
        && active.record == record
        && active.has_payload()
    {
        layout.install_launchers(&launcher, Launchers::Owner)?;
        return Ok(Ownership::Unchanged);
    }
    let runtime = layout.create_runtime(&record, |dir| {
        layout::fill_runtime(dir, desktop.binaries, desktop.payload, true)
    })?;
    layout.install_launchers(&launcher, Launchers::Owner)?;
    layout.activate(&runtime)?;
    layout.collect_garbage()?;
    Ok(Ownership::Taken {
        previous: previous.map(|runtime| runtime.record),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StandaloneInstall {
    /// The standalone runtime is installed and active.
    Active { previous: Option<RuntimeRecord> },
    /// A desktop app is active: the installed standalone runtime was updated
    /// and stays inactive.
    UpdatedInactive { desktop: String },
    /// A desktop app is active and no standalone runtime was installed:
    /// only missing launchers were written, `svode` runs the desktop runtime.
    DesktopRuntime { desktop: String },
}

/// Installs or updates the standalone runtime unpacked at `source`
/// (`bin/` with every runtime binary and `plugins/svode/`) as `version`.
pub fn install_standalone(
    layout: &Layout,
    source: &Path,
    version: &str,
) -> Result<StandaloneInstall, InstallError> {
    layout.check_not_project()?;
    let (binaries, payload) = (source.join("bin"), source.join(PAYLOAD));
    layout::check_source(&binaries, &payload)?;
    let launcher = binaries.join(LAUNCHER_BINARY);
    let record = RuntimeRecord {
        kind: RuntimeKind::Standalone,
        version: version.to_string(),
        binaries: None,
    };
    let create = || {
        layout.create_runtime(&record, |dir| {
            layout::fill_runtime(dir, &binaries, &payload, false)
        })
    };

    if let Some(desktop) = active_desktop(layout) {
        layout.install_launchers(&launcher, Launchers::Missing)?;
        let desktop = desktop.record.version;
        if layout.standalone().is_none() {
            return Ok(StandaloneInstall::DesktopRuntime { desktop });
        }
        layout.set_standalone(&create()?)?;
        layout.collect_garbage()?;
        return Ok(StandaloneInstall::UpdatedInactive { desktop });
    }

    let previous = layout.active().map(|runtime| runtime.record);
    let runtime = create()?;
    layout.install_launchers(&launcher, Launchers::Owner)?;
    layout.set_standalone(&runtime)?;
    layout.activate(&runtime)?;
    layout.collect_garbage()?;
    Ok(StandaloneInstall::Active { previous })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StandaloneRemoval {
    /// The standalone runtime was active: the stable location is removed.
    Active,
    /// A desktop app stays active; the standalone runtime was removed.
    Inactive { desktop: String },
    /// A desktop app is active and no standalone runtime was installed.
    NotInstalled { desktop: String },
    /// There was no installation to remove.
    Nothing,
}

/// Removes the standalone runtime. With an active desktop app its
/// launchers, payload and links stay; otherwise the whole stable location
/// goes. Projects and client configs are never touched here.
pub fn uninstall_standalone(layout: &Layout) -> Result<StandaloneRemoval, InstallError> {
    if let Some(desktop) = active_desktop(layout) {
        let desktop = desktop.record.version;
        if layout.standalone().is_none() {
            return Ok(StandaloneRemoval::NotInstalled { desktop });
        }
        layout.remove_standalone_link()?;
        layout.collect_garbage()?;
        return Ok(StandaloneRemoval::Inactive { desktop });
    }
    let existed = layout.root().exists();
    layout.remove_all()?;
    Ok(if existed {
        StandaloneRemoval::Active
    } else {
        StandaloneRemoval::Nothing
    })
}

/// Why a launcher cannot start its runtime, with the next step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable {
    pub message: String,
    pub hint: &'static str,
}

const REINSTALL: &str =
    "Reinstall Svode Desktop and start it once, or run the standalone Svode installer.";

impl Unavailable {
    pub fn start_failed(path: &Path, error: &std::io::Error) -> Self {
        Self {
            message: format!("could not start {}: {error}", path.display()),
            hint: REINSTALL,
        }
    }

    pub fn from_error(error: &InstallError) -> Self {
        Self {
            message: error.message.clone(),
            hint: REINSTALL,
        }
    }
}

/// The binary a launcher runs for `name`. When the active desktop app is
/// gone, the installed standalone runtime becomes active on the way.
pub fn resolve_launch(layout: &Layout, name: &str) -> Result<PathBuf, Unavailable> {
    let active = layout.active();
    if active.as_ref().is_some_and(|runtime| runtime.runs(name)) {
        return Ok(layout.active_binary(name));
    }
    if let Some(standalone) = layout.standalone().filter(|runtime| runtime.runs(name)) {
        return Ok(match layout.activate(&standalone) {
            Ok(()) => layout.active_binary(name),
            Err(_) => standalone.binary(name),
        });
    }
    Err(match active {
        Some(Runtime {
            record:
                RuntimeRecord {
                    kind: RuntimeKind::Desktop,
                    binaries: Some(binaries),
                    ..
                },
            ..
        }) => Unavailable {
            message: format!(
                "Svode Desktop is no longer at {} and no standalone Svode runtime is installed",
                binaries.display()
            ),
            hint: REINSTALL,
        },
        _ => Unavailable {
            message: "the Svode runtime is not installed".into(),
            hint: "Install Svode Desktop and start it once, or run the standalone Svode installer.",
        },
    })
}

/// The active desktop runtime whose app is still installed.
fn active_desktop(layout: &Layout) -> Option<Runtime> {
    layout
        .active()
        .filter(|runtime| runtime.record.kind == RuntimeKind::Desktop && runtime.runs("svode"))
}
