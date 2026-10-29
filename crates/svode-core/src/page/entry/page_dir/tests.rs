//! Turning a folder Page into a leaf removes only the Page (DF-241).

use std::fs;
use std::path::Path;

use tempfile::TempDir;

use crate::page::PageError;
use crate::page::entry::{convert_entry_to_leaf, entry_detail_state, unnest_entry};

const ORDER: &str = "{\".\": [\"Doc\", \"Other.md\"], \"Doc\": []}";

/// A Space with the folder Page `Doc` and the extra files of `files`.
fn space_with_doc(files: &[(&str, &[u8])]) -> TempDir {
    let tmp = TempDir::new().unwrap();
    crate::page::test_support::scaffold_space(tmp.path(), "Root");
    fs::write(tmp.path().join(".svode/order.json"), ORDER).unwrap();
    fs::write(tmp.path().join("Other.md"), "---\ntitle: Other\n---\n").unwrap();
    write(
        tmp.path(),
        "Doc/README.md",
        b"---\ntitle: Doc\n---\nDoc body\n",
    );
    for (path, content) in files {
        write(tmp.path(), path, content);
    }
    tmp
}

fn write(root: &Path, path: &str, content: &[u8]) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// Every directory and file under `root`, with file contents.
fn snapshot(root: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    let mut items = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for item in fs::read_dir(&dir).unwrap() {
            let path = item.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            if path.is_dir() {
                items.push((rel, None));
                dirs.push(path);
            } else {
                items.push((rel, Some(fs::read(&path).unwrap())));
            }
        }
    }
    items.sort();
    items
}

fn not_empty(error: &PageError, folders: &[&str], other: &[&str]) -> bool {
    error.to_string()
        == format!("EntryNotEmpty {{ entries: [], folders: {folders:?}, other: {other:?} }}")
}

/// Each item of the directory that is not the Page itself, with the refusal
/// lists that name it.
const BLOCKING: &[(&[(&str, &[u8])], &[&str], &[&str])] = &[
    (&[("Doc/.hidden.txt", b"hidden")], &[], &[".hidden.txt"]),
    (&[("Doc/.notes/secret.txt", b"secret")], &[".notes"], &[]),
    (&[("Doc/.svode/config.json", b"{}")], &[".svode"], &[]),
    (
        &[("Doc/.git/HEAD", b"ref: refs/heads/main\n")],
        &[".git"],
        &[],
    ),
    (&[("Doc/.gitkeep", b"keep")], &[], &[".gitkeep"]),
    (&[("Doc/Thumbs.db", b"thumbs")], &[], &["Thumbs.db"]),
    (
        &[("Doc/desktop.ini", b"[.ShellClassInfo]")],
        &[],
        &["desktop.ini"],
    ),
    (&[("Doc/notes.txt", b"notes")], &[], &["notes.txt"]),
];

#[test]
fn every_item_besides_the_page_blocks_the_leaf_conversion_without_changes() {
    for (files, folders, other) in BLOCKING {
        let tmp = space_with_doc(files);
        let before = snapshot(tmp.path());

        let error = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap_err();

        assert!(not_empty(&error, folders, other), "{files:?}: {error}");
        assert_eq!(snapshot(tmp.path()), before, "{files:?}");
    }
}

#[test]
fn every_item_besides_the_page_blocks_unnest_without_changes() {
    for (files, _, _) in BLOCKING {
        let tmp = space_with_doc(files);
        let before = snapshot(tmp.path());

        let error = unnest_entry(tmp.path(), "Doc/README.md", None).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Folder still has children, cannot unnest",
            "{files:?}"
        );
        assert_eq!(snapshot(tmp.path()), before, "{files:?}");
    }
}

#[test]
fn the_root_of_a_child_space_is_not_turned_into_a_leaf() {
    let tmp = space_with_doc(&[
        ("Doc/.svode/config.json", b"{\"name\":\"Doc\"}"),
        ("Doc/.git/HEAD", b"ref: refs/heads/main\n"),
    ]);
    let before = snapshot(tmp.path());

    let error = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap_err();

    assert!(error.to_string().starts_with("EntryNotEmpty"), "{error}");
    assert_eq!(snapshot(tmp.path()), before);
}

#[test]
fn an_empty_gitkeep_goes_with_the_directory_of_a_new_leaf() {
    let tmp = space_with_doc(&[("Doc/.gitkeep", b"")]);

    let (entry, removed) = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap();

    assert_eq!(entry.path, "Doc.md");
    assert_eq!(removed, vec!["Doc/.gitkeep".to_string()]);
    assert!(!tmp.path().join("Doc").exists());
    assert!(
        fs::read_to_string(tmp.path().join("Doc.md"))
            .unwrap()
            .contains("Doc body")
    );
}

#[test]
fn an_empty_gitkeep_goes_with_the_directory_on_unnest() {
    let tmp = space_with_doc(&[("Doc/.gitkeep", b"")]);

    let (path, removed) = unnest_entry(tmp.path(), "Doc/README.md", None).unwrap();

    assert_eq!(path, "Doc.md");
    assert_eq!(removed, vec!["Doc/.gitkeep".to_string()]);
    assert!(!tmp.path().join("Doc").exists());
}

#[test]
fn finder_view_settings_go_with_the_directory_with_an_empty_gitkeep() {
    for unnest in [false, true] {
        let tmp = space_with_doc(&[("Doc/.gitkeep", b""), ("Doc/.DS_Store", b"finder")]);

        let mut removed = if unnest {
            unnest_entry(tmp.path(), "Doc/README.md", None).unwrap().1
        } else {
            convert_entry_to_leaf(tmp.path(), "Doc/README.md", None)
                .unwrap()
                .1
        };

        removed.sort();
        assert_eq!(
            removed,
            vec!["Doc/.DS_Store", "Doc/.gitkeep"],
            "unnest: {unnest}"
        );
        assert!(!tmp.path().join("Doc").exists(), "unnest: {unnest}");
        assert!(tmp.path().join("Doc.md").is_file(), "unnest: {unnest}");
    }
}

#[test]
fn finder_view_settings_are_restored_when_the_conversion_rolls_back() {
    let tmp = space_with_doc(&[("Doc/.DS_Store", b"finder")]);
    let before = snapshot(tmp.path());
    let late = tmp.path().join("Doc/late.txt");
    crate::page::write::inject_effect(
        "page_dir_remove",
        Box::new(move || fs::write(late, "late").unwrap()),
    );

    let error = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap_err();

    assert!(not_empty(&error, &[], &["late.txt"]), "{error}");
    let mut expected = before;
    expected.push(("Doc/late.txt".to_string(), Some(b"late".to_vec())));
    expected.sort();
    assert_eq!(snapshot(tmp.path()), expected);
}

#[test]
fn a_page_alone_in_its_directory_removes_nothing_else() {
    let tmp = space_with_doc(&[]);

    let (entry, removed) = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap();

    assert_eq!(entry.path, "Doc.md");
    assert!(removed.is_empty());
    assert!(!tmp.path().join("Doc").exists());
}

#[test]
fn an_item_that_appears_before_the_directory_is_removed_fails_the_conversion() {
    let tmp = space_with_doc(&[("Doc/.gitkeep", b"")]);
    let before = snapshot(tmp.path());
    let late = tmp.path().join("Doc/.late.txt");
    crate::page::write::inject_effect(
        "page_dir_remove",
        Box::new(move || fs::write(late, "late").unwrap()),
    );

    let error = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap_err();

    assert!(not_empty(&error, &[], &[".late.txt"]), "{error}");
    let mut expected = before;
    expected.push(("Doc/.late.txt".to_string(), Some(b"late".to_vec())));
    expected.sort();
    assert_eq!(snapshot(tmp.path()), expected);
}

#[test]
fn an_item_that_appears_before_the_directory_is_removed_fails_unnest() {
    let tmp = space_with_doc(&[("Doc/.gitkeep", b"")]);
    let before = snapshot(tmp.path());
    let late = tmp.path().join("Doc/late.md");
    crate::page::write::inject_effect(
        "page_dir_remove",
        Box::new(move || fs::write(late, "late").unwrap()),
    );

    let error = unnest_entry(tmp.path(), "Doc/README.md", None).unwrap_err();

    assert_eq!(
        error.to_string(),
        "Folder still has children, cannot unnest"
    );
    let mut expected = before;
    expected.push(("Doc/late.md".to_string(), Some(b"late".to_vec())));
    expected.sort();
    assert_eq!(snapshot(tmp.path()), expected);
}

#[test]
fn a_failed_restore_names_the_paths_left_changed() {
    let tmp = space_with_doc(&[("Doc/.gitkeep", b"")]);
    let gitkeep = tmp.path().join("Doc/.gitkeep");
    crate::page::write::inject_effect(
        "page_dir_remove",
        Box::new(move || fs::write(gitkeep, "concurrent").unwrap()),
    );

    let error = convert_entry_to_leaf(tmp.path(), "Doc/README.md", None).unwrap_err();

    match error {
        PageError::Recovery { paths, .. } => assert_eq!(paths, vec!["Doc/.gitkeep"]),
        other => panic!("expected recovery failure, got {other:?}"),
    }
    assert_eq!(
        fs::read_to_string(tmp.path().join("Doc/.gitkeep")).unwrap(),
        "concurrent"
    );
    assert!(tmp.path().join("Doc/README.md").is_file());
    assert!(!tmp.path().join("Doc.md").exists());
}

#[test]
fn the_page_detail_counts_hidden_items_but_not_service_files() {
    let tmp = space_with_doc(&[
        ("Doc/.gitkeep", b""),
        ("Doc/.hidden.txt", b"hidden"),
        ("Doc/.notes/secret.txt", b"secret"),
        ("Doc/Child.md", b"---\ntitle: Child\n---\n"),
    ]);

    let state = entry_detail_state(tmp.path(), "Doc/README.md").unwrap();

    assert_eq!(state.subpage_count, 1);
    assert_eq!(state.other_file_count, 2);

    let only_service = space_with_doc(&[("Doc/.gitkeep", b""), ("Doc/.DS_Store", b"finder")]);
    let state = entry_detail_state(only_service.path(), "Doc").unwrap();
    assert_eq!((state.subpage_count, state.other_file_count), (0, 0));
}
