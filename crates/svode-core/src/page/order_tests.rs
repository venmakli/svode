//! `.svode/order.json` keeps the place of its sections on every write path.

use std::fs;
use std::path::Path;
use std::process::Command;

use crate::collections::engine::write_default_collection_schema;
use crate::content_tree::{list_tree_children, reorder_content};
use crate::page::entry;
use crate::page::templates::{self, TemplateKind};
use indexmap::IndexMap;

const ORDER: &[(&str, &[&str])] = &[
    ("zeta", &["z2.md", "z1.md", "deep"]),
    (".", &["zeta", "alpha", "notes.md", "solo", "beta"]),
    ("beta/sub", &["s.md"]),
    ("solo", &[]),
    ("alpha", &["a2.md", "a1.md"]),
    ("zeta/deep", &["d.md"]),
    ("beta", &["sub", "b.md"]),
];

fn page(root: &Path, path: &str, title: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("---\ntitle: {title}\n---\n")).unwrap();
}

fn write_order(root: &Path, sections: &[(&str, &[&str])]) {
    let order = sections
        .iter()
        .map(|(key, names)| {
            let names = names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>();
            (key.to_string(), names)
        })
        .collect::<IndexMap<_, _>>();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/order.json"),
        serde_json::to_string_pretty(&order).unwrap(),
    )
    .unwrap();
}

fn read_order(root: &Path) -> String {
    fs::read_to_string(root.join(".svode/order.json")).unwrap()
}

fn fixture() -> tempfile::TempDir {
    let space = tempfile::tempdir().unwrap();
    let root = space.path();
    for (path, title) in [
        ("notes.md", "Notes"),
        ("alpha/README.md", "Alpha"),
        ("alpha/a1.md", "A1"),
        ("alpha/a2.md", "A2"),
        ("beta/README.md", "Beta"),
        ("beta/b.md", "B"),
        ("beta/sub/README.md", "Sub"),
        ("beta/sub/s.md", "S"),
        ("solo/README.md", "Solo"),
        ("zeta/README.md", "Zeta"),
        ("zeta/z1.md", "Z1"),
        ("zeta/z2.md", "Z2"),
        ("zeta/deep/README.md", "Deep"),
        ("zeta/deep/d.md", "D"),
    ] {
        page(root, path, title);
    }
    write_order(root, ORDER);
    space
}

/// The section key of every line of a pretty-printed order file, `None` for
/// the enclosing braces.
fn line_sections(data: &str) -> Vec<(Option<String>, &str)> {
    let mut current = None;
    data.lines()
        .map(|line| {
            if let Some(rest) = line.strip_prefix("  \"") {
                current = rest.split("\": [").next().map(str::to_string);
            }
            let owner = if line == "{" || line == "}" {
                None
            } else {
                current.clone()
            };
            (owner, line)
        })
        .collect()
}

/// Lines of `before` and `after` outside their longest common subsequence.
fn changed_lines<'a>(
    before: &'a [(Option<String>, &'a str)],
    after: &'a [(Option<String>, &'a str)],
) -> Vec<&'a (Option<String>, &'a str)> {
    let (n, m) = (before.len(), after.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if before[i].1 == after[j].1 {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut changed = Vec::new();
    while i < n || j < m {
        if i < n && j < m && before[i].1 == after[j].1 {
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            changed.push(&after[j]);
            j += 1;
        } else {
            changed.push(&before[i]);
            i += 1;
        }
    }
    changed
}

fn section_keys(data: &str) -> Vec<String> {
    serde_json::from_str::<IndexMap<String, Vec<String>>>(data)
        .unwrap()
        .into_keys()
        .collect()
}

/// Run `operation` on the fixture and check that the sections come out as
/// `expected_keys` and that the line diff touches only `affected` sections,
/// besides the closing bracket of a neighbour when the last section changes.
fn assert_order_change(
    setup: impl FnOnce(&Path),
    operation: impl FnOnce(&Path),
    expected_keys: &[&str],
    affected: &[&str],
) -> String {
    let space = fixture();
    let root = space.path();
    setup(root);
    let before = read_order(root);
    operation(root);
    let after = read_order(root);

    assert_eq!(section_keys(&after), expected_keys, "{after}");
    let before_lines = line_sections(&before);
    let after_lines = line_sections(&after);
    let changed = changed_lines(&before_lines, &after_lines);
    assert!(!changed.is_empty(), "the operation changed no order line");
    for (owner, line) in changed {
        let bracket = line.trim() == "]" || line.trim() == "],";
        let affected_owner = owner
            .as_deref()
            .is_some_and(|owner| affected.contains(&owner));
        assert!(
            affected_owner || bracket,
            "line {line:?} of section {owner:?} changed:\n{before}\n---\n{after}"
        );
    }
    after
}

const KEYS: &[&str] = &[
    "zeta",
    ".",
    "beta/sub",
    "solo",
    "alpha",
    "zeta/deep",
    "beta",
];

fn space_str(root: &Path) -> &str {
    root.to_str().unwrap()
}

#[test]
fn creating_a_page_changes_only_its_parent_section() {
    assert_order_change(
        |_| {},
        |root| {
            entry::create(space_str(root), Some("alpha"), "Created").unwrap();
        },
        KEYS,
        &["alpha"],
    );
}

#[test]
fn creating_a_folder_and_its_first_page_inserts_the_new_section_by_key() {
    assert_order_change(
        |_| {},
        |root| {
            entry::create_folder(space_str(root), Some("beta"), "fresh").unwrap();
            entry::create(space_str(root), Some("beta/fresh"), "Inner").unwrap();
        },
        &[
            "beta/fresh",
            "zeta",
            ".",
            "beta/sub",
            "solo",
            "alpha",
            "zeta/deep",
            "beta",
        ],
        &["beta", "beta/fresh"],
    );
}

#[test]
fn renaming_a_page_changes_only_its_parent_section() {
    assert_order_change(
        |_| {},
        |root| entry::rename(space_str(root), "alpha/a1.md", "alpha/a3.md").unwrap(),
        KEYS,
        &["alpha"],
    );
}

#[test]
fn renaming_a_folder_keeps_its_nested_sections_in_place() {
    let after = assert_order_change(
        |_| {},
        |root| entry::rename(space_str(root), "zeta", "omega").unwrap(),
        &[
            "omega",
            ".",
            "beta/sub",
            "solo",
            "alpha",
            "omega/deep",
            "beta",
        ],
        &[".", "zeta", "omega", "zeta/deep", "omega/deep"],
    );
    let order = serde_json::from_str::<IndexMap<String, Vec<String>>>(&after).unwrap();
    assert_eq!(order["omega"], ["z2.md", "z1.md", "deep"]);
    assert_eq!(order["."][0], "omega");
}

#[test]
fn moving_a_folder_keeps_its_nested_sections_in_place() {
    assert_order_change(
        |_| {},
        |root| {
            entry::move_entry_with_project(root, "beta", "alpha", None, None).unwrap();
        },
        &[
            "zeta",
            ".",
            "alpha/beta/sub",
            "solo",
            "alpha",
            "zeta/deep",
            "alpha/beta",
        ],
        &[
            ".",
            "alpha",
            "beta",
            "beta/sub",
            "alpha/beta",
            "alpha/beta/sub",
        ],
    );
}

#[test]
fn nesting_a_page_changes_only_its_parent_section() {
    assert_order_change(
        |_| {},
        |root| {
            entry::convert_entry_to_folder(root, "notes.md", None).unwrap();
        },
        KEYS,
        &["."],
    );
}

#[test]
fn converting_a_folder_to_a_leaf_removes_its_section_without_moving_others() {
    assert_order_change(
        |_| {},
        |root| {
            entry::convert_entry_to_leaf(root, "solo/README.md", None).unwrap();
        },
        &["zeta", ".", "beta/sub", "alpha", "zeta/deep", "beta"],
        &[".", "solo"],
    );
}

#[test]
fn duplicating_a_page_changes_only_its_parent_section() {
    assert_order_change(
        |_| {},
        |root| {
            entry::duplicate_entry(root, "alpha/a1.md").unwrap();
        },
        KEYS,
        &["alpha"],
    );
}

#[test]
fn deleting_a_folder_removes_its_nested_sections_without_moving_others() {
    assert_order_change(
        |_| {},
        |root| {
            entry::delete(space_str(root), "zeta/README.md", None).unwrap();
        },
        &[".", "beta/sub", "solo", "alpha", "beta"],
        &[".", "zeta", "zeta/deep"],
    );
}

#[test]
fn instantiating_a_template_changes_only_its_parent_section() {
    assert_order_change(
        |root| {
            write_default_collection_schema(space_str(root), "alpha").unwrap();
            templates::create(space_str(root), "alpha", "Template", TemplateKind::Leaf).unwrap();
        },
        |root| {
            templates::instantiate(
                space_str(root),
                "alpha",
                "template",
                "alpha",
                Some("From template".into()),
                false,
                false,
                None,
            )
            .unwrap();
        },
        KEYS,
        &["alpha"],
    );
}

#[test]
fn reordering_content_changes_only_its_section() {
    assert_order_change(
        |_| {},
        |root| {
            let ordered = list_tree_children(space_str(root), Some("alpha/README.md"))
                .unwrap()
                .into_iter()
                .rev()
                .map(|child| child.path)
                .collect();
            let outcome = reorder_content(space_str(root), "alpha/README.md", ordered).unwrap();
            assert!(outcome.changed);
        },
        KEYS,
        &["alpha"],
    );
}

#[test]
fn the_same_order_reached_by_different_operation_sequences_has_the_same_bytes() {
    let run = |first_alpha: bool| {
        let space = fixture();
        let root = space_str(space.path());
        let create_alpha = || {
            entry::create_folder(root, Some("alpha"), "x").unwrap();
            entry::create(root, Some("alpha/x"), "X").unwrap();
        };
        let create_beta = || {
            entry::create_folder(root, Some("beta"), "y").unwrap();
            entry::create(root, Some("beta/y"), "Y").unwrap();
        };
        if first_alpha {
            create_alpha();
            create_beta();
        } else {
            create_beta();
            create_alpha();
        }
        read_order(space.path())
    };
    let first = run(true);
    assert_eq!(first, run(false));
    assert_eq!(
        section_keys(&first)[..3],
        [
            "alpha/x".to_string(),
            "beta/y".to_string(),
            "zeta".to_string()
        ]
    );
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_GLOBAL", root.join("../no-global-config"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn order_changes_in_different_folders_on_two_branches_merge_without_conflict() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("space");
    for (path, title) in [
        ("alpha/README.md", "Alpha"),
        ("alpha/a1.md", "A1"),
        ("beta/README.md", "Beta"),
        ("beta/b1.md", "B1"),
        ("beta/b2.md", "B2"),
    ] {
        page(&root, path, title);
    }
    write_order(
        &root,
        &[
            ("beta", &["b1.md", "b2.md"]),
            (".", &["beta", "alpha"]),
            ("alpha", &["a1.md"]),
        ],
    );
    git(&root, &["-c", "init.defaultBranch=main", "init"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    git(&root, &["checkout", "-b", "a"]);
    let created = entry::create(space_str(&root), Some("alpha"), "Created").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "create in alpha"]);

    git(&root, &["checkout", "main"]);
    git(&root, &["checkout", "-b", "b"]);
    let outcome = reorder_content(
        space_str(&root),
        "beta/README.md",
        vec!["beta/b2.md".to_string(), "beta/b1.md".to_string()],
    )
    .unwrap();
    assert!(outcome.changed);
    git(&root, &["commit", "-am", "reorder beta"]);

    git(&root, &["merge", "--no-edit", "a"]);
    let order = serde_json::from_str::<IndexMap<String, Vec<String>>>(&read_order(&root)).unwrap();
    let created_name = Path::new(&created.path)
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(order["alpha"], ["a1.md", created_name]);
    assert_eq!(order["beta"], ["b2.md", "b1.md"]);
    assert_eq!(section_keys(&read_order(&root)), ["beta", ".", "alpha"]);
}
