//! Publication of a project root with a Space on every OS (DF-364): the proof
//! hands Git the local copy of a Space in a form Git for Windows reads, so a
//! root pointer to a published Space revision passes. Real Git, no shell
//! wrapper: the fixture's own submodule clone allows the file protocol by an
//! argument.

use super::*;
use crate::git::staging_tests::{cli, git, repo, write};

/// Allows the local Space source for the fixture's submodule clone only.
const FILE_PROTOCOL: [&str; 2] = ["-c", "protocol.file.allow=always"];

#[tokio::test]
async fn a_root_pointer_to_a_published_space_revision_passes_the_proof_and_publishes() {
    let cli = cli();
    let tmp = tempfile::tempdir().unwrap();
    let seed = repo(&cli, true).await;
    let source = tmp.path().join("space.git");
    let remote = tmp.path().join("project.git");
    git(
        &cli,
        tmp.path(),
        &[
            "clone",
            "-q",
            "--bare",
            seed.path().to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    )
    .await;
    let project = repo(&cli, true).await;
    let root = project.path();
    let mut add = FILE_PROTOCOL.to_vec();
    add.extend(["submodule", "add", "-q", source.to_str().unwrap(), "Space"]);
    git(&cli, root, &add).await;
    git(&cli, root, &["commit", "-q", "-m", "Space"]).await;
    git(
        &cli,
        tmp.path(),
        &[
            "clone",
            "-q",
            "--bare",
            root.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    )
    .await;
    git(
        &cli,
        root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .await;
    git(&cli, root, &["push", "-q", "-u", "origin", "HEAD"]).await;

    // A published Space revision, referenced only by an unpublished root commit.
    let child = root.join("Space");
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.test"),
        ("commit.gpgsign", "false"),
    ] {
        git(&cli, &child, &["config", key, value]).await;
    }
    write(&child, "note.md", "published\n");
    git(&cli, &child, &["add", "note.md"]).await;
    git(&cli, &child, &["commit", "-q", "-m", "Published"]).await;
    git(&cli, &child, &["push", "-q", "origin", "HEAD"]).await;
    git(&cli, root, &["add", "Space"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Pointer"]).await;

    assert_eq!(blocked_spaces(&cli, root).await.unwrap(), Vec::new());
    let out = push(&cli, root, false).await.unwrap();
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    assert_eq!(
        git(&cli, &remote, &["rev-parse", "HEAD"]).await,
        git(&cli, root, &["rev-parse", "HEAD"]).await
    );
}
