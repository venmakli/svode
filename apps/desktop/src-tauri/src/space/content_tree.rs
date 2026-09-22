use std::collections::HashMap;
use std::path::Path;

use crate::error::AppError;
use crate::files::{TreeNode, tree};

use super::project;
use super::types::SpaceInfo;

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
