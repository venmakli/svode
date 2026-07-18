use super::*;
use crate::space::config::write_space_config;
use crate::space::types::{SpaceConfig, SpaceRef, TreeSpaceConfig};
use tempfile::TempDir;

fn test_column(name: &str, type_: PropertyType) -> Column {
    Column {
        name: name.into(),
        type_,
        sensitivity: None,
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
        relation: None,
        relation_scope: None,
        limit: None,
        two_way: None,
        prefix: None,
        next: None,
        multiple: None,
    }
}

fn write_test_space_config(
    space: &Path,
    spaces: Option<Vec<SpaceRef>>,
    tree: Option<TreeSpaceConfig>,
) {
    write_space_config(
        space,
        &SpaceConfig {
            name: "Test".to_string(),
            description: String::new(),
            icon: "folder".to_string(),
            spaces,
            agent: None,
            defaults: None,
            git: None,
            assets: None,
            tree,
        },
    )
    .unwrap();
}

#[test]
fn schema_roundtrips_utf8_names_and_mixed_options() {
    let raw = r#"
columns:
  - name: "Статус"
    type: status
    default: "В работе"
    options:
      - { name: "Сделать", group: todo, color: blue }
      - { name: "В работе", group: in_progress, color: yellow }
      - { name: "Готово", group: done, color: green }
  - name: "Метки"
    type: multi_select
    options:
      - "Баг"
      - { name: "Фича", color: purple, icon: "▶" }
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    validate_schema(&schema).unwrap();
    assert_eq!(schema.columns[0].name, "Статус");
    assert_eq!(schema.columns[1].options.as_ref().unwrap()[0].name, "Баг");

    let serialized = serde_yml::to_string(&schema).unwrap();
    let parsed: CollectionSchema = serde_yml::from_str(&serialized).unwrap();
    assert_eq!(parsed.columns[0].name, "Статус");
    assert_eq!(parsed.columns[1].options.as_ref().unwrap()[1].name, "Фича");
}

#[test]
fn relation_schema_roundtrips_yaml_shape() {
    let raw = r#"
columns:
  - name: Sprint
    type: relation
    relation: sprints
    limit: one
    two_way: Tasks
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    validate_schema(&schema).unwrap();
    let column = &schema.columns[0];
    assert_eq!(column.type_, PropertyType::Relation);
    assert_eq!(column.relation.as_deref(), Some("sprints"));
    assert_eq!(column.limit, Some(RelationLimit::One));
    assert_eq!(column.two_way.as_deref(), Some("Tasks"));

    let serialized = serde_yml::to_string(&schema).unwrap();
    assert!(serialized.contains("type: relation"));
    assert!(serialized.contains("relation: sprints"));
    assert!(serialized.contains("limit: one"));
    assert!(serialized.contains("two_way: Tasks"));
}

#[test]
fn scoped_relation_schema_roundtrips_yaml_shape() {
    let raw = r#"
columns:
  - name: Project task
    type: relation
    relation: tasks
    relation_scope: root
  - name: Space decision
    type: relation
    relation: decisions
    relation_scope:
      type: space
      id: design
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    validate_schema(&schema).unwrap();
    assert_eq!(schema.columns[0].relation_scope, Some(RelationScope::Root));
    assert_eq!(
        schema.columns[1].relation_scope,
        Some(RelationScope::Space {
            id: "design".to_string()
        })
    );

    let serialized = serde_yml::to_string(&schema).unwrap();
    assert!(serialized.contains("relation_scope: root"));
    assert!(serialized.contains("type: space"));
    assert!(serialized.contains("id: design"));
}

#[test]
fn scoped_relation_update_validates_targets_in_root_and_space() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let child = root.join("spaces/design");
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(root.join("roadmap")).unwrap();
    fs::create_dir_all(child.join("decisions")).unwrap();
    write_test_space_config(
        root,
        Some(vec![SpaceRef {
            id: "design".to_string(),
            path: "spaces/design".to_string(),
            repo: None,
        }]),
        None,
    );
    write_test_space_config(&child, None, None);
    fs::write(root.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(root.join("roadmap/schema.yaml"), "columns:\n  - name: Decision\n    type: relation\n    relation: decisions\n    relation_scope:\n      type: space\n      id: design\nviews: []\n").unwrap();
    fs::write(child.join("decisions/schema.yaml"), "columns:\n  - name: Task\n    type: relation\n    relation: tasks\n    relation_scope: root\nviews: []\n").unwrap();
    fs::write(
        root.join("tasks/task-1.md"),
        "---\ntitle: Task 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        root.join("roadmap/item-1.md"),
        "---\ntitle: Roadmap item\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        child.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let updated_child = update_relation_entry_field(
        child.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Task",
        Value::String("task-1.md".to_string()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        updated_child
            .meta
            .extra
            .get("Task")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("task-1.md")
    );

    let updated_root = update_relation_entry_field(
        root.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "roadmap/item-1.md",
        "Decision",
        Value::String("decision-1.md".to_string()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        updated_root
            .meta
            .extra
            .get("Decision")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("decision-1.md")
    );

    assert!(
        update_relation_entry_field(
            child.to_str().unwrap(),
            Some(root.to_str().unwrap()),
            "decisions/decision-1.md",
            "Task",
            Value::String("missing.md".to_string()),
        )
        .is_err()
    );
}

#[test]
fn cross_scope_two_way_root_to_space_materializes_and_syncs_reverse() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let child = root.join("spaces/design");
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(child.join("decisions")).unwrap();
    write_test_space_config(
        root,
        Some(vec![SpaceRef {
            id: "design".to_string(),
            path: "spaces/design".to_string(),
            repo: None,
        }]),
        None,
    );
    write_test_space_config(&child, None, None);
    fs::write(root.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        child.join("decisions/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        root.join("tasks/a.md"),
        "---\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        child.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let mut column = test_column("Decision", PropertyType::Relation);
    column.relation = Some("decisions".to_string());
    column.relation_scope = Some(RelationScope::Space {
        id: "design".to_string(),
    });
    column.two_way = Some("Tasks".to_string());
    add_schema_column_with_project(
        root.to_str().unwrap(),
        "tasks",
        column,
        Some(root.to_str().unwrap()),
    )
    .unwrap();

    let reverse_schema = read_collection_schema(child.to_str().unwrap(), "decisions").unwrap();
    let reverse = reverse_schema
        .columns
        .iter()
        .find(|column| column.name == "Tasks")
        .unwrap();
    assert_eq!(reverse.relation.as_deref(), Some("tasks"));
    assert_eq!(reverse.relation_scope, Some(RelationScope::Root));
    assert_eq!(reverse.two_way.as_deref(), Some("Decision"));

    update_relation_entry_field(
        root.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "tasks/a.md",
        "Decision",
        Value::String("decision-1.md".to_string()),
    )
    .unwrap();
    let raw = fs::read_to_string(child.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Tasks")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("a.md")
    );

    let diagnostics = diagnose_two_way_relation_with_project(
        root.to_str().unwrap(),
        "tasks",
        "Decision",
        Some(root.to_str().unwrap()),
    )
    .unwrap();
    assert_eq!(diagnostics.schema_status, RelationTwoWaySchemaStatus::Ok);
    assert_eq!(diagnostics.drift.missing_reverse_count, 0);
    assert_eq!(diagnostics.drift.missing_source_count, 0);

    update_relation_entry_field(
        child.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Tasks",
        serde_yml::to_value(Vec::<String>::new()).unwrap(),
    )
    .unwrap();
    let raw = fs::read_to_string(root.join("tasks/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Decision"));
}

#[test]
fn cross_scope_two_way_space_to_root_materializes_and_syncs_reverse() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let child = root.join("spaces/design");
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(child.join("decisions")).unwrap();
    write_test_space_config(
        root,
        Some(vec![SpaceRef {
            id: "design".to_string(),
            path: "spaces/design".to_string(),
            repo: None,
        }]),
        None,
    );
    write_test_space_config(&child, None, None);
    fs::write(root.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        child.join("decisions/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        root.join("tasks/a.md"),
        "---\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        child.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let mut column = test_column("Task", PropertyType::Relation);
    column.relation = Some("tasks".to_string());
    column.relation_scope = Some(RelationScope::Root);
    column.two_way = Some("Decisions".to_string());
    add_schema_column_with_project(
        child.to_str().unwrap(),
        "decisions",
        column,
        Some(root.to_str().unwrap()),
    )
    .unwrap();

    let reverse_schema = read_collection_schema(root.to_str().unwrap(), "tasks").unwrap();
    let reverse = reverse_schema
        .columns
        .iter()
        .find(|column| column.name == "Decisions")
        .unwrap();
    assert_eq!(reverse.relation.as_deref(), Some("decisions"));
    assert_eq!(
        reverse.relation_scope,
        Some(RelationScope::Space {
            id: "design".to_string()
        })
    );
    assert_eq!(reverse.two_way.as_deref(), Some("Task"));

    update_relation_entry_field(
        child.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Task",
        Value::String("a.md".to_string()),
    )
    .unwrap();
    let raw = fs::read_to_string(root.join("tasks/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Decisions")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("decision-1.md")
    );

    update_relation_entry_field(
        root.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "tasks/a.md",
        "Decisions",
        serde_yml::to_value(Vec::<String>::new()).unwrap(),
    )
    .unwrap();
    let raw = fs::read_to_string(child.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Task"));

    update_relation_entry_field(
        child.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Task",
        Value::String("a.md".to_string()),
    )
    .unwrap();
    fs::rename(root.join("tasks/a.md"), root.join("tasks/b.md")).unwrap();
    rewrite_relation_paths_for_move_with_project(
        root.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "tasks/a.md",
        "tasks/b.md",
    )
    .unwrap();
    let raw = fs::read_to_string(child.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Task")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("b.md")
    );
    entry::delete_with_project(
        root.to_str().unwrap(),
        "tasks/b.md",
        None,
        Some(root.to_str().unwrap()),
    )
    .unwrap();
    let raw = fs::read_to_string(child.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Task"));
}

#[test]
fn cross_scope_two_way_rejects_child_to_sibling_space() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let design = root.join("spaces/design");
    let engineering = root.join("spaces/engineering");
    fs::create_dir_all(design.join("decisions")).unwrap();
    fs::create_dir_all(engineering.join("tasks")).unwrap();
    write_test_space_config(
        root,
        Some(vec![
            SpaceRef {
                id: "design".to_string(),
                path: "spaces/design".to_string(),
                repo: None,
            },
            SpaceRef {
                id: "engineering".to_string(),
                path: "spaces/engineering".to_string(),
                repo: None,
            },
        ]),
        None,
    );
    write_test_space_config(&design, None, None);
    write_test_space_config(&engineering, None, None);
    fs::write(
        design.join("decisions/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        engineering.join("tasks/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();

    let mut column = test_column("Engineering task", PropertyType::Relation);
    column.relation = Some("tasks".to_string());
    column.relation_scope = Some(RelationScope::Space {
        id: "engineering".to_string(),
    });
    column.two_way = Some("Decisions".to_string());

    let error = add_schema_column_with_project(
        design.to_str().unwrap(),
        "decisions",
        column,
        Some(root.to_str().unwrap()),
    )
    .unwrap_err();

    assert!(error.to_string().contains("sibling spaces"));
    let source_schema = read_collection_schema(design.to_str().unwrap(), "decisions").unwrap();
    assert!(source_schema.columns.is_empty());
    let target_schema = read_collection_schema(engineering.to_str().unwrap(), "tasks").unwrap();
    assert!(target_schema.columns.is_empty());

    fs::write(
            design.join("decisions/schema.yaml"),
            "columns:\n  - name: Engineering task\n    type: relation\n    relation: tasks\n    relation_scope:\n      type: space\n      id: engineering\n    two_way: Decisions\nviews: []\n",
        )
        .unwrap();
    fs::write(
        design.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        engineering.join("tasks/task-1.md"),
        "---\ntitle: Task 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let error = update_relation_entry_field(
        design.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Engineering task",
        Value::String("task-1.md".to_string()),
    )
    .unwrap_err();

    assert!(error.to_string().contains("sibling spaces"));
    let raw = fs::read_to_string(engineering.join("tasks/task-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Decisions"));
}

#[test]
fn cross_scope_one_way_child_to_sibling_space_updates_without_reverse_sync() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let design = root.join("spaces/design");
    let engineering = root.join("spaces/engineering");
    fs::create_dir_all(design.join("decisions")).unwrap();
    fs::create_dir_all(engineering.join("tasks")).unwrap();
    write_test_space_config(
        root,
        Some(vec![
            SpaceRef {
                id: "design".to_string(),
                path: "spaces/design".to_string(),
                repo: None,
            },
            SpaceRef {
                id: "engineering".to_string(),
                path: "spaces/engineering".to_string(),
                repo: None,
            },
        ]),
        None,
    );
    write_test_space_config(&design, None, None);
    write_test_space_config(&engineering, None, None);
    fs::write(
        design.join("decisions/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        engineering.join("tasks/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        design.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        engineering.join("tasks/task-1.md"),
        "---\ntitle: Task 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let mut column = test_column("Engineering task", PropertyType::Relation);
    column.relation = Some("tasks".to_string());
    column.relation_scope = Some(RelationScope::Space {
        id: "engineering".to_string(),
    });
    add_schema_column_with_project(
        design.to_str().unwrap(),
        "decisions",
        column,
        Some(root.to_str().unwrap()),
    )
    .unwrap();

    update_relation_entry_field(
        design.to_str().unwrap(),
        Some(root.to_str().unwrap()),
        "decisions/decision-1.md",
        "Engineering task",
        Value::String("task-1.md".to_string()),
    )
    .unwrap();

    let raw = fs::read_to_string(design.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Engineering task")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("task-1.md")
    );
    let raw = fs::read_to_string(engineering.join("tasks/task-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Decisions"));
}

#[test]
fn sensitivity_defaults_phone_email_and_preserves_explicit_none() {
    let mut schema: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Email, type: email }
  - { name: Phone, type: phone }
  - { name: PublicPhone, type: phone, sensitivity: none }
  - { name: Owner, type: actor }
  - { name: Notes, type: text }
views: []
"#,
    )
    .unwrap();

    normalize_schema(&mut schema);

    assert_eq!(schema.columns[0].sensitivity, Some(ColumnSensitivity::Pii));
    assert_eq!(schema.columns[1].sensitivity, Some(ColumnSensitivity::Pii));
    assert_eq!(schema.columns[2].sensitivity, Some(ColumnSensitivity::None));
    assert_eq!(
        column_effective_sensitivity(&schema.columns[2]),
        ColumnSensitivity::None
    );
    assert_eq!(schema.columns[3].sensitivity, None);
    assert_eq!(
        column_effective_sensitivity(&schema.columns[3]),
        ColumnSensitivity::None
    );
    assert_eq!(schema.columns[4].sensitivity, None);
    assert!(schema_has_sensitive_columns(&schema));
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

#[test]
fn copy_rewrite_updates_internal_relation_values_in_same_collection() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks/folder")).unwrap();
    fs::create_dir_all(space.join("tasks/folder-copy")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Related\n    type: relation\n    relation: tasks\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/folder/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nRelated:\n  - folder/b.md\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/folder/b.md"),
        "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/folder-copy/a.md"),
        "---\nid: a2\ntitle: A copy\ncreated: now\nupdated: now\nRelated:\n  - folder/b.md\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/folder-copy/b.md"),
        "---\nid: b2\ntitle: B copy\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    rewrite_internal_relation_refs_for_copy(
        space.to_str().unwrap(),
        "tasks/folder",
        "tasks/folder-copy",
    )
    .unwrap();

    let raw = fs::read_to_string(space.join("tasks/folder-copy/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    let related = meta.extra.get("Related").unwrap().as_sequence().unwrap();
    assert_eq!(related[0].as_str(), Some("folder-copy/b.md"));
}

#[test]
fn move_rewrite_updates_descendant_relation_values_in_same_collection() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks/folder/sub")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Related\n    type: relation\n    relation: tasks\nviews: []\n",
    )
    .unwrap();
    fs::write(
            space.join("tasks/links.md"),
            "---\nid: links\ntitle: Links\ncreated: now\nupdated: now\nRelated:\n  - folder/a.md\n  - folder/sub/b.md\n---\n",
        )
        .unwrap();
    fs::write(
        space.join("tasks/folder/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/folder/sub/b.md"),
        "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::rename(space.join("tasks/folder"), space.join("tasks/moved")).unwrap();

    rewrite_relation_paths_for_move(space.to_str().unwrap(), "tasks/folder", "tasks/moved")
        .unwrap();

    let raw = fs::read_to_string(space.join("tasks/links.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    let related: Vec<_> = meta
        .extra
        .get("Related")
        .unwrap()
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(related, vec!["moved/a.md", "moved/sub/b.md"]);
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
fn change_schema_type_to_relation_preserves_unconverted_values_as_orphan_extra() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("sprints")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Sprint\n    type: text\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("sprints/schema.yaml"),
        "columns: []\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("sprints/sprint-1.md"),
        "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\nSprint: sprint-1.md\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/b.md"),
        "---\nid: b\ntitle: B\ncreated: now\nupdated: now\nSprint: missing.md\n---\n",
    )
    .unwrap();
    fs::write(
            space.join("tasks/c.md"),
            "---\nid: c\ntitle: C\ncreated: now\nupdated: now\nSprint:\n  - sprint-1.md\n  - missing-2.md\n---\n",
        )
        .unwrap();

    let strategy: Value = serde_yml::from_str("relation: sprints\nlimit: one\n").unwrap();
    let (schema, warnings) = change_schema_type_with_warnings(
        space.to_str().unwrap(),
        "tasks",
        "Sprint",
        PropertyType::Relation,
        Some(strategy),
    )
    .unwrap();

    assert_eq!(schema.columns[0].type_, PropertyType::Relation);
    assert_eq!(schema.columns[0].relation.as_deref(), Some("sprints"));
    assert_eq!(schema.columns[0].limit, Some(RelationLimit::One));
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].code, "relation_unconverted_values");
    assert_eq!(warnings[0].field, "Sprint (unconverted)");
    assert_eq!(warnings[0].count, 2);

    let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra.get("Sprint").and_then(Value::as_str),
        Some("sprint-1.md")
    );
    assert!(!meta.extra.contains_key("Sprint (unconverted)"));

    let raw = fs::read_to_string(space.join("tasks/b.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert!(!meta.extra.contains_key("Sprint"));
    assert_eq!(
        meta.extra
            .get("Sprint (unconverted)")
            .and_then(Value::as_str),
        Some("missing.md")
    );

    let raw = fs::read_to_string(space.join("tasks/c.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra.get("Sprint").and_then(Value::as_str),
        Some("sprint-1.md")
    );
    assert_eq!(
        meta.extra
            .get("Sprint (unconverted)")
            .and_then(Value::as_str),
        Some("missing-2.md")
    );
}

#[test]
fn change_schema_type_to_scoped_relation_converts_against_target_space() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let child = root.join("spaces/design");
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(child.join("decisions")).unwrap();
    write_test_space_config(
        root,
        Some(vec![SpaceRef {
            id: "design".to_string(),
            path: "spaces/design".to_string(),
            repo: None,
        }]),
        None,
    );
    write_test_space_config(&child, None, None);
    fs::write(root.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        child.join("decisions/schema.yaml"),
        "columns:\n  - name: Task\n    type: text\nviews: []\n",
    )
    .unwrap();
    fs::write(
        root.join("tasks/task-1.md"),
        "---\ntitle: Task 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        child.join("decisions/decision-1.md"),
        "---\ntitle: Decision 1\ncreated: now\nupdated: now\nTask: task-1.md\n---\n",
    )
    .unwrap();

    let strategy: Value = serde_yml::from_str("relation: tasks\nrelation_scope: root\n").unwrap();
    let (schema, warnings) = change_schema_type_with_warnings_and_project(
        child.to_str().unwrap(),
        "decisions",
        "Task",
        PropertyType::Relation,
        Some(strategy),
        Some(root.to_str().unwrap()),
    )
    .unwrap();

    assert_eq!(schema.columns[0].type_, PropertyType::Relation);
    assert_eq!(schema.columns[0].relation.as_deref(), Some("tasks"));
    assert_eq!(schema.columns[0].relation_scope, Some(RelationScope::Root));
    assert!(warnings.is_empty());

    let raw = fs::read_to_string(child.join("decisions/decision-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Task")
            .and_then(Value::as_sequence)
            .and_then(|values| values.first())
            .and_then(Value::as_str),
        Some("task-1.md")
    );
    assert!(!meta.extra.contains_key("Task (unconverted)"));
}

#[test]
fn two_way_relation_rejects_limit_one_reverse_column() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("sprints")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
            space.join("sprints/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    limit: one\nviews: []\n",
        )
        .unwrap();

    let column = Column {
        name: "Sprint".into(),
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
        relation: Some("sprints".into()),
        relation_scope: None,
        limit: None,
        two_way: Some("Tasks".into()),
        prefix: None,
        next: None,
        multiple: None,
    };

    assert!(add_schema_column(space.to_str().unwrap(), "tasks", column).is_err());
}

#[test]
fn two_way_relation_diagnoses_and_creates_missing_reverse_column() {
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
        "columns: []\nviews: []\n",
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
    assert_eq!(
        diagnostics.schema_status,
        RelationTwoWaySchemaStatus::MissingReverse
    );
    assert_eq!(diagnostics.reverse_column.as_deref(), Some("Tasks"));

    repair_two_way_relation(
        space.to_str().unwrap(),
        "tasks",
        "Sprint",
        "create_reverse_column",
        Some("Tasks"),
    )
    .unwrap();

    let source_schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
    let reverse_schema = read_collection_schema(space.to_str().unwrap(), "sprints").unwrap();
    assert_eq!(source_schema.columns[0].two_way.as_deref(), Some("Tasks"));
    let reverse = reverse_schema
        .columns
        .iter()
        .find(|column| column.name == "Tasks")
        .unwrap();
    assert_eq!(reverse.type_, PropertyType::Relation);
    assert_eq!(reverse.relation.as_deref(), Some("tasks"));
    assert_eq!(reverse.two_way.as_deref(), Some("Sprint"));

    let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    let tasks: Vec<_> = meta
        .extra
        .get("Tasks")
        .unwrap()
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(tasks, vec!["a.md"]);

    let diagnostics =
        diagnose_two_way_relation(space.to_str().unwrap(), "tasks", "Sprint").unwrap();
    assert_eq!(diagnostics.schema_status, RelationTwoWaySchemaStatus::Ok);
    assert_eq!(diagnostics.drift.missing_reverse_count, 0);
    assert_eq!(diagnostics.drift.missing_source_count, 0);
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

#[test]
fn two_way_relation_reverse_side_update_allows_paired_limit_one() {
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
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("sprints/sprint-1.md"),
        "---\nid: s1\ntitle: Sprint 1\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("sprints/sprint-2.md"),
        "---\nid: s2\ntitle: Sprint 2\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    update_relation_entry_field(
        space.to_str().unwrap(),
        None,
        "sprints/sprint-1.md",
        "Tasks",
        serde_yml::to_value(vec!["a.md"]).unwrap(),
    )
    .unwrap();

    let raw = fs::read_to_string(space.join("tasks/a.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra.get("Sprint").and_then(Value::as_str),
        Some("sprint-1.md")
    );

    let conflict = update_relation_entry_field(
        space.to_str().unwrap(),
        None,
        "sprints/sprint-2.md",
        "Tasks",
        serde_yml::to_value(vec!["a.md"]).unwrap(),
    );
    assert!(conflict.is_err());
}

#[test]
fn two_way_relation_can_choose_compatible_reverse_column() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("sprints")).unwrap();
    fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n    limit: one\n    two_way: Missing\nviews: []\n",
        )
        .unwrap();
    fs::write(
        space.join("sprints/schema.yaml"),
        "columns:\n  - name: Work\n    type: relation\n    relation: tasks\nviews: []\n",
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
    assert_eq!(
        diagnostics.schema_status,
        RelationTwoWaySchemaStatus::MissingReverse
    );
    assert_eq!(diagnostics.compatible_reverse_choices[0].name, "Work");

    repair_two_way_relation(
        space.to_str().unwrap(),
        "tasks",
        "Sprint",
        "choose_reverse_column",
        Some("Work"),
    )
    .unwrap();

    let source_schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
    let reverse_schema = read_collection_schema(space.to_str().unwrap(), "sprints").unwrap();
    assert_eq!(source_schema.columns[0].two_way.as_deref(), Some("Work"));
    assert_eq!(reverse_schema.columns[0].two_way.as_deref(), Some("Sprint"));

    let raw = fs::read_to_string(space.join("sprints/sprint-1.md")).unwrap();
    let (meta, _) = frontmatter::try_parse(&raw).unwrap().unwrap();
    assert_eq!(
        meta.extra
            .get("Work")
            .unwrap()
            .as_sequence()
            .unwrap()
            .first()
            .unwrap()
            .as_str(),
        Some("a.md")
    );
}

#[test]
fn copy_rewrite_updates_relation_schema_roots_inside_copied_tree() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("source/a")).unwrap();
    fs::create_dir_all(space.join("source/b")).unwrap();
    fs::create_dir_all(space.join("copy/a")).unwrap();
    fs::create_dir_all(space.join("copy/b")).unwrap();
    fs::write(
        space.join("source/a/schema.yaml"),
        "columns:\n  - name: B\n    type: relation\n    relation: source/b\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("source/b/schema.yaml"),
        "columns:\n  - name: A\n    type: relation\n    relation: source/a\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("copy/a/schema.yaml"),
        "columns:\n  - name: B\n    type: relation\n    relation: source/b\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("copy/b/schema.yaml"),
        "columns:\n  - name: A\n    type: relation\n    relation: source/a\nviews: []\n",
    )
    .unwrap();

    rewrite_internal_relation_refs_for_copy(space.to_str().unwrap(), "source", "copy").unwrap();

    let schema_a = read_collection_schema(space.to_str().unwrap(), "copy/a").unwrap();
    let schema_b = read_collection_schema(space.to_str().unwrap(), "copy/b").unwrap();
    assert_eq!(schema_a.columns[0].relation.as_deref(), Some("copy/b"));
    assert_eq!(schema_b.columns[0].relation.as_deref(), Some("copy/a"));
}

#[test]
fn schema_validation_rejects_reserved_duplicates_and_bad_status() {
    let duplicate = r#"
columns:
  - { name: title, type: text }
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(duplicate).unwrap();
    assert!(validate_schema(&schema).is_err());

    let bad_status = r#"
columns:
  - name: Status
    type: status
    options: ["Todo"]
views: []
"#;
    let schema: CollectionSchema = serde_yml::from_str(bad_status).unwrap();
    assert!(validate_schema(&schema).is_err());
}

#[test]
fn unique_id_and_actor_schema_shape_validate_and_normalize() {
    let raw = r#"
columns:
  - name: Key
    type: unique_id
    prefix: " ISSUE "
    next: 7
  - name: Assignee
    type: actor
    multiple: false
  - name: Reviewers
    type: actor
    multiple: true
views: []
"#;
    let mut schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    normalize_schema(&mut schema);
    validate_schema(&schema).unwrap();
    assert_eq!(schema.columns[0].prefix.as_deref(), Some("ISSUE"));
    assert_eq!(schema.columns[1].multiple, Some(false));
    assert_eq!(schema.columns[2].multiple, Some(true));

    let hyphen_prefix: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Key, type: unique_id, prefix: "ISSUE-KEY", next: 1 }
views: []
"#,
    )
    .unwrap();
    validate_schema(&hyphen_prefix).unwrap();

    let bad_prefix: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Key, type: unique_id, prefix: "ISSUE KEY", next: 1 }
views: []
"#,
    )
    .unwrap();
    assert!(validate_schema(&bad_prefix).is_err());

    let duplicate_unique_id: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Key, type: unique_id, next: 1 }
  - { name: Other, type: unique_id, next: 2 }
views: []
"#,
    )
    .unwrap();
    assert!(validate_schema(&duplicate_unique_id).is_err());

    let mut actor_schema: CollectionSchema = serde_yml::from_str(
        r#"
columns:
  - { name: Owner, type: actor }
views: []
"#,
    )
    .unwrap();
    normalize_schema(&mut actor_schema);
    assert_eq!(actor_schema.columns[0].type_, PropertyType::Actor);
    assert_eq!(actor_schema.columns[0].multiple, Some(false));
}

#[test]
fn add_unique_id_materializes_existing_rows_and_sets_next() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join(".svode")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join(".svode/order.json"),
        r#"{"tasks":["b.md","a.md"]}"#,
    )
    .unwrap();
    fs::write(
        space.join("tasks/a.md"),
        "---\nid: a\ntitle: A\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/b.md"),
        "---\nid: b\ntitle: B\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();

    let mut column = test_column("Key", PropertyType::UniqueId);
    column.prefix = Some("ISSUE".into());
    let schema = add_schema_column(space.to_str().unwrap(), "tasks", column).unwrap();
    assert_eq!(schema.columns[0].next, Some(3));

    let b = entry::read(space.to_str().unwrap(), "tasks/b.md").unwrap();
    let a = entry::read(space.to_str().unwrap(), "tasks/a.md").unwrap();
    assert_eq!(b.meta.extra.get("Key").and_then(unique_id_value), Some(1));
    assert_eq!(a.meta.extra.get("Key").and_then(unique_id_value), Some(2));
}

#[test]
fn unique_id_create_delete_duplicate_and_repair_do_not_reuse_numbers() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Key\n    type: unique_id\n    prefix: ISSUE\n    next: 1\nviews: []\n",
    )
    .unwrap();

    let first = entry::create(space.to_str().unwrap(), Some("tasks"), "First").unwrap();
    assert_eq!(
        first.meta.extra.get("Key").and_then(unique_id_value),
        Some(1)
    );
    fs::remove_file(space.join(&first.path)).unwrap();
    let second = entry::create(space.to_str().unwrap(), Some("tasks"), "Second").unwrap();
    assert_eq!(
        second.meta.extra.get("Key").and_then(unique_id_value),
        Some(2)
    );

    let duplicated = entry::duplicate_entry(space, &second.path).unwrap();
    assert_eq!(
        duplicated.meta.extra.get("Key").and_then(unique_id_value),
        Some(3)
    );

    let schema = read_collection_schema(space.to_str().unwrap(), "tasks").unwrap();
    assert_eq!(schema.columns[0].next, Some(4));

    mutate_frontmatter(&space.join(&duplicated.path), |meta| {
        meta.extra.insert("Key".into(), yaml_u64(2));
        Ok(())
    })
    .unwrap();
    let repaired = assign_unique_id(space.to_str().unwrap(), &duplicated.path).unwrap();
    assert_eq!(
        repaired.meta.extra.get("Key").and_then(unique_id_value),
        Some(4)
    );
    let schema = normalize_unique_id_counter(space.to_str().unwrap(), "tasks").unwrap();
    assert_eq!(schema.columns[0].next, Some(5));
}

#[test]
fn unique_id_update_is_readonly_and_actor_values_are_normalized() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, next: 1 }\n  - { name: Owner, type: actor, multiple: false }\n  - { name: Reviewers, type: actor, multiple: true }\nviews: []\n",
        )
        .unwrap();
    let created = entry::create(space.to_str().unwrap(), Some("tasks"), "Task").unwrap();

    assert!(
        entry::update_field(
            space.to_str().unwrap(),
            None,
            &created.path,
            "Key",
            serde_json::json!(99),
        )
        .is_err()
    );

    let updated = entry::update_field(
        space.to_str().unwrap(),
        None,
        &created.path,
        "Owner",
        serde_json::json!(" ME@EXAMPLE.COM "),
    )
    .unwrap();
    assert_eq!(
        updated.meta.extra.get("Owner").and_then(Value::as_str),
        Some("me@example.com")
    );

    let updated = entry::update_field(
        space.to_str().unwrap(),
        None,
        &created.path,
        "Reviewers",
        serde_json::json!(["A@Example.com", "a@example.com", "bad value"]),
    )
    .unwrap();
    let reviewers: Vec<_> = updated
        .meta
        .extra
        .get("Reviewers")
        .unwrap()
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(reviewers, vec!["a@example.com", "bad value"]);
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
fn resolver_uses_readme_parent_exception() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks/sub")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        "columns:\n  - name: Priority\n    type: text\nviews: []\n",
    )
    .unwrap();
    fs::write(
        space.join("tasks/sub/schema.yaml"),
        "columns:\n  - name: Inner\n    type: text\nviews: []\n",
    )
    .unwrap();

    let (_, root) =
        resolve_collection_schema_result(space.to_str().unwrap(), "tasks/sub/README.md")
            .unwrap()
            .unwrap();
    assert_eq!(root, PathBuf::from("tasks"));

    let (_, root) = resolve_collection_schema_result(space.to_str().unwrap(), "tasks/sub/item.md")
        .unwrap()
        .unwrap();
    assert_eq!(root, PathBuf::from("tasks/sub"));
}

#[test]
fn date_range_must_be_homogeneous() {
    let column = Column {
        name: "Due".into(),
        type_: PropertyType::Date,
        sensitivity: None,
        default: None,
        options: None,
        display: None,
        min: None,
        max: None,
        color: None,
        time_by_default: None,
        range_by_default: None,
        relation: None,
        relation_scope: None,
        limit: None,
        two_way: None,
        prefix: None,
        next: None,
        multiple: None,
    };
    let ok: Value = serde_yml::from_str("start: 2026-04-20\nend: 2026-04-22\n").unwrap();
    validate_property_value(&column, &ok).unwrap();

    let bad: Value = serde_yml::from_str("start: 2026-04-20T09:00\nend: 2026-04-22\n").unwrap();
    assert!(validate_property_value(&column, &bad).is_err());
}

#[test]
fn query_validation_enforces_operator_matrix_and_macros() {
    let raw = r#"
columns:
  - { name: Effort, type: number }
  - { name: Due, type: date }
  - name: Status
    type: status
    options:
      - { name: Todo, group: todo }
      - { name: Doing, group: in_progress }
      - { name: Done, group: done }
  - name: Tags
    type: multi_select
    options: [Bug, Feature]
views:
  - type: table
    name: Valid
    filter:
      - { field: Due, op: before, value: "@today+3" }
      - { field: Status, op: group_in, values: [todo, done] }
    sort:
      - { field: Tags }
    visible_fields: [title]
"#;
    let schema: CollectionSchema = serde_yml::from_str(raw).unwrap();
    validate_schema(&schema).unwrap();

    let bad_op = r#"
columns:
  - { name: Effort, type: number }
views:
  - type: table
    name: Bad
    filter:
      - { field: Effort, op: contains, value: "1" }
"#;
    let schema: CollectionSchema = serde_yml::from_str(bad_op).unwrap();
    assert!(validate_schema(&schema).is_err());

    let bad_macro = r#"
columns:
  - { name: Due, type: date }
views:
  - type: table
    name: Bad
    filter:
      - { field: Due, op: before, value: "@today+soon" }
"#;
    let schema: CollectionSchema = serde_yml::from_str(bad_macro).unwrap();
    assert!(validate_schema(&schema).is_err());
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

#[test]
fn collection_integrity_reports_relation_and_sidebar_damage() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::create_dir_all(space.join("people")).unwrap();
    fs::create_dir_all(space.join(".svode")).unwrap();
    fs::write(
        space.join("tasks/schema.yaml"),
        r#"columns:
  - name: Owner
    type: relation
    relation: people
  - name: Removed target
    type: relation
    relation: removed-collection
views: []
"#,
    )
    .unwrap();
    fs::write(space.join("people/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(
        space.join("tasks/one.md"),
        "---\ntitle: One\nOwner: missing.md\n---\n",
    )
    .unwrap();
    fs::write(
        space.join(".svode/order.json"),
        r#"{"tasks":["one.md","gone.md"]}"#,
    )
    .unwrap();

    let report =
        validate_collection_integrity_with_project(space.to_str().unwrap(), Some("tasks"), None)
            .unwrap();
    let errors = report
        .errors
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    let warnings = report
        .warnings
        .iter()
        .map(|issue| issue.code.as_str())
        .collect::<Vec<_>>();
    assert!(errors.contains(&"RELATION_ENTRY_MISSING"));
    assert!(errors.contains(&"RELATION_TARGET_COLLECTION_MISSING"));
    assert!(warnings.contains(&"STALE_ORDER_REF"));
}

#[test]
fn collection_integrity_is_empty_for_a_clean_collection() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path();
    fs::create_dir_all(space.join("tasks")).unwrap();
    fs::write(space.join("tasks/schema.yaml"), "columns: []\nviews: []\n").unwrap();
    fs::write(space.join("tasks/one.md"), "---\ntitle: One\n---\n").unwrap();

    let report =
        validate_collection_integrity_with_project(space.to_str().unwrap(), Some("tasks"), None)
            .unwrap();
    assert!(report.errors.is_empty());
    assert!(report.warnings.is_empty());
}
