use std::fs;

use sqlx::SqlitePool;
use svode_core::collections::list::list_collections;
use svode_core::collections::model::CollectionSchema;
use svode_core::collections::query::query_entry_rows;
use svode_core::collections::relation_read::{
    RelationTwoWaySchemaStatus, diagnose_two_way_relation, query_relation_backlinks,
    resolve_relation,
};

#[tokio::test]
async fn core_query_uses_collection_membership_and_bounded_rows() {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        "CREATE TABLE entries (file_path TEXT PRIMARY KEY, title TEXT, created TEXT, updated TEXT, icon TEXT, collection_root_path TEXT, in_collection INTEGER, is_entry_head INTEGER, fields TEXT)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (path, collection, membership) in [
        ("tasks/hidden.md", "tasks", 1),
        ("tasks/visible.md", "tasks", 1),
        ("tasks/unrelated.md", "tasks", 0),
        ("elsewhere/page.md", "elsewhere", 1),
    ] {
        sqlx::query("INSERT INTO entries (file_path, title, created, updated, icon, collection_root_path, in_collection, is_entry_head, fields) VALUES (?, ?, '', '', NULL, ?, ?, 1, '{}')")
            .bind(path)
            .bind(path)
            .bind(collection)
            .bind(membership)
            .execute(&pool)
            .await
            .unwrap();
    }
    let schema = CollectionSchema::default();
    let rows = query_entry_rows(&pool, &schema, "tasks", &[], &[], None, None)
        .await
        .unwrap();
    let paths: Vec<_> = rows.iter().map(|row| row.file_path.as_str()).collect();
    assert_eq!(paths, ["tasks/hidden.md", "tasks/visible.md"]);
    let page = query_entry_rows(&pool, &schema, "tasks", &[], &[], Some(1), Some(1))
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert!(paths.contains(&page[0].file_path.as_str()));
}

#[tokio::test]
async fn core_relation_reads_source_and_index_without_desktop_runtime() {
    let fixture = tempfile::tempdir().unwrap();
    let space = fixture.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("people")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Person\n    type: relation\n    relation: people\n",
    )
    .unwrap();
    fs::write(space.join("people/schema.yaml"), "columns: []\n").unwrap();
    fs::write(
        space.join("tasks/work.md"),
        "---\ntitle: Work\nPerson:\n  - alice.md\n---\nBody\n",
    )
    .unwrap();
    fs::write(space.join("people/alice.md"), "---\ntitle: Alice\n---\n").unwrap();

    let space_string = space.to_str().unwrap();
    let collections = list_collections(space_string).unwrap();
    assert_eq!(collections.len(), 2);
    assert_eq!(
        collections
            .iter()
            .find(|row| row.path == "tasks")
            .unwrap()
            .row_count,
        1
    );
    let backlinks = query_relation_backlinks(space_string, "people/alice.md", None, None).unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].file_path, "tasks/work.md");
    let diagnostics = diagnose_two_way_relation(space_string, "tasks", "Person").unwrap();
    assert_eq!(
        diagnostics.schema_status,
        RelationTwoWaySchemaStatus::NotTwoWay
    );

    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE entries (file_path TEXT PRIMARY KEY, title TEXT, icon TEXT, collection_root_path TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO entries VALUES ('people/alice.md', 'Alice', NULL, 'people')")
        .execute(&pool)
        .await
        .unwrap();
    let resolved = resolve_relation(&pool, "people", "alice.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.title, "Alice");
    assert_eq!(resolved.file_path, "people/alice.md");
}
