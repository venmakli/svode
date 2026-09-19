use std::collections::HashMap;
#[cfg(test)]
use std::fs;
use std::path::Path;

use crate::AppError;
use serde::Serialize;

#[cfg(test)]
use svode_core::content_tree::TreeChildKind;
pub use svode_core::content_tree::read_order;
pub use svode_core::content_tree::{TreeChildNode, TreeNode};
pub(crate) use svode_core::content_tree::{
    child_folder_names, has_direct_schema, read_frontmatter_meta_head,
    read_frontmatter_meta_head_with_fallback,
};
#[cfg(test)]
use svode_core::page::identity::SourceShape;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TreeLoadError {
    Missing {
        path: String,
    },
    Hidden {
        path: String,
    },
    Unavailable {
        message: String,
        #[serde(skip)]
        source: AppError,
    },
}

pub fn build_tree(space: &str) -> Result<Vec<TreeNode>, AppError> {
    svode_core::content_tree::build_tree(space).map_err(Into::into)
}

pub fn list_tree_children(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<TreeChildNode>, AppError> {
    svode_core::content_tree::list_tree_children(space, parent_path).map_err(Into::into)
}

pub fn list_tree_children_checked(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<TreeChildNode>, TreeLoadError> {
    svode_core::content_tree::list_tree_children_checked(space, parent_path).map_err(|error| {
        match error {
            svode_core::content_tree::TreeLoadError::Missing { path } => {
                TreeLoadError::Missing { path }
            }
            svode_core::content_tree::TreeLoadError::Hidden { path } => {
                TreeLoadError::Hidden { path }
            }
            svode_core::content_tree::TreeLoadError::Unavailable { source, .. } => {
                let source = AppError::from(source);
                TreeLoadError::Unavailable {
                    message: source.to_string(),
                    source,
                }
            }
        }
    })
}

pub(crate) fn normalize_tree_parent_path(parent_path: Option<&str>) -> Result<String, AppError> {
    svode_core::content_tree::normalize_tree_parent_path(parent_path).map_err(Into::into)
}

pub fn write_order(space: &Path, order: &HashMap<String, Vec<String>>) -> Result<(), AppError> {
    let svode_dir = space.join(".svode");
    std::fs::create_dir_all(&svode_dir)?;
    let data = serde_json::to_string_pretty(order)?;
    std::fs::write(svode_dir.join("order.json"), data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, TreeSpaceConfig};
    use tempfile::TempDir;

    fn write_tree_config(tmp: &TempDir, exclude: Vec<&str>, include: Vec<&str>) {
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Test".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: exclude.into_iter().map(ToString::to_string).collect(),
                    include: include.into_iter().map(ToString::to_string).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .expect("write config");
    }

    fn child_names(nodes: &[TreeNode]) -> Vec<String> {
        nodes.iter().map(|node| node.name.clone()).collect()
    }

    fn child_names_direct(nodes: &[TreeChildNode]) -> Vec<String> {
        nodes.iter().map(|node| node.name.clone()).collect()
    }

    fn write_doc(path: &Path, title: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(
            path,
            format!(
                "---\nid: test\ntitle: {title}\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nBody that lazy tree listing should not need.\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn app_policy_matches_listing_hint_fallback_and_stale_branch_access() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("app/public/deep")).unwrap();
        fs::write(root.join("app/app.yaml"), "invalid").unwrap();
        fs::write(root.join("app/public/deep/README.md"), "deep").unwrap();
        fs::write(root.join("app/binary.pdf"), "binary").unwrap();
        let space = root.to_str().unwrap();
        assert!(!list_tree_children(space, None).unwrap()[0].has_children);
        assert!(list_tree_children(space, Some("app")).unwrap().is_empty());
        assert!(build_tree(space).unwrap()[0].children.is_empty());
        assert!(matches!(
            list_tree_children_checked(space, Some("app/public/deep")),
            Err(TreeLoadError::Hidden { .. })
        ));
        fs::write(root.join("app/public/readme.md"), "Public").unwrap();
        assert!(list_tree_children(space, None).unwrap()[0].has_children);
        assert_eq!(
            list_tree_children(space, Some("app")).unwrap()[0].path,
            "app/public/readme.md"
        );
        assert!(list_tree_children_checked(space, Some("app/public/deep")).is_ok());
        fs::write(root.join(".gitignore"), "app/public/readme.md").unwrap();
        assert!(list_tree_children(space, Some("app")).unwrap().is_empty());
        assert!(matches!(
            list_tree_children_checked(space, Some("app/public")),
            Err(TreeLoadError::Hidden { .. })
        ));
        fs::write(root.join(".gitignore"), "app/app.yaml").unwrap();
        assert!(!list_tree_children(space, None).unwrap()[0].has_app);
        assert_eq!(list_tree_children(space, Some("app")).unwrap().len(), 1);
    }

    #[test]
    fn checked_tree_distinguishes_missing_policy_and_unavailable_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        write_tree_config(&tmp, vec!["hidden"], vec![]);
        fs::write(tmp.path().join("file"), "not a directory").unwrap();
        for path in ["gone/README.md", "gone/nested", "file/child"] {
            assert!(matches!(
                list_tree_children_checked(root, Some(path)),
                Err(TreeLoadError::Missing { .. })
            ));
        }
        assert!(matches!(
            list_tree_children_checked(root, Some("hidden/child")),
            Err(TreeLoadError::Hidden { .. })
        ));
        assert!(matches!(
            list_tree_children_checked(&format!("{root}/absent-root"), Some("gone")),
            Err(TreeLoadError::Unavailable { .. })
        ));
        assert!(matches!(
            list_tree_children_checked(root, Some("../escape")),
            Err(TreeLoadError::Unavailable { .. })
        ));
        assert_eq!(
            serde_json::to_value(TreeLoadError::Missing {
                path: "gone".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "missing", "path": "gone"})
        );
    }

    #[cfg(unix)]
    #[test]
    fn checked_tree_preserves_denied_ancestor_and_symlink_boundaries() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();
        let denied = tmp.path().join("denied");
        fs::create_dir(&denied).unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0)).unwrap();
        let result = list_tree_children_checked(root, Some("denied/missing"));
        let enforced = fs::read_dir(&denied).is_err();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        if enforced {
            assert!(matches!(result, Err(TreeLoadError::Unavailable { .. })));
        }
        symlink(tmp.path().join("absent"), tmp.path().join("link")).unwrap();
        assert!(matches!(
            list_tree_children_checked(root, Some("link/missing")),
            Err(TreeLoadError::Hidden { .. })
        ));
        assert!(list_tree_children_checked(root, Some("denied")).is_ok());
    }

    #[test]
    fn list_tree_children_root_returns_direct_children_only() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("a.md"), "A");
        write_doc(&tmp.path().join("folder").join("b.md"), "B");
        write_doc(&tmp.path().join("folder").join("nested").join("c.md"), "C");

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("children");

        assert_eq!(
            child_names_direct(&nodes),
            vec!["a.md".to_string(), "folder".to_string()]
        );
        assert!(!child_names_direct(&nodes).contains(&"b.md".to_string()));
        let folder = nodes.iter().find(|node| node.name == "folder").unwrap();
        assert_eq!(folder.parent, None);
        assert_eq!(folder.kind, TreeChildKind::Folder);
        assert_eq!(folder.source_shape, SourceShape::Directory);
        assert!(folder.has_children);
    }

    #[test]
    fn list_tree_children_folder_parent_returns_direct_children_only() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("docs").join("a.md"), "A");
        write_doc(&tmp.path().join("docs").join("nested").join("b.md"), "B");
        write_doc(
            &tmp.path()
                .join("docs")
                .join("nested")
                .join("deep")
                .join("c.md"),
            "C",
        );

        let nodes =
            list_tree_children(tmp.path().to_str().unwrap(), Some("docs")).expect("children");

        assert_eq!(
            child_names_direct(&nodes),
            vec!["a.md".to_string(), "nested".to_string()]
        );
        assert!(!child_names_direct(&nodes).contains(&"b.md".to_string()));
        assert!(
            nodes
                .iter()
                .all(|node| node.parent.as_deref() == Some("docs"))
        );
        assert!(
            nodes
                .iter()
                .find(|node| node.name == "nested")
                .unwrap()
                .has_children
        );
    }

    #[test]
    fn list_tree_children_uses_readme_as_folder_metadata_without_duplicate_child() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("docs").join("README.md"), "Docs Home");
        write_doc(&tmp.path().join("docs").join("child.md"), "Child");

        let root_nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");
        let docs = root_nodes
            .iter()
            .find(|node| node.name == "docs")
            .expect("docs");

        assert_eq!(docs.path, "docs/README.md");
        assert_eq!(docs.title, "Docs Home");
        assert_eq!(docs.kind, TreeChildKind::Page);
        assert_eq!(docs.source_shape, SourceShape::Directory);
        assert!(docs.has_children);

        let children = list_tree_children(tmp.path().to_str().unwrap(), Some("docs/README.md"))
            .expect("docs children");

        assert_eq!(child_names_direct(&children), vec!["child.md".to_string()]);
        assert!(!child_names_direct(&children).contains(&"README.md".to_string()));
    }

    #[test]
    fn app_capability_preserves_directory_backed_page_identity() {
        let tmp = TempDir::new().unwrap();
        write_doc(
            &tmp.path().join("dashboard").join("README.md"),
            "Dashboard docs",
        );
        fs::write(
            tmp.path().join("dashboard").join("app.yaml"),
            "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\n",
        )
        .unwrap();

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");
        let dashboard = nodes
            .iter()
            .find(|node| node.name == "dashboard")
            .expect("dashboard");

        assert_eq!(dashboard.path, "dashboard/README.md");
        assert_eq!(dashboard.title, "Dashboard docs");
        assert_eq!(dashboard.kind, TreeChildKind::Page);
        assert!(dashboard.has_app);
        assert_eq!(dashboard.source_shape, SourceShape::Directory);
    }

    #[test]
    fn invalid_manifest_still_adds_capability_without_replacing_page() {
        let tmp = TempDir::new().unwrap();
        write_doc(
            &tmp.path().join("broken-app").join("README.md"),
            "Broken app docs",
        );
        fs::write(
            tmp.path().join("broken-app").join("app.yaml"),
            "not: valid: yaml",
        )
        .unwrap();

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");
        let app = nodes
            .iter()
            .find(|node| node.name == "broken-app")
            .expect("broken app");

        assert_eq!(app.path, "broken-app/README.md");
        assert_eq!(app.kind, TreeChildKind::Page);
        assert!(app.has_app);
    }

    #[test]
    fn app_only_directory_is_a_semantic_owner_and_hides_source_directories() {
        let tmp = TempDir::new().unwrap();
        let app = tmp.path().join("dashboard");
        fs::create_dir_all(app.join("src/components")).unwrap();
        fs::write(app.join("app.yaml"), "invalid").unwrap();
        fs::write(app.join("src/main.ts"), "export {};").unwrap();
        write_doc(&app.join("notes.md"), "Notes");
        write_doc(&app.join("nested-page/README.md"), "Nested Page");
        fs::create_dir_all(app.join("nested-app")).unwrap();
        fs::write(app.join("nested-app/app.yaml"), "invalid").unwrap();

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");
        let dashboard = nodes
            .iter()
            .find(|node| node.name == "dashboard")
            .expect("dashboard");

        assert_eq!(dashboard.path, "dashboard");
        assert_eq!(dashboard.kind, TreeChildKind::App);
        assert!(dashboard.has_app);
        assert!(dashboard.has_children);

        let children = list_tree_children(tmp.path().to_str().unwrap(), Some("dashboard"))
            .expect("App children");
        assert_eq!(
            child_names_direct(&children),
            vec![
                "nested-app".to_string(),
                "nested-page".to_string(),
                "notes.md".to_string(),
            ]
        );
        assert!(!child_names_direct(&children).contains(&"src".to_string()));
    }

    #[test]
    fn space_readme_is_owner_content_not_a_page_tree_child() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("README.md"), "Space home");
        write_doc(&tmp.path().join("page.md"), "Page");

        let direct = list_tree_children(tmp.path().to_str().unwrap(), None).expect("children");
        let recursive = build_tree(tmp.path().to_str().unwrap()).expect("tree");

        assert_eq!(child_names_direct(&direct), vec!["page.md".to_string()]);
        assert_eq!(child_names(&recursive), vec!["page.md".to_string()]);
        assert_eq!(direct[0].kind, TreeChildKind::Page);
        assert_eq!(direct[0].source_shape, SourceShape::File);
    }

    #[test]
    fn list_tree_children_ignores_user_heavy_dir_and_does_not_count_it_as_children() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        write_doc(
            &tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "Package",
        );
        write_doc(&tmp.path().join("docs").join("README.md"), "Docs");
        write_doc(
            &tmp.path()
                .join("docs")
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "Nested Package",
        );

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");

        assert_eq!(child_names_direct(&nodes), vec!["docs".to_string()]);
        let docs = nodes.iter().find(|node| node.name == "docs").unwrap();
        assert!(!docs.has_children);

        let docs_children =
            list_tree_children(tmp.path().to_str().unwrap(), Some("docs")).expect("docs");
        assert!(docs_children.is_empty());
    }

    #[test]
    fn read_order_normalizes_windows_directory_keys() {
        let tmp = TempDir::new().unwrap();
        let svode = tmp.path().join(".svode");
        fs::create_dir_all(&svode).unwrap();
        fs::write(
            svode.join("order.json"),
            r#"{"operations\\board":["task.md"],".":["operations"]}"#,
        )
        .unwrap();

        let order = read_order(tmp.path());

        assert!(order.contains_key("operations/board"));
        assert!(!order.contains_key("operations\\board"));
        assert_eq!(
            order.get("operations/board").unwrap(),
            &vec!["task.md".to_string()]
        );
    }

    #[test]
    fn build_tree_applies_system_excludes() {
        let tmp = TempDir::new().unwrap();
        for dirname in [".git", ".svode", ".assets", ".templates", ".cache"] {
            fs::create_dir_all(tmp.path().join(dirname)).unwrap();
            fs::write(tmp.path().join(dirname).join("README.md"), "hidden").unwrap();
        }
        fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");

        assert_eq!(child_names(&nodes), vec!["visible.md".to_string()]);
    }

    #[test]
    fn build_tree_lets_user_include_override_user_exclude() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs/*.md"], vec!["docs/keep.md"]);
        fs::create_dir_all(tmp.path().join("docs")).unwrap();
        fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        fs::write(tmp.path().join("docs").join("keep.md"), "keep").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let docs = nodes.iter().find(|node| node.name == "docs").expect("docs");

        assert_eq!(child_names(&docs.children), vec!["keep.md".to_string()]);
    }

    #[test]
    fn build_tree_descends_to_user_included_paths_inside_excluded_parent() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs"], vec!["docs/guides/keep.md"]);
        fs::create_dir_all(tmp.path().join("docs").join("guides")).unwrap();
        fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        fs::write(
            tmp.path().join("docs").join("guides").join("drop.md"),
            "drop",
        )
        .unwrap();
        fs::write(
            tmp.path().join("docs").join("guides").join("keep.md"),
            "keep",
        )
        .unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let docs = nodes.iter().find(|node| node.name == "docs").expect("docs");
        let guides = docs
            .children
            .iter()
            .find(|node| node.name == "guides")
            .expect("guides");

        assert_eq!(child_names(&docs.children), vec!["guides".to_string()]);
        assert_eq!(child_names(&guides.children), vec!["keep.md".to_string()]);
    }

    #[test]
    fn build_tree_does_not_descend_into_ignored_dirs() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        fs::create_dir_all(tmp.path().join("node_modules").join("pkg")).unwrap();
        fs::write(
            tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "pkg",
        )
        .unwrap();
        fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");

        assert_eq!(child_names(&nodes), vec!["visible.md".to_string()]);
    }

    #[test]
    fn build_tree_matches_direct_relative_exclude_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["src/generated"], vec![]);
        fs::create_dir_all(tmp.path().join("src").join("generated")).unwrap();
        fs::write(
            tmp.path().join("src").join("generated").join("client.md"),
            "generated",
        )
        .unwrap();
        fs::write(tmp.path().join("src").join("manual.md"), "manual").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let src = nodes.iter().find(|node| node.name == "src").expect("src");

        assert_eq!(child_names(&src.children), vec!["manual.md".to_string()]);
    }
}
