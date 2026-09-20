use std::collections::HashMap;
use std::path::Path;

use crate::error::AppError;
use crate::files::{TreeNode, tree};

use super::project;
use super::types::SpaceInfo;

pub use svode_core::content_tree::ContentOrderOutcome;

pub fn reorder_content(
    space: &str,
    parent_path: &str,
    ordered_children: Vec<String>,
) -> Result<ContentOrderOutcome, AppError> {
    Ok(svode_core::content_tree::reorder_content(
        space,
        parent_path,
        ordered_children,
    )?)
}

#[derive(Debug)]
pub struct SpaceOrderOutcome {
    pub previous_order: Vec<String>,
    pub ordered_space_ids: Vec<String>,
    pub spaces: Vec<SpaceInfo>,
    pub changed: bool,
}

pub fn list_recursive(space: &str) -> Result<Vec<TreeNode>, AppError> {
    tree::build_tree(space)
}

pub fn list_children_checked(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<tree::TreeChildNode>, tree::TreeLoadError> {
    tree::list_tree_children_checked(space, parent_path)
}

pub fn read_order(space: &Path) -> HashMap<String, Vec<String>> {
    svode_core::content_tree::read_order(space)
}

pub fn replace_order(space: &Path, order: HashMap<String, Vec<String>>) -> Result<bool, AppError> {
    if svode_core::content_tree::read_order(space) == order {
        return Ok(false);
    }
    svode_core::content_tree::write_order(space, &order)?;
    Ok(true)
}

pub fn list_child_spaces(project_path: &Path) -> Result<Vec<SpaceInfo>, AppError> {
    project::list_spaces(project_path)
}

pub fn reorder_child_spaces(
    project_path: &Path,
    ordered_space_ids: Vec<String>,
) -> Result<SpaceOrderOutcome, AppError> {
    let previous_order = project::list_spaces(project_path)?
        .into_iter()
        .map(|space| space.id)
        .collect::<Vec<_>>();
    let changed = previous_order != ordered_space_ids;
    let spaces = if changed {
        project::reorder_spaces(project_path, ordered_space_ids.clone())?
    } else {
        project::list_spaces(project_path)?
    };
    Ok(SpaceOrderOutcome {
        previous_order,
        ordered_space_ids,
        spaces,
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::scaffold;
    use crate::space::types::SpaceRef;

    #[test]
    fn child_space_reorder_no_op_preserves_project_config_bytes() {
        let dir = tempfile::tempdir().expect("project");
        scaffold::scaffold_space(dir.path(), "Root", "", "").expect("scaffold");
        let mut config = super::super::config::read_space_config(dir.path()).expect("config");
        config.spaces = Some(vec![
            SpaceRef {
                id: "a".to_string(),
                path: "alpha".to_string(),
                repo: None,
            },
            SpaceRef {
                id: "b".to_string(),
                path: "beta".to_string(),
                repo: None,
            },
        ]);
        super::super::config::write_space_config(dir.path(), &config).expect("write config");
        let config_path = dir.path().join(".svode/config.json");
        let before = std::fs::read(&config_path).expect("before");

        let outcome = reorder_child_spaces(dir.path(), vec!["a".to_string(), "b".to_string()])
            .expect("reorder");

        assert!(!outcome.changed);
        assert_eq!(std::fs::read(config_path).expect("after"), before);
    }
}
