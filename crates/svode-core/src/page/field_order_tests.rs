//! Order of user-defined frontmatter fields across every write path: fields
//! keep the order of the file, new ones follow in schema column order and
//! then by name.

use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::json;
use serde_norway::Value;
use tempfile::TempDir;

use crate::collections::engine::{self as collections, Column};
use crate::page::entry;
use crate::page::frontmatter::{self, FrontmatterFields};
use crate::page::templates::{self, TemplateKind};

const SCHEMA: &str = "columns:
- name: Status
  type: text
- name: Owner
  type: text
- name: Priority
  type: number
- name: Sprint
  type: text
- name: Area
  type: text
views: []
";

/// Neither alphabetical nor schema order.
const ITEM: &str = "---
title: Task
Sprint: S1
Priority: 2
Status: Todo
Area: Core
Owner: Ann
---
Body
";

fn collection(dir: &Path) -> String {
    fs::create_dir_all(dir.join("tasks")).unwrap();
    fs::write(dir.join("tasks/schema.yaml"), SCHEMA).unwrap();
    fs::write(dir.join("tasks/Task.md"), ITEM).unwrap();
    dir.to_str().unwrap().to_string()
}

fn item(dir: &Path) -> String {
    fs::read_to_string(dir.join("tasks/Task.md")).unwrap()
}

fn column(raw: &str) -> Column {
    serde_norway::from_str(raw).unwrap()
}

fn fields(pairs: &[(&str, Value)]) -> FrontmatterFields {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

#[test]
fn changing_one_field_keeps_the_others_in_place() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    entry::update_field(&space, None, "tasks/Task.md", "Status", json!("Done")).unwrap();

    assert_eq!(
        item(tmp.path()),
        ITEM.replace("Status: Todo\n", "Status: Done\n")
    );
}

#[test]
fn clearing_one_field_removes_only_its_line() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    entry::update_field(&space, None, "tasks/Task.md", "Priority", json!(null)).unwrap();

    assert_eq!(item(tmp.path()), ITEM.replace("Priority: 2\n", ""));
}

#[test]
fn replacing_the_field_set_keeps_file_order_and_appends_new_columns_in_schema_order() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());
    fs::write(
        tmp.path().join("tasks/schema.yaml"),
        SCHEMA.replace(
            "views: []\n",
            "- name: Due\n  type: text\n- name: Bucket\n  type: text\nviews: []\n",
        ),
    )
    .unwrap();
    // Alphabetical, as a JSON object without order would arrive.
    let incoming = fields(&[
        ("Area", text("Core")),
        ("Bucket", text("B1")),
        ("Due", text("Friday")),
        ("Owner", text("Ann")),
        ("Priority", Value::from(3)),
        ("Sprint", text("S1")),
        ("Status", text("Todo")),
        ("note", text("free")),
    ]);

    entry::write(
        &space,
        "tasks/Task.md",
        "Body\n",
        None,
        None,
        Some(incoming),
        None,
        None,
        true,
    )
    .unwrap();

    assert_eq!(
        item(tmp.path()),
        ITEM.replace("Priority: 2\n", "Priority: 3\n").replace(
            "Owner: Ann\n",
            "Owner: Ann\nDue: Friday\nBucket: B1\nnote: free\n"
        )
    );
}

#[test]
fn replacing_the_field_set_of_a_page_appends_new_keys_by_name() {
    let tmp = TempDir::new().unwrap();
    let space = tmp.path().to_str().unwrap().to_string();
    let page = "---\ntitle: Note\nmood: calm\nweather: rain\n---\nBody\n";
    fs::write(tmp.path().join("Note.md"), page).unwrap();

    entry::write(
        &space,
        "Note.md",
        "Body\n",
        None,
        None,
        Some(fields(&[
            ("zeta", text("z")),
            ("weather", text("sun")),
            ("beta", text("b")),
            ("mood", text("calm")),
        ])),
        None,
        None,
        true,
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(tmp.path().join("Note.md")).unwrap(),
        "---\ntitle: Note\nmood: calm\nweather: sun\nbeta: b\nzeta: z\n---\nBody\n"
    );
}

#[test]
fn saving_the_same_title_and_metadata_keeps_the_bytes() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());
    let mut metadata = frontmatter::parse(ITEM).unwrap().0;
    metadata.extra.reverse();

    entry::write_under_name_lock(
        &space,
        "tasks/Task.md",
        "Body\n",
        Some("Task"),
        None,
        None,
        Some(metadata),
        None,
        None,
        false,
        None,
        None,
    )
    .unwrap();

    assert_eq!(item(tmp.path()), ITEM);
}

#[test]
fn renaming_a_column_puts_the_new_name_in_place_of_the_old() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    collections::rename_schema_column(&space, "tasks", "Priority", "Rank").unwrap();

    assert_eq!(item(tmp.path()), ITEM.replace("Priority: 2\n", "Rank: 2\n"));
}

#[test]
fn deleting_a_column_removes_only_its_line() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    collections::delete_schema_column(&space, "tasks", "Area", true).unwrap();

    assert_eq!(item(tmp.path()), ITEM.replace("Area: Core\n", ""));
}

#[test]
fn changing_a_column_type_keeps_the_value_in_place() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    collections::change_schema_type(
        &space,
        "tasks",
        "Priority",
        collections::PropertyType::Text,
        None,
    )
    .unwrap();

    assert_eq!(
        item(tmp.path()),
        ITEM.replace("Priority: 2\n", "Priority: '2'\n")
    );
}

#[test]
fn backfilled_defaults_follow_existing_fields_in_schema_order() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());
    collections::add_schema_column(
        &space,
        "tasks",
        column("{name: Size, type: text, default: M}"),
    )
    .unwrap();
    collections::add_schema_column(
        &space,
        "tasks",
        column("{name: Kind, type: text, default: Bug}"),
    )
    .unwrap();

    collections::apply_schema_defaults_to_entry_tree(tmp.path(), "tasks/Task.md").unwrap();

    assert_eq!(
        item(tmp.path()),
        ITEM.replace("Owner: Ann\n", "Owner: Ann\nSize: M\nKind: Bug\n")
    );
}

#[test]
fn materialized_unique_id_is_appended_after_existing_fields() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());

    collections::add_schema_column(&space, "tasks", column("{name: Code, type: unique_id}"))
        .unwrap();

    assert_eq!(
        item(tmp.path()),
        ITEM.replace("Owner: Ann\n", "Owner: Ann\nCode: 1\n")
    );
}

#[test]
fn moving_a_page_into_a_collection_keeps_its_fields_and_appends_defaults() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());
    fs::write(
        tmp.path().join("tasks/schema.yaml"),
        SCHEMA.replace(
            "views: []\n",
            "- name: Size\n  type: text\n  default: M\n- name: Kind\n  type: text\n  default: Bug\nviews: []\n",
        ),
    )
    .unwrap();
    let page = "---\ntitle: Loose\nzone: west\nOwner: Bob\nalpha: a\n---\n";
    fs::write(tmp.path().join("Loose.md"), page).unwrap();

    let moved = entry::move_entry(Path::new(&space), "Loose.md", "tasks", None).unwrap();

    assert_eq!(
        fs::read_to_string(tmp.path().join(moved)).unwrap(),
        "---\ntitle: Loose\nzone: west\nOwner: Bob\nalpha: a\nSize: M\nKind: Bug\n---\n"
    );
}

#[test]
fn template_instance_keeps_template_order_and_contextual_defaults_change_values_in_place() {
    let tmp = TempDir::new().unwrap();
    let space = collection(tmp.path());
    let head = templates::create(&space, "tasks", "Bug", TemplateKind::Leaf).unwrap();
    fs::write(
        tmp.path().join(&head),
        "---\ntitle: Bug\nSprint: S0\nPriority: 1\nStatus: Todo\nArea: Core\nOwner: Ann\n---\nSteps\n",
    )
    .unwrap();

    let slug = Path::new(&head).file_stem().unwrap().to_str().unwrap();

    let instantiated = templates::instantiate(
        &space,
        "tasks",
        slug,
        "tasks",
        Some("Crash".into()),
        false,
        false,
        Some(fields(&[("Owner", text("Eve")), ("Status", text("Doing"))])),
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(tmp.path().join(&instantiated.entry.path)).unwrap(),
        "---\ntitle: Crash\nSprint: S0\nPriority: 1\nStatus: Doing\nArea: Core\nOwner: Eve\n---\nSteps\n"
    );
}

#[test]
fn new_item_fields_follow_schema_order_and_repeat_byte_for_byte() {
    let create = || {
        let tmp = TempDir::new().unwrap();
        let space = collection(tmp.path());
        fs::write(
            tmp.path().join("tasks/schema.yaml"),
            SCHEMA.replace(
                "- name: Owner\n  type: text\n",
                "- name: Owner\n  type: text\n  default: Ann\n",
            ),
        )
        .unwrap();
        let created = entry::create_with_options(
            &space,
            Some("tasks"),
            "Fresh",
            Some(fields(&[
                ("Area", text("Core")),
                ("Sprint", text("S2")),
                ("Status", text("Todo")),
            ])),
            false,
            false,
        )
        .unwrap();
        fs::read_to_string(tmp.path().join(created.path)).unwrap()
    };

    let first = create();

    assert_eq!(
        first,
        "---\ntitle: Fresh\nStatus: Todo\nOwner: Ann\nSprint: S2\nArea: Core\n---\n"
    );
    assert_eq!(create(), first);
}

#[test]
fn order_fields_keeps_previous_positions_then_columns_then_names() {
    let previous = fields(&[("b", text("1")), ("a", text("2")), ("gone", text("3"))]);
    let next: IndexMap<_, _> = fields(&[
        ("z", text("z")),
        ("Col2", text("c2")),
        ("a", text("A")),
        ("y", text("y")),
        ("Col1", text("c1")),
        ("b", text("1")),
    ]);

    let ordered =
        frontmatter::order_fields(&previous, next, &["Col1".to_string(), "Col2".to_string()]);

    assert_eq!(
        ordered.keys().map(String::as_str).collect::<Vec<_>>(),
        ["b", "a", "Col1", "Col2", "y", "z"]
    );
}
