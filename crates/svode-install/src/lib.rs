//! Installation of the Svode runtime for the current user.
//!
//! A user has one active installation: the desktop app bundle or the
//! standalone runtime, and the desktop app wins while it is installed. Agent
//! clients reach the active one through the stable location `~/.svode`,
//! whose address never changes between versions; switching a version
//! changes what it points to:
//!
//! ```text
//! ~/.svode/
//!   bin/svode, bin/svode-mcp      launchers (copies of svode-launcher)
//!   current -> runtimes/<id>      the active runtime, switched by rename(2)
//!   standalone -> runtimes/<id>   the installed standalone runtime, if any
//!   runtimes/<id>/
//!     runtime.json                kind and version
//!     bin/svode, bin/svode-mcp, bin/svode-lfs, bin/svode-launcher
//!     plugins/svode/              the plugin payload of that version
//! ```
//!
//! A desktop runtime links its binaries into the app bundle, a standalone
//! runtime holds them. The payload is always a copy, so after the desktop
//! app is removed the plugin and skill of a client stay loaded and the
//! launchers can tell the agent what happened. `~/.svode/config.json` is
//! never created: it would make the home directory a Svode project.

#[cfg(unix)]
pub mod diagnostic;
mod error;
#[cfg(unix)]
mod layout;
#[cfg(unix)]
mod ownership;
#[cfg(unix)]
pub mod shell_path;

pub use error::InstallError;
#[cfg(unix)]
pub use layout::{Layout, Runtime, RuntimeKind, RuntimeRecord};
#[cfg(unix)]
pub use ownership::{
    DesktopRuntime, Ownership, StandaloneInstall, StandaloneRemoval, Unavailable,
    install_standalone, resolve_launch, take_desktop_ownership, uninstall_standalone,
};

/// Launchers of the stable location, by the file name they run as.
pub const LAUNCHERS: [&str; 2] = ["svode", "svode-mcp"];
/// Binaries of every runtime, next to each other.
pub const RUNTIME_BINARIES: [&str; 4] = ["svode", "svode-mcp", "svode-lfs", "svode-launcher"];
/// The binary that the launchers are copies of.
pub const LAUNCHER_BINARY: &str = "svode-launcher";
/// Plugin payload inside a runtime and inside an unpacked archive.
pub const PAYLOAD: &str = "plugins/svode";
/// Version of this installation code, the product version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
