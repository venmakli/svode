use std::path::Path;

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
}
