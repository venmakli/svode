//! `create_space` on the standalone host of `svode` and `svode-mcp
//! --project` (Stage 11 05): the three Git types, who commits the creation
//! by the structural commit setting, the refusals with their stable codes,
//! and that the creation itself never commits.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use svode_core::git::policy::write_user_policy;
use svode_core::git::write_guard;
use svode_core::project::scaffold::{self, Storage};
use svode_core::routines::local::GitUserPolicy;
use svode_tools::dispatch::call_tool;
use svode_tools::host::{RequestTarget, ToolHost};
use svode_tools::result::ToolCallResult;
use svode_tools::standalone::StandaloneHost;

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

impl Fixture {
    /// A Project scaffolded like one created in the desktop app, with a
    /// committed repository when `repository` is set.
    fn new(repository: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().canonicalize().unwrap().join("project");
        fs::create_dir_all(&project).unwrap();
        scaffold::scaffold(&project, "Project", "", "", Storage::Own).unwrap();
        if repository {
            let hooks = temp.path().join("hooks");
            fs::create_dir_all(&hooks).unwrap();
            git(&project, &["init", "-q"]);
            for (key, value) in [
                ("user.email", "agent@example.com"),
                ("user.name", "Agent"),
                ("commit.gpgsign", "false"),
                ("maintenance.auto", "false"),
                ("core.hooksPath", hooks.to_str().unwrap()),
            ] {
                git(&project, &["config", key, value]);
            }
            git(&project, &["add", "-A"]);
            git(&project, &["commit", "-qm", "Base"]);
        }
        Self {
            _temp: temp,
            project,
        }
    }

    fn with_structural_commits(self) -> Self {
        write_user_policy(
            &self.project,
            &GitUserPolicy {
                auto_commit_structural: true,
                ..GitUserPolicy::default()
            },
        )
        .unwrap();
        self
    }

    fn target(&self) -> RequestTarget {
        let project = self.project.to_string_lossy().to_string();
        RequestTarget {
            project_path: project.clone(),
            default_space_id: None,
            default_space_path: project,
            routine_caller: None,
        }
    }

    async fn create(&self, host: &StandaloneHost, args: Value) -> ToolCallResult {
        call_tool(host, Some(&self.target()), "create_space", args).await
    }

    fn commits(&self, repository: &Path) -> String {
        git(repository, &["rev-list", "--all", "--count"])
            .trim()
            .to_string()
    }

    /// Every file of the Project outside `.git`, without the lock file of
    /// the write guard.
    fn files(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path
                    .file_name()
                    .is_some_and(|name| name == ".git" || name == "write.lock")
                {
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
        walk(&self.project, &self.project, &mut files);
        files
    }

    fn spaces(&self) -> Vec<String> {
        let config: Value =
            serde_json::from_slice(&fs::read(self.project.join(".svode/config.json")).unwrap())
                .unwrap();
        config["spaces"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|space| space["path"].as_str().unwrap().to_string())
            .collect()
    }
}

fn structured(result: &ToolCallResult) -> &Value {
    assert!(!result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()
}

fn error_code(result: &ToolCallResult) -> String {
    assert!(result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

fn paths(value: &Value) -> BTreeSet<String> {
    value["changedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect()
}

fn set(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|path| path.to_string()).collect()
}

#[tokio::test]
async fn each_git_type_is_created_without_a_commit_and_waits_for_a_manual_commit() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new(true);
    let host = StandaloneHost::new("test");
    host.open_project(&fixture.project).await.unwrap();
    let base = fixture.commits(&fixture.project);

    let inline = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    let inline = structured(&inline);
    assert_eq!(inline["space"]["gitType"], "inline", "{inline}");
    assert_eq!(inline["space"]["name"], "Notes");
    assert_eq!(inline["space"]["folder"], "notes");
    assert!(
        inline["space"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    assert_eq!(
        inline["repositories"],
        json!([{
            "path": ".",
            "created": false,
            "initialBranch": null,
            "upstream": false,
            "commit": { "by": "manual", "reason": "structural_commits_off" }
        }])
    );
    assert_eq!(inline["storage"]["inherited"], true);
    assert_eq!(inline["storage"]["strategy"], "local");
    assert_eq!(
        inline["settings"],
        "Svode Desktop → Settings → Git / Storage"
    );
    assert_eq!(
        paths(inline),
        set(&[
            "notes/.svode/config.json",
            "notes/.svode/local.json",
            "notes/README.md",
            ".svode/config.json",
            ".gitignore",
        ])
    );

    let independent = fixture
        .create(
            &host,
            json!({ "name": "Clients", "folder": "clients", "gitType": "independent", "icon": "🗂", "description": "Client data" }),
        )
        .await;
    let independent = structured(&independent);
    assert_eq!(independent["space"]["gitType"], "independent");
    assert_eq!(independent["space"]["icon"], "🗂");
    assert_eq!(independent["space"]["description"], "Client data");
    let repositories = independent["repositories"].as_array().unwrap();
    assert_eq!(repositories.len(), 2, "{independent}");
    assert_eq!(repositories[0]["path"], ".");
    assert_eq!(
        repositories[0]["commit"],
        json!({ "by": "manual", "reason": "structural_commits_off" })
    );
    assert_eq!(repositories[1]["path"], "clients");
    assert_eq!(repositories[1]["created"], true);
    assert!(
        repositories[1]["initialBranch"].is_string(),
        "{independent}"
    );
    assert_eq!(repositories[1]["upstream"], false);
    assert_eq!(
        repositories[1]["commit"],
        json!({ "by": "manual", "reason": "new_repository" })
    );
    assert_eq!(
        independent["storage"],
        json!({
            "inherited": false,
            "strategy": "local",
            "binaryRouting": { "lfsExtensions": [], "lfsThresholdBytes": 10_000_000 }
        })
    );
    assert_eq!(
        paths(independent),
        set(&[
            "clients/.svode/config.json",
            "clients/.svode/local.json",
            "clients/README.md",
            "clients/.gitignore",
            ".svode/config.json",
            ".gitignore",
        ])
    );

    let submodule = fixture
        .create(
            &host,
            json!({ "name": "Code", "folder": "code", "gitType": "submodule" }),
        )
        .await;
    let submodule = structured(&submodule);
    assert_eq!(submodule["space"]["gitType"], "submodule");
    assert!(paths(submodule).contains(".gitmodules"), "{submodule}");
    assert!(!paths(submodule).contains(".gitignore"), "{submodule}");
    assert!(fixture.project.join("code/.git").exists());

    assert_eq!(fixture.spaces(), ["notes", "clients", "code"]);
    assert_eq!(fixture.commits(&fixture.project), base, "no commit");
    for repository in ["clients", "code"] {
        assert_eq!(
            fixture.commits(&fixture.project.join(repository)),
            "0",
            "{repository}"
        );
    }
    host.close().await;
}

#[tokio::test]
async fn with_structural_commits_on_desktop_commits_the_project_repository() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new(true).with_structural_commits();
    let host = StandaloneHost::new("test");
    let base = fixture.commits(&fixture.project);

    let created = fixture
        .create(
            &host,
            json!({ "name": "Clients", "folder": "clients", "gitType": "independent" }),
        )
        .await;
    let created = structured(&created);
    assert_eq!(
        created["repositories"][0]["commit"],
        json!({ "by": "desktop", "message": "Add independent space clients" })
    );
    assert_eq!(
        created["repositories"][1]["commit"],
        json!({ "by": "manual", "reason": "new_repository" })
    );
    let inline = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    assert_eq!(
        structured(&inline)["repositories"],
        json!([{
            "path": ".",
            "created": false,
            "initialBranch": null,
            "upstream": false,
            "commit": { "by": "desktop", "message": "Add inline space notes" }
        }])
    );

    // Creating never commits: Desktop makes the creation commit.
    assert_eq!(fixture.commits(&fixture.project), base);
    assert_eq!(fixture.commits(&fixture.project.join("clients")), "0");
}

#[tokio::test]
async fn refusals_carry_their_stable_code_and_change_nothing() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new(true);
    let host = StandaloneHost::new("test");
    fs::create_dir_all(fixture.project.join("taken")).unwrap();
    let before = fixture.files();

    for (args, code) in [
        (
            json!({ "name": "Taken", "folder": "taken" }),
            "FILE_ALREADY_EXISTS",
        ),
        (json!({ "name": "Nested", "folder": "a/b" }), "INVALID_PATH"),
        (
            json!({ "name": "Clients", "folder": "Клиенты" }),
            "INVALID_PATH",
        ),
        (json!({ "name": "Up", "folder": ".." }), "INVALID_PATH"),
        (json!({ "name": " ", "folder": "blank" }), "SVODE_ERROR"),
        (
            json!({ "name": "Clients", "folder": "clients", "gitType": "remote" }),
            "SERIALIZATION_ERROR",
        ),
        (
            json!({ "name": "Clients", "folder": "clients", "spaceId": "root" }),
            "SERIALIZATION_ERROR",
        ),
    ] {
        let refused = fixture.create(&host, args.clone()).await;
        assert_eq!(error_code(&refused), code, "{args}");
    }
    let taken = fixture
        .create(&host, json!({ "name": "Taken", "folder": "taken" }))
        .await;
    assert!(
        taken.structured_content.unwrap()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("taken")
    );

    // Another writer holds the Project repository.
    let held = write_guard::acquire(
        &BTreeSet::from([fixture.project.canonicalize().unwrap()]),
        &[],
    )
    .await
    .unwrap();
    let busy = fixture
        .create(&host, json!({ "name": "Busy", "folder": "busy" }))
        .await;
    assert_eq!(error_code(&busy), "SOURCE_BUSY");
    drop(held);
    assert_eq!(fixture.files(), before);

    // A registered Space owns its folder even when the folder is missing.
    let created = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    structured(&created);
    fs::remove_dir_all(fixture.project.join("notes")).unwrap();
    let again = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    assert_eq!(error_code(&again), "FILE_ALREADY_EXISTS");
    assert!(!fixture.project.join("notes").exists());
}

#[tokio::test]
async fn an_unreadable_project_config_refuses_before_any_write() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new(true);
    let config = fixture.project.join(".svode/config.json");
    fs::write(
        &config,
        "<<<<<<< ours\n{\"name\":\"A\"}\n=======\n{\"name\":\"B\"}\n>>>>>>> theirs\n",
    )
    .unwrap();
    let before = fixture.files();
    let refused = fixture
        .create(
            &StandaloneHost::new("test"),
            json!({ "name": "Notes", "folder": "notes" }),
        )
        .await;
    assert_eq!(error_code(&refused), "INVALID_PROJECT_CONFIG");
    assert_eq!(fixture.files(), before);
}

#[tokio::test]
async fn without_a_project_repository_an_inline_space_has_no_git_effects_and_a_submodule_is_refused()
 {
    let fixture = Fixture::new(false);
    let host = StandaloneHost::new("test");
    let before = fixture.files();
    let refused = fixture
        .create(
            &host,
            json!({ "name": "Code", "folder": "code", "gitType": "submodule" }),
        )
        .await;
    assert_eq!(error_code(&refused), "SVODE_ERROR");
    assert!(
        refused.structured_content.unwrap()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Git repository")
    );
    assert_eq!(fixture.files(), before);

    let inline = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    let inline = structured(&inline);
    assert_eq!(inline["repositories"], json!([]));
    assert_eq!(
        paths(inline),
        set(&[
            "notes/.svode/config.json",
            "notes/.svode/local.json",
            "notes/README.md",
            ".svode/config.json",
        ])
    );
    assert!(!fixture.project.join(".git").exists());
    assert!(!fixture.project.join(".gitignore").exists());
}

#[tokio::test]
async fn the_session_writes_and_searches_a_new_space_as_its_own() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new(true);
    let host = StandaloneHost::new("test");
    host.open_project(&fixture.project).await.unwrap();
    let target = fixture.target();
    // The root index is prepared before the Space exists.
    let root = call_tool(
        &host,
        Some(&target),
        "search_pages",
        json!({ "query": "x" }),
    )
    .await;
    structured(&root);

    let created = fixture
        .create(&host, json!({ "name": "Notes", "folder": "notes" }))
        .await;
    let id = structured(&created)["space"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let page = call_tool(
        &host,
        Some(&target),
        "create_page",
        json!({ "spaceId": id, "parentPath": "", "title": "Kickoff", "content": "Quarterly kickoff agenda" }),
    )
    .await;
    structured(&page);
    assert!(fixture.project.join("notes/Kickoff.md").is_file());

    let found = |result: &ToolCallResult| {
        structured(result)["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hit| hit.to_string().contains("Kickoff"))
    };
    let in_space = call_tool(
        &host,
        Some(&target),
        "search_pages",
        json!({ "spaceId": id, "query": "kickoff" }),
    )
    .await;
    assert!(found(&in_space), "{:?}", in_space.structured_content);
    let in_root = call_tool(
        &host,
        Some(&target),
        "search_pages",
        json!({ "spaceId": "root", "query": "kickoff" }),
    )
    .await;
    assert!(!found(&in_root), "{:?}", in_root.structured_content);
    host.close().await;
}
