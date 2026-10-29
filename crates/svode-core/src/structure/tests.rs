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
    )
    .unwrap();

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
    .await
    .unwrap();

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

#[tokio::test]
async fn df_154_move_rename_and_conversion_rewrite_percent_encoded_links() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let space = root.to_str().unwrap();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::write(
        root.join("Roadmap Draft.md"),
        "---\ntitle: Roadmap Draft\n---\n[План](%D0%9F%D0%BB%D0%B0%D0%BD.md)\n",
    )
    .unwrap();
    fs::write(root.join("План.md"), "---\ntitle: План\n---\n").unwrap();
    fs::write(root.join("Index.md"), "[R](Roadmap%20Draft.md)\n").unwrap();
    fs::write(root.join("tasks/Ship.md"), "[R](../Roadmap%20Draft.md)\n").unwrap();
    let state = IndexRuntimeState::default();

    let moved = super::ops::move_entry(
        space,
        "Roadmap Draft.md",
        "notes",
        Some(space),
        runtime(&state),
    )
    .await
    .unwrap();
    assert_eq!(moved, "notes/Roadmap Draft.md");
    assert_eq!(
        fs::read_to_string(root.join("Index.md")).unwrap(),
        "[R](notes/Roadmap%20Draft.md)\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("tasks/Ship.md")).unwrap(),
        "[R](../notes/Roadmap%20Draft.md)\n"
    );
    assert!(
        fs::read_to_string(root.join("notes/Roadmap Draft.md"))
            .unwrap()
            .ends_with("[План](../%D0%9F%D0%BB%D0%B0%D0%BD.md)\n")
    );

    let modified = super::ops::rename(space, "notes", "Old Notes", Some(space), runtime(&state))
        .await
        .unwrap();
    assert!(
        modified.iter().any(|path| path == "Index.md"),
        "{modified:?}"
    );
    assert_eq!(
        fs::read_to_string(root.join("Index.md")).unwrap(),
        "[R](Old%20Notes/Roadmap%20Draft.md)\n"
    );

    super::ops::convert_to_folder(
        space,
        "Old Notes/Roadmap Draft.md",
        Some(space),
        runtime(&state),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("tasks/Ship.md")).unwrap(),
        "[R](../Old%20Notes/Roadmap%20Draft/README.md)\n"
    );
    assert!(
        fs::read_to_string(root.join("Old Notes/Roadmap Draft/README.md"))
            .unwrap()
            .ends_with("[План](../../%D0%9F%D0%BB%D0%B0%D0%BD.md)\n")
    );
}

/// Records each structural history registration with its Space and whether
/// it is an immediate commit.
#[derive(Default)]
struct GroupSink(std::sync::Mutex<Vec<(bool, std::path::PathBuf, Vec<std::path::PathBuf>)>>);

impl GroupSink {
    fn take(&self) -> Vec<(bool, std::path::PathBuf, Vec<std::path::PathBuf>)> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl super::StructuralCommitSink for GroupSink {
    fn schedule(
        &self,
        _: &Path,
        space: &Path,
        _: crate::git::pending::StructuralChange,
        paths: Vec<std::path::PathBuf>,
    ) {
        self.0
            .lock()
            .unwrap()
            .push((false, space.to_path_buf(), paths));
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        space: &'a Path,
        paths: Vec<std::path::PathBuf>,
        _: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        self.0
            .lock()
            .unwrap()
            .push((true, space.to_path_buf(), paths));
        Box::pin(async {})
    }
}

/// Source files of the tree with their bytes, without the device-local state
/// (`.svode/local.json`, `write.lock`, `variables.*`, `*.db*`) the index
/// repair and the document name lock write.
fn source_snapshot(root: &Path) -> Vec<(String, String)> {
    tree_snapshot(root)
        .into_iter()
        .filter(|(path, _)| {
            let local = path.strip_prefix(".svode/").is_some_and(|name| {
                name == "local.json"
                    || name == "write.lock"
                    || name.starts_with("variables.")
                    || name.contains(".db")
            });
            !local
        })
        .map(|(path, bytes)| (path, String::from_utf8_lossy(&bytes).to_string()))
        .collect()
}

/// Inline Project Space: the bare folder `Area` holds the Collection
/// `Area/Tasks` with `nested_items`, whose item `Item.md` is a relation target
/// of `Decisions` and the link target of `Link.md`; `Area/Tasks/Sub` is an
/// empty folder.
fn relation_target_space(root: &Path) {
    crate::page::test_support::scaffold_space(root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    write_tree(
        root,
        &[
            (
                "Area/Tasks/schema.yaml",
                "nested_items: true\ncolumns: []\n",
            ),
            ("Area/Tasks/README.md", "---\ntitle: Tasks\n---\n"),
            (
                "Area/Tasks/Item.md",
                "---\ntitle: Item\n---\nSee [Decision](../../Decisions/Decision.md).\n",
            ),
            (
                "Decisions/schema.yaml",
                "columns:\n  - name: Task\n    type: relation\n    relation: Area/Tasks\n",
            ),
            ("Decisions/README.md", "---\ntitle: Decisions\n---\n"),
            (
                "Decisions/Decision.md",
                "---\ntitle: Decision\nTask: [Item.md]\n---\n",
            ),
            ("Link.md", "See [Item](Area/Tasks/Item.md).\n"),
            (
                ".svode/order.json",
                r#"{".":["Area","Decisions","Link.md"],"Area/Tasks":["Item.md"]}"#,
            ),
        ],
    );
    fs::create_dir_all(root.join("Area/Tasks/Sub")).unwrap();
}

fn assert_contains_all(paths: &[std::path::PathBuf], root: &Path, expected: &[&str]) {
    for path in expected {
        assert!(paths.contains(&root.join(path)), "{path} not in {paths:?}");
    }
}

#[tokio::test]
async fn rename_and_move_register_every_changed_file_in_one_group() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    relation_target_space(root);
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    let sink = GroupSink::default();
    let runtime = || StructureRuntime {
        commits: Some(&sink),
        ..runtime(&state)
    };

    let modified = super::rename(space, "Area", "Zone", Some(space), runtime())
        .await
        .unwrap();
    assert_eq!(modified, vec!["Link.md".to_string()]);
    let groups = sink.take();
    assert_eq!(groups.len(), 1, "{groups:?}");
    let (now, owner, paths) = &groups[0];
    assert!(!now);
    assert_eq!(owner, root);
    assert_contains_all(
        paths,
        root,
        &[
            "Area",
            "Zone",
            "Area/Tasks/Item.md",
            "Zone/Tasks/Item.md",
            "Link.md",
            "Decisions/schema.yaml",
            ".svode/order.json",
        ],
    );
    assert!(!paths.contains(&root.join("Decisions/Decision.md")));
    assert_eq!(
        relation_targets(&root.join("Decisions/schema.yaml")),
        vec!["Zone/Tasks".to_string()]
    );

    let moved = super::move_entry(
        space,
        "Zone/Tasks/Item.md",
        "Zone/Tasks/Sub",
        Some(space),
        runtime(),
    )
    .await
    .unwrap();
    assert_eq!(moved, "Zone/Tasks/Sub/Item.md");
    assert!(
        fs::read_to_string(root.join("Decisions/Decision.md"))
            .unwrap()
            .contains("Sub/Item.md")
    );
    let groups = sink.take();
    assert_eq!(groups.len(), 1, "{groups:?}");
    let (now, owner, paths) = &groups[0];
    assert!(!now);
    assert_eq!(owner, root);
    assert_contains_all(
        paths,
        root,
        &[
            "Zone/Tasks/Item.md",
            "Zone/Tasks/Sub/Item.md",
            "Decisions/Decision.md",
            "Link.md",
            ".svode/order.json",
        ],
    );
    assert!(!paths.contains(&root.join("Decisions/schema.yaml")));
}

#[tokio::test]
async fn a_move_with_unique_ids_commits_the_whole_changed_set_at_once() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    crate::page::test_support::scaffold_space(root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    write_tree(
        root,
        &[
            (
                "Tasks/schema.yaml",
                "columns:\n  - { name: Key, type: unique_id, prefix: ISSUE, next: 4 }\n",
            ),
            ("Tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("Loose.md", "---\ntitle: Loose\n---\n"),
            ("Link.md", "See [Loose](Loose.md).\n"),
        ],
    );
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    let sink = GroupSink::default();

    super::move_entry(
        space,
        "Loose.md",
        "Tasks",
        Some(space),
        StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        },
    )
    .await
    .unwrap();

    assert!(
        fs::read_to_string(root.join("Tasks/Loose.md"))
            .unwrap()
            .contains("Key: 4")
    );
    let groups = sink.take();
    assert_eq!(groups.len(), 1, "{groups:?}");
    let (now, owner, paths) = &groups[0];
    assert!(now);
    assert_eq!(owner, root);
    assert_contains_all(
        paths,
        root,
        &[
            "Loose.md",
            "Tasks/Loose.md",
            "Tasks/schema.yaml",
            "Link.md",
            ".svode/order.json",
        ],
    );
}

/// Runs `operation` with a failure injected at `stage` and asserts that the
/// sources are restored, the injected cause is returned and nothing is
/// registered in history.
async fn assert_failure_restores(
    stage: &'static str,
    operation: impl AsyncFnOnce(
        &str,
        StructureRuntime<'_, SystemGitDateExecutor>,
    ) -> crate::page::PageError,
) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    relation_target_space(root);
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    let sink = GroupSink::default();
    let before = source_snapshot(root);

    crate::page::write::inject_failure(Some(stage), None);
    let error = operation(
        space,
        StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        },
    )
    .await;
    crate::page::write::inject_failure(None, None);

    assert!(
        error
            .to_string()
            .contains(&format!("injected {stage} failure")),
        "{stage}: {error:?}"
    );
    assert_eq!(source_snapshot(root), before, "{stage}");
    assert!(sink.take().is_empty(), "{stage}");
}

#[tokio::test]
async fn a_failed_step_of_a_rename_or_move_restores_the_touched_set() {
    for stage in [
        "move_relations",
        "move_order",
        "move_routing",
        "move_links",
        "move_sources",
    ] {
        assert_failure_restores(stage, async |space, runtime| {
            super::rename(space, "Area", "Zone", Some(space), runtime)
                .await
                .expect_err("injected rename failure")
        })
        .await;
    }
    for stage in [
        "move_order",
        "move_defaults",
        "move_relations",
        "move_routing",
        "move_links",
        "move_sources",
    ] {
        assert_failure_restores(stage, async |space, runtime| {
            super::move_entry(
                space,
                "Area/Tasks/Item.md",
                "Area/Tasks/Sub",
                Some(space),
                runtime,
            )
            .await
            .expect_err("injected move failure")
        })
        .await;
        assert_failure_restores(stage, async |space, runtime| {
            fs::create_dir_all(Path::new(space).join("Archive")).unwrap();
            let error = super::move_entry(space, "Area", "Archive", Some(space), runtime)
                .await
                .expect_err("injected folder move failure");
            fs::remove_dir(Path::new(space).join("Archive")).unwrap();
            error
        })
        .await;
    }
}

#[tokio::test]
async fn a_failed_case_only_rename_keeps_the_original_name() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path().to_str().unwrap();
    write_tree(
        tmp.path(),
        &[
            ("notes/a.md", "---\ntitle: A\n---\n"),
            (".svode/order.json", r#"{".":["notes"]}"#),
        ],
    );
    let state = IndexRuntimeState::default();
    let before = source_snapshot(tmp.path());

    crate::page::write::inject_failure(Some("move_order"), None);
    let error = super::rename(space, "notes", "Notes", None, runtime(&state)).await;
    crate::page::write::inject_failure(None, None);

    assert!(error.is_err());
    let names = fs::read_dir(tmp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert!(names.contains(&"notes".to_string()), "{names:?}");
    assert!(!names.contains(&"Notes".to_string()), "{names:?}");
    assert_eq!(source_snapshot(tmp.path()), before);
}

#[tokio::test]
async fn an_unrestorable_file_fails_the_rename_with_its_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    relation_target_space(root);
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    let sink = GroupSink::default();
    let link = root.join("Link.md");

    let replaced = link.clone();
    crate::page::write::inject_failure(
        Some("move_sources"),
        Some(Box::new(move || {
            fs::remove_file(&replaced).unwrap();
            fs::create_dir(&replaced).unwrap();
        })),
    );
    let error = super::rename(
        space,
        "Area",
        "Zone",
        Some(space),
        StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        },
    )
    .await
    .expect_err("unrestorable link source");
    crate::page::write::inject_failure(None, None);

    match error {
        crate::page::PageError::Recovery { cause, paths } => {
            assert!(cause.contains("injected move_sources failure"), "{cause}");
            assert_eq!(paths, vec![link.display().to_string()]);
        }
        error => panic!("expected recovery, got {error:?}"),
    }
    assert!(root.join("Area/Tasks/Item.md").is_file());
    assert!(!root.join("Zone").exists());
    assert!(sink.take().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_read_only_source_fails_the_operation_without_a_false_recovery() {
    use std::os::unix::fs::PermissionsExt;

    for (read_only, rename) in [
        ("Link.md", true),
        (".svode/order.json", true),
        ("Decisions/Decision.md", false),
    ] {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        relation_target_space(root);
        let space = root.to_str().unwrap();
        let state = IndexRuntimeState::default();
        let sink = GroupSink::default();
        let path = root.join(read_only);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let before = source_snapshot(root);
        let runtime = StructureRuntime {
            commits: Some(&sink),
            ..runtime(&state)
        };

        let result = if rename {
            super::rename(space, "Area", "Zone", Some(space), runtime).await
        } else {
            super::move_entry(
                space,
                "Area/Tasks/Item.md",
                "Area/Tasks/Sub",
                Some(space),
                runtime,
            )
            .await
            .map(|path| vec![path])
        };
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let error = result.expect_err(read_only);
        assert!(
            !matches!(error, crate::page::PageError::Recovery { .. }),
            "{read_only}: {error:?}"
        );
        assert_eq!(source_snapshot(root), before, "{read_only}");
        assert!(sink.take().is_empty(), "{read_only}");
    }
}

async fn create_tasks_collection(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    allocate_unique_title: bool,
) -> Result<super::CollectionCreateOutcome, crate::page::PageError> {
    let state = IndexRuntimeState::default();
    super::create_collection(
        super::CollectionCreate {
            space: space.to_string(),
            parent_path: parent_path.map(str::to_string),
            title: title.to_string(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: crate::collections::engine::default_collection_schema(),
            allocate_unique_title,
            project: None,
        },
        runtime(&state),
        |paths| async move { Ok::<_, crate::page::PageError>(paths) },
    )
    .await
}

/// Files and directories of `prefix` with their bytes.
fn subtree_snapshot(root: &Path, prefix: &str) -> Vec<(String, Vec<u8>)> {
    tree_snapshot(root)
        .into_iter()
        .filter(|(path, _)| path == prefix || path.starts_with(&format!("{prefix}/")))
        .collect()
}

/// Names of the direct children of `parent` that portably match `name`.
fn portable_neighbors(parent: &Path, name: &str) -> Vec<String> {
    let key = crate::page::filename::portable_component_key(name);
    let mut names = fs::read_dir(parent)
        .unwrap()
        .map(|item| item.unwrap().file_name().to_string_lossy().to_string())
        .filter(|component| crate::page::filename::portable_component_key(component) == key)
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[tokio::test]
async fn collection_create_takes_a_suffix_when_a_neighbor_has_its_portable_name() {
    // (neighbor files, parent, neighbor path)
    let cases: [(&[(&str, &str)], Option<&str>, &str); 5] = [
        (
            &[("tasks/Ship.md", "---\ntitle: Ship\n---\n")],
            None,
            "tasks",
        ),
        (
            &[("Tasks/Ship.md", "---\ntitle: Ship\n---\n")],
            None,
            "Tasks",
        ),
        (
            &[
                ("tasks/README.md", "---\ntitle: Backlog\n---\nOwner\n"),
                ("tasks/Ship.md", "---\ntitle: Ship\n---\n"),
            ],
            None,
            "tasks",
        ),
        (
            &[("tasks", "plain file without extension\n")],
            None,
            "tasks",
        ),
        (
            &[("projects/tasks/Ship.md", "---\ntitle: Ship\n---\n")],
            Some("projects"),
            "projects/tasks",
        ),
    ];
    for (files, parent, neighbor) in cases {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        crate::page::test_support::scaffold_space(root, "Root");
        fs::create_dir_all(root.join(".git")).unwrap();
        write_tree(root, files);
        let neighbor_name = neighbor.rsplit('/').next().unwrap();
        let mut order = std::collections::BTreeMap::from([(
            parent.unwrap_or(".").to_string(),
            vec![neighbor_name.to_string()],
        )]);
        if root.join(neighbor).is_dir() {
            order.insert(neighbor.to_string(), vec!["Ship.md".to_string()]);
        }
        crate::content_tree::replace_order(root, order).unwrap();
        let neighbor_before = subtree_snapshot(root, neighbor);
        let neighbor_order = crate::content_tree::read_order(root).get(neighbor).cloned();

        let outcome = create_tasks_collection(root.to_str().unwrap(), parent, "Tasks", false)
            .await
            .unwrap_or_else(|error| panic!("{neighbor}: {error:?}"));

        let expected = match parent {
            Some(parent) => format!("{parent}/Tasks-1"),
            None => "Tasks-1".to_string(),
        };
        assert_eq!(outcome.collection_path, expected, "{neighbor}");
        assert_eq!(outcome.collection.path, format!("{expected}/README.md"));
        assert_eq!(outcome.collection.meta.title, "Tasks", "{neighbor}");
        assert!(root.join(&expected).join("schema.yaml").is_file());
        assert!(
            outcome.collection.warnings.iter().any(|warning| {
                warning.kind == "filename_collision_allocated"
                    && warning.path.as_deref() == Some(outcome.collection.path.as_str())
            }),
            "{neighbor}: {:?}",
            outcome.collection.warnings
        );
        assert_eq!(
            subtree_snapshot(root, neighbor),
            neighbor_before,
            "{neighbor}"
        );
        assert_eq!(
            crate::content_tree::read_order(root).get(neighbor).cloned(),
            neighbor_order,
            "{neighbor}"
        );
        let parent_dir = parent.map_or(root.to_path_buf(), |parent| root.join(parent));
        assert_eq!(
            portable_neighbors(&parent_dir, "Tasks"),
            vec![neighbor_name.to_string()],
            "{neighbor}: no second name that differs only in case"
        );
    }
}

#[tokio::test]
async fn collection_create_keeps_the_title_conflict_and_the_page_file_suffix() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    crate::page::test_support::scaffold_space(root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    write_tree(
        root,
        &[
            ("tasks/README.md", "---\ntitle: tasks\n---\n"),
            ("Notes.md", "---\ntitle: Other\n---\n"),
        ],
    );
    let space = root.to_str().unwrap();
    let before = source_snapshot(root);

    let conflict = create_tasks_collection(space, None, "Tasks", false)
        .await
        .unwrap_err();
    assert!(
        matches!(conflict, crate::page::PageError::DocumentNameConflict(_)),
        "{conflict:?}"
    );
    assert_eq!(source_snapshot(root), before);

    let outcome = create_tasks_collection(space, None, "Notes", false)
        .await
        .unwrap();
    assert_eq!(outcome.collection_path, "Notes-1");
    assert_eq!(outcome.collection.meta.title, "Notes");
    assert!(
        outcome
            .collection
            .warnings
            .iter()
            .any(|warning| warning.kind == "filename_collision_allocated")
    );
    assert_eq!(
        fs::read_to_string(root.join("Notes.md")).unwrap(),
        "---\ntitle: Other\n---\n"
    );
}

#[tokio::test]
async fn collection_create_with_a_free_name_reports_no_allocation_warning() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    crate::page::test_support::scaffold_space(root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();

    let outcome = create_tasks_collection(root.to_str().unwrap(), None, "Tasks", false)
        .await
        .unwrap();

    assert_eq!(outcome.collection_path, "Tasks");
    assert_eq!(outcome.collection.path, "Tasks/README.md");
    assert!(outcome.collection.warnings.is_empty());
}

/// Space of `relation_target_space` plus the Collection `Sprints`, whose
/// column `Board` is a relation when `reverse_conflict` is false and a text
/// column otherwise (design scenario R of DF-221).
fn collection_create_space(root: &Path, reverse_conflict: bool) {
    relation_target_space(root);
    let schema = if reverse_conflict {
        "columns:\n  - { name: Board, type: text }\n"
    } else {
        "columns: []\n"
    };
    write_tree(
        root,
        &[
            ("Sprints/schema.yaml", schema),
            ("Sprints/README.md", "---\ntitle: Sprints\n---\n"),
        ],
    );
}

/// Create the Collection `Board` under the leaf item `Area/Tasks/Item.md`,
/// which `Link.md` links and `Decisions/Decision.md` relates to, with a
/// two-way relation to `Sprints`.
async fn create_board_collection(
    space: &str,
    state: &IndexRuntimeState,
    sink: &GroupSink,
) -> Result<super::CollectionCreateOutcome, crate::page::PageError> {
    let schema = serde_norway::from_str(
        "columns:\n  - name: Sprint\n    type: relation\n    relation: Sprints\n    two_way: Board\nviews: []\n",
    )
    .unwrap();
    super::create_collection(
        super::CollectionCreate {
            space: space.to_string(),
            parent_path: Some("Area/Tasks/Item.md".into()),
            title: "Board".into(),
            body: Some("See [Link](../../../Link.md).\n".into()),
            icon: None,
            description: None,
            cover: None,
            schema,
            allocate_unique_title: false,
            project: Some(space.to_string()),
        },
        StructureRuntime {
            commits: Some(sink),
            ..runtime(state)
        },
        |paths| async move { Ok::<_, crate::page::PageError>(paths) },
    )
    .await
}

/// After a failed create the sources are those before it, nothing is
/// registered in history and the projection follows the restored leaf.
async fn assert_collection_create_restored(
    root: &Path,
    state: &IndexRuntimeState,
    sink: &GroupSink,
    before: &[(String, String)],
    label: &str,
) {
    assert_eq!(source_snapshot(root), before, "{label}");
    assert!(sink.take().is_empty(), "{label}");
    let backlinks = state.backlinks_for_space_dir(root).await;
    assert!(
        backlinks
            .get_backlinks("Area/Tasks/Item.md")
            .iter()
            .any(|link| link.source_path == "Link.md"),
        "{label}"
    );
    assert!(
        backlinks
            .get_backlinks("Area/Tasks/Item/README.md")
            .is_empty(),
        "{label}"
    );
    let pool = state
        .get_or_create(&IndexKey::Root(root.to_path_buf()))
        .await
        .unwrap();
    let indexed = indexed_paths(&pool).await;
    assert!(
        indexed.contains(&"Area/Tasks/Item.md".to_string()),
        "{label}: {indexed:?}"
    );
    assert!(
        !indexed
            .iter()
            .any(|path| path.starts_with("Area/Tasks/Item/")),
        "{label}: {indexed:?}"
    );
}

#[tokio::test]
async fn a_failed_step_of_a_collection_create_restores_the_sources_and_the_projection() {
    for stage in ["collection_page", "collection_convert", "collection_schema"] {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        collection_create_space(root, false);
        let space = root.to_str().unwrap();
        let state = IndexRuntimeState::default();
        state
            .backlinks_for_space_dir(root)
            .await
            .build(root)
            .unwrap();
        let sink = GroupSink::default();
        let before = source_snapshot(root);

        crate::page::write::inject_failure(Some(stage), None);
        let error = create_board_collection(space, &state, &sink)
            .await
            .unwrap_err();
        crate::page::write::inject_failure(None, None);

        assert!(
            error
                .to_string()
                .contains(&format!("injected {stage} failure")),
            "{stage}: {error:?}"
        );
        assert_collection_create_restored(root, &state, &sink, &before, stage).await;
    }
}

#[tokio::test]
async fn a_reverse_column_conflict_restores_the_leaf_parent_its_links_and_relations() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    collection_create_space(root, true);
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    state
        .backlinks_for_space_dir(root)
        .await
        .build(root)
        .unwrap();
    let sink = GroupSink::default();
    let before = source_snapshot(root);

    let error = create_board_collection(space, &state, &sink)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("not a relation"), "{error:?}");
    assert_collection_create_restored(root, &state, &sink, &before, "scenario R").await;
}

#[tokio::test]
async fn a_collection_create_with_all_steps_registers_its_history_once_it_succeeds() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    collection_create_space(root, false);
    let state = IndexRuntimeState::default();
    let sink = GroupSink::default();

    let outcome = create_board_collection(root.to_str().unwrap(), &state, &sink)
        .await
        .unwrap();

    assert_eq!(outcome.collection_path, "Area/Tasks/Item/Board");
    assert!(root.join("Area/Tasks/Item/Board/schema.yaml").is_file());
    // The parent conversion rewrote the link and the relation value that a
    // failed create restores.
    assert_ne!(
        fs::read_to_string(root.join("Link.md")).unwrap(),
        "See [Item](Area/Tasks/Item.md).\n"
    );
    assert_ne!(
        fs::read_to_string(root.join("Decisions/Decision.md")).unwrap(),
        "---\ntitle: Decision\nTask: [Item.md]\n---\n"
    );
    assert!(!sink.take().is_empty());
}

#[tokio::test]
async fn a_directory_that_appears_before_the_conversion_fails_it_without_being_touched() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();
    crate::page::test_support::scaffold_space(&root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    let before = source_snapshot(&root);

    let concurrent = root.clone();
    crate::page::write::inject_effect(
        "collection_page",
        Box::new(move || write_tree(&concurrent, &[("Tasks/Mine.md", "mine\n")])),
    );
    let error = create_tasks_collection(root.to_str().unwrap(), None, "Tasks", false)
        .await
        .unwrap_err();

    assert!(
        matches!(&error, crate::page::PageError::FileAlreadyExists(path) if path == "Tasks"),
        "{error:?}"
    );
    let mut expected = before;
    expected.extend([
        ("Tasks".to_string(), String::new()),
        ("Tasks/Mine.md".to_string(), "mine\n".to_string()),
    ]);
    expected.sort();
    assert_eq!(source_snapshot(&root), expected);
}

#[tokio::test]
async fn a_changed_plan_removes_only_the_page_file_the_create_wrote() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();
    crate::page::test_support::scaffold_space(&root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    let before = source_snapshot(&root);
    let state = IndexRuntimeState::default();
    let concurrent = root.clone();

    let error = super::create_collection(
        super::CollectionCreate {
            space: root.to_string_lossy().into_owned(),
            parent_path: None,
            title: "Tasks".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: crate::collections::engine::default_collection_schema(),
            allocate_unique_title: false,
            project: None,
        },
        runtime(&state),
        |paths| async move {
            // A directory with the planned name appears after the plan, so
            // the Page create allocates the next free name.
            write_tree(&concurrent, &[("Tasks/Mine.md", "mine\n")]);
            Ok::<_, crate::page::PageError>(paths)
        },
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("plan changed"), "{error:?}");
    let mut expected = before;
    expected.extend([
        ("Tasks".to_string(), String::new()),
        ("Tasks/Mine.md".to_string(), "mine\n".to_string()),
    ]);
    expected.sort();
    assert_eq!(source_snapshot(&root), expected);
}
