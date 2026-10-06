use std::path::Path;

use crate::error::AppError;
use svode_core::system_path;

use super::types::{LastView, RegistryEntry, SpaceRegistry};

/// Read the space registry from config_dir/spaces.json, creating defaults if missing.
pub fn read_registry(config_dir: &Path) -> Result<SpaceRegistry, AppError> {
    let path = config_dir.join("spaces.json");
    if !path.exists() {
        let registry = SpaceRegistry::default();
        write_registry(config_dir, &registry)?;
        return Ok(registry);
    }
    let data = std::fs::read_to_string(&path)?;
    let mut registry: SpaceRegistry = serde_json::from_str(&data)?;
    normalize_registry_paths(&mut registry);
    Ok(registry)
}

/// Write the space registry to config_dir/spaces.json.
pub fn write_registry(config_dir: &Path, registry: &SpaceRegistry) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let mut registry = registry.clone();
    normalize_registry_paths(&mut registry);
    let data = serde_json::to_string_pretty(&registry)?;
    std::fs::write(config_dir.join("spaces.json"), data)?;
    Ok(())
}

/// Add a space reference to the registry.
pub fn add_space(config_dir: &Path, id: &str, path: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    if !registry.spaces.iter().any(|w| w.id == id) {
        registry.spaces.push(RegistryEntry {
            id: id.to_string(),
            last_opened: None,
            path: system_path::user_facing_path_str(path),
        });
    }
    write_registry(config_dir, &registry)
}

fn normalize_registry_paths(registry: &mut SpaceRegistry) {
    for space in &mut registry.spaces {
        space.path = system_path::user_facing_path_str(&space.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_registry_normalizes_windows_verbatim_paths() {
        let dir = tempfile::tempdir().expect("config dir");
        std::fs::write(
            dir.path().join("spaces.json"),
            r#"{
  "spaces": [
    {
      "id": "root",
      "lastOpened": null,
      "path": "\\\\?\\C:\\Users\\eeeoo\\Documents\\pro\\mine"
    }
  ],
  "lastActive": "root"
}"#,
        )
        .expect("write registry");

        let registry = read_registry(dir.path()).expect("read registry");

        assert_eq!(
            registry.spaces[0].path,
            r"C:\Users\eeeoo\Documents\pro\mine"
        );
    }

    #[test]
    fn a_registry_without_the_last_view_reads_as_before() {
        let dir = tempfile::tempdir().expect("config dir");
        std::fs::write(
            dir.path().join("spaces.json"),
            r#"{ "spaces": [{ "id": "root", "lastOpened": null, "path": "/p" }], "lastActive": "root" }"#,
        )
        .expect("write registry");

        let registry = read_registry(dir.path()).expect("read registry");

        assert_eq!(registry.last_active.as_deref(), Some("root"));
        assert_eq!(registry.last_view, None);
    }

    #[test]
    fn the_last_view_is_stored_beside_the_last_active_project() {
        let dir = tempfile::tempdir().expect("config dir");
        add_space(dir.path(), "root", "/p").expect("add project");
        update_last_active(dir.path(), "root").expect("last active");

        update_last_view(dir.path(), LastView::Home).expect("last view");

        let stored: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join("spaces.json")).expect("read file"),
        )
        .expect("parse registry");
        assert_eq!(stored["lastActive"], "root");
        assert_eq!(stored["lastView"], serde_json::json!({ "kind": "home" }));
        assert_eq!(stored["spaces"][0]["lastOpened"], serde_json::Value::Null);

        update_last_view(
            dir.path(),
            LastView::Project {
                project_id: "root".to_string(),
            },
        )
        .expect("last view");
        assert_eq!(
            read_registry(dir.path()).expect("read registry").last_view,
            Some(LastView::Project {
                project_id: "root".to_string()
            })
        );
    }

    #[test]
    fn a_view_of_a_later_version_reads_as_unknown() {
        let registry: SpaceRegistry = serde_json::from_value(serde_json::json!({
            "spaces": [],
            "lastActive": null,
            "lastView": { "kind": "workspace", "workspaceId": "w" }
        }))
        .expect("read registry");

        assert_eq!(registry.last_view, Some(LastView::Unknown));
    }
}

/// Find a space ref by id.
pub fn find_space(config_dir: &Path, id: &str) -> Result<Option<RegistryEntry>, AppError> {
    let registry = read_registry(config_dir)?;
    Ok(registry.spaces.iter().find(|w| w.id == id).cloned())
}

/// Remove a space reference from the registry.
pub fn remove_space(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.spaces.retain(|w| w.id != id);
    if registry.last_active.as_deref() == Some(id) {
        registry.last_active = None;
    }
    write_registry(config_dir, &registry)
}

/// Set the last active space in the registry.
pub fn update_last_active(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.last_active = Some(id.to_string());
    write_registry(config_dir, &registry)
}

/// Remember the view of the window the user was in last.
pub fn update_last_view(config_dir: &Path, view: LastView) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.last_view = Some(view);
    write_registry(config_dir, &registry)
}

/// Update the last_opened timestamp on a space reference.
pub fn update_last_opened(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(ws) = registry.spaces.iter_mut().find(|w| w.id == id) {
        ws.last_opened = Some(now);
    }
    write_registry(config_dir, &registry)
}

/// Resolve the existing root registration; reading an App never registers a project.
pub(crate) fn find_project_by_path(
    config_dir: &Path,
    path: &Path,
) -> Result<RegistryEntry, AppError> {
    let path = path.canonicalize()?;
    let registry: SpaceRegistry =
        serde_json::from_slice(&std::fs::read(config_dir.join("spaces.json"))?)?;
    let mut matches = registry
        .spaces
        .iter()
        .filter(|entry| Path::new(&entry.path).canonicalize().ok().as_ref() == Some(&path));
    let project = matches
        .next()
        .ok_or_else(|| AppError::Storage("Project registration is unavailable".into()))?;
    if matches.next().is_some()
        || project.id.is_empty()
        || registry
            .spaces
            .iter()
            .filter(|entry| entry.id == project.id)
            .count()
            != 1
    {
        return Err(AppError::Storage(
            "Project registration is ambiguous".into(),
        ));
    }
    Ok(project.clone())
}
