use std::collections::BTreeSet;
use std::path::Path;

use super::{files_held_by_local_rules, with_released_lfs_paths};
use crate::git::cli::GitCli;
use crate::storage::config::BinaryRoutingConfig;
use crate::storage::local_rules::{
    LEGACY_ASSETS_IGNORE_BODY, LEGACY_ASSETS_IGNORE_END, LEGACY_ASSETS_IGNORE_START,
    LOCAL_EXTENSIONS_END, LOCAL_EXTENSIONS_START, rewrite_local_extensions_block,
};
use crate::storage::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, append_block,
    parse_managed_paths, rewrite_managed_path_block,
};

fn write(repo: &Path, relative: &str, contents: &[u8]) {
    let path = repo.join(relative);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    std::fs::write(path, contents).expect("write");
}

async fn git(cli: &GitCli, repo: &Path, args: &[&str]) -> String {
    let out = cli.exec(repo, args).await.expect("git");
    assert_eq!(out.exit_code, 0, "git {args:?}: {}", out.stderr);
    out.stdout
}

async fn repo() -> Option<(GitCli, tempfile::TempDir)> {
    let cli = GitCli::detect().ok()?;
    let temp = tempfile::tempdir().expect("temp");
    git(&cli, temp.path(), &["init"]).await;
    git(
        &cli,
        temp.path(),
        &["config", "user.email", "test@example.com"],
    )
    .await;
    git(&cli, temp.path(), &["config", "user.name", "Svode Test"]).await;
    Some((cli, temp))
}

fn local_gitignore(user: &str, exact: &[&str], extensions: &[&str]) -> String {
    let legacy = append_block(
        user,
        LEGACY_ASSETS_IGNORE_START,
        LEGACY_ASSETS_IGNORE_BODY,
        LEGACY_ASSETS_IGNORE_END,
    );
    let exact: BTreeSet<String> = exact.iter().map(|path| (*path).to_string()).collect();
    let paths =
        rewrite_managed_path_block(&legacy, LOCAL_PATHS_START, LOCAL_PATHS_END, &exact, false);
    let extensions: Vec<String> = extensions.iter().map(|e| (*e).to_string()).collect();
    rewrite_local_extensions_block(&paths, Some(&extensions))
}

#[tokio::test]
async fn held_files_are_the_untracked_files_a_local_block_decides_for() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write(repo, "docs/tracked.png", b"tracked");
    write(repo, ".assets/tracked.png", b"tracked");
    git(
        &cli,
        repo,
        &["add", "docs/tracked.png", ".assets/tracked.png"],
    )
    .await;
    git(&cli, repo, &["commit", "-m", "Tracked"]).await;
    write(
        repo,
        ".gitignore",
        local_gitignore(
            "node_modules/\n*.log\n",
            &["docs/big.bin", "docs/gone.bin"],
            &["jpg", "png"],
        )
        .as_bytes(),
    );
    for (path, contents) in [
        ("docs/photo.JPG", &b"jpg"[..]),
        ("docs/sub/deep/a.png", b"png"),
        ("docs/big.bin", b"big"),
        (".assets/a/f.bin", b"bin"),
        (".assets/g.txt", b"txt"),
        ("docs/notes.txt", b"txt"),
        ("debug.log", b"log"),
        ("node_modules/x/y.js", b"js"),
        // A nested .gitignore decides for its folder.
        ("apps/i/.gitignore", b"icon.png\n"),
        ("apps/i/icon.png", b"png"),
    ] {
        write(repo, path, contents);
    }
    // A tracked file stays tracked and is not counted.
    write(repo, "docs/tracked.png", b"changed");

    let held = files_held_by_local_rules(&cli, repo).await.expect("held");

    assert_eq!(
        held,
        [
            ".assets/a/f.bin",
            ".assets/g.txt",
            "docs/big.bin",
            "docs/photo.JPG",
            "docs/sub/deep/a.png",
        ]
    );
    assert!(
        git(&cli, repo, &["diff", "--cached", "--name-only"])
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_repository_without_local_blocks_holds_nothing() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write(repo, ".gitignore", b"*.png\n");
    write(repo, "docs/photo.png", b"png");

    assert!(
        files_held_by_local_rules(&cli, repo)
            .await
            .expect("held")
            .is_empty()
    );

    // An empty extension block holds nothing either.
    write(
        repo,
        ".gitignore",
        format!("*.png\n{LOCAL_EXTENSIONS_START}\n{LOCAL_EXTENSIONS_END}\n").as_bytes(),
    );
    assert!(
        files_held_by_local_rules(&cli, repo)
            .await
            .expect("held")
            .is_empty()
    );
}

#[test]
fn released_files_get_exact_lfs_rules_only_where_lfs_rules_leave_them_out() {
    let temp = tempfile::tempdir().expect("temp");
    let repo = temp.path();
    for (path, size) in [
        ("docs/big.bin", 20),
        ("docs/small.bin", 5),
        ("docs/photo.png", 20),
        (".assets/old.bin", 20),
        ("docs/notes.md", 20),
    ] {
        write(repo, path, &vec![b'x'; size]);
    }
    let released: Vec<String> = [
        "docs/big.bin",
        "docs/small.bin",
        "docs/photo.png",
        ".assets/old.bin",
        "docs/notes.md",
        "docs/gone.bin",
    ]
    .iter()
    .map(|path| (*path).to_string())
    .collect();
    let mut routing = BinaryRoutingConfig::new_project_default();
    routing.lfs_extensions = vec!["png".into()];
    routing.lfs_threshold_bytes = Some(10);
    let existing = rewrite_managed_path_block(
        "*.custom merge=ours\n",
        LFS_PATHS_START,
        LFS_PATHS_END,
        &BTreeSet::from(["media/clip.raw".to_string()]),
        true,
    );

    let next = with_released_lfs_paths(&existing, repo, &released, &routing).expect("rules");

    assert!(next.starts_with("*.custom merge=ours\n"), "{next}");
    assert_eq!(
        parse_managed_paths(&next, LFS_PATHS_START, LFS_PATHS_END).expect("paths"),
        BTreeSet::from(["docs/big.bin".to_string(), "media/clip.raw".to_string()])
    );
    assert!(next.contains("docs/big.bin filter=lfs diff=lfs merge=lfs -text"));
    assert_eq!(
        with_released_lfs_paths(&next, repo, &released, &routing).expect("again"),
        next
    );

    routing.lfs_threshold_bytes = None;
    assert_eq!(
        with_released_lfs_paths(&existing, repo, &released, &routing).expect("no threshold"),
        existing
    );
}
