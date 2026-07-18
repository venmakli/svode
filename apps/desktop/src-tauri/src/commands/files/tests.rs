use super::*;
use crate::space::config::write_space_config;
use crate::space::types::{SpaceConfig, TreeSpaceConfig};
use sqlx::SqlitePool;
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

fn collect_markdown_rel_paths(tmp: &TempDir, root: &Path) -> Vec<String> {
    let policy = TreeIgnorePolicy::from_space_root(tmp.path());
    let mut rels = collect_markdown_paths(tmp.path(), root, &policy)
        .expect("collect markdown paths")
        .into_iter()
        .map(|path| {
            path.strip_prefix(tmp.path())
                .expect("relative path")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect::<Vec<_>>();
    rels.sort();
    rels
}

async fn delete_for_test(tmp: &TempDir, path: &str) -> DeleteEntryCommandResult {
    let index_state = IndexState::new();
    delete_entry_shared(tmp.path().to_str().unwrap(), path, None, &index_state, None)
        .await
        .expect("delete entry")
}

async fn indexed_pool(state: &IndexState, space: &Path) -> SqlitePool {
    state
        .get_or_create(&IndexKey::Root(space.to_path_buf()))
        .await
        .expect("index pool")
}

async fn indexed_paths(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
        .fetch_all(pool)
        .await
        .expect("indexed paths")
}

#[test]
fn targeted_markdown_collection_uses_tree_ignore_policy() {
    let tmp = TempDir::new().unwrap();
    write_tree_config(&tmp, vec!["node_modules"], vec![]);
    std::fs::create_dir_all(tmp.path().join("docs").join(".cache")).unwrap();
    std::fs::create_dir_all(tmp.path().join("node_modules").join("pkg")).unwrap();
    std::fs::write(tmp.path().join("docs").join("keep.md"), "keep").unwrap();
    std::fs::write(tmp.path().join("docs").join(".notes.md"), "notes").unwrap();
    std::fs::write(
        tmp.path().join("docs").join(".cache").join("hidden.md"),
        "hidden",
    )
    .unwrap();
    std::fs::write(
        tmp.path()
            .join("node_modules")
            .join("pkg")
            .join("README.md"),
        "ignored",
    )
    .unwrap();

    assert_eq!(
        collect_markdown_rel_paths(&tmp, &tmp.path().join("docs")),
        vec!["docs/.notes.md".to_string(), "docs/keep.md".to_string()]
    );
    assert!(collect_markdown_rel_paths(&tmp, &tmp.path().join("node_modules")).is_empty());
}

#[test]
fn rebase_legacy_source_after_move_updates_content_and_source_identity() {
    let tmp = TempDir::new().unwrap();
    let index = BacklinkIndex::new();
    std::fs::write(tmp.path().join("Source.md"), "See [Target](Target.md).\n").unwrap();
    std::fs::write(tmp.path().join("Target.md"), "Target\n").unwrap();
    index.build(tmp.path()).unwrap();

    std::fs::create_dir_all(tmp.path().join("Moved")).unwrap();
    std::fs::rename(
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
        std::fs::read_to_string(tmp.path().join("Moved").join("Source.md")).unwrap(),
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
    std::fs::create_dir_all(tmp.path().join("Folder")).unwrap();
    std::fs::write(
        tmp.path().join("Folder").join("Source.md"),
        "See [Sibling](Sibling.md) and [Outside](../Outside.md).\n",
    )
    .unwrap();
    std::fs::write(tmp.path().join("Folder").join("Sibling.md"), "Sibling\n").unwrap();
    std::fs::write(tmp.path().join("Outside.md"), "Outside\n").unwrap();
    index.build(tmp.path()).unwrap();

    std::fs::create_dir_all(tmp.path().join("Archive")).unwrap();
    std::fs::rename(
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
        std::fs::read_to_string(tmp.path().join("Archive").join("Folder").join("Source.md"))
            .unwrap(),
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
async fn shared_delete_entry_deletes_document_and_reports_changed_paths() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("Note.md"), "note").unwrap();

    let result = delete_for_test(&tmp, "Note.md").await;

    assert!(!tmp.path().join("Note.md").exists());
    assert_eq!(result.deleted_root, "Note.md");
    assert_eq!(result.deleted_paths, vec!["Note.md".to_string()]);
    assert!(result.changed_paths.contains(&"Note.md".to_string()));
}

#[tokio::test]
async fn shared_delete_entry_removes_targeted_index_rows_and_fts() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    write_tree_config(&tmp, vec![], vec![]);
    std::fs::write(space.join("Note.md"), "search-token body").unwrap();
    index::update::update_entry(&state, space, &space.join("Note.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let result = delete_entry_shared(
        space.to_str().unwrap(),
        "Note.md",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await
    .expect("delete entry");

    assert_eq!(result.deleted_paths, vec!["Note.md".to_string()]);
    assert!(indexed_paths(&pool).await.is_empty());
    let hits = index::search::search_fts(&pool, "search-token", None, None, 10)
        .await
        .unwrap();
    assert!(hits.is_empty());
}

#[tokio::test]
async fn shared_delete_entry_deletes_collection_entry_without_schema() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join("Tasks")).unwrap();
    std::fs::write(
        tmp.path().join("Tasks").join("schema.yaml"),
        "columns: []\n",
    )
    .unwrap();
    std::fs::write(tmp.path().join("Tasks").join("Item.md"), "item").unwrap();

    let result = delete_for_test(&tmp, "Tasks/Item.md").await;

    assert!(!tmp.path().join("Tasks").join("Item.md").exists());
    assert!(tmp.path().join("Tasks").join("schema.yaml").exists());
    assert_eq!(result.deleted_root, "Tasks/Item.md");
    assert_eq!(result.deleted_paths, vec!["Tasks/Item.md".to_string()]);
    assert!(result.changed_paths.contains(&"Tasks/Item.md".to_string()));
}

#[tokio::test]
async fn shared_delete_entry_deletes_folder_document_from_readme_path() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join("Folder")).unwrap();
    std::fs::write(tmp.path().join("Folder").join("README.md"), "folder").unwrap();
    std::fs::write(tmp.path().join("Folder").join("Child.md"), "child").unwrap();

    let result = delete_for_test(&tmp, "Folder/README.md").await;

    assert!(!tmp.path().join("Folder").exists());
    assert_eq!(result.deleted_root, "Folder");
    assert!(
        result
            .deleted_paths
            .contains(&"Folder/README.md".to_string())
    );
    assert!(
        result
            .deleted_paths
            .contains(&"Folder/Child.md".to_string())
    );
    assert!(
        result
            .changed_paths
            .contains(&"Folder/README.md".to_string())
    );
    assert!(
        result
            .changed_paths
            .contains(&"Folder/Child.md".to_string())
    );
}

#[tokio::test]
async fn targeted_convert_to_folder_replaces_stale_leaf_index_row() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::write(space.join("Topic.md"), "leaf-body-token").unwrap();
    index::update::update_entry(&state, space, &space.join("Topic.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let entry = entry::convert_entry_to_folder(space, "Topic.md", None).unwrap();
    replace_index_entries_or_reindex(
        &state,
        Some(space.to_str().unwrap()),
        space.to_str().unwrap(),
        &["Topic.md".to_string()],
        std::slice::from_ref(&entry.path),
        "convert_entry_to_folder",
    )
    .await;

    assert_eq!(entry.path, "Topic/README.md");
    assert_eq!(
        indexed_paths(&pool).await,
        vec!["Topic/README.md".to_string()]
    );
    assert!(
        index::search::search_fts(&pool, "leaf-body-token", None, None, 10)
            .await
            .unwrap()
            .iter()
            .all(|row| row.path != "Topic.md")
    );
}

#[tokio::test]
async fn targeted_convert_to_leaf_replaces_stale_readme_index_row() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::create_dir_all(space.join("Topic")).unwrap();
    std::fs::write(space.join("Topic").join("README.md"), "readme-body-token").unwrap();
    index::update::update_entry(&state, space, &space.join("Topic").join("README.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let entry = entry::convert_entry_to_leaf(space, "Topic/README.md", None).unwrap();
    replace_index_entries_or_reindex(
        &state,
        Some(space.to_str().unwrap()),
        space.to_str().unwrap(),
        &["Topic/README.md".to_string()],
        std::slice::from_ref(&entry.path),
        "convert_entry_to_leaf",
    )
    .await;

    assert_eq!(entry.path, "Topic.md");
    assert_eq!(indexed_paths(&pool).await, vec!["Topic.md".to_string()]);
    assert!(
        index::search::search_fts(&pool, "readme-body-token", None, None, 10)
            .await
            .unwrap()
            .iter()
            .all(|row| row.path != "Topic/README.md")
    );
}

#[tokio::test]
async fn targeted_duplicate_indexes_created_tree_only() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::write(
        space.join("Original.md"),
        "---\ntitle: Original\n---\noriginal-token",
    )
    .unwrap();
    index::update::update_entry(&state, space, &space.join("Original.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let entry = entry::duplicate_entry(space, "Original.md").unwrap();
    update_index_tree_or_reindex(
        &state,
        Some(space.to_str().unwrap()),
        space.to_str().unwrap(),
        root_path_for_head(&entry.path),
        "duplicate_entry",
    )
    .await;

    assert_eq!(entry.path, "original-copy.md");
    assert_eq!(
        indexed_paths(&pool).await,
        vec!["Original.md".to_string(), "original-copy.md".to_string()]
    );
    let hits = index::search::search_fts(&pool, "original-token", None, None, 10)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
}

#[tokio::test]
async fn targeted_nested_collection_convert_recomputes_descendant_flags() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::create_dir_all(space.join("Tasks")).unwrap();
    std::fs::write(space.join("Tasks").join("README.md"), "Tasks").unwrap();
    std::fs::write(space.join("Tasks").join("Item.md"), "item-token").unwrap();
    index::update::update_entry(&state, space, &space.join("Tasks").join("Item.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let collection_path =
        entry::convert_entry_to_nested_collection(space, "Tasks/README.md").unwrap();
    update_index_tree_or_reindex(
        &state,
        Some(space.to_str().unwrap()),
        space.to_str().unwrap(),
        &collection_path,
        "convert_entry_to_nested_collection",
    )
    .await;

    let flags: (Option<String>, i64, i64) = sqlx::query_as(
            "SELECT collection_root_path, in_collection, is_entry_head FROM entries WHERE file_path = ?",
        )
        .bind("Tasks/Item.md")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(flags, (Some("Tasks".to_string()), 1, 1));
}

#[tokio::test]
async fn shared_convert_to_collection_preserves_leaf_and_refreshes_index_tree() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::write(
        space.join("Topic.md"),
        "---\ntitle: Topic\nstatus: draft\n---\nleaf-body-token",
    )
    .unwrap();
    std::fs::write(space.join("Reference.md"), "[Topic](Topic.md)").unwrap();
    index::update::update_entry(&state, space, &space.join("Topic.md"))
        .await
        .unwrap();
    index::update::update_entry(&state, space, &space.join("Reference.md"))
        .await
        .unwrap();
    let pool = indexed_pool(&state, space).await;

    let result = convert_to_collection_shared(
        space.to_str().unwrap(),
        "Topic.md",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await
    .expect("convert leaf to collection");

    assert_eq!(result.old_path, "Topic.md");
    assert_eq!(result.collection_path, "Topic");
    assert_eq!(result.readme_path, "Topic/README.md");
    assert_eq!(result.schema_path, "Topic/schema.yaml");
    assert_eq!(result.entry.body, "leaf-body-token");
    assert_eq!(
        result
            .entry
            .meta
            .extra
            .get("status")
            .and_then(|value| value.as_str()),
        Some("draft")
    );
    assert!(space.join("Topic").join("schema.yaml").exists());
    assert!(!space.join("Topic.md").exists());
    assert_eq!(
        std::fs::read_to_string(space.join("Reference.md")).unwrap(),
        "[Topic](Topic/README.md)"
    );
    assert_eq!(
        indexed_paths(&pool).await,
        vec!["Reference.md".to_string(), "Topic/README.md".to_string()]
    );
    assert!(
        index::search::search_fts(&pool, "leaf-body-token", None, None, 10)
            .await
            .unwrap()
            .iter()
            .any(|row| row.path == "Topic/README.md")
    );
}

#[tokio::test]
async fn shared_convert_to_collection_supports_folder_document_and_bare_folder() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::create_dir_all(space.join("Folder")).unwrap();
    std::fs::write(
        space.join("Folder").join("README.md"),
        "folder-document-token",
    )
    .unwrap();
    std::fs::create_dir_all(space.join("Bare")).unwrap();

    let folder_result = convert_to_collection_shared(
        space.to_str().unwrap(),
        "Folder/README.md",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await
    .expect("convert folder document");
    let bare_result = convert_to_collection_shared(
        space.to_str().unwrap(),
        "Bare",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await
    .expect("convert bare folder");

    assert_eq!(folder_result.collection_path, "Folder");
    assert_eq!(folder_result.readme_path, "Folder/README.md");
    assert_eq!(folder_result.entry.body, "folder-document-token");
    assert!(space.join("Folder").join("schema.yaml").exists());
    assert_eq!(bare_result.collection_path, "Bare");
    assert_eq!(bare_result.readme_path, "Bare/README.md");
    assert!(space.join("Bare").join("schema.yaml").exists());
}

#[tokio::test]
async fn shared_convert_to_collection_rejects_existing_collection_readme() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::create_dir_all(space.join("Tasks")).unwrap();
    std::fs::write(space.join("Tasks").join("README.md"), "tasks").unwrap();
    std::fs::write(space.join("Tasks").join("schema.yaml"), "columns: []\n").unwrap();

    let result = convert_to_collection_shared(
        space.to_str().unwrap(),
        "Tasks/README.md",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::General(message)) if message.contains("already a collection"))
    );
}

#[tokio::test]
async fn shared_convert_to_collection_preserves_leaf_when_target_folder_exists() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let state = IndexState::new();
    std::fs::write(space.join("Topic.md"), "topic-body").unwrap();
    std::fs::create_dir(space.join("Topic")).unwrap();

    let result = convert_to_collection_shared(
        space.to_str().unwrap(),
        "Topic.md",
        Some(space.to_str().unwrap()),
        &state,
        None,
    )
    .await;

    assert!(matches!(result, Err(AppError::FileAlreadyExists(path)) if path == "Topic"));
    assert_eq!(
        std::fs::read_to_string(space.join("Topic.md")).unwrap(),
        "topic-body"
    );
    assert!(!space.join("Topic").join("schema.yaml").exists());
}

#[tokio::test]
async fn shared_delete_entry_returns_error_for_missing_path() {
    let tmp = TempDir::new().unwrap();
    let index_state = IndexState::new();

    let result = delete_entry_shared(
        tmp.path().to_str().unwrap(),
        "Missing.md",
        None,
        &index_state,
        None,
    )
    .await;

    assert!(matches!(result, Err(AppError::FileNotFound(path)) if path == "Missing.md"));
}

#[test]
fn shared_reorder_entries_handles_semantic_paths_and_preserves_other_keys() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    std::fs::write(space.join("note.md"), "note").unwrap();
    std::fs::create_dir(space.join("folder")).unwrap();
    std::fs::write(space.join("folder/README.md"), "folder").unwrap();
    std::fs::write(space.join("folder/a.md"), "a").unwrap();
    std::fs::write(space.join("folder/b.md"), "b").unwrap();
    std::fs::create_dir(space.join("collection")).unwrap();
    std::fs::write(space.join("collection/README.md"), "collection").unwrap();
    std::fs::write(
        space.join("collection/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    let mut order = HashMap::new();
    order.insert(
        ".".to_string(),
        vec![
            "note.md".to_string(),
            "folder".to_string(),
            "collection".to_string(),
        ],
    );
    order.insert(
        "folder".to_string(),
        vec!["a.md".to_string(), "b.md".to_string()],
    );
    tree::write_order(space, &order).unwrap();

    let result = reorder_entries_shared(
        space.to_str().unwrap(),
        "",
        vec![
            "collection/README.md".to_string(),
            "folder/README.md".to_string(),
            "note.md".to_string(),
        ],
    )
    .unwrap();

    assert_eq!(result.parent_path, "");
    assert_eq!(
        result.previous_order,
        vec![
            "note.md".to_string(),
            "folder/README.md".to_string(),
            "collection/README.md".to_string(),
        ]
    );
    let saved = tree::read_order(space);
    assert_eq!(
        saved.get(".").unwrap(),
        &vec![
            "collection".to_string(),
            "folder".to_string(),
            "note.md".to_string(),
        ]
    );
    assert_eq!(
        saved.get("folder").unwrap(),
        &vec!["a.md".to_string(), "b.md".to_string()]
    );

    let nested = reorder_entries_shared(
        space.to_str().unwrap(),
        "folder/README.md",
        vec!["folder/b.md".to_string(), "folder/a.md".to_string()],
    )
    .unwrap();
    assert_eq!(nested.parent_path, "folder");
    assert_eq!(
        tree::read_order(space).get("folder").unwrap(),
        &vec!["b.md".to_string(), "a.md".to_string()]
    );
}

#[test]
fn shared_reorder_entries_rejects_invalid_permutation_without_writing() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    std::fs::write(space.join("a.md"), "a").unwrap();
    std::fs::write(space.join("b.md"), "b").unwrap();
    let mut order = HashMap::new();
    order.insert(
        ".".to_string(),
        vec!["a.md".to_string(), "b.md".to_string()],
    );
    tree::write_order(space, &order).unwrap();
    let before = std::fs::read(space.join(".svode/order.json")).unwrap();

    for invalid in [
        vec!["a.md".to_string(), "a.md".to_string()],
        vec!["a.md".to_string()],
        vec!["a.md".to_string(), "foreign.md".to_string()],
    ] {
        let result = reorder_entries_shared(space.to_str().unwrap(), "", invalid);
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(space.join(".svode/order.json")).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn shared_rename_rejects_parent_change_and_preserves_sibling_position() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    std::fs::create_dir(space.join("target")).unwrap();
    std::fs::write(space.join("a.md"), "a").unwrap();
    std::fs::write(space.join("b.md"), "b").unwrap();
    let mut order = HashMap::new();
    order.insert(
        ".".to_string(),
        vec!["a.md".to_string(), "b.md".to_string()],
    );
    tree::write_order(space, &order).unwrap();
    let index_state = IndexState::new();

    let invalid = rename_entry_shared(
        space.to_str().unwrap(),
        "a.md",
        "target/a.md",
        None,
        &index_state,
        None,
    )
    .await;
    assert!(invalid.is_err());
    assert!(space.join("a.md").is_file());

    rename_entry_shared(
        space.to_str().unwrap(),
        "a.md",
        "renamed.md",
        None,
        &index_state,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        tree::read_order(space).get(".").unwrap(),
        &vec!["renamed.md".to_string(), "b.md".to_string()]
    );
}
