//! Values of `schema.yaml` that a newer Svode version added: they read, are
//! written back unchanged, and only the operations that depend on them are
//! refused (DF-244 R4–R5).

use std::collections::BTreeMap;

use tempfile::TempDir;

use super::*;
use crate::page::entry;

/// A newer value in every position R4 names: property type, `limit` and
/// `relation_scope` type, view type, filter operator, status group of an
/// option and in a filter, colors of a column and an option, `display` and
/// `sensitivity`; views that depend on a newer property or option group.
const TASKS: &str = r#"
columns:
  - name: ID
    type: unique_id
    prefix: T
    next: 2
  - name: Status
    type: status
    color: teal
    options:
      - name: Todo
        group: todo
        color: teal
      - name: Blocked
        group: blocked
      - name: Done
        group: done
  - name: Score
    type: formula
    expression: Count * 2
    display: sparkline
  - name: Links
    type: relation
    relation: people
    limit: many
  - name: Elsewhere
    type: relation
    relation: people
    relation_scope:
      type: project
      id: shared
  - name: Owner
    type: relation
    relation: people
  - name: Count
    type: number
    display: sparkline
    sensitivity: secret
  - name: Notes
    type: text
views:
  - name: All
    type: table
    visible_fields: [title, Score, Count]
  - name: Timeline
    type: timeline
    date_field: created
    lanes: Status
  - name: Between
    type: table
    filter:
      - field: Count
        op: between
        values: [1, 5]
  - name: Grouped
    type: table
    filter:
      - field: Status
        op: group_in
        values: [todo, blocked]
  - name: ByScore
    type: table
    sort:
      - field: Score
  - name: Open
    type: board
    group_by: Status
    filter:
      - field: Status
        op: group_neq
        value: done
  - name: Board
    type: board
    group_by: Status
"#;

const ITEM: &str =
    "---\ntitle: A\nID: 1\nStatus: Blocked\nScore: 42\nLinks: [p]\nCount: 3\nNotes: n\n---\nBody\n";

const NEWER_COLUMNS: [&str; 3] = ["Score", "Links", "Elsewhere"];
const NEWER_VIEWS: [&str; 5] = ["Timeline", "Between", "Grouped", "ByScore", "Open"];

struct Fixture {
    _tmp: TempDir,
    space: String,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap().to_string();
        for (path, content) in [
            ("tasks/schema.yaml", TASKS),
            ("tasks/a.md", ITEM),
            ("people/schema.yaml", "columns: []\nviews: []\n"),
            ("people/p.md", "---\ntitle: P\n---\n"),
        ] {
            let path = tmp.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        Self { _tmp: tmp, space }
    }

    fn raw(&self, rel: &str) -> String {
        fs::read_to_string(Path::new(&self.space).join(rel)).unwrap()
    }

    fn schema(&self) -> CollectionSchema {
        read_collection_schema(&self.space, "tasks").unwrap()
    }

    /// Every source file of the Space, to prove a refusal wrote nothing.
    fn files(&self) -> BTreeMap<String, String> {
        [
            "tasks/schema.yaml",
            "tasks/a.md",
            "people/schema.yaml",
            "people/p.md",
        ]
        .into_iter()
        .map(|rel| (rel.to_string(), self.raw(rel)))
        .collect()
    }
}

/// The newer values of a `tasks` schema file: newer properties and views
/// whole, the other values one by one. Renamed items are found by content.
fn newer_values(raw: &str) -> BTreeMap<String, Value> {
    let doc: Value = serde_norway::from_str(raw).unwrap();
    let mut found = BTreeMap::new();
    for column in doc["columns"].as_sequence().unwrap() {
        let name = column["name"].as_str().unwrap();
        if NEWER_COLUMNS.contains(&name) {
            found.insert(format!("column {name}"), column.clone());
        }
        if name == "Status" {
            found.insert("Status color".into(), column["color"].clone());
            for option in column["options"].as_sequence().unwrap() {
                if option["color"].as_str() == Some("teal") {
                    found.insert("option color".into(), option["color"].clone());
                }
                if option["group"].as_str() == Some("blocked") {
                    found.insert("option group".into(), option["group"].clone());
                }
            }
        }
        if name == "Count" {
            found.insert("Count display".into(), column["display"].clone());
            found.insert("Count sensitivity".into(), column["sensitivity"].clone());
        }
    }
    for view in doc["views"].as_sequence().unwrap() {
        let mut view = view.as_mapping().unwrap().clone();
        let name = view.remove("name").unwrap();
        if view.get("type").and_then(Value::as_str) == Some("timeline") {
            found.insert("view timeline".into(), Value::Mapping(view));
        } else if matches!(name.as_str(), Some("Between" | "Grouped")) {
            found.insert(
                format!("view {}", name.as_str().unwrap()),
                Value::Mapping(view),
            );
        }
    }
    found
}

fn assert_newer_values_kept(fixture: &Fixture, step: &str) {
    let raw = fixture.raw("tasks/schema.yaml");
    assert_eq!(newer_values(&raw), newer_values(TASKS), "{step}:\n{raw}");
    assert!(!raw.contains("newer_svode"), "{step}:\n{raw}");
}

/// The operation is refused with the compatibility reason and writes nothing.
fn assert_newer_refusal<T: std::fmt::Debug>(
    fixture: &Fixture,
    step: &str,
    operation: impl FnOnce() -> Result<T, CollectionError>,
) {
    let before = fixture.files();
    match operation() {
        Err(CollectionError::NewerVersion(message)) => {
            assert!(message.contains("newer Svode version"), "{step}: {message}");
        }
        other => panic!("{step}: expected a newer-version refusal, got {other:?}"),
    }
    assert_eq!(fixture.files(), before, "{step} wrote a file");
}

fn fields(field: &str, value: serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    BTreeMap::from([(field.to_string(), value)])
}

#[test]
fn newer_values_read_with_their_markers_and_reading_leaves_the_file() {
    let fixture = Fixture::new();
    let schema = fixture.schema();
    assert_eq!(fixture.raw("tasks/schema.yaml"), TASKS);

    let newer = |name: &str| schema.column(name).unwrap().is_newer();
    assert!(NEWER_COLUMNS.iter().all(|name| newer(name)));
    assert!(!newer("Owner") && !newer("Count") && !newer("Status"));
    let status = schema.column("Status").unwrap();
    assert_eq!(status.color, Some(OrNewer::Newer("teal".into())));
    assert!(status.has_newer_option_group());
    let count = schema.column("Count").unwrap();
    assert!(!count.display_is_known());
    assert_eq!(count.sensitivity, Some(OrNewer::Newer("secret".into())));
    assert_eq!(
        column_effective_sensitivity(count),
        ColumnSensitivity::Pii,
        "a newer sensitivity counts as pii"
    );
    assert_eq!(
        column_effective_sensitivity(schema.column("Score").unwrap()),
        ColumnSensitivity::Pii
    );
    assert!(schema_has_sensitive_columns(&schema));
    for view in ["Timeline", "Between", "Grouped"] {
        assert!(
            schema
                .views
                .iter()
                .any(|v| v.name() == view && v.is_newer()),
            "{view}"
        );
    }

    let marker = schema.newer_svode().unwrap();
    assert_eq!(marker.columns, NEWER_COLUMNS);
    assert_eq!(marker.views, NEWER_VIEWS);

    // Responses carry the marker and the values as in the file.
    let json = serde_json::to_value(&schema).unwrap();
    assert_eq!(json["newer_svode"]["columns"][0], "Score");
    assert_eq!(json["newer_svode"]["views"][4], "Open");
    assert_eq!(json["columns"][2]["type"], "formula");
    assert_eq!(json["columns"][2]["expression"], "Count * 2");
    assert_eq!(json["columns"][3]["limit"], "many");
    assert_eq!(json["columns"][1]["color"], "teal");
    assert_eq!(json["columns"][1]["options"][1]["group"], "blocked");
    assert_eq!(json["columns"][6]["display"], "sparkline");
    assert_eq!(json["views"][1]["type"], "timeline");
    assert_eq!(json["views"][2]["filter"][0]["op"], "between");

    // A schema without newer values has no marker, in responses either.
    let plain: CollectionSchema =
        serde_norway::from_str("columns: [{ name: N, type: text }]\nviews: []\n").unwrap();
    assert_eq!(plain.newer_svode(), None);
    assert!(
        serde_json::to_value(&plain)
            .unwrap()
            .get("newer_svode")
            .is_none()
    );

    // Syntax errors and broken known rules still make the schema invalid.
    for broken in [
        "columns: [broken\n",
        "columns:\n  - { name: S, type: status, options: [{ name: A }] }\n",
        "columns:\n  - { name: N, type: number, min: high }\n",
        "views:\n  - { name: V, type: table, filter: [{ field: missing, op: eq, value: 1 }] }\n",
    ] {
        fs::write(Path::new(&fixture.space).join("tasks/schema.yaml"), broken).unwrap();
        assert!(
            matches!(
                read_collection_schema(&fixture.space, "tasks"),
                Err(CollectionError::Schema(_))
            ),
            "{broken}"
        );
    }
}

#[test]
fn every_schema_writer_keeps_newer_values() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let text: Column = serde_norway::from_str("name: Extra\ntype: text\n").unwrap();

    add_schema_column(space, "tasks", text).unwrap();
    assert_newer_values_kept(&fixture, "add column");
    update_schema_column(
        space,
        "tasks",
        "Count",
        serde_norway::from_str("min: 0").unwrap(),
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "column patch");
    update_schema_column(
        space,
        "tasks",
        "Notes",
        serde_norway::from_str("{}").unwrap(),
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "empty patch");
    add_option(
        space,
        "tasks",
        "Status",
        serde_norway::from_str("name: Waiting\ngroup: todo\n").unwrap(),
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "add option");
    rename_option(space, "tasks", "Status", "Blocked", "Stuck").unwrap();
    assert_newer_values_kept(&fixture, "rename option");
    update_option(
        space,
        "tasks",
        "Status",
        "Stuck",
        None,
        Some(serde_norway::from_str("icon: stop").unwrap()),
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "update option");
    add_view(
        space,
        "tasks",
        serde_norway::from_str("name: New\ntype: list\n").unwrap(),
        None,
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "add view");
    update_view(
        space,
        "tasks",
        "All",
        serde_norway::from_str("visible_fields: [title, Score]").unwrap(),
    )
    .unwrap();
    assert_newer_values_kept(&fixture, "view patch");
    set_default_template(space, "tasks", Some("basic")).unwrap();
    update_system_field_label(space, "tasks", "title", Some("Name".into())).unwrap();
    assert_newer_values_kept(&fixture, "templates and title label");

    let created = entry::create(space, Some("tasks"), "Second").unwrap();
    assert!(fixture.raw("tasks/schema.yaml").contains("next: 3"));
    assert_newer_values_kept(&fixture, "unique_id allocation");
    // The new item takes no default of a newer property.
    assert!(!fixture.raw(&created.path).contains("Score"));

    let reverse: Column =
        serde_norway::from_str("name: Tasks\ntype: relation\nrelation: tasks\ntwo_way: People\n")
            .unwrap();
    add_schema_column(space, "people", reverse).unwrap();
    assert!(fixture.raw("tasks/schema.yaml").contains("two_way: Tasks"));
    assert_newer_values_kept(&fixture, "two-way reverse column");

    // Renaming `people` rewrites the known relation targets only.
    entry::rename(space, "people", "team").unwrap();
    let raw = fixture.raw("tasks/schema.yaml");
    assert!(raw.contains("relation: team"), "{raw}");
    assert_newer_values_kept(&fixture, "collection rename");
}

#[test]
fn a_newer_property_is_read_and_kept_but_never_changed() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    assert_newer_refusal(&fixture, "rename", || {
        rename_schema_column(space, "tasks", "Score", "Points")
    });
    assert_newer_refusal(&fixture, "delete", || {
        delete_schema_column(space, "tasks", "Score", true)
    });
    assert_newer_refusal(&fixture, "change type", || {
        change_schema_type(space, "tasks", "Score", PropertyType::Text, None)
    });
    assert_newer_refusal(&fixture, "settings", || {
        update_schema_column(
            space,
            "tasks",
            "Links",
            serde_norway::from_str("{}").unwrap(),
        )
    });
    assert_newer_refusal(&fixture, "options", || {
        add_option(
            space,
            "tasks",
            "Score",
            serde_norway::from_str("name: X").unwrap(),
        )
    });
    assert_newer_refusal(&fixture, "clear values", || {
        clear_field_values(space, "tasks", "Score")
    });
    assert_newer_refusal(&fixture, "write a value", || {
        prepare_entry_field_batch(
            space,
            None,
            "tasks/a.md",
            &fields("Score", serde_json::json!(7)),
            EntryFieldBatchIntent::Literal,
        )
        .map(PreparedEntryFieldBatch::into_metadata)
    });
    assert_newer_refusal(&fixture, "clear a value", || {
        prepare_entry_field_batch(
            space,
            None,
            "tasks/a.md",
            &fields("Elsewhere", serde_json::Value::Null),
            EntryFieldBatchIntent::Literal,
        )
        .map(PreparedEntryFieldBatch::into_metadata)
    });
    assert_newer_refusal(&fixture, "two-way diagnosis", || {
        diagnose_two_way_relation(space, "tasks", "Links")
    });
    let error =
        entry::update_field(space, None, "tasks/a.md", "Score", serde_json::json!(7)).unwrap_err();
    assert!(error.to_string().contains("newer Svode version"), "{error}");
    let duplicate = add_schema_column(
        space,
        "tasks",
        serde_norway::from_str("name: Score\ntype: text").unwrap(),
    )
    .unwrap_err();
    assert!(duplicate.to_string().contains("already exists"));

    // Edits of other fields, renames, duplicates and moves keep its values.
    entry::update_field(
        space,
        None,
        "tasks/a.md",
        "Notes",
        serde_json::json!("edited"),
    )
    .unwrap();
    let copy = entry::duplicate_entry(Path::new(space), "tasks/a.md").unwrap();
    let moved = entry::move_entry(Path::new(space), &copy.path, "people", None).unwrap();
    for item in [fixture.raw("tasks/a.md"), fixture.raw(&moved)] {
        assert!(
            item.contains("Score: 42") && item.contains("Links:\n- p"),
            "{item}"
        );
    }
    assert_newer_values_kept(&fixture, "item edits");

    // Its relation values are neither resolved nor counted as backlinks.
    let backlinks = query_relation_backlinks(space, "people/p.md", None, None).unwrap();
    assert!(backlinks.is_empty(), "{backlinks:?}");
}

#[test]
fn views_that_depend_on_newer_values_keep_their_place_but_are_not_shown_or_changed() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    for view in NEWER_VIEWS {
        assert_newer_refusal(&fixture, &format!("update {view}"), || {
            update_view(space, "tasks", view, serde_norway::from_str("{}").unwrap())
        });
        assert_newer_refusal(&fixture, &format!("duplicate {view}"), || {
            duplicate_view(space, "tasks", view, "Copy")
        });
    }
    // A new view or a patch may not come to depend on a newer value either.
    assert_newer_refusal(&fixture, "add a view sorted by a newer property", || {
        add_view(
            space,
            "tasks",
            serde_norway::from_str("name: S\ntype: table\nsort: [{ field: Score }]").unwrap(),
            None,
        )
    });
    assert_newer_refusal(&fixture, "patch a view into a status group filter", || {
        update_view(
            space,
            "tasks",
            "All",
            serde_norway::from_str("filter: [{ field: Status, op: group_eq, value: todo }]")
                .unwrap(),
        )
    });
    // Showing only fields of a newer property keeps the view working.
    duplicate_view(space, "tasks", "All", "All copy").unwrap();

    rename_view(space, "tasks", "Timeline", "Roadmap").unwrap();
    let mut order = fixture
        .schema()
        .views
        .iter()
        .map(|view| view.name().to_string())
        .collect::<Vec<_>>();
    order.reverse();
    reorder_views(space, "tasks", order.clone()).unwrap();
    let schema = fixture.schema();
    let names = schema.views.iter().map(View::name).collect::<Vec<_>>();
    assert_eq!(names, order);
    assert!(
        schema
            .views
            .iter()
            .any(|v| v.name() == "Roadmap" && v.is_newer())
    );
    assert_newer_values_kept(&fixture, "rename and reorder");

    delete_view(space, "tasks", "Between").unwrap();
    delete_view(space, "tasks", "Roadmap").unwrap();
    let raw = fixture.raw("tasks/schema.yaml");
    assert!(
        !raw.contains("between") && !raw.contains("timeline"),
        "{raw}"
    );
}

#[test]
fn queries_that_depend_on_newer_values_are_refused() {
    let fixture = Fixture::new();
    let schema = fixture.schema();
    let filter = |yaml: &str| -> Filter { serde_norway::from_str(yaml).unwrap() };
    let sort = |field: &str| Sort {
        field: field.into(),
        desc: false,
        unknown_keys: Mapping::new(),
    };
    for (step, filters, sorts) in [
        (
            "filter",
            vec![filter("{ field: Score, op: eq, value: 1 }")],
            vec![],
        ),
        ("sort", vec![], vec![sort("Score")]),
        (
            "status group",
            vec![filter("{ field: Status, op: group_eq, value: done }")],
            vec![],
        ),
    ] {
        assert_newer_refusal(&fixture, step, || {
            crate::collections::query::validate_ad_hoc_query(&schema, &filters, &sorts)
        });
    }
    // Options of a newer group still filter by name, and sorts by known fields work.
    crate::collections::query::validate_ad_hoc_query(
        &schema,
        &[filter("{ field: Status, op: in, values: [Blocked, Done] }")],
        &[sort("Count")],
    )
    .unwrap();
}

#[test]
fn known_parts_with_newer_values_keep_working() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    // An option of a newer status group: values, renames, edits, deletion.
    prepare_entry_field_batch(
        space,
        None,
        "tasks/a.md",
        &fields("Status", serde_json::json!("Blocked")),
        EntryFieldBatchIntent::Literal,
    )
    .unwrap();
    rename_option(space, "tasks", "Status", "Blocked", "Stuck").unwrap();
    assert!(fixture.raw("tasks/a.md").contains("Status: Stuck"));
    let schema = update_option(
        space,
        "tasks",
        "Status",
        "Stuck",
        None,
        Some(serde_norway::from_str("color: red").unwrap()),
    )
    .unwrap();
    let stuck = &schema.column("Status").unwrap().options.as_ref().unwrap()[1];
    assert_eq!(stuck.group, Some(OrNewer::Newer("blocked".into())));
    assert_eq!(stuck.color, Some(ColorName::Red.into()));
    delete_option(space, "tasks", "Status", "Stuck", false).unwrap();
    assert!(
        !fixture
            .schema()
            .column("Status")
            .unwrap()
            .has_newer_option_group()
    );

    // A known column with a newer color, display or sensitivity.
    prepare_entry_field_batch(
        space,
        None,
        "tasks/a.md",
        &fields("Count", serde_json::json!(4)),
        EntryFieldBatchIntent::Literal,
    )
    .unwrap();
    // Input may repeat a stored newer value, and setting the field replaces it.
    update_schema_column(
        space,
        "tasks",
        "Count",
        serde_norway::from_str("{ display: sparkline, sensitivity: secret }").unwrap(),
    )
    .unwrap();
    let schema = update_schema_column(
        space,
        "tasks",
        "Status",
        serde_norway::from_str("color: blue").unwrap(),
    )
    .unwrap();
    assert_eq!(
        schema.column("Status").unwrap().color,
        Some(ColorName::Blue.into())
    );
}

#[test]
fn operation_input_never_brings_newer_values() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let before = fixture.files();
    let column: Column =
        serde_norway::from_str("name: Tag\ntype: select\ncolor: teal\noptions: [A]\n").unwrap();
    let error = add_schema_column(space, "tasks", column).unwrap_err();
    assert!(
        matches!(&error, CollectionError::Schema(message) if message.contains("invalid color 'teal'")),
        "{error}"
    );
    let error = update_schema_column(
        space,
        "tasks",
        "Count",
        serde_norway::from_str("display: dots").unwrap(),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("invalid display 'dots'"),
        "{error}"
    );
    let error = update_option(
        space,
        "tasks",
        "Status",
        "Done",
        None,
        Some(serde_norway::from_str("group: frozen").unwrap()),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("invalid group 'frozen'"),
        "{error}"
    );
    let error = change_schema_type(
        space,
        "tasks",
        "Notes",
        PropertyType::Status,
        Some(serde_norway::from_str("options: [{ name: A, group: later }]").unwrap()),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("invalid group 'later'"),
        "{error}"
    );
    // Input types this version does not know do not deserialize at all.
    for input in [
        "name: F\ntype: formula\n",
        "name: L\ntype: relation\nrelation: people\nlimit: many\n",
    ] {
        assert!(serde_norway::from_str::<Column>(input).is_err(), "{input}");
    }
    for input in [
        "name: T\ntype: timeline\n",
        "name: B\ntype: table\nfilter: [{ field: Count, op: between, value: 1 }]\n",
    ] {
        assert!(serde_norway::from_str::<View>(input).is_err(), "{input}");
    }
    assert_eq!(fixture.files(), before);
}

#[tokio::test]
async fn items_stay_members_in_the_index_and_unshowable_views_refuse() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let root = Path::new(space);
    crate::page::test_support::scaffold_space(root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    let pool = crate::index::db::create_pool(&root.join(".svode/index.db"))
        .await
        .unwrap();
    crate::index::db::ensure_schema(&pool).await.unwrap();
    crate::index::reindex::full_reindex::<crate::git::cli::GitCli>(None, &pool, root, &[])
        .await
        .unwrap();
    let members = sqlx::query_scalar::<_, String>(
        "SELECT file_path FROM entries WHERE in_collection = 1 AND collection_root_path = 'tasks'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(members, ["tasks/a.md"]);

    let actors = crate::actors::resolver::ActorCatalogState::new();
    let list = |view: &'static str| {
        crate::collections::entries::list_entries_for_view(
            &pool, &actors, None, space, "tasks", view, None,
        )
    };
    let shown = list("All").await.unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].meta.extra.get("Score"), Some(&Value::from(42)));
    for view in NEWER_VIEWS {
        let error = list(view).await.unwrap_err().to_string();
        assert!(error.contains("newer Svode version"), "{view}: {error}");
    }
}
