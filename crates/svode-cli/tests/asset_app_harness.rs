//! Managed asset import and App manifest validation of the `svode` frame on
//! a harness host with the runtime of an open Project. It proves the command
//! mapping and the shared import effects; `asset_app_process` runs them on
//! the standalone host of the real binary.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use common::harness::{Access, WriteHost, git, has_git, human, ok, svode, write};
use serde_json::{Value, json};
use svode_core::index::resolver::SpaceStatus;

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
    /// Directory outside the Project holding import sources.
    sources: PathBuf,
}

fn fixture(assets: Value) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let project = base.join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "assets": assets,
            "spaces": [{ "id": "child", "path": "child", "repo": null }]
        })
        .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child" }).to_string(),
    );
    for (path, source) in [
        ("README.md", "---\ntitle: Project\n---\n"),
        ("leaf.md", "---\ntitle: Leaf\n---\nLeaf body\n"),
        ("notes.md", "---\ntitle: Notes\n---\n[Leaf](leaf.md)\n"),
        ("solo/README.md", "---\ntitle: Solo\n---\n"),
        (
            "tasks/schema.yaml",
            "columns: []\nviews:\n  - type: table\n    name: Table\n",
        ),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
        ("tasks/alpha.md", "---\ntitle: Alpha\n---\n"),
        ("child/README.md", "---\ntitle: Child\n---\n"),
        ("child/brief.md", "---\ntitle: Brief\n---\n"),
    ] {
        write(&project.join(path), source);
    }
    if has_git() {
        git(&project, &["init", "-q"]);
        git(&project, &["config", "user.email", "agent@example.com"]);
        git(&project, &["config", "user.name", "Agent"]);
        git(&project, &["config", "maintenance.auto", "false"]);
        git(&project, &["add", "-A"]);
        git(&project, &["commit", "-q", "-m", "fixture"]);
    }
    let sources = base.join("sources");
    write(&sources.join("photo.png"), "image");
    write(&sources.join("report.pdf"), "%PDF-1.4");
    write(&sources.join("script.exe"), "binary");
    fs::create_dir_all(sources.join("folder")).unwrap();
    Fixture {
        _temp: temp,
        project,
        sources,
    }
}

fn source(fixture: &Fixture, name: &str) -> String {
    fixture.sources.join(name).to_string_lossy().to_string()
}

/// Every file of the Project except the index the host runtime opens.
fn sources(project: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = common::process::snapshot(project);
    // The derived index and the device-local write lock are not sources.
    files.retain(|path, _| {
        let path = path.to_string_lossy();
        !path.starts_with(".svode/index.db") && path != ".svode/write.lock"
    });
    files
}

fn changed(value: &Value) -> BTreeSet<String> {
    value["changedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect()
}

fn error(exit: i32, value: &Value) -> &str {
    assert_eq!(exit, 1, "{value}");
    assert_eq!(value["ok"], false, "{value}");
    value["error"]["code"].as_str().unwrap()
}

#[tokio::test]
async fn every_asset_and_app_capability_has_exactly_one_command() {
    let fixture = fixture(json!({ "strategy": "in-git" }));
    write(
        &fixture.sources.join("app.yaml"),
        "runtime:\n  type: url\n  url: https://example.com/tool\n",
    );
    let host = WriteHost::new(Access::Grant);
    let photo = source(&fixture, "photo.png");
    let manifest = source(&fixture, "app.yaml");
    for (args, tool) in [
        (
            vec!["asset", "import", "--path", "notes.md", "--file", &photo],
            "import_asset",
        ),
        (
            vec!["app", "validate", "--file", &manifest],
            "validate_app_manifest",
        ),
    ] {
        let (exit, value) = svode(&host, &fixture.project, &args).await;
        ok(exit, &value);
        assert_eq!(
            host.take_asked(),
            BTreeSet::from([tool.to_string()]),
            "{args:?}"
        );
    }
}

#[tokio::test]
async fn asset_import_returns_canonical_paths_and_keeps_the_source() {
    let fixture = fixture(json!({ "strategy": "in-git" }));
    let project = &fixture.project;
    let host = WriteHost::new(Access::Grant);
    let head = has_git().then(|| git(project, &["rev-parse", "HEAD"]));
    // The open Project runtime knows its ready child Space.
    host.index
        .upsert_space(
            project,
            "child",
            "child",
            SpaceStatus::Ready,
            Some("Child".to_string()),
        )
        .await;

    // A leaf Page becomes directory-backed; a relative --file is read from
    // the current directory.
    let (exit, leaf) = svode(
        &host,
        &fixture.sources,
        &[
            "--project",
            project.to_str().unwrap(),
            "asset",
            "import",
            "--path",
            "leaf.md",
            "--file",
            "photo.png",
        ],
    )
    .await;
    ok(exit, &leaf);
    assert_eq!(leaf["target"]["path"], "leaf.md");
    assert_eq!(leaf["target"]["spaceId"], "root");
    assert_eq!(leaf["spaceId"], "root");
    assert_eq!(leaf["contentPath"], "leaf/README.md");
    assert_eq!(leaf["fileName"], "photo.png");
    assert_eq!(leaf["mime"], "image/png");
    assert_eq!(leaf["sizeBytes"], 5);
    let attachment = leaf["attachmentPath"].as_str().unwrap();
    assert_eq!(fs::read(project.join(attachment)).unwrap(), b"image");
    assert_eq!(leaf["coverPath"], attachment);
    assert!(leaf["markdownUrl"].as_str().unwrap().ends_with("photo.png"));
    assert!(!project.join("leaf.md").exists());
    assert!(project.join("leaf/README.md").is_file());
    let paths = changed(&leaf);
    assert!(paths.contains(attachment), "{paths:?}");
    assert!(paths.contains("leaf/README.md"), "{paths:?}");
    // The link to the converted Page is rewritten by the managed transition.
    assert!(
        fs::read_to_string(project.join("notes.md"))
            .unwrap()
            .contains("leaf/README.md")
    );
    let deliveries = host.deliveries.lock().unwrap().clone();
    assert_eq!(deliveries.len(), 1);
    assert!(deliveries[0].converted_page);
    assert!(
        fixture.sources.join("photo.png").is_file(),
        "copied, not moved"
    );

    // The canonical contentPath addresses the next import; --name names the
    // copy. Collection items, owner READMEs and child Spaces are owners too.
    let (exit, named) = svode(
        &host,
        project,
        &[
            "asset",
            "import",
            "--path",
            "leaf/README.md",
            "--file",
            &source(&fixture, "report.pdf"),
            "--name",
            "Q3 report.pdf",
        ],
    )
    .await;
    ok(exit, &named);
    assert_eq!(named["contentPath"], "leaf/README.md");
    assert_eq!(named["fileName"], "Q3 report.pdf");
    assert_eq!(named["coverPath"], "leaf/Q3 report.pdf");
    assert!(
        project
            .join(named["attachmentPath"].as_str().unwrap())
            .is_file()
    );

    for (args, content) in [
        (vec!["--path", "tasks/alpha.md"], "tasks/alpha/README.md"),
        (vec!["--path", "tasks/README.md"], "tasks/README.md"),
        (vec!["--path", "solo/README.md"], "solo/README.md"),
        (
            vec!["--path", "brief.md", "--space", "child"],
            "brief/README.md",
        ),
    ] {
        let mut command = vec!["asset", "import"];
        command.extend(args.iter().copied());
        let photo = source(&fixture, "photo.png");
        command.extend(["--file", &photo]);
        let (exit, value) = svode(&host, project, &command).await;
        ok(exit, &value);
        assert_eq!(value["contentPath"], content, "{args:?}");
    }
    let (exit, child) = svode(
        &host,
        &project.join("child"),
        &[
            "asset",
            "import",
            "--path",
            "README.md",
            "--file",
            &source(&fixture, "photo.png"),
        ],
    )
    .await;
    ok(exit, &child);
    assert_eq!(child["target"]["spaceId"], "child");
    let attachment = child["attachmentPath"].as_str().unwrap();
    assert!(project.join("child").join(attachment).is_file(), "{child}");
    assert!(!project.join(attachment).exists(), "not in the root Space");

    // Human output: summary, canonical paths, then the changed paths.
    let rendered = human(
        &host,
        project,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            &source(&fixture, "photo.png"),
        ],
    )
    .await;
    assert_eq!(rendered.exit, 0, "{rendered:?}");
    let lines = rendered.stdout.lines().collect::<Vec<_>>();
    assert!(lines[0].starts_with("Imported asset"), "{lines:?}");
    assert!(lines.contains(&"contentPath notes/README.md"), "{lines:?}");
    assert!(lines.iter().any(|line| line.starts_with("markdownUrl ")));
    assert!(lines.iter().any(|line| line.starts_with("coverPath ")));

    // No implicit commit.
    if let Some(head) = head {
        assert_eq!(git(project, &["rev-parse", "HEAD"]), head);
    }
}

#[tokio::test]
async fn asset_import_follows_the_routing_of_its_space() {
    let local = fixture(json!({ "strategy": "local" }));
    let host = WriteHost::new(Access::Grant);
    let (exit, value) = svode(
        &host,
        &local.project,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            &source(&local, "photo.png"),
        ],
    )
    .await;
    ok(exit, &value);
    let attachment = value["attachmentPath"].as_str().unwrap();
    let gitignore = fs::read_to_string(local.project.join(".gitignore")).unwrap();
    assert!(gitignore.contains("photo.png"), "{gitignore}");
    assert!(changed(&value).contains(".gitignore"), "{value}");
    assert!(local.project.join(attachment).is_file());

    // A Git LFS route that is not ready refuses before the first write.
    let lfs = fixture(json!({
        "strategy": "lfs-remote",
        "binaryRouting": { "version": 1, "lfsExtensions": ["png"] }
    }));
    let not_ready = WriteHost::with_lfs(false);
    let before = sources(&lfs.project);
    let (exit, refused) = svode(
        &not_ready,
        &lfs.project,
        &[
            "asset",
            "import",
            "--path",
            "leaf.md",
            "--file",
            &source(&lfs, "photo.png"),
        ],
    )
    .await;
    error(exit, &refused);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Git LFS route is not ready"),
        "{refused}"
    );
    assert_eq!(refused["error"]["target"]["path"], "leaf.md");
    assert_eq!(not_ready.lfs_probes.lock().unwrap().len(), 1);
    assert_eq!(sources(&lfs.project), before);
    assert!(not_ready.deliveries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn asset_import_rejects_paths_sources_and_denied_repositories_without_writes() {
    let fixture = fixture(json!({ "strategy": "in-git" }));
    let project = &fixture.project;
    let host = WriteHost::new(Access::Grant);
    let before = sources(project);
    let photo = source(&fixture, "photo.png");
    for (path, file, expected) in [
        ("../outside.md", photo.as_str(), "INVALID_PATH"),
        ("/etc/hosts.md", photo.as_str(), "INVALID_PATH"),
        (".git/config.md", photo.as_str(), "PATH_FORBIDDEN"),
        (".svode/notes.md", photo.as_str(), "PATH_FORBIDDEN"),
        ("missing.md", photo.as_str(), "PATH_NOT_ACCESSIBLE"),
        ("tasks/schema.yaml", photo.as_str(), "INVALID_PATH"),
        ("notes.md", "absent.png", "PATH_NOT_ACCESSIBLE"),
        ("notes.md", "folder", "PATH_NOT_ACCESSIBLE"),
    ] {
        let (exit, value) = svode(
            &host,
            &fixture.sources,
            &[
                "--project",
                project.to_str().unwrap(),
                "asset",
                "import",
                "--path",
                path,
                "--file",
                file,
            ],
        )
        .await;
        assert_eq!(error(exit, &value), expected, "{path} {file}: {value}");
        assert_eq!(value["error"]["target"]["path"], path);
    }
    let (exit, unsupported) = svode(
        &host,
        project,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            &source(&fixture, "script.exe"),
        ],
    )
    .await;
    assert!(
        unsupported["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unsupported attachment format"),
        "{unsupported}"
    );
    error(exit, &unsupported);
    assert_eq!(sources(project), before);

    let denied = WriteHost::new(Access::Deny);
    let (exit, value) = svode(
        &denied,
        project,
        &["asset", "import", "--path", "leaf.md", "--file", &photo],
    )
    .await;
    assert_eq!(error(exit, &value), "REPOSITORY_ACCESS_DENIED");
    assert_eq!(sources(project), before);
    assert!(denied.deliveries.lock().unwrap().is_empty());
    assert!(
        denied
            .authorized
            .lock()
            .unwrap()
            .iter()
            .all(|repository| repository == project)
    );
    assert!(host.deliveries.lock().unwrap().is_empty());
}
