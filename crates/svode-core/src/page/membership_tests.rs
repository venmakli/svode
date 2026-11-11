//! Writes addressed through a Space never reach into a registered child
//! Space: every write operation of `page`, `structure` and `attachments`
//! refuses a source, parent or destination that the child owns, before its
//! first write, and the inventory keeps new write operations under the rule.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::collections::engine::{self, ItemFieldBatchIntent};
use crate::index::IndexKey;
use crate::index::resolver::SpaceStatus;
use crate::index::state::IndexRuntimeState;
use crate::index::update;
use crate::page::PageError;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::nonce::WriteNonceRegistry;
use crate::page::test_support::{runtime as page_runtime, scaffold_space, update_state};
use crate::page::{create, fields, metadata, store, templates, write};
use crate::structure::{self, StructuralCommitSink, StructureRuntime};

/// Repository shape of the child Space `eng`.
#[derive(Debug, Clone, Copy)]
enum ChildRepository {
    /// History in the root repository.
    Inline,
    /// Its own `.git`, ignored by the root repository.
    Independent,
    /// A submodule with a gitlink in the root repository.
    Submodule,
}

const CHILD_REPOSITORIES: [ChildRepository; 3] = [
    ChildRepository::Inline,
    ChildRepository::Independent,
    ChildRepository::Submodule,
];

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (path, content) in files {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

/// Project `root` with Pages of its own and the registered child Space
/// `eng` holding a Page, a folder Page and a Collection with a template.
fn project(kind: ChildRepository) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    scaffold_space(root, "Root");
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Root","spaces":[{"id":"eng","path":"eng"}]}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let eng = root.join("eng");
    scaffold_space(&eng, "Eng");
    write_tree(
        root,
        &[
            ("Note.md", "---\ntitle: Note\n---\nRoot note\n"),
            ("Area/README.md", "---\ntitle: Area\n---\n"),
            ("Plain/Draft.md", "---\ntitle: Draft\n---\n"),
            (".svode/order.json", r#"{".":["Area","Note.md","Plain"]}"#),
            ("eng/Spec.md", "---\ntitle: Spec\n---\nSpec body\n"),
            ("eng/Folder/README.md", "---\ntitle: Folder\n---\n"),
            ("eng/Tasks/schema.yaml", "columns: []\n"),
            ("eng/Tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("eng/Tasks/Item.md", "---\ntitle: Item\n---\n"),
            ("eng/Tasks/.templates/basic.md", "---\ntitle: Basic\n---\n"),
            (
                "eng/.svode/order.json",
                r#"{".":["Folder","Spec.md","Tasks"]}"#,
            ),
        ],
    );
    match kind {
        ChildRepository::Inline => {}
        ChildRepository::Independent => {
            write_tree(
                root,
                &[
                    (".gitignore", "# svode:spaces\neng/\n"),
                    ("eng/.git/HEAD", "ref: refs/heads/main\n"),
                    ("eng/.git/objects/pack/history.pack", "history"),
                ],
            );
        }
        ChildRepository::Submodule => {
            write_tree(
                root,
                &[
                    (
                        ".gitmodules",
                        "[submodule \"eng\"]\n\tpath = eng\n\turl = https://example.invalid/eng.git\n",
                    ),
                    ("eng/.git", "gitdir: ../.git/modules/eng\n"),
                    (".git/modules/eng/HEAD", "ref: refs/heads/main\n"),
                ],
            );
        }
    }
    temp
}

/// Every file and directory of the tree with its bytes, `.git` included.
fn tree_snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path.strip_prefix(root).unwrap().display().to_string();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                files.push((rel, Vec::new()));
                dirs.push(path);
            } else if metadata.file_type().is_symlink() {
                let target = fs::read_link(&path).unwrap();
                files.push((rel, target.display().to_string().into_bytes()));
            } else {
                files.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

#[derive(Default)]
struct RecordingSink(std::sync::Mutex<Vec<PathBuf>>);

impl StructuralCommitSink for RecordingSink {
    fn schedule(
        &self,
        _: &Path,
        _: &Path,
        _: crate::git::pending::StructuralChange,
        paths: Vec<PathBuf>,
    ) {
        self.0.lock().unwrap().extend(paths);
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        _: &'a Path,
        paths: Vec<PathBuf>,
        _: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        self.0.lock().unwrap().extend(paths);
        Box::pin(async {})
    }
}

fn structure_runtime<'a>(
    index: &'a IndexRuntimeState,
    sink: &'a RecordingSink,
) -> StructureRuntime<'a, SystemGitDateExecutor> {
    StructureRuntime {
        index,
        updates: update_state(),
        git_dates: None,
        commits: Some(sink),
    }
}

fn authorize(paths: Vec<PathBuf>) -> std::future::Ready<Result<Vec<PathBuf>, PageError>> {
    std::future::ready(Ok(paths))
}

fn assert_refused<T>(operation: &str, result: Result<T, PageError>) {
    match result {
        Err(PageError::PathInOtherSpace { space_id, .. }) if space_id == "eng" => {}
        Err(error) => panic!("{operation}: expected PathInOtherSpace of eng, got {error:?}"),
        Ok(_) => panic!("{operation}: expected PathInOtherSpace of eng, but it succeeded"),
    }
}

fn page_create(space: &str, parent: &str, project: &str) -> create::PageCreate {
    create::PageCreate {
        space: space.to_string(),
        parent_path: Some(parent.to_string()),
        title: "From root".to_string(),
        body: None,
        icon: None,
        description: None,
        cover: None,
        properties: None,
        contextual_defaults: false,
        allocate_unique_title: false,
        as_readme: false,
        project: Some(project.to_string()),
        publish_projection: true,
    }
}

fn collection_create(space: &str, parent: &str, project: &str) -> structure::CollectionCreate {
    structure::CollectionCreate {
        space: space.to_string(),
        parent_path: Some(parent.to_string()),
        title: "Board".to_string(),
        body: None,
        icon: None,
        description: None,
        cover: None,
        schema: engine::default_collection_schema(),
        allocate_unique_title: false,
        project: Some(project.to_string()),
    }
}

fn page_write<'a>(space: &'a str, path: &'a str, project: &'a str) -> write::PageWrite<'a> {
    write::PageWrite {
        space,
        path,
        content: "Replaced from root\n",
        title: None,
        icon: None,
        extra: None,
        metadata: None,
        field_batch: None,
        skip_rename: true,
        project: Some(project),
        source_version: None,
    }
}

/// Every write operation addressed through the root Space at `space`
/// whose source, parent or destination lies in the child Space reached
/// through `eng` (the child's directory, a symlink to it, or another
/// letter case of it). Returns the names of the operations it ran.
async fn run_every_write_through_root(
    project: &Path,
    space: &str,
    eng: &str,
    index: &IndexRuntimeState,
    sink: &RecordingSink,
) -> Vec<&'static str> {
    let at = |rel: &str| {
        if rel.is_empty() {
            eng.to_string()
        } else {
            format!("{eng}/{rel}")
        }
    };
    let space_path = Path::new(space);
    let project_str = project.to_str().unwrap();
    let nonces = WriteNonceRegistry::default();
    let mut ran = Vec::new();
    macro_rules! refused {
        ($name:literal, $result:expr) => {{
            assert_refused($name, $result);
            ran.push($name);
        }};
    }

    // structure::ops
    for path in [at(""), at("README.md"), at("Spec.md"), at("Tasks")] {
        assert_refused(
            "structure::delete",
            structure::delete(
                space,
                &path,
                Some(project_str),
                structure_runtime(index, sink),
            )
            .await,
        );
    }
    ran.push("structure::delete");
    refused!(
        "structure::create_folder",
        structure::create_folder(space, Some(&at("")), "New", Some(project_str), Some(sink))
    );
    refused!(
        "structure::create_collection",
        structure::create_collection(
            collection_create(space, &at(""), project_str),
            structure_runtime(index, sink),
            authorize,
        )
        .await
    );
    refused!(
        "structure::convert_to_folder",
        structure::convert_to_folder(
            space,
            &at("Spec.md"),
            Some(project_str),
            structure_runtime(index, sink)
        )
        .await
    );
    refused!(
        "structure::convert_to_leaf",
        structure::convert_to_leaf(
            space,
            &at("Folder/README.md"),
            Some(project_str),
            structure_runtime(index, sink)
        )
        .await
    );
    for path in [at(""), at("Spec.md"), at("Folder")] {
        assert_refused(
            "structure::convert_to_collection",
            structure::convert_to_collection(
                space,
                &path,
                Some(project_str),
                structure_runtime(index, sink),
            )
            .await,
        );
    }
    ran.push("structure::convert_to_collection");
    // The new name of a folder without a title must stay in this Space; a
    // rename keeps its parent, so it applies to a top-level child name.
    let renames_into_child = !eng.contains('/');
    if renames_into_child {
        refused!(
            "structure::rename",
            structure::rename(
                space,
                "Plain",
                eng,
                Some(project_str),
                structure_runtime(index, sink)
            )
            .await
        );
    }
    for (from, to_parent) in [
        (at("Spec.md"), String::new()),
        ("Note.md".to_string(), at("")),
        ("Note.md".to_string(), at("Folder")),
        ("Note.md".to_string(), at("Spec.md")),
    ] {
        assert_refused(
            "structure::move_page",
            structure::move_page(
                space,
                &from,
                &to_parent,
                Some(project_str),
                structure_runtime(index, sink),
            )
            .await,
        );
    }
    ran.push("structure::move_page");
    refused!(
        "structure::nest",
        structure::nest(
            space,
            &at("Spec.md"),
            Some(project_str),
            structure_runtime(index, sink)
        )
        .await
    );
    refused!(
        "structure::duplicate",
        structure::duplicate(
            space,
            &at("Spec.md"),
            Some(project_str),
            structure_runtime(index, sink)
        )
        .await
    );

    // structure::plan
    refused!(
        "structure::move_mutation_paths",
        structure::move_mutation_paths(index, space, Some(project_str), &at("Spec.md"), "Spec.md")
            .await
    );
    refused!(
        "structure::move_page_mutation_paths",
        structure::move_page_mutation_paths(index, space, Some(project_str), "Note.md", &at(""))
            .await
    );
    if renames_into_child {
        refused!(
            "structure::rename_mutation_paths",
            structure::rename_mutation_paths(index, space, Some(project_str), "Plain", eng).await
        );
    }
    refused!(
        "structure::backlink_mutation_paths",
        structure::backlink_mutation_paths(index, space, Some(project_str), &at("Spec.md"), false)
            .await
    );
    refused!(
        "structure::delete_mutation_paths",
        structure::delete_mutation_paths(space, Some(project_str), &at("README.md"))
    );
    refused!(
        "structure::collection_create_schema_paths",
        structure::collection_create_schema_paths(
            space,
            Some(&at("")),
            "Board",
            engine::default_collection_schema(),
            false,
            Some(project_str),
        )
    );

    // page::create, metadata, fields, write
    refused!(
        "create::create",
        create::create(
            page_create(space, &at(""), project_str),
            index,
            update_state(),
            None::<&SystemGitDateExecutor>,
            authorize,
        )
        .await
    );
    for (path, title) in [
        (at("Spec.md"), Some("Renamed spec".to_string())),
        (at("README.md"), None),
    ] {
        assert_refused(
            "metadata::patch",
            metadata::patch(
                space,
                &path,
                metadata::PageMetadataPatch {
                    title,
                    icon: Some(Some("x".to_string())),
                    description: None,
                    cover: None,
                },
                Some(project_str),
                page_runtime(index, &nonces),
                authorize,
            )
            .await,
        );
    }
    ran.push("metadata::patch");
    let values = BTreeMap::from([("title".to_string(), serde_json::json!("Renamed item"))]);
    refused!(
        "fields::update",
        fields::update(
            fields::PageFieldUpdate {
                space,
                path: &at("Tasks/Item.md"),
                project: Some(project_str),
                values: &values,
                intent: ItemFieldBatchIntent::Literal,
            },
            page_runtime(index, &nonces),
            authorize,
        )
        .await
    );
    for path in [at("Spec.md"), at("README.md")] {
        assert_refused(
            "write::write",
            write::write(
                page_write(space, &path, project_str),
                page_runtime(index, &nonces),
                authorize,
            )
            .await,
        );
    }
    ran.push("write::write");

    // page::templates
    let tasks = at("Tasks");
    refused!(
        "templates::create",
        templates::create(space, &tasks, "Fresh", templates::TemplateKind::Leaf)
    );
    refused!(
        "templates::delete",
        templates::delete(space, &tasks, "basic")
    );
    refused!(
        "templates::duplicate",
        templates::duplicate(space, &tasks, "basic")
    );
    refused!(
        "templates::instantiate",
        templates::instantiate(space, &tasks, "basic", &tasks, None, true, false, None)
    );

    // page::store
    refused!(
        "store::create_source_with_options",
        store::create_source_with_options(
            space,
            Some(&at("")),
            "From root",
            false,
            false,
            store::SourceNames::File,
        )
    );
    refused!(
        "store::planned_collection_source",
        store::planned_collection_source(space, Some(&at("")), "Board", false)
    );
    refused!(
        "store::create_folder",
        store::create_folder(space, Some(&at("")), "New")
    );
    refused!(
        "store::planned_write_rename",
        store::planned_write_rename(space, &at("Spec.md"), Some("Other"), false)
    );
    refused!(
        "store::write_under_name_lock",
        store::write_under_name_lock(
            space,
            &at("Spec.md"),
            "Replaced\n",
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            Some(project_str),
            None,
        )
    );
    refused!(
        "store::replace_created_body",
        store::replace_created_body(space, &at("Spec.md"), "Replaced\n")
    );
    refused!(
        "store::move_page",
        store::move_page(space_path, "Note.md", &at(""), None)
    );
    refused!(
        "store::move_page_with_project",
        store::move_page_with_project(space_path, &at("Spec.md"), "", None, Some(project_str))
    );
    refused!(
        "store::nest_page",
        store::nest_page(space_path, &at("Spec.md"), None)
    );
    refused!(
        "store::convert_page_to_folder",
        store::convert_page_to_folder(space_path, &at("Spec.md"), None)
    );
    refused!(
        "store::convert_page_to_leaf",
        store::convert_page_to_leaf(space_path, &at("Folder/README.md"), None)
    );
    refused!(
        "store::convert_page_to_nested_collection",
        store::convert_page_to_nested_collection(space_path, &at("Folder/README.md"))
    );
    refused!(
        "store::convert_bare_folder_to_collection",
        store::convert_bare_folder_to_collection(space_path, &at(""))
    );
    refused!(
        "store::write_incoming_copy",
        store::write_incoming_copy(space_path, &at("Spec.md"), b"incoming", "incoming")
    );
    refused!(
        "store::duplicate_page",
        store::duplicate_page(space_path, &at("Spec.md"))
    );
    refused!(
        "store::delete",
        store::delete(space, &at("README.md"), None)
    );
    refused!(
        "store::delete_with_project",
        store::delete_with_project(space, &at(""), None, Some(project_str))
    );
    refused!(
        "store::planned_deleted_page_paths",
        store::planned_deleted_page_paths(space, &at("README.md"))
    );
    refused!(
        "store::rename",
        store::rename(space, &at("Spec.md"), &at("Other.md"))
    );
    refused!(
        "store::rename_with_project",
        store::rename_with_project(space, "Plain", eng, Some(project_str))
    );

    // attachments
    let source_dir = tempfile::tempdir().unwrap();
    let source = source_dir.path().join("photo.png");
    fs::write(&source, b"image").unwrap();
    refused!(
        "attachments::plan_managed_import",
        crate::attachments::import::plan_managed_import(
            index,
            project,
            None,
            &at("Spec.md"),
            &source,
            None,
        )
        .await
    );
    ran
}

async fn index_snapshot(index: &IndexRuntimeState, key: IndexKey) -> Vec<String> {
    let pool = index.get_or_create(&key).await.expect("index pool");
    sqlx::query_scalar::<_, String>("SELECT file_path FROM pages ORDER BY file_path")
        .fetch_all(&pool)
        .await
        .expect("indexed pages")
}

async fn publish_all(index: &IndexRuntimeState, project: &Path, paths: &[&str]) {
    for path in paths {
        update::publish_managed_path(
            index,
            update_state(),
            None::<&SystemGitDateExecutor>,
            project,
            &project.join(path),
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn every_write_through_the_root_space_refuses_paths_of_a_child_space() {
    for kind in CHILD_REPOSITORIES {
        let temp = project(kind);
        let root = temp.path().canonicalize().unwrap();
        let space = root.to_str().unwrap();
        let index = IndexRuntimeState::default();
        index
            .upsert_space(&root, "eng", "eng", SpaceStatus::Ready, None)
            .await;
        publish_all(
            &index,
            &root,
            &[
                "Note.md",
                "Area/README.md",
                "eng/Spec.md",
                "eng/Tasks/Item.md",
            ],
        )
        .await;
        let root_index = index_snapshot(&index, IndexKey::Root(root.clone())).await;
        let child_key = IndexKey::Space {
            project: root.clone(),
            space_id: "eng".to_string(),
        };
        let child_index = index_snapshot(&index, child_key.clone()).await;
        let sink = RecordingSink::default();
        let before = tree_snapshot(&root);

        let ran = run_every_write_through_root(&root, space, "eng", &index, &sink).await;

        assert_eq!(tree_snapshot(&root), before, "{kind:?}");
        assert!(sink.0.lock().unwrap().is_empty(), "{kind:?}");
        assert_eq!(
            index_snapshot(&index, IndexKey::Root(root.clone())).await,
            root_index,
            "{kind:?}"
        );
        assert_eq!(
            index_snapshot(&index, child_key).await,
            child_index,
            "{kind:?}"
        );
        assert_eq!(
            ran.iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>(),
            checked_operations(),
            "every guarded public write operation runs here"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_into_a_child_space_is_refused_like_the_child_itself() {
    let temp = project(ChildRepository::Independent);
    let root = temp.path().canonicalize().unwrap();
    std::os::unix::fs::symlink(root.join("eng"), root.join("Area/link")).unwrap();
    let index = IndexRuntimeState::default();
    let sink = RecordingSink::default();
    let before = tree_snapshot(&root);

    run_every_write_through_root(&root, root.to_str().unwrap(), "Area/link", &index, &sink).await;

    assert_eq!(tree_snapshot(&root), before);
    assert!(sink.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn another_letter_case_of_a_child_space_is_refused_on_a_case_insensitive_file_system() {
    let temp = project(ChildRepository::Inline);
    let root = temp.path().canonicalize().unwrap();
    if !root.join("ENG").exists() {
        // A case-sensitive file system has no such path to protect.
        return;
    }
    let index = IndexRuntimeState::default();
    let sink = RecordingSink::default();
    let before = tree_snapshot(&root);

    run_every_write_through_root(&root, root.to_str().unwrap(), "ENG", &index, &sink).await;

    assert_eq!(tree_snapshot(&root), before);
    assert!(sink.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_absent_child_space_still_owns_its_registered_path() {
    let temp = project(ChildRepository::Submodule);
    let root = temp.path().canonicalize().unwrap();
    // Uninitialized submodule: the directory is gone.
    fs::remove_dir_all(root.join("eng")).unwrap();
    let space = root.to_str().unwrap();
    let index = IndexRuntimeState::default();
    let sink = RecordingSink::default();
    let before = tree_snapshot(&root);

    assert_refused(
        "create::create",
        create::create(
            page_create(space, "eng", space),
            &index,
            update_state(),
            None::<&SystemGitDateExecutor>,
            authorize,
        )
        .await,
    );
    assert_refused(
        "structure::create_folder",
        structure::create_folder(space, Some("eng"), "New", Some(space), Some(&sink)),
    );
    assert_refused(
        "structure::move_page",
        structure::move_page(
            space,
            "Note.md",
            "eng",
            Some(space),
            structure_runtime(&index, &sink),
        )
        .await,
    );

    assert_eq!(tree_snapshot(&root), before);
}

#[tokio::test]
async fn writes_through_the_child_space_and_root_writes_on_root_paths_still_succeed() {
    let temp = project(ChildRepository::Independent);
    let root = temp.path().canonicalize().unwrap();
    let project_str = root.to_str().unwrap();
    let eng = root.join("eng");
    let eng_str = eng.to_str().unwrap();
    let index = IndexRuntimeState::default();
    let nonces = WriteNonceRegistry::default();
    let sink = RecordingSink::default();

    // In the child Space, through the child Space.
    let created = create::create(
        page_create(eng_str, "Folder", project_str),
        &index,
        update_state(),
        None::<&SystemGitDateExecutor>,
        authorize,
    )
    .await
    .expect("create in the child Space");
    assert!(eng.join(&created.page.path).is_file());
    write::write(
        page_write(eng_str, "Spec.md", project_str),
        page_runtime(&index, &nonces),
        authorize,
    )
    .await
    .expect("body write in the child Space");
    structure::move_page(
        eng_str,
        "Spec.md",
        "Folder",
        Some(project_str),
        structure_runtime(&index, &sink),
    )
    .await
    .expect("move in the child Space");
    assert!(eng.join("Folder/Spec.md").is_file());
    structure::delete(
        eng_str,
        "Folder/Spec.md",
        Some(project_str),
        structure_runtime(&index, &sink),
    )
    .await
    .expect("delete in the child Space");
    assert!(!eng.join("Folder/Spec.md").exists());

    // In the root Space, on its own paths.
    structure::move_page(
        project_str,
        "Note.md",
        "Area",
        Some(project_str),
        structure_runtime(&index, &sink),
    )
    .await
    .expect("move in the root Space");
    create::create(
        page_create(project_str, "Area", project_str),
        &index,
        update_state(),
        None::<&SystemGitDateExecutor>,
        authorize,
    )
    .await
    .expect("create in the root Space");
    structure::delete(
        project_str,
        "Area/Note.md",
        Some(project_str),
        structure_runtime(&index, &sink),
    )
    .await
    .expect("delete in the root Space");

    // The child Space and its repository are intact.
    assert!(eng.join(".svode/config.json").is_file());
    assert!(eng.join(".git/HEAD").is_file());
    assert!(eng.join("README.md").is_file());
}

#[tokio::test]
async fn existing_refusals_keep_their_codes() {
    let temp = project(ChildRepository::Inline);
    let root = temp.path().canonicalize().unwrap();
    let space = root.to_str().unwrap();
    let index = IndexRuntimeState::default();
    let sink = RecordingSink::default();

    for path in ["eng", "eng/Folder"] {
        let error = structure::rename(
            space,
            path,
            &format!("{path}2"),
            Some(space),
            structure_runtime(&index, &sink),
        )
        .await
        .expect_err(path);
        assert!(
            matches!(error, PageError::UnsupportedRenameTarget { .. }),
            "{path}: {error:?}"
        );
    }
    let target = crate::page::resolve_space_target(&root, None).unwrap();
    for path in ["eng/Spec.md", "eng/README.md"] {
        assert!(
            matches!(
                crate::page::read_standalone_page(&target, path).await,
                Err(crate::page::PageSourceError::InvalidOwner(_))
            ),
            "{path}"
        );
    }
}

// ---------------------------------------------------------------------------
// Inventory of public write operations
// ---------------------------------------------------------------------------

/// Source files of the modules whose public functions take a path of a
/// Space. Every top-level public function in them is classified below.
const SCANNED_DIRS: &[&str] = &["page", "structure", "attachments"];

/// How a public function meets the rule.
enum Guard {
    /// Its body calls `ensure_path_in_space` for its paths.
    Direct,
    /// Its body calls the named guarded function first.
    Via(&'static str),
    /// Not a write addressed by a path of a Space; the reason says why.
    NotAWrite(#[allow(dead_code)] &'static str),
}

const INVENTORY: &[(&str, &str, Guard)] = {
    use Guard::{Direct, NotAWrite, Via};
    const PURE: Guard = NotAWrite("pure value or path computation");
    const READ: Guard = NotAWrite("reads without writing");
    &[
        ("attachments/format.rs", "is_html_path", PURE),
        ("attachments/format.rs", "classify_attachment_file", PURE),
        ("attachments/format.rs", "is_inside_app", PURE),
        ("attachments/format.rs", "app_directory", PURE),
        ("attachments/format.rs", "classify_binary_path", PURE),
        ("attachments/format.rs", "classify_binary_extension", PURE),
        ("attachments/format.rs", "mime_for", PURE),
        ("attachments/import.rs", "inspect_import_source", READ),
        ("attachments/import.rs", "plan_managed_import", Direct),
        (
            "attachments/import.rs",
            "execute_managed_import",
            Via("plan_managed_import"),
        ),
        ("page/changes.rs", "field_changes", PURE),
        ("page/changes.rs", "section_changes", PURE),
        ("page/create.rs", "create", Via("create_with_source_names")),
        ("page/dates.rs", "detect_git_binary", READ),
        ("page/dates.rs", "apply_date_override", PURE),
        ("page/dates.rs", "enrich_source_git_dates", READ),
        ("page/dates.rs", "derive_date_overrides", READ),
        ("page/fields.rs", "update", Direct),
        ("page/filename.rs", "project", PURE),
        ("page/filename.rs", "allocate_available_path", READ),
        ("page/filename.rs", "allocate_available_stem", READ),
        ("page/filename.rs", "component_conflicts_portably", PURE),
        ("page/filename.rs", "component_name", PURE),
        ("page/filename.rs", "portable_component_key", PURE),
        ("page/frontmatter.rs", "read_page_meta", READ),
        ("page/frontmatter.rs", "title_from_stem", PURE),
        ("page/frontmatter.rs", "try_parse", PURE),
        ("page/frontmatter.rs", "parse", PURE),
        ("page/frontmatter.rs", "parse_status", PURE),
        (
            "page/frontmatter.rs",
            "replace_body_preserving_frontmatter",
            PURE,
        ),
        ("page/frontmatter.rs", "serialize", PURE),
        ("page/frontmatter.rs", "order_fields", PURE),
        ("page/frontmatter.rs", "apply_item_field_update", PURE),
        ("page/identity.rs", "resolve_markdown_identity", PURE),
        (
            "page/identity.rs",
            "resolve_markdown_identity_for_path",
            READ,
        ),
        ("page/identity.rs", "is_agent_context_source", PURE),
        ("page/indexed_dates.rs", "apply_indexed_dates", READ),
        ("page/links.rs", "parse_markdown_links", PURE),
        ("page/links.rs", "parse_markdown_body_links", PURE),
        ("page/links.rs", "parse_markdown_link_nodes", PURE),
        ("page/links.rs", "normalize_link_path_preserve_parent", PURE),
        (
            "page/membership.rs",
            "ensure_path_in_space",
            NotAWrite("the rule itself"),
        ),
        ("page/metadata.rs", "patch", Direct),
        ("page/metadata.rs", "relative_changed_paths", PURE),
        ("page/naming.rs", "display_name_key", PURE),
        ("page/naming.rs", "logical_document_parent", PURE),
        ("page/naming.rs", "is_user_document", PURE),
        ("page/naming.rs", "document_name_conflict", READ),
        (
            "page/naming.rs",
            "with_document_name_lock",
            NotAWrite("process lock around a caller's write"),
        ),
        ("page/naming.rs", "ensure_document_name_available", READ),
        ("page/naming.rs", "allocate_document_title", READ),
        ("page/naming.rs", "slugify", PURE),
        ("page/source.rs", "resolve_page_target", READ),
        ("page/source.rs", "read_page_source", READ),
        ("page/source.rs", "read_page_source_with_names", READ),
        ("page/source.rs", "current_source_version", READ),
        ("page/source.rs", "filesystem_dates", READ),
        ("page/source.rs", "fallback_title", PURE),
        ("page/source.rs", "parse_markdown", PURE),
        ("page/store.rs", "filename_projection_warning", PURE),
        ("page/store.rs", "filename_allocation_warnings", PURE),
        ("page/store.rs", "create_source_with_options", Direct),
        ("page/store.rs", "planned_collection_source", Direct),
        ("page/store.rs", "create_folder", Direct),
        ("page/store.rs", "planned_write_rename", Direct),
        ("page/store.rs", "write_under_name_lock", Direct),
        ("page/store.rs", "replace_created_body", Direct),
        ("page/store.rs", "move_page", Via("move_page_with_project")),
        ("page/store.rs", "move_page_with_project", Direct),
        ("page/store.rs", "nest_page", Direct),
        ("page/store.rs", "convert_page_to_folder", Direct),
        ("page/store.rs", "page_detail_state", READ),
        ("page/store.rs", "convert_page_to_leaf", Direct),
        ("page/store.rs", "convert_page_to_nested_collection", Direct),
        ("page/store.rs", "convert_bare_folder_to_collection", Direct),
        ("page/store.rs", "write_incoming_copy", Direct),
        ("page/store.rs", "duplicate_page", Direct),
        ("page/store.rs", "delete", Via("delete_with_project")),
        ("page/store.rs", "delete_with_project", Direct),
        ("page/store.rs", "planned_deleted_page_paths", Direct),
        ("page/store.rs", "rename", Via("rename_with_project")),
        ("page/store.rs", "rename_with_project", Direct),
        ("page/store/persistence.rs", "read", READ),
        ("page/store/persistence.rs", "read_with_git_dates", READ),
        ("page/store/persistence.rs", "read_with_names", READ),
        ("page/store/persistence.rs", "page_from_source", PURE),
        ("page/store/persistence.rs", "replaced_by_staged_copy", READ),
        ("page/target.rs", "space_reference_status", READ),
        ("page/target.rs", "read_project_config", READ),
        ("page/target.rs", "registered_spaces", READ),
        ("page/target.rs", "registered_space_dirs", READ),
        ("page/target.rs", "project_for_directory", READ),
        ("page/target.rs", "ready_child_space_for_directory", READ),
        ("page/target.rs", "resolve_space_target", READ),
        ("page/target.rs", "resolve_owned_page_target", READ),
        ("page/target.rs", "read_standalone_page", READ),
        ("page/templates.rs", "create", Direct),
        ("page/templates.rs", "delete", Direct),
        ("page/templates.rs", "duplicate", Direct),
        ("page/templates.rs", "instantiate", Direct),
        ("page/write/runtime.rs", "write", Direct),
        (
            "structure/commit.rs",
            "schedule_rename",
            NotAWrite("schedules history of a finished write"),
        ),
        ("structure/naming.rs", "abs_page_path", PURE),
        ("structure/naming.rs", "order_path", PURE),
        ("structure/naming.rs", "page_paths_with_order", PURE),
        ("structure/naming.rs", "grouped_abs_paths_by_space", READ),
        ("structure/naming.rs", "basename", PURE),
        ("structure/naming.rs", "page_history_name", READ),
        ("structure/naming.rs", "page_in_sensitive_collection", READ),
        ("structure/naming.rs", "page_commit_name", READ),
        ("structure/naming.rs", "page_history_commit_name", READ),
        ("structure/naming.rs", "page_relocation", PURE),
        ("structure/naming.rs", "page_entity", PURE),
        ("structure/naming.rs", "page_rename_op", PURE),
        ("structure/naming.rs", "root_path_for_head", PURE),
        ("structure/ops.rs", "delete", Direct),
        ("structure/ops.rs", "create_folder", Direct),
        ("structure/ops.rs", "create_collection", Direct),
        ("structure/ops.rs", "convert_to_folder", Direct),
        ("structure/ops.rs", "convert_to_leaf", Direct),
        ("structure/ops.rs", "convert_to_collection", Direct),
        ("structure/ops.rs", "rename", Via("ensure_renamable_folder")),
        ("structure/ops.rs", "move_page", Direct),
        ("structure/ops.rs", "nest", Direct),
        ("structure/ops.rs", "duplicate", Direct),
        ("structure/plan.rs", "move_mutation_paths", Direct),
        ("structure/plan.rs", "move_page_mutation_paths", Direct),
        (
            "structure/plan.rs",
            "rename_mutation_paths",
            Via("ensure_renamable_folder"),
        ),
        ("structure/plan.rs", "backlink_mutation_paths", Direct),
        ("structure/plan.rs", "delete_mutation_paths", Direct),
        (
            "structure/plan.rs",
            "collection_create_schema_paths",
            Direct,
        ),
        (
            "structure/spaces.rs",
            "reorder_child_spaces",
            NotAWrite("orders the registered Spaces of a Project, no content path"),
        ),
    ]
};

/// Module-qualified names of the guarded write operations, as
/// `run_every_write_through_root` names them.
fn checked_operations() -> std::collections::BTreeSet<&'static str> {
    INVENTORY
        .iter()
        .filter(|(_, _, guard)| !matches!(guard, Guard::NotAWrite(_)))
        .map(|(file, name, _)| operation_name(file, name))
        .collect()
}

fn operation_name(file: &str, name: &str) -> &'static str {
    let module = match file {
        "attachments/import.rs" => "attachments",
        "page/create.rs" => "create",
        "page/fields.rs" => "fields",
        "page/metadata.rs" => "metadata",
        "page/store.rs" => "store",
        "page/templates.rs" => "templates",
        "page/write/runtime.rs" => "write",
        "structure/ops.rs" | "structure/plan.rs" => "structure",
        other => panic!("no operation name for {other}"),
    };
    // `execute_managed_import` re-plans with `plan_managed_import`, which
    // the behavior test runs; the store wrappers run as their own names.
    let name = match name {
        "execute_managed_import" => "plan_managed_import",
        name => name,
    };
    Box::leak(format!("{module}::{name}").into_boxed_str())
}

fn source_files() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    let mut dirs: Vec<PathBuf> = SCANNED_DIRS.iter().map(|dir| root.join(dir)).collect();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.is_dir() {
                dirs.push(path);
            } else if name.ends_with(".rs")
                && !name.ends_with("tests.rs")
                && name != "test_support.rs"
            {
                let rel = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                // Normalize line endings: a Windows checkout has CRLF.
                let text = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
                files.push((rel, text));
            }
        }
    }
    files
}

/// Top-level `pub fn`/`pub async fn` names of `text` that exist outside
/// tests.
fn public_functions(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut names = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(rest) = line
            .strip_prefix("pub fn ")
            .or_else(|| line.strip_prefix("pub async fn "))
        else {
            continue;
        };
        if index > 0 && lines[index - 1].trim() == "#[cfg(test)]" {
            continue;
        }
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        names.push(name);
    }
    names
}

/// Body of the top-level function `name` of any visibility in `text`.
fn function_body<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line
            .trim_start_matches("pub(crate) ")
            .trim_start_matches("pub ");
        let signature = trimmed.strip_prefix("async ").unwrap_or(trimmed);
        if !line.starts_with(' ')
            && signature
                .strip_prefix("fn ")
                .and_then(|rest| rest.strip_prefix(name))
                .is_some_and(|rest| rest.starts_with('(') || rest.starts_with('<'))
        {
            let start = offset;
            let end = text[start..]
                .find("\n}\n")
                .map(|end| start + end + 2)
                .unwrap_or(text.len());
            return Some(&text[start..end]);
        }
        offset += line.len();
    }
    None
}

fn is_guarded(files: &[(String, String)], file: &str, name: &str, depth: usize) -> bool {
    assert!(depth < 4, "guard chain of {name} is too deep");
    let text = &files.iter().find(|(path, _)| path == file).unwrap().1;
    // A helper may live in another scanned file of the same module.
    let body = function_body(text, name)
        .or_else(|| files.iter().find_map(|(_, text)| function_body(text, name)));
    let Some(body) = body else {
        panic!("{file}: no function {name}");
    };
    if body.contains("ensure_path_in_space(") {
        return true;
    }
    match INVENTORY.iter().find(|(f, n, _)| *f == file && *n == name) {
        Some((_, _, Guard::Via(target))) => {
            body.contains(&format!("{target}(")) && is_guarded(files, file, target, depth + 1)
        }
        _ => false,
    }
}

#[test]
fn every_public_write_operation_with_a_space_path_passes_the_membership_rule() {
    let files = source_files();
    let mut found = Vec::new();
    for (file, text) in &files {
        for name in public_functions(text) {
            found.push((file.clone(), name));
        }
    }
    for (file, name) in &found {
        assert!(
            INVENTORY.iter().any(|(f, n, _)| f == file && n == name),
            "{file}: public fn {name} is not classified; a write that takes a path of a Space must call ensure_path_in_space and be listed as guarded"
        );
    }
    for (file, name, guard) in INVENTORY {
        assert!(
            found.iter().any(|(f, n)| f == file && n == name),
            "{file}: classified fn {name} no longer exists"
        );
        match guard {
            Guard::NotAWrite(_) => {}
            Guard::Direct | Guard::Via(_) => assert!(
                is_guarded(&files, file, name, 0),
                "{file}: {name} does not pass ensure_path_in_space"
            ),
        }
    }
}
