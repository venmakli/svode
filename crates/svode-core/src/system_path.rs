//! Presentation of local filesystem paths to people and agents.

use std::path::Path;

/// `path` without the Windows verbatim prefix a canonical path carries.
pub fn user_facing_path(path: &Path) -> String {
    user_facing_path_str(&path.to_string_lossy())
}

pub fn user_facing_path_str(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = path.strip_prefix("//?/") {
        return rest.to_string();
    }
    path.to_string()
}

/// Whether `path` names a network share or a device rather than a local
/// object: it starts with two separators of either kind, as `\\server\share`,
/// `//server/share`, `\\?\UNC\…` and `\\.\pipe\…` do. A verbatim drive
/// path `\\?\C:\…` is local. Even a metadata read of a network path
/// reaches the server, so it is refused before any filesystem access.
pub fn is_network_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let separator = |at: usize| matches!(bytes.get(at), Some(b'/' | b'\\'));
    if !(separator(0) && separator(1)) {
        return false;
    }
    let verbatim_drive = bytes.get(2) == Some(&b'?')
        && separator(3)
        && bytes.get(4).is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(5) == Some(&b':')
        && (bytes.len() == 6 || separator(6));
    !verbatim_drive
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_drive_verbatim_prefix() {
        assert_eq!(
            user_facing_path_str(r"\\?\C:\Users\eeeoo\Documents\pro\mine"),
            r"C:\Users\eeeoo\Documents\pro\mine"
        );
    }

    #[test]
    fn strips_windows_unc_verbatim_prefix() {
        assert_eq!(
            user_facing_path_str(r"\\?\UNC\server\share\mine"),
            r"\\server\share\mine"
        );
    }

    #[test]
    fn a_path_of_two_leading_separators_is_a_network_path() {
        for path in [
            r"\\server\share\a.png",
            "//server/share/a.png",
            r"\\?\UNC\server\share\a.png",
            r"\\.\pipe\name",
            r"/\server\share",
            r"\\?\Volume{0}\a.png",
        ] {
            assert!(is_network_path(path), "{path}");
        }
        for path in [
            r"\\?\C:\Users\me\a.png",
            r"\\?\c:",
            r"C:\Users\me\a.png",
            "C:/Users/me/a.png",
            "/Users/me/a.png",
            r"\Users\me",
            "relative/a.png",
            "",
        ] {
            assert!(!is_network_path(path), "{path}");
        }
    }
}
