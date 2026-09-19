use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::AppError;
use crate::files::{TreeNode, tree};

use super::project;
use super::types::SpaceInfo;

#[derive(Debug, PartialEq, Eq)]
pub struct ContentOrderOutcome {
    pub parent_path: String,
    pub previous_order: Vec<String>,
    pub ordered_children: Vec<String>,
    pub changed: bool,
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

pub fn reorder_content(
    space: &str,
    parent_path: &str,
    ordered_children: Vec<String>,
) -> Result<ContentOrderOutcome, AppError> {
    let parent_path = tree::normalize_tree_parent_path(Some(parent_path))?;
    let actual_children = tree::list_tree_children(space, Some(&parent_path))?;
    let previous_order = actual_children
        .iter()
        .map(|child| child.path.clone())
        .collect::<Vec<_>>();
    let expected = previous_order.iter().collect::<HashSet<_>>();
    let proposed = ordered_children.iter().collect::<HashSet<_>>();

    if proposed.len() != ordered_children.len() {
        return Err(AppError::General(
            "orderedChildren contains duplicate paths".to_string(),
        ));
    }
    if proposed != expected {
        return Err(AppError::General(
            "orderedChildren must contain each current direct child exactly once".to_string(),
        ));
    }

    let changed = previous_order != ordered_children;
    if changed {
        let names = ordered_children
            .iter()
            .map(|path| {
                actual_children
                    .iter()
                    .find(|child| child.path == *path)
                    .map(|child| child.name.clone())
                    .ok_or_else(|| AppError::General(format!("unknown child path: {path}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut order = svode_core::content_tree::read_order(Path::new(space));
        order.insert(parent_path.clone(), names);
        svode_core::content_tree::write_order(Path::new(space), &order)?;
    }

    Ok(ContentOrderOutcome {
        parent_path: if parent_path == "." {
            String::new()
        } else {
            parent_path
        },
        previous_order,
        ordered_children,
        changed,
    })
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
    fn content_reorder_no_op_does_not_create_order_source() {
        let dir = tempfile::tempdir().expect("space");
        std::fs::write(dir.path().join("a.md"), "a").expect("a");
        std::fs::write(dir.path().join("b.md"), "b").expect("b");

        let outcome = reorder_content(
            dir.path().to_str().expect("utf8 path"),
            "",
            vec!["a.md".to_string(), "b.md".to_string()],
        )
        .expect("reorder");

        assert!(!outcome.changed);
        assert!(!dir.path().join(".svode/order.json").exists());
    }

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
