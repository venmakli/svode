use serde::Serialize;
use sqlx::SqlitePool;
use tempfile::TempDir;

use super::*;
use crate::collections::query::{query_entry_rows, reorder_visible_entry_names};
use crate::collections::relation_read::validate_relation_value_shape;
use crate::collections::schema::read_schema_at;
use crate::collections::schema_validation::validate_filter_op;
use crate::collections::traversal::collection_markdown_files;
use query_filters::normalize_filter_values_for_query;

#[derive(Serialize)]
struct SpaceRef {
    id: String,
    path: String,
    repo: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeSpaceConfig {
    exclude: Vec<String>,
    include: Vec<String>,
    show_ignored_placeholders: bool,
}

fn write_test_space_config(
    space: &Path,
    spaces: Option<Vec<SpaceRef>>,
    tree: Option<TreeSpaceConfig>,
) {
    fs::create_dir_all(space.join(".svode")).unwrap();
    let mut config = serde_json::json!({
        "name": "Test",
        "description": "",
        "icon": "folder",
    });
    if let Some(spaces) = spaces {
        config["spaces"] = serde_json::to_value(spaces).unwrap();
    }
    if let Some(tree) = tree {
        config["tree"] = serde_json::to_value(tree).unwrap();
    }
    fs::write(
        space.join(".svode/config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
}

#[test]
fn boolean_schema_is_canonical_strict_and_inferred_from_boolean_values() {
    let raw = r#"
columns:
  - { name: Active, type: boolean, default: false }
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    validate_schema(&schema).unwrap();
    assert_eq!(schema.columns[0].type_, PropertyType::Boolean);
    assert_eq!(schema.columns[0].default, Some(Value::Bool(false)));
    assert!(
        serde_yml::to_string(&schema)
            .unwrap()
            .contains("type: boolean")
    );

    let legacy = serde_yml::from_str::<CollectionSchema>(
        "columns:\n  - { name: Active, type: checkbox }\nviews: []\n",
    )
    .unwrap_err()
    .to_string();
    assert!(legacy.contains("checkbox"));
    assert!(legacy.contains("boolean"));

    let invalid_default: CollectionSchema = serde_yml::from_str(
        "columns:\n  - { name: Active, type: boolean, default: yes }\nviews: []\n",
    )
    .unwrap();
    let error = validate_schema(&invalid_default).unwrap_err().to_string();
    assert!(error.contains("Active must be a boolean"));

    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), raw).unwrap();
    let mut meta = EntryMeta::new_persisted("Item");
    assert!(
        apply_schema_defaults_for_path(space.to_str().unwrap(), "tasks/item.md", &mut meta,)
            .unwrap()
    );
    assert_eq!(meta.extra.get("Active"), Some(&Value::Bool(false)));

    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - { name: Active, type: boolean }\nviews: []\n",
    )
    .unwrap();
    let mut meta_without_default = EntryMeta::new_persisted("No default");
    assert!(
        !apply_schema_defaults_for_path(
            space.to_str().unwrap(),
            "tasks/no-default.md",
            &mut meta_without_default,
        )
        .unwrap()
    );
    assert!(!meta_without_default.extra.contains_key("Active"));

    fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join("tasks/item.md"),
        "---\ntitle: Item\nActive: true\n---\n",
    )
    .unwrap();
    let inferred =
        promote_orphan(space.to_str().unwrap(), "tasks", "tasks/item.md", "Active").unwrap();
    assert_eq!(inferred.columns[0].type_, PropertyType::Boolean);
    assert!(
        fs::read_to_string(space.join("tasks/schema.yaml"))
            .unwrap()
            .contains("type: boolean")
    );
}

#[test]
fn read_schema_applies_sensitivity_defaults_and_accepts_legacy_schema() {
    let tmp = TempDir::new().unwrap();
    let schema_path = tmp.path().join("schema.yaml");
    fs::write(
        &schema_path,
        "columns:\n  - { name: Email, type: email }\n  - { name: Title, type: text }\nviews: []\n",
    )
    .unwrap();

    let schema = read_schema_at(&schema_path).unwrap();
    assert_eq!(schema.columns[0].sensitivity, Some(ColumnSensitivity::Pii));
    assert_eq!(schema.columns[1].sensitivity, None);
}

#[test]
fn legacy_document_config_is_ignored_until_an_explicit_schema_write() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    let collection = space.join("tasks");
    fs::create_dir_all(&collection).unwrap();
    let schema_path = collection.join(SCHEMA_FILE);
    let legacy = "document:\n  label: Documents\ncolumns: []\nviews: []\n";
    fs::write(&schema_path, legacy).unwrap();

    let schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
    assert_eq!(fs::read_to_string(&schema_path).unwrap(), legacy);

    write_collection_schema(space.to_str().unwrap(), "tasks", &schema).unwrap();
    let rewritten = fs::read_to_string(&schema_path).unwrap();
    assert!(!rewritten.contains("document:"));
}

#[test]
fn list_collections_skips_registered_child_space_dirs() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    write_test_space_config(
        space,
        Some(vec![SpaceRef {
            id: "child-space".to_string(),
            path: "child".to_string(),
            repo: None,
        }]),
        None,
    );
    fs::write(space.join(SCHEMA_FILE), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join("root-row.md"),
        "---\nid: root-row\ntitle: Root row\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::create_dir_all(space.join("child")).unwrap();
    fs::write(
        space.join("child").join(SCHEMA_FILE),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("child").join("child-row.md"),
        "---\nid: child-row\ntitle: Child row\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let collections = list_collections(space.to_str().unwrap()).unwrap();

    assert_eq!(
        collections
            .iter()
            .map(|collection| collection.path.as_str())
            .collect::<Vec<_>>(),
        vec!["."]
    );
    assert_eq!(collections[0].row_count, 1);
}

#[test]
fn collection_markdown_files_respects_tree_excludes() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    write_test_space_config(
        space,
        None,
        Some(TreeSpaceConfig {
            exclude: vec!["heavy".to_string()],
            include: vec![],
            show_ignored_placeholders: false,
        }),
    );
    fs::write(space.join(SCHEMA_FILE), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join("visible.md"),
        "---\nid: visible\ntitle: Visible\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::create_dir_all(space.join("heavy")).unwrap();
    fs::write(
        space.join("heavy").join("hidden.md"),
        "---\nid: hidden\ntitle: Hidden\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("heavy").join(SCHEMA_FILE),
        "columns: []\nviews: []\n",
    )
    .unwrap();

    let files = collection_markdown_files(space.to_str().unwrap(), ".").unwrap();
    let collections = list_collections(space.to_str().unwrap()).unwrap();

    assert_eq!(
        files
            .iter()
            .map(|file| file
                .strip_prefix(space)
                .unwrap()
                .to_string_lossy()
                .to_string())
            .collect::<Vec<_>>(),
        vec!["visible.md".to_string()]
    );
    assert_eq!(
        collections
            .iter()
            .map(|collection| collection.path.as_str())
            .collect::<Vec<_>>(),
        vec!["."]
    );
}

#[test]
fn relation_value_shape_normalizes_unique_many_and_rejects_dot_segments() {
    let column = Column {
        name: "Tasks".into(),
        type_: PropertyType::Relation,
        sensitivity: None,
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
        relation: Some("tasks".into()),
        relation_scope: None,
        limit: None,
        two_way: None,
        prefix: None,
        next: None,
        multiple: None,
    };
    let value: Value = serde_yml::from_str("[a.md, a.md, folder/README.md]").unwrap();
    let normalized = validate_relation_value_shape(&column, &value).unwrap();
    assert_eq!(normalized, vec!["a.md", "folder/README.md"]);

    let bad: Value = serde_yml::from_str("../a.md").unwrap();
    assert!(validate_relation_value_shape(&column, &bad).is_err());
}

#[tokio::test]
async fn move_to_another_collection_keeps_old_relation_out_of_scope() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("archive")).unwrap();
    fs::create_dir_all(space.join("projects")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join("archive/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("projects/schema.yaml"),
        "columns:\n  - name: Work\n    type: relation\n    relation: tasks\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("projects/p.md"),
        "---\nid: p\ntitle: Project\ncreated: now\nupdated: now\nWork: a.md\n---\n",
    )
    .unwrap();
    fs::rename(space.join("tasks/a.md"), space.join("archive/a.md")).unwrap();

    rewrite_relation_paths_for_move(space.to_str().unwrap(), "tasks/a.md", "archive/a.md").unwrap();

    let raw = fs::read_to_string(space.join("projects/p.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    let work_values: Vec<_> = meta
        .extra
        .get("Work")
        .unwrap()
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(work_values, vec!["archive/a.md"]);

    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                icon TEXT,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
            r#"
            INSERT INTO entries (
                file_path, title, icon, description, created, updated, collection_root_path,
                in_collection, is_entry_head, fields
            ) VALUES ('archive/a.md', 'A', NULL, NULL, '2026-01-01', '2026-01-01', 'archive', 1, 1, '{}')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

    let resolved = resolve_relation(&pool, "tasks", "archive/a.md")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.file_path, "archive/a.md");
    assert_eq!(resolved.collection_root_path, "archive");

    let batch = resolve_relations_batch(&pool, "tasks", &["archive/a.md".to_string()])
        .await
        .unwrap();
    assert_eq!(batch[0].as_ref().unwrap().file_path, "archive/a.md");
}

#[test]
fn two_way_relation_detects_and_repairs_value_drift() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("sprints")).unwrap();
    fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Tasks\nviews: []\n",
        )
        .unwrap();
    fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: Sprint\nviews: []\n",
        )
        .unwrap();
    fs::write(
        space.join("tasks/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("sprints/sprint-1.md"),
        "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let diagnostics =
        diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
    assert_eq!(diagnostics.schema_status, RelationTwoWaySchemaStatus::Ok);
    assert_eq!(diagnostics.drift.missing_reverse_count, 1);
    assert_eq!(diagnostics.drift.missing_source_count, 0);

    repair_two_way_relation(
        space.to_str().unwrap(),
        "tasks",
        "Sprint",
        "from_this_side",
        None,
    )
    .unwrap();
    let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Tasks")
            .unwrap()
            .as_sequence()
            .unwrap()
            .first()
            .unwrap()
            .as_str(),
        Some("a.md")
    );

    mutate_frontmatter(&space.join("tasks/a.md"), |meta| {
        meta.extra.remove("Sprint");
        Ok(())
    })
    .unwrap();
    let diagnostics =
        diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
    assert_eq!(diagnostics.drift.missing_reverse_count, 0);
    assert_eq!(diagnostics.drift.missing_source_count, 1);

    repair_two_way_relation(
        space.to_str().unwrap(),
        "tasks",
        "Sprint",
        "from_related_side",
        None,
    )
    .unwrap();
    let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra.get("Sprint").and_then(Value::as_str),
        Some("sprint-1.md")
    );
}

#[tokio::test]
async fn unique_id_and_actor_query_filters_use_numeric_and_multi_semantics() {
    let schema: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Key, type: unique_id, prefix: ISSUE, next: 4 }
  - { name: Owner, type: actor, multiple: false }
  - { name: Reviewers, type: actor, multiple: true }
views: []
"#,
    )
    .unwrap();
    validate_schema(&schema).unwrap();

    let mut display_filter = Filter {
        field: "Key".into(),
        op: FilterOp::Eq,
        value: Some(Value::String("ISSUE-2".into())),
        values: None,
    };
    validate_filter_op(&schema, &display_filter).unwrap();
    normalize_filter_values_for_query(&schema, &mut display_filter).unwrap();
    assert_eq!(
        display_filter.value.as_ref().and_then(unique_id_value),
        Some(2)
    );

    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    for (path, title, fields) in [
        (
            "tasks/a.md",
            "A",
            serde_json::json!({"Key":10,"Owner":"me@example.com","Reviewers":["a@example.com"]}),
        ),
        (
            "tasks/b.md",
            "B",
            serde_json::json!({"Key":2,"Owner":"other@example.com","Reviewers":["me@example.com"]}),
        ),
        (
            "tasks/c.md",
            "C",
            serde_json::json!({"Key":3,"Owner":"me@example.com","Reviewers":["other@example.com"]}),
        ),
        (
            "tasks/d.md",
            "D",
            serde_json::json!({"Key":11,"Owner":"other@example.com","Reviewers":["z@example.com","a@example.com"]}),
        ),
    ] {
        sqlx::query(
            r#"
                INSERT INTO entries (
                    file_path, title, description, created, updated, collection_root_path,
                    in_collection, is_entry_head, fields
                ) VALUES (?, ?, NULL, '2026-01-01', '2026-01-01', 'tasks', 1, 1, ?)
                "#,
        )
        .bind(path)
        .bind(title)
        .bind(fields.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }

    let filters = vec![Filter {
        field: "Reviewers".into(),
        op: FilterOp::Contains,
        value: Some(Value::String("me@example.com".into())),
        values: None,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &filters, &[], None, None)
        .await
        .unwrap();
    let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["B"]);

    let sort = vec![Sort {
        field: "Key".into(),
        desc: false,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &[], &sort, None, None)
        .await
        .unwrap();
    let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["B", "C", "A", "D"]);

    let sort = vec![Sort {
        field: "Reviewers".into(),
        desc: false,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &[], &sort, None, None)
        .await
        .unwrap();
    let titles: Vec<_> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["A", "B", "C", "D"]);
}

#[test]
fn filtered_reorder_inserts_against_visible_positions() {
    let full = vec![
        "a.md".to_string(),
        "hidden-1.md".to_string(),
        "b.md".to_string(),
        "hidden-2.md".to_string(),
        "c.md".to_string(),
    ];
    let visible = vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()];

    let reordered = reorder_visible_entry_names(&full, &visible, "c.md", 1).unwrap();
    assert_eq!(
        reordered,
        vec![
            "a.md".to_string(),
            "hidden-1.md".to_string(),
            "c.md".to_string(),
            "b.md".to_string(),
            "hidden-2.md".to_string(),
        ]
    );

    let reordered = reorder_visible_entry_names(&full, &visible, "a.md", 2).unwrap();
    assert_eq!(
        reordered,
        vec![
            "hidden-1.md".to_string(),
            "b.md".to_string(),
            "hidden-2.md".to_string(),
            "c.md".to_string(),
            "a.md".to_string(),
        ]
    );
}

#[tokio::test]
async fn query_sql_filters_groups_and_sorts_option_indexes() {
    let schema: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - name: Priority
    type: select
    options: [Low, High]
  - name: Status
    type: status
    options:
      - { name: Todo, group: todo }
      - { name: Doing, group: in_progress }
      - { name: Done, group: done }
  - name: Tags
    type: multi_select
    options: [Bug, Feature]
  - name: Due
    type: date
views: []
"#,
    )
    .unwrap();
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    for (path, title, fields) in [
        (
            "tasks/a.md",
            "A",
            serde_json::json!({"Priority":"High","Status":"Doing","Tags":["Feature"],"Due":{"start":"2026-01-10","end":"2026-01-20"}}),
        ),
        (
            "tasks/b.md",
            "B",
            serde_json::json!({"Priority":"Low","Status":"Doing","Tags":["Feature"],"Due":"2026-01-05"}),
        ),
        (
            "tasks/c.md",
            "C",
            serde_json::json!({"Priority":"Unknown","Status":"Doing","Tags":["Feature"],"Due":{"start":"2026-02-01","end":"2026-02-03"}}),
        ),
        (
            "tasks/d.md",
            "D",
            serde_json::json!({"Status":"Doing","Tags":["Feature"]}),
        ),
        (
            "tasks/e.md",
            "E",
            serde_json::json!({"Priority":"Low","Status":"Todo","Tags":["Feature"],"Due":"2025-12-31"}),
        ),
    ] {
        sqlx::query(
            r#"
                INSERT INTO entries (
                    file_path, title, description, created, updated, collection_root_path,
                    in_collection, is_entry_head, fields
                ) VALUES (?, ?, NULL, '2026-01-01', '2026-01-01', 'tasks', 1, 1, ?)
                "#,
        )
        .bind(path)
        .bind(title)
        .bind(fields.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }

    let filters = vec![
        Filter {
            field: "Status".into(),
            op: FilterOp::GroupEq,
            value: Some(Value::String("in_progress".into())),
            values: None,
        },
        Filter {
            field: "Tags".into(),
            op: FilterOp::Contains,
            value: Some(Value::String("Feature".into())),
            values: None,
        },
    ];
    let sort = vec![Sort {
        field: "Priority".into(),
        desc: false,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &filters, &sort, None, None)
        .await
        .unwrap();
    let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["B", "A", "C", "D"]);

    let date_eq = vec![Filter {
        field: "Due".into(),
        op: FilterOp::Eq,
        value: Some(Value::String("2026-01-15".into())),
        values: None,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &date_eq, &[], None, None)
        .await
        .unwrap();
    let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["A"]);

    let date_before = vec![Filter {
        field: "Due".into(),
        op: FilterOp::Before,
        value: Some(Value::String("2026-01-06".into())),
        values: None,
    }];
    let title_sort = vec![Sort {
        field: "title".into(),
        desc: false,
    }];
    let rows = query_entry_rows(
        &pool,
        &schema,
        "tasks",
        &date_before,
        &title_sort,
        None,
        None,
    )
    .await
    .unwrap();
    let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["B", "E"]);

    let date_after = vec![Filter {
        field: "Due".into(),
        op: FilterOp::After,
        value: Some(Value::String("2026-01-31".into())),
        values: None,
    }];
    let rows = query_entry_rows(&pool, &schema, "tasks", &date_after, &[], None, None)
        .await
        .unwrap();
    let titles: Vec<String> = rows.into_iter().map(|row| row.title).collect();
    assert_eq!(titles, vec!["C"]);
}

#[tokio::test]
async fn boolean_query_uses_effective_false_for_missing_and_null() {
    let schema: CollectionSchema =
        serde_yml::from_str("columns:\n  - { name: Active, type: boolean }\nviews: []\n").unwrap();
    validate_schema(&schema).unwrap();
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(
        r#"
            CREATE TABLE entries (
                file_path TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                created TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_entry_head INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    for (path, title, fields) in [
        ("tasks/true.md", "True", serde_json::json!({"Active": true})),
        (
            "tasks/false.md",
            "False",
            serde_json::json!({"Active": false}),
        ),
        ("tasks/missing.md", "Missing", serde_json::json!({})),
        ("tasks/null.md", "Null", serde_json::json!({"Active": null})),
        (
            "tasks/invalid.md",
            "Invalid",
            serde_json::json!({"Active": "false"}),
        ),
    ] {
        sqlx::query(
            r#"
                INSERT INTO entries (
                    file_path, title, description, created, updated, collection_root_path,
                    in_collection, is_entry_head, fields
                ) VALUES (?, ?, NULL, '2026-01-01', '2026-01-01', 'tasks', 1, 1, ?)
                "#,
        )
        .bind(path)
        .bind(title)
        .bind(fields.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }

    for (op, value, expected) in [
        (FilterOp::Eq, false, vec!["False", "Missing", "Null"]),
        (FilterOp::Neq, true, vec!["False", "Missing", "Null"]),
        (FilterOp::Eq, true, vec!["True"]),
        (FilterOp::Neq, false, vec!["True"]),
    ] {
        let rows = query_entry_rows(
            &pool,
            &schema,
            "tasks",
            &[Filter {
                field: "Active".into(),
                op,
                value: Some(Value::Bool(value)),
                values: None,
            }],
            &[Sort {
                field: "title".into(),
                desc: false,
            }],
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            rows.into_iter().map(|row| row.title).collect::<Vec<_>>(),
            expected
        );
    }

    for (desc, expected) in [
        (false, vec!["False", "Missing", "Null", "True", "Invalid"]),
        (true, vec!["True", "False", "Missing", "Null", "Invalid"]),
    ] {
        let rows = query_entry_rows(
            &pool,
            &schema,
            "tasks",
            &[],
            &[
                Sort {
                    field: "Active".into(),
                    desc,
                },
                Sort {
                    field: "title".into(),
                    desc: false,
                },
            ],
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            rows.into_iter().map(|row| row.title).collect::<Vec<_>>(),
            expected
        );
    }
}

#[test]
fn standalone_relation_move_checks_both_owners_nested_capabilities_and_space_boundaries() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_test_space_config(
        root,
        Some(vec![SpaceRef {
            id: "child".into(),
            path: "spaces/child".into(),
            repo: None,
        }]),
        None,
    );
    fs::create_dir_all(root.join("plain/sub")).unwrap();
    fs::create_dir_all(root.join("collection")).unwrap();
    fs::write(root.join("plain/README.md"), "Head").unwrap();
    fs::write(root.join("plain/sub/page.md"), "Body").unwrap();
    fs::write(root.join("collection/schema.yaml"), "columns: [").unwrap();
    assert!(!relation_move_may_affect_collections(root, "plain", "renamed").unwrap());
    assert!(
        relation_move_may_affect_collections(root, "plain/sub/page.md", "collection/page.md")
            .unwrap()
    );
    assert!(
        relation_move_may_affect_collections(root, "collection/page.md", "plain/page.md").unwrap()
    );
    for (old, new) in [
        ("spaces", "moved"),
        ("plain", "spaces/child"),
        ("spaces/child/page.md", "page.md"),
    ] {
        assert!(relation_move_may_affect_collections(root, old, new).unwrap());
    }
    fs::write(root.join("plain/sub/schema.yaml"), "columns: [").unwrap();
    assert!(relation_move_may_affect_collections(root, "plain", "renamed").unwrap());
    fs::rename(root.join("plain"), root.join("renamed")).unwrap();
    assert!(relation_move_may_affect_collections(root, "plain", "renamed").unwrap());
    fs::write(root.join("schema.yaml"), "columns: [").unwrap();
    assert!(relation_move_may_affect_collections(root, "a.md", "b.md").unwrap());
}
