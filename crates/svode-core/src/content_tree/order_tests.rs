use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use tempfile::TempDir;

use super::{replace_order, update_order};

fn order_path(space: &Path) -> std::path::PathBuf {
    space.join(".svode/order.json")
}

fn write_raw(space: &Path, data: &str) {
    fs::create_dir_all(space.join(".svode")).unwrap();
    fs::write(order_path(space), data).unwrap();
}

fn read_raw(space: &Path) -> String {
    fs::read_to_string(order_path(space)).unwrap()
}

fn section_keys(space: &Path) -> Vec<String> {
    let data = read_raw(space);
    let order: indexmap::IndexMap<String, Vec<String>> = serde_json::from_str(&data).unwrap();
    order.into_keys().collect()
}

fn children(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

const UNSORTED: &str = r#"{
  "b": [
    "b1.md"
  ],
  ".": [
    "b",
    "a"
  ],
  "a": [
    "a1.md"
  ]
}"#;

#[test]
fn a_changed_list_keeps_its_section_and_the_file_bytes_of_the_others() {
    let space = TempDir::new().unwrap();
    write_raw(space.path(), UNSORTED);

    update_order(space.path(), |order| {
        order.children_mut("a").push("a2.md".to_string());
        true
    })
    .unwrap();

    assert_eq!(
        read_raw(space.path()),
        r#"{
  "b": [
    "b1.md"
  ],
  ".": [
    "b",
    "a"
  ],
  "a": [
    "a1.md",
    "a2.md"
  ]
}"#
    );
}

#[test]
fn a_new_section_goes_before_the_first_section_with_a_greater_key() {
    let space = TempDir::new().unwrap();
    write_raw(space.path(), UNSORTED);

    update_order(space.path(), |order| {
        order.children_mut("a/x").push("x.md".to_string());
        order.children_mut("c").push("c.md".to_string());
        true
    })
    .unwrap();

    assert_eq!(section_keys(space.path()), ["a/x", "b", ".", "a", "c"]);
}

#[test]
fn new_sections_land_in_the_same_place_whatever_the_order_of_changes() {
    let keys = ["c", "a/x", "0", "b/y", "zz", ".hidden"];
    let mut results = Vec::new();
    for reversed in [false, true] {
        let space = TempDir::new().unwrap();
        write_raw(space.path(), UNSORTED);
        let mut ordered = keys.to_vec();
        if reversed {
            ordered.reverse();
        }
        update_order(space.path(), |order| {
            for key in ordered {
                order.children_mut(key).push("item.md".to_string());
            }
            true
        })
        .unwrap();
        results.push(read_raw(space.path()));
    }
    assert_eq!(results[0], results[1]);
}

#[test]
fn a_new_file_is_sorted_by_key_and_independent_runs_give_the_same_bytes() {
    let content = BTreeMap::from([
        ("z".to_string(), children(&["z.md"])),
        (".".to_string(), children(&["z", "a"])),
        ("a/b".to_string(), children(&["b.md"])),
        ("a".to_string(), children(&["b"])),
    ]);
    let mut results = Vec::new();
    for _ in 0..2 {
        let space = TempDir::new().unwrap();
        assert!(replace_order(space.path(), content.clone()).unwrap());
        assert_eq!(section_keys(space.path()), [".", "a", "a/b", "z"]);
        results.push(read_raw(space.path()));
    }
    assert_eq!(results[0], results[1]);
    assert!(!results[0].ends_with('\n'));
    assert!(results[0].starts_with("{\n  \".\": [\n    \"z\","));
}

#[test]
fn a_removed_section_shifts_nothing_and_a_rewrite_of_the_same_order_keeps_the_bytes() {
    let space = TempDir::new().unwrap();
    write_raw(space.path(), UNSORTED);

    update_order(space.path(), |order| order.remove(".").is_some()).unwrap();
    assert_eq!(section_keys(space.path()), ["b", "a"]);

    let written = read_raw(space.path());
    update_order(space.path(), |_| true).unwrap();
    assert_eq!(read_raw(space.path()), written);
}

#[test]
fn renamed_sections_take_the_place_of_the_old_keys() {
    let space = TempDir::new().unwrap();
    write_raw(
        space.path(),
        r#"{"b/deep": ["d.md"], ".": ["b"], "c": ["stale.md"], "b": ["deep"]}"#,
    );

    update_order(space.path(), |order| {
        order.rename_sections(|key| {
            (key == "b" || key.starts_with("b/")).then(|| format!("c{}", &key[1..]))
        })
    })
    .unwrap();

    let order = super::read_order(space.path());
    assert_eq!(section_keys(space.path()), ["c/deep", ".", "c"]);
    assert_eq!(order["c"], children(&["deep"]));
    assert_eq!(order["c/deep"], children(&["d.md"]));
}

#[test]
fn replacing_with_the_same_content_in_another_section_order_does_not_write() {
    let space = TempDir::new().unwrap();
    write_raw(space.path(), UNSORTED);
    let same = BTreeMap::from([
        (".".to_string(), children(&["b", "a"])),
        ("a".to_string(), children(&["a1.md"])),
        ("b".to_string(), children(&["b1.md"])),
    ]);

    assert!(!replace_order(space.path(), same.clone()).unwrap());
    assert_eq!(read_raw(space.path()), UNSORTED);

    let mut changed = same;
    changed.insert(".".to_string(), children(&["a", "b"]));
    changed.remove("a");
    changed.insert("c".to_string(), children(&["c.md"]));
    assert!(replace_order(space.path(), changed).unwrap());
    assert_eq!(
        read_raw(space.path()),
        r#"{
  "b": [
    "b1.md"
  ],
  ".": [
    "a",
    "b"
  ],
  "c": [
    "c.md"
  ]
}"#
    );
}

#[test]
fn backslash_keys_are_normalized_in_place() {
    let space = TempDir::new().unwrap();
    write_raw(
        space.path(),
        r#"{"b": [], "a\\x": ["x.md"], ".": ["a", "b"]}"#,
    );

    update_order(space.path(), |order| {
        order.children_mut("b").push("b.md".to_string());
        true
    })
    .unwrap();

    assert_eq!(section_keys(space.path()), ["b", "a/x", "."]);
}
