//! Device-local presentation of installed external applications.
//!
//! Names and icons come from the OS for the concrete installed application and
//! are delivered to the window only: they are never written to a project and
//! never exposed through MCP/CLI. The frontend receives an opaque application
//! id and a ready image, never an executable path.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::system_path;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub(crate) use macos::{
    app_presentation as macos_app_presentation, find_app_bundle as find_macos_app_bundle,
};

/// Symbolic fallback class shown when the OS returns no icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAppKind {
    Editor,
    FileManager,
    Terminal,
    /// An application the OS offers for a file.
    Application,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAppDto {
    pub id: String,
    pub label: String,
    pub kind: ExternalAppKind,
    pub is_default: bool,
    /// `data:` URL of the application icon, absent when the OS returned none.
    pub icon: Option<String>,
}

/// What the OS reports for one installed application.
#[derive(Debug, Clone, Default)]
pub(crate) struct AppPresentation {
    pub label: Option<String>,
    pub icon: Option<String>,
}

/// An application the OS offers for a file, with where it is launched from.
// Constructed by the native lookups; Windows and Linux land in DF-098D/E.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone)]
pub(crate) struct OfferedApp {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub is_default: bool,
    pub location: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExternalOpenError {
    /// The id is not offered for this file (any more); nothing was launched.
    UnknownApp,
    Launch,
}

/// Applications the OS offers for `file`: its default first, then the others
/// by name, without duplicates.
pub(crate) fn file_apps(file: &Path) -> Vec<ExternalAppDto> {
    order_offered_apps(offered_apps(file))
        .into_iter()
        .map(|app| ExternalAppDto {
            id: app.id,
            label: app.label,
            kind: ExternalAppKind::Application,
            is_default: app.is_default,
            icon: app.icon,
        })
        .collect()
}

/// Opens `file` in `app_id` re-resolved for this file, or hands the choice to
/// the OS when absent.
pub(crate) fn open_file(
    app: &AppHandle,
    file: &Path,
    app_id: Option<&str>,
) -> Result<(), ExternalOpenError> {
    match app_id {
        Some(app_id) => open_file_in_app(file, app_id),
        None => app
            .opener()
            .open_path(system_path::user_facing_path(file), None::<&str>)
            .map_err(|_| ExternalOpenError::Launch),
    }
}

fn open_file_in_app(file: &Path, app_id: &str) -> Result<(), ExternalOpenError> {
    let offered = order_offered_apps(offered_apps(file))
        .into_iter()
        .find(|app| app.id == app_id)
        .ok_or(ExternalOpenError::UnknownApp)?;
    launch_offered_app(&offered, Path::new(&system_path::user_facing_path(file)))
}

/// Shows `file` selected in the file manager; where selection is unsupported,
/// opens its folder.
pub(crate) fn reveal_file(file: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg("-R").arg(file);
        return command.spawn().map(|_| ());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", file.display()));
        return command.spawn().map(|_| ());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Freedesktop has no portable select-file CLI; opening the canonical parent
        // is the safe fallback on platforms where file selection is unsupported.
        let parent = file.parent().ok_or_else(|| {
            std::io::Error::other(format!("file has no parent: {}", file.display()))
        })?;
        let mut command = Command::new("xdg-open");
        command.arg(parent);
        return command.spawn().map(|_| ());
    }

    #[allow(unreachable_code)]
    Err(std::io::Error::other("No supported file manager found"))
}

/// Default first, then the others by name; the first occurrence of an id wins.
fn order_offered_apps(apps: Vec<OfferedApp>) -> Vec<OfferedApp> {
    let mut seen = HashSet::new();
    let (mut defaults, mut others): (Vec<_>, Vec<_>) = apps
        .into_iter()
        .filter(|app| seen.insert(app.id.clone()))
        .partition(|app| app.is_default);
    defaults.truncate(1);
    others.sort_by_cached_key(|app| app.label.to_lowercase());
    defaults.extend(others);
    defaults
}

#[cfg(target_os = "macos")]
fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    macos::offered_apps(file)
}

/// Windows and Linux offer the generic OS choice until their native lookups land.
#[cfg(not(target_os = "macos"))]
fn offered_apps(_file: &Path) -> Vec<OfferedApp> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn launch_offered_app(app: &OfferedApp, file: &Path) -> Result<(), ExternalOpenError> {
    Command::new("open")
        .arg("-a")
        .arg(&app.location)
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|_| ExternalOpenError::Launch)
}

#[cfg(not(target_os = "macos"))]
fn launch_offered_app(_app: &OfferedApp, _file: &Path) -> Result<(), ExternalOpenError> {
    Err(ExternalOpenError::Launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered(id: &str, label: &str, is_default: bool) -> OfferedApp {
        OfferedApp {
            id: id.into(),
            label: label.into(),
            icon: None,
            is_default,
            location: PathBuf::from(format!("/Applications/{label}.app")),
        }
    }

    fn ids(apps: &[OfferedApp]) -> Vec<&str> {
        apps.iter().map(|app| app.id.as_str()).collect()
    }

    #[test]
    fn default_comes_first_and_the_others_by_name_without_duplicates() {
        let ordered = order_offered_apps(vec![
            offered("preview", "Preview", true),
            offered("zed", "Zed", false),
            offered("acrobat", "Adobe Acrobat", false),
            offered("preview", "Preview", true),
            offered("safari", "safari", false),
            offered("zed", "Zed copy", false),
        ]);

        assert_eq!(ids(&ordered), ["preview", "acrobat", "safari", "zed"]);
        assert!(ordered[0].is_default);
        assert!(ordered[1..].iter().all(|app| !app.is_default));
    }

    #[test]
    fn without_a_default_only_alternatives_remain() {
        let ordered = order_offered_apps(vec![
            offered("b", "Beta", false),
            offered("a", "Alpha", false),
        ]);

        assert_eq!(ids(&ordered), ["a", "b"]);
        assert!(ordered.iter().all(|app| !app.is_default));
        assert!(order_offered_apps(Vec::new()).is_empty());
    }

    #[test]
    fn unknown_app_is_rejected_without_launch() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("guide.pdf");
        std::fs::write(&file, b"%PDF fixture").unwrap();

        assert_eq!(
            open_file_in_app(&file, "com.example.not-offered"),
            Err(ExternalOpenError::UnknownApp)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_offers_the_default_application_for_a_pdf_with_name_and_icon() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("guide.pdf");
        std::fs::write(&file, b"%PDF fixture").unwrap();

        let apps = file_apps(&file);
        let default = apps.first().expect("the OS offers applications for a PDF");
        assert!(default.is_default);
        assert!(!default.label.is_empty());
        assert!(
            default
                .icon
                .as_deref()
                .is_some_and(|icon| icon.starts_with("data:image/png;base64,"))
        );
        assert_eq!(apps.iter().filter(|app| app.is_default).count(), 1);
        let unique: HashSet<_> = apps.iter().map(|app| &app.id).collect();
        assert_eq!(unique.len(), apps.len());
        assert!(apps.iter().all(|app| !app.id.starts_with('/')));
    }
}
