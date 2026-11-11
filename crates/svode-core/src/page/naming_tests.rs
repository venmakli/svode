//! Name conflicts read once per naming scope and marked alike everywhere.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::head_reads;
use super::naming::{allocate_document_title, ensure_document_name_available};
use super::{PageError, read_page_source, resolve_page_target};
use crate::collections::items::items_from_rows;
use crate::collections::query::ItemQueryRow;
use crate::content_tree::{
    TreeChildNode, TreeNode, build_tree, list_tree_children_checked, list_tree_children_unmarked,
    reorder_content,
};

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn titled(title: &str) -> String {
    format!("---\ntitle: {title}\n---\nBody\n")
}

fn space(root: &TempDir) -> &str {
    root.path().to_str().unwrap()
}

/// Every Markdown file under `root`, the way a head read records it.
fn markdown_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|extension| extension == "md") {
                files.push(path);
            }
        }
    }
    files
}

fn assert_each_read_once(reads: &HashMap<PathBuf, usize>, files: &[PathBuf]) {
    for file in files {
        assert_eq!(reads.get(file), Some(&1), "reads of {}", file.display());
    }
    assert_eq!(reads.len(), files.len(), "unexpected reads: {reads:?}");
}

/// A folder of `leaves` leaf Pages and `folders` folder Pages, every
/// second title shared with another document of the folder.
fn large_folder(root: &Path, leaves: usize, folders: usize) {
    for index in 0..leaves {
        write(
            root,
            &format!("docs/page-{index}.md"),
            &titled(&format!("Title {}", index / 2)),
        );
    }
    for index in 0..folders {
        write(
            root,
            &format!("docs/topic-{index}/README.md"),
            &titled(&format!("Topic {index}")),
        );
        write(root, &format!("docs/topic-{index}/child.md"), "child");
    }
}

#[test]
fn folder_listing_reads_each_document_once() {
    let root = TempDir::new().unwrap();
    large_folder(root.path(), 400, 40);
    head_reads::take();

    let nodes = list_tree_children_checked(space(&root), Some("docs")).unwrap();

    assert_eq!(nodes.len(), 440);
    let docs = root.path().join("docs");
    let mut expected: Vec<PathBuf> = (0..400)
        .map(|index| docs.join(format!("page-{index}.md")))
        .collect();
    expected.extend((0..40).map(|index| docs.join(format!("topic-{index}/README.md"))));
    assert_each_read_once(&head_reads::take(), &expected);
    let page = nodes.iter().find(|node| node.path == "docs/page-0.md");
    assert_eq!(
        page.unwrap().name_conflict.as_ref().unwrap().conflicts[0].path,
        "docs/page-1.md"
    );
}

#[test]
fn space_listing_for_list_pages_reads_each_document_once() {
    let root = TempDir::new().unwrap();
    large_folder(root.path(), 300, 30);
    write(root.path(), "Root.md", &titled("Root"));
    head_reads::take();

    let tree = build_tree(space(&root)).unwrap();

    assert_each_read_once(&head_reads::take(), &markdown_files(root.path()));
    let docs = tree.iter().find(|node| node.name == "docs").unwrap();
    assert!(
        docs.children
            .iter()
            .filter(|node| node.name.starts_with("page-"))
            .all(|node| node.name_conflict.is_some())
    );
}

#[test]
fn listings_for_names_only_do_not_compute_conflicts() {
    let root = TempDir::new().unwrap();
    large_folder(root.path(), 50, 5);
    head_reads::take();

    let nodes = list_tree_children_unmarked(space(&root), Some("docs")).unwrap();

    assert!(nodes.iter().all(|node| node.name_conflict.is_none()));
    assert!(head_reads::take().values().all(|reads| *reads == 1));

    let paths = nodes.iter().map(|node| node.path.clone()).collect();
    reorder_content(space(&root), "docs", paths).unwrap();
    assert!(head_reads::take().values().all(|reads| *reads == 1));
}

#[test]
fn collection_rows_share_one_read_of_their_folder() {
    let root = TempDir::new().unwrap();
    write(root.path(), "tasks/README.md", &titled("Tasks"));
    write(root.path(), "tasks/schema.yaml", "views: []\n");
    let rows = (0..300)
        .map(|index| {
            let path = format!("tasks/task-{index}.md");
            write(root.path(), &path, &titled(&format!("Task {}", index / 2)));
            ItemQueryRow {
                file_path: path,
                title: String::new(),
                created: String::new(),
                updated: String::new(),
            }
        })
        .collect();
    head_reads::take();

    let items = items_from_rows(space(&root), "tasks", rows, false, false).unwrap();

    assert_eq!(items.len(), 300);
    assert!(items.iter().all(|item| item.name_conflict.is_some()));
    let reads = head_reads::take();
    let tasks = root.path().join("tasks");
    let expected: Vec<PathBuf> = (0..300)
        .map(|index| tasks.join(format!("task-{index}.md")))
        .collect();
    assert_each_read_once(&reads, &expected);
}

#[test]
fn free_title_candidates_share_one_read_of_the_scope() {
    let root = TempDir::new().unwrap();
    write(root.path(), "Untitled.md", &titled("Untitled"));
    for index in 2..200 {
        write(
            root.path(),
            &format!("u{index}.md"),
            &titled(&format!("Untitled {index}")),
        );
    }
    head_reads::take();

    let title = allocate_document_title(root.path(), "new.md", "Untitled").unwrap();

    assert_eq!(title, "Untitled 200");
    assert_each_read_once(&head_reads::take(), &markdown_files(root.path()));
}

/// Two documents of one scope that the naming rule names alike.
struct Pair {
    first: &'static str,
    second: &'static str,
    /// A new title that both share, for the check of a write.
    title: &'static str,
    files: &'static [(&'static str, &'static str)],
}

const PAIRS: &[Pair] = &[
    Pair {
        first: "upper.md",
        second: "lower.md",
        title: "SHARED case",
        files: &[
            ("upper.md", "---\ntitle: Shared Case\n---\n"),
            ("lower.md", "---\ntitle: shared case\n---\n"),
        ],
    },
    Pair {
        first: "wide.md",
        second: "narrow.md",
        title: "abc",
        files: &[
            ("wide.md", "---\ntitle: ＡＢＣ\n---\n"),
            ("narrow.md", "---\ntitle: abc\n---\n"),
        ],
    },
    Pair {
        first: "spaced.md",
        second: "single.md",
        title: "two  words",
        files: &[
            ("spaced.md", "---\ntitle: \"two   words\"\n---\n"),
            ("single.md", "---\ntitle: two words\n---\n"),
        ],
    },
    Pair {
        first: "a b.md",
        second: "a-b.md",
        title: "A B",
        files: &[("a b.md", "plain"), ("a-b.md", "plain")],
    },
    Pair {
        first: "c_d.md",
        second: "c d.md",
        title: "c d",
        files: &[("c_d.md", "plain"), ("c d.md", "---\nicon: x\n---\n")],
    },
    Pair {
        first: "topic/README.md",
        second: "topic.md",
        title: "Topic",
        files: &[("topic/README.md", "plain"), ("topic.md", "plain")],
    },
    Pair {
        first: "tasks/README.md",
        second: "Tasks.md",
        title: "tasks",
        files: &[
            ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("tasks/schema.yaml", "views: []\n"),
            ("Tasks.md", "plain"),
        ],
    },
];

fn listed_child<'a>(nodes: &'a [TreeChildNode], path: &str) -> &'a TreeChildNode {
    nodes.iter().find(|node| node.path == path).unwrap()
}

fn listed_node<'a>(nodes: &'a [TreeNode], path: &str) -> &'a TreeNode {
    nodes.iter().find(|node| node.path == path).unwrap()
}

#[test]
fn conflicts_are_symmetric_in_listings_reads_and_writes() {
    for pair in PAIRS {
        let root = TempDir::new().unwrap();
        for (path, content) in pair.files {
            write(root.path(), path, content);
        }
        let children = list_tree_children_checked(space(&root), None).unwrap();
        let tree = build_tree(space(&root)).unwrap();
        for (path, other) in [(pair.first, pair.second), (pair.second, pair.first)] {
            let listed = listed_child(&children, path).name_conflict.as_ref();
            assert_eq!(
                listed.map(|conflict| conflict.conflicts[0].path.as_str()),
                Some(other),
                "listing of {path}"
            );
            let in_tree = listed_node(&tree, path).name_conflict.as_ref();
            assert_eq!(in_tree, listed, "list_pages of {path}");
            let target = resolve_page_target(root.path(), path).unwrap();
            let read = read_page_source(target).unwrap().name_conflict;
            assert_eq!(read.as_ref(), listed, "read_page_source of {path}");

            let title_of_other = &listed.unwrap().conflicts[0].title;
            assert!(
                matches!(
                    ensure_document_name_available(root.path(), path, title_of_other),
                    Err(PageError::DocumentNameConflict(_))
                ),
                "new title of {path}"
            );
            assert!(matches!(
                ensure_document_name_available(root.path(), path, pair.title),
                Err(PageError::DocumentNameConflict(_))
            ));
        }
        let created = crate::page::store::create_with_options(
            space(&root),
            None,
            pair.title,
            None,
            false,
            false,
        );
        assert!(
            matches!(created, Err(PageError::DocumentNameConflict(_))),
            "create {}",
            pair.title
        );
    }
}

#[test]
fn readme_titled_readme_is_named_alike_in_listing_and_write_check() {
    let root = TempDir::new().unwrap();
    write(root.path(), "notes/README.md", "---\ntitle: readme\n---\n");
    write(root.path(), "other.md", "---\ntitle: README\n---\n");
    write(root.path(), "notes-page.md", "---\ntitle: notes\n---\n");

    let children = list_tree_children_checked(space(&root), None).unwrap();

    let folder = listed_child(&children, "notes/README.md");
    assert_eq!(folder.title, "notes");
    assert_eq!(
        folder.name_conflict.as_ref().unwrap().conflicts[0].path,
        "other.md"
    );
    assert!(
        listed_child(&children, "notes-page.md")
            .name_conflict
            .is_none()
    );
    assert!(ensure_document_name_available(root.path(), "notes-page.md", "notes").is_ok());
}

#[test]
fn child_space_folder_is_not_a_sibling_of_parent_documents() {
    let root = TempDir::new().unwrap();
    write(
        root.path(),
        ".svode/config.json",
        r#"{"name":"Root","spaces":[{"id":"eng","path":"eng"}]}"#,
    );
    write(root.path(), "eng/.svode/config.json", r#"{"name":"Eng"}"#);
    write(root.path(), "eng/README.md", "---\ntitle: Eng\n---\n");
    write(root.path(), "Eng.md", "---\ntitle: Eng\n---\n");

    let children = list_tree_children_checked(space(&root), None).unwrap();
    assert!(listed_child(&children, "Eng.md").name_conflict.is_none());
    let tree = build_tree(space(&root)).unwrap();
    assert!(listed_node(&tree, "Eng.md").name_conflict.is_none());
    let target = resolve_page_target(root.path(), "Eng.md").unwrap();
    assert!(read_page_source(target).unwrap().name_conflict.is_none());
    assert!(ensure_document_name_available(root.path(), "Eng.md", "eng").is_ok());
}
