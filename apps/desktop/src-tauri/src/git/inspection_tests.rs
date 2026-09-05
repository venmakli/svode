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
