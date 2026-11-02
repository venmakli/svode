//! A move under a Page: the parent rule, the conversions of a leaf parent
//! and of the folder Page the source leaves, their refusals and the one
//! snapshot and history of the whole operation (DF-296 M1–M5).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tempfile::TempDir;

use crate::content_tree::read_order;
use crate::git::pending::{OperationId, StructuralChange};
use crate::index::state::IndexRuntimeState;
use crate::page::PageError;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::test_support::{scaffold_space, update_state};

use super::{ConvertedParent, MovePageOutcome, StructuralCommitSink, StructureRuntime};

/// Inline Project Space: the leaf `Doc.md` that `Link.md` links to, the
/// folder Page `Folder` with its only child `Child.md` and a `.gitkeep`, the
/// Collection `Tasks` with the item `T1.md`, the bare folder `Bare`, the
/// source `Note.md` and a plain file.
fn fixture() -> TempDir {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    scaffold_space(root, "Root");
    fs::create_dir_all(root.join(".git")).unwrap();
    for (path, content) in [
        ("Doc.md", "---\ntitle: Doc\n---\nDoc body\n"),
        ("Link.md", "---\ntitle: Link\n---\nSee [Doc](Doc.md).\n"),
        ("Note.md", "---\ntitle: Note\n---\nNote body\n"),
        ("Folder/README.md", "---\ntitle: Folder\n---\nFolder body\n"),
        ("Folder/Child.md", "---\ntitle: Child\n---\nChild body\n"),
        ("Folder/.gitkeep", ""),
        (
            "Tasks/schema.yaml",
            "columns:\n  - { name: Status, type: text, default: Todo }\n",
        ),
        ("Tasks/README.md", "---\ntitle: Tasks\n---\n"),
        (
            "Tasks/T1.md",
            "---\ntitle: T1\nStatus: Open\n---\nT1 body\n",
        ),
        ("Bare/Loose.md", "---\ntitle: Loose\n---\n"),
        ("data.txt", "data"),
        (
            ".svode/order.json",
            r#"{".":["Doc.md","Folder","Link.md","Note.md","Tasks","Bare"],"Folder":["Child.md"]}"#,
        ),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    tmp
}

fn runtime<'a>(
    index: &'a IndexRuntimeState,
    commits: Option<&'a dyn StructuralCommitSink>,
) -> StructureRuntime<'a, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits,
    }
}

async fn move_page(
    root: &Path,
    from: &str,
    to_parent: &str,
    project: bool,
    commits: Option<&dyn StructuralCommitSink>,
) -> Result<MovePageOutcome, PageError> {
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();
    super::move_page(
        space,
        from,
        to_parent,
        project.then_some(space),
        runtime(&state, commits),
    )
    .await
}

/// Every directory and source file of the tree with its bytes, without the
/// device-local state the index repair and the name lock write.
fn source_tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            let local = rel.strip_prefix(".svode/").is_some_and(|name| {
                name == "local.json"
                    || name == "write.lock"
                    || name.starts_with("variables.")
                    || name.contains(".db")
            });
            if local || rel == ".git" {
                continue;
            }
            if path.is_dir() {
                files.push((rel, Vec::new()));
                dirs.push(path);
            } else {
                files.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

fn read(root: &Path, path: &str) -> String {
    fs::read_to_string(root.join(path)).unwrap()
}

fn order(root: &Path, key: &str) -> Vec<String> {
    read_order(root).get(key).cloned().unwrap_or_default()
}

fn converted(old_path: &str, new_path: &str) -> ConvertedParent {
    ConvertedParent {
        old_path: old_path.into(),
        new_path: new_path.into(),
    }
}

/// Records every structural history registration with its operation and
/// relocation.
#[derive(Default)]
struct ChangeSink(Mutex<Vec<(OperationId, Option<(PathBuf, PathBuf)>, Vec<PathBuf>)>>);

impl ChangeSink {
    fn take(&self) -> Vec<(OperationId, Option<(PathBuf, PathBuf)>, Vec<PathBuf>)> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl StructuralCommitSink for ChangeSink {
    fn schedule(&self, _: &Path, _: &Path, change: StructuralChange, paths: Vec<PathBuf>) {
        let relocation = change
            .relocation()
            .map(|relocation| (relocation.source.clone(), relocation.target.clone()));
        self.0
            .lock()
            .unwrap()
            .push((change.id(), relocation, paths));
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
        _: Vec<PathBuf>,
        _: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        panic!("a move without unique ids commits nothing now")
    }
}

#[tokio::test]
async fn a_move_into_a_leaf_page_makes_it_a_folder_page_first() {
    for to_parent in ["Doc.md", "Doc"] {
        let tmp = fixture();
        let root = tmp.path();

        let moved = move_page(root, "Note.md", to_parent, true, None)
            .await
            .unwrap();

        assert_eq!(moved.new_path, "Doc/Note.md", "{to_parent}");
        assert_eq!(
            moved.converted_parents,
            vec![converted("Doc.md", "Doc/README.md")]
        );
        assert!(!root.join("Doc.md").exists());
        assert_eq!(
            read(root, "Doc/README.md"),
            "---\ntitle: Doc\n---\nDoc body\n"
        );
        assert_eq!(
            read(root, "Doc/Note.md"),
            "---\ntitle: Note\n---\nNote body\n"
        );
        assert!(read(root, "Link.md").contains("[Doc](Doc/README.md)"));
        // The converted Page keeps its place, the moved Page goes last.
        assert_eq!(
            order(root, "."),
            ["Doc", "Folder", "Link.md", "Tasks", "Bare"]
        );
        assert_eq!(order(root, "Doc"), ["Note.md"]);
    }
}

#[tokio::test]
async fn a_folder_readme_names_its_folder_and_the_root_readme_the_space_root() {
    let tmp = fixture();
    let root = tmp.path();

    let moved = move_page(root, "Note.md", "Folder/README.md", true, None)
        .await
        .unwrap();
    assert_eq!(moved.new_path, "Folder/Note.md");
    assert!(moved.converted_parents.is_empty());
    assert!(root.join("Folder/README.md").is_file());

    let back = move_page(root, "Folder/Note.md", "README.md", true, None)
        .await
        .unwrap();
    assert_eq!(back.new_path, "Note.md");
    assert!(back.converted_parents.is_empty());
}

#[tokio::test]
async fn a_move_into_a_collection_item_keeps_its_fields_and_gives_the_page_only_its_title() {
    let tmp = fixture();
    let root = tmp.path();

    let moved = move_page(root, "Note.md", "Tasks/T1.md", true, None)
        .await
        .unwrap();

    assert_eq!(moved.new_path, "Tasks/T1/Note.md");
    assert_eq!(
        moved.converted_parents,
        vec![converted("Tasks/T1.md", "Tasks/T1/README.md")]
    );
    assert!(read(root, "Tasks/T1/README.md").contains("Status: Open"));
    assert_eq!(
        read(root, "Tasks/T1/Note.md"),
        "---\ntitle: Note\n---\nNote body\n"
    );
}

#[tokio::test]
async fn a_leaf_parent_beside_a_folder_of_its_name_is_refused_unchanged() {
    let tmp = fixture();
    let root = tmp.path();
    fs::create_dir_all(root.join("Doc")).unwrap();
    let before = source_tree(root);

    let error = move_page(root, "Note.md", "Doc.md", true, None)
        .await
        .unwrap_err();

    assert!(
        matches!(&error, PageError::FileAlreadyExists(path) if path == "Doc"),
        "{error:?}"
    );
    assert_eq!(source_tree(root), before);
}

#[tokio::test]
async fn moving_the_last_child_out_makes_its_folder_page_a_leaf_in_place() {
    for project in [true, false] {
        let tmp = fixture();
        let root = tmp.path();

        let moved = move_page(root, "Folder/Child.md", "", project, None)
            .await
            .unwrap();

        assert_eq!(moved.new_path, "Child.md");
        assert_eq!(
            moved.converted_parents,
            vec![converted("Folder/README.md", "Folder.md")]
        );
        assert_eq!(moved.removed_paths, vec![root.join("Folder/.gitkeep")]);
        assert!(!root.join("Folder").exists());
        assert_eq!(
            read(root, "Folder.md"),
            "---\ntitle: Folder\n---\nFolder body\n"
        );
        assert_eq!(
            order(root, "."),
            [
                "Doc.md",
                "Folder.md",
                "Link.md",
                "Note.md",
                "Tasks",
                "Bare",
                "Child.md"
            ]
        );
        assert!(!read_order(root).contains_key("Folder"));
    }
}

#[tokio::test]
async fn a_folder_page_that_still_holds_something_stays_a_folder() {
    for (extra, content) in [
        ("Folder/Other.md", "---\ntitle: Other\n---\n"),
        ("Folder/image.png", "png"),
        ("Folder/schema.yaml", "columns: []\n"),
    ] {
        let tmp = fixture();
        let root = tmp.path();
        fs::write(root.join(extra), content).unwrap();

        let moved = move_page(root, "Folder/Child.md", "", true, None)
            .await
            .unwrap();

        assert_eq!(moved.new_path, "Child.md", "{extra}");
        assert!(moved.converted_parents.is_empty(), "{extra}");
        assert!(root.join("Folder/README.md").is_file(), "{extra}");
        assert!(!root.join("Folder.md").exists(), "{extra}");
    }
}

#[tokio::test]
async fn the_space_root_a_bare_folder_and_a_collection_never_become_leaves() {
    let tmp = fixture();
    let root = tmp.path();

    let from_root = move_page(root, "Note.md", "Bare", true, None)
        .await
        .unwrap();
    assert_eq!(from_root.new_path, "Bare/Note.md");
    assert!(from_root.converted_parents.is_empty());

    let from_bare = move_page(root, "Bare/Loose.md", "", true, None)
        .await
        .unwrap();
    assert!(from_bare.converted_parents.is_empty());
    assert!(root.join("Bare").is_dir());

    let from_collection = move_page(root, "Tasks/T1.md", "", true, None)
        .await
        .unwrap();
    assert!(from_collection.converted_parents.is_empty());
    assert!(root.join("Tasks/README.md").is_file());
}

#[tokio::test]
async fn one_move_from_a_folder_page_into_a_leaf_page_makes_both_conversions_together() {
    for project in [true, false] {
        let tmp = fixture();
        let root = tmp.path();
        let sink = ChangeSink::default();

        let moved = move_page(root, "Folder/Child.md", "Doc.md", project, Some(&sink))
            .await
            .unwrap();

        assert_eq!(moved.new_path, "Doc/Child.md");
        assert_eq!(
            moved.converted_parents,
            vec![
                converted("Doc.md", "Doc/README.md"),
                converted("Folder/README.md", "Folder.md"),
            ]
        );
        assert!(root.join("Doc/README.md").is_file());
        assert!(root.join("Doc/Child.md").is_file());
        assert!(root.join("Folder.md").is_file());
        assert!(!root.join("Folder").exists());
        let registrations = sink.take();
        if !project {
            // A Space outside a Project records no history.
            assert!(registrations.is_empty(), "{registrations:?}");
            continue;
        }
        let relocations = registrations
            .iter()
            .filter_map(|(_, relocation, _)| relocation.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            relocations,
            vec![
                (root.join("Doc.md"), root.join("Doc")),
                (root.join("Folder"), root.join("Folder.md")),
                (root.join("Folder/Child.md"), root.join("Doc/Child.md")),
            ]
        );
        let operation = registrations[0].0;
        assert!(
            registrations.iter().all(|(id, _, _)| *id == operation),
            "every step belongs to one operation"
        );
        let paths = registrations
            .iter()
            .flat_map(|(_, _, paths)| paths.clone())
            .collect::<Vec<_>>();
        for path in [
            "Doc.md",
            "Doc/README.md",
            "Doc/Child.md",
            "Folder/Child.md",
            "Folder/README.md",
            "Folder.md",
            "Folder/.gitkeep",
            "Link.md",
            ".svode/order.json",
        ] {
            assert!(paths.contains(&root.join(path)), "{path}: {paths:?}");
        }
    }
}

#[tokio::test]
async fn a_failed_step_restores_every_file_and_directory_and_registers_nothing() {
    for project in [true, false] {
        for stage in [
            "move_parent_folder",
            "move_order",
            "move_relations",
            "move_sources",
            "page_dir_remove",
            "move_parent_leaf",
        ] {
            let tmp = fixture();
            let root = tmp.path();
            let sink = ChangeSink::default();
            let before = source_tree(root);

            crate::page::write::inject_failure(Some(stage), None);
            let error = move_page(root, "Folder/Child.md", "Doc.md", project, Some(&sink)).await;
            crate::page::write::inject_failure(None, None);

            let error = error.expect_err(stage);
            assert!(
                error
                    .to_string()
                    .contains(&format!("injected {stage} failure")),
                "{stage}: {error:?}"
            );
            assert_eq!(source_tree(root), before, "{stage} project={project}");
            assert!(sink.take().is_empty(), "{stage}");
        }
    }
}

#[tokio::test]
async fn a_missing_parent_is_refused_without_creating_directories() {
    for to_parent in ["Nope/Deep", "Leaf"] {
        let tmp = fixture();
        let root = tmp.path();
        let before = source_tree(root);

        let error = move_page(root, "Note.md", to_parent, true, None)
            .await
            .unwrap_err();

        assert!(
            matches!(&error, PageError::FileNotFound(path) if path == to_parent),
            "{to_parent}: {error:?}"
        );
        assert_eq!(source_tree(root), before, "{to_parent}");
    }
}

#[tokio::test]
async fn a_parent_that_cannot_hold_the_source_is_refused_unchanged() {
    for (from, to_parent) in [
        ("Note.md", "data.txt"),
        ("Note.md", "Tasks/schema.yaml"),
        ("Doc.md", "Doc.md"),
        ("Doc.md", "Doc"),
        ("Folder", "Folder"),
        ("Folder", "Folder/README.md"),
        ("Folder", "Folder/Sub"),
        ("Folder", "Folder/Child.md"),
    ] {
        let tmp = fixture();
        let root = tmp.path();
        fs::create_dir_all(root.join("Folder/Sub")).unwrap();
        let before = source_tree(root);

        let error = move_page(root, from, to_parent, true, None)
            .await
            .unwrap_err();

        assert!(
            matches!(&error, PageError::UnsupportedMoveParent { path } if path == to_parent),
            "{from} → {to_parent}: {error:?}"
        );
        assert_eq!(source_tree(root), before, "{from} → {to_parent}");
    }
}

#[tokio::test]
async fn the_move_plan_authorizes_the_paths_of_both_conversions() {
    let tmp = fixture();
    let root = tmp.path();
    let space = root.to_str().unwrap();
    let state = IndexRuntimeState::default();

    let paths =
        super::move_page_mutation_paths(&state, space, Some(space), "Folder/Child.md", "Doc.md")
            .await
            .unwrap();

    assert!(paths.contains(&root.join("Link.md")), "{paths:?}");
    let refused = super::move_page_mutation_paths(&state, space, Some(space), "Note.md", "Nope")
        .await
        .unwrap_err();
    assert!(matches!(refused, PageError::FileNotFound(path) if path == "Nope"));
}
