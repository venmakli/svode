//! Managed asset import, App list and description, and App manifest
//! validation through the real `svode` binary with the desktop app closed.
//! Validation needs no Project; list and description answer with the
//! structured result of the shared capability.
//! The import copies the file by the routing of its Space without a commit;
//! a Git LFS route answers with the live readiness probe of the process and
//! refuses before any write while it is not ready.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::process::{code, json, snapshot, svode, write};
use serde_json::{Value, json};
use svode_core::storage::policy;

const PROCESS_APP: &str = "runtime:\n  type: process\n  start:\n    argv: [tool]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: ${API_TOKEN}\n  REGION: ${REGION}-eu\n";

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    let elsewhere = base.join("elsewhere");
    write(&elsewhere.join("photo.png"), "image");
    write(&elsewhere.join("app.yaml"), PROCESS_APP);
    write(
        &elsewhere.join("broken.yaml"),
        "runtime:\n  type: process\n  start:\n    argv: []\n",
    );
    (temp, root, elsewhere)
}

#[test]
fn app_validate_needs_no_project_and_reports_diagnostics_as_a_result() {
    let (_temp, root, elsewhere) = fixture();
    let before = snapshot(&root);

    let (exit, valid) = json(&elsewhere, &["app", "validate", "--file", "app.yaml"], None);
    assert_eq!(exit, 0, "{valid}");
    assert_eq!(valid["ok"], true);
    assert_eq!(valid["target"], json!({}));
    assert_eq!(valid["valid"], true);
    assert_eq!(valid["runtimeType"], "process");
    assert_eq!(valid["settingsReferences"], json!(["API_TOKEN", "REGION"]));
    assert_eq!(valid["diagnostics"], json!([]));

    // Project selectors do not matter to a Project-free command.
    let (exit, stdin) = json(
        &root,
        &["--project", "missing", "app", "validate", "--file", "-"],
        Some(PROCESS_APP),
    );
    assert_eq!(exit, 0, "{stdin}");
    assert_eq!(stdin["valid"], true);

    let (exit, invalid) = json(
        &elsewhere,
        &["app", "validate", "--file", "broken.yaml"],
        None,
    );
    assert_eq!(exit, 0, "{invalid}");
    assert_eq!(invalid["ok"], true);
    assert_eq!(invalid["valid"], false);
    assert_eq!(invalid["runtimeType"], Value::Null);
    let diagnostics = invalid["diagnostics"].as_array().unwrap();
    assert!(!diagnostics.is_empty());
    assert!(diagnostics.iter().all(|diagnostic| {
        diagnostic["code"].is_string()
            && diagnostic["path"].is_string()
            && diagnostic["message"].is_string()
    }));

    let (exit, oversized) = json(
        &elsewhere,
        &["app", "validate", "--file", "-"],
        Some(&" ".repeat(64 * 1024 + 1)),
    );
    assert_eq!(exit, 0);
    assert_eq!(oversized["valid"], false);
    assert_eq!(oversized["diagnostics"][0]["code"], "resource_limit");

    let human = svode(&elsewhere, &["app", "validate", "--file", "app.yaml"]);
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        "valid process App\nsetting API_TOKEN\nsetting REGION\n"
    );
    let human = svode(&elsewhere, &["app", "validate", "--file", "broken.yaml"]);
    assert_eq!(human.status.code(), Some(0));
    let stdout = String::from_utf8(human.stdout).unwrap();
    assert!(stdout.starts_with("invalid\n"), "{stdout}");
    assert!(stdout.lines().count() > 1, "{stdout}");

    // Nothing is written anywhere.
    assert_eq!(snapshot(&root), before);
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        3,
        "no files next to the candidate"
    );
}

/// Structured result of `tool` from the shared dispatch on the standalone
/// host, the same one `svode-mcp --project` serves as `structuredContent`.
fn shared_result(project: &Path, tool: &str, args: Value) -> Value {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let host = svode_tools::standalone::StandaloneHost::new("test");
        let target = svode_tools::host::RequestTarget {
            project_path: project.to_string_lossy().to_string(),
            default_space_id: None,
            default_space_path: project.to_string_lossy().to_string(),
            routine_caller: None,
        };
        let result = svode_tools::dispatch::call_tool(&host, Some(&target), tool, args).await;
        host.close().await;
        result.structured_content.unwrap()
    })
}

/// The command result without the envelope the CLI adds.
fn payload(mut value: Value) -> Value {
    let object = value.as_object_mut().unwrap();
    for key in ["ok", "schemaVersion", "target"] {
        object.remove(key);
    }
    value
}

#[test]
fn app_list_and_show_answer_with_the_shared_result_and_change_nothing() {
    let (_temp, root, _elsewhere) = fixture();
    write(&root.join("apps/README.md"), "---\ntitle: Apps\n---\n");
    write(
        &root.join("apps/board/app.yaml"),
        "runtime:\n  type: url\n  url: https://example.com/board\n",
    );
    write(
        &root.join("apps/board/Readme.md"),
        "---\ntitle: Board\n---\n## For agents\n\nRead `board.json`.\n",
    );
    write(&root.join("apps/api/app.yaml"), PROCESS_APP);
    let before = snapshot(&root);

    let (exit, listed) = json(&root, &["app", "list"], None);
    assert_eq!(exit, 0, "{listed}");
    assert_eq!(listed["ok"], true);
    assert_eq!(listed["target"]["spaceId"], "root");
    assert_eq!(
        listed["apps"],
        json!([
            { "ownerPath": "apps/api", "runtimeType": "process", "valid": true, "diagnosticCount": 0, "hasReadme": false },
            { "ownerPath": "apps/board", "runtimeType": "url", "valid": true, "diagnosticCount": 0, "hasReadme": true },
        ])
    );
    assert_eq!(
        payload(listed),
        shared_result(&root, "list_apps", json!({}))
    );

    let (exit, shown) = json(&root, &["app", "show", "apps/board"], None);
    assert_eq!(exit, 0, "{shown}");
    assert_eq!(shown["target"]["owner"], "apps/board");
    assert_eq!(shown["readme"]["path"], "apps/board/Readme.md");
    assert_eq!(
        shown["readme"]["body"],
        "## For agents\n\nRead `board.json`.\n"
    );
    assert_eq!(
        payload(shown),
        shared_result(&root, "get_app", json!({ "ownerPath": "apps/board" }))
    );

    let (exit, api) = json(&root, &["app", "show", "apps/api"], None);
    assert_eq!(exit, 0, "{api}");
    assert_eq!(api["url"], "http://127.0.0.1:3210");
    assert_eq!(api["readme"], Value::Null);
    assert!(!api.to_string().contains("API_TOKEN"));

    let (exit, refused) = json(&root, &["app", "show", "notes.md"], None);
    assert_eq!(exit, 1, "{refused}");
    assert_eq!(code(&refused), "PATH_NOT_ACCESSIBLE");
    let (exit, refused) = json(&root, &["app", "show", "apps"], None);
    assert_eq!(exit, 1, "{refused}");
    assert_eq!(code(&refused), "NOT_AN_APP");
    let (exit, missing) = json(&root, &["app", "show"], None);
    assert_eq!(exit, 2, "{missing}");

    let human = svode(&root, &["app", "list"]);
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        "apps/api\tprocess\tno readme\napps/board\turl\treadme\n"
    );
    let human = svode(&root, &["app", "show", "apps/board"]);
    let stdout = String::from_utf8(human.stdout).unwrap();
    assert!(
        stdout.starts_with("apps/board\nruntime: url\nurl: https://example.com/board\nreadme: apps/board/Readme.md\n\n## For agents"),
        "{stdout}"
    );
    for verb in ["list", "show"] {
        let help = svode(&root, &["app", verb, "--help"]);
        assert_eq!(help.status.code(), Some(0));
        let help = String::from_utf8(help.stdout).unwrap();
        assert!(help.contains("Example"), "{help}");
        assert!(
            help.contains(&format!("svode --project ~/Notes app {verb}")),
            "{help}"
        );
    }

    // Reads only: no index or store is opened and nothing is written.
    let mut after = snapshot(&root);
    after.retain(|path, _| {
        let path = path.to_string_lossy();
        !path.starts_with(".svode/index.db") && path != ".svode/write.lock"
    });
    assert_eq!(after, before);
}

#[test]
fn app_validate_input_failures_exit_two() {
    let (_temp, _root, elsewhere) = fixture();
    fs::write(elsewhere.join("latin1.yaml"), [0x72, 0xe9, 0x0a]).unwrap();
    for (args, expected) in [
        (
            vec!["app", "validate", "--file", "absent.yaml"],
            "INPUT_UNREADABLE",
        ),
        (
            vec!["app", "validate", "--file", "latin1.yaml"],
            "INPUT_UNREADABLE",
        ),
        (vec!["app", "validate", "--file", "."], "INPUT_UNREADABLE"),
        (vec!["app", "validate"], "INVALID_ARGUMENT"),
        (vec!["app", "validate", "--yaml", "x"], "INVALID_ARGUMENT"),
    ] {
        let (exit, value) = json(&elsewhere, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// Commits the project with the given assets config of its root Space and
/// an independent child Space repository; `None` without Git.
fn committed(assets: Value) -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
    Command::new("git").arg("--version").output().ok()?;
    let (temp, root, elsewhere) = fixture();
    write(
        &root.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "assets": assets,
            "spaces": [{ "id": "child", "path": "child", "repo": null }]
        })
        .to_string(),
    );
    write(&root.join(".gitignore"), "child/\n");
    for dir in [root.clone(), root.join("child")] {
        if dir.ends_with("child") {
            write(&dir.join(".svode/config.json"), r#"{"name":"Child"}"#);
            write(&dir.join("page.md"), "---\ntitle: Page\n---\nChild\n");
        }
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "agent@example.com"]);
        git(&dir, &["config", "user.name", "Agent"]);
        git(&dir, &["config", "maintenance.auto", "false"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "fixture"]);
    }
    Some((temp, root, elsewhere))
}

/// Project sources without Git internals and the derived index, Routine
/// projection and device-local stores next to it.
fn sources(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut files = snapshot(root);
    files.retain(|path, _| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let derived = name.starts_with("index.db")
            || name.starts_with("routines.db")
            || name == "local.json"
            || name == "variables.lock"
            || name == "write.lock";
        !path.components().any(|part| part.as_os_str() == ".git")
            && !(derived
                && path
                    .parent()
                    .is_some_and(|parent| parent.ends_with(".svode")))
    });
    files
}

#[test]
fn asset_import_copies_by_the_local_routing_of_its_space_without_a_commit() {
    let Some((_temp, root, elsewhere)) = committed(json!({ "strategy": "local" })) else {
        return;
    };
    let head = git(&root, &["rev-parse", "HEAD"]);
    let photo = elsewhere.join("photo.png");
    let photo = photo.to_str().unwrap();

    let (exit, value) = json(
        &root,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            photo,
            "--name",
            "chart.png",
        ],
        None,
    );
    assert_eq!(exit, 0, "{value}");
    // The leaf Page became directory-backed to own the file.
    assert_eq!(value["contentPath"], "notes/README.md");
    assert_eq!(value["fileName"], "chart.png");
    let attachment = value["attachmentPath"].as_str().unwrap();
    assert_eq!(fs::read(root.join(attachment)).unwrap(), b"image");
    assert!(value["markdownUrl"].as_str().unwrap().contains("chart.png"));
    // A listed format stays local by the extension block, not by an exact rule.
    let gitignore = fs::read_to_string(root.join(".gitignore")).unwrap();
    assert!(gitignore.contains("*.[pP][nN][gG]"), "{gitignore}");
    assert!(!gitignore.contains("chart.png"), "{gitignore}");
    let changed = value["changedPaths"].to_string();
    assert!(changed.contains(".gitignore"), "{value}");
    assert!(elsewhere.join("photo.png").is_file(), "source kept");
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);

    // The next read sees the directory-backed Page.
    let (exit, read) = json(&root, &["page", "read", "--path", "notes/README.md"], None);
    assert_eq!(exit, 0, "{read}");

    // A child Space imports into its own repository.
    let child = root.join("child");
    let child_head = git(&child, &["rev-parse", "HEAD"]);
    let (exit, value) = json(
        &root,
        &[
            "--space", "child", "asset", "import", "--path", "page.md", "--file", photo,
        ],
        None,
    );
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["spaceId"], "child");
    let attachment = value["attachmentPath"].as_str().unwrap();
    assert!(child.join(attachment).is_file(), "{value}");
    assert_eq!(git(&child, &["rev-parse", "HEAD"]), child_head);
}

#[test]
fn an_lfs_route_refuses_the_import_before_any_write_until_it_is_ready() {
    let routing = json!({ "version": 1, "lfsExtensions": ["png"] });
    // A remote route whose repository has no reachable `origin`.
    let remote = committed(json!({ "strategy": "lfs-remote", "binaryRouting": routing }));
    // An S3 route without the S3 setup of this device, and one whose saved
    // setup names Secrets this device cannot resolve.
    let s3 = json!({
        "strategy": "lfs-s3",
        "binaryRouting": routing,
        "s3": { "endpoint": "https://s3.example.test", "bucket": "bucket", "region": "us-east-1", "prefix": "project" }
    });
    let unset = committed(s3.clone());
    let unresolved = committed(s3);
    let Some(((_a, remote, elsewhere), (_b, unset, _), (_c, unresolved, _))) = remote
        .zip(unset)
        .zip(unresolved)
        .map(|((a, b), c)| (a, b, c))
    else {
        return;
    };
    let library = unresolved.parent().unwrap().join("library");
    fs::create_dir_all(&library).unwrap();
    write(
        &unresolved.join(".svode/lfs-s3-agent.json"),
        &json!({
            "version": 2,
            "endpoint": "https://s3.example.test",
            "bucket": "bucket",
            "region": "us-east-1",
            "prefix": "project",
            "bindings": {
                "accessKey": { "owner": { "scope": "project" }, "name": "S3_KEY" },
                "secretKey": { "owner": { "scope": "project" }, "name": "S3_SECRET" }
            },
            "globalDirectory": library,
            "projectPath": unresolved,
            "spaceId": null
        })
        .to_string(),
    );
    let photo = elsewhere.join("photo.png");
    let photo = photo.to_str().unwrap();

    for root in [&remote, &unset, &unresolved] {
        let before = sources(root);
        let head = git(root, &["rev-parse", "HEAD"]);
        let (exit, refused) = json(
            root,
            &["asset", "import", "--path", "notes.md", "--file", photo],
            None,
        );
        assert_eq!(exit, 1, "{refused}");
        assert_eq!(refused["ok"], false);
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Git LFS route is not ready"),
            "{refused}"
        );
        assert_eq!(refused["error"]["target"]["path"], "notes.md");
        assert_eq!(sources(root), before, "{}", root.display());
        assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
        // The probe never registers a transfer agent for an unready route.
        let agent = Command::new("git")
            .args(["config", "--local", "--get", "lfs.standalonetransferagent"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(!agent.status.success(), "{}", root.display());
    }

    // A file the routing keeps out of LFS still imports on the same Space.
    write(&elsewhere.join("photo.jpg"), "image");
    let jpg = elsewhere.join("photo.jpg");
    let (exit, value) = json(
        &remote,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            jpg.to_str().unwrap(),
        ],
        None,
    );
    assert_eq!(exit, 0, "{value}");
    let content = value["contentPath"].as_str().unwrap().to_string();

    // Once Git LFS reaches `origin`, the same route is ready and the file is
    // stored through it, still without a commit.
    let has_lfs = Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|output| output.status.success());
    if has_lfs {
        let bare = remote.parent().unwrap().join("remote.git");
        git(
            remote.parent().unwrap(),
            &["init", "-q", "--bare", bare.to_str().unwrap()],
        );
        git(
            &remote,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        git(&remote, &["push", "-q", "origin", "HEAD:main"]);
        // The strategy applied in Storage settings keeps its managed LFS
        // rules in `.gitattributes`.
        let routing = serde_json::from_value(routing.clone()).unwrap();
        write(
            &remote.join(".gitattributes"),
            &format!(
                "{}\n{}\n{}\n",
                policy::LFS_START,
                policy::managed_lfs_attributes_body(&routing).trim_end(),
                policy::LFS_END
            ),
        );
        let (exit, access) = json(&remote, &["git", "access", "verify"], None);
        assert_eq!(exit, 0, "{access}");
        let head = git(&remote, &["rev-parse", "HEAD"]);
        let (exit, value) = json(
            &remote,
            &["asset", "import", "--path", &content, "--file", photo],
            None,
        );
        assert_eq!(exit, 0, "{value}");
        let attachment = value["attachmentPath"].as_str().unwrap();
        assert!(
            git(&remote, &["check-attr", "filter", "--", attachment]).ends_with("filter: lfs"),
            "{value}"
        );
        assert!(remote.join(attachment).is_file());
        assert_eq!(git(&remote, &["rev-parse", "HEAD"]), head);
    }
}

#[test]
fn asset_import_grammar_fails_before_the_command_runs() {
    let (_temp, root, _elsewhere) = fixture();
    let before = snapshot(&root);
    for args in [
        vec!["asset", "import", "--path", "notes.md"],
        vec!["asset", "import", "--file", "photo.png"],
        vec![
            "asset", "import", "--path", "notes.md", "--file", "x", "--force",
        ],
        vec!["asset", "upload", "--path", "notes.md", "--file", "x"],
    ] {
        let (exit, value) = json(&root, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), "INVALID_ARGUMENT", "{args:?}");
    }
    assert_eq!(snapshot(&root), before);
}

#[test]
fn asset_and_app_help_work_without_a_project() {
    let temp = tempfile::tempdir().unwrap();
    for args in [["asset", "import", "--help"], ["app", "validate", "--help"]] {
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Example"), "{args:?}: {help}");
        assert!(!help.contains("MODE_UNAVAILABLE"), "{args:?}: {help}");
    }
    for noun in ["asset", "app"] {
        let output = svode(temp.path(), &[noun, "--help"]);
        assert_eq!(output.status.code(), Some(0), "{noun}");
    }
}
