//! Device-local settings directory of the Svode install, found without the
//! desktop runtime.

use std::path::{Path, PathBuf};

/// Product identifier of the install; the desktop app resolves the same
/// directory from its bundle identifier.
pub const PRODUCT_IDENTIFIER: &str = "app.svode.desktop";

/// Environment override of the product identifier for dev/QA builds that
/// run under another identifier. It selects settings, never a target.
pub const PRODUCT_IDENTIFIER_ENV: &str = "SVODE_PRODUCT_IDENTIFIER";

/// Device-local config directory of the install: the OS config directory
/// joined with the product identifier, as the desktop app resolves it.
/// `None` when the OS has no config directory for the user.
pub fn config_dir() -> Option<PathBuf> {
    let identifier = std::env::var(PRODUCT_IDENTIFIER_ENV).ok();
    config_dir_in(dirs::config_dir()?.as_path(), identifier.as_deref())
}

fn config_dir_in(os_config_dir: &Path, identifier: Option<&str>) -> Option<PathBuf> {
    let identifier = match identifier.map(str::trim) {
        None | Some("") => PRODUCT_IDENTIFIER,
        Some(identifier) if valid_identifier(identifier) => identifier,
        Some(_) => return None,
    };
    Some(os_config_dir.join(identifier))
}

/// An identifier is one path segment, so an override cannot leave the OS
/// config directory.
fn valid_identifier(identifier: &str) -> bool {
    identifier != "."
        && identifier != ".."
        && identifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_identifier_selects_the_desktop_config_directory() {
        let base = Path::new("/config");
        assert_eq!(
            config_dir_in(base, None),
            Some(PathBuf::from("/config/app.svode.desktop"))
        );
        assert_eq!(
            config_dir_in(base, Some(" ")),
            Some(PathBuf::from("/config/app.svode.desktop"))
        );
    }

    #[test]
    fn override_selects_another_identifier_inside_the_config_directory() {
        let base = Path::new("/config");
        assert_eq!(
            config_dir_in(base, Some("app.svode.desktop.dev")),
            Some(PathBuf::from("/config/app.svode.desktop.dev"))
        );
        for escaping in ["..", ".", "../other", "a/b", "/abs"] {
            assert_eq!(config_dir_in(base, Some(escaping)), None, "{escaping}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_directory_matches_the_desktop_app_config_dir() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            config_dir_in(&dirs::config_dir().unwrap(), None).unwrap(),
            home.join("Library/Application Support/app.svode.desktop")
        );
    }
}
