use super::{cli::GitCli, inspection::read_item, ops};

async fn repo() -> (tempfile::TempDir, GitCli) {
    let dir = tempfile::tempdir().unwrap();
    let cli = GitCli::detect().unwrap();
    cli.exec(dir.path(), &["init"]).await.unwrap();
    cli.exec(dir.path(), &["config", "user.email", "test@example.com"])
        .await
        .unwrap();
    cli.exec(dir.path(), &["config", "user.name", "Test"])
        .await
        .unwrap();
    (dir, cli)
}

#[tokio::test]
async fn inspection_reads_unborn_modified_deleted_and_index_only_without_writes() {
    let (dir, cli) = repo().await;
    let path = dir.path().join("note.md");
    std::fs::write(&path, "first\n").unwrap();
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "1".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["before"], "");
    assert_eq!(item["after"], "first\n");
    assert!(
        ops::commit_paths(&cli, dir.path(), &["note.md".into()])
            .await
            .unwrap()
    );
    std::fs::write(&path, "second\n").unwrap();
    ops::add(&cli, dir.path(), "note.md").await.unwrap();
    std::fs::write(&path, "first\n").unwrap();
    let index_before = cli
        .exec(dir.path(), &["diff", "--cached"])
        .await
        .unwrap()
        .stdout;
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "2".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["state"], "no_content_diff");
    assert_eq!(
        index_before,
        cli.exec(dir.path(), &["diff", "--cached"])
            .await
            .unwrap()
            .stdout
    );
    std::fs::remove_file(&path).unwrap();
    let item = serde_json::to_value(
        read_item(&cli, dir.path(), "note.md", "3".into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(item["before"], "first\n");
    assert_eq!(item["after"], "");
    assert!(
        read_item(&cli, dir.path(), "../note.md", "4".into())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn selected_commit_preserves_unrelated_staged_content() {
    let (dir, cli) = repo().await;
    for name in ["note.md", "other.md"] {
        std::fs::write(dir.path().join(name), "initial\n").unwrap();
    }
    ops::commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("other.md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "other.md").await.unwrap();
    std::fs::write(dir.path().join("other.md"), "working\n").unwrap();
    std::fs::write(dir.path().join("note.md"), "selected\n").unwrap();
    let staged = cli
        .exec(dir.path(), &["show", ":other.md"])
        .await
        .unwrap()
        .stdout;
    ops::commit_file(&cli, dir.path(), "note.md").await.unwrap();
    assert_eq!(
        cli.exec(dir.path(), &["show", "HEAD:other.md"])
            .await
            .unwrap()
            .stdout,
        "initial\n"
    );
    assert_eq!(
        cli.exec(dir.path(), &["show", ":other.md"])
            .await
            .unwrap()
            .stdout,
        staged
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("other.md")).unwrap(),
        "working\n"
    );
}

#[tokio::test]
async fn inspection_bounds_text_and_rejects_child_repository_and_symlink_escape() {
    let (dir, cli) = repo().await;
    for (name, bytes, state) in [
        ("large.md", vec![b'a'; 600 * 1024], "truncated"),
        ("large.pdf", vec![b'a'; 600 * 1024], "binary"),
        ("invalid.md", vec![255], "invalid_encoding"),
        ("binary.md", vec![0, 1], "binary"),
    ] {
        std::fs::write(dir.path().join(name), bytes).unwrap();
        let item = serde_json::to_value(
            read_item(&cli, dir.path(), name, "generation".into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(item["state"], state);
        assert_eq!(item["generation"], "generation");
        assert!(item["after"].is_null());
    }
    let child = dir.path().join("child");
    std::fs::create_dir(&child).unwrap();
    cli.exec(&child, &["init"]).await.unwrap();
    std::fs::write(child.join("note.md"), "child").unwrap();
    assert!(
        read_item(&cli, dir.path(), "child/note.md", "1".into())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("note.md"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        assert!(
            read_item(&cli, dir.path(), "escape/note.md", "1".into())
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn index_only_save_clears_selected_index_without_creating_commit() {
    let (dir, cli) = repo().await;
    std::fs::write(dir.path().join("[note].md"), "base\n").unwrap();
    ops::commit_all(&cli, dir.path()).await.unwrap();
    let head = cli
        .exec(dir.path(), &["rev-parse", "HEAD"])
        .await
        .unwrap()
        .stdout;
    std::fs::write(dir.path().join("[note].md"), "staged\n").unwrap();
    ops::add(&cli, dir.path(), "[note].md").await.unwrap();
    std::fs::write(dir.path().join("[note].md"), "base\n").unwrap();
    assert!(
        !ops::commit_paths(&cli, dir.path(), &["[note].md".into()])
            .await
            .unwrap()
    );
    assert_eq!(
        cli.exec(dir.path(), &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .stdout,
        head
    );
    assert!(
        ops::status(&cli, dir.path())
            .await
            .unwrap()
            .files
            .is_empty()
    );
}

#[tokio::test]
async fn aggregate_scope_is_rechecked_and_exceptional_items_are_local() {
    let (dir, cli) = repo().await;
    std::fs::create_dir(dir.path().join("contract")).unwrap();
    for name in [
        "README.md",
        "schema.yaml",
        "app.yaml",
        "source.ts",
        "manual.pdf",
    ] {
        std::fs::write(dir.path().join("contract").join(name), "base\n").unwrap();
    }
    ops::commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("contract/source.ts"), "changed\n").unwrap();
    cli.exec(
        dir.path(),
        &["mv", "contract/README.md", "contract/renamed.md"],
    )
    .await
    .unwrap();
    let scope = || {
        serde_json::from_value(serde_json::json!({"kind": "directory", "path": "contract"}))
            .unwrap()
    };
    let renamed = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/renamed.md",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    let renamed = serde_json::to_value(renamed).unwrap();
    assert_eq!(renamed["previousPath"], "contract/README.md");
    let binary = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/manual.pdf",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(binary).unwrap()["state"], "binary");
    assert!(
        super::inspection::read_scoped_item(
            &cli,
            dir.path(),
            "outside.md",
            "1".into(),
            Some(scope())
        )
        .await
        .is_err()
    );
    let missing = super::inspection::read_scoped_item(
        &cli,
        dir.path(),
        "contract/gone.md",
        "1".into(),
        Some(scope()),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(missing).unwrap()["state"],
        "disappeared"
    );
    let root_scope =
        serde_json::from_value(serde_json::json!({"kind": "repository", "path": ""})).unwrap();
    assert!(
        super::inspection::read_scoped_item(
            &cli,
            dir.path(),
            "contract/source.ts",
            "1".into(),
            Some(root_scope)
        )
        .await
        .is_ok()
    );
}

#[tokio::test]
async fn project_status_contains_inline_paths_and_gitlink_but_not_child_working_trees() {
    let (dir, cli) = repo().await;
    let (child, _) = repo().await;
    std::fs::write(child.path().join("child.md"), "base\n").unwrap();
    ops::commit_all(&cli, child.path()).await.unwrap();
    let added = cli
        .exec(
            dir.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child.path().to_str().unwrap(),
                "sub",
            ],
        )
        .await
        .unwrap();
    assert_eq!(added.exit_code, 0, "{}", added.stderr);
    std::fs::create_dir(dir.path().join("inline")).unwrap();
    std::fs::write(dir.path().join("inline/README.md"), "base\n").unwrap();
    ops::commit_all(&cli, dir.path()).await.unwrap();
    std::fs::write(dir.path().join("sub/child.md"), "dirty child\n").unwrap();
    std::fs::write(dir.path().join("inline/README.md"), "dirty inline\n").unwrap();
    let independent = dir.path().join("independent");
    std::fs::create_dir(&independent).unwrap();
    cli.exec(&independent, &["init"]).await.unwrap();
    std::fs::write(independent.join("note.md"), "independent\n").unwrap();
    let status = ops::status(&cli, dir.path()).await.unwrap();
    assert_eq!(
        status
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["inline/README.md"]
    );
    let inline = ops::status(&cli, &dir.path().join("inline")).await.unwrap();
    assert_eq!(inline.files[0].path, "README.md");
    assert_eq!(
        ops::status(&cli, &dir.path().join("sub"))
            .await
            .unwrap()
            .files[0]
            .path,
        "child.md"
    );
    cli.exec(&dir.path().join("sub"), &["config", "user.name", "Test"])
        .await
        .unwrap();
    cli.exec(
        &dir.path().join("sub"),
        &["config", "user.email", "test@example.com"],
    )
    .await
    .unwrap();
    ops::commit_all(&cli, &dir.path().join("sub"))
        .await
        .unwrap();
    assert!(
        ops::status(&cli, dir.path())
            .await
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "sub")
    );
    let pointer = read_item(&cli, dir.path(), "sub", "1".into())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(pointer).unwrap()["state"], "gitlink");
}

#[tokio::test]
async fn conflicts_and_non_regular_sources_never_become_normal_text() {
    let (dir, cli) = repo().await;
    std::fs::write(dir.path().join("note.md"), "base\n").unwrap();
    ops::commit_all(&cli, dir.path()).await.unwrap();
    let base_branch = ops::status(&cli, dir.path()).await.unwrap().branch;
    cli.exec(dir.path(), &["checkout", "-b", "other"])
        .await
        .unwrap();
    std::fs::write(dir.path().join("note.md"), "other\n").unwrap();
    ops::commit_all(&cli, dir.path()).await.unwrap();
    cli.exec(dir.path(), &["checkout", &base_branch])
        .await
        .unwrap();
    std::fs::write(dir.path().join("note.md"), "ours\n").unwrap();
    ops::commit_all(&cli, dir.path()).await.unwrap();
    assert_ne!(
        cli.exec(dir.path(), &["merge", "other"])
            .await
            .unwrap()
            .exit_code,
        0
    );
    let item = read_item(&cli, dir.path(), "note.md", "1".into())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(item).unwrap()["state"], "conflict");
    #[cfg(unix)]
    {
        let pipe = dir.path().join("pipe");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&pipe)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            read_item(&cli, dir.path(), "pipe", "1".into())
                .await
                .is_err()
        );
    }
}
