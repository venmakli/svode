use std::fs;
use std::path::Path;
use std::process::Command;

use svode_core::page::dates::{SystemGitDateExecutor, derive_date_overrides};
use svode_core::page::{PageSource, PageSourceError, read_standalone_page, resolve_space_target};

async fn read(
    project: &Path,
    space_id: Option<&str>,
    path: &str,
) -> Result<PageSource, PageSourceError> {
    read_standalone_page(&resolve_space_target(project, space_id)?, path).await
}

fn project(root: &Path) {
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(root.join(".svode/config.json"), r#"{"name":"Project","spaces":[{"id":"inline","path":"inline","repo":null},{"id":"independent","path":"independent","repo":null}]}"#).unwrap();
    fs::create_dir(root.join("inline")).unwrap();
    fs::create_dir(root.join("independent")).unwrap();
}

fn git(root: &Path, args: &[&str], date: Option<&str>) {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(date) = date {
        command
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date);
    }
    assert!(command.output().unwrap().status.success(), "git {args:?}");
}

#[tokio::test]
async fn source_only_read_preserves_source_and_rejects_owners_and_escape() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    project(root);
    fs::write(root.join("valid.md"), "---\ntitle: Named\nid: custom\ncreated: custom-created\nupdated: custom-updated\n---\nBody\n").unwrap();
    fs::write(root.join("plain.md"), "Plain body").unwrap();
    fs::write(root.join("empty.md"), "").unwrap();
    fs::write(root.join("bad-encoding.md"), [0xff, 0xfe]).unwrap();
    fs::write(root.join("duplicate.md"), "---\ntitle: Named\n---\nOther").unwrap();
    fs::write(root.join("malformed.md"), "---\ntitle: [bad\n---\nBody").unwrap();
    fs::write(root.join("README.md"), "Owner").unwrap();
    fs::write(root.join("AGENTS.md"), "Instructions").unwrap();
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("folder/README.md"), "Folder body").unwrap();
    fs::create_dir(root.join("collection")).unwrap();
    fs::write(root.join("collection/schema.yaml"), "name: Collection").unwrap();
    fs::write(root.join("collection/item.md"), "Item").unwrap();
    fs::write(root.join("collection/README.md"), "Collection owner").unwrap();
    fs::write(root.join("inline/child.md"), "Child body").unwrap();

    let first = read(root, None, "valid.md").await.unwrap();
    assert_eq!(first.meta.title, "Named");
    assert_eq!(
        first
            .meta
            .extra
            .get("id")
            .and_then(serde_yml::Value::as_str),
        Some("custom")
    );
    assert_eq!(
        first
            .meta
            .extra
            .get("created")
            .and_then(serde_yml::Value::as_str),
        Some("custom-created")
    );
    assert_eq!(first.body, "Body\n");
    assert_eq!(
        first.name_conflict.as_ref().unwrap().conflicts[0].path,
        "duplicate.md"
    );
    assert_eq!(first.target.path, "valid.md");
    let plain = read(root, None, "plain.md").await.unwrap();
    assert_eq!(plain.meta.title, "Plain");
    assert_eq!(plain.body, "Plain body");
    assert_eq!(read(root, None, "empty.md").await.unwrap().body, "");
    assert!(matches!(
        read(root, None, "bad-encoding.md").await,
        Err(PageSourceError::InvalidEncoding(_))
    ));
    let malformed = read(root, None, "malformed.md").await.unwrap();
    assert_eq!(malformed.body, "---\ntitle: [bad\n---\nBody");
    assert_eq!(malformed.warnings[0].kind, "malformed_frontmatter");
    let folder = read(root, None, "folder/README.md").await.unwrap();
    assert_eq!(folder.body, "Folder body");
    let child = read(root, Some("inline"), "child.md").await.unwrap();
    assert_eq!(child.body, "Child body");
    for path in [
        "README.md",
        "AGENTS.md",
        "collection/item.md",
        "collection/README.md",
        "inline/child.md",
    ] {
        assert!(
            matches!(
                read(root, None, path).await,
                Err(PageSourceError::InvalidOwner(_))
            ),
            "{path}"
        );
    }
    for path in [".git/config.md", ".svode/notes.md", ".SVODE/notes.md"] {
        assert!(
            matches!(
                read(root, None, path).await,
                Err(PageSourceError::Forbidden(_))
            ),
            "{path}"
        );
    }
    for path in ["missing.md", "../valid.md", "/tmp/valid.md", "plain.txt"] {
        assert!(read(root, None, path).await.is_err(), "{path}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside_dir = tempfile::tempdir().unwrap();
        let outside = outside_dir.path().join("outside-page-source.md");
        fs::write(&outside, "Outside").unwrap();
        symlink(&outside, root.join("escape.md")).unwrap();
        assert!(matches!(
            read(root, None, "escape.md").await,
            Err(PageSourceError::Forbidden(_))
        ));
        symlink(root.join("inline/child.md"), root.join("child-alias.md")).unwrap();
        assert!(matches!(
            read(root, None, "child-alias.md").await,
            Err(PageSourceError::InvalidOwner(_))
        ));
    }
    let before = first.version;
    fs::write(root.join("valid.md"), "---\ntitle: Changed\nid: custom\ncreated: custom-created\nupdated: custom-updated\n---\nBody\n").unwrap();
    let after = read(root, None, "valid.md").await.unwrap();
    assert_ne!(before, after.version);
    assert_eq!(after.body, "Body\n");
    assert!(!root.join(".svode/index.db").exists());
    assert!(!root.join(".svode/routines.db").exists());
}

#[tokio::test]
async fn invalid_project_config_and_child_selection_do_not_create_scaffold() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::write(root.join("note.md"), "Body").unwrap();
    assert!(matches!(
        read(root, None, "note.md").await,
        Err(PageSourceError::Missing(_))
    ));
    fs::create_dir(root.join(".svode")).unwrap();
    fs::write(root.join(".svode/config.json"), "{").unwrap();
    assert!(matches!(
        read(root, None, "note.md").await,
        Err(PageSourceError::InvalidConfig(_))
    ));
    project(root);
    assert!(matches!(
        read(root, Some("unknown"), "note.md").await,
        Err(PageSourceError::SpaceNotFound(_))
    ));
    assert!(!root.join(".svode/index.db").exists());
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":null}"#,
    )
    .unwrap();
    assert_eq!(read(root, None, "note.md").await.unwrap().body, "Body");
}

#[cfg(unix)]
#[tokio::test]
async fn registered_child_symlink_alias_keeps_root_out_of_child_content() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::create_dir(root.join("real")).unwrap();
    fs::write(root.join("real/note.md"), "Child").unwrap();
    symlink(root.join("real"), root.join("alias")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"alias","path":"alias","repo":null}]}"#,
    )
    .unwrap();
    assert!(matches!(
        read(root, None, "real/note.md").await,
        Err(PageSourceError::InvalidOwner(_))
    ));
    assert_eq!(
        read(root, Some("alias"), "note.md").await.unwrap().body,
        "Child"
    );
}

#[tokio::test]
async fn git_history_dates_and_dirty_fallback_are_read_only() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    project(root);
    git(root, &["init"], None);
    git(root, &["config", "user.name", "Test"], None);
    git(
        root,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    fs::write(root.join("note.md"), "one").unwrap();
    git(root, &["add", "note.md"], None);
    git(
        root,
        &["commit", "-m", "first"],
        Some("2026-01-01T00:00:00Z"),
    );
    fs::write(root.join("note.md"), "two").unwrap();
    git(root, &["add", "note.md"], None);
    git(
        root,
        &["commit", "-m", "second"],
        Some("2026-02-03T04:05:06Z"),
    );
    let index = fs::read(root.join(".git/index")).unwrap();
    let clean = read(root, None, "note.md").await.unwrap();
    assert_eq!(clean.created, "2026-01-01T00:00:00Z");
    assert_eq!(clean.updated, "2026-02-03T04:05:06Z");
    fs::write(root.join("note.md"), "three").unwrap();
    let dirty = read(root, None, "note.md").await.unwrap();
    assert_eq!(dirty.created, clean.created);
    assert_ne!(dirty.updated, clean.updated);
    assert_eq!(dirty.body, "three");
    assert_ne!(dirty.version, clean.version);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    fs::write(root.join("untracked.md"), "Untracked").unwrap();
    let untracked = read(root, None, "untracked.md").await.unwrap();
    assert_eq!(untracked.body, "Untracked");
    assert!(!untracked.created.is_empty());
    assert!(!root.join(".svode/index.db").exists());
    assert!(!root.join(".svode/routines.db").exists());
}

#[tokio::test]
async fn inline_independent_and_submodule_use_their_effective_git_history() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    project(&root);
    git(&root, &["init"], None);
    git(&root, &["config", "user.name", "Test"], None);
    git(
        &root,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    fs::write(root.join("inline/note.md"), "Inline").unwrap();
    git(&root, &["add", "inline/note.md"], None);
    git(
        &root,
        &["commit", "-m", "inline"],
        Some("2026-01-01T00:00:00Z"),
    );
    let inline = read(&root, Some("inline"), "note.md").await.unwrap();
    assert_eq!(inline.created, "2026-01-01T00:00:00Z");

    let independent = root.join("independent");
    git(&independent, &["init"], None);
    git(&independent, &["config", "user.name", "Test"], None);
    git(
        &independent,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    fs::write(independent.join("note.md"), "Independent").unwrap();
    git(&independent, &["add", "note.md"], None);
    git(
        &independent,
        &["commit", "-m", "independent"],
        Some("2026-02-02T00:00:00Z"),
    );
    let independent_read = read(&root, Some("independent"), "note.md").await.unwrap();
    assert_eq!(independent_read.created, "2026-02-02T00:00:00Z");

    let source = temp.path().join("sub-source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init"], None);
    git(&source, &["config", "user.name", "Test"], None);
    git(
        &source,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    fs::write(source.join("note.md"), "Submodule").unwrap();
    git(&source, &["add", "note.md"], None);
    git(
        &source,
        &["commit", "-m", "submodule"],
        Some("2026-03-03T00:00:00Z"),
    );
    let source_path = source.to_str().unwrap();
    git(
        &root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source_path,
            "sub",
        ],
        None,
    );
    fs::write(root.join(".svode/config.json"), r#"{"name":"Project","spaces":[{"id":"inline","path":"inline","repo":null},{"id":"independent","path":"independent","repo":null},{"id":"sub","path":"sub","repo":null}]}"#).unwrap();
    assert!(root.join("sub/.git").is_file());
    let submodule = read(&root, Some("sub"), "note.md").await.unwrap();
    assert_eq!(submodule.created, "2026-03-03T00:00:00Z");
    assert!(!root.join(".svode/index.db").exists());
    assert!(!root.join(".svode/routines.db").exists());
}

#[tokio::test]
async fn shallow_history_uses_filesystem_dates() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    project(&source);
    git(&source, &["init"], None);
    git(&source, &["config", "user.name", "Test"], None);
    git(
        &source,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    fs::write(source.join("note.md"), "Body").unwrap();
    git(&source, &["add", ".svode/config.json", "note.md"], None);
    git(
        &source,
        &["commit", "-m", "source"],
        Some("2020-01-01T00:00:00Z"),
    );
    let clone = temp.path().join("shallow");
    let clone_path = clone.to_str().unwrap();
    let url = format!("file://{}", source.display());
    git(
        temp.path(),
        &["clone", "--depth", "1", &url, clone_path],
        None,
    );
    let overrides =
        derive_date_overrides(&SystemGitDateExecutor, &clone, &["note.md".into()]).await;
    assert!(overrides.is_empty());
    let page = read(&clone, None, "note.md").await.unwrap();
    assert_eq!(page.body, "Body");
    assert_ne!(page.created, "2020-01-01T00:00:00Z");
}
