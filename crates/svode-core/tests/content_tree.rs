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

#[test]
fn scope_owner_facts_follow_the_tree_marker_rule_for_every_owner_form() {
    use svode_core::content_tree::ContentTreeError;
    use svode_core::content_tree::owner::{ScopeOwnerIdentity, scope_owner_facts};

    let space = tempfile::tempdir().unwrap();
    let root = space.path();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","tree":{"exclude":["hidden"]}}"#,
    )
    .unwrap();
    fs::write(root.join("README.md"), "root").unwrap();
    fs::write(root.join("leaf.md"), "leaf").unwrap();
    fs::write(root.join("file.pdf"), "pdf").unwrap();
    for dir in [
        "folder",
        "folder-app",
        "tasks",
        "tasks-app",
        "app-only",
        "plain",
    ] {
        fs::create_dir(root.join(dir)).unwrap();
    }
    fs::write(root.join("folder/readme.md"), "folder").unwrap();
    fs::write(root.join("folder-app/README.md"), "folder").unwrap();
    fs::write(root.join("folder-app/app.yaml"), "name: App\n").unwrap();
    fs::write(root.join("tasks/schema.yaml"), "properties: {}\n").unwrap();
    fs::write(root.join("tasks/item.md"), "item").unwrap();
    fs::write(root.join("tasks-app/schema.yaml"), "properties: {}\n").unwrap();
    fs::write(root.join("tasks-app/README.md"), "tasks").unwrap();
    fs::write(root.join("tasks-app/app.yaml"), "name: App\n").unwrap();
    fs::write(root.join("app-only/app.yaml"), "name: App\n").unwrap();
    fs::write(root.join("plain/note.txt"), "note").unwrap();

    let facts = |path: &str| scope_owner_facts(root, path).unwrap();
    let leaf = facts("leaf.md");
    assert_eq!(leaf.identity, ScopeOwnerIdentity::PageFile);
    assert_eq!(
        (leaf.owner_path.as_str(), leaf.content_path.as_str()),
        ("leaf.md", "leaf.md")
    );
    assert!(!leaf.has_app);
    let item = facts("tasks/item.md");
    assert_eq!(item.identity, ScopeOwnerIdentity::PageFile);

    for path in ["folder", "folder/README.md", "folder/readme.md"] {
        let folder = facts(path);
        assert_eq!(folder.identity, ScopeOwnerIdentity::PageDirectory, "{path}");
        assert_eq!(folder.owner_path, "folder");
        assert_eq!(folder.content_path, "folder/readme.md");
        assert!(!folder.has_app);
    }
    let folder_app = facts("folder-app/README.md");
    assert_eq!(folder_app.identity, ScopeOwnerIdentity::PageDirectory);
    assert!(folder_app.has_app);

    for path in ["tasks", "tasks/README.md"] {
        let tasks = facts(path);
        assert_eq!(
            tasks.identity,
            ScopeOwnerIdentity::CollectionDirectory,
            "{path}"
        );
        assert_eq!(tasks.content_path, "tasks/README.md");
        assert!(!tasks.has_app);
    }
    let tasks_app = facts("tasks-app");
    assert_eq!(tasks_app.identity, ScopeOwnerIdentity::CollectionDirectory);
    assert!(tasks_app.has_app);

    let app = facts("app-only");
    assert_eq!(app.identity, ScopeOwnerIdentity::AppDirectory);
    assert_eq!(app.content_path, "app-only/README.md");
    assert!(app.has_app);

    // Adding and removing a marker changes the facts of the same target.
    fs::write(root.join("folder/app.yaml"), "name: App\n").unwrap();
    assert!(facts("folder/readme.md").has_app);
    fs::write(root.join("folder/schema.yaml"), "properties: {}\n").unwrap();
    assert_eq!(
        facts("folder/readme.md").identity,
        ScopeOwnerIdentity::CollectionDirectory
    );
    fs::remove_file(root.join("folder/schema.yaml")).unwrap();
    fs::remove_file(root.join("folder/app.yaml")).unwrap();
    assert_eq!(
        facts("folder/readme.md").identity,
        ScopeOwnerIdentity::PageDirectory
    );
    assert!(!facts("folder/readme.md").has_app);

    // A marker the tree hides does not make an owner either.
    fs::create_dir(root.join("hidden")).unwrap();
    fs::write(root.join("hidden/app.yaml"), "name: App\n").unwrap();
    assert!(matches!(
        scope_owner_facts(root, "hidden"),
        Err(ContentTreeError::Invalid(_))
    ));

    assert!(matches!(
        scope_owner_facts(root, "missing.md"),
        Err(ContentTreeError::FileNotFound(path)) if path == "missing.md"
    ));
    assert!(matches!(
        scope_owner_facts(root, "gone/README.md"),
        Err(ContentTreeError::FileNotFound(_))
    ));
    // The root README is a Page of its own, even before it exists.
    for path in ["README.md", "readme.md"] {
        let root_readme = facts(path);
        assert_eq!(root_readme.identity, ScopeOwnerIdentity::PageFile);
        assert_eq!(root_readme.content_path, path);
    }
    fs::remove_file(root.join("README.md")).unwrap();
    assert_eq!(facts("README.md").identity, ScopeOwnerIdentity::PageFile);

    for path in [".", "plain", "file.pdf"] {
        assert!(
            matches!(
                scope_owner_facts(root, path),
                Err(ContentTreeError::Invalid(_))
            ),
            "{path}"
        );
    }
    assert!(scope_owner_facts(root, "../outside.md").is_err());
}
