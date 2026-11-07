//! `svode project create` through the real binary outside any Project
//! (Stage 11 05): a Project-free command with a path relative to the
//! current directory, registered in the project list of the device, whose
//! JSON result without the envelope is the `structuredContent` of
//! `create_project`; later commands address the new Project from its
//! folder; existing and nested Projects, and an existing repository with a
//! remote whose write access is not verified, are refused before any write.
//! The envelope target names the path normalized, like the result.

#![cfg(unix)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::process::{BIN, TEST_IDENTIFIER, code, json_with, snapshot};
use serde_json::{Value, json};
use svode_core::project::registry;
use svode_tools::dispatch::call_tool;
use svode_tools::standalone::StandaloneHost;

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// A directory outside any Project with its own home, so the project list
/// of the device the commands register in is apart from the user's own.
struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    work: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let work = base.join("work");
        let home = base.join("home");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&home).unwrap();
        Self {
            _temp: temp,
            base,
            work,
            home,
        }
    }

    fn env(&self) -> Vec<(&'static str, String)> {
        vec![
            ("HOME", self.home.to_string_lossy().to_string()),
            (
                "XDG_CONFIG_HOME",
                self.home.join(".config").to_string_lossy().to_string(),
            ),
        ]
    }

    fn json(&self, cwd: &Path, args: &[&str]) -> (i32, Value) {
        let env = self.env();
        let env = env
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect::<Vec<_>>();
        json_with(cwd, args, None, &env)
    }

    fn human(&self, cwd: &Path, args: &[&str]) -> (i32, String) {
        let output = Command::new(BIN)
            .args(args)
            .current_dir(cwd)
            .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
            .envs(self.env())
            .output()
            .unwrap();
        (
            output.status.code().unwrap(),
            String::from_utf8(output.stdout).unwrap(),
        )
    }

    /// The config directory of the device as the desktop app resolves it
    /// under this home.
    fn device(&self) -> PathBuf {
        let config = if cfg!(target_os = "macos") {
            self.home.join("Library/Application Support")
        } else {
            self.home.join(".config")
        };
        config.join(TEST_IDENTIFIER)
    }

    fn registered(&self) -> Vec<(String, String)> {
        if !registry::file(&self.device()).exists() {
            return Vec::new();
        }
        registry::read(&self.device())
            .unwrap()
            .spaces
            .into_iter()
            .map(|entry| (entry.id, entry.path))
            .collect()
    }
}

/// A result with its id, its folder and the initial branch, which follows
/// the Git config of the user, replaced.
fn comparable(mut value: Value, folder: &Path) -> Value {
    let id = value["project"]["id"].as_str().unwrap().to_string();
    value["repositories"][0]["initialBranch"] = Value::Null;
    let text = value
        .to_string()
        .replace(&id, "<id>")
        .replace(folder.to_str().unwrap(), "<folder>");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn a_project_created_outside_a_project_is_registered_and_later_commands_address_it() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new();
    let (exit, value) = fixture.json(
        &fixture.work,
        &["project", "create", "./acme", "--name", "Acme"],
    );
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["ok"], true);
    let acme = fixture.work.join("acme");
    let path = acme.to_string_lossy().to_string();
    assert_eq!(value["project"]["path"], path);
    assert_eq!(
        value["target"]["path"], path,
        "the target names it normalized"
    );
    assert_eq!(value["project"]["name"], "Acme");
    assert_eq!(value["session"]["addressing"], "per_command");
    assert!(
        value["session"]["hint"]
            .as_str()
            .unwrap()
            .contains(&format!("--project {path}")),
        "{value}"
    );
    let id = value["project"]["id"].as_str().unwrap().to_string();
    assert_eq!(fixture.registered(), [(id, path.clone())]);
    assert!(acme.join(".svode/config.json").is_file());
    assert!(
        !Command::new("git")
            .args(["rev-parse", "--verify", "HEAD"])
            .current_dir(&acme)
            .output()
            .unwrap()
            .status
            .success(),
        "the creation commits nothing"
    );

    // The JSON result without the envelope is the shared result of the
    // capability on the same input.
    let twin = fixture.base.join("twin");
    fs::create_dir_all(&twin).unwrap();
    let host = StandaloneHost::new("test").with_project_list_dir(twin.join("device"));
    let shared = call_tool(
        &host,
        None,
        "create_project",
        json!({ "path": twin.join("acme"), "name": "Acme" }),
    )
    .await
    .structured_content
    .unwrap();
    let mut own = value.clone();
    for key in ["schemaVersion", "ok", "target"] {
        own.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        comparable(own, &acme),
        comparable(shared, &twin.join("acme"))
    );

    // Later commands address the new Project from its folder or by
    // `--project`.
    let (exit, listed) = fixture.json(&acme, &["page", "list"]);
    assert_eq!(exit, 0, "{listed}");
    assert_eq!(listed["target"]["projectPath"], path);
    let (exit, info) = fixture.json(&fixture.work, &["--project", "acme", "project", "info"]);
    assert_eq!(exit, 0, "{info}");
    assert_eq!(info["projectName"], "Acme");

    let (exit, human) = fixture.human(&fixture.work, &["project", "create", "other"]);
    assert_eq!(exit, 0, "{human}");
    assert!(human.starts_with("Created project other at "), "{human}");
    for line in [
        "projectId ",
        &format!("path {}", fixture.work.join("other").display()),
        "repository . (new): commit manual",
        "next Each svode command addresses the project of its directory",
        "settings Svode Desktop → Settings → Git / Storage",
        ".svode/config.json",
    ] {
        assert!(human.contains(line), "{line}: {human}");
    }
    assert_eq!(fixture.registered().len(), 2);
}

#[test]
fn an_existing_or_nested_project_is_refused_before_any_write() {
    let fixture = Fixture::new();
    let (exit, value) = fixture.json(&fixture.work, &["project", "create", "acme"]);
    assert_eq!(exit, 0, "{value}");
    let acme = fixture.work.join("acme");
    let before = snapshot(&fixture.base);
    let registered = fixture.registered();

    let (exit, taken) = fixture.json(&fixture.work, &["project", "create", "acme"]);
    assert_eq!(exit, 1, "{taken}");
    assert_eq!(code(&taken), "PROJECT_ALREADY_EXISTS");

    let (exit, nested) = fixture.json(&acme, &["project", "create", "./docs/notes"]);
    assert_eq!(exit, 1, "{nested}");
    assert_eq!(code(&nested), "PROJECT_NESTED");
    assert_eq!(nested["error"]["project"], acme.to_string_lossy().as_ref());
    assert!(
        nested["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("svode space create"),
        "{nested}"
    );
    assert_eq!(
        nested["error"]["target"]["path"],
        acme.join("docs/notes").to_string_lossy().as_ref()
    );

    assert_eq!(snapshot(&fixture.base), before);
    assert_eq!(fixture.registered(), registered);
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
}

/// The current behavior for an existing repository with a remote and no
/// access evidence on the device: the Stage 9 mutation policy refuses it,
/// and since `git access verify` needs a Project, the hint names the step
/// that is reachable: Open folder in the desktop app, or the user.
#[test]
fn an_existing_repository_with_an_unverified_remote_is_refused_with_a_reachable_hint() {
    if !has_git() {
        return;
    }
    let fixture = Fixture::new();
    let code_dir = fixture.work.join("code");
    let remote = fixture.base.join("remote.git");
    fs::create_dir_all(&code_dir).unwrap();
    git(
        &fixture.base,
        &["init", "-q", "--bare", remote.to_str().unwrap()],
    );
    git(&code_dir, &["init", "-q"]);
    git(&code_dir, &["config", "user.email", "agent@example.com"]);
    git(&code_dir, &["config", "user.name", "Agent"]);
    git(&code_dir, &["config", "commit.gpgsign", "false"]);
    fs::write(code_dir.join("main.rs"), "fn main() {}\n").unwrap();
    git(&code_dir, &["add", "-A"]);
    git(&code_dir, &["commit", "-qm", "Code"]);
    git(
        &code_dir,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&code_dir, &["push", "-q", "-u", "origin", "HEAD"]);
    let before = snapshot(&fixture.base);

    let (exit, refused) = fixture.json(&fixture.work, &["project", "create", "code"]);
    assert_eq!(exit, 1, "{refused}");
    assert_eq!(code(&refused), "REPOSITORY_ACCESS_DENIED");
    let error = &refused["error"];
    assert_eq!(error["status"], "unknown", "{error}");
    assert_eq!(error["reason"], "not_checked", "{error}");
    assert_eq!(
        error["hint"],
        "Write access to this Git repository is not verified on this device. Create the project in Svode Desktop with Open folder, which creates and registers it there, or ask the user."
    );

    assert_eq!(snapshot(&fixture.base), before);
    assert!(fixture.registered().is_empty());
}
