//! A write addressed by an existing path in another letter case or Unicode
//! normalization than the disk acts as the same write in the disk spelling:
//! on a file system that finds such a path, the tree, `.svode/order.json`,
//! links and the result path are byte for byte those of the call in the
//! exact spelling; on one that does not, the write refuses as before and
//! leaves the tree as it was.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::collections::engine::{self, ItemFieldBatchIntent};
use crate::index::state::IndexRuntimeState;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::nonce::WriteNonceRegistry;
use crate::page::test_support::{runtime as page_runtime, scaffold_space, update_state};
use crate::page::{PageError, create, fields, metadata, templates, write};
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

/// Space with the Collection `Tasks` (`Alpha.md`, `Beta.md`, the template
/// `basic`), the Page `Note.md` that links `Tasks/Beta.md`, the folder Page
/// `Docs`, the folder Page `Solo` that holds only itself, the folder
/// without a title `Misc/Sub` and a leaf stored decomposed (NFD).
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
            (
                "Tasks/.templates/basic.md",
                "---\ntitle: Basic\n---\nTemplate body\n",
            ),
            ("Solo/README.md", "---\ntitle: Solo\n---\n"),
            ("Misc/Sub/.gitkeep", ""),
            (DECOMPOSED_LEAF, "---\ntitle: Café\n---\n"),
            (
                ".svode/order.json",
                &format!(
                    r#"{{".":["{DECOMPOSED_LEAF}","Docs","Misc","Note.md","Solo","Tasks"],"Docs":["Inner.md"],"Misc":["Sub"],"Tasks":["Alpha.md","Beta.md"]}}"#
                ),
            ),
        ],
    );
    temp
}

/// Paths relative to `root`, which differs between two fixtures.
fn relative(root: &str, paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| {
            path.strip_prefix(root)
                .unwrap_or(path)
                .display()
                .to_string()
        })
        .collect()
}

/// Every file and directory of the tree with its contents, without the
/// derived databases and the write lock any write takes.
fn tree_snapshot(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            if rel.starts_with(".svode/") && rel.contains(".db") || rel == ".svode/write.lock" {
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
    /// The path under the given parent.
    MoveSource(&'static str),
    Delete,
    /// A new title through the metadata write.
    Title(&'static str),
    /// A new icon through the metadata write.
    Icon,
    /// A new title through the field write of a Collection item.
    FieldTitle(&'static str),
    /// A body write without a title.
    Body,
    ConvertToFolder,
    ConvertToLeaf,
    ConvertToCollection,
    Nest,
    Duplicate,
    /// A rename by path of the folder to the given name in its parent.
    Rename(&'static str),
    /// The given children of the parent, by name, in this order.
    Reorder(&'static [&'static str]),
    /// A record of the template `basic` of the Collection at the path,
    /// created in the Collection.
    FromTemplate,
}

/// What the write does on a file system that does not find the path.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WhenNotFound {
    /// It refuses with `FileNotFound` before any write.
    Refuses,
    /// It refuses with its own error before any write, as before.
    RefusesAsBefore,
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
        Write::MoveSource(to_parent) => {
            structure::move_page(&space, path, to_parent, None, structure_runtime(&index))
                .await
                .map(|outcome| format!("{} {}", outcome.old_path, outcome.new_path))
        }
        Write::Delete => structure::delete(&space, path, None, structure_runtime(&index))
            .await
            .map(|outcome| {
                format!(
                    "{} {} {:?}",
                    outcome.source_path, outcome.deleted_root, outcome.changed_paths
                )
            }),
        Write::Title(title) => patch_metadata(&space, path, &index, Some(title), None).await,
        Write::Icon => patch_metadata(&space, path, &index, None, Some("star")).await,
        Write::FieldTitle(title) => {
            let nonces = WriteNonceRegistry::default();
            let values = BTreeMap::from([("title".to_string(), serde_json::json!(title))]);
            fields::update(
                fields::PageFieldUpdate {
                    space: &space,
                    path,
                    project: None,
                    values: &values,
                    intent: ItemFieldBatchIntent::Literal,
                },
                page_runtime(&index, &nonces),
                authorize,
            )
            .await
            .map(|outcome| format!("{} {}", outcome.source_path, outcome.page.path))
        }
        Write::Body => {
            let nonces = WriteNonceRegistry::default();
            write::write(
                write::PageWrite {
                    space: &space,
                    path,
                    content: "New body\n",
                    title: None,
                    icon: None,
                    extra: None,
                    metadata: None,
                    field_batch: None,
                    skip_rename: true,
                    project: None,
                    source_version: None,
                },
                page_runtime(&index, &nonces),
                authorize,
            )
            .await
            .map(|outcome| {
                format!(
                    "{} {:?} {:?}",
                    outcome.source_path,
                    outcome.result.new_path,
                    relative(&space, &outcome.changed_paths)
                )
            })
        }
        Write::ConvertToFolder => {
            structure::convert_to_folder(&space, path, None, structure_runtime(&index))
                .await
                .map(|outcome| format!("{} {}", outcome.old_path, outcome.page.path))
        }
        Write::ConvertToLeaf => {
            structure::convert_to_leaf(&space, path, None, structure_runtime(&index))
                .await
                .map(|outcome| {
                    format!(
                        "{} {} {:?}",
                        outcome.old_path,
                        outcome.page.path,
                        relative(&space, &outcome.removed_paths)
                    )
                })
        }
        Write::ConvertToCollection => {
            structure::convert_to_collection(&space, path, None, structure_runtime(&index))
                .await
                .map(|outcome| {
                    format!(
                        "{} {} {} {} {}",
                        outcome.old_path,
                        outcome.collection_path,
                        outcome.readme_path,
                        outcome.schema_path,
                        outcome.page.path
                    )
                })
        }
        Write::Nest => structure::nest(&space, path, None, structure_runtime(&index))
            .await
            .map(|outcome| format!("{} {}", outcome.old_path, outcome.new_path)),
        Write::Duplicate => structure::duplicate(&space, path, None, structure_runtime(&index))
            .await
            .map(|page| page.path),
        Write::Rename(name) => {
            // The new name replaces the last component; the parent keeps
            // the spelling of the request.
            let to = match path.rsplit_once('/') {
                Some((parent, _)) => format!("{parent}/{name}"),
                None => name.to_string(),
            };
            structure::rename(&space, path, &to, None, structure_runtime(&index))
                .await
                .map(|outcome| {
                    format!(
                        "{} {} {:?}",
                        outcome.old_path, outcome.new_path, outcome.modified_paths
                    )
                })
        }
        Write::Reorder(names) => {
            let children = names
                .iter()
                .map(|name| format!("{path}/{name}"))
                .collect::<Vec<_>>();
            crate::content_tree::reorder_content(&space, path, children)
                .map(|outcome| format!("{outcome:?}"))
                .map_err(PageError::from)
        }
        Write::FromTemplate => templates::instantiate(
            &space,
            path,
            "basic",
            path,
            Some("Record".into()),
            false,
            false,
            None,
        )
        .map(|instantiated| instantiated.page.path),
    }
}

async fn patch_metadata(
    space: &str,
    path: &str,
    index: &IndexRuntimeState,
    title: Option<&str>,
    icon: Option<&str>,
) -> Result<String, PageError> {
    let nonces = WriteNonceRegistry::default();
    metadata::patch(
        space,
        path,
        metadata::PageMetadataPatch {
            title: title.map(str::to_string),
            icon: icon.map(|icon| Some(icon.to_string())),
            description: None,
            cover: None,
        },
        None,
        page_runtime(index, &nonces),
        authorize,
    )
    .await
    .map(|outcome| {
        format!(
            "{} {} {:?}",
            outcome.source_path,
            outcome.page.path,
            relative(space, &outcome.changed_paths)
        )
    })
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
    } else {
        assert_not_found(write, other, when_not_found, result, &before, actual.path());
    }
}

/// What `write` addressed by a path the file system does not find gave:
/// what `when_not_found` says.
fn assert_not_found(
    write: Write,
    path: &str,
    when_not_found: WhenNotFound,
    result: Result<String, PageError>,
    before: &[(String, String)],
    root: &Path,
) {
    match when_not_found {
        WhenNotFound::Refuses => {
            assert!(
                matches!(result, Err(PageError::FileNotFound(_))),
                "{write:?} {path:?}: {result:?}"
            );
            assert_eq!(tree_snapshot(root), before, "{write:?} {path:?}");
        }
        WhenNotFound::RefusesAsBefore => {
            assert!(result.is_err(), "{write:?} {path:?}: {result:?}");
            assert_eq!(tree_snapshot(root), before, "{write:?} {path:?}");
        }
        WhenNotFound::KeepsThePath => assert!(result.is_ok(), "{write:?} {path:?}: {result:?}"),
    }
}

/// `write` addressed by `missing`, a path no file system finds, gives what
/// it gives on a case-sensitive file system for a path in another case.
async fn assert_missing(write: Write, missing: &str, when_not_found: WhenNotFound) {
    let actual = fixture();
    let before = tree_snapshot(actual.path());
    let result = run(write, actual.path(), missing).await;
    assert_not_found(
        write,
        missing,
        when_not_found,
        result,
        &before,
        actual.path(),
    );
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

#[tokio::test]
async fn move_a_source_in_another_letter_case() {
    // Scenario H: the moved file keeps its name and leaves the order of its
    // old parent.
    assert_same_as_exact(
        Write::MoveSource("Tasks"),
        "Note.md",
        "note.md",
        WhenNotFound::Refuses,
    )
    .await;
    // Scenario X: the link to the moved item is rewritten.
    let exact = fixture();
    run(Write::MoveSource(""), exact.path(), "Tasks/Beta.md")
        .await
        .unwrap();
    assert!(
        fs::read_to_string(exact.path().join("Note.md"))
            .unwrap()
            .contains("](Beta.md)")
    );
    for other in ["tasks/beta.md", "TASKS/Beta.md"] {
        assert_same_as_exact(
            Write::MoveSource(""),
            "Tasks/Beta.md",
            other,
            WhenNotFound::Refuses,
        )
        .await;
    }
    assert_same_as_exact(
        Write::MoveSource("Docs"),
        DECOMPOSED_LEAF,
        COMPOSED_LEAF,
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn delete_in_another_letter_case() {
    // Scenario K: the order entry goes with the file; a Collection too.
    for (exact, other) in [
        ("Note.md", "note.md"),
        ("Tasks/Beta.md", "tasks/beta.md"),
        ("Tasks", "tasks"),
        ("Docs", "DOCS"),
        (DECOMPOSED_LEAF, COMPOSED_LEAF),
    ] {
        assert_same_as_exact(Write::Delete, exact, other, WhenNotFound::Refuses).await;
    }
}

#[tokio::test]
async fn metadata_and_field_writes_in_another_letter_case() {
    // Scenario M: the renamed file replaces its own order entry.
    assert_same_as_exact(
        Write::Title("Note 2"),
        "Note.md",
        "note.md",
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(
        Write::Title("Coffee"),
        DECOMPOSED_LEAF,
        COMPOSED_LEAF,
        WhenNotFound::Refuses,
    )
    .await;
    // Scenario U.
    assert_same_as_exact(Write::Icon, "Note.md", "note.md", WhenNotFound::Refuses).await;
    // Scenario W: the order entry and the link follow the renamed item.
    assert_same_as_exact(
        Write::FieldTitle("Gamma"),
        "Tasks/Beta.md",
        "tasks/beta.md",
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(Write::Body, "Note.md", "note.md", WhenNotFound::Refuses).await;
    assert_same_as_exact(
        Write::Body,
        "Tasks/Beta.md",
        "TASKS/BETA.MD",
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn conversions_in_another_letter_case() {
    // Scenario Q: the Collection keeps the name of the leaf and replaces its
    // order entry.
    for (exact, other) in [("Tasks/Beta.md", "tasks/Beta.md"), ("Note.md", "note.md")] {
        assert_same_as_exact(
            Write::ConvertToCollection,
            exact,
            other,
            WhenNotFound::Refuses,
        )
        .await;
    }
    assert_same_as_exact(
        Write::ConvertToFolder,
        "Note.md",
        "note.md",
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(
        Write::ConvertToLeaf,
        "Solo/README.md",
        "solo/readme.md",
        WhenNotFound::Refuses,
    )
    .await;
    assert_same_as_exact(Write::Nest, "Note.md", "NOTE.md", WhenNotFound::Refuses).await;
    assert_same_as_exact(
        Write::Duplicate,
        "Note.md",
        "note.md",
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn rename_a_folder_by_path_in_another_letter_case() {
    assert_same_as_exact(
        Write::Rename("Renamed"),
        "Misc/Sub",
        "misc/sub",
        WhenNotFound::Refuses,
    )
    .await;
    // A new name that differs only in letter case is the name the request
    // gives.
    assert_same_as_exact(
        Write::Rename("SUB"),
        "Misc/Sub",
        "MISC/sub",
        WhenNotFound::Refuses,
    )
    .await;
}

#[tokio::test]
async fn reorder_in_another_letter_case() {
    // Scenario P: the existing section of the parent, not a refusal.
    assert_same_as_exact(
        Write::Reorder(&["Beta.md", "Alpha.md"]),
        "Tasks",
        "tasks",
        WhenNotFound::RefusesAsBefore,
    )
    .await;
    assert_same_as_exact(
        Write::Reorder(&["beta.md", "ALPHA.md"]),
        "Tasks",
        "Tasks",
        WhenNotFound::RefusesAsBefore,
    )
    .await;
}

#[tokio::test]
async fn create_from_a_template_in_another_letter_case() {
    assert_same_as_exact(
        Write::FromTemplate,
        "Tasks",
        "tasks",
        WhenNotFound::RefusesAsBefore,
    )
    .await;
}

#[tokio::test]
async fn a_missing_source_refuses_as_before() {
    // What a case-sensitive file system gives for a path in another case.
    for write in [
        Write::MoveSource(""),
        Write::Delete,
        Write::Title("New"),
        Write::Icon,
        Write::FieldTitle("New"),
        Write::Body,
        Write::ConvertToFolder,
        Write::ConvertToLeaf,
        Write::ConvertToCollection,
        Write::Nest,
        Write::Duplicate,
        Write::Rename("New"),
    ] {
        assert_missing(write, "tasks/missing.md", WhenNotFound::Refuses).await;
    }
    assert_missing(
        Write::Reorder(&[]),
        "missing",
        WhenNotFound::RefusesAsBefore,
    )
    .await;
    assert_missing(
        Write::FromTemplate,
        "missing",
        WhenNotFound::RefusesAsBefore,
    )
    .await;
}
