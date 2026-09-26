//! Device-local presentation of installed external applications.
//!
//! Names and icons come from the OS for the concrete installed application and
//! are delivered to the window only: they are never written to a project and
//! never exposed through MCP/CLI. The frontend receives an opaque application
//! id and a ready image, never an executable path.

#[cfg(not(target_os = "windows"))]
use std::process::Command;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
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

#[cfg(target_os = "windows")]
mod windows_shell;

#[cfg(target_os = "windows")]
pub(crate) use windows_shell::app_presentation as windows_app_presentation;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
pub(crate) use linux::{
    command_presentation as linux_command_presentation,
    directory_app_presentation as linux_directory_app_presentation,
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
// Constructed by the native lookups.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    allow(dead_code)
)]
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
        return tauri_plugin_opener::reveal_item_in_dir(system_path::user_facing_path(file))
            .map_err(std::io::Error::other);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // The file manager selects the file through `org.freedesktop.FileManager1`;
        // without one, the plugin asks the desktop portal to open the folder.
        #[cfg(target_os = "linux")]
        if tauri_plugin_opener::reveal_item_in_dir(file).is_ok() {
            return Ok(());
        }
        // Without a session bus, opening the canonical parent is the fallback.
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

#[cfg(target_os = "windows")]
fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    windows_shell::offered_apps(file)
}

#[cfg(target_os = "linux")]
fn offered_apps(file: &Path) -> Vec<OfferedApp> {
    linux::offered_apps(file)
}

/// Other platforms offer the generic OS choice.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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

#[cfg(target_os = "windows")]
fn launch_offered_app(app: &OfferedApp, file: &Path) -> Result<(), ExternalOpenError> {
    windows_shell::launch(app, file)
}

#[cfg(target_os = "linux")]
fn launch_offered_app(app: &OfferedApp, file: &Path) -> Result<(), ExternalOpenError> {
    linux::launch(app, file)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn launch_offered_app(_app: &OfferedApp, _file: &Path) -> Result<(), ExternalOpenError> {
    Err(ExternalOpenError::Launch)
}

/// Whether a `.desktop` entry whose `Exec` runs `executable` is the
/// application `command` launches (resolved to `launched`): the same program
/// name, or the same file once resolved through `PATH` and links.
#[cfg(any(target_os = "linux", test))]
fn runs_command(
    executable: &Path,
    command: &str,
    launched: &Path,
    resolve: impl FnOnce(&Path) -> Option<PathBuf>,
) -> bool {
    executable.file_name().is_some_and(|name| name == command)
        || resolve(executable).is_some_and(|resolved| resolved == launched)
}

/// Opaque id of a Windows association handler: a digest of its registered
/// name, which is an executable path that must not reach the frontend.
#[cfg(any(target_os = "windows", test))]
fn handler_app_id(handler_name: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(normalize_windows_path(handler_name).as_bytes());
    let hex: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("win-{hex}")
}

/// Which of the `(name, label)` handlers is the one Windows opens the file type
/// with: the same executable, otherwise the same display name (packaged apps
/// may report a different executable path than the association).
#[cfg(any(target_os = "windows", test))]
fn default_handler_index(
    handlers: impl IntoIterator<Item = (impl AsRef<str>, impl AsRef<str>)>,
    default_executable: Option<&str>,
    default_label: Option<&str>,
) -> Option<usize> {
    let handlers: Vec<_> = handlers.into_iter().collect();
    default_executable
        .map(normalize_windows_path)
        .and_then(|executable| {
            handlers
                .iter()
                .position(|(name, _)| normalize_windows_path(name.as_ref()) == executable)
        })
        .or_else(|| {
            let label = default_label?.trim().to_lowercase();
            handlers
                .iter()
                .position(|(_, candidate)| candidate.as_ref().trim().to_lowercase() == label)
        })
}

#[cfg(any(target_os = "windows", test))]
fn normalize_windows_path(path: &str) -> String {
    system_path::user_facing_path_str(path.trim())
        .replace('/', "\\")
        .to_lowercase()
}

/// Expands `%NAME%` references the way Shell icon locations use them;
/// unknown names stay as written.
#[cfg(any(target_os = "windows", test))]
fn expand_env_vars(text: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut expanded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            expanded.push_str(&rest[start..]);
            return expanded;
        };
        match lookup(&after[..end]).filter(|_| end > 0) {
            Some(value) => {
                expanded.push_str(&value);
                rest = &after[end + 1..];
            }
            None => {
                expanded.push('%');
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded
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

    #[test]
    fn windows_handler_ids_are_stable_opaque_digests_of_the_handler_name() {
        let acrobat = r"C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe";
        let id = handler_app_id(acrobat);

        assert_eq!(id, handler_app_id(acrobat));
        assert_eq!(id, handler_app_id(&acrobat.to_uppercase()));
        assert_eq!(
            id,
            handler_app_id(r"\\?\C:/Program Files/Adobe/Acrobat DC/Acrobat/Acrobat.exe")
        );
        assert_ne!(id, handler_app_id(r"C:\Windows\System32\mspaint.exe"));
        assert!(id.starts_with("win-"));
        assert_eq!(id.len(), "win-".len() + 16);
        assert!(!id.contains(['\\', '/', ':']));
        assert!(!id.to_lowercase().contains("acrobat"));
    }

    #[test]
    fn windows_default_handler_matches_the_executable_before_the_display_name() {
        let handlers = [
            (r"C:\Program Files\Mozilla Firefox\firefox.exe", "Firefox"),
            (
                r"C:\Program Files\Microsoft\Edge\msedge.exe",
                "Microsoft Edge",
            ),
            (r"C:\Program Files\Other\edge.exe", "Microsoft Edge"),
        ];

        assert_eq!(
            default_handler_index(
                handlers,
                Some(r"\\?\c:/program files/microsoft/edge/MSEDGE.EXE"),
                Some("Firefox"),
            ),
            Some(1)
        );
        // Packaged apps may report another executable: the display name decides.
        assert_eq!(
            default_handler_index(
                handlers,
                Some(r"C:\Program Files\WindowsApps\Viewer\viewer.exe"),
                Some(" microsoft edge "),
            ),
            Some(1)
        );
        assert_eq!(default_handler_index(handlers, None, Some("Paint")), None);
        assert_eq!(default_handler_index(handlers, None, None), None);
    }

    #[test]
    fn icon_locations_expand_known_environment_variables_only() {
        let lookup = |name: &str| (name == "SystemRoot").then(|| r"C:\Windows".to_string());

        assert_eq!(
            expand_env_vars(r"%SystemRoot%\system32\imageres.dll", lookup),
            r"C:\Windows\system32\imageres.dll"
        );
        assert_eq!(
            expand_env_vars(r"%Missing%\app.exe", lookup),
            r"%Missing%\app.exe"
        );
        assert_eq!(expand_env_vars("100%", lookup), "100%");
        assert_eq!(expand_env_vars("%%", lookup), "%%");
        assert_eq!(expand_env_vars(r"C:\plain.ico", lookup), r"C:\plain.ico");
    }

    #[test]
    fn desktop_entries_match_the_launched_program_by_name_or_resolved_file() {
        let launched = Path::new("/usr/share/code/bin/code");
        let unresolved = |_: &Path| None;

        assert!(runs_command(
            Path::new("/usr/share/code/code"),
            "code",
            launched,
            unresolved
        ));
        assert!(runs_command(
            Path::new("code"),
            "code",
            launched,
            unresolved
        ));
        // An AppImage entry behind a `cursor` symlink on PATH.
        assert!(runs_command(
            Path::new("/home/me/Applications/Cursor.AppImage"),
            "cursor",
            Path::new("/home/me/Applications/Cursor.AppImage"),
            |executable| Some(executable.to_path_buf()),
        ));
        assert!(!runs_command(
            Path::new("/usr/bin/code-oss"),
            "code",
            launched,
            |_| Some(PathBuf::from("/usr/lib/code-oss/code-oss")),
        ));
        assert!(!runs_command(
            Path::new("/usr/bin/flatpak"),
            "code",
            launched,
            |_| Some(PathBuf::from("/usr/bin/flatpak")),
        ));
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
