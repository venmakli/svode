//! `schema.yaml` keeps the keys this version does not know through every
//! schema write (DF-244 R1–R3).

use std::collections::BTreeMap;

use tempfile::TempDir;

use super::*;
use crate::page::entry;

/// Unknown keys (`x_*`) on every level of the format, the legacy `document`
/// key and a counter column for `unique_id` allocations.
const TASKS: &str = r#"
document:
  label: Documents
x_root:
  nested: [1, 2.5, text, true]
system_fields:
  x_system: 1
  title:
    label: Name
    x_title: kept
templates:
  default: basic
  x_templates: 3
columns:
  - name: ID
    type: unique_id
    prefix: T
    next: 1
    x_column: id
  - name: Status
    type: status
    x_column: 7
    options:
      - name: Todo
        group: todo
        x_option: o1
      - name: Done
        group: done
        x_option: o2
  - name: Owner
    type: relation
    relation: people
    relation_scope:
      type: space
      id: people-space
      x_scope: s1
  - name: Lead
    type: relation
    relation: people
    relation_scope:
      type: root
      x_scope: s2
  - name: Notes
    type: text
    x_column: notes
views:
  - name: All
    type: table
    x_view: v1
    filter:
      - field: Status
        op: eq
        value: Todo
        x_filter: f1
    sort:
      - field: title
        x_sort: s1
  - name: Board
    type: board
    group_by: Status
    x_view: v2
"#;

/// Every unknown key of the fixture: path by object names, then its value.
const TASKS_KEYS: &[(&str, &str)] = &[
    ("columns.ID.x_column", "id"),
    ("columns.Lead.relation_scope.x_scope", "s2"),
    ("columns.Notes.x_column", "notes"),
    ("columns.Owner.relation_scope.x_scope", "s1"),
    ("columns.Status.options.Done.x_option", "o2"),
    ("columns.Status.options.Todo.x_option", "o1"),
    ("columns.Status.x_column", "7"),
    ("system_fields.title.x_title", "kept"),
    ("system_fields.x_system", "1"),
    ("templates.x_templates", "3"),
    ("views.All.filter.0.x_filter", "f1"),
    ("views.All.sort.0.x_sort", "s1"),
    ("views.All.x_view", "v1"),
    ("views.Board.x_view", "v2"),
    ("x_root", "{nested: [1, 2.5, text, true]}"),
];

struct Fixture {
    _tmp: TempDir,
    space: String,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_str().unwrap().to_string();
        for (collection, schema) in [("tasks", TASKS), ("people", "columns: []\nviews: []\n")] {
            fs::create_dir_all(tmp.path().join(collection)).unwrap();
            fs::write(tmp.path().join(collection).join(SCHEMA_FILE), schema).unwrap();
        }
        Self { _tmp: tmp, space }
    }

    fn path(&self, rel: &str) -> PathBuf {
        Path::new(&self.space).join(rel)
    }

    fn raw(&self, collection: &str) -> String {
        fs::read_to_string(self.path(collection).join(SCHEMA_FILE)).unwrap()
    }

    fn keys(&self, collection: &str) -> BTreeMap<String, String> {
        let raw = self.raw(collection);
        assert!(!raw.contains("document"), "legacy document is kept:\n{raw}");
        unknown_keys(&raw)
    }
}

/// Unknown keys (`x_*`) of a schema file by their path: list items are named
/// by their `name`, or by their index when they have none.
fn unknown_keys(raw: &str) -> BTreeMap<String, String> {
    fn walk(value: &Value, path: &str, found: &mut BTreeMap<String, String>) {
        let join = |key: &str| {
            if path.is_empty() {
                key.to_string()
            } else {
                format!("{path}.{key}")
            }
        };
        match value {
            Value::Mapping(mapping) => {
                for (key, value) in mapping {
                    let key = key.as_str().unwrap();
                    if key.starts_with("x_") {
                        let text = serde_norway::to_string(value).unwrap();
                        found.insert(join(key), flow(&text));
                    } else {
                        walk(value, &join(key), found);
                    }
                }
            }
            Value::Sequence(items) => {
                for (index, item) in items.iter().enumerate() {
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| index.to_string());
                    walk(item, &join(&name), found);
                }
            }
            _ => {}
        }
    }
    let mut found = BTreeMap::new();
    walk(&serde_norway::from_str(raw).unwrap(), "", &mut found);
    found
}

/// Compact one-line form of a serialized YAML value for comparisons.
fn flow(text: &str) -> String {
    let value: Value = serde_norway::from_str(text).unwrap();
    match value {
        Value::Mapping(mapping) => {
            let entries = mapping
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        key.as_str().unwrap(),
                        flow(&serde_norway::to_string(value).unwrap())
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", entries.join(", "))
        }
        Value::Sequence(items) => {
            let items = items
                .iter()
                .map(|item| flow(&serde_norway::to_string(item).unwrap()))
                .collect::<Vec<_>>();
            format!("[{}]", items.join(", "))
        }
        _ => text.trim().to_string(),
    }
}

fn expected(
    removed: &[&str],
    renamed: &[(&str, &str)],
    added: &[(&str, &str)],
) -> BTreeMap<String, String> {
    let mut keys = TASKS_KEYS
        .iter()
        .filter(|(path, _)| !removed.iter().any(|prefix| path.starts_with(prefix)))
        .map(|(path, value)| {
            let path = renamed
                .iter()
                .find(|(from, _)| path.starts_with(from))
                .map(|(from, to)| path.replacen(from, to, 1))
                .unwrap_or_else(|| path.to_string());
            (path, value.to_string())
        })
        .collect::<BTreeMap<_, _>>();
    for (path, value) in added {
        keys.insert(path.to_string(), value.to_string());
    }
    keys
}

fn all_keys() -> BTreeMap<String, String> {
    expected(&[], &[], &[])
}

fn text_column(name: &str) -> Column {
    serde_norway::from_str(&format!("name: {name}\ntype: text\nx_input: dropped\n")).unwrap()
}

#[test]
fn reading_keeps_unknown_keys_in_the_model_and_leaves_the_file() {
    let fixture = Fixture::new();
    let schema = read_collection_schema(&fixture.space, "tasks").unwrap();
    assert_eq!(fixture.raw("tasks"), TASKS);
    assert_eq!(
        schema.unknown_keys.get("x_root").unwrap()["nested"][1],
        Value::from(2.5)
    );
    assert!(!schema.unknown_keys.contains_key("document"));
    assert_eq!(
        schema.views[0].unknown_keys().get("x_view"),
        Some(&Value::from("v1"))
    );
}

#[test]
fn unknown_keys_go_to_json_responses_as_additional_fields() {
    let fixture = Fixture::new();
    let schema = read_collection_schema(&fixture.space, "tasks").unwrap();
    let json = serde_json::to_value(&schema).unwrap();
    assert_eq!(json["x_root"]["nested"][2], "text");
    assert_eq!(json["columns"][1]["x_column"], 7);
    assert_eq!(json["columns"][1]["options"][0]["x_option"], "o1");
    assert_eq!(json["columns"][2]["relation_scope"]["x_scope"], "s1");
    assert_eq!(json["columns"][3]["relation_scope"]["type"], "root");
    assert_eq!(json["views"][0]["filter"][0]["x_filter"], "f1");
    assert_eq!(json["views"][0]["sort"][0]["x_sort"], "s1");
    assert_eq!(json["system_fields"]["title"]["x_title"], "kept");
}

#[test]
fn column_writes_keep_unknown_keys_and_drop_those_of_the_input() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    add_schema_column(space, "tasks", text_column("Extra")).unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    rename_schema_column(space, "tasks", "Notes", "Comments").unwrap();
    let renamed = [("columns.Notes", "columns.Comments")];
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    update_schema_column(
        space,
        "tasks",
        "Status",
        serde_norway::from_str(
            "options:\n  - { name: Done, group: done, x_input: dropped }\n  - { name: Todo, group: todo }\n  - { name: New, group: todo, x_input: dropped }\n",
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    change_schema_type(space, "tasks", "Comments", PropertyType::Number, None).unwrap();
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    delete_schema_column(space, "tasks", "Comments", false).unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["columns.Notes"], &[], &[])
    );
}

#[test]
fn relation_scope_patch_keeps_keys_of_the_same_target_only() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    update_schema_column(
        space,
        "tasks",
        "Owner",
        serde_json::from_value(serde_json::json!({
            "relation_scope": { "type": "space", "id": "people-space", "x_input": "dropped" }
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    update_schema_column(
        space,
        "tasks",
        "Owner",
        serde_json::from_value(serde_json::json!({ "relation_scope": "root" })).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["columns.Owner.relation_scope"], &[], &[])
    );
}

#[test]
fn option_writes_keep_unknown_keys_and_drop_those_of_the_input() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let option: PropertyOption =
        serde_norway::from_str("name: Later\ngroup: todo\nx_input: dropped\n").unwrap();

    add_option(space, "tasks", "Status", option).unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    rename_option(space, "tasks", "Status", "Done", "Closed").unwrap();
    let renamed = [(
        "columns.Status.options.Done",
        "columns.Status.options.Closed",
    )];
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    update_option(
        space,
        "tasks",
        "Status",
        "Closed",
        None,
        Some(serde_norway::from_str("color: red\nx_input: dropped\n").unwrap()),
    )
    .unwrap();
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    delete_option(space, "tasks", "Status", "Closed", false).unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["columns.Status.options.Done"], &[], &[])
    );
}

#[test]
fn view_writes_keep_unknown_keys_and_drop_those_of_the_input() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let view: View = serde_norway::from_str(
        "name: List\ntype: list\nx_input: dropped\nfilter:\n  - { field: Status, op: eq, value: Done, x_input: dropped }\n",
    )
    .unwrap();

    add_view(space, "tasks", view, None).unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    rename_view(space, "tasks", "All", "Everything").unwrap();
    let renamed = [("views.All", "views.Everything")];
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    reorder_views(
        space,
        "tasks",
        vec!["List".into(), "Board".into(), "Everything".into()],
    )
    .unwrap();
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &[]));

    duplicate_view(space, "tasks", "Board", "Board copy").unwrap();
    let copied = [("views.Board copy.x_view", "v2")];
    assert_eq!(fixture.keys("tasks"), expected(&[], &renamed, &copied));

    delete_view(space, "tasks", "Board").unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["views.Board.x_view"], &renamed, &copied)
    );
}

#[test]
fn view_patch_neither_adds_nor_removes_unknown_keys() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    // The patch sends the stored filter back and adds a new one, replaces the
    // sort with the same one and tries to set and to remove unknown keys.
    update_view(
        space,
        "tasks",
        "All",
        serde_json::from_value(serde_json::json!({
            "x_view": null,
            "x_input": "dropped",
            "filter": [
                { "field": "Status", "op": "eq", "value": "Todo", "x_input": "dropped" },
                { "field": "title", "op": "contains", "value": "a", "x_input": "dropped" }
            ],
            "sort": [{ "field": "title" }],
            "visible_fields": ["title", "Status"]
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    // A changed filter is input: its unknown keys go with the old filter.
    update_view(
        space,
        "tasks",
        "All",
        serde_json::from_value(serde_json::json!({
            "filter": [{ "field": "Status", "op": "eq", "value": "Done" }],
            "sort": null
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["views.All.filter", "views.All.sort"], &[], &[])
    );

    // A view kind change keeps the view's own unknown keys.
    update_view(
        space,
        "tasks",
        "Board",
        serde_json::from_value(serde_json::json!({ "type": "list" })).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fixture.keys("tasks"),
        expected(&["views.All.filter", "views.All.sort"], &[], &[])
    );
}

#[test]
fn template_and_title_label_writes_keep_unknown_keys() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    set_default_template(space, "tasks", None).unwrap();
    reorder_templates(space, "tasks", vec!["basic".into()]).unwrap();
    update_system_field_label(space, "tasks", "title", Some("Task".into())).unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());

    // Without a label the title override stays for its unknown key.
    let schema = update_system_field_label(space, "tasks", "title", None).unwrap();
    assert_eq!(fixture.keys("tasks"), all_keys());
    let title = schema.system_fields.unwrap().title.unwrap();
    assert_eq!(title.label, None);
    assert!(!fixture.raw("tasks").contains("label: Name"));
}

#[test]
fn unique_id_allocations_keep_unknown_keys() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();

    let created = entry::create(space, Some("tasks"), "First").unwrap();
    assert!(fixture.raw("tasks").contains("next: 2"));
    assert_eq!(fixture.keys("tasks"), all_keys());

    entry::duplicate_entry(Path::new(space), &created.path).unwrap();
    assert!(fixture.raw("tasks").contains("next: 3"));
    assert_eq!(fixture.keys("tasks"), all_keys());

    fs::write(
        fixture.path("Loose.md"),
        "---\ntitle: Loose\ncreated: now\nupdated: now\n---\n",
    )
    .unwrap();
    entry::move_entry(Path::new(space), "Loose.md", "tasks", None).unwrap();
    assert!(fixture.raw("tasks").contains("next: 4"));
    assert_eq!(fixture.keys("tasks"), all_keys());
}

#[test]
fn two_way_reverse_column_and_collection_rename_keep_unknown_keys() {
    let fixture = Fixture::new();
    let space = fixture.space.as_str();
    let mut relation: Column =
        serde_norway::from_str("name: Tasks\ntype: relation\nrelation: tasks\ntwo_way: People\n")
            .unwrap();
    relation
        .unknown_keys
        .insert("x_input".into(), "dropped".into());

    add_schema_column(space, "people", relation).unwrap();
    assert!(fixture.raw("tasks").contains("two_way: Tasks"));
    assert_eq!(fixture.keys("tasks"), all_keys());
    assert!(fixture.keys("people").is_empty());

    // Renaming `people` rewrites the relation targets in the `tasks` schema.
    entry::rename(space, "people", "team").unwrap();
    let tasks = fixture.raw("tasks");
    assert!(tasks.contains("relation: team"), "{tasks}");
    assert_eq!(fixture.keys("tasks"), all_keys());
}

#[test]
fn created_collection_schema_takes_no_unknown_keys_from_input() {
    let fixture = Fixture::new();
    let mut schema: CollectionSchema = serde_norway::from_str(TASKS).unwrap();
    // Relations need their targets beside the new Collection.
    schema
        .columns
        .retain(|column| column.type_ != PropertyType::Relation);
    prepare_initial_collection_schema(&fixture.space, "fresh", schema, None)
        .unwrap()
        .apply()
        .unwrap();
    let raw = fixture.raw("fresh");
    assert!(fixture.keys("fresh").is_empty(), "{raw}");
}

#[test]
fn schema_without_unknown_keys_is_written_as_before() {
    // Golden output of the writer before DF-244: known keys in model order,
    // absent optional fields omitted, the root scope as a plain string.
    const SCHEMA: &str = r#"system_fields:
  title:
    label: Name
templates:
  default: basic
  order:
  - basic
  - bug
columns:
- name: ID
  type: unique_id
  prefix: T
  next: 3
- name: Status
  type: status
  options:
  - name: Todo
    color: blue
    group: todo
  - name: Done
    group: done
- name: Estimate
  type: number
  display: bar
  min: 0.0
  max: 10.5
- name: Owner
  type: relation
  relation: people
  relation_scope: root
  limit: one
- name: Team
  type: relation
  relation: people
  relation_scope:
    type: space
    id: team
- name: Due
  type: date
  time_by_default: true
- name: Email
  type: email
  sensitivity: pii
views:
- type: table
  name: All
  filter:
  - field: Status
    op: in
    values:
    - Todo
    - Done
  sort:
  - field: Due
    desc: true
  visible_fields:
  - title
  - Status
- type: board
  name: Board
  group_by: Status
  card_fields:
  - title
- type: gallery
  name: Gallery
  card_cover:
  - cover
  - icon
  - title
  size: large
"#;
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.path("golden")).unwrap();
    fs::write(fixture.path("golden").join(SCHEMA_FILE), SCHEMA).unwrap();
    let schema = read_collection_schema(&fixture.space, "golden").unwrap();
    write_collection_schema(&fixture.space, "golden", &schema).unwrap();
    assert_eq!(fixture.raw("golden"), SCHEMA);
}
