//! Collection schema/views/integrity and structural commands of the `svode`
//! frame on a harness host with the mutation runtime of an open Project. It
//! proves the command mapping and the shared structural effects;
//! `structural_families_process` runs the commands on the standalone host
//! of the real binary.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use common::harness::{Access, WriteHost, git, has_git, human, ok, svode, write};
use serde_json::{Value, json};
use svode_core::git::cli::GitCli;
use svode_core::index::IndexKey;
use svode_core::index::reindex::full_reindex;
use svode_tools::catalog;

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

impl Fixture {
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.project.join(path)).unwrap()
    }

    fn exists(&self, path: &str) -> bool {
        self.project.join(path).exists()
    }
}

/// Committed root Space with a link source, directory-backed Pages, a
/// Collection whose items relate to a second Collection and two registered
/// child Spaces, reindexed like an open Project.
async fn fixture(host: &WriteHost) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap().join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "spaces": [
                { "id": "child", "path": "child", "repo": null },
                { "id": "other", "path": "other", "repo": null }
            ]
        })
        .to_string(),
    );
    for (path, source) in [
        ("README.md", "---\ntitle: Project\n---\n"),
        ("leaf.md", "---\ntitle: Leaf\n---\nLeaf body\n"),
        ("notes.md", "---\ntitle: Notes\n---\n[Leaf](leaf.md)\n"),
        ("archive/README.md", "---\ntitle: Archive\n---\n"),
        ("archive/a.md", "---\ntitle: A\n---\n"),
        ("archive/b.md", "---\ntitle: B\n---\n"),
        ("solo/README.md", "---\ntitle: Solo\n---\nSolo body\n"),
        (
            "tasks/schema.yaml",
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\n  - name: Points\n    type: number\n  - name: Estimate\n    type: number\nviews:\n  - type: table\n    name: Table\n",
        ),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
        (
            "tasks/alpha.md",
            "---\ntitle: Alpha\nSprint: one.md\nPoints: 3\nEstimate: 2\n---\nAlpha body\n",
        ),
        ("sprints/schema.yaml", "columns: []\nviews: []\n"),
        ("sprints/README.md", "---\ntitle: Sprints\n---\n"),
        ("sprints/one.md", "---\ntitle: One\n---\n"),
        ("sprints/two.md", "---\ntitle: Two\n---\n"),
        ("child/.svode/config.json", r#"{"name":"Child"}"#),
        ("child/README.md", "---\ntitle: Child\n---\n"),
        ("other/.svode/config.json", r#"{"name":"Other"}"#),
        ("other/README.md", "---\ntitle: Other\n---\n"),
        (
            "input/columns.json",
            r#"[{ "name": "Owner", "type": "text" }]"#,
        ),
        (
            "input/views.json",
            r#"[{ "type": "table", "name": "All" }]"#,
        ),
        (
            "input/column.json",
            r#"{ "name": "Stage", "type": "text" }"#,
        ),
        ("input/column-patch.json", r#"{ "min": 0 }"#),
        ("input/view.json", r#"{ "type": "table", "name": "Board" }"#),
        ("input/view-patch.json", r#"{ "name": "Kanban" }"#),
        (
            "input/bad-view.json",
            r#"{ "type": "board", "name": "Bad", "group_by": "Points" }"#,
        ),
        ("input/body.md", "Backlog owner\n"),
        (".gitignore", "input/\n"),
    ] {
        write(&project.join(path), source);
    }
    if has_git() {
        git(&project, &["init", "-q"]);
        git(&project, &["config", "user.email", "agent@example.com"]);
        git(&project, &["config", "user.name", "Agent"]);
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "fixture"]);
    }
    let root = host
        .index
        .get_or_create(&IndexKey::Root(project.clone()))
        .await
        .unwrap();
    full_reindex::<GitCli>(None, &root, &project, &[])
        .await
        .unwrap();
    Fixture {
        _temp: temp,
        project,
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("not an array: {value}"))
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect()
}

/// Every file of the project outside `.git` and the index, with its bytes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            if name == ".git" || name.starts_with("index.db") {
                continue;
            }
            let key = path.strip_prefix(root).unwrap().to_path_buf();
            if path.is_dir() {
                files.insert(key, Vec::new());
                walk(&path, root, files);
            } else {
                files.insert(key, fs::read(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

/// Structural commands of slice 4.4 in an order valid on one fixture, with
/// the capability each one publishes.
const STRUCTURAL_COMMANDS: [(&[&str], &str); 17] = [
    (
        &["collection", "check", "--collection", "tasks"],
        "validate_collection_integrity",
    ),
    (
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Backlog",
            "--columns-file",
            "input/columns.json",
        ],
        "create_collection",
    ),
    (
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            "input/column.json",
        ],
        "add_collection_column",
    ),
    (
        &[
            "collection",
            "column",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Points",
            "--patch-file",
            "input/column-patch.json",
        ],
        "update_collection_column",
    ),
    (
        &[
            "collection",
            "column",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Estimate",
        ],
        "delete_collection_column",
    ),
    (
        &[
            "collection",
            "view",
            "add",
            "--collection",
            "tasks",
            "--view-file",
            "input/view.json",
        ],
        "add_collection_view",
    ),
    (
        &[
            "collection",
            "view",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Board",
            "--patch-file",
            "input/view-patch.json",
        ],
        "update_collection_view",
    ),
    (
        &[
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Kanban",
        ],
        "delete_collection_view",
    ),
    (
        &[
            "content",
            "rename",
            "--path",
            "leaf.md",
            "--to",
            "Renamed.md",
        ],
        "rename_content",
    ),
    (
        &[
            "content",
            "move",
            "--path",
            "Renamed.md",
            "--to-parent",
            "archive",
        ],
        "move_content",
    ),
    (
        &[
            "content",
            "reorder",
            "--parent",
            "archive",
            "--child",
            "archive/b.md",
            "--child",
            "archive/Renamed.md",
            "--child",
            "archive/a.md",
        ],
        "reorder_content",
    ),
    (
        &[
            "content",
            "convert",
            "--path",
            "solo/README.md",
            "--to",
            "leaf",
        ],
        "convert_page_to_leaf",
    ),
    (
        &[
            "content",
            "convert",
            "--path",
            "notes.md",
            "--to",
            "collection",
        ],
        "convert_to_collection",
    ),
    (
        &["item", "delete", "--path", "sprints/one.md"],
        "delete_collection_item",
    ),
    (&["page", "delete", "--path", "archive/a.md"], "delete_page"),
    (
        &["collection", "delete", "--collection", "sprints"],
        "delete_collection",
    ),
    (
        &["space", "reorder", "--id", "other", "--id", "child"],
        "reorder_spaces",
    ),
];

#[tokio::test]
async fn every_structural_capability_has_exactly_one_command() {
    let host = WriteHost::new(Access::Grant);
    let fixture = fixture(&host).await;

    let mut published = BTreeSet::new();
    for (args, tool) in STRUCTURAL_COMMANDS {
        let (exit, value) = svode(&host, &fixture.project, args).await;
        ok(exit, &value);
        assert_eq!(value["target"]["spaceId"], "root", "{args:?}");
        assert_eq!(
            host.take_asked(),
            BTreeSet::from([tool.to_string()]),
            "{args:?}"
        );
        if catalog::is_mutating_tool(tool) == Some(true) {
            assert!(value["changedPaths"].is_array(), "{args:?}: {value}");
        }
        published.insert(tool);
    }
    assert_eq!(published.len(), STRUCTURAL_COMMANDS.len());
    // Every mutation authorized only the repository of the root Space.
    assert!(
        host.authorized
            .lock()
            .unwrap()
            .iter()
            .all(|repository| repository == &fixture.project)
    );

    // The family is every baseline capability not published by the read
    // and owner-write families, except import, App and Routine (4.5-4.6).
    let family = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .filter(|name| {
            [
                "create_collection",
                "delete_collection",
                "validate_collection_integrity",
                "add_collection_column",
                "update_collection_column",
                "delete_collection_column",
                "add_collection_view",
                "update_collection_view",
                "delete_collection_view",
                "rename_content",
                "move_content",
                "reorder_content",
                "convert_page_to_leaf",
                "convert_to_collection",
                "delete_page",
                "delete_collection_item",
                "reorder_spaces",
            ]
            .contains(name)
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(published, family);
}

#[tokio::test]
async fn structural_commands_keep_link_relation_order_and_conversion_effects() {
    let host = WriteHost::new(Access::Grant);
    let fixture = fixture(&host).await;
    let project = &fixture.project;
    let head = has_git().then(|| git(project, &["rev-parse", "HEAD"]));

    // Rename rewrites the link source and reports the backlink.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "rename",
            "--path",
            "leaf.md",
            "--to",
            "Renamed.md",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["target"]["path"], "leaf.md");
    assert_eq!(value["newPath"], "Renamed.md");
    assert!(fixture.read("notes.md").contains("(Renamed.md)"));
    let changed = strings(&value["changedPaths"]);
    assert!(changed.contains(&"notes.md".to_string()), "{value}");
    assert!(changed.contains(&"Renamed.md".to_string()), "{value}");
    assert!(strings(&value["touchedPaths"]["backlinks"]).contains(&"notes.md".to_string()));

    // Move keeps the link; the human output is the summary, then paths.
    let rendered = human(
        &host,
        project,
        &[
            "content",
            "move",
            "--path",
            "Renamed.md",
            "--to-parent",
            "archive",
        ],
    )
    .await;
    assert_eq!(rendered.exit, 0, "{rendered:?}");
    assert!(fixture.exists("archive/Renamed.md"));
    assert!(fixture.read("notes.md").contains("archive/Renamed.md"));
    let mut lines = rendered.stdout.lines();
    assert!(!lines.next().unwrap().is_empty());
    let printed = lines.map(str::to_string).collect::<Vec<_>>();
    assert!(
        printed.contains(&"archive/Renamed.md".to_string()),
        "{rendered:?}"
    );
    assert!(printed.contains(&"notes.md".to_string()), "{rendered:?}");

    // Repeated --child flags keep their order; an incomplete order is
    // rejected without a write.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "reorder",
            "--parent",
            "archive",
            "--child",
            "archive/b.md",
            "--child",
            "archive/Renamed.md",
            "--child",
            "archive/a.md",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["target"]["parent"], "archive");
    assert_eq!(strings(&value["changedPaths"]), vec![".svode/order.json"]);
    assert_eq!(
        value["orderedChildren"],
        json!(["archive/b.md", "archive/Renamed.md", "archive/a.md"])
    );
    let order = fixture.read(".svode/order.json");
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "reorder",
            "--parent",
            "archive",
            "--child",
            "archive/a.md",
        ],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert_eq!(value["error"]["target"]["parent"], "archive");
    assert_eq!(fixture.read(".svode/order.json"), order);

    // Conversions in place, both directions of `--to`.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "convert",
            "--path",
            "solo/README.md",
            "--to",
            "leaf",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["newPath"], "solo.md");
    assert!(fixture.read("solo.md").contains("Solo body"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "convert",
            "--path",
            "notes.md",
            "--to",
            "collection",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["collectionPath"], "notes");
    assert!(fixture.exists("notes/schema.yaml"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "content",
            "convert",
            "--path",
            "notes/README.md",
            "--to",
            "collection",
        ],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(value["error"]["code"], "INVALID_COLLECTION_CONVERSION");

    // Deletes address one owner kind each; an item delete cleans relations.
    let (exit, value) = svode(
        &host,
        project,
        &["page", "delete", "--path", "tasks/alpha.md"],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(value["error"]["code"], "NOT_A_STANDALONE_PAGE");
    assert_eq!(value["error"]["target"]["path"], "tasks/alpha.md");
    assert!(fixture.exists("tasks/alpha.md"));
    let (exit, value) = svode(
        &host,
        project,
        &["item", "delete", "--path", "sprints/one.md"],
    )
    .await;
    ok(exit, &value);
    assert!(strings(&value["deletedPaths"]).contains(&"sprints/one.md".to_string()));
    assert!(strings(&value["cascadeTouched"]).contains(&"tasks/alpha.md".to_string()));
    assert!(!fixture.read("tasks/alpha.md").contains("one.md"));
    let (exit, value) = svode(
        &host,
        project,
        &["page", "delete", "--path", "archive/a.md"],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["deletedRoot"], "archive/a.md");
    let (exit, value) = svode(
        &host,
        project,
        &["collection", "delete", "--collection", "sprints"],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["target"]["collection"], "sprints");
    assert!(!fixture.exists("sprints/README.md"));

    // Child Spaces: repeated --id is the complete order; root is pinned.
    let (exit, value) = svode(
        &host,
        project,
        &["space", "reorder", "--id", "other", "--id", "child"],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["orderedSpaceIds"], json!(["other", "child"]));
    assert_eq!(strings(&value["changedPaths"]), vec![".svode/config.json"]);
    let (exit, value) = svode(
        &host,
        project,
        &[
            "space", "reorder", "--id", "root", "--id", "other", "--id", "child",
        ],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(value["error"]["code"], "INVALID_SPACE_ORDER");
    // A Project-level command ignores the selected Space.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "--space", "child", "space", "reorder", "--id", "other", "--id", "child",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(value["changedPaths"].as_array().unwrap().is_empty());

    if let Some(head) = head {
        assert_eq!(git(project, &["rev-parse", "HEAD"]), head, "no commit");
    }
}

#[tokio::test]
async fn collection_schema_and_view_commands_keep_the_shared_normalization() {
    let host = WriteHost::new(Access::Grant);
    let fixture = fixture(&host).await;
    let project = &fixture.project;

    // Create with body, columns and views from files.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Backlog",
            "--body-file",
            "input/body.md",
            "--icon",
            "📋",
            "--columns-file",
            "input/columns.json",
            "--views-file",
            "input/views.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["target"]["parent"], "");
    assert_eq!(value["collectionPath"], "Backlog");
    assert_eq!(value["schema"]["columns"][0]["name"], "Owner");
    assert_eq!(value["schema"]["views"][0]["name"], "All");
    assert!(strings(&value["changedPaths"]).contains(&"Backlog/schema.yaml".to_string()));
    assert!(fixture.read("Backlog/README.md").contains("Backlog owner"));
    // Invalid data creates nothing.
    write(
        &project.join("input/bad-columns.json"),
        r#"[{ "name": "Link", "type": "relation", "relation": "missing" }]"#,
    );
    let (exit, _) = svode(
        &host,
        project,
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Broken",
            "--columns-file",
            "input/bad-columns.json",
        ],
    )
    .await;
    assert_eq!(exit, 1);
    assert!(!fixture.exists("Broken") && !fixture.exists("Broken.md"));

    // Column update and delete; --delete-values removes stored values.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "column",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Points",
            "--patch-file",
            "input/column-patch.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["target"]["name"], "Points");
    assert!(fixture.read("tasks/schema.yaml").contains("min: 0"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "column",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Estimate",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(fixture.read("tasks/alpha.md").contains("Estimate"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "column",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Points",
            "--delete-values",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(strings(&value["changedPaths"]).contains(&"tasks/alpha.md".to_string()));
    assert!(!fixture.read("tasks/alpha.md").contains("Points"));

    // A two-way relation column writes the reverse schema too.
    write(
        &project.join("input/relation.json"),
        r#"{ "name": "Sprint2", "type": "relation", "relation": "sprints", "two_way": "Tasks" }"#,
    );
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "column",
            "add",
            "--collection",
            "tasks",
            "--column-file",
            "input/relation.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(strings(&value["changedPaths"]).contains(&"sprints/schema.yaml".to_string()));

    // Views: position, incompatible view rejected unchanged, rename, delete.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "view",
            "add",
            "--collection",
            "tasks",
            "--view-file",
            "input/view.json",
            "--position",
            "0",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["schema"]["views"][0]["name"], "Board");
    let before = fixture.read("tasks/schema.yaml");
    let (exit, _) = svode(
        &host,
        project,
        &[
            "collection",
            "view",
            "add",
            "--collection",
            "tasks",
            "--view-file",
            "input/bad-view.json",
        ],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(fixture.read("tasks/schema.yaml"), before);
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "view",
            "update",
            "--collection",
            "tasks",
            "--name",
            "Board",
            "--patch-file",
            "input/view-patch.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["schema"]["views"][0]["name"], "Kanban");
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "view",
            "delete",
            "--collection",
            "tasks",
            "--name",
            "Kanban",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["schema"]["views"].as_array().unwrap().len(), 1);

    // Integrity finds a relation broken by a raw edit, as a result.
    fs::remove_file(project.join("sprints/two.md")).unwrap();
    write(
        &project.join("tasks/beta.md"),
        "---\ntitle: Beta\nSprint: two.md\n---\n",
    );
    let (exit, value) = svode(&host, project, &["collection", "check"]).await;
    ok(exit, &value);
    assert!(value["errorCount"].as_u64().unwrap() >= 1, "{value}");
    assert!(value["target"].get("collection").is_none());
    let rendered = human(
        &host,
        project,
        &["collection", "check", "--collection", "tasks"],
    )
    .await;
    assert_eq!(rendered.exit, 0);
    assert!(rendered.stdout.contains("tasks/beta.md"), "{rendered:?}");
}

#[tokio::test]
async fn structural_commands_authorize_before_the_first_write() {
    let host = WriteHost::new(Access::Deny);
    let fixture = fixture(&host).await;
    let before = snapshot(&fixture.project);

    for (args, tool) in STRUCTURAL_COMMANDS {
        if catalog::is_mutating_tool(tool) != Some(true) {
            continue;
        }
        let (exit, value) = svode(&host, &fixture.project, args).await;
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(
            value["error"]["code"], "REPOSITORY_ACCESS_DENIED",
            "{args:?}"
        );
        assert_eq!(value["error"]["target"]["spaceId"], "root", "{args:?}");
    }
    assert_eq!(snapshot(&fixture.project), before);
    assert!(
        host.authorized
            .lock()
            .unwrap()
            .iter()
            .all(|repository| repository == &fixture.project)
    );
}
