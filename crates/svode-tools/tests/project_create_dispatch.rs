//! `create_project` on the standalone host of `svode` and `svode-mcp`
//! (Stage 11 05): a Project-free capability with an absolute path, the
//! applied settings it answers, the refusals with their stable codes, which
//! Project the next requests address per host, and that it never commits.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use svode_core::project::registry;
use svode_core::project::scaffold::{self, Storage};
use svode_tools::catalog;
use svode_tools::dispatch::{call_tool, requires_project};
use svode_tools::host::RequestTarget;
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

fn has_head(repository: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(repository)
        .output()
        .unwrap()
        .status
        .success()
}

/// A temporary directory outside any Project with its own project list of
/// the device.
struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    list: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        Self {
            list: base.join("device"),
            base,
            _temp: temp,
        }
    }

    fn host(&self) -> StandaloneHost {
        StandaloneHost::new("test").with_project_list_dir(self.list.clone())
    }

    fn session(&self) -> StandaloneHost {
        StandaloneHost::session("test").with_project_list_dir(self.list.clone())
    }

    fn registered(&self) -> Vec<(String, String)> {
        if !registry::file(&self.list).exists() {
            return Vec::new();
        }
        registry::read(&self.list)
            .unwrap()
            .spaces
            .into_iter()
            .map(|entry| (entry.id, entry.path))
            .collect()
    }
}

fn target(project: &Path) -> RequestTarget {
    let project = project.to_string_lossy().to_string();
    RequestTarget {
        project_path: project.clone(),
        default_space_id: None,
        default_space_path: project,
        routine_caller: None,
    }
}

async fn create(
    host: &StandaloneHost,
    target: Option<&RequestTarget>,
    args: Value,
) -> ToolCallResult {
    call_tool(host, target, "create_project", args).await
}

fn ok(result: &ToolCallResult) -> &Value {
    assert!(!result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()
}

fn code(result: &ToolCallResult) -> String {
    assert!(result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
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

#[tokio::test]
async fn a_new_folder_becomes_a_registered_project_with_a_new_repository_and_no_commit() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new();
    let host = fixture.host();
    // `.` and `..` are resolved; the folder is created with its parents.
    let requested = format!("{}/work/./tmp/../acme", fixture.base.display());
    let result = create(&host, None, json!({ "path": requested, "icon": "🚀" })).await;
    let created = ok(&result).clone();
    let project = fixture.base.join("work/acme");
    let path = project.to_string_lossy().to_string();

    let id = created["project"]["id"].as_str().unwrap().to_string();
    assert_eq!(fixture.registered(), [(id, path.clone())]);
    assert_eq!(created["project"]["name"], "acme", "the folder name");
    assert_eq!(created["project"]["path"], path);
    assert_eq!(created["project"]["icon"], "🚀");
    assert_eq!(created["registration"], json!({ "registered": true }));
    let repository = &created["repositories"][0];
    assert_eq!(created["repositories"].as_array().unwrap().len(), 1);
    assert_eq!(repository["path"], ".");
    assert_eq!(repository["created"], true);
    assert_eq!(repository["upstream"], false);
    assert!(repository["initialBranch"].is_string(), "{repository}");
    assert_eq!(
        repository["commit"],
        json!({ "by": "manual", "reason": "new_repository" })
    );
    assert_eq!(created["gitNotFound"], false);
    assert_eq!(created["storage"]["inherited"], false);
    assert_eq!(created["storage"]["strategy"], "local");
    assert_eq!(
        created["storage"]["binaryRouting"]["lfsExtensions"],
        json!([])
    );
    assert_eq!(
        created["settings"],
        "Svode Desktop → Settings → Git / Storage"
    );
    assert_eq!(
        created["session"],
        json!({
            "addressing": "per_command",
            "addressesCreatedProject": false,
            "hint": format!("Each svode command addresses the project of its directory: run the next commands in {path} or pass --project {path}."),
        })
    );
    let changed = created["changedPaths"].as_array().unwrap();
    for file in [".svode/config.json", ".svode/local.json", "README.md"] {
        assert!(changed.contains(&json!(file)), "{changed:?}");
        assert!(project.join(file).is_file(), "{file}");
    }
    assert!(project.join(".git").is_dir());
    assert!(!has_head(&project), "the creation commits nothing");
    let summary = &result.content[0].text;
    assert!(summary.contains("Created project acme"), "{summary}");
    assert!(summary.contains("no commit"), "{summary}");
}

/// A committed repository with the given remote of `origin`.
fn code_repository(base: &Path, remote: Option<&Path>) -> PathBuf {
    let repository = base.join("code");
    fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "-q"]);
    for (key, value) in [
        ("user.email", "agent@example.com"),
        ("user.name", "Agent"),
        ("commit.gpgsign", "false"),
        ("maintenance.auto", "false"),
    ] {
        git(&repository, &["config", key, value]);
    }
    fs::write(repository.join("main.rs"), "fn main() {}\n").unwrap();
    git(&repository, &["add", "-A"]);
    git(&repository, &["commit", "-qm", "Code"]);
    if let Some(remote) = remote {
        git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(
            &repository,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&repository, &["push", "-q", "-u", "origin", "HEAD"]);
    }
    repository
}

#[tokio::test]
async fn an_existing_repository_becomes_the_project_without_a_commit() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new();
    let repository = code_repository(&fixture.base, None);
    let head = git(&repository, &["rev-parse", "HEAD"]);

    let created = create(
        &fixture.host(),
        None,
        json!({ "path": repository, "name": "My app", "description": "Notes of the app" }),
    )
    .await;
    let created = ok(&created);
    assert_eq!(created["project"]["name"], "My app");
    assert_eq!(created["project"]["description"], "Notes of the app");
    assert_eq!(
        created["repositories"],
        json!([{
            "path": ".",
            "created": false,
            "initialBranch": null,
            "upstream": false,
            "commit": { "by": "manual", "reason": "structural_commits_off" },
        }])
    );
    assert_eq!(git(&repository, &["rev-parse", "HEAD"]), head, "no commit");
    assert_eq!(
        fs::read_to_string(repository.join("main.rs")).unwrap(),
        "fn main() {}\n"
    );
    assert!(repository.join(".svode/config.json").is_file());
}

/// Write access of a repository with a remote is proven only by evidence
/// of a Project Space; the refusal says how to get there and changes
/// nothing.
#[tokio::test]
async fn an_existing_repository_without_access_evidence_is_refused_with_a_reachable_next_step() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new();
    let repository = code_repository(&fixture.base, Some(&fixture.base.join("remote.git")));
    let before = files(&repository);
    let refused = create(&fixture.host(), None, json!({ "path": repository })).await;
    assert_eq!(code(&refused), "REPOSITORY_ACCESS_DENIED");
    let error = &refused.structured_content.as_ref().unwrap()["error"];
    assert_eq!(error["status"], "unknown", "{error}");
    let hint = error["hint"].as_str().unwrap();
    assert!(hint.contains("Open folder"), "{hint}");
    assert!(!hint.contains("svode git access verify"), "{hint}");
    assert_eq!(files(&repository), before);
    assert!(fixture.registered().is_empty());
}

#[tokio::test]
async fn refusals_have_stable_codes_and_change_nothing() {
    let fixture = Fixture::new();
    let host = fixture.host();
    let existing = fixture.base.join("existing");
    fs::create_dir_all(&existing).unwrap();
    scaffold::scaffold(&existing, "Existing", "", "", Storage::Own).unwrap();
    let before = files(&fixture.base);

    for relative in ["acme", "./acme", ""] {
        let refused = create(&host, None, json!({ "path": relative })).await;
        assert_eq!(code(&refused), "INVALID_PATH", "{relative:?}");
    }
    let taken = create(&host, None, json!({ "path": existing })).await;
    assert_eq!(code(&taken), "PROJECT_ALREADY_EXISTS");

    let nested = create(&host, None, json!({ "path": existing.join("docs/notes") })).await;
    assert_eq!(code(&nested), "PROJECT_NESTED");
    let error = &nested.structured_content.as_ref().unwrap()["error"];
    assert_eq!(error["project"], existing.to_string_lossy().as_ref());
    assert!(
        error["hint"].as_str().unwrap().contains("create_space"),
        "{error}"
    );

    let file = fixture.base.join("file.txt");
    fs::write(&file, "text").unwrap();
    let not_a_folder = create(&host, None, json!({ "path": file })).await;
    assert_eq!(code(&not_a_folder), "PATH_NOT_ACCESSIBLE");
    fs::remove_file(&file).unwrap();

    let unknown = create(&host, None, json!({ "path": "/x", "gitType": "inline" })).await;
    assert!(unknown.is_error);

    assert_eq!(files(&fixture.base), before);
    assert!(fixture.registered().is_empty());
}

/// A headless session without a Project binds to the Project it creates; a
/// session with one keeps it, and so does a bound session that creates
/// another Project.
#[tokio::test]
async fn a_session_without_a_project_takes_the_created_one_and_a_session_with_one_keeps_it() {
    let fixture = Fixture::new();
    let session = fixture.session();
    let first = fixture.base.join("first");
    let created = create(&session, None, json!({ "path": first })).await;
    assert_eq!(
        ok(&created)["session"],
        json!({ "addressing": "session", "addressesCreatedProject": true })
    );
    assert!(
        created.content[0]
            .text
            .contains("The next calls of this session address the new project.")
    );
    assert_eq!(session.project(), Some(first.as_path()));

    let second = fixture.base.join("second");
    for target in [Some(target(&first)), None] {
        let path = second.join(if target.is_some() { "a" } else { "b" });
        let kept = create(&session, target.as_ref(), json!({ "path": path })).await;
        let shown = path.to_string_lossy().to_string();
        assert_eq!(
            ok(&kept)["session"],
            json!({
                "addressing": "session",
                "addressesCreatedProject": false,
                "project": first.to_string_lossy(),
                "hint": format!("Work with the new project through `svode --project {shown}` or a new agent session started in its folder."),
            })
        );
        assert_eq!(session.project(), Some(first.as_path()));
    }
    assert_eq!(fixture.registered().len(), 3);
    session.close().await;
}

/// Project-free tools run without a request target; every other tool needs
/// one.
#[tokio::test]
async fn project_free_tools_run_without_a_target() {
    let host = StandaloneHost::new("test");
    let mut free = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .filter(|name| !requires_project(name))
        .collect::<Vec<_>>();
    free.sort_unstable();
    assert_eq!(
        free,
        ["create_project", "get_svode_guide", "validate_app_manifest"]
    );
    for name in free {
        let result = call_tool(&host, None, name, json!({})).await;
        if result.is_error {
            assert_ne!(
                result.structured_content.unwrap()["error"]["code"],
                "NO_ACTIVE_PROJECT",
                "{name}"
            );
        }
    }
    let refused = call_tool(&host, None, "list_spaces", json!({})).await;
    assert_eq!(code(&refused), "NO_ACTIVE_PROJECT");
}
