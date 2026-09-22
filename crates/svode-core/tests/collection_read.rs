use std::fs;

use serde_yml::Value;
use sqlx::SqlitePool;
use svode_core::collections::engine::read_collection_schema;
use svode_core::collections::entries::entries_from_rows;
use svode_core::collections::list::list_collections;
use svode_core::collections::model::{CollectionSchema, Filter, FilterOp, Sort};
use svode_core::collections::query::query_entry_rows;
use svode_core::collections::relation_read::{
    RelationTwoWaySchemaStatus, diagnose_two_way_relation, query_relation_backlinks,
    resolve_relation,
};
use svode_core::git::cli::GitCli;
use svode_core::index::reindex::full_reindex;

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

#[tokio::test]
async fn df_087_root_collection_queries_exclude_owner_readme_for_all_query_shapes() {
    let tmp = tempfile::TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join(".svode")).unwrap();
    fs::create_dir_all(space.join("notes")).unwrap();
    fs::create_dir_all(space.join("archive")).unwrap();
    fs::write(
        space.join("schema.yaml"),
        "columns:\n  - name: Priority\n    type: text\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("README.md"),
        "---\ntitle: Owner\nPriority: Hidden\n---\nOwner body",
    )
    .unwrap();
    fs::write(
        space.join("alpha.md"),
        "---\ntitle: Alpha\nPriority: High\n---\nAlpha body",
    )
    .unwrap();
    fs::write(space.join("notes/README.md"), "---\ntitle: Notes\n---\n").unwrap();
    fs::write(space.join("notes/deep.md"), "---\ntitle: Deep\n---\n").unwrap();
    fs::write(
        space.join("archive/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("archive/README.md"),
        "---\ntitle: Archive\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("archive/item.md"),
        "---\ntitle: Nested item\n---\n",
    )
    .unwrap();

    let pool = svode_core::index::db::create_pool(&space.join(".svode/index.db"))
        .await
        .unwrap();
    svode_core::index::db::ensure_schema(&pool).await.unwrap();
    full_reindex::<GitCli>(None, &pool, space, &[])
        .await
        .unwrap();
    let schema = read_collection_schema(space.to_str().unwrap(), ".").unwrap();

    let rows = query_entry_rows(&pool, &schema, ".", &[], &[], None, None)
        .await
        .unwrap();
    let mut paths = rows
        .iter()
        .map(|row| row.file_path.as_str())
        .collect::<Vec<_>>();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec![
            "alpha.md",
            "archive/README.md",
            "notes/README.md",
            "notes/deep.md"
        ]
    );

    let flat = entries_from_rows(space.to_str().unwrap(), ".", rows.clone(), false, false).unwrap();
    assert_eq!(flat.len(), 3);
    assert!(flat.iter().all(|entry| entry.path != "README.md"));
    let nested = entries_from_rows(space.to_str().unwrap(), ".", rows, true, false).unwrap();
    assert_eq!(nested.len(), 4);
    assert!(nested.iter().all(|entry| entry.path != "README.md"));

    let owner_filter = vec![Filter {
        field: "title".into(),
        op: FilterOp::Eq,
        value: Some(Value::String("Owner".into())),
        values: None,
    }];
    assert!(
        query_entry_rows(&pool, &schema, ".", &owner_filter, &[], None, None)
            .await
            .unwrap()
            .is_empty()
    );

    let title_sort = vec![Sort {
        field: "title".into(),
        desc: false,
    }];
    let sorted = query_entry_rows(&pool, &schema, ".", &[], &title_sort, None, None)
        .await
        .unwrap();
    assert_eq!(
        sorted.into_iter().map(|row| row.title).collect::<Vec<_>>(),
        vec!["Alpha", "Archive", "Deep", "Notes"]
    );

    let owner_membership_edges: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM knowledge_links WHERE source_path = 'README.md' AND edge_kind = 'member_of'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner_membership_edges, 0);
    assert!(
        svode_core::index::search::search_by_title(&pool, "Owner", 10)
            .await
            .unwrap()
            .is_empty()
    );
}
