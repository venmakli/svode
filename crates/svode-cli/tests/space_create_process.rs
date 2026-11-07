//! `svode space create` through the real binary (Stage 11 05): the JSON
//! result without the envelope is the `structuredContent` of
//! `create_space`, the files equal those of the creation the desktop app
//! command runs on the same fixture, nothing is committed, and an affected
//! repository without access evidence refuses before any write.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::process::{code, json, snapshot, svode};
use serde_json::{Value, json};
use svode_core::project::scaffold::{self, Storage};
use svode_core::project::space::{self, SpaceCreate};
use svode_core::storage::config::SpaceGitType;
use svode_tools::dispatch::call_tool;
use svode_tools::host::{RequestTarget, ToolHost};
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
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// A committed Project repository scaffolded like one of the desktop app.
fn project(temp: &Path, name: &str) -> PathBuf {
    let project = temp.join(name);
    fs::create_dir_all(&project).unwrap();
    scaffold::scaffold(&project, "Project", "", "", Storage::Own).unwrap();
    let hooks = temp.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    git(&project, &["init", "-q", "-b", "main"]);
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
    project
}

fn target(project: &Path) -> RequestTarget {
    let path = project.to_string_lossy().to_string();
    RequestTarget {
        project_path: path.clone(),
        default_space_id: None,
        default_space_path: path,
        routine_caller: None,
    }
}

/// Working tree files of a Project, with the Space id replaced, the Git
/// directories left out and the submodule entries of the Project
/// repository config added, its own path replaced.
fn files(project: &Path, id: &str) -> BTreeMap<PathBuf, String> {
    let mut files = snapshot(project)
        .into_iter()
        .filter(|(path, _)| {
            !path.components().any(|part| part.as_os_str() == ".git")
                && !path.ends_with("write.lock")
        })
        .map(|(path, bytes)| (path, String::from_utf8_lossy(&bytes).replace(id, "<id>")))
        .collect::<BTreeMap<_, _>>();
    let submodules = Command::new("git")
        .args(["config", "--local", "--get-regexp", "^submodule\\."])
        .current_dir(project)
        .output()
        .unwrap();
    files.insert(
        PathBuf::from("<.git/config submodules>"),
        String::from_utf8_lossy(&submodules.stdout).replace(project.to_str().unwrap(), "<project>"),
    );
    files
}

fn without_envelope(mut value: Value) -> Value {
    let object = value.as_object_mut().unwrap();
    for key in ["schemaVersion", "ok", "target"] {
        object.remove(key);
    }
    value
}

fn with_id(mut value: Value, id: &str) -> Value {
    value["space"]["id"] = json!(id);
    value
}

#[tokio::test]
async fn the_command_result_is_the_capability_result_and_its_files_are_those_of_the_desktop_creation()
 {
    if !has_git() {
        return;
    }
    for (folder, git_type, kind) in [
        ("notes", "inline", SpaceGitType::Inline),
        ("clients", "independent", SpaceGitType::Independent),
        ("code", "submodule", SpaceGitType::Submodule),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let temp = temp.path().canonicalize().unwrap();
        let by_cli = project(&temp, "cli");
        let by_tool = project(&temp, "tool");
        let by_desktop = project(&temp, "desktop");
        let base = git(&by_cli, &["rev-parse", "HEAD"]);

        let (exit, value) = json(
            &by_cli,
            &[
                "space",
                "create",
                folder,
                "--name",
                "Space",
                "--git-type",
                git_type,
                "--icon",
                "📁",
            ],
            None,
        );
        assert_eq!(exit, 0, "{value}");
        assert_eq!(value["ok"], true);
        assert_eq!(value["target"]["projectPath"], by_cli.to_str().unwrap());
        assert_eq!(value["target"]["folder"], folder);
        let id = value["space"]["id"].as_str().unwrap().to_string();
        assert_eq!(git(&by_cli, &["rev-parse", "HEAD"]), base, "no commit");

        // The same capability in process: the result `svode-mcp` serves.
        let host = StandaloneHost::new("test");
        let result = call_tool(
            &host,
            Some(&target(&by_tool)),
            "create_space",
            json!({ "name": "Space", "folder": folder, "gitType": git_type, "icon": "📁" }),
        )
        .await;
        assert!(!result.is_error, "{:?}", result.structured_content);
        let structured = result.structured_content.unwrap();
        let tool_id = structured["space"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            with_id(without_envelope(value), "<id>"),
            with_id(structured, "<id>"),
            "{git_type}"
        );

        // The operation the desktop app command runs, on the same fixture.
        let desktop = space::create(
            host.read_runtime().git,
            &host,
            SpaceCreate {
                project: by_desktop.clone(),
                name: "Space".into(),
                folder: folder.into(),
                git_type: kind,
                icon: Some("📁".into()),
                description: None,
            },
        )
        .await
        .unwrap();
        let cli_files = files(&by_cli, &id);
        assert_eq!(cli_files, files(&by_tool, &tool_id), "{git_type}");
        assert_eq!(cli_files, files(&by_desktop, &desktop.id), "{git_type}");
        assert!(cli_files.contains_key(&PathBuf::from(folder).join("README.md")));
    }
}

#[test]
fn an_affected_repository_without_access_evidence_refuses_before_any_write() {
    if !has_git() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let temp = temp.path().canonicalize().unwrap();
    let project = project(&temp, "project");
    git(
        &project,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/team/notes.git",
        ],
    );
    let before = snapshot(&project);

    let (exit, value) = json(
        &project,
        &["space", "create", "clients", "--name", "Clients"],
        None,
    );
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "REPOSITORY_ACCESS_DENIED");
    assert!(
        value["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("svode git access verify")
    );
    let mut after = snapshot(&project);
    after.retain(|path, _| !path.ends_with("write.lock"));
    assert_eq!(after, before);
}

#[test]
fn human_output_names_who_commits_and_help_shows_an_example() {
    if !has_git() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let temp = temp.path().canonicalize().unwrap();
    let project = project(&temp, "project");
    let output = svode(
        &project,
        &[
            "space",
            "create",
            "clients",
            "--name",
            "Clients",
            "--git-type",
            "independent",
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.starts_with("Created independent space clients (Clients)."),
        "{stdout}"
    );
    assert!(stdout.contains("manual commit"), "{stdout}");
    assert!(stdout.contains("repository .: commit manual"), "{stdout}");
    assert!(
        stdout.contains("repository clients (new): commit manual"),
        "{stdout}"
    );
    assert!(
        stdout.contains("settings Svode Desktop → Settings → Git / Storage"),
        "{stdout}"
    );
    assert!(stdout.contains("clients/README.md"), "{stdout}");

    let help = svode(&project, &["space", "create", "--help"]);
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.contains("Example"), "{help}");
    assert!(help.contains(
        "svode --project ~/Notes space create clients --name Clients --git-type independent"
    ));
    assert!(help.contains("does not commit"), "{help}");
    assert!(help.contains("Settings → Git / Storage"), "{help}");

    // A taken folder is refused with its stable code.
    let (exit, value) = json(
        &project,
        &["space", "create", "clients", "--name", "Again"],
        None,
    );
    assert_eq!(exit, 1);
    assert_eq!(code(&value), "FILE_ALREADY_EXISTS");
}
