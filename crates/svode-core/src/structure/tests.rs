use std::fs;
use std::path::Path;

use sqlx::SqlitePool;
use tempfile::TempDir;

use crate::index::IndexKey;
use crate::index::backlinks::BacklinkIndex;
use crate::index::state::IndexRuntimeState;
use crate::index::update;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::test_support::update_state;

use super::ops::{
    StructureRuntime, rebase_legacy_source_after_move, rebase_legacy_source_tree_after_move,
    rebase_project_source_tree_after_move,
};

fn runtime<'a>(index: &'a IndexRuntimeState) -> StructureRuntime<'a, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits: None,
    }
}

async fn indexed_paths(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
        .fetch_all(pool)
        .await
        .expect("indexed paths")
}

#[test]
fn rebase_legacy_source_after_move_updates_content_and_source_identity() {
    let tmp = TempDir::new().unwrap();
    let index = BacklinkIndex::new();
    fs::write(tmp.path().join("Source.md"), "See [Target](Target.md).\n").unwrap();
    fs::write(tmp.path().join("Target.md"), "Target\n").unwrap();
    index.build(tmp.path()).unwrap();

    fs::create_dir_all(tmp.path().join("Moved")).unwrap();
    fs::rename(
        tmp.path().join("Source.md"),
        tmp.path().join("Moved").join("Source.md"),
    )
    .unwrap();

    let changed = rebase_legacy_source_after_move(
        tmp.path().to_str().unwrap(),
        &index,
        "Source.md",
        "Moved/Source.md",
    )
    .unwrap();

    assert!(changed);
    assert_eq!(
        fs::read_to_string(tmp.path().join("Moved").join("Source.md")).unwrap(),
        "See [Target](../Target.md).\n"
    );
    let backlinks = index.get_backlinks("Target.md");
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_path, "Moved/Source.md");
    assert!(
        index
            .get_backlinks("Target.md")
            .iter()
            .all(|item| item.source_path != "Source.md")
    );
}

#[test]
fn rebase_legacy_source_tree_after_move_preserves_internal_moved_targets() {
    let tmp = TempDir::new().unwrap();
    let index = BacklinkIndex::new();
    fs::create_dir_all(tmp.path().join("Folder")).unwrap();
    fs::write(
        tmp.path().join("Folder").join("Source.md"),
        "See [Sibling](Sibling.md) and [Outside](../Outside.md).\n",
    )
    .unwrap();
    fs::write(tmp.path().join("Folder").join("Sibling.md"), "Sibling\n").unwrap();
    fs::write(tmp.path().join("Outside.md"), "Outside\n").unwrap();
    index.build(tmp.path()).unwrap();

    fs::create_dir_all(tmp.path().join("Archive")).unwrap();
    fs::rename(
        tmp.path().join("Folder"),
        tmp.path().join("Archive").join("Folder"),
    )
    .unwrap();

    rebase_legacy_source_tree_after_move(
        tmp.path().to_str().unwrap(),
        &index,
        "Folder",
        "Archive/Folder",
    );

    assert_eq!(
        fs::read_to_string(tmp.path().join("Archive").join("Folder").join("Source.md")).unwrap(),
        "See [Sibling](Sibling.md) and [Outside](../../Outside.md).\n"
    );
    let moved_internal_backlinks = index.get_backlinks("Archive/Folder/Sibling.md");
    assert_eq!(moved_internal_backlinks.len(), 1);
    assert_eq!(
        moved_internal_backlinks[0].source_path,
        "Archive/Folder/Source.md"
    );
    let outside_backlinks = index.get_backlinks("Outside.md");
    assert_eq!(outside_backlinks.len(), 1);
    assert_eq!(outside_backlinks[0].source_path, "Archive/Folder/Source.md");
    assert!(index.get_backlinks("Folder/Sibling.md").is_empty());
}

#[tokio::test]
async fn moved_collection_tree_replaces_descendant_index_paths() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexRuntimeState::default();
    fs::create_dir_all(space.join("Old collection")).unwrap();
    fs::write(
        space.join("Old collection").join("schema.yaml"),
        "columns: []\n",
    )
    .unwrap();
    fs::write(
        space.join("Old collection").join("README.md"),
        "---\ntitle: Old collection\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("Old collection").join("Item.md"),
        "---\ntitle: Item\n---\n",
    )
    .unwrap();
    for path in ["Old collection/README.md", "Old collection/Item.md"] {
        update::publish_managed_path(
            &state,
            update_state(),
            None::<&SystemGitDateExecutor>,
            space,
            &space.join(path),
        )
        .await
        .unwrap();
    }
    let pool = state
        .get_or_create(&IndexKey::Root(space.to_path_buf()))
        .await
        .expect("index pool");

    fs::rename(
        space.join("Old collection"),
        space.join("Renamed collection"),
    )
    .unwrap();
    rebase_project_source_tree_after_move(
        runtime(&state),
        Some(space.to_str().unwrap()),
        space.to_str().unwrap(),
        None,
        "Old collection",
        "Renamed collection",
        "test_collection_rename",
    )
    .await;

    assert_eq!(
        indexed_paths(&pool).await,
        vec![
            "Renamed collection/Item.md".to_string(),
            "Renamed collection/README.md".to_string(),
        ]
    );
    let item_flags: (Option<String>, i64, i64) = sqlx::query_as(
        "SELECT collection_root_path, in_collection, is_entry_head FROM entries WHERE file_path = ?",
    )
    .bind("Renamed collection/Item.md")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(item_flags, (Some("Renamed collection".to_string()), 1, 1));
}

#[tokio::test]
async fn content_reorder_no_op_does_not_create_order_source() {
    let dir = TempDir::new().expect("space");
    fs::write(dir.path().join("a.md"), "a").expect("a");
    fs::write(dir.path().join("b.md"), "b").expect("b");

    let outcome = crate::content_tree::reorder_content(
        dir.path().to_str().expect("utf8 path"),
        "",
        vec!["a.md".to_string(), "b.md".to_string()],
    )
    .expect("reorder");

    assert!(!outcome.changed);
    assert!(!dir.path().join(".svode/order.json").exists());
}

#[tokio::test]
async fn content_reorder_rejects_a_stale_child_set() {
    let dir = TempDir::new().expect("space");
    fs::write(dir.path().join("a.md"), "a").expect("a");
    fs::write(dir.path().join("b.md"), "b").expect("b");

    let error = crate::content_tree::reorder_content(
        dir.path().to_str().expect("utf8 path"),
        "",
        vec!["a.md".to_string(), "a.md".to_string()],
    )
    .expect_err("duplicate paths");

    assert!(error.to_string().contains("duplicate paths"));
    assert!(!dir.path().join(".svode/order.json").exists());
    let _ = Path::new(".");
}

#[tokio::test]
async fn unreadable_order_is_kept_by_content_changes_and_refuses_reorder() {
    use crate::content_tree::{ContentTreeError, list_tree_children, reorder_content};
    use crate::page::entry;

    let dir = TempDir::new().expect("space");
    let space = dir.path().to_str().expect("utf8 path");
    fs::write(dir.path().join("b.md"), "---\ntitle: B\n---\n").expect("b");
    fs::write(dir.path().join("a.md"), "---\ntitle: A\n---\n").expect("a");
    fs::create_dir_all(dir.path().join("folder")).expect("folder");
    fs::write(
        dir.path().join("folder/README.md"),
        "---\ntitle: Folder\n---\n",
    )
    .expect("readme");
    fs::create_dir_all(dir.path().join(".svode")).expect("svode dir");
    let order_path = dir.path().join(".svode/order.json");
    let conflicted = "{\n<<<<<<< HEAD\n  \".\": [\"folder\", \"b.md\", \"a.md\"]\n=======\n  \".\": [\"folder\", \"a.md\", \"b.md\"]\n>>>>>>> origin/main\n}\n";
    fs::write(&order_path, conflicted).expect("order");

    let created = entry::create(space, None, "Created").expect("create");
    entry::create_folder(space, None, "Bare").expect("create folder");
    let renamed = entry::write(
        space,
        &created.path,
        "",
        Some("Renamed"),
        None,
        None,
        None,
        None,
        false,
    )
    .expect("rename by title")
    .new_path
    .expect("renamed path");
    entry::rename(space, "Bare", "Bare renamed").expect("rename folder");
    entry::move_entry_with_project(dir.path(), "b.md", "folder", None, None).expect("move");
    entry::delete(space, "a.md", None).expect("delete");
    assert_eq!(fs::read_to_string(&order_path).expect("order"), conflicted);

    let children = list_tree_children(space, None).expect("tree");
    let names = children
        .iter()
        .map(|child| child.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["Bare renamed", "folder", renamed.as_str()]);

    let ordered = children
        .iter()
        .rev()
        .map(|child| child.path.clone())
        .collect::<Vec<_>>();
    let error = reorder_content(space, "", ordered).expect_err("reorder refused");
    assert!(matches!(error, ContentTreeError::UnreadableOrder(ref path) if *path == order_path));
    assert!(error.to_string().contains(".svode/order.json"));
    assert_eq!(fs::read_to_string(&order_path).expect("order"), conflicted);
}

/// Records every structural history registration of an operation.
#[derive(Default)]
struct RecordingSink(std::sync::Mutex<Vec<std::path::PathBuf>>);

impl super::StructuralCommitSink for RecordingSink {
    fn schedule(
        &self,
        _: &Path,
        _: &Path,
        _: crate::git::pending::StructuralChange,
        paths: Vec<std::path::PathBuf>,
    ) {
        self.0.lock().unwrap().extend(paths);
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
        paths: Vec<std::path::PathBuf>,
        _: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        self.0.lock().unwrap().extend(paths);
        Box::pin(async {})
    }
}

/// Every file of the tree with its bytes, so a refusal is shown to change
/// nothing on disk.
fn tree_snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.push((
                    path.strip_prefix(root).unwrap().display().to_string(),
                    Vec::new(),
                ));
                dirs.push(path);
            } else {
                let rel = path.strip_prefix(root).unwrap().display().to_string();
                files.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (path, content) in files {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

fn rename_target_fixture() -> TempDir {
    let tmp = TempDir::new().unwrap();
    write_tree(
        tmp.path(),
        &[
            (
                ".svode/config.json",
                "{\"name\":\"Root\",\"spaces\":[{\"id\":\"child\",\"path\":\"child\"}]}",
            ),
            ("README.md", "---\ntitle: Root\n---\n"),
            ("AGENTS.md", "Agent instructions\n"),
            (
                "Leaf.md",
                "---\ntitle: Leaf\n---\nSee [Doc](Doc/README.md).\n",
            ),
            ("Doc/README.md", "---\ntitle: Doc\n---\n"),
            ("Doc/Child.md", "---\ntitle: Child\n---\n"),
            ("Tasks/schema.yaml", "columns: []\n"),
            ("Tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("Tasks/Item.md", "---\ntitle: Item\n---\n"),
            (
                "Tasks/Folder item/README.md",
                "---\ntitle: Folder item\n---\n",
            ),
            ("App/app.yaml", "runtime: static\n"),
            ("Notes/photo.png", "png"),
            ("Notes/brief.pdf", "pdf"),
            ("child/.svode/config.json", "{\"name\":\"Child\"}"),
            ("child/README.md", "---\ntitle: Child\n---\n"),
            (".assets/image.png", "png"),
        ],
    );
    tmp
}

const TITLED_TARGETS: &[(&str, crate::page::TitledContent)] = &[
    ("Leaf.md", crate::page::TitledContent::Page),
    ("Doc", crate::page::TitledContent::Page),
    ("Doc/README.md", crate::page::TitledContent::Page),
    ("Tasks/Item.md", crate::page::TitledContent::CollectionItem),
    (
        "Tasks/Folder item",
        crate::page::TitledContent::CollectionItem,
    ),
    (
        "Tasks/Folder item/README.md",
        crate::page::TitledContent::CollectionItem,
    ),
    ("Tasks", crate::page::TitledContent::Collection),
    ("Tasks/README.md", crate::page::TitledContent::Collection),
];

const UNSUPPORTED_TARGETS: &[&str] = &[
    "Notes/photo.png",
    "Notes/brief.pdf",
    "App/app.yaml",
    "README.md",
    "AGENTS.md",
    "child",
    "child/README.md",
    ".assets",
    ".assets/image.png",
];

fn renamed_sibling(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((parent, name)) => format!("{parent}/Renamed {name}"),
        None => format!("Renamed {path}"),
    }
}

#[tokio::test]
async fn rename_by_path_refuses_titled_and_unsupported_targets_without_changes() {
    use crate::page::PageError;

    let tmp = rename_target_fixture();
    let space = tmp.path().to_str().unwrap();
    let state = IndexRuntimeState::default();
    let sink = RecordingSink::default();
    let before = tree_snapshot(tmp.path());

    for (path, kind) in TITLED_TARGETS {
        let runtime = StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        };
        let error = super::rename(space, path, &renamed_sibling(path), Some(space), runtime)
            .await
            .expect_err(path);
        assert!(
            matches!(&error, PageError::TitleRenameRequired { path: refused, kind: refused_kind }
                if refused == path && refused_kind == kind),
            "{path}: {error:?}"
        );
    }
    for path in UNSUPPORTED_TARGETS {
        let runtime = StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        };
        let error = super::rename(space, path, &renamed_sibling(path), Some(space), runtime)
            .await
            .expect_err(path);
        assert!(
            matches!(&error, PageError::UnsupportedRenameTarget { path: refused } if refused == path),
            "{path}: {error:?}"
        );
    }
    let missing = super::rename(space, "Missing", "Other", Some(space), runtime(&state))
        .await
        .expect_err("missing");
    assert!(matches!(missing, PageError::FileNotFound(ref path) if path == "Missing"));

    assert_eq!(tree_snapshot(tmp.path()), before);
    assert!(sink.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rename_plan_refuses_a_target_before_planning() {
    use crate::page::PageError;

    let tmp = rename_target_fixture();
    let space = tmp.path().to_str().unwrap();
    let state = IndexRuntimeState::default();

    let page = super::rename_mutation_paths(&state, space, Some(space), "Leaf.md", "Plan.md")
        .await
        .expect_err("page");
    assert!(matches!(page, PageError::TitleRenameRequired { .. }));
    let file = super::rename_mutation_paths(
        &state,
        space,
        Some(space),
        "Notes/photo.png",
        "Notes/cover.png",
    )
    .await
    .expect_err("file");
    assert!(matches!(file, PageError::UnsupportedRenameTarget { .. }));
    let moved = super::rename_mutation_paths(&state, space, Some(space), "Notes", "Doc/Notes")
        .await
        .expect_err("parent change");
    assert!(moved.to_string().contains("cannot change parent"));
    let planned = super::rename_mutation_paths(&state, space, None, "Notes", "Archive")
        .await
        .expect("bare folder plan");
    assert!(planned.contains(&tmp.path().to_path_buf()));
}

#[tokio::test]
async fn bare_folder_rename_changes_case_and_refuses_portable_collisions() {
    use crate::page::PageError;

    let tmp = TempDir::new().unwrap();
    let space = tmp.path().to_str().unwrap();
    write_tree(
        tmp.path(),
        &[
            ("notes/a.md", "---\ntitle: A\n---\n"),
            ("Archive/b.md", "---\ntitle: B\n---\n"),
            ("Caf\u{e9}/c.md", "---\ntitle: C\n---\n"),
            ("App/app.yaml", "runtime: static\n"),
        ],
    );
    let state = IndexRuntimeState::default();
    let names = || {
        let mut names = fs::read_dir(tmp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        names.sort();
        names
    };

    super::rename(space, "notes", "Notes", None, runtime(&state))
        .await
        .expect("case-only rename");
    assert!(names().contains(&"Notes".to_string()), "{:?}", names());
    assert!(!names().contains(&"notes".to_string()), "{:?}", names());
    assert!(tmp.path().join("Notes/a.md").is_file());

    let before = tree_snapshot(tmp.path());
    for taken in ["archive", "ARCHIVE", "Cafe\u{301}"] {
        let error = super::rename(space, "Notes", taken, None, runtime(&state))
            .await
            .expect_err(taken);
        assert!(
            matches!(&error, PageError::FileAlreadyExists(path) if path == taken),
            "{taken}: {error:?}"
        );
    }
    assert_eq!(tree_snapshot(tmp.path()), before);

    super::rename(space, "App", "Site", None, runtime(&state))
        .await
        .expect("an App folder has no title");
    assert!(tmp.path().join("Site/app.yaml").is_file());
}

/// Project whose child Space `alpha` holds `Area` with Collections at depth 1
/// (`Area/Tasks`) and 2 (`Area/Sub/Deep`), referenced by a two-way relation
/// of the same Space, by the root Space and by the sibling Space `beta`.
/// `Area` is a folder Page when `folder_page`, a bare folder otherwise.
fn nested_collections_project(root: &Path, folder_page: bool) -> std::path::PathBuf {
    use crate::page::test_support::scaffold_space;

    scaffold_space(root, "Root");
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","spaces":[{"id":"alpha","path":"spaces/alpha"},{"id":"beta","path":"spaces/beta"}]}"#,
    )
    .unwrap();
    let alpha = root.join("spaces/alpha");
    scaffold_space(&alpha, "alpha");
    scaffold_space(&root.join("spaces/beta"), "beta");
    for repository in [root, &alpha, &root.join("spaces/beta")] {
        fs::create_dir_all(repository.join(".git")).unwrap();
    }
    let files = [
        (
            "spaces/alpha/Area/Tasks/schema.yaml",
            "columns:\n  - name: Decisions\n    type: relation\n    relation: Decisions\n    two_way: Task\n",
        ),
        (
            "spaces/alpha/Area/Tasks/README.md",
            "---\ntitle: Tasks\n---\n",
        ),
        (
            "spaces/alpha/Area/Tasks/Item.md",
            "---\ntitle: Item\nDecisions: [Decision.md]\n---\n",
        ),
        ("spaces/alpha/Area/Sub/Deep/schema.yaml", "columns: []\n"),
        (
            "spaces/alpha/Area/Sub/Deep/README.md",
            "---\ntitle: Deep\n---\n",
        ),
        (
            "spaces/alpha/Area/Sub/Deep/Leaf.md",
            "---\ntitle: Leaf\n---\n",
        ),
        (
            "spaces/alpha/Decisions/schema.yaml",
            "columns:\n  - name: Task\n    type: relation\n    relation: Area/Tasks\n    two_way: Decisions\n  - name: Deep\n    type: relation\n    relation: Area/Sub/Deep\n",
        ),
        (
            "spaces/alpha/Decisions/README.md",
            "---\ntitle: Decisions\n---\n",
        ),
        (
            "spaces/alpha/Decisions/Decision.md",
            "---\ntitle: Decision\nTask: [Item.md]\nDeep: [Leaf.md]\n---\n",
        ),
        (
            "spaces/alpha/.svode/order.json",
            r#"{".":["Area","Decisions"],"Area":["Sub","Tasks"],"Area/Sub":["Deep"],"Area/Tasks":["Item.md"]}"#,
        ),
        (
            "Refs/schema.yaml",
            "columns:\n  - name: Task\n    type: relation\n    relation: Area/Tasks\n    relation_scope:\n      type: space\n      id: alpha\n",
        ),
        ("Refs/README.md", "---\ntitle: Refs\n---\n"),
        ("Refs/Ref.md", "---\ntitle: Ref\nTask: [Item.md]\n---\n"),
        (
            "spaces/beta/Refs/schema.yaml",
            "columns:\n  - name: Deep\n    type: relation\n    relation: Area/Sub/Deep\n    relation_scope:\n      type: space\n      id: alpha\n",
        ),
        ("spaces/beta/Refs/README.md", "---\ntitle: Refs\n---\n"),
        (
            "spaces/beta/Refs/Ref.md",
            "---\ntitle: Ref\nDeep: [Leaf.md]\n---\n",
        ),
    ];
    for (path, content) in files {
        fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        fs::write(root.join(path), content).unwrap();
    }
    if folder_page {
        fs::write(alpha.join("Area/README.md"), "---\ntitle: Area\n---\n").unwrap();
    }
    alpha
}

fn relation_targets(schema: &Path) -> Vec<String> {
    let schema: crate::collections::engine::CollectionSchema =
        serde_norway::from_str(&fs::read_to_string(schema).unwrap()).unwrap();
    schema
        .columns
        .into_iter()
        .filter_map(|column| column.relation)
        .collect()
}

/// Every schema that pointed into `Area` points into `moved` instead, the
/// moved Collections keep their own relations, order keys of the whole tree
/// moved and the integrity check of each Space is clean.
fn assert_nested_collections_moved(root: &Path, moved: &str) {
    let alpha = root.join("spaces/alpha");
    assert_eq!(
        relation_targets(&alpha.join("Decisions/schema.yaml")),
        vec![format!("{moved}/Tasks"), format!("{moved}/Sub/Deep")]
    );
    assert_eq!(
        relation_targets(&root.join("Refs/schema.yaml")),
        vec![format!("{moved}/Tasks")]
    );
    assert_eq!(
        relation_targets(&root.join("spaces/beta/Refs/schema.yaml")),
        vec![format!("{moved}/Sub/Deep")]
    );
    assert_eq!(
        relation_targets(&alpha.join(moved).join("Tasks/schema.yaml")),
        vec!["Decisions".to_string()]
    );
    let order: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(&fs::read_to_string(alpha.join(".svode/order.json")).unwrap())
            .unwrap();
    assert_eq!(order[&format!("{moved}")], vec!["Sub", "Tasks"]);
    assert_eq!(order[&format!("{moved}/Sub")], vec!["Deep"]);
    assert_eq!(order[&format!("{moved}/Tasks")], vec!["Item.md"]);
    assert!(
        order
            .keys()
            .all(|key| key != "Area" && !key.starts_with("Area/")),
        "{order:?}"
    );
    let project = root.to_str().unwrap();
    for space in [alpha.clone(), root.to_path_buf(), root.join("spaces/beta")] {
        let report = crate::collections::engine::validate_collection_integrity_with_project(
            space.to_str().unwrap(),
            None,
            Some(project),
        )
        .unwrap();
        assert!(
            report.errors.is_empty(),
            "{}: {:?}",
            space.display(),
            report.errors
        );
    }
}

fn nested_collection_schema_paths(root: &Path) -> [std::path::PathBuf; 3] {
    [
        root.join("spaces/alpha/Decisions/schema.yaml"),
        root.join("Refs/schema.yaml"),
        root.join("spaces/beta/Refs/schema.yaml"),
    ]
}

#[tokio::test]
async fn renaming_a_folder_rewrites_relation_schemas_of_nested_collections() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let alpha = nested_collections_project(root, false);
    let state = IndexRuntimeState::default();
    let project = root.to_str().unwrap();

    let plan = super::plan::move_mutation_paths(
        &state,
        alpha.to_str().unwrap(),
        Some(project),
        "Area",
        "Zone",
    )
    .await
    .unwrap();
    for schema in nested_collection_schema_paths(root) {
        assert!(
            plan.contains(&schema),
            "{} not in {plan:?}",
            schema.display()
        );
    }

    super::rename(
        alpha.to_str().unwrap(),
        "Area",
        "Zone",
        Some(project),
        runtime(&state),
    )
    .await
    .unwrap();

    assert!(!alpha.join("Area").exists());
    let order: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(&fs::read_to_string(alpha.join(".svode/order.json")).unwrap())
            .unwrap();
    assert_eq!(order["."], vec!["Zone", "Decisions"]);
    assert_nested_collections_moved(root, "Zone");
}

#[tokio::test]
async fn moving_a_folder_rewrites_relation_schemas_of_nested_collections() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let alpha = nested_collections_project(root, false);
    fs::create_dir_all(alpha.join("Archive")).unwrap();
    let state = IndexRuntimeState::default();
    let project = root.to_str().unwrap();

    let plan = super::plan::move_mutation_paths(
        &state,
        alpha.to_str().unwrap(),
        Some(project),
        "Area",
        "Archive/Area",
    )
    .await
    .unwrap();
    for schema in nested_collection_schema_paths(root) {
        assert!(
            plan.contains(&schema),
            "{} not in {plan:?}",
            schema.display()
        );
    }

    let moved = super::move_entry(
        alpha.to_str().unwrap(),
        "Area",
        "Archive",
        Some(project),
        runtime(&state),
    )
    .await
    .unwrap();

    assert_eq!(moved, "Archive/Area");
    assert_nested_collections_moved(root, "Archive/Area");
}

#[tokio::test]
async fn renaming_a_folder_page_by_title_rewrites_relation_schemas_of_nested_collections() {
    use crate::page::nonce::WriteNonceRegistry;
    use crate::page::write::{PageWrite, write};

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let alpha = nested_collections_project(root, true);
    let state = IndexRuntimeState::default();
    let nonces = WriteNonceRegistry::new();
    let authorized = std::sync::Mutex::new(Vec::new());

    let outcome = write(
        PageWrite {
            space: alpha.to_str().unwrap(),
            path: "Area/README.md",
            content: "",
            title: Some("Zone"),
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: false,
            project: Some(root.to_str().unwrap()),
            source_version: None,
        },
        crate::page::test_support::runtime(&state, &nonces),
        |paths| {
            authorized.lock().unwrap().extend(paths.clone());
            async move { Ok::<_, crate::page::PageError>(paths) }
        },
    )
    .await
    .unwrap();

    assert_eq!(outcome.result.new_path.as_deref(), Some("Zone/README.md"));
    let authorized = authorized.into_inner().unwrap();
    for schema in nested_collection_schema_paths(root) {
        assert!(
            authorized.contains(&schema),
            "{} not in {authorized:?}",
            schema.display()
        );
    }
    assert_nested_collections_moved(root, "Zone");
}

#[tokio::test]
async fn a_structural_plan_in_a_submodule_space_authorizes_the_parent_gitlink() {
    let Some(cli) = crate::git::state::detected_cli() else {
        return;
    };
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    cli.exec(root, &["init", "-q"]).await.unwrap();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","spaces":[{"id":"a","path":"spaces/a"}]}"#,
    )
    .unwrap();
    let space = root.join("spaces/a");
    crate::page::test_support::scaffold_space(&space, "a");
    fs::create_dir_all(space.join(".git")).unwrap();
    fs::create_dir_all(space.join("Notes")).unwrap();
    fs::write(space.join("Notes/Page.md"), "---\ntitle: Page\n---\n").unwrap();
    fs::write(space.join("Link.md"), "[Page](Notes/Page.md)\n").unwrap();
    let state = IndexRuntimeState::default();
    state
        .upsert_space(
            root,
            "a",
            "spaces/a",
            crate::index::resolver::SpaceStatus::Ready,
            None,
        )
        .await;
    let (space, project) = (space.to_str().unwrap(), root.to_str().unwrap());
    let plan = async |from: &str, to: &str| {
        super::move_mutation_paths(&state, space, Some(project), from, to)
            .await
            .unwrap()
    };
    let independent = [
        plan("Notes", "Ideas").await,
        plan("Notes/Page.md", "Page.md").await,
    ];
    for paths in &independent {
        assert!(!paths.contains(&root.to_path_buf()), "{paths:?}");
    }

    fs::write(
        root.join(".gitmodules"),
        "[submodule \"spaces/a\"]\n\tpath = spaces/a\n\turl = https://example.invalid/a.git\n",
    )
    .unwrap();
    let submodule = [
        plan("Notes", "Ideas").await,
        plan("Notes/Page.md", "Page.md").await,
    ];

    // The rename and the move gain only the parent gitlink, the Project
    // repository the title rename of the same Space authorizes.
    let gitlink = crate::git::ops::submodule_parent(Some(project), space)
        .await
        .unwrap()
        .expect("submodule parent");
    assert_eq!(gitlink, root);
    for (before, after) in independent.iter().zip(&submodule) {
        let mut expected = before.clone();
        expected.push(gitlink.clone());
        expected.sort();
        assert_eq!(after, &expected);
    }
}
