use std::fs;

use svode_core::content_tree::{
    TreeChildKind, build_tree, list_project_children, list_tree_children_checked,
};
use svode_core::page::SpaceReadiness;

#[test]
fn core_lists_the_same_visible_children_without_desktop_runtime() {
    let space = tempfile::tempdir().unwrap();
    let root = space.path();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","spaces":[{"id":"child","path":"child","repo":null},{"id":"missing","path":"missing","repo":null},{"id":"remote","path":"remote","repo":"ssh://example.test/remote"}],"tree":{"exclude":["hidden"]}}"#,
    )
    .unwrap();
    fs::write(
        root.join(".svode/order.json"),
        r#"{".":["docs","data","z.md"]}"#,
    )
    .unwrap();
    fs::write(root.join("README.md"), "---\ntitle: Home\n---\n").unwrap();
    fs::write(root.join("z.md"), "---\ntitle: Z\n---\n").unwrap();
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("docs/README.md"), "---\ntitle: Docs\n---\n").unwrap();
    fs::write(root.join("docs/page.md"), "---\ntitle: Page\n---\n").unwrap();
    fs::create_dir(root.join("data")).unwrap();
    fs::write(
        root.join("data/schema.yaml"),
        "name: Data\nproperties: {}\n",
    )
    .unwrap();
    fs::write(root.join("data/README.md"), "---\ntitle: Data\n---\n").unwrap();
    fs::write(root.join("data/item.md"), "---\ntitle: Item\n---\n").unwrap();
    fs::create_dir(root.join("child")).unwrap();
    fs::write(root.join("child/page.md"), "child").unwrap();
    fs::create_dir(root.join("child/.svode")).unwrap();
    fs::write(
        root.join("child/.svode/config.json"),
        r#"{"name":"Child Space","icon":"star","description":"Nested","spaces":[{"id":"grandchild","path":"grandchild","repo":null}]}"#,
    )
    .unwrap();
    fs::write(root.join("child/schema.yaml"), "name: Child\n").unwrap();
    fs::write(root.join("child/app.yaml"), "invalid but present").unwrap();
    fs::create_dir(root.join("hidden")).unwrap();
    fs::write(root.join("hidden/page.md"), "hidden").unwrap();

    let root_str = root.to_str().unwrap();
    let direct = list_tree_children_checked(root_str, None).unwrap();
    assert_eq!(
        direct
            .iter()
            .map(|node| node.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/README.md", "data/README.md", "z.md"]
    );
    assert_eq!(direct[0].kind, TreeChildKind::Page);
    assert!(direct[0].has_children);
    assert_eq!(direct[1].kind, TreeChildKind::Collection);

    let recursive = build_tree(root_str).unwrap();
    assert_eq!(
        recursive
            .iter()
            .map(|node| node.path.as_str())
            .collect::<Vec<_>>(),
        ["docs/README.md", "data/README.md", "z.md"]
    );
    assert_eq!(recursive[0].children[0].path, "docs/page.md");
    assert_eq!(recursive[1].children[0].path, "data/item.md");
    let children = list_project_children(root).unwrap();
    assert_eq!(children.len(), 3);
    assert_eq!(children[0].status, SpaceReadiness::Ready);
    assert_eq!(children[0].name, "Child Space");
    assert_eq!(children[0].icon, "star");
    assert!(children[0].has_spaces);
    assert!(children[0].has_schema);
    assert!(children[0].has_app);
    assert_eq!(children[1].status, SpaceReadiness::Broken);
    assert_eq!(children[1].name, "missing");
    assert_eq!(children[2].status, SpaceReadiness::Missing);
    assert_eq!(children[2].name, "remote");
    assert!(!root.join(".svode/index.db").exists());
}
