//! Linux lookups through GIO: the applications registered for the MIME type of
//! a file with the default one from `mimeapps.list`, their `.desktop` names
//! and theme icons, and launching a chosen application.
//!
//! GTK icon themes may only be used on the main thread, where Tauri runs
//! synchronous commands; elsewhere the symbolic fallback is shown.

use std::{
    collections::HashMap,
    path::Path,
    sync::{LazyLock, Mutex},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use gtk::{gio, prelude::*};

use super::{AppPresentation, ExternalOpenError, OfferedApp, runs_command};

/// Pixel size of the delivered icon: sharp at ~20 px on high-DPI displays.
const ICON_PIXELS: i32 = 64;

/// Content type whose default application is the file manager.
const DIRECTORY_TYPE: &str = "inode/directory";

/// Rendered icon of each installed application, by desktop id, for the
/// lifetime of the process.
static ICONS: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Name and icon of the application `command` launches: the `.desktop` entry
/// that runs the same program, preferring entries shown in menus.
pub(crate) fn command_presentation(command: &str) -> AppPresentation {
    let Some(launched) = which::which(command)
        .ok()
        .and_then(|path| path.canonicalize().ok())
    else {
        return AppPresentation::default();
    };
    let resolve = |executable: &Path| {
        which::which(executable)
            .ok()
            .and_then(|path| path.canonicalize().ok())
    };
    let (shown, hidden): (Vec<_>, Vec<_>) = gio::AppInfo::all()
        .into_iter()
        .partition(|app| app.should_show());
    shown
        .iter()
        .chain(&hidden)
        .find(|app| runs_command(&app.executable(), command, &launched, resolve))
        .map(presentation)
        .unwrap_or_default()
}

/// Name and icon of the application a directory opens in: the file manager.
pub(crate) fn directory_app_presentation() -> AppPresentation {
    gio::AppInfo::default_for_type(DIRECTORY_TYPE, false)
        .as_ref()
        .map(presentation)
        .unwrap_or_default()
}

/// Applications registered for the MIME type of `file`, with the default one
/// marked. Identified by desktop id, launched from their `.desktop` entry.
pub(crate) fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    let Some(content_type) = content_type(file) else {
        return Vec::new();
    };
    let default = gio::AppInfo::default_for_type(&content_type, false);
    let default_id = default.as_ref().and_then(|app| app.id());
    default
        .into_iter()
        .chain(gio::AppInfo::recommended_for_type(&content_type))
        .filter_map(|app| {
            let id = app.id()?;
            let location = app.downcast_ref::<gio::DesktopAppInfo>()?.filename()?;
            let presentation = presentation(&app);
            Some(OfferedApp {
                is_default: default_id.as_ref() == Some(&id),
                id: id.into(),
                label: presentation.label.unwrap_or_else(|| app.name().into()),
                icon: presentation.icon,
                location,
            })
        })
        .collect()
}

/// Launches the `.desktop` entry behind `app` for `file`.
pub(crate) fn launch(app: &OfferedApp, file: &Path) -> Result<(), ExternalOpenError> {
    gio::DesktopAppInfo::from_filename(&app.location)
        .ok_or(ExternalOpenError::Launch)?
        .launch(&[gio::File::for_path(file)], gio::AppLaunchContext::NONE)
        .map_err(|_| ExternalOpenError::Launch)
}

fn content_type(file: &Path) -> Option<String> {
    gio::File::for_path(file)
        .query_info(
            gio::FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
            gio::FileQueryInfoFlags::NONE,
            gio::Cancellable::NONE,
        )
        .ok()?
        .content_type()
        .map(Into::into)
}

fn presentation(app: &gio::AppInfo) -> AppPresentation {
    let label = app.display_name();
    AppPresentation {
        label: (!label.trim().is_empty()).then(|| label.into()),
        icon: icon_data_url(app),
    }
}

fn icon_data_url(app: &gio::AppInfo) -> Option<String> {
    if !gtk::is_initialized_main_thread() {
        return None;
    }
    let id = app.id()?.to_string();
    let mut icons = ICONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    icons
        .entry(id)
        .or_insert_with(|| render_icon(&app.icon()?))
        .clone()
}

/// Renders a theme, file or bundled icon as a PNG `data:` URL.
fn render_icon(icon: &gio::Icon) -> Option<String> {
    let png = gtk::IconTheme::default()?
        .lookup_by_gicon(icon, ICON_PIXELS, gtk::IconLookupFlags::FORCE_SIZE)?
        .load_icon()
        .ok()?
        .save_to_bufferv("png", &[])
        .ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_is_typed_by_the_shared_mime_database() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("guide.pdf");
        std::fs::write(&file, b"%PDF-1.7 fixture").unwrap();

        assert_eq!(content_type(&file).as_deref(), Some("application/pdf"));
        assert_eq!(content_type(&temp.path().join("missing.pdf")), None);
    }

    #[test]
    fn lookups_off_the_gtk_main_thread_fall_back_without_icons() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("guide.pdf");
        std::fs::write(&file, b"%PDF-1.7 fixture").unwrap();

        let apps = offered_apps(&file);
        assert!(apps.iter().all(|app| app.icon.is_none()));
        assert!(apps.iter().filter(|app| app.is_default).count() <= 1);
        assert!(apps.iter().all(|app| app.id.ends_with(".desktop")));
        assert!(directory_app_presentation().icon.is_none());
        assert!(
            command_presentation("svode-no-such-command")
                .label
                .is_none()
        );
    }
}
