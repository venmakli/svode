//! The desktop app as the owner of the active Svode installation: every
//! start of an installed app points the stable location `~/.svode` at the
//! runtime of its bundle, also over a standalone runtime of any version.

use tauri::AppHandle;

/// Returns the version of the runtime that this start replaced with the
/// app's own, when it differs.
pub async fn take_ownership(app: &AppHandle) -> Option<String> {
    // A development build runs from the Cargo target directory and never
    // replaces the installation the user's agents run.
    if tauri::is_dev() {
        return None;
    }
    #[cfg(unix)]
    {
        let version = app.package_info().version.to_string();
        let app = app.clone();
        match tauri::async_runtime::spawn_blocking(move || take(&app)).await {
            Ok(Ok(Some(ownership))) => {
                tracing::info!("stable location ~/.svode: {ownership:?}");
                match ownership {
                    svode_install::Ownership::Taken {
                        previous: Some(previous),
                    } if previous.version != version => Some(previous.version),
                    _ => None,
                }
            }
            Ok(Ok(None)) => None,
            Ok(Err(error)) => {
                tracing::warn!("failed to take over the stable location ~/.svode: {error}");
                None
            }
            Err(error) => {
                tracing::warn!("taking over the stable location ~/.svode stopped: {error}");
                None
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = app;
        None
    }
}

#[cfg(unix)]
fn take(app: &AppHandle) -> Result<Option<svode_install::Ownership>, String> {
    use tauri::Manager;

    let exe = std::env::current_exe()
        .and_then(|exe| exe.canonicalize())
        .map_err(|error| error.to_string())?;
    let binaries = exe.parent().ok_or("the app binary has no directory")?;
    if is_transient(binaries) {
        tracing::info!(
            "Svode runs from {} outside an installed location; the stable location is left as is",
            binaries.display()
        );
        return Ok(None);
    }
    let payload = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join(svode_install::PAYLOAD);
    let version = app.package_info().version.to_string();
    let layout = svode_install::Layout::user().map_err(|error| error.to_string())?;
    svode_install::take_desktop_ownership(
        &layout,
        &svode_install::DesktopRuntime {
            binaries,
            payload: &payload,
            version: &version,
        },
    )
    .map(Some)
    .map_err(|error| error.to_string())
}

/// An app started from a mounted disk image or translocated by Gatekeeper
/// is not installed: its path disappears once it quits.
#[cfg(unix)]
fn is_transient(binaries: &std::path::Path) -> bool {
    cfg!(target_os = "macos")
        && (binaries.starts_with("/Volumes")
            || binaries
                .components()
                .any(|component| component.as_os_str() == "AppTranslocation"))
}
