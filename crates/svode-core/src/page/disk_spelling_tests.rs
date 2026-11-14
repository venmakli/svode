//! A write addressed by an existing path in another letter case or Unicode
//! normalization than the disk acts as the same write in the disk spelling:
//! on a file system that finds such a path, the tree, `.svode/order.json`,
//! links and the result path are byte for byte those of the call in the
//! exact spelling; on one that does not, the write refuses as before and
//! leaves the tree as it was.

use std::fs;
use std::path::{Path, PathBuf};

use crate::collections::engine;
use crate::index::state::IndexRuntimeState;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::test_support::{scaffold_space, update_state};
use crate::page::{PageError, create};
use crate::structure::{self, StructureRuntime};

/// Disk name of the leaf whose name differs from its NFC spelling.
const DECOMPOSED_LEAF: &str = "Cafe\u{301}.md";
/// The NFC spelling of [`DECOMPOSED_LEAF`].
const COMPOSED_LEAF: &str = "Caf\u{e9}.md";

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (path, content) in files {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

/// Space with the Collection `Tasks` (`Alpha.md`, `Beta.md`), the Page
/// `Note.md` that links `Tasks/Beta.md`, the folder Page `Docs` and a leaf
/// stored decomposed (NFD).
fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    scaffold_space(root, "Root");
    write_tree(
        root,
        &[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("Note.md", "---\ntitle: Note\n---\nSee [b](Tasks/Beta.md)\n"),
            ("Tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("Tasks/schema.yaml", "columns: []\nviews: []\n"),
            ("Tasks/Alpha.md", "---\ntitle: Alpha\n---\n"),
            ("Tasks/Beta.md", "---\ntitle: Beta\n---\nBeta body\n"),
            ("Docs/README.md", "---\ntitle: Docs\n---\n"),
            ("Docs/Inner.md", "---\ntitle: Inner\n---\n"),
            (DECOMPOSED_LEAF, "---\ntitle: Café\n---\n"),
            (
                ".svode/order.json",
                &format!(
                    r#"{{".":["{DECOMPOSED_LEAF}","Docs","Note.md","Tasks"],"Docs":["Inner.md"],"Tasks":["Alpha.md","Beta.md"]}}"#
                ),
            ),
        ],
    );
    temp
}

/// Every file and directory of the tree with its contents, without the
/// derived databases.
fn tree_snapshot(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            if rel.starts_with(".svode/") && rel.contains(".db") {
                continue;
            }
            if fs::symlink_metadata(&path).unwrap().is_dir() {
                files.push((rel, String::new()));
                dirs.push(path);
            } else {
                files.push((
                    rel,
                    String::from_utf8_lossy(&fs::read(&path).unwrap()).into_owned(),
                ));
            }
        }
    }
    files.sort();
    files
}

/// A write addressed by one existing path of the fixture.
#[derive(Debug, Clone, Copy)]
enum Write {
    PageCreate,
    CollectionCreate,
    /// `Note.md` under the path.
    Move,
    /// Desktop "New folder" under the path.
    NewFolder,
}

/// What the write does on a file system that does not find the path.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WhenNotFound {
    /// It refuses with `FileNotFound` before any write.
    Refuses,
    /// It keeps the path as given, as before.
    KeepsThePath,
}

fn authorize(paths: Vec<PathBuf>) -> std::future::Ready<Result<Vec<PathBuf>, PageError>> {
    std::future::ready(Ok(paths))
}

fn structure_runtime(index: &IndexRuntimeState) -> StructureRuntime<'_, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits: None,
    }
}

/// Run `write` addressed by `path` and return its result path.
async fn run(write: Write, root: &Path, path: &str) -> Result<String, PageError> {
    let space = root.to_string_lossy().to_string();
    let index = IndexRuntimeState::default();
    match write {
        Write::PageCreate => create::create(
            create::PageCreate {
                space,
                parent_path: Some(path.to_string()),
                title: "Child".into(),
                body: Some("Child body".into()),
                icon: None,
                description: None,
                cover: None,
                properties: None,
                contextual_defaults: false,
                allocate_unique_title: false,
                as_readme: false,
                project: None,
                publish_projection: true,
            },
            &index,
            update_state(),
            None::<&SystemGitDateExecutor>,
            authorize,
        )
        .await
        .map(|outcome| outcome.page.path),
        Write::CollectionCreate => structure::create_collection(
            structure::CollectionCreate {
                space,
                parent_path: Some(path.to_string()),
                title: "Board".into(),
                body: None,
                icon: None,
                description: None,
                cover: None,
                schema: engine::default_collection_schema(),
                allocate_unique_title: false,
                project: None,
            },
            structure_runtime(&index),
            authorize,
        )
        .await
        .map(|outcome| format!("{} {}", outcome.collection_path, outcome.collection.path)),
        Write::Move => {
            structure::move_page(&space, "Note.md", path, None, structure_runtime(&index))
                .await
                .map(|outcome| outcome.new_path)
        }
        Write::NewFolder => structure::create_folder(&space, Some(path), "New", None, None),
    }
}

/// `write` addressed by `other` gives what it gives addressed by `exact`
/// where the file system finds `other`, and what `when_not_found` says
/// where it does not.
async fn assert_same_as_exact(
    write: Write,
    exact: &str,
    other: &str,
    when_not_found: WhenNotFound,
) {
    let expected = fixture();
    let exact_result = run(write, expected.path(), exact).await;
    let exact_result =
        exact_result.unwrap_or_else(|error| panic!("{write:?} {exact:?} failed: {error:?}"));

    let actual = fixture();
    let before = tree_snapshot(actual.path());
    // A parent without extension names its leaf.
    let found =
        actual.path().join(other).exists() || actual.path().join(format!("{other}.md")).exists();
    let result = run(write, actual.path(), other).await;
    if found {
        let result = result.unwrap_or_else(|error| panic!("{write:?} {other:?} failed: {error:?}"));
        assert_eq!(result, exact_result, "{write:?} {other:?}");
        assert_eq!(
            tree_snapshot(actual.path()),
            tree_snapshot(expected.path()),
            "{write:?} {other:?}"
        );
    } else if when_not_found == WhenNotFound::Refuses {
        assert!(
            matches!(result, Err(PageError::FileNotFound(_))),
            "{write:?} {other:?}: {result:?}"
        );
        assert_eq!(tree_snapshot(actual.path()), before, "{write:?} {other:?}");
    } else {
        assert!(result.is_ok(), "{write:?} {other:?}: {result:?}");
    }
}

#[tokio::test]
async fn create_under_a_leaf_parent_in_another_letter_case() {
    // Scenario A: the folder the leaf becomes, not a refusal with an empty
    // folder left behind; B: the folder keeps the name of the leaf on disk.
    for other in ["tasks/Beta.md", "tasks/Beta", "Tasks/beta.md", "TASKS/BETA"] {
        assert_same_as_exact(
            Write::PageCreate,
            "Tasks/Beta.md",
            other,
            WhenNotFound::Refuses,
        )
        .await;
    }
    // Scenario E.
    assert_same_as_exact(
        Write::CollectionCreate,
        "Tasks/Beta.md",
        "tasks/Beta.md",
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn create_under_a_directory_parent_in_another_letter_case() {
    // Scenario C: the order of the existing section, not a new one.
    for (exact, other) in [("Tasks", "tasks"), ("Docs", "docs")] {
        assert_same_as_exact(Write::PageCreate, exact, other, WhenNotFound::Refuses).await;
        // Scenario F: no "plan changed before execution".
        assert_same_as_exact(Write::CollectionCreate, exact, other, WhenNotFound::Refuses).await;
    }
}

#[tokio::test]
async fn new_folder_in_a_parent_in_another_letter_case() {
    // Desktop "New folder" creates a missing parent, as before.
    assert_same_as_exact(Write::NewFolder, "Docs", "docs", WhenNotFound::KeepsThePath).await;
}

#[tokio::test]
async fn move_under_a_parent_in_another_letter_case() {
    // Scenario G: a directory parent; I: a leaf parent.
    assert_same_as_exact(Write::Move, "Tasks", "tasks", WhenNotFound::Refuses).await;
    assert_same_as_exact(
        Write::Move,
        "Tasks/Beta.md",
        "tasks/Beta.md",
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(
        Write::Move,
        "Docs/README.md",
        "docs/readme.md",
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn parent_in_another_unicode_normalization() {
    assert_same_as_exact(
        Write::PageCreate,
        DECOMPOSED_LEAF,
        COMPOSED_LEAF,
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(
        Write::Move,
        DECOMPOSED_LEAF,
        COMPOSED_LEAF,
        WhenNotFound::Refuses,
    )
    .await;
}
