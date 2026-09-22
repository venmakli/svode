//! Page, owner and item writes of the `svode` frame on a harness host with
//! the mutation runtime of an open Project, as the headless runtime will
//! provide it. It proves the command mapping and the shared write outcomes
//! before that runtime is connected to the binary; the standalone process
//! answers these commands with `MODE_UNAVAILABLE`.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::git::cli::GitCli;
use svode_core::index::IndexKey;
use svode_core::index::reindex::full_reindex;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineLiveEvidence};
use svode_core::routines::store_state::RoutineStoreState;
use svode_tools::catalog;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};

/// Whether the host grants repository access to mutations.
#[derive(Clone, Copy, PartialEq)]
enum Access {
    Grant,
    Deny,
}

struct WriteHost {
    access: Access,
    asked: Mutex<Vec<String>>,
    authorized: Mutex<Vec<PathBuf>>,
    routines: Arc<RoutineStoreState>,
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
}

impl WriteHost {
    fn new(access: Access) -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            access,
            asked: Mutex::new(Vec::new()),
            authorized: Mutex::new(Vec::new()),
            updates: IndexUpdateState::new(routines.clone()),
            routines,
            index: IndexRuntimeState::default(),
            nonces: WriteNonceRegistry::new(),
        }
    }

    fn take_asked(&self) -> BTreeSet<String> {
        std::mem::take(&mut *self.asked.lock().unwrap())
            .into_iter()
            .collect()
    }
}

impl ToolHost for WriteHost {
    fn version(&self) -> &str {
        "harness"
    }

    fn serves_tool(&self, name: &str) -> bool {
        self.asked.lock().unwrap().push(name.to_string());
        true
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

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), ToolError> {
        self.authorized
            .lock()
            .unwrap()
            .push(repository.to_path_buf());
        match self.access {
            Access::Grant => Ok(()),
            Access::Deny => Err(ToolError::new(
                "REPOSITORY_ACCESS_DENIED",
                "Repository access denied: status=read_only",
            )),
        }
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: &self.index,
            updates: &self.updates,
            nonces: &self.nonces,
        }
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        unreachable!("writes only")
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {
        unreachable!("no managed import")
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: &self.routines,
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

impl Fixture {
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.project.join(path)).unwrap()
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// Committed root Space with a linked Page, a schema-backed Collection and
/// its README, reindexed like an open Project.
async fn fixture(host_index: Option<&IndexRuntimeState>) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap().join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({ "name": "Project" }).to_string(),
    );
    write(
        &project.join("README.md"),
        "---\ntitle: Project\ndescription: Root\n---\nOwner\n",
    );
    write(
        &project.join("leaf.md"),
        "---\ntitle: Leaf\nicon: 🍃\ndescription: Kept\n---\nLeaf body\n",
    );
    write(
        &project.join("links.md"),
        "---\ntitle: Links\n---\n[Leaf](leaf.md)\n",
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\n    default: Todo\n  - name: Points\n    type: number\nviews:\n  - type: table\n    name: Table\n",
    );
    write(
        &project.join("tasks/README.md"),
        "---\ntitle: Tasks\n---\nTasks owner\n",
    );
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\nPoints: 3\n---\nAlpha body\n",
    );
    write(&project.join("input/body.md"), "Rewritten body\n");
    write(&project.join("input/empty.md"), "");
    write(
        &project.join("input/fields.json"),
        r#"{ "Status": "Done", "Points": 5 }"#,
    );
    write(
        &project.join("input/bad-fields.json"),
        r#"{ "Points": "many" }"#,
    );
    write(&project.join("input/properties.json"), r#"{ "Points": 8 }"#);
    write(
        &project.join("input/cover.json"),
        r#"{ "type": "color", "value": "blue" }"#,
    );
    write(&project.join(".gitignore"), "input/\n");
    if has_git() {
        git(&project, &["init", "-q"]);
        git(&project, &["config", "user.email", "agent@example.com"]);
        git(&project, &["config", "user.name", "Agent"]);
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "fixture"]);
    }
    if let Some(index) = host_index {
        let root = index
            .get_or_create(&IndexKey::Root(project.clone()))
            .await
            .unwrap();
        full_reindex::<GitCli>(None, &root, &project, &[])
            .await
            .unwrap();
    }
    Fixture {
        _temp: temp,
        project,
    }
}

/// Runs one JSON command through the public frame; returns the exit code
/// and the single stdout object.
async fn svode(host: &WriteHost, cwd: &Path, args: &[&str]) -> (i32, Value) {
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

async fn human(host: &WriteHost, cwd: &Path, args: &[&str]) -> svode_cli::Rendered {
    let mut raw = vec![OsString::from("svode")];
    raw.extend(args.iter().map(OsString::from));
    let cli = svode_cli::parse(&raw).unwrap();
    svode_cli::run(host, cli, cwd).await
}

fn ok(exit: i32, value: &Value) {
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["ok"], true, "{value}");
}

/// Write commands of slice 4.3 with the capability each one publishes.
const WRITE_COMMANDS: [(&[&str], &str); 10] = [
    (
        &["page", "create", "--parent", "", "--title", "Fresh"],
        "create_page",
    ),
    (
        &[
            "page",
            "write",
            "--path",
            "links.md",
            "--body",
            "[Leaf](leaf.md)\n",
        ],
        "write_page",
    ),
    (
        &["page", "meta", "set", "--path", "links.md", "--icon", "🔗"],
        "update_page_metadata",
    ),
    (
        &["space", "readme", "write", "--body", "Owner\n"],
        "write_space_readme",
    ),
    (
        &["space", "meta", "set", "--icon", "🏠"],
        "update_space_metadata",
    ),
    (
        &[
            "collection",
            "readme",
            "write",
            "--collection",
            "tasks",
            "--body",
            "Owner\n",
        ],
        "write_collection_readme",
    ),
    (
        &[
            "collection",
            "meta",
            "set",
            "--collection",
            "tasks",
            "--icon",
            "✅",
        ],
        "update_collection_metadata",
    ),
    (
        &[
            "item",
            "write",
            "--path",
            "tasks/alpha.md",
            "--body",
            "Alpha\n",
        ],
        "update_collection_item_body",
    ),
    (
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            "input/fields.json",
        ],
        "update_collection_item_fields",
    ),
    (
        &[
            "item",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--icon",
            "⭐",
        ],
        "update_collection_item_metadata",
    ),
];

#[tokio::test]
async fn every_owner_write_capability_has_exactly_one_command() {
    let fixture = fixture(None).await;
    let host = WriteHost::new(Access::Grant);

    let mut published = BTreeSet::new();
    for (args, tool) in WRITE_COMMANDS {
        let (exit, value) = svode(&host, &fixture.project, args).await;
        ok(exit, &value);
        assert!(value["changedPaths"].is_array(), "{args:?}: {value}");
        assert_eq!(value["target"]["spaceId"], "root");
        assert_eq!(
            host.take_asked(),
            BTreeSet::from([tool.to_string()]),
            "{args:?}"
        );
        assert!(published.insert(tool), "{tool} has two commands");
    }
    assert!(
        host.authorized
            .lock()
            .unwrap()
            .iter()
            .all(|repository| repository == &fixture.project)
    );

    // Every mutating baseline capability of this family is published; the
    // structural, import and Routine families belong to 4.4-4.6.
    let family = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .filter(|name| {
            catalog::is_mutating_tool(name) == Some(true)
                && [
                    "write_page",
                    "create_page",
                    "update_page_metadata",
                    "write_space_readme",
                    "update_space_metadata",
                    "write_collection_readme",
                    "update_collection_metadata",
                    "update_collection_item_body",
                    "update_collection_item_fields",
                    "update_collection_item_metadata",
                ]
                .contains(name)
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(published, family);
}

#[tokio::test]
async fn page_writes_keep_body_only_combined_and_metadata_semantics() {
    if !has_git() {
        return;
    }
    let host_index = IndexRuntimeState::default();
    let fixture = fixture(Some(&host_index)).await;
    let mut host = WriteHost::new(Access::Grant);
    host.index = host_index;
    let project = &fixture.project;
    let head = git(project, &["rev-parse", "HEAD"]);

    // Body-only write from a file keeps metadata and path.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "write",
            "--path",
            "leaf.md",
            "--body-file",
            "input/body.md",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["path"], "leaf.md");
    assert_eq!(value["newPath"], Value::Null);
    assert_eq!(value["changedPaths"], json!(["leaf.md"]));
    assert_eq!(value["target"]["path"], "leaf.md");
    let source = fixture.read("leaf.md");
    assert!(source.contains("icon: 🍃") && source.ends_with("Rewritten body\n"));

    // An empty body is a valid value.
    let (exit, _) = svode(
        &host,
        project,
        &[
            "page",
            "write",
            "--path",
            "leaf.md",
            "--body-file",
            "input/empty.md",
        ],
    )
    .await;
    assert_eq!(exit, 0);
    assert!(fixture.read("leaf.md").ends_with("---\n"));

    // Combined body + title renames by Desktop naming and rewrites links.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "write",
            "--path",
            "leaf.md",
            "--body",
            "Moved body\n",
            "--title",
            "Moved",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["path"], "Moved.md");
    assert_eq!(value["newPath"], "Moved.md");
    assert!(!project.join("leaf.md").exists());
    assert!(fixture.read("Moved.md").ends_with("Moved body\n"));
    assert!(fixture.read("links.md").contains("(Moved.md)"));
    let changed = value["changedPaths"].as_array().unwrap();
    assert!(changed.contains(&json!("links.md")), "{value}");

    // Metadata: a value writes, --clear-* clears, a missing flag keeps.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "Moved.md",
            "--clear-icon",
            "--cover-file",
            "input/cover.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(value["page"]["meta"]["icon"].is_null(), "{value}");
    assert_eq!(value["page"]["meta"]["description"], "Kept");
    assert_eq!(value["page"]["meta"]["cover"]["value"], "blue");
    let source = fixture.read("Moved.md");
    assert!(!source.contains("icon:") && source.contains("description: Kept"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "Moved.md",
            "--description",
            "New",
            "--clear-cover",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["page"]["meta"]["description"], "New");
    assert!(!fixture.read("Moved.md").contains("cover"));

    // Owner writes keep the owner distinction.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "space",
            "readme",
            "write",
            "--body",
            "New owner\n",
            "--title",
            "Renamed Project",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["path"], "README.md");
    assert!(fixture.read("README.md").contains("title: Renamed Project"));
    let (exit, _) = svode(
        &host,
        project,
        &["space", "meta", "set", "--clear-description"],
    )
    .await;
    assert_eq!(exit, 0);
    assert!(!fixture.read("README.md").contains("description:"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "readme",
            "write",
            "--collection",
            "tasks",
            "--body-file",
            "input/body.md",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["collectionPath"], "tasks");
    assert_eq!(value["target"]["collection"], "tasks");
    assert!(
        fixture
            .read("tasks/README.md")
            .ends_with("Rewritten body\n")
    );
    let (exit, value) = svode(
        &host,
        project,
        &[
            "collection",
            "meta",
            "set",
            "--collection",
            "tasks",
            "--description",
            "Work",
        ],
    )
    .await;
    ok(exit, &value);
    assert!(
        fixture
            .read("tasks/README.md")
            .contains("description: Work")
    );

    // Owner README content is not a standalone Page.
    let (exit, value) = svode(
        &host,
        project,
        &["page", "write", "--path", "tasks/README.md", "--body", "x"],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert!(value["error"]["target"]["path"] == "tasks/README.md");

    // No implicit commit.
    assert_eq!(git(project, &["rev-parse", "HEAD"]), head);
    assert!(!git(project, &["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn item_writes_keep_fields_validation_defaults_and_metadata() {
    if !has_git() {
        return;
    }
    let host_index = IndexRuntimeState::default();
    let fixture = fixture(Some(&host_index)).await;
    let mut host = WriteHost::new(Access::Grant);
    host.index = host_index;
    let project = &fixture.project;

    // Create in a Collection applies defaults and validates properties.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "create",
            "--parent",
            "tasks",
            "--title",
            "Beta",
            "--properties-file",
            "input/properties.json",
            "--body",
            "Beta body\n",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["path"], "tasks/Beta.md");
    assert_eq!(value["target"]["parent"], "tasks");
    let source = fixture.read("tasks/Beta.md");
    assert!(
        source.contains("Status: Todo") && source.contains("Points: 8"),
        "{source}"
    );
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "create",
            "--parent",
            "tasks",
            "--title",
            "Gamma",
            "--properties-file",
            "input/bad-fields.json",
        ],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert!(!project.join("tasks/Gamma.md").exists());

    // Fields are set atomically with schema validation.
    let (exit, value) = svode(
        &host,
        project,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            "input/fields.json",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["item"]["path"], "tasks/alpha.md", "{value}");
    assert!(fixture.read("tasks/alpha.md").contains("Status: Done"));
    let before = fixture.read("tasks/alpha.md");
    let (exit, value) = svode(
        &host,
        project,
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            "input/bad-fields.json",
        ],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert_eq!(fixture.read("tasks/alpha.md"), before);

    // Body write keeps fields; metadata keeps body and fields.
    let (exit, _) = svode(
        &host,
        project,
        &[
            "item",
            "write",
            "--path",
            "tasks/alpha.md",
            "--body-file",
            "input/body.md",
        ],
    )
    .await;
    assert_eq!(exit, 0);
    let source = fixture.read("tasks/alpha.md");
    assert!(source.contains("Status: Done") && source.ends_with("Rewritten body\n"));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "item",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--icon",
            "⭐",
            "--description",
            "Item",
        ],
    )
    .await;
    ok(exit, &value);
    let source = fixture.read("tasks/alpha.md");
    assert!(source.contains("icon: ⭐") && source.contains("Status: Done"));
    assert!(source.ends_with("Rewritten body\n"));

    // Items and Pages keep their owner distinction.
    let (exit, value) = svode(
        &host,
        project,
        &["item", "write", "--path", "links.md", "--body", "x"],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(value["error"]["code"], "NOT_A_COLLECTION_ITEM");
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page",
            "meta",
            "set",
            "--path",
            "tasks/alpha.md",
            "--icon",
            "x",
        ],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert_eq!(value["error"]["code"], "NOT_A_STANDALONE_PAGE");
}

#[tokio::test]
async fn write_outcomes_keep_codes_and_evidence() {
    let fixture = fixture(None).await;
    let project = &fixture.project;
    write(
        &project.join("Taken.md"),
        "---\ntitle: Other\n---\nOccupied\n",
    );

    // Applied with warning: exit 0, the warning in JSON and on stderr.
    let host = WriteHost::new(Access::Grant);
    let (exit, value) = svode(
        &host,
        project,
        &[
            "page", "write", "--path", "leaf.md", "--body", "Body\n", "--title", "Taken",
        ],
    )
    .await;
    ok(exit, &value);
    assert_eq!(value["newPath"], Value::Null);
    assert_eq!(value["warnings"][0]["kind"], "filename_rename_collision");
    let rendered = human(
        &host,
        project,
        &[
            "page", "write", "--path", "leaf.md", "--body", "Again\n", "--title", "Taken",
        ],
    )
    .await;
    assert_eq!(rendered.exit, 0);
    assert!(
        rendered
            .stdout
            .starts_with("Updated Page leaf.md.\nleaf.md\n"),
        "{rendered:?}"
    );
    assert!(
        rendered
            .stderr
            .contains("warning[filename_rename_collision]"),
        "{rendered:?}"
    );

    // Rejected before the first write: code and target, nothing written.
    let denied = WriteHost::new(Access::Deny);
    let before = fixture.read("leaf.md");
    let (exit, value) = svode(
        &denied,
        project,
        &[
            "page", "write", "--path", "leaf.md", "--body", "Lost\n", "--title", "Lost",
        ],
    )
    .await;
    assert_eq!(exit, 1);
    assert_eq!(value["error"]["code"], "REPOSITORY_ACCESS_DENIED");
    assert_eq!(value["error"]["target"]["path"], "leaf.md");
    assert_eq!(fixture.read("leaf.md"), before);
    assert!(!project.join("Lost.md").exists());
    let (exit, value) = svode(
        &denied,
        project,
        &["page", "create", "--parent", "", "--title", "Denied"],
    )
    .await;
    assert_eq!(
        (exit, value["error"]["code"].as_str()),
        (1, Some("REPOSITORY_ACCESS_DENIED"))
    );
    assert!(!project.join("Denied.md").exists());

    // Name conflict of a new Page keeps the shared code.
    let (exit, value) = svode(
        &host,
        project,
        &["page", "create", "--parent", "", "--title", "Other"],
    )
    .await;
    assert_eq!(exit, 1, "{value}");
    assert_eq!(value["error"]["code"], "PAGE_NAME_CONFLICT");

    // A source failure after the first write rejects the whole combined
    // request and restores every affected source.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        write(
            &project.join("linker.md"),
            "---\ntitle: Linker\n---\n[Leaf](leaf.md)\n",
        );
        let links = project.join("linker.md");
        fs::set_permissions(&links, fs::Permissions::from_mode(0o444)).unwrap();
        let before = fixture.read("leaf.md");
        let (exit, value) = svode(
            &host,
            project,
            &[
                "page", "write", "--path", "leaf.md", "--body", "Lost\n", "--title", "Rolled",
            ],
        )
        .await;
        fs::set_permissions(&links, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(exit, 1, "{value}");
        assert_eq!(value["error"]["code"], "SVODE_ERROR");
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("ermission denied"),
            "{value}"
        );
        assert_eq!(fixture.read("leaf.md"), before);
        assert!(!project.join("Rolled.md").exists());
        assert!(fixture.read("linker.md").contains("(leaf.md)"));
    }
}
