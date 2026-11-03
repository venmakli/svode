use super::*;
use crate::page::test_support::scaffold_space;
use std::fs;
use tempfile::TempDir;

fn item(title: &str, key: u64) -> String {
    format!("---\ntitle: {title}\nKey: {key}\n---\n")
}

/// A project whose Collection `tasks` holds 3 at `a.md`, `b.md` and
/// `c.md` and 4 at `d.md` and `e.md`, and whose inline child Space `team`
/// holds 2 twice in its Collection `bugs`.
fn fixture() -> TempDir {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    scaffold_space(root, "Project");
    scaffold_space(&root.join("team"), "Team");
    let config = root.join(".svode/config.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
    value["spaces"] = serde_json::json!([{ "id": "team", "path": "team" }]);
    fs::write(&config, value.to_string()).unwrap();
    for (path, content) in [
        (
            "tasks/schema.yaml",
            "columns:\n  - { name: Key, type: unique_id, prefix: T, next: 5 }\nviews: []\n".into(),
        ),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n".into()),
        ("tasks/a.md", item("A", 3)),
        ("tasks/b.md", item("B", 3)),
        ("tasks/c.md", item("C", 3)),
        ("tasks/d.md", item("D", 4)),
        ("tasks/e.md", item("E", 4)),
        (
            "team/bugs/schema.yaml",
            "columns:\n  - { name: Id, type: unique_id, next: 3 }\nviews: []\n".into(),
        ),
        ("team/bugs/x.md", "---\ntitle: X\nId: 2\n---\n".into()),
        ("team/bugs/y.md", "---\ntitle: Y\nId: 2\n---\n".into()),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    temp
}

fn published(sources: &[(&str, String)]) -> HashMap<String, String> {
    sources
        .iter()
        .map(|(path, source)| (path.to_string(), source.clone()))
        .collect()
}

fn read(root: &Path, path: &str) -> String {
    fs::read_to_string(root.join(path)).unwrap()
}

#[test]
fn the_repeats_of_the_repository_include_its_inline_child_spaces() {
    let temp = fixture();

    let repeats = repeats_in_repository(temp.path());

    let found: Vec<(String, Vec<String>)> = repeats
        .iter()
        .map(|repeat| (repeat.schema_path(), repeat.item_paths().collect()))
        .collect();
    assert_eq!(
        found,
        [
            (
                "tasks/schema.yaml".to_owned(),
                [
                    "tasks/a.md",
                    "tasks/b.md",
                    "tasks/c.md",
                    "tasks/d.md",
                    "tasks/e.md"
                ]
                .map(str::to_owned)
                .to_vec()
            ),
            (
                "team/bugs/schema.yaml".to_owned(),
                ["team/bugs/x.md", "team/bugs/y.md"]
                    .map(str::to_owned)
                    .to_vec()
            ),
        ]
    );
}

#[test]
fn the_published_item_keeps_its_number_and_the_others_are_renumbered_by_path() {
    let temp = fixture();
    let repeats = repeats_in_repository(temp.path());
    // `b.md` holds 3 upstream; 4 is upstream at `d.md` and `e.md`, and
    // `team/bugs` has neither of its items upstream.
    let upstream = published(&[
        ("tasks/b.md", item("B", 3)),
        ("tasks/d.md", item("D", 4)),
        ("tasks/e.md", item("E", 4)),
    ]);

    let renumbered = renumber(&repeats, &upstream, &BTreeSet::new());

    assert_eq!(renumbered.len(), 1);
    let tasks = &renumbered[0];
    assert_eq!(tasks.schema_path, "tasks/schema.yaml");
    assert_eq!(tasks.next, 7);
    let items: Vec<(&str, &str, &str, &str)> = tasks
        .items
        .iter()
        .map(|item| {
            (
                item.item.path.as_str(),
                item.item.collection.as_str(),
                item.item.from.as_str(),
                item.item.to.as_str(),
            )
        })
        .collect();
    assert_eq!(
        items,
        [
            ("tasks/a.md", "Tasks", "T-3", "T-5"),
            ("tasks/c.md", "Tasks", "T-3", "T-6"),
        ]
    );
    let root = temp.path();
    assert_eq!(read(root, "tasks/a.md"), item("A", 5));
    assert_eq!(read(root, "tasks/b.md"), item("B", 3));
    assert_eq!(read(root, "tasks/c.md"), item("C", 6));
    assert_eq!(read(root, "tasks/d.md"), item("D", 4));
    assert_eq!(read(root, "team/bugs/x.md"), "---\ntitle: X\nId: 2\n---\n");
}

#[test]
fn a_held_item_and_a_number_published_with_another_value_stay() {
    let temp = fixture();
    let repeats = repeats_in_repository(temp.path());
    // `a.md` holds another number upstream; `c.md` is in conflict.
    let upstream = published(&[("tasks/a.md", item("A", 1)), ("tasks/b.md", item("B", 3))]);
    let held = BTreeSet::from(["tasks/c.md".to_owned()]);

    let renumbered = renumber(&repeats, &upstream, &held);

    let paths: Vec<&str> = renumbered
        .iter()
        .flat_map(|collection| &collection.items)
        .map(|item| item.item.path.as_str())
        .collect();
    assert_eq!(paths, ["tasks/a.md"]);
    assert_eq!(read(temp.path(), "tasks/c.md"), item("C", 3));
}

#[test]
fn index_versions_change_only_the_number_and_next() {
    let source = "---\ntitle: A\nKey: 3\nStatus: Open\n---\nBody\n";
    let changed = item_source_with_number(source, "Key", 7).unwrap();
    assert_eq!(source_number(&changed, "Key"), Some(7));
    assert!(changed.contains("Status: Open") && changed.ends_with("Body\n"));
    assert_eq!(
        item_source_with_number("---\ntitle: [\n---\n", "Key", 7),
        None
    );

    let schema = "columns:\n- name: Key\n  type: unique_id\n  prefix: T\n  next: 4\nviews: []\n";
    assert_eq!(
        schema_source_with_next(schema, "Key", 6).unwrap(),
        schema.replace("next: 4", "next: 6")
    );
    assert_eq!(
        schema_source_with_next(schema, "Key", 2).unwrap(),
        schema,
        "next never goes down"
    );
    assert_eq!(schema_source_with_next(schema, "Other", 6), None);
}
