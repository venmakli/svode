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
