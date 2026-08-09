use super::*;

pub(super) fn active_context(app: &AppHandle) -> Result<ActiveProjectContext, McpBusinessError> {
    if let Ok(Some(context)) = MCP_CONTEXT_OVERRIDE.try_with(Clone::clone) {
        return Ok(context);
    }

    app.state::<ActiveProjectState>()
        .get()
        .ok_or_else(McpBusinessError::no_active_project)
}
pub(super) fn resolve_context_override(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
) -> Result<Option<ActiveProjectContext>, McpBusinessError> {
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

fn canonical_caller_cwd(caller_cwd: Option<&str>) -> Result<Option<PathBuf>, McpBusinessError> {
    let Some(caller_cwd) = caller_cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    PathBuf::from(caller_cwd)
        .canonicalize()
        .map(Some)
        .map_err(|error| {
            McpBusinessError::new(
                "CALLER_CWD_NOT_ACCESSIBLE",
                format!("caller cwd '{caller_cwd}' is not accessible: {error}"),
            )
        })
}

fn context_for_project_cwd(
    project_path: &Path,
    caller_cwd: Option<&Path>,
) -> Result<ActiveProjectContext, McpBusinessError> {
    let project = project_path.canonicalize().map_err(|error| {
        McpBusinessError::new(
            "PROJECT_PATH_NOT_ACCESSIBLE",
            format!(
                "project path '{}' is not accessible: {error}",
                project_path.display()
            ),
        )
    })?;
    let child = caller_cwd
        .filter(|cwd| cwd.starts_with(&project))
        .and_then(|cwd| most_specific_ready_child(&project, cwd));
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

fn most_specific_ready_child(project_path: &Path, cwd: &Path) -> Option<(String, PathBuf)> {
    let config = space_config::read_space_config(project_path).ok()?;
    config
        .spaces
        .unwrap_or_default()
        .into_iter()
        .filter(|space| {
            matches!(
                project::space_ref_status(project_path, space),
                crate::space::types::SpaceStatus::Ready
            )
        })
        .filter_map(|space| {
            let path = project_path.join(&space.path).canonicalize().ok()?;
            cwd.starts_with(&path).then_some((space.id, path))
        })
        .max_by_key(|(_, path)| path.components().count())
}

pub(super) fn resolve_project_root_for_cwd(
    config_dir: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf, McpBusinessError> {
    if let Some(config_dir) = config_dir
        && let Some(root) = registry_project_root_for_cwd(config_dir, cwd)?
    {
        return Ok(root);
    }

    ancestor_svode_project_root(cwd).ok_or_else(|| {
        McpBusinessError::new(
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
) -> Result<Option<PathBuf>, McpBusinessError> {
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

    #[test]
    fn project_boundary_keeps_most_specific_ready_child_from_caller_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let child = project.join("child");
        let nested_child = child.join("nested");
        let caller = nested_child.join("docs");
        fs::create_dir_all(&caller).unwrap();
        write_project(
            &project,
            &[
                ("child-id", "child", None),
                ("nested-id", "child/nested", None),
                (
                    "missing-id",
                    "missing",
                    Some("https://example.invalid/missing.git"),
                ),
            ],
        );

        let caller = caller.canonicalize().unwrap();
        let context = context_for_project_cwd(&project, Some(&caller)).unwrap();

        assert_eq!(context.active_space_id.as_deref(), Some("nested-id"));
        assert_eq!(
            Path::new(&context.active_space_path),
            nested_child.canonicalize().unwrap()
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

pub(super) async fn resolve_space(
    app: &AppHandle,
    requested_space_id: Option<String>,
) -> Result<(ActiveProjectContext, String), McpBusinessError> {
    let context = active_context(app)?;
    if let Some(space_id) = requested_space_id {
        if is_mcp_root_space_id(&space_id) {
            return Ok((context.clone(), context.project_path.clone()));
        }
        let state = app.state::<IndexState>();
        let path = state
            .space_path_of(Path::new(&context.project_path), Some(&space_id))
            .await?;
        Ok((context, path.to_string_lossy().to_string()))
    } else {
        Ok((context.clone(), context.active_space_path))
    }
}
