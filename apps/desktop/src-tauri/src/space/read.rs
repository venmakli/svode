use std::path::Path;

use crate::error::AppError;

pub use svode_core::page::ResolvedSpaceTarget;

pub fn resolve_space_target(
    project: &Path,
    space_id: Option<&str>,
) -> Result<ResolvedSpaceTarget, AppError> {
    svode_core::page::resolve_space_target(project, space_id).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn root_and_ready_child_use_portable_config_without_bootstrap_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::create_dir(root.join("ready")).unwrap();
        fs::write(root.join(".svode/config.json"), r#"{"name":"Project","spaces":[{"id":"ready","path":"ready","repo":null},{"id":"missing","path":"missing","repo":null}]}"#).unwrap();
        let project = resolve_space_target(root, None).unwrap();
        assert_eq!(project.space_path, root.canonicalize().unwrap());
        let child = resolve_space_target(root, Some("ready")).unwrap();
        assert_eq!(child.space_path, root.join("ready").canonicalize().unwrap());
        for id in ["missing", "unknown"] {
            assert!(
                matches!(resolve_space_target(root, Some(id)), Err(AppError::SpaceNotFound(found)) if found == id)
            );
        }
        assert!(!root.join("ready/.svode").exists());
    }

    #[cfg(unix)]
    #[test]
    fn registered_child_symlink_cannot_escape_project() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(
            root.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[{"id":"ready","path":"ready","repo":null}]}"#,
        )
        .unwrap();
        symlink(&outside, root.join("ready")).unwrap();
        assert!(matches!(
            resolve_space_target(&root, Some("ready")),
            Err(AppError::PathNotAccessible(_))
        ));
    }
}
