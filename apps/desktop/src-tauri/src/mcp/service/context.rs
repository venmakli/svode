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
        return Ok(Some(root_context(Path::new(project_path))?));
    }

    let Some(caller_cwd) = context_override
        .caller_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let cwd = PathBuf::from(caller_cwd).canonicalize().map_err(|error| {
        McpBusinessError::new(
            "CALLER_CWD_NOT_ACCESSIBLE",
            format!("caller cwd '{caller_cwd}' is not accessible: {error}"),
        )
    })?;
    let config_dir = app.path().app_data_dir().ok();
    let root = match resolve_project_root_for_cwd(config_dir.as_deref(), &cwd) {
        Ok(root) => root,
        Err(error) if error.code == "PROJECT_CONTEXT_NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(root_context(&root)?))
}

fn root_context(project_path: &Path) -> Result<ActiveProjectContext, McpBusinessError> {
    let project = project_path.canonicalize().map_err(|error| {
        McpBusinessError::new(
            "PROJECT_PATH_NOT_ACCESSIBLE",
            format!(
                "project path '{}' is not accessible: {error}",
                project_path.display()
            ),
        )
    })?;
    active::build_context(
        project.to_string_lossy().to_string(),
        None,
        Some(project.to_string_lossy().to_string()),
    )
    .map_err(Into::into)
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
