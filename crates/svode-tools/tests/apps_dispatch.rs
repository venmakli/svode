//! App list and description through the shared dispatch on the standalone
//! host, against a real project: owners the Space tree shows (Space root,
//! Page, Collection, App-only and nested directories), the README the
//! Description tab shows, the cut of a long README and the stable codes.
//! The operations only read: the project is unchanged afterwards.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use svode_core::apps::catalog::APP_README_TEXT_LIMIT_BYTES;
use svode_tools::dispatch::call_tool;
use svode_tools::host::RequestTarget;
use svode_tools::result::ToolCallResult;
use svode_tools::standalone::StandaloneHost;

const URL_APP: &str = "runtime:\n  type: url\n  url: https://example.com/tool\n";
const STATIC_APP: &str = "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\n";
const PROCESS_APP: &str = "runtime:\n  type: process\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: Bearer ${API_TOKEN}\n";

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
    long_body: String,
}

fn write(path: &Path, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
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
    let long_body = format!("# Long\n\n{}\n", "Line of guidance. ".repeat(2_000));
    for (path, source) in [
        // The Space root is an App and keeps its README as the Space owner.
        ("app.yaml", URL_APP),
        ("README.md", "---\ntitle: Project\n---\nRoot App guide\n"),
        // A Page with App capability.
        (
            "guide/README.md",
            "---\ntitle: Guide\n---\nPage App guide\n",
        ),
        ("guide/app.yaml", STATIC_APP),
        // A Collection with App capability.
        ("tasks/schema.yaml", "columns: []\nviews: []\n"),
        (
            "tasks/README.md",
            "---\ntitle: Tasks\n---\nCollection App guide\n",
        ),
        ("tasks/app.yaml", PROCESS_APP),
        ("tasks/alpha.md", "---\ntitle: Alpha\n---\n"),
        // An App-only directory whose README has another name case, with a
        // nested App owner and an app.yaml in an ordinary source directory.
        ("board/app.yaml", URL_APP),
        ("board/readme.md", "## For agents\n\nUse `board.json`.\n"),
        ("board/panel/app.yaml", URL_APP),
        ("board/src/widgets/app.yaml", URL_APP),
        // A Page whose app.yaml the tree policy hides, a hidden directory
        // with an App and a Page without App.
        ("ignored/README.md", "---\ntitle: Ignored marker\n---\n"),
        ("ignored/app.yaml", URL_APP),
        ("generated/app.yaml", URL_APP),
        (".gitignore", "ignored/app.yaml\ngenerated/\n"),
        ("notes/README.md", "---\ntitle: Notes\n---\n"),
        // A child Space is listed in its own Space only.
        ("child/.svode/config.json", r#"{"name":"Child"}"#),
        ("child/app.yaml", URL_APP),
    ] {
        write(&project.join(path), source);
    }
    write(&project.join("long/app.yaml"), URL_APP);
    write(&project.join("long/README.md"), &long_body);
    Fixture {
        _temp: temp,
        project,
        long_body,
    }
}

fn target(fixture: &Fixture) -> RequestTarget {
    RequestTarget {
        project_path: fixture.project.to_string_lossy().to_string(),
        default_space_id: None,
        default_space_path: fixture.project.to_string_lossy().to_string(),
        routine_caller: None,
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.insert(path.clone(), fs::read(&path).unwrap());
            }
        }
    }
    files
}

fn structured(result: ToolCallResult) -> Value {
    assert!(!result.is_error, "{:?}", result.structured_content);
    result.structured_content.unwrap()
}

fn error_code(result: ToolCallResult) -> String {
    assert!(result.is_error, "{:?}", result.structured_content);
    result.structured_content.unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn apps_are_listed_and_described_like_the_space_tree_and_description_tab_show_them() {
    let fixture = fixture();
    let before = snapshot(&fixture.project);
    let host = StandaloneHost::new("test");
    let target = target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let listed = structured(call("list_apps", json!({})).await);
    assert_eq!(
        listed,
        json!({ "apps": [
            { "ownerPath": ".", "runtimeType": "url", "valid": true, "diagnosticCount": 0, "hasReadme": true },
            { "ownerPath": "board", "runtimeType": "url", "valid": true, "diagnosticCount": 0, "hasReadme": true },
            { "ownerPath": "board/panel", "runtimeType": "url", "valid": true, "diagnosticCount": 0, "hasReadme": false },
            { "ownerPath": "guide", "runtimeType": "static", "valid": true, "diagnosticCount": 0, "hasReadme": true },
            { "ownerPath": "long", "runtimeType": "url", "valid": true, "diagnosticCount": 0, "hasReadme": true },
            { "ownerPath": "tasks", "runtimeType": "process", "valid": true, "diagnosticCount": 0, "hasReadme": true },
        ] })
    );
    let child = structured(call("list_apps", json!({ "spaceId": "child" })).await);
    assert_eq!(child["apps"][0]["ownerPath"], ".");
    assert_eq!(child["apps"].as_array().unwrap().len(), 1);

    // README with another name case, read like any Markdown source.
    let board = structured(call("get_app", json!({ "ownerPath": "board" })).await);
    assert_eq!(board["runtimeType"], "url");
    assert_eq!(board["url"], "https://example.com/tool");
    assert_eq!(board["diagnostics"], json!([]));
    assert_eq!(board["readme"]["path"], "board/readme.md");
    assert_eq!(
        board["readme"]["body"],
        "## For agents\n\nUse `board.json`.\n"
    );
    assert_eq!(board["readme"]["truncated"], false);
    assert_eq!(board["readme"]["diagnostic"], Value::Null);

    // A missing README is an empty field, not an error.
    let panel = structured(call("get_app", json!({ "ownerPath": "board/panel" })).await);
    assert_eq!(panel["readme"], Value::Null);

    // The Space root, a Page and a Collection: their owner README, which the
    // existing reader of that source returns in full.
    let root = structured(call("get_app", json!({ "ownerPath": "." })).await);
    let space_readme = structured(call("read_space_readme", json!({})).await);
    assert_eq!(root["readme"]["path"], "README.md");
    assert_eq!(root["readme"]["body"], space_readme["spaceReadme"]["body"]);
    assert_eq!(root["readme"]["meta"]["title"], "Project");

    let guide = structured(call("get_app", json!({ "ownerPath": "guide" })).await);
    assert_eq!(guide["runtimeType"], "static");
    assert_eq!(guide["url"], Value::Null);
    assert_eq!(guide["readme"]["body"], "Page App guide\n");

    let tasks = structured(call("get_app", json!({ "ownerPath": "tasks" })).await);
    let tasks_readme = structured(
        call(
            "read_collection_readme",
            json!({ "collectionPath": "tasks" }),
        )
        .await,
    );
    assert_eq!(tasks["url"], "http://127.0.0.1:3210");
    assert_eq!(
        tasks["readme"]["body"],
        tasks_readme["collectionReadme"]["body"]
    );
    // Variables are never resolved: the description carries no environment.
    assert!(!tasks.to_string().contains("API_TOKEN"));

    // A long README is cut; its full text comes from the same path.
    let long = structured(call("get_app", json!({ "ownerPath": "long" })).await);
    let cut = long["readme"]["body"].as_str().unwrap();
    assert_eq!(long["readme"]["truncated"], true);
    assert_eq!(cut.len(), APP_README_TEXT_LIMIT_BYTES);
    assert!(fixture.long_body.starts_with(cut));
    let full = structured(call("read_page", json!({ "path": "long/README.md" })).await);
    assert_eq!(full["page"]["body"], fixture.long_body);

    // The App host opens an owner the tree hides.
    let generated = structured(call("get_app", json!({ "ownerPath": "generated" })).await);
    assert_eq!(generated["runtimeType"], "url");

    assert_eq!(
        error_code(call("get_app", json!({ "ownerPath": "notes" })).await),
        "NOT_AN_APP"
    );
    assert_eq!(
        error_code(call("get_app", json!({ "ownerPath": "missing" })).await),
        "FILE_NOT_FOUND"
    );
    assert_eq!(
        error_code(call("get_app", json!({ "ownerPath": "child" })).await),
        "PATH_NOT_ACCESSIBLE"
    );
    assert_eq!(
        error_code(call("get_app", json!({ "ownerPath": "../outside" })).await),
        "PATH_NOT_ACCESSIBLE"
    );
    assert_eq!(
        error_code(call_tool(&host, None, "list_apps", json!({})).await),
        "NO_ACTIVE_PROJECT"
    );

    // Reads only: no file appeared, changed or vanished.
    host.close().await;
    let mut after = snapshot(&fixture.project);
    after.retain(|path, _| {
        let path = path
            .strip_prefix(&fixture.project)
            .unwrap()
            .to_string_lossy();
        !path.starts_with(".svode/index.db") && path != ".svode/write.lock"
    });
    assert_eq!(after, before);
}
