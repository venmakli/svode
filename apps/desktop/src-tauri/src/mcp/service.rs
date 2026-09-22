use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use crate::git::GitState;
use crate::index::IndexState;
use crate::index::update::IndexUpdateState;
use crate::space::{config as space_config, project, registry};
use svode_mcp::error::McpBusinessError;
use svode_mcp::host::{RequestTarget, RoutineCaller};
use svode_mcp::protocol::{IpcContextOverride, ToolCallResult};

mod context;
mod dispatch;

#[cfg(test)]
use context::resolve_project_root_for_cwd;
pub(crate) use dispatch::DesktopMcpHost;
pub use dispatch::call_tool_with_context;

/// Frozen target of a request in the public MCP addressing vocabulary.
fn request_target(
    context: &ActiveProjectContext,
    routine_caller: Option<RoutineCaller>,
) -> RequestTarget {
    RequestTarget {
        project_path: context.project_path.clone(),
        default_space_id: context.active_space_id.clone(),
        default_space_path: context.active_space_path.clone(),
        routine_caller,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scaffold_test_space(path: &Path, name: &str) {
        crate::space::scaffold::scaffold_space(path, name, "", "").expect("scaffold space");
    }

    #[test]
    fn registry_context_resolution_uses_registered_root_for_child_space_cwd() {
        let temp = tempfile::tempdir().expect("temp dir");
        let config_dir = temp.path().join("app-data");
        let project = temp.path().join("project");
        let child = project.join("child");
        let nested = child.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        scaffold_test_space(&project, "Project");
        scaffold_test_space(&child, "Child");
        registry::add_space(&config_dir, "project", &project.to_string_lossy())
            .expect("register project");

        let root =
            resolve_project_root_for_cwd(Some(&config_dir), &nested).expect("resolve project root");

        assert_eq!(
            root.canonicalize().expect("root canonical"),
            project.canonicalize().expect("project canonical")
        );
    }

    #[test]
    fn ancestor_context_resolution_uses_highest_svode_space_without_registry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let child = project.join("child");
        let nested = child.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        scaffold_test_space(&project, "Project");
        scaffold_test_space(&child, "Child");

        let root = resolve_project_root_for_cwd(None, &nested).expect("resolve project root");

        assert_eq!(root, project);
    }
}
