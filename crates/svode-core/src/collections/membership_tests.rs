//! DF-205: the items of a Collection are the direct children of its root;
//! deeper Pages under the same schema are items only with `nested_items: true`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_norway::Value;
use sqlx::SqlitePool;
use tempfile::TempDir;

use super::engine;
use super::entries::entries_from_rows;
use super::list::list_collections;
use super::query::query_entry_rows;
use super::schema::{find_collection_root, resolve_collection_schema_result};
use super::traversal::collection_markdown_files;
use crate::index::IndexKey;
use crate::index::db;
use crate::index::entry_projection::build_entry_with_dates;
use crate::index::inventory::MarkdownProjection;
use crate::index::reindex::full_reindex;
use crate::index::state::IndexRuntimeState;
use crate::index::update;
use crate::page::create::{PageCreate, create};
use crate::page::dates::SystemGitDateExecutor;
use crate::page::identity::{ContentOwnerKind, PageRole, resolve_markdown_identity_for_path};
use crate::page::test_support::{scaffold_space, update_state};
use crate::page::{PageError, entry, templates};
use crate::routines::observation::snapshot_from_entry;
use crate::structure::{StructureRuntime, entry_commit_name, move_entry};

const TASKS_COLUMNS: &str = "columns:
  - { name: Status, type: text, default: Todo }
  - { name: Key, type: unique_id, prefix: T, next: 5 }
  - { name: Mail, type: email }
  - name: Priority
    type: select
    options:
      - { name: High }
      - { name: Low }
views: []
";

const DIRECT: [&str; 2] = ["tasks/a.md", "tasks/b/README.md"];
const DEEP: [&str; 4] = [
    "tasks/b/note.md",
    "tasks/b/sub/c.md",
    "tasks/d/e.md",
    "tasks/b/inner/README.md",
];

fn tasks_schema(nested_items: bool) -> String {
    if nested_items {
        format!("nested_items: true\n{TASKS_COLUMNS}")
    } else {
        TASKS_COLUMNS.to_string()
    }
}

/// Collection `tasks` with direct items `a.md` and `b/README.md`, deep Pages
/// below them, the nested Collection `b/inner`, a template and the Collection
/// `links` whose relation points at the deep Page `b/note.md`.
fn fixture(nested_items: bool) -> TempDir {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    scaffold_space(root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    let schema = tasks_schema(nested_items);
    for (path, content) in [
        ("tasks/schema.yaml", schema.as_str()),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
        (
            "tasks/a.md",
            "---\ntitle: A\nStatus: Todo\nKey: 1\nPriority: High\n---\n",
        ),
        (
            "tasks/b/README.md",
            "---\ntitle: B\nStatus: Todo\nKey: 2\n---\n",
        ),
        (
            "tasks/b/note.md",
            "---\ntitle: Note\nStatus: Done\nKey: 3\nPriority: High\n---\nNote body\n",
        ),
        ("tasks/b/sub/c.md", "---\ntitle: C\n---\n"),
        ("tasks/d/e.md", "---\ntitle: E\n---\n"),
        ("tasks/b/inner/schema.yaml", "columns: []\nviews: []\n"),
        ("tasks/b/inner/README.md", "---\ntitle: Inner\n---\n"),
        ("tasks/b/inner/i.md", "---\ntitle: I\n---\n"),
        ("tasks/.templates/t.md", "---\ntitle: T\n---\n"),
        (
            "links/schema.yaml",
            "columns:\n  - { name: Task, type: relation, relation: tasks }\nviews: []\n",
        ),
        ("links/README.md", "---\ntitle: Links\n---\n"),
        ("links/x.md", "---\ntitle: X\nTask: [b/note.md]\n---\n"),
        ("Loose.md", "---\ntitle: Loose\n---\n"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    temp
}

fn space(temp: &TempDir) -> &str {
    temp.path().to_str().unwrap()
}

fn source_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for item in fs::read_dir(dir).unwrap() {
            let path = item.unwrap().path();
            if path.strip_prefix(root).unwrap().starts_with(".svode") {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else {
                files.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    files
}

async fn index_pool(root: &Path) -> SqlitePool {
    let pool = db::create_pool(&root.join(".svode/index.db"))
        .await
        .unwrap();
    db::ensure_schema(&pool).await.unwrap();
    full_reindex::<crate::git::cli::GitCli>(None, &pool, root, &[])
        .await
        .unwrap();
    pool
}

async fn indexed_members(pool: &SqlitePool, collection: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT file_path FROM entries WHERE in_collection = 1 AND collection_root_path = ? \
         ORDER BY file_path",
    )
    .bind(collection)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn queried_members(pool: &SqlitePool, space: &str, include_nested: bool) -> Vec<String> {
    let schema = engine::read_collection_schema(space, "tasks").unwrap();
    let rows = query_entry_rows(pool, &schema, "tasks", &[], &[], None, None)
        .await
        .unwrap();
    let mut paths = entries_from_rows(space, "tasks", rows, include_nested, false)
        .unwrap()
        .into_iter()
        .map(|entry| entry.path)
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn traversed_members(space: &str) -> Vec<String> {
    let mut paths = collection_markdown_files(space, "tasks")
        .unwrap()
        .into_iter()
        .map(|path| {
            path.strip_prefix(space)
                .unwrap()
                .to_string_lossy()
                .trim_start_matches('/')
                .replace('\\', "/")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn row_count(space: &str) -> usize {
    list_collections(space)
        .unwrap()
        .into_iter()
        .find(|collection| collection.path == "tasks")
        .unwrap()
        .row_count
}

fn write_relation(space: &str, target: &str) -> Result<(), super::CollectionError> {
    engine::update_relation_entry_field(
        space,
        None,
        "links/x.md",
        "Task",
        Value::Sequence(vec![Value::String(target.into())]),
    )
    .map(|_| ())
}

fn outside_target_issues(space: &str) -> Vec<String> {
    engine::validate_collection_integrity_with_project(space, Some("links"), None)
        .unwrap()
        .errors
        .into_iter()
        .filter(|issue| issue.code == "RELATION_ENTRY_OUTSIDE_TARGET")
        .filter_map(|issue| issue.related_path)
        .collect()
}

/// Whether a change of the Page reaches the event Routines of a Collection.
fn observed_by_collection_routines(root: &Path, path: &str) -> bool {
    let entry = build_entry_with_dates(
        root,
        &root.join(path),
        None,
        MarkdownProjection::Discoverable,
    )
    .unwrap();
    snapshot_from_entry(root, &entry).unwrap().is_some()
}

fn role(space: &Path, path: &str) -> Option<PageRole> {
    resolve_markdown_identity_for_path(space, path, false)
        .unwrap()
        .page_role
}

#[tokio::test]
async fn deep_pages_without_the_flag_are_plain_pages_for_every_membership_path() {
    let temp = fixture(false);
    let root = temp.path();
    let space = space(&temp);

    for path in DIRECT {
        assert_eq!(
            find_collection_root(root, path),
            Some("tasks".into()),
            "{path}"
        );
        assert!(
            engine::schema_response(space, path).unwrap().is_some(),
            "{path}"
        );
        assert_eq!(role(root, path), Some(PageRole::CollectionItem), "{path}");
    }
    assert_eq!(
        find_collection_root(root, "tasks/b/inner/i.md"),
        Some("tasks/b/inner".into())
    );
    assert_eq!(
        role(root, "tasks/b/inner/i.md"),
        Some(PageRole::CollectionItem)
    );
    for path in DEEP {
        assert_eq!(find_collection_root(root, path), None, "{path}");
        assert!(
            resolve_collection_schema_result(root, path)
                .unwrap()
                .is_none()
        );
        assert!(
            engine::schema_response(space, path).unwrap().is_none(),
            "{path}"
        );
    }
    for path in &DEEP[..3] {
        assert_eq!(role(root, path), Some(PageRole::Standalone), "{path}");
    }
    assert_eq!(
        resolve_markdown_identity_for_path(root, "tasks/b/inner/README.md", false)
            .unwrap()
            .owner_kind,
        Some(ContentOwnerKind::Collection)
    );

    assert_eq!(traversed_members(space), DIRECT);
    assert_eq!(row_count(space), 2);
    let pool = index_pool(root).await;
    assert_eq!(indexed_members(&pool, "tasks").await, DIRECT);
    assert_eq!(
        indexed_members(&pool, "tasks/b/inner").await,
        ["tasks/b/inner/i.md"]
    );
    assert_eq!(queried_members(&pool, space, true).await, DIRECT);
    assert!(observed_by_collection_routines(root, "tasks/a.md"));
    assert!(!observed_by_collection_routines(root, "tasks/b/note.md"));

    assert_eq!(outside_target_issues(space), ["tasks/b/note.md"]);
    assert!(write_relation(space, "b/note.md").is_err());
    write_relation(space, "a.md").unwrap();
    assert_eq!(
        entry_commit_name(space, "tasks/b/note.md"),
        "collection entry"
    );
    db::close_pool(&pool).await;
}

#[tokio::test]
async fn nested_items_keeps_deep_pages_of_the_same_schema_as_items() {
    let temp = fixture(true);
    let root = temp.path();
    let space = space(&temp);

    for path in DIRECT.iter().chain(DEEP.iter()) {
        assert_eq!(
            find_collection_root(root, path),
            Some("tasks".into()),
            "{path}"
        );
        assert!(
            engine::schema_response(space, path).unwrap().is_some(),
            "{path}"
        );
    }
    for path in &DEEP[..3] {
        assert_eq!(role(root, path), Some(PageRole::CollectionItem), "{path}");
    }
    assert_eq!(
        find_collection_root(root, "tasks/b/inner/i.md"),
        Some("tasks/b/inner".into())
    );

    let mut all = DIRECT
        .iter()
        .chain(DEEP.iter())
        .copied()
        .collect::<Vec<_>>();
    all.sort_unstable();
    assert_eq!(traversed_members(space), all);
    assert_eq!(row_count(space), 6);
    let pool = index_pool(root).await;
    assert_eq!(indexed_members(&pool, "tasks").await, all);
    assert_eq!(queried_members(&pool, space, true).await, all);
    assert_eq!(queried_members(&pool, space, false).await, DIRECT);
    assert!(observed_by_collection_routines(root, "tasks/b/note.md"));

    assert!(outside_target_issues(space).is_empty());
    write_relation(space, "b/sub/c.md").unwrap();
    db::close_pool(&pool).await;
}

#[tokio::test]
async fn membership_follows_the_flag_without_rewriting_any_source() {
    let temp = fixture(false);
    let root = temp.path();
    let schema_path = root.join("tasks/schema.yaml");
    let before = source_bytes(root);
    let pool = index_pool(root).await;
    assert_eq!(indexed_members(&pool, "tasks").await, DIRECT);

    fs::write(&schema_path, tasks_schema(true)).unwrap();
    full_reindex::<crate::git::cli::GitCli>(None, &pool, root, &[])
        .await
        .unwrap();
    assert_eq!(indexed_members(&pool, "tasks").await.len(), 6);

    fs::write(&schema_path, tasks_schema(false)).unwrap();
    full_reindex::<crate::git::cli::GitCli>(None, &pool, root, &[])
        .await
        .unwrap();
    assert_eq!(indexed_members(&pool, "tasks").await, DIRECT);
    assert_eq!(source_bytes(root), before);
    db::close_pool(&pool).await;

    // A targeted update projects the same membership as the full reindex.
    let state = IndexRuntimeState::default();
    for path in ["tasks/a.md", "tasks/b/note.md"] {
        update::publish_managed_path(
            &state,
            update_state(),
            None::<&SystemGitDateExecutor>,
            root,
            &root.join(path),
        )
        .await
        .unwrap();
    }
    let pool = state
        .get_or_create(&IndexKey::Root(root.to_path_buf()))
        .await
        .unwrap();
    assert_eq!(indexed_members(&pool, "tasks").await, DIRECT);
}

#[test]
fn schema_migrations_leave_deep_pages_untouched() {
    let temp = fixture(false);
    let root = temp.path();
    let space = space(&temp);
    let deep = |root: &Path| {
        DEEP.iter()
            .map(|path| fs::read(root.join(path)).unwrap())
            .collect::<Vec<_>>()
    };
    let before = deep(root);

    engine::rename_schema_column(space, "tasks", "Status", "State").unwrap();
    engine::rename_option(space, "tasks", "Priority", "High", "Urgent").unwrap();
    let item = fs::read_to_string(root.join("tasks/a.md")).unwrap();
    assert!(item.contains("State: Todo") && item.contains("Priority: Urgent"));
    assert_eq!(deep(root), before);
}

#[test]
fn the_unique_id_counter_never_drops_when_items_leave_the_collection() {
    let temp = fixture(false);
    let space = space(&temp);
    fs::write(
        temp.path().join("tasks/schema.yaml"),
        TASKS_COLUMNS.replace("next: 5", "next: 9"),
    )
    .unwrap();
    let schema = engine::normalize_unique_id_counter(space, "tasks").unwrap();
    let key = schema.columns.iter().find(|column| column.name == "Key");
    assert_eq!(key.and_then(|column| column.next), Some(9));
}

#[test]
fn schema_writers_keep_nested_items_and_never_write_false() {
    let temp = fixture(true);
    let space = space(&temp);
    let schema_path = temp.path().join("tasks/schema.yaml");
    engine::rename_schema_column(space, "tasks", "Status", "State").unwrap();
    engine::normalize_unique_id_counter(space, "tasks").unwrap();
    let written = fs::read_to_string(&schema_path).unwrap();
    assert!(written.contains("nested_items: true"), "{written}");
    assert!(
        engine::read_collection_schema(space, "tasks")
            .unwrap()
            .nested_items
    );

    fs::write(
        &schema_path,
        format!("nested_items: false\n{TASKS_COLUMNS}"),
    )
    .unwrap();
    assert!(
        !engine::read_collection_schema(space, "tasks")
            .unwrap()
            .nested_items
    );
    engine::rename_schema_column(space, "tasks", "Status", "State").unwrap();
    assert!(
        !fs::read_to_string(schema_path)
            .unwrap()
            .contains("nested_items")
    );
}

fn create_request(root: &Path, parent: &str) -> PageCreate {
    PageCreate {
        space: root.to_string_lossy().to_string(),
        parent_path: Some(parent.into()),
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
    }
}

async fn create_child(root: &Path, parent: &str) -> entry::Entry {
    create(
        create_request(root, parent),
        &IndexRuntimeState::default(),
        update_state(),
        None::<&SystemGitDateExecutor>,
        |paths| async move { Ok::<_, PageError>(paths) },
    )
    .await
    .unwrap()
    .page
}

#[tokio::test]
async fn only_new_items_receive_schema_defaults_and_unique_ids() {
    let temp = fixture(false);
    let root = temp.path();
    let space = space(&temp);
    let schema_path = root.join("tasks/schema.yaml");
    let schema_before = fs::read(&schema_path).unwrap();

    let deep = create_child(root, "tasks/b").await;
    assert_eq!(deep.path, "tasks/b/Child.md");
    assert!(deep.meta.extra.is_empty(), "{:?}", deep.meta.extra);
    assert_eq!(fs::read(&schema_path).unwrap(), schema_before);

    let under_leaf = create_child(root, "tasks/a.md").await;
    assert_eq!(under_leaf.path, "tasks/a/Child.md");
    assert!(under_leaf.meta.extra.is_empty());
    let parent = fs::read_to_string(root.join("tasks/a/README.md")).unwrap();
    assert!(parent.contains("Status: Todo") && parent.contains("Key: 1"));

    let item = create_child(root, "tasks").await;
    assert_eq!(
        item.meta.extra.get("Status"),
        Some(&Value::String("Todo".into()))
    );
    assert_eq!(item.meta.extra.get("Key"), Some(&Value::Number(5.into())));

    let template =
        templates::create(space, "tasks", "Plan", templates::TemplateKind::Leaf).unwrap();
    let template = fs::read_to_string(root.join(template)).unwrap();
    assert!(template.contains("Status: Todo"), "{template}");

    let state = IndexRuntimeState::default();
    let runtime = || StructureRuntime {
        index: &state,
        updates: update_state(),
        git_dates: None::<&SystemGitDateExecutor>,
        commits: None,
    };
    let moved = move_entry(space, "Loose.md", "tasks/b", Some(space), runtime())
        .await
        .unwrap();
    assert_eq!(moved, "tasks/b/Loose.md");
    assert_eq!(
        fs::read_to_string(root.join(&moved)).unwrap(),
        "---\ntitle: Loose\n---\n"
    );
    let moved = move_entry(space, &moved, "tasks", Some(space), runtime())
        .await
        .unwrap();
    let moved = fs::read_to_string(root.join(moved)).unwrap();
    assert!(
        moved.contains("Status: Todo") && moved.contains("Key: 6"),
        "{moved}"
    );
}
