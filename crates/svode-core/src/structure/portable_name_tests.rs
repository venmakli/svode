//! An operation that creates or moves a named item refuses a sibling that
//! takes the name portably, before its first write, on every file system
//! (DF-242). The sibling differs in case or Unicode normalization only, so a
//! case-insensitive or normalization-insensitive file system already refuses
//! these cases: the decisive run is a case- and normalization-sensitive one
//! such as Linux ext4.

use std::fs;
use std::path::Path;

use tempfile::TempDir;

use crate::index::state::IndexRuntimeState;
use crate::page::PageError;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::test_support::{scaffold_space, update_state};

use super::ops::StructureRuntime;

/// A name and a sibling that takes it portably: another case, and NFC
/// against NFD.
const NAMES: [(&str, &str); 2] = [("Tasks", "tasks"), ("Caf\u{e9}", "Cafe\u{301}")];

fn runtime(index: &IndexRuntimeState) -> StructureRuntime<'_, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits: None,
    }
}

/// A Space with `files` and a sidebar order naming its top-level entries.
fn space(files: &[(String, &str)], order: &str) -> TempDir {
    let tmp = TempDir::new().unwrap();
    scaffold_space(tmp.path(), "Root");
    fs::create_dir_all(tmp.path().join(".git")).unwrap();
    fs::write(tmp.path().join(".svode/order.json"), order).unwrap();
    for (path, content) in files {
        let path = tmp.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    tmp
}

/// Every file and directory of the tree with its bytes, except the write
/// lock a create takes.
fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut items = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for item in fs::read_dir(&dir).unwrap() {
            let path = item.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            if rel == ".svode/write.lock" {
                continue;
            }
            if path.is_dir() {
                items.push((rel, Vec::new()));
                dirs.push(path);
            } else {
                items.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    items.sort();
    items
}

fn assert_refused<T: std::fmt::Debug>(
    result: Result<T, PageError>,
    root: &Path,
    before: &[(String, Vec<u8>)],
    operation: &str,
) {
    assert!(
        matches!(result, Err(PageError::FileAlreadyExists(_))),
        "{operation}: {result:?}"
    );
    assert_eq!(tree(root), before, "{operation} changed the tree");
}

/// The leaf `<name>.md` beside the folder `<sibling>/` with an item.
fn leaf_beside_folder(name: &str, sibling: &str) -> TempDir {
    space(
        &[
            (format!("{name}.md"), "---\ntitle: Leaf\n---\nLeaf body\n"),
            (format!("{sibling}/Ship.md"), "---\ntitle: Ship\n---\n"),
        ],
        &format!("{{\".\": [\"{name}.md\", \"{sibling}\"]}}"),
    )
}

#[tokio::test]
async fn turning_a_leaf_into_a_folder_refuses_a_portably_equal_sibling() {
    for (name, sibling) in NAMES {
        let leaf = format!("{name}.md");
        for operation in [
            "convert_to_folder",
            "convert_to_collection",
            "nest",
            "create_page",
            "create_collection",
            "import_asset",
        ] {
            let tmp = leaf_beside_folder(name, sibling);
            let root = tmp.path();
            let space = root.to_str().unwrap();
            let before = tree(root);
            let state = IndexRuntimeState::default();
            let result: Result<(), PageError> = match operation {
                "convert_to_folder" => {
                    super::convert_to_folder(space, &leaf, None, runtime(&state))
                        .await
                        .map(drop)
                }
                "convert_to_collection" => {
                    super::convert_to_collection(space, &leaf, None, runtime(&state))
                        .await
                        .map(drop)
                }
                "nest" => super::nest(space, &leaf, None, runtime(&state))
                    .await
                    .map(drop),
                "create_page" => create_page(space, &leaf, &state).await,
                "create_collection" => create_collection(space, &leaf, &state).await,
                _ => plan_import(root, &leaf, &state).await,
            };
            assert_refused(result, root, &before, &format!("{operation} {name:?}"));
        }
    }
}

async fn create_page(
    space: &str,
    parent: &str,
    state: &IndexRuntimeState,
) -> Result<(), PageError> {
    crate::page::create::create(
        crate::page::create::PageCreate {
            space: space.to_string(),
            parent_path: Some(parent.to_string()),
            title: "Child".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            properties: None,
            contextual_defaults: false,
            allocate_unique_title: false,
            as_readme: false,
            project: None,
            publish_projection: false,
        },
        state,
        update_state(),
        None::<&SystemGitDateExecutor>,
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await
    .map(drop)
}

async fn create_collection(
    space: &str,
    parent: &str,
    state: &IndexRuntimeState,
) -> Result<(), PageError> {
    super::create_collection(
        super::CollectionCreate {
            space: space.to_string(),
            parent_path: Some(parent.to_string()),
            title: "Coll".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: crate::collections::engine::default_collection_schema(),
            allocate_unique_title: false,
            project: None,
        },
        runtime(state),
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await
    .map(drop)
}

async fn plan_import(root: &Path, leaf: &str, state: &IndexRuntimeState) -> Result<(), PageError> {
    let source_dir = TempDir::new().unwrap();
    let source = source_dir.path().join("photo.png");
    fs::write(&source, b"image").unwrap();
    crate::attachments::import::plan_managed_import(state, root, None, leaf, &source, None)
        .await
        .map(drop)
}

#[tokio::test]
async fn turning_a_folder_page_into_a_leaf_refuses_a_portably_equal_sibling() {
    for (name, sibling) in NAMES {
        for unnest in [false, true] {
            let tmp = space(
                &[
                    (
                        format!("{name}/README.md"),
                        "---\ntitle: Doc\n---\nDoc body\n",
                    ),
                    (format!("{sibling}.md"), "---\ntitle: Other\n---\n"),
                ],
                &format!("{{\".\": [\"{name}\", \"{sibling}.md\"], \"{name}\": []}}"),
            );
            let root = tmp.path();
            let space = root.to_str().unwrap();
            let readme = format!("{name}/README.md");
            let before = tree(root);
            let state = IndexRuntimeState::default();
            let result = if unnest {
                super::unnest(space, &readme, None, runtime(&state))
                    .await
                    .map(drop)
            } else {
                super::convert_to_leaf(space, &readme, None, runtime(&state))
                    .await
                    .map(drop)
            };
            let operation = if unnest { "unnest" } else { "convert_to_leaf" };
            assert_refused(result, root, &before, &format!("{operation} {name:?}"));
        }
    }
}

#[tokio::test]
async fn moving_into_another_parent_refuses_a_portably_equal_sibling() {
    for (name, sibling) in NAMES {
        for (source, taken) in [
            (format!("x/{name}.md"), format!("y/{sibling}.md")),
            (format!("x/{name}/Note.md"), format!("y/{sibling}/Other.md")),
        ] {
            let tmp = space(
                &[
                    (source.clone(), "---\ntitle: Moved\n---\n"),
                    (taken, "---\ntitle: Taken\n---\n"),
                ],
                "{\".\": [\"x\", \"y\"]}",
            );
            let root = tmp.path();
            let from = source.strip_suffix("/Note.md").unwrap_or(&source);
            let before = tree(root);
            let state = IndexRuntimeState::default();
            let result =
                super::move_entry(root.to_str().unwrap(), from, "y", None, runtime(&state)).await;
            assert_refused(result, root, &before, &format!("move {from:?}"));
        }
    }
}

#[test]
fn a_new_folder_refuses_a_portably_equal_sibling() {
    for (name, sibling) in NAMES {
        for parent in [None, Some("area")] {
            let taken = match parent {
                Some(parent) => format!("{parent}/{sibling}/Note.md"),
                None => format!("{sibling}/Note.md"),
            };
            let tmp = space(&[(taken, "---\ntitle: Note\n---\n")], "{}");
            let root = tmp.path();
            let before = tree(root);
            let result = super::create_folder(root.to_str().unwrap(), parent, name, None, None);
            assert_refused(result, root, &before, &format!("create_folder {name:?}"));
        }
    }
}
