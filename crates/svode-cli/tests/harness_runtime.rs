//! The `svode` frame on a harness host whose runtime holds a real reindexed
//! Project. It proves the command mapping of index-backed reads;
//! `index_process` runs them on the standalone host of the real binary.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::git::cli::GitCli;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::reindex::full_reindex;
use svode_core::index::resolver::SpaceStatus;
use svode_core::index::state::IndexRuntimeState;
use svode_core::routines::model::ResolvedRoutineOwner;
use svode_tools::catalog;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};

/// Host with the read runtime of an open Project: index pools, Actor
/// catalog and Git runtime. It records every tool it is asked to serve.
struct HarnessHost {
    index: IndexRuntimeState,
    actors: ActorCatalogState,
    git: GitRuntime,
    asked: Mutex<Vec<String>>,
}

impl HarnessHost {
    fn new() -> Self {
        Self {
            index: IndexRuntimeState::default(),
            actors: ActorCatalogState::new(),
            git: GitRuntime::new(),
            asked: Mutex::new(Vec::new()),
        }
    }

    fn take_asked(&self) -> BTreeSet<String> {
        std::mem::take(&mut *self.asked.lock().unwrap())
            .into_iter()
            .collect()
    }
}

impl ToolHost for HarnessHost {
    fn version(&self) -> &str {
        "harness"
    }

    fn serves_tool(&self, name: &str) -> bool {
        self.asked.lock().unwrap().push(name.to_string());
        catalog::is_mutating_tool(name) == Some(false)
    }

    async fn index_pool(&self, key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        self.index.existing_pool(key).await
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Ok(RepositoryAccessSnapshot {
            repository_id: "harness".to_string(),
            generation: 1,
            status: RepositoryAccessStatus::Local,
            reason: None,
            checked_at: None,
            expires_at: None,
            last_known_status: None,
        })
    }

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        unreachable!("reads only")
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        unreachable!("reads only")
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: &self.index,
            actors: &self.actors,
            git: &self.git,
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {
        unreachable!("reads only")
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Err(ToolError::new("MODE_UNAVAILABLE", "no Routine runtime"))
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {
        unreachable!("reads only")
    }

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap().join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "spaces": [{ "id": "child", "path": "child", "repo": null }]
        })
        .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child" }).to_string(),
    );
    write(
        &project.join("README.md"),
        "---\ntitle: Project\n---\nOwner\n",
    );
    write(
        &project.join("notes.md"),
        "---\ntitle: Root Needle\n---\nNeedle root body [Alpha](tasks/alpha.md)\n",
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\n  - name: Points\n    type: number\nviews:\n  - type: table\n    name: Table\n",
    );
    write(
        &project.join("tasks/README.md"),
        "---\ntitle: Tasks\n---\nTasks owner\n",
    );
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\nPoints: 3\n---\nAlpha body\n",
    );
    write(
        &project.join("tasks/beta.md"),
        "---\ntitle: Beta\nStatus: Done\nPoints: 1\n---\nBeta body\n",
    );
    write(&project.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &project.join("child/brief.md"),
        "---\ntitle: Child Needle\n---\nNeedle child body\n",
    );
    write(&project.join("child/deep/.keep"), "");
    write(
        &project.join("filter.json"),
        r#"[{ "field": "Status", "op": "eq", "value": "Done" }]"#,
    );
    write(
        &project.join("sort.json"),
        r#"[{ "field": "Points", "desc": false }]"#,
    );
    if has_git() {
        git(&project, &["init", "-q"]);
        git(&project, &["config", "user.email", "agent@example.com"]);
        git(&project, &["config", "user.name", "Agent"]);
        git(&project, &["config", "maintenance.auto", "false"]);
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "fixture"]);
    }
    Fixture {
        _temp: temp,
        project,
    }
}

/// Reindexes the root and child Space into the host index state, as an open
/// Project runtime keeps them.
async fn index(fixture: &Fixture, host: &HarnessHost) {
    let project = &fixture.project;
    host.index
        .upsert_space(
            project,
            "child",
            "child",
            SpaceStatus::Ready,
            Some("Child".to_string()),
        )
        .await;
    let root = host
        .index
        .get_or_create(&IndexKey::Root(project.clone()))
        .await
        .unwrap();
    full_reindex::<GitCli>(None, &root, project, &["child".to_string()])
        .await
        .unwrap();
    let child = host
        .index
        .get_or_create(&IndexKey::Space {
            project: project.clone(),
            space_id: "child".to_string(),
        })
        .await
        .unwrap();
    full_reindex::<GitCli>(None, &child, &project.join("child"), &[])
        .await
        .unwrap();
}

/// Runs one JSON command through the public frame; returns the exit code
/// and the single stdout object.
async fn svode(host: &HarnessHost, cwd: &Path, args: &[&str]) -> (i32, Value) {
    let mut raw = vec![OsString::from("svode"), OsString::from("--json")];
    raw.extend(args.iter().map(OsString::from));
    let cli = svode_cli::parse(&raw).unwrap_or_else(|rendered| panic!("{args:?}: {rendered:?}"));
    let rendered = svode_cli::run(host, cli, cwd).await;
    assert_eq!(rendered.stdout.lines().count(), 1, "{args:?}: {rendered:?}");
    (
        rendered.exit,
        serde_json::from_str(&rendered.stdout).unwrap(),
    )
}

fn paths(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_string())
        .collect()
}

/// Read commands of slice 4.2 with the capability each one publishes.
const READ_COMMANDS: [(&[&str], &str); 19] = [
    (&["project", "info"], "get_project_info"),
    (&["space", "list"], "list_spaces"),
    (&["space", "readme", "read"], "read_space_readme"),
    (&["page", "list"], "list_pages"),
    (&["collection", "list"], "list_collections"),
    (
        &["collection", "schema", "--collection", "tasks"],
        "get_collection_schema",
    ),
    (
        &["collection", "query", "--collection", "tasks"],
        "query_collection_items",
    ),
    (
        &["collection", "readme", "read", "--collection", "tasks"],
        "read_collection_readme",
    ),
    (
        &["item", "read", "--path", "tasks/alpha.md"],
        "read_collection_item",
    ),
    (&["actor", "list"], "list_actors"),
    (&["search", "Needle"], "search_pages"),
    (&["knowledge", "search", "Needle"], "search_knowledge"),
    (
        &["knowledge", "node", "--id", "page:root:notes.md"],
        "get_knowledge_node",
    ),
    (
        &["knowledge", "neighbors", "--id", "page:root:notes.md"],
        "get_knowledge_neighbors",
    ),
    (&["knowledge", "context", "Needle"], "get_related_context"),
    (&["knowledge", "status"], "get_knowledge_status"),
    (&["git", "status"], "get_git_status"),
    (&["guide"], "get_svode_guide"),
    (&["page", "read", "--path", "notes.md"], "read_page"),
];

#[tokio::test]
async fn every_read_capability_has_exactly_one_command() {
    if !has_git() {
        return;
    }
    let fixture = fixture();
    let host = HarnessHost::new();
    index(&fixture, &host).await;

    let mut published = BTreeSet::new();
    for (args, tool) in READ_COMMANDS {
        let (code, value) = svode(&host, &fixture.project, args).await;
        assert_eq!(code, 0, "{args:?}: {value}");
        assert_eq!(value["ok"], true, "{args:?}");
        let asked = host.take_asked();
        assert_eq!(asked, BTreeSet::from([tool.to_string()]), "{args:?}");
        if tool == "read_page" {
            assert!(value["sourceVersion"].is_string());
        }
        assert!(published.insert(tool), "{tool} has two commands");
    }

    // Every read-only baseline capability except those of later families
    // (Collection integrity 4.4, App manifest 4.5, Routine definitions 4.6),
    // which their own family tests cover, is published.
    let later = [
        "validate_collection_integrity",
        "validate_app_manifest",
        "list_routines",
        "get_routine",
    ];
    let expected = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .filter(|name| catalog::is_mutating_tool(name) == Some(false) && !later.contains(name))
        .collect::<BTreeSet<_>>();
    assert_eq!(published, expected);
}

#[tokio::test]
async fn index_backed_reads_use_the_host_runtime_inside_the_frozen_target() {
    if !has_git() {
        return;
    }
    let fixture = fixture();
    let project = &fixture.project;
    let host = HarnessHost::new();
    index(&fixture, &host).await;

    let (_, sorted) = svode(
        &host,
        project,
        &[
            "collection",
            "query",
            "--collection",
            "tasks",
            "--sort-file",
            "sort.json",
            "--limit",
            "500",
            "--offset",
            "-3",
        ],
    )
    .await;
    assert_eq!(paths(&sorted["items"]), ["tasks/beta.md", "tasks/alpha.md"]);
    assert_eq!(sorted["limit"], 200);
    assert_eq!(sorted["offset"], 0);
    assert_eq!(sorted["target"]["collection"], "tasks");
    let (_, filtered) = svode(
        &host,
        project,
        &[
            "collection",
            "query",
            "--collection",
            "tasks",
            "--filter-file",
            "filter.json",
        ],
    )
    .await;
    assert_eq!(paths(&filtered["items"]), ["tasks/beta.md"]);

    let (_, page) = svode(
        &host,
        project,
        &["search", "Needle", "--limit", "1", "--offset", "0"],
    )
    .await;
    assert_eq!(paths(&page["items"]), ["notes.md"]);
    assert_eq!(page["limit"], 1);
    assert_eq!(page["total"], 1);

    // The current directory inside the child Space freezes it as default.
    let deep = project.join("child/deep");
    let (_, child) = svode(&host, &deep, &["search", "Needle"]).await;
    assert_eq!(child["target"]["spaceId"], "child");
    assert_eq!(paths(&child["items"]), ["brief.md"]);
    let (_, knowledge) = svode(&host, &deep, &["knowledge", "search", "Needle"]).await;
    assert_eq!(
        knowledge["scope"],
        json!({ "kind": "space", "spaceId": "child" })
    );
    let (_, explicit) = svode(&host, &deep, &["--space", "root", "search", "Needle"]).await;
    assert_eq!(paths(&explicit["items"]), ["notes.md"]);

    let (_, status) = svode(
        &host,
        project,
        &["knowledge", "status", "--scope", "project"],
    )
    .await;
    assert_eq!(status["scope"], json!({ "kind": "project" }));
    assert_eq!(status["counts"]["readablePools"], 2);
    let (_, node) = svode(
        &host,
        project,
        &["knowledge", "node", "--id", "page:root:notes.md"],
    )
    .await;
    assert_eq!(node["node"]["source"]["path"], "notes.md");
    assert_eq!(node["target"]["id"], "page:root:notes.md");
    let (_, context) = svode(
        &host,
        project,
        &[
            "knowledge",
            "context",
            "Needle",
            "--text-budget",
            "100",
            "--kind",
            "page",
        ],
    )
    .await;
    assert_eq!(context["textBudget"], 100);
    let (_, neighbors) = svode(
        &host,
        project,
        &[
            "knowledge",
            "neighbors",
            "--id",
            "page:root:notes.md",
            "--edge-kind",
            "links_to",
            "--limit",
            "1",
        ],
    )
    .await;
    assert_eq!(neighbors["limit"], 1);

    let (_, git_status) = svode(&host, project, &["git", "status"]).await;
    assert!(git_status["status"]["repository"].is_string());
    let (_, actors) = svode(&host, project, &["actor", "list"]).await;
    assert_eq!(actors["actors"][0]["email"], "agent@example.com");

    // Shared business codes and evidence pass through unchanged.
    for (args, code) in [
        (
            vec![
                "--space",
                "child",
                "knowledge",
                "search",
                "x",
                "--scope",
                "project",
            ],
            "INVALID_KNOWLEDGE_SCOPE",
        ),
        (
            vec!["knowledge", "node", "--id", "page:child:brief.md"],
            "KNOWLEDGE_NODE_NOT_FOUND",
        ),
        (
            vec!["knowledge", "search", "x", "--limit", "51"],
            "INVALID_KNOWLEDGE_LIMIT",
        ),
        (
            vec!["collection", "query", "--collection", "../outside"],
            "INVALID_PATH",
        ),
    ] {
        let (exit, value) = svode(&host, project, &args).await;
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(value["error"]["code"], code, "{args:?}: {value}");
        assert!(value["error"]["target"]["projectPath"].is_string());
    }
}

#[tokio::test]
async fn index_backed_reads_without_a_ready_index_say_so() {
    let fixture = fixture();
    let host = HarnessHost::new();

    let (exit, query) = svode(
        &host,
        &fixture.project,
        &["collection", "query", "--collection", "tasks"],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(query["error"]["code"], "INDEX_UNAVAILABLE");
    // An unready index is a failure with diagnostics, never an empty result.
    let (exit, status) = svode(&host, &fixture.project, &["knowledge", "status"]).await;
    assert_eq!(exit, 1);
    assert_eq!(status["error"]["code"], "INDEX_UNAVAILABLE", "{status}");
    assert!(
        !status["error"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{status}"
    );
}
