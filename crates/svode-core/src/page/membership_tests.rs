//! Writes addressed through a Space never reach into a registered child
//! Space: every write operation of `page`, `structure` and `attachments`
//! and every prepared schema mutation of `collections::engine` refuses a
//! source, parent, destination, Collection or item path that the child
//! owns, before its first write, and the inventory keeps new write
//! operations under the rule. A relation without `relation_scope` targets
//! a Collection of its own Space: a write that sets such a target in the
//! child, or follows a stored one to write there, is refused the same way.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::collections::CollectionError;
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

fn assert_schema_refused<T>(operation: &str, result: Result<T, CollectionError>) {
    match result {
        Err(CollectionError::PathInOtherSpace { space_id, .. }) if space_id == "eng" => {}
        Err(error) => panic!("{operation}: expected PathInOtherSpace of eng, got {error:?}"),
        Ok(_) => panic!("{operation}: expected PathInOtherSpace of eng, but it succeeded"),
    }
}

fn yaml(text: &str) -> serde_norway::Value {
    serde_norway::from_str(text).unwrap()
}

fn text_column(name: &str) -> engine::Column {
    serde_norway::from_str(&format!("{{ name: {name}, type: text }}")).unwrap()
}

fn option(name: &str) -> engine::PropertyOption {
    serde_norway::from_str(&format!("{{ name: {name} }}")).unwrap()
}

fn view(name: &str) -> engine::View {
    serde_norway::from_str(&format!("{{ type: table, name: {name} }}")).unwrap()
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
        "structure::create_page",
        structure::create_page(
            page_create(space, &at(""), project_str),
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
    for path in [at("Restored.md"), at("Gone/Restored.md")] {
        assert_refused(
            "write::restore",
            write::restore(
                write::PageRestore {
                    space,
                    path: &path,
                    content: "---\ntitle: Restored\n---\n",
                    project: Some(project_str),
                },
                page_runtime(index, &nonces),
                authorize,
            )
            .await,
        );
    }
    ran.push("write::restore");

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

    // collections::engine prepared schema mutations
    let item = at("Tasks/Item.md");
    macro_rules! schema_refused {
        ($name:literal, $result:expr) => {{
            assert_schema_refused($name, $result);
            ran.push($name);
        }};
    }
    schema_refused!(
        "engine::prepare_initial_collection_schema",
        engine::prepare_initial_collection_schema(
            space,
            &at("Board"),
            engine::default_collection_schema(),
            Some(project_str),
        )
    );
    schema_refused!(
        "engine::prepare_add_schema_column",
        engine::prepare_add_schema_column(space, &tasks, text_column("Extra"), Some(project_str))
    );
    schema_refused!(
        "engine::prepare_change_schema_type",
        engine::prepare_change_schema_type(
            space,
            &tasks,
            "Status",
            engine::PropertyType::Number,
            None,
            Some(project_str),
        )
    );
    schema_refused!(
        "engine::prepare_rename_schema_column",
        engine::prepare_rename_schema_column(space, &tasks, "Status", "State", Some(project_str))
    );
    schema_refused!(
        "engine::prepare_update_schema_column",
        engine::prepare_update_schema_column(
            space,
            &tasks,
            "Status",
            yaml("color: red"),
            Some(project_str),
        )
    );
    schema_refused!(
        "engine::prepare_delete_schema_column",
        engine::prepare_delete_schema_column(space, &tasks, "Status", true, Some(project_str))
    );
    schema_refused!(
        "engine::prepare_add_option",
        engine::prepare_add_option(space, &tasks, "Priority".into(), option("Mid"))
    );
    schema_refused!(
        "engine::prepare_update_option",
        engine::prepare_update_option(
            space,
            &tasks,
            "Priority".into(),
            "High".into(),
            None,
            Some(yaml("color: red")),
        )
    );
    schema_refused!(
        "engine::prepare_promote_orphan",
        engine::prepare_promote_orphan(space, &tasks, item.clone(), "Extra".into())
    );
    // The item path alone, with a Collection path of this Space.
    assert_schema_refused(
        "engine::prepare_promote_orphan",
        engine::prepare_promote_orphan(space, "Plain", item.clone(), "Extra".into()),
    );
    schema_refused!(
        "engine::prepare_update_system_field_label",
        engine::prepare_update_system_field_label(
            space,
            &tasks,
            "title".into(),
            Some("Name".into())
        )
    );
    schema_refused!(
        "engine::prepare_rename_option",
        engine::prepare_rename_option(
            space,
            &tasks,
            "Priority".into(),
            "High".into(),
            "Top".into()
        )
    );
    schema_refused!(
        "engine::prepare_delete_option",
        engine::prepare_delete_option(space, &tasks, "Priority".into(), "High".into(), true)
    );
    schema_refused!(
        "engine::prepare_clear_field_values",
        engine::prepare_clear_field_values(space, &tasks, "Status".into())
    );
    schema_refused!(
        "engine::prepare_clear_option_values",
        engine::prepare_clear_option_values(space, &tasks, "Priority".into(), vec!["High".into()])
    );
    schema_refused!(
        "engine::prepare_replace_option_values",
        engine::prepare_replace_option_values(
            space,
            &tasks,
            "Priority".into(),
            "High".into(),
            "Low".into(),
        )
    );
    schema_refused!(
        "engine::prepare_assign_unique_id",
        engine::prepare_assign_unique_id(space, &item)
    );
    schema_refused!(
        "engine::prepare_normalize_unique_id_counter",
        engine::prepare_normalize_unique_id_counter(space, &tasks)
    );
    schema_refused!(
        "engine::prepare_repair_two_way_relation",
        engine::prepare_repair_two_way_relation(
            space,
            &tasks,
            "Sprint",
            "from_this_side",
            None,
            Some(project_str),
        )
    );
    schema_refused!(
        "engine::prepare_add_view",
        engine::prepare_add_view(space, &tasks, view("Board"), None)
    );
    schema_refused!(
        "engine::prepare_rename_view",
        engine::prepare_rename_view(space, &tasks, "Table", "Grid")
    );
    schema_refused!(
        "engine::prepare_update_view",
        engine::prepare_update_view(space, &tasks, "Table", yaml("name: Grid"))
    );
    schema_refused!(
        "engine::prepare_delete_view",
        engine::prepare_delete_view(space, &tasks, "Table")
    );
    schema_refused!(
        "engine::prepare_duplicate_view",
        engine::prepare_duplicate_view(space, &tasks, "Table", "Copy")
    );
    schema_refused!(
        "engine::prepare_reorder_views",
        engine::prepare_reorder_views(space, &tasks, vec!["Table".into()])
    );
    schema_refused!(
        "engine::prepare_set_default_template",
        engine::prepare_set_default_template(space, &tasks, Some("basic".into()))
    );
    schema_refused!(
        "engine::prepare_reorder_templates",
        engine::prepare_reorder_templates(space, &tasks, vec!["basic".into()])
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

/// Collection `collection` of the Space at `space` with a text, a select, a
/// unique ID and a two-way relation column to the Collection `sprints`, a
/// view, a template and an item with an orphan field.
fn schema_fixture(space: &Path, collection: &str, sprints: &str) {
    write_tree(
        space,
        &[
            (
                &format!("{collection}/schema.yaml"),
                &format!(
                    "columns:
  - {{ name: Status, type: text }}
  - name: Priority
    type: select
    options:
      - {{ name: High }}
      - {{ name: Low }}
  - {{ name: Key, type: unique_id, prefix: T, next: 1 }}
  - {{ name: Sprint, type: relation, relation: {sprints}, limit: one, two_way: {collection} }}
views:
  - {{ type: table, name: Table }}
"
                ),
            ),
            (
                &format!("{collection}/Item.md"),
                "---\ntitle: Item\nStatus: Open\nPriority: High\nSprint: sprint-1.md\nExtra: hello\n---\n",
            ),
            (
                &format!("{collection}/.templates/basic.md"),
                "---\ntitle: Basic\n---\n",
            ),
            (
                &format!("{sprints}/schema.yaml"),
                &format!(
                    "columns:\n  - {{ name: {collection}, type: relation, relation: {collection}, two_way: Sprint }}\nviews: []\n"
                ),
            ),
            (
                &format!("{sprints}/sprint-1.md"),
                "---\ntitle: Sprint 1\n---\n",
            ),
        ],
    );
}

/// Every prepared schema mutation, applied through the Space at `space` to
/// its Collection `collection` from `schema_fixture`. Returns the names of
/// the operations it ran.
fn run_every_schema_mutation(space: &str, collection: &str, project: &str) -> Vec<&'static str> {
    let item = format!("{collection}/Item.md");
    let project = Some(project);
    let mut ran = Vec::new();
    macro_rules! applied {
        ($name:literal, $prepared:expr) => {{
            $prepared
                .unwrap_or_else(|error| panic!("{}: {error:?}", $name))
                .apply()
                .unwrap_or_else(|error| panic!("{}: {error:?}", $name));
            ran.push($name);
        }};
    }
    applied!(
        "engine::prepare_initial_collection_schema",
        engine::prepare_initial_collection_schema(
            space,
            &format!("{collection}Board"),
            engine::default_collection_schema(),
            project,
        )
    );
    applied!(
        "engine::prepare_add_schema_column",
        engine::prepare_add_schema_column(space, collection, text_column("Estimate"), project)
    );
    applied!(
        "engine::prepare_change_schema_type",
        engine::prepare_change_schema_type(
            space,
            collection,
            "Estimate",
            engine::PropertyType::Number,
            None,
            project,
        )
    );
    applied!(
        "engine::prepare_rename_schema_column",
        engine::prepare_rename_schema_column(space, collection, "Estimate", "Points", project)
    );
    applied!(
        "engine::prepare_update_schema_column",
        engine::prepare_update_schema_column(space, collection, "Points", yaml("min: 0"), project)
    );
    applied!(
        "engine::prepare_add_option",
        engine::prepare_add_option(space, collection, "Priority".into(), option("Mid"))
    );
    applied!(
        "engine::prepare_update_option",
        engine::prepare_update_option(
            space,
            collection,
            "Priority".into(),
            "Mid".into(),
            None,
            Some(yaml("color: red")),
        )
    );
    applied!(
        "engine::prepare_rename_option",
        engine::prepare_rename_option(
            space,
            collection,
            "Priority".into(),
            "Mid".into(),
            "Medium".into()
        )
    );
    applied!(
        "engine::prepare_replace_option_values",
        engine::prepare_replace_option_values(
            space,
            collection,
            "Priority".into(),
            "High".into(),
            "Low".into(),
        )
    );
    applied!(
        "engine::prepare_clear_option_values",
        engine::prepare_clear_option_values(
            space,
            collection,
            "Priority".into(),
            vec!["Low".into()]
        )
    );
    applied!(
        "engine::prepare_delete_option",
        engine::prepare_delete_option(space, collection, "Priority".into(), "Medium".into(), false)
    );
    applied!(
        "engine::prepare_clear_field_values",
        engine::prepare_clear_field_values(space, collection, "Status".into())
    );
    applied!(
        "engine::prepare_promote_orphan",
        engine::prepare_promote_orphan(space, collection, item.clone(), "Extra".into())
    );
    applied!(
        "engine::prepare_update_system_field_label",
        engine::prepare_update_system_field_label(
            space,
            collection,
            "title".into(),
            Some("Name".into())
        )
    );
    applied!(
        "engine::prepare_assign_unique_id",
        engine::prepare_assign_unique_id(space, &item)
    );
    applied!(
        "engine::prepare_normalize_unique_id_counter",
        engine::prepare_normalize_unique_id_counter(space, collection)
    );
    applied!(
        "engine::prepare_repair_two_way_relation",
        engine::prepare_repair_two_way_relation(
            space,
            collection,
            "Sprint",
            "from_this_side",
            None,
            project,
        )
    );
    applied!(
        "engine::prepare_add_view",
        engine::prepare_add_view(space, collection, view("Board"), None)
    );
    applied!(
        "engine::prepare_rename_view",
        engine::prepare_rename_view(space, collection, "Board", "Kanban")
    );
    applied!(
        "engine::prepare_update_view",
        engine::prepare_update_view(space, collection, "Kanban", yaml("name: Grid"))
    );
    applied!(
        "engine::prepare_duplicate_view",
        engine::prepare_duplicate_view(space, collection, "Grid", "Copy")
    );
    applied!(
        "engine::prepare_reorder_views",
        engine::prepare_reorder_views(
            space,
            collection,
            vec!["Copy".into(), "Table".into(), "Grid".into()]
        )
    );
    applied!(
        "engine::prepare_delete_view",
        engine::prepare_delete_view(space, collection, "Copy")
    );
    applied!(
        "engine::prepare_set_default_template",
        engine::prepare_set_default_template(space, collection, Some("basic".into()))
    );
    applied!(
        "engine::prepare_reorder_templates",
        engine::prepare_reorder_templates(space, collection, vec!["basic".into()])
    );
    applied!(
        "engine::prepare_delete_schema_column",
        engine::prepare_delete_schema_column(space, collection, "Points", true, project)
    );
    ran
}

/// Paths of a tree snapshot outside the child Space `eng`.
fn outside_eng(snapshot: &[(String, Vec<u8>)]) -> Vec<(String, Vec<u8>)> {
    snapshot
        .iter()
        .filter(|(path, _)| path != "eng" && !path.starts_with("eng/"))
        .cloned()
        .collect()
}

#[test]
fn schema_mutations_through_the_child_space_and_on_root_collections_still_succeed() {
    let engine_operations: std::collections::BTreeSet<_> = checked_operations()
        .into_iter()
        .filter(|name| name.starts_with("engine::"))
        .collect();
    for kind in CHILD_REPOSITORIES {
        let temp = project(kind);
        let root = temp.path().canonicalize().unwrap();
        let project_str = root.to_str().unwrap();
        let eng = root.join("eng");
        schema_fixture(&eng, "Tasks", "Sprints");
        schema_fixture(&root, "Notes", "Cycles");

        // In the child Space, through the child Space.
        let root_before = outside_eng(&tree_snapshot(&root));
        let ran = run_every_schema_mutation(eng.to_str().unwrap(), "Tasks", project_str);
        assert_eq!(
            ran.into_iter().collect::<std::collections::BTreeSet<_>>(),
            engine_operations,
            "every prepared schema mutation runs here"
        );
        assert_eq!(outside_eng(&tree_snapshot(&root)), root_before, "{kind:?}");
        let tasks = fs::read_to_string(eng.join("Tasks/schema.yaml")).unwrap();
        assert!(tasks.contains("name: Extra"), "{kind:?}: {tasks}");
        assert!(tasks.contains("name: Grid"), "{kind:?}: {tasks}");
        assert!(eng.join("TasksBoard/schema.yaml").is_file(), "{kind:?}");

        // In the root Space, on its own Collection.
        let eng_before = tree_snapshot(&eng);
        run_every_schema_mutation(project_str, "Notes", project_str);
        assert_eq!(tree_snapshot(&eng), eng_before, "{kind:?}");
        let notes = fs::read_to_string(root.join("Notes/schema.yaml")).unwrap();
        assert!(notes.contains("name: Extra"), "{kind:?}: {notes}");
        assert!(root.join("NotesBoard/schema.yaml").is_file(), "{kind:?}");
    }
}

// ---------------------------------------------------------------------------
// Relation targets without scope
// ---------------------------------------------------------------------------

fn relation_column(text: &str) -> engine::Column {
    serde_norway::from_str(text).unwrap()
}

fn assert_relation_refused<T>(operation: &str, result: Result<T, CollectionError>) {
    match result {
        Err(CollectionError::RelationTargetInOtherSpace { path, space_id })
            if space_id == "eng" && path.to_lowercase().ends_with("tasks") => {}
        Err(error) => {
            panic!("{operation}: expected RelationTargetInOtherSpace of eng, got {error:?}")
        }
        Ok(_) => {
            panic!("{operation}: expected RelationTargetInOtherSpace of eng, but it succeeded")
        }
    }
}

fn assert_page_relation_refused<T>(operation: &str, result: Result<T, PageError>) {
    match result {
        Err(PageError::RelationTargetInOtherSpace { space_id, .. }) if space_id == "eng" => {}
        Err(error) => {
            panic!("{operation}: expected RelationTargetInOtherSpace of eng, got {error:?}")
        }
        Ok(_) => {
            panic!("{operation}: expected RelationTargetInOtherSpace of eng, but it succeeded")
        }
    }
}

/// Root Collection `Notes` with an item, a view and relation columns whose
/// targets the tests change: `Cycle` to the root Collection `Cycles`,
/// `Scoped` to `Tasks` of Space `eng` through `relation_scope`, and
/// `Rooted` to `eng/Tasks` through the root scope. `stored` adds the
/// columns a project written before this rule may hold: the two-way
/// `Task` and the one-way `Ref`, both to `eng/Tasks` without scope.
fn relation_fixture(root: &Path, stored: bool) {
    let stored_columns = if stored {
        "  - { name: Task, type: relation, relation: eng/Tasks, two_way: Notes }
  - { name: Ref, type: relation, relation: eng/Tasks }
"
    } else {
        ""
    };
    write_tree(
        root,
        &[
            (
                "Notes/schema.yaml",
                &format!(
                    "columns:
  - {{ name: Status, type: text }}
  - {{ name: Cycle, type: relation, relation: Cycles }}
  - {{ name: Scoped, type: relation, relation: Tasks, relation_scope: {{ type: space, id: eng }} }}
  - {{ name: Rooted, type: relation, relation: eng/Tasks, relation_scope: {{ type: root }} }}
{stored_columns}views:
  - {{ type: table, name: Table }}
"
                ),
            ),
            ("Notes/README.md", "---\ntitle: Notes\n---\n"),
            ("Notes/First.md", "---\ntitle: First\nStatus: Open\n---\n"),
            ("Cycles/schema.yaml", "columns: []\nviews: []\n"),
            ("Cycles/README.md", "---\ntitle: Cycles\n---\n"),
        ],
    );
}

/// Every write that sets the target of a relation through the root Space
/// at `space` to `target`, a Collection of the child Space `eng`, without
/// `relation_scope`.
fn refuse_every_relation_target(space: &str, project: &str, target: &str) {
    let project = Some(project);
    for column in [
        format!("{{ name: Task, type: relation, relation: {target} }}"),
        format!("{{ name: Task, type: relation, relation: {target}, two_way: Notes }}"),
    ] {
        assert_relation_refused(
            "engine::prepare_add_schema_column",
            engine::prepare_add_schema_column(space, "Notes", relation_column(&column), project),
        );
    }
    for patch in [
        format!("relation: {target}"),
        format!("{{ relation: {target}, two_way: Notes }}"),
    ] {
        assert_relation_refused(
            "engine::prepare_update_schema_column (target)",
            engine::prepare_update_schema_column(space, "Notes", "Cycle", yaml(&patch), project),
        );
    }
    assert_relation_refused(
        "engine::prepare_update_schema_column (target and scope)",
        engine::prepare_update_schema_column(
            space,
            "Notes",
            "Scoped",
            yaml(&format!("{{ relation: {target}, relation_scope: null }}")),
            project,
        ),
    );
    if target == "eng/Tasks" {
        assert_relation_refused(
            "engine::prepare_update_schema_column (scope)",
            engine::prepare_update_schema_column(
                space,
                "Notes",
                "Rooted",
                yaml("relation_scope: null"),
                project,
            ),
        );
    }
    assert_relation_refused(
        "engine::prepare_change_schema_type",
        engine::prepare_change_schema_type(
            space,
            "Notes",
            "Status",
            engine::PropertyType::Relation,
            Some(yaml(&format!("relation: {target}"))),
            project,
        ),
    );
    let mut schema = engine::default_collection_schema();
    schema.columns.push(relation_column(&format!(
        "{{ name: Task, type: relation, relation: {target} }}"
    )));
    assert_relation_refused(
        "engine::prepare_initial_collection_schema",
        engine::prepare_initial_collection_schema(space, "Fresh", schema, project),
    );
}

#[tokio::test]
async fn a_relation_target_of_a_child_space_without_scope_is_refused() {
    for kind in CHILD_REPOSITORIES {
        let temp = project(kind);
        let root = temp.path().canonicalize().unwrap();
        let space = root.to_str().unwrap();
        relation_fixture(&root, false);
        let before = tree_snapshot(&root);

        refuse_every_relation_target(space, space, "eng/Tasks");

        let index = IndexRuntimeState::default();
        let sink = RecordingSink::default();
        let mut create = collection_create(space, "", space);
        create.schema.columns.push(relation_column(
            "{ name: Task, type: relation, relation: eng/Tasks }",
        ));
        assert_page_relation_refused(
            "structure::create_collection",
            structure::create_collection(create, structure_runtime(&index, &sink), authorize).await,
        );

        assert_eq!(tree_snapshot(&root), before, "{kind:?}");
        assert!(sink.0.lock().unwrap().is_empty(), "{kind:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_relation_target_through_a_symlink_into_a_child_space_is_refused() {
    let temp = project(ChildRepository::Independent);
    let root = temp.path().canonicalize().unwrap();
    let space = root.to_str().unwrap();
    relation_fixture(&root, false);
    std::os::unix::fs::symlink(root.join("eng/Tasks"), root.join("Area/link")).unwrap();
    let before = tree_snapshot(&root);

    let column = "{ name: Task, type: relation, relation: Area/link, two_way: Notes }";
    match engine::prepare_add_schema_column(space, "Notes", relation_column(column), Some(space)) {
        Err(CollectionError::RelationTargetInOtherSpace { space_id, .. }) if space_id == "eng" => {}
        other => panic!("{:?}", other.map(|_| ())),
    }

    assert_eq!(tree_snapshot(&root), before);
}

#[test]
fn another_letter_case_of_a_relation_target_in_a_child_space_is_refused() {
    let temp = project(ChildRepository::Inline);
    let root = temp.path().canonicalize().unwrap();
    if !root.join("ENG").exists() {
        // A case-sensitive file system has no such path to protect.
        return;
    }
    let space = root.to_str().unwrap();
    relation_fixture(&root, false);
    let before = tree_snapshot(&root);

    refuse_every_relation_target(space, space, "ENG/tasks");

    assert_eq!(tree_snapshot(&root), before);
}

#[test]
fn a_two_way_relation_to_a_child_space_through_relation_scope_still_works() {
    for kind in CHILD_REPOSITORIES {
        let temp = project(kind);
        let root = temp.path().canonicalize().unwrap();
        let space = root.to_str().unwrap();
        relation_fixture(&root, false);

        engine::prepare_add_schema_column(
            space,
            "Notes",
            relation_column(
                "{ name: Task, type: relation, relation: Tasks, relation_scope: { type: space, id: eng }, two_way: Notes }",
            ),
            Some(space),
        )
        .unwrap()
        .apply()
        .unwrap();

        let tasks =
            engine::read_collection_schema(root.join("eng").to_str().unwrap(), "Tasks").unwrap();
        let reverse = tasks.column("Notes").expect("reverse column");
        assert_eq!(reverse.relation.as_deref(), Some("Notes"), "{kind:?}");
        assert!(
            matches!(
                reverse.relation_scope,
                Some(engine::RelationScope::Root { .. })
            ),
            "{kind:?}: {:?}",
            reverse.relation_scope
        );
        assert_eq!(reverse.two_way.as_deref(), Some("Task"), "{kind:?}");
    }
}

#[tokio::test]
async fn a_stored_relation_without_scope_blocks_only_writes_that_follow_it() {
    for kind in CHILD_REPOSITORIES {
        let temp = project(kind);
        let root = temp.path().canonicalize().unwrap();
        let space = root.to_str().unwrap();
        let project = Some(space);
        relation_fixture(&root, true);
        let eng = root.join("eng");
        let eng_before = tree_snapshot(&eng);
        let index = IndexRuntimeState::default();
        let nonces = WriteNonceRegistry::default();

        // Writes that do not follow the stored relations.
        let notes_before = tree_snapshot(&root.join("Notes"));
        for (name, outcome) in [
            (
                "view",
                engine::prepare_update_view(space, "Notes", "Table", yaml("name: Grid"))
                    .and_then(engine::PreparedCollectionMutation::apply)
                    .map(|_| ()),
            ),
            (
                "add column",
                engine::prepare_add_schema_column(space, "Notes", text_column("Extra"), project)
                    .and_then(engine::PreparedCollectionMutation::apply)
                    .map(|_| ()),
            ),
            (
                "rename column",
                engine::prepare_rename_schema_column(space, "Notes", "Status", "State", project)
                    .and_then(engine::PreparedCollectionMutation::apply)
                    .map(|_| ()),
            ),
            (
                "update one-way",
                engine::prepare_update_schema_column(
                    space,
                    "Notes",
                    "Ref",
                    yaml("limit: one"),
                    project,
                )
                .and_then(engine::PreparedCollectionMutation::apply)
                .map(|_| ()),
            ),
            (
                "rename one-way",
                engine::prepare_rename_schema_column(space, "Notes", "Ref", "Reference", project)
                    .and_then(engine::PreparedCollectionMutation::apply)
                    .map(|_| ()),
            ),
        ] {
            outcome.unwrap_or_else(|error| panic!("{kind:?} {name}: {error:?}"));
        }
        let values = BTreeMap::from([("Reference".to_string(), serde_json::json!("Item.md"))]);
        fields::update(
            fields::PageFieldUpdate {
                space,
                path: "Notes/First.md",
                project,
                values: &values,
                intent: ItemFieldBatchIntent::Literal,
            },
            page_runtime(&index, &nonces),
            authorize,
        )
        .await
        .unwrap_or_else(|error| panic!("{kind:?} one-way value: {error:?}"));
        engine::prepare_delete_schema_column(space, "Notes", "Reference", true, project)
            .and_then(engine::PreparedCollectionMutation::apply)
            .unwrap_or_else(|error| panic!("{kind:?} delete one-way: {error:?}"));
        assert_ne!(tree_snapshot(&root.join("Notes")), notes_before, "{kind:?}");
        assert_eq!(tree_snapshot(&eng), eng_before, "{kind:?}");

        // Writes that follow the two-way relation into the child Space.
        let before = tree_snapshot(&root);
        assert_relation_refused(
            "rename two-way",
            engine::prepare_rename_schema_column(space, "Notes", "Task", "Job", project),
        );
        assert_relation_refused(
            "delete two-way",
            engine::prepare_delete_schema_column(space, "Notes", "Task", true, project),
        );
        assert_relation_refused(
            "update two-way",
            engine::prepare_update_schema_column(
                space,
                "Notes",
                "Task",
                yaml("limit: one"),
                project,
            ),
        );
        assert_relation_refused(
            "change type of two-way",
            engine::prepare_change_schema_type(
                space,
                "Notes",
                "Task",
                engine::PropertyType::Text,
                None,
                project,
            ),
        );
        assert_relation_refused(
            "repair two-way",
            engine::prepare_repair_two_way_relation(
                space,
                "Notes",
                "Task",
                "from_this_side",
                None,
                project,
            ),
        );
        let values = BTreeMap::from([("Task".to_string(), serde_json::json!("Item.md"))]);
        assert_page_relation_refused(
            "two-way value",
            fields::update(
                fields::PageFieldUpdate {
                    space,
                    path: "Notes/First.md",
                    project,
                    values: &values,
                    intent: ItemFieldBatchIntent::Literal,
                },
                page_runtime(&index, &nonces),
                authorize,
            )
            .await,
        );
        assert_page_relation_refused(
            "store::update_field two-way value",
            store::update_field(
                space,
                project,
                "Notes/First.md",
                "Task",
                serde_json::json!("Item.md"),
            ),
        );
        assert_eq!(tree_snapshot(&root), before, "{kind:?}");
    }
}

// ---------------------------------------------------------------------------
// Inventory of public write operations
// ---------------------------------------------------------------------------

/// Source files of the modules whose public functions take a path of a
/// Space. Every top-level public function in them is classified below.
const SCANNED_DIRS: &[&str] = &["page", "structure", "attachments", "collections/engine"];

/// How a public function meets the rule.
enum Guard {
    /// Its body calls `ensure_path_in_space` for its paths.
    Direct,
    /// Its body calls the named guarded function first.
    Via(&'static str),
    /// Not a write addressed by a path of a Space; the reason says why.
    NotAWrite(#[allow(dead_code)] &'static str),
    /// A write step that only guarded operations of `svode-core` run; the
    /// reason names them. No host calls it, so a host reaches the write only
    /// through an operation that passes the rule.
    Step(#[allow(dead_code)] &'static str),
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
        ("page/membership.rs", "disk_spelling", READ),
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
        ("page/write/restore.rs", "restore", Direct),
        ("page/write/restore_source.rs", "restore_source", READ),
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
        ("structure/ops.rs", "create_page", Direct),
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

/// Public functions of `collections::engine`, by file: its prepared schema
/// mutations pass the rule, its other writes are steps of guarded
/// operations.
const ENGINE_INVENTORY: &[(&str, &[(&str, Guard)])] = {
    use Guard::{NotAWrite, Step, Via};
    const PURE: Guard = NotAWrite("pure value or path computation");
    const READ: Guard = NotAWrite("reads without writing");
    const DEFAULTS: Guard = NotAWrite("fills item metadata in memory from the schema");
    const GUARDED: Guard = Via("ensure_paths_in_space");
    const SCHEMA_STEP: Guard = Step("schema write applied by a guarded prepared mutation");
    const SEED_STEP: Guard =
        Step("seed schema of the guarded Collection conversions and template create");
    const ITEM_STEP: Guard =
        Step("item write of the guarded page create, write, fields and template operations");
    const STRUCTURE_STEP: Guard =
        Step("relation effect of the guarded structure delete, move, rename and duplicate");
    const RENUMBER_STEP: Guard =
        Step("Git renumbering of unique IDs across the repository, outside this rule");
    &[
        (
            "defaults.rs",
            &[
                ("apply_schema_defaults_for_path", DEFAULTS),
                ("apply_contextual_defaults_for_path", DEFAULTS),
                ("apply_contextual_defaults_for_path_strict", DEFAULTS),
                ("apply_schema_defaults_to_item_tree", ITEM_STEP),
                ("unique_id_mutation_paths_for_item", READ),
                ("unique_id_mutation_paths_for_item_tree", READ),
                ("unique_id_schema_path_for_item", READ),
                ("assign_unique_ids_to_item_tree", ITEM_STEP),
                ("assign_unique_id", SCHEMA_STEP),
                ("reassign_unique_ids", RENUMBER_STEP),
                ("normalize_unique_id_counter", SCHEMA_STEP),
                ("assign_unique_id_to_meta_for_path", ITEM_STEP),
                ("force_assign_unique_id_to_meta_for_path", ITEM_STEP),
            ],
        ),
        (
            "field_rules.rs",
            &[
                ("normalize_schema", PURE),
                ("validate_item_field_value", READ),
                ("ensure_item_field_writable", READ),
                ("normalize_item_field_value", READ),
            ],
        ),
        (
            "integrity.rs",
            &[("validate_collection_integrity_with_project", READ)],
        ),
        (
            "mod.rs",
            &[
                ("column_effective_sensitivity", PURE),
                ("schema_has_sensitive_columns", PURE),
                ("default_status_options", PURE),
                ("resolve_collection_schema_result", READ),
                ("schema_response", READ),
                ("read_collection_schema", READ),
                ("schema_mutation_paths", READ),
                ("schema_column_mutation_paths", READ),
                ("schema_column_mutation_paths_with_project", READ),
                ("schema_column_name_mutation_paths", READ),
                ("schema_column_name_mutation_paths_with_project", READ),
                ("schema_type_target_mutation_paths_with_project", READ),
                (
                    "schema_column_patch_target_mutation_paths_with_project",
                    READ,
                ),
                ("cascade_clean_deleted_items", STRUCTURE_STEP),
                ("cascade_clean_deleted_items_with_project", STRUCTURE_STEP),
                (
                    "cascade_clean_deleted_items_mutation_paths_with_project",
                    READ,
                ),
                ("rewrite_relation_paths_for_move", STRUCTURE_STEP),
                (
                    "rewrite_relation_paths_for_move_with_project",
                    STRUCTURE_STEP,
                ),
                (
                    "rewrite_relation_paths_for_move_with_authorized_plan",
                    STRUCTURE_STEP,
                ),
                ("relation_move_mutation_paths_with_project", READ),
                ("rewrite_internal_relation_refs_for_copy", STRUCTURE_STEP),
                ("update_relation_item_field", ITEM_STEP),
                ("prepare_item_field_batch", READ),
                ("apply_prepared_item_field_relations", ITEM_STEP),
                ("item_property_batch_mutation_paths_with_project", READ),
                (
                    "relation_field_target_mutation_paths_for_value_with_project",
                    READ,
                ),
                ("validate_property_value", PURE),
                ("relation_repair_mutation_paths", READ),
                ("relation_repair_mutation_paths_with_project", READ),
                ("repair_two_way_relation", SCHEMA_STEP),
                ("repair_two_way_relation_with_project", SCHEMA_STEP),
            ],
        ),
        (
            "mutations.rs",
            &[
                ("prepare_initial_collection_schema", GUARDED),
                ("prepare_add_schema_column", GUARDED),
                ("prepare_change_schema_type", GUARDED),
                ("prepare_rename_schema_column", GUARDED),
                ("prepare_update_schema_column", GUARDED),
                ("prepare_delete_schema_column", GUARDED),
                ("prepare_add_option", GUARDED),
                ("prepare_update_option", GUARDED),
                ("prepare_promote_orphan", GUARDED),
                ("prepare_update_system_field_label", GUARDED),
                ("prepare_rename_option", GUARDED),
                ("prepare_delete_option", GUARDED),
                ("prepare_clear_field_values", GUARDED),
                ("prepare_clear_option_values", GUARDED),
                ("prepare_replace_option_values", GUARDED),
                ("prepare_assign_unique_id", GUARDED),
                ("prepare_normalize_unique_id_counter", GUARDED),
                ("prepare_repair_two_way_relation", GUARDED),
                ("prepare_add_view", GUARDED),
                ("prepare_rename_view", GUARDED),
                ("prepare_update_view", GUARDED),
                ("prepare_delete_view", GUARDED),
                ("prepare_duplicate_view", GUARDED),
                ("prepare_reorder_views", GUARDED),
            ],
        ),
        ("query_filters.rs", &[("resolve_query_filters", READ)]),
        (
            "schema_mutations.rs",
            &[
                ("add_schema_column", SCHEMA_STEP),
                ("add_schema_column_with_project", SCHEMA_STEP),
                ("change_schema_type", SCHEMA_STEP),
                ("change_schema_type_with_warnings", SCHEMA_STEP),
                ("change_schema_type_with_warnings_and_project", SCHEMA_STEP),
                ("rename_schema_column", SCHEMA_STEP),
                ("rename_schema_column_with_project", SCHEMA_STEP),
                ("update_schema_column", SCHEMA_STEP),
                ("update_schema_column_with_project", SCHEMA_STEP),
                ("delete_schema_column", SCHEMA_STEP),
                ("delete_schema_column_with_project", SCHEMA_STEP),
                ("add_option", SCHEMA_STEP),
                ("rename_option", SCHEMA_STEP),
                ("delete_option", SCHEMA_STEP),
                ("clear_field_values", SCHEMA_STEP),
                ("clear_option_values", SCHEMA_STEP),
                ("replace_option_values", SCHEMA_STEP),
                ("update_option", SCHEMA_STEP),
                ("promote_orphan", SCHEMA_STEP),
                ("update_system_field_label", SCHEMA_STEP),
                ("set_default_template", SCHEMA_STEP),
                ("reorder_templates", SCHEMA_STEP),
                ("default_collection_schema", PURE),
                ("write_default_collection_schema", SEED_STEP),
                ("add_view", SCHEMA_STEP),
                ("rename_view", SCHEMA_STEP),
                ("update_view", SCHEMA_STEP),
                ("delete_view", SCHEMA_STEP),
                ("duplicate_view", SCHEMA_STEP),
                ("reorder_views", SCHEMA_STEP),
            ],
        ),
        (
            "templates.rs",
            &[
                ("list_templates", READ),
                ("ensure_template_exists", READ),
                ("validate_template_order", READ),
                ("prepare_set_default_template", GUARDED),
                ("prepare_reorder_templates", GUARDED),
                ("resolve_template_source", READ),
                ("templates_dir", PURE),
                ("template_head_rel", PURE),
                ("join_template_rel", PURE),
                ("template_rel_abs", PURE),
                ("normalize_template_rel", PURE),
                ("humanize_template_slug", PURE),
            ],
        ),
    ]
};

/// Every classified public function with its source file.
fn inventory() -> Vec<(String, &'static str, &'static Guard)> {
    INVENTORY
        .iter()
        .map(|(file, name, guard)| (file.to_string(), *name, guard))
        .chain(ENGINE_INVENTORY.iter().flat_map(|(file, rows)| {
            rows.iter()
                .map(move |(name, guard)| (format!("collections/engine/{file}"), *name, guard))
        }))
        .collect()
}

/// Module-qualified names of the guarded write operations, as
/// `run_every_write_through_root` names them.
fn checked_operations() -> std::collections::BTreeSet<&'static str> {
    inventory()
        .iter()
        .filter(|(_, _, guard)| matches!(guard, Guard::Direct | Guard::Via(_)))
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
        "page/write/runtime.rs" | "page/write/restore.rs" => "write",
        "structure/ops.rs" | "structure/plan.rs" => "structure",
        "collections/engine/mutations.rs" | "collections/engine/templates.rs" => "engine",
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
    match inventory()
        .into_iter()
        .find(|(f, n, _)| f == file && *n == name)
    {
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
    let inventory = inventory();
    for (file, name) in &found {
        assert!(
            inventory.iter().any(|(f, n, _)| f == file && n == name),
            "{file}: public fn {name} is not classified; a write that takes a path of a Space must call ensure_path_in_space and be listed as guarded"
        );
    }
    for (file, name, guard) in &inventory {
        assert!(
            found.iter().any(|(f, n)| f == file && n == name),
            "{file}: classified fn {name} no longer exists"
        );
        match guard {
            Guard::NotAWrite(_) | Guard::Step(_) => {}
            Guard::Direct | Guard::Via(_) => assert!(
                is_guarded(&files, file, name, 0),
                "{file}: {name} does not pass ensure_path_in_space"
            ),
        }
    }
}

/// Production sources of the crates that host `svode-core`: every crate of
/// the workspace except the core itself, and the Desktop backend.
fn host_source_files() -> Vec<(String, String)> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut dirs: Vec<PathBuf> = fs::read_dir(manifest.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.as_path() != manifest)
        .map(|path| path.join("src"))
        .chain([manifest.join("../../apps/desktop/src-tauri/src")])
        .filter(|path| path.is_dir())
        .collect();
    let mut files = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if path.is_dir() {
                if name != "tests" {
                    dirs.push(path);
                }
            } else if name.ends_with(".rs") && !name.ends_with("tests.rs") {
                let text = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
                // An inline test module closes a production file.
                let text = match text.find("\n#[cfg(test)]\nmod ") {
                    Some(end) => text[..end].to_string(),
                    None => text,
                };
                files.push((path.display().to_string(), text));
            }
        }
    }
    files
}

/// Whether `text` calls or imports the `collections::engine` function
/// `name`.
fn reaches_engine_function(text: &str, name: &str) -> bool {
    if [format!("engine::{name}("), format!("engine::{name};")]
        .iter()
        .any(|pattern| text.contains(pattern.as_str()))
    {
        return true;
    }
    text.match_indices("collections::engine::{")
        .any(|(start, prefix)| {
            let group = &text[start + prefix.len()..];
            let group = &group[..group.find('}').unwrap_or(group.len())];
            group.split(',').any(|item| item.trim() == name)
        })
}

#[test]
fn hosts_reach_schema_writes_only_through_operations_under_the_rule() {
    let hosts = host_source_files();
    assert!(
        hosts
            .iter()
            .any(|(_, text)| reaches_engine_function(text, "prepare_add_view")),
        "the scan finds the host calls of prepared mutations"
    );
    for (file, name, guard) in inventory() {
        if !matches!(guard, Guard::Step(_)) {
            continue;
        }
        for (host, text) in &hosts {
            assert!(
                !reaches_engine_function(text, name),
                "{host} reaches the write step {name} of {file}; call an operation that passes ensure_path_in_space"
            );
        }
    }
}
