//! Routine definition commands of the `svode` frame on a harness host with
//! the Routine stores of an open Project. It proves the command mapping,
//! owner resolution, strict candidate, fingerprint CAS and acknowledgement
//! of the shared operation; `routine_families_process` runs the same
//! commands on the standalone host of the real binary.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use common::harness::{Access, WriteHost, git, has_git, human, ok, svode, write};
use serde_json::{Value, json};
use svode_tools::catalog;

const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
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
        &project.join(".svode/agent-actors.json"),
        &json!({
            "schemaVersion": 1,
            "actors": [{ "id": ACTOR, "name": "Reviewer", "adapters": [{ "adapter": "codex" }] }]
        })
        .to_string(),
    );
    for (path, source) in [
        ("README.md", "---\ntitle: Project\n---\n"),
        (
            "tasks/schema.yaml",
            "columns:\n  - name: reviewed\n    type: checkbox\nviews:\n  - type: table\n    name: Table\n",
        ),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
        ("tasks/alpha.md", "---\ntitle: Alpha\n---\n"),
        ("child/README.md", "---\ntitle: Child\n---\n"),
        ("child/notes/today.md", "---\ntitle: Today\n---\n"),
    ] {
        write(&project.join(path), source);
    }
    git(&project, &["init", "-q"]);
    git(&project, &["config", "user.email", "agent@example.com"]);
    git(&project, &["config", "user.name", "Agent"]);
    git(&project, &["config", "maintenance.auto", "false"]);
    git(&project, &["add", "-A"]);
    git(&project, &["commit", "-q", "-m", "fixture"]);
    Fixture {
        _temp: temp,
        project,
    }
}

fn definition(name: &str, enabled: bool) -> Value {
    json!({
        "name": name,
        "enabled": enabled,
        "trigger": { "type": "event", "event": "collection.entry_created" },
        "action": {
            "type": "update_properties",
            "target": "trigger.entry",
            "set": { "reviewed": true }
        },
        "body": "Managed by Svode."
    })
}

fn manual(name: &str) -> Value {
    json!({
        "name": name,
        "trigger": { "type": "manual" },
        "action": { "type": "run_agent", "executor": format!("agent:{ACTOR}") },
        "body": "Run by hand."
    })
}

/// Writes a definition file outside the Project and returns its path.
fn definition_file(fixture: &Fixture, name: &str, value: &Value) -> String {
    let path = fixture.project.parent().unwrap().join(name);
    fs::write(&path, value.to_string()).unwrap();
    path.to_string_lossy().to_string()
}

fn files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn error(exit: i32, value: &Value) -> &str {
    assert_eq!(exit, 1, "{value}");
    assert_eq!(value["ok"], false, "{value}");
    value["error"]["code"].as_str().unwrap()
}

fn head(project: &Path) -> String {
    git(project, &["rev-parse", "HEAD"])
}

#[tokio::test]
async fn every_routine_definition_capability_has_exactly_one_command() {
    if !has_git() {
        return;
    }
    let fixture = fixture();
    let host = WriteHost::new(Access::Grant);
    let file = definition_file(&fixture, "manual.json", &manual("Mapped"));
    let mut published = BTreeSet::new();
    for (args, tool) in [
        (vec!["routine", "list"], "list_routines"),
        (
            vec!["routine", "get", "--id", "routine:none"],
            "get_routine",
        ),
        (
            vec!["routine", "create", "--definition-file", &file],
            "create_routine",
        ),
        (
            vec![
                "routine",
                "update",
                "--id",
                "routine:none",
                "--fingerprint",
                "f",
                "--definition-file",
                &file,
            ],
            "update_routine",
        ),
        (
            vec![
                "routine",
                "delete",
                "--id",
                "routine:none",
                "--fingerprint",
                "f",
            ],
            "delete_routine",
        ),
    ] {
        svode(&host, &fixture.project, &args).await;
        assert_eq!(
            host.take_asked(),
            BTreeSet::from([tool.to_string()]),
            "{args:?}"
        );
        assert!(published.insert(tool), "{tool} has two commands");
    }

    // The family is every Routine definition capability; `run_routine`
    // stays outside the CLI until G04.
    let family = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .filter(|name| name.contains("routine") && *name != "run_routine")
        .collect::<BTreeSet<_>>();
    assert_eq!(published, family);
}

#[tokio::test]
async fn routine_definitions_keep_the_shared_owner_candidate_cas_and_acknowledgement() {
    if !has_git() {
        return;
    }
    let fixture = fixture();
    let project = &fixture.project;
    let host = WriteHost::new(Access::Grant);
    let before = head(project);
    let routines = project.join("tasks/.routines");

    let (exit, empty) = svode(
        &host,
        project,
        &["routine", "list", "--collection", "tasks"],
    )
    .await;
    ok(exit, &empty);
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["owner"]["ownerPath"], "tasks");
    assert_eq!(empty["target"]["collection"], "tasks");
    assert_eq!(empty["target"]["spaceId"], "root");

    // Strict candidate: unknown fields and invalid definitions write nothing.
    let mut unknown = manual("Unknown");
    unknown["schedule"] = json!("daily");
    let unknown = definition_file(&fixture, "unknown.json", &unknown);
    let (exit, value) = svode(
        &host,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &unknown,
        ],
    )
    .await;
    // The shared decode rejects the candidate with its own code.
    assert_eq!(error(exit, &value), "SERIALIZATION_ERROR");
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown field definition.schedule"),
        "{value}"
    );
    let invalid = definition_file(
        &fixture,
        "invalid.json",
        &json!({
            "name": "Agent task",
            "trigger": { "type": "manual" },
            "action": { "type": "run_agent", "executor": "agent:01arz3ndektsv4rrffq69g5fax" },
            "body": "Do it."
        }),
    );
    let (exit, value) = svode(
        &host,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &invalid,
        ],
    )
    .await;
    assert_eq!(error(exit, &value), "ROUTINE_INVALID");

    // An enabled event Routine needs the acknowledgement.
    let enabled = definition_file(&fixture, "enabled.json", &definition("Keep review", true));
    let (exit, value) = svode(
        &host,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &enabled,
        ],
    )
    .await;
    assert_eq!(
        error(exit, &value),
        "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED"
    );
    assert_eq!(value["error"]["target"]["collection"], "tasks");
    assert!(files(&routines).is_empty());
    assert!(host.authorized.lock().unwrap().is_empty());

    let (exit, created) = svode(
        &host,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &enabled,
            "--confirm-automatic-execution",
        ],
    )
    .await;
    ok(exit, &created);
    assert_eq!(created["path"], "tasks/.routines/Keep review.md");
    assert_eq!(
        created["changedPaths"],
        json!(["tasks/.routines/Keep review.md"])
    );
    assert_eq!(created["detail"]["valid"], true);
    assert_eq!(created["detail"]["definition"]["enabled"], true);
    // Saving acknowledges automation but grants no device authority.
    assert_eq!(
        created["detail"]["automaticAuthorityEnabled"], false,
        "{created}"
    );
    assert_eq!(*host.authorized.lock().unwrap(), vec![project.clone()]);
    let id = created["routineId"].as_str().unwrap().to_string();
    let fingerprint = created["fingerprint"].as_str().unwrap().to_string();

    let (exit, duplicate) = svode(
        &host,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &enabled,
            "--confirm-automatic-execution",
        ],
    )
    .await;
    assert_eq!(error(exit, &duplicate), "ROUTINE_NAME_CONFLICT");

    let (exit, detail) = svode(
        &host,
        project,
        &["routine", "get", "--collection", "tasks", "--id", &id],
    )
    .await;
    ok(exit, &detail);
    assert_eq!(detail["fingerprint"], fingerprint.as_str());
    assert_eq!(detail["definition"]["body"], "Managed by Svode.");
    assert_eq!(detail["target"]["id"], id.as_str());
    let (exit, listed) = svode(
        &host,
        project,
        &["routine", "list", "--collection", "tasks"],
    )
    .await;
    ok(exit, &listed);
    assert_eq!(listed["total"], 1);
    assert!(listed["routines"][0].get("definition").is_none());
    let (exit, missing) = svode(
        &host,
        project,
        &[
            "routine",
            "get",
            "--collection",
            "tasks",
            "--id",
            "routine:none",
        ],
    )
    .await;
    assert_eq!(error(exit, &missing), "ROUTINE_NOT_FOUND");

    // Fingerprint CAS: a stale fingerprint fails with the current one and
    // writes nothing.
    let source = fs::read(routines.join("Keep review.md")).unwrap();
    let renamed = definition_file(&fixture, "renamed.json", &definition("Review", false));
    let (exit, stale) = svode(
        &host,
        project,
        &[
            "routine",
            "update",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            "stale",
            "--definition-file",
            &renamed,
        ],
    )
    .await;
    assert_eq!(error(exit, &stale), "ROUTINE_FINGERPRINT_CONFLICT");
    assert_eq!(stale["error"]["currentFingerprint"], fingerprint.as_str());
    assert_eq!(stale["error"]["target"]["id"], id.as_str());
    assert_eq!(fs::read(routines.join("Keep review.md")).unwrap(), source);

    let (exit, updated) = svode(
        &host,
        project,
        &[
            "routine",
            "update",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            &fingerprint,
            "--definition-file",
            &renamed,
        ],
    )
    .await;
    ok(exit, &updated);
    assert_eq!(
        updated["changedPaths"],
        json!([
            "tasks/.routines/Keep review.md",
            "tasks/.routines/Review.md"
        ])
    );
    assert_eq!(updated["routineId"], id.as_str());
    assert_eq!(files(&routines), vec!["Review.md".to_string()]);
    let fingerprint = updated["fingerprint"].as_str().unwrap().to_string();

    let (exit, stale) = svode(
        &host,
        project,
        &[
            "routine",
            "delete",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            "stale",
        ],
    )
    .await;
    assert_eq!(error(exit, &stale), "ROUTINE_FINGERPRINT_CONFLICT");
    assert_eq!(stale["error"]["currentFingerprint"], fingerprint.as_str());
    let rendered = human(
        &host,
        project,
        &[
            "routine",
            "delete",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            &fingerprint,
        ],
    )
    .await;
    assert_eq!(rendered.exit, 0, "{rendered:?}");
    assert!(
        rendered
            .stdout
            .ends_with(&format!("routineId {id}\ntasks/.routines/Review.md\n")),
        "{rendered:?}"
    );
    assert!(files(&routines).is_empty());

    // No implicit commit.
    assert_eq!(head(project), before);

    for (args, code) in [
        (
            vec!["routine", "list", "--collection", "tasks/.routines"],
            "PATH_FORBIDDEN",
        ),
        (
            vec!["routine", "list", "--collection", "../tasks"],
            "INVALID_PATH",
        ),
        (
            vec![
                "routine",
                "delete",
                "--id",
                " routine:x",
                "--fingerprint",
                "f",
            ],
            "INVALID_ROUTINE_ID",
        ),
        (
            vec![
                "routine",
                "delete",
                "--id",
                "routine:x",
                "--fingerprint",
                " ",
            ],
            "INVALID_ROUTINE_FINGERPRINT",
        ),
    ] {
        let (exit, value) = svode(&host, project, &args).await;
        assert_eq!(error(exit, &value), code, "{args:?}");
    }
}

#[tokio::test]
async fn routine_owner_is_the_resolved_space_or_its_collection() {
    if !has_git() {
        return;
    }
    let fixture = fixture();
    let project = &fixture.project;
    let host = WriteHost::new(Access::Grant);
    let file = definition_file(&fixture, "child.json", &manual("Child task"));

    // From a directory inside the child Space the owner is that Space, even
    // without --space; the resolved id reaches the shared operation.
    let (exit, created) = svode(
        &host,
        &project.join("child/notes"),
        &["routine", "create", "--definition-file", &file],
    )
    .await;
    ok(exit, &created);
    assert_eq!(created["target"]["spaceId"], "child");
    assert_eq!(created["owner"]["spaceId"], "child");
    assert_eq!(created["path"], ".routines/Child task.md");
    assert_eq!(
        files(&project.join("child/.routines")),
        vec!["Child task.md".to_string()]
    );
    assert!(files(&project.join(".routines")).is_empty());

    // An explicit --space wins over the current directory.
    let (exit, root) = svode(
        &host,
        &project.join("child/notes"),
        &["routine", "list", "--space", "root"],
    )
    .await;
    ok(exit, &root);
    assert_eq!(root["total"], 0);
    let (exit, child) = svode(&host, project, &["routine", "list", "--space", "child"]).await;
    ok(exit, &child);
    assert_eq!(child["total"], 1);
    // A Collection owner lists only its own Routines.
    let (exit, tasks) = svode(
        &host,
        project,
        &["routine", "list", "--collection", "tasks"],
    )
    .await;
    ok(exit, &tasks);
    assert_eq!(tasks["total"], 0);

    let rendered = human(&host, project, &["routine", "list", "--space", "child"]).await;
    let line = rendered.stdout.lines().next().unwrap().to_string();
    assert!(
        line.starts_with(created["routineId"].as_str().unwrap()),
        "{line}"
    );
    assert!(line.contains("\tChild task\t"), "{line}");
    assert!(
        line.contains("\tdisabled\t") || line.contains("\tenabled\t"),
        "{line}"
    );

    let denied = WriteHost::new(Access::Deny);
    let other = definition_file(&fixture, "other.json", &definition("Other", false));
    let (exit, value) = svode(
        &denied,
        project,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &other,
        ],
    )
    .await;
    assert_eq!(error(exit, &value), "REPOSITORY_ACCESS_DENIED");
    assert!(files(&project.join("tasks/.routines")).is_empty());
}
