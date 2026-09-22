use super::*;

pub(super) fn resolve_context_override(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
) -> Result<Option<ActiveProjectContext>, ToolError> {
    let Some(context_override) = context_override else {
        return Ok(None);
    };

    if let Some(project_path) = context_override
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let caller_cwd = canonical_caller_cwd(context_override.caller_cwd.as_deref())?;
        return Ok(Some(context_for_project_cwd(
            Path::new(project_path),
            caller_cwd.as_deref(),
        )?));
    }

    let Some(caller_cwd) = context_override
        .caller_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let cwd = canonical_caller_cwd(Some(caller_cwd))?.expect("non-empty caller cwd");
    let config_dir = app.path().app_data_dir().ok();
    let root = match resolve_project_root_for_cwd(config_dir.as_deref(), &cwd) {
        Ok(root) => root,
        Err(error) if error.code == "PROJECT_CONTEXT_NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(context_for_project_cwd(&root, Some(&cwd))?))
}

fn canonical_caller_cwd(caller_cwd: Option<&str>) -> Result<Option<PathBuf>, ToolError> {
    let Some(caller_cwd) = caller_cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    PathBuf::from(caller_cwd)
        .canonicalize()
        .map(Some)
        .map_err(|error| {
            ToolError::new(
                "CALLER_CWD_NOT_ACCESSIBLE",
                format!("caller cwd '{caller_cwd}' is not accessible: {error}"),
            )
        })
}

fn context_for_project_cwd(
    project_path: &Path,
    caller_cwd: Option<&Path>,
) -> Result<ActiveProjectContext, ToolError> {
    let project = project_path.canonicalize().map_err(|error| {
        ToolError::new(
            "PROJECT_PATH_NOT_ACCESSIBLE",
            format!(
                "project path '{}' is not accessible: {error}",
                project_path.display()
            ),
        )
    })?;
    let child = caller_cwd
        .filter(|cwd| cwd.starts_with(&project))
        .and_then(|cwd| svode_core::page::ready_child_space_for_directory(&project, cwd));
    let active_space_id = child.as_ref().map(|(space_id, _)| space_id.clone());
    let active_space_path = child
        .map(|(_, path)| path.to_string_lossy().to_string())
        .or_else(|| Some(project.to_string_lossy().to_string()));
    active::build_context(
        project.to_string_lossy().to_string(),
        active_space_id,
        active_space_path,
    )
    .map_err(Into::into)
}

pub(super) fn resolve_project_root_for_cwd(
    config_dir: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf, ToolError> {
    if let Some(config_dir) = config_dir
        && let Some(root) = registry_project_root_for_cwd(config_dir, cwd)?
    {
        return Ok(root);
    }

    ancestor_svode_project_root(cwd).ok_or_else(|| {
        ToolError::new(
            "PROJECT_CONTEXT_NOT_FOUND",
            format!(
                "could not resolve a Svode project root from caller cwd '{}'",
                cwd.display()
            ),
        )
    })
}

fn registry_project_root_for_cwd(
    config_dir: &Path,
    cwd: &Path,
) -> Result<Option<PathBuf>, ToolError> {
    let registry = registry::read_registry(config_dir)?;
    let mut best: Option<PathBuf> = None;

    for entry in registry.spaces {
        let Ok(root) = PathBuf::from(entry.path).canonicalize() else {
            continue;
        };
        if !cwd.starts_with(&root) || space_config::read_space_config(&root).is_err() {
            continue;
        }
        let replace = best
            .as_ref()
            .is_none_or(|current| root.components().count() > current.components().count());
        if replace {
            best = Some(root);
        }
    }

    Ok(best)
}

fn ancestor_svode_project_root(cwd: &Path) -> Option<PathBuf> {
    let mut root = None;
    for candidate in cwd.ancestors() {
        if space_config::read_space_config(candidate).is_ok() {
            root = Some(candidate.to_path_buf());
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::project;
    use std::fs;

    fn write_project(project: &Path, children: &[(&str, &str, Option<&str>)]) {
        fs::create_dir_all(project.join(".svode")).unwrap();
        let spaces = children
            .iter()
            .map(|(id, path, repo)| serde_json::json!({ "id": id, "path": path, "repo": repo }))
            .collect::<Vec<_>>();
        fs::write(
            project.join(".svode/config.json"),
            serde_json::to_vec(&serde_json::json!({
                "name": "Project",
                "spaces": spaces,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// The Space model is flat: a Project knows only its direct children, each
    /// registered as a single folder segment. A caller working deep inside a
    /// registered Space still resolves to that Space, and unready references are
    /// skipped.
    #[test]
    fn project_boundary_keeps_most_specific_ready_child_from_caller_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let child = project.join("child");
        let caller = child.join("nested").join("docs");
        fs::create_dir_all(&caller).unwrap();
        fs::create_dir_all(project.join("sibling")).unwrap();
        write_project(
            &project,
            &[
                ("child-id", "child", None),
                ("sibling-id", "sibling", None),
                (
                    "missing-id",
                    "missing",
                    Some("https://example.invalid/missing.git"),
                ),
            ],
        );

        let caller = caller.canonicalize().unwrap();
        let context = context_for_project_cwd(&project, Some(&caller)).unwrap();

        assert_eq!(context.active_space_id.as_deref(), Some("child-id"));
        assert_eq!(
            Path::new(&context.active_space_path),
            child.canonicalize().unwrap()
        );
    }

    #[test]
    fn missing_or_broken_child_falls_back_to_root() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let unrelated = project.join("unregistered");
        fs::create_dir_all(&unrelated).unwrap();
        write_project(
            &project,
            &[
                (
                    "missing-id",
                    "missing",
                    Some("https://example.invalid/missing.git"),
                ),
                ("broken-id", "broken", None),
            ],
        );

        let config = space_config::read_space_config(&project).unwrap();
        let spaces = config.spaces.unwrap();
        assert_eq!(
            project::space_ref_status(&project, &spaces[0]),
            crate::space::types::SpaceStatus::Missing
        );
        assert_eq!(
            project::space_ref_status(&project, &spaces[1]),
            crate::space::types::SpaceStatus::Broken
        );

        let unrelated = unrelated.canonicalize().unwrap();
        let context = context_for_project_cwd(&project, Some(&unrelated)).unwrap();

        assert_eq!(context.active_space_id, None);
        assert_eq!(
            Path::new(&context.active_space_path),
            project.canonicalize().unwrap()
        );
    }
}
