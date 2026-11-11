//! The size threshold of the `local` strategy at a commit of Svode (DF-305
//! R4б): every commit holds the large untracked files of its scope out of Git
//! with an exact rule before staging, and the other strategies commit them as
//! before.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::policy::{GitUserPolicy, write_user_policy};
use super::save::save;
use super::staging_tests::{TestHost, cli, git, repo, write};
use super::state::GitRuntime;
use super::versions::MessageLanguage;
use super::versions::auto::{AutoVersions, Closing, close};
use crate::storage::routes::{LOCAL_PATHS_END, LOCAL_PATHS_START, parse_managed_paths};

const THRESHOLD: usize = 1_000;
const LOCAL: &str = r#"{"strategy":"local","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":1000}}"#;

/// A born repository with the `assets` config of `assets` and the system
/// rules the repair of a save writes to `.gitignore` committed.
async fn project(assets: &str) -> tempfile::TempDir {
    let tmp = repo(&cli(), true).await;
    write(
        tmp.path(),
        ".svode/config.json",
        &format!(r#"{{"name":"Project","assets":{assets}}}"#),
    );
    save_paths(tmp.path(), None).await;
    assert!(status(tmp.path()).await.is_empty());
    tmp
}

fn gitignore(root: &Path) -> String {
    std::fs::read_to_string(root.join(".gitignore")).unwrap_or_default()
}

/// An external large file of a format outside the list, a small one and a
/// Page, none of them known to Git.
fn external_files(root: &Path) {
    write(root, "docs/data.bin", &"x".repeat(THRESHOLD * 2));
    write(root, "docs/notes.txt", "notes\n");
    write(root, "page.md", "page\n");
}

async fn head(root: &Path) -> String {
    git(&cli(), root, &["rev-parse", "HEAD"])
        .await
        .trim()
        .to_string()
}

async fn committed_since(root: &Path, before: &str) -> Vec<String> {
    let range = format!("{before}..HEAD");
    let mut paths = git(&cli(), root, &["log", "--name-only", "--format=", &range])
        .await
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    paths.sort_unstable();
    paths.dedup();
    paths
}

async fn status(root: &Path) -> Vec<String> {
    git(&cli(), root, &["status", "--porcelain", "-uall"])
        .await
        .lines()
        .map(|line| line[3..].to_string())
        .filter(|path| !super::policy::contains(path))
        .collect()
}

fn exact_rules(root: &Path) -> Vec<String> {
    parse_managed_paths(&gitignore(root), LOCAL_PATHS_START, LOCAL_PATHS_END)
        .expect("exact rules")
        .into_iter()
        .collect()
}

async fn ignored(root: &Path, path: &str) -> bool {
    cli()
        .exec(root, &["check-ignore", "--quiet", "--", path])
        .await
        .expect("check-ignore")
        .exit_code
        == 0
}

async fn save_paths(root: &Path, paths: Option<&[&str]>) {
    save(
        &Arc::new(GitRuntime::new()),
        &TestHost::default(),
        None,
        root,
        paths.map(|paths| paths.iter().map(|path| path.to_string()).collect()),
        MessageLanguage::En,
    )
    .await
    .expect("save");
}

/// The large file is held out with its exact rule and the rest landed.
async fn assert_held(root: &Path, before: &str) {
    assert_eq!(
        committed_since(root, before).await,
        [".gitignore", "docs/notes.txt", "page.md"]
    );
    assert_eq!(exact_rules(root), ["docs/data.bin"]);
    assert!(ignored(root, "docs/data.bin").await);
    assert!(status(root).await.is_empty(), "{:?}", status(root).await);
}

#[tokio::test]
async fn saving_all_listed_changes_holds_a_large_external_file_out_of_the_commit() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    external_files(root);
    let before = head(root).await;

    // «Сохранить всё» names the paths of the status it showed.
    save_paths(root, Some(&["docs/data.bin", "docs/notes.txt", "page.md"])).await;

    assert_held(root, &before).await;
}

#[tokio::test]
async fn committing_all_holds_a_large_external_file_out_of_the_commit() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    external_files(root);
    let before = head(root).await;

    save_paths(root, None).await;

    assert_held(root, &before).await;
}

#[tokio::test]
async fn an_automatic_version_holds_a_large_external_file_out_of_the_commit() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    write(root, ".gitignore", ".svode/local.json\n");
    git(&cli(), root, &["add", ".gitignore"]).await;
    git(&cli(), root, &["commit", "-q", "-m", "Ignore"]).await;
    write_user_policy(
        root,
        &GitUserPolicy {
            auto_commit_content: true,
            ..GitUserPolicy::default()
        },
    )
    .expect("policy");
    external_files(root);
    let before = head(root).await;

    let outcome = close(
        &GitRuntime::with_cli(cli()),
        &TestHost::default(),
        root,
        &Closing::all(Duration::from_secs(60)),
        MessageLanguage::En,
    )
    .await
    .expect("close");

    assert!(matches!(outcome, AutoVersions::Done { .. }));
    assert_held(root, &before).await;
    let rules = gitignore(root);
    assert!(rules.starts_with(".svode/local.json\n"), "{rules}");
}

#[tokio::test]
async fn a_structural_commit_of_a_folder_holds_its_large_external_file() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    external_files(root);
    let before = head(root).await;

    assert!(
        super::versions::commit_exact(&cli(), root, &["docs".to_string()], "Create docs")
            .await
            .expect("structural commit")
    );

    assert_eq!(
        committed_since(root, &before).await,
        [".gitignore", "docs/notes.txt"]
    );
    assert_eq!(exact_rules(root), ["docs/data.bin"]);
    assert_eq!(status(root).await, ["page.md"]);
}

#[tokio::test]
async fn listed_formats_small_files_and_protected_formats_get_no_exact_rule() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    write(root, "docs/photo.JPG", &"x".repeat(THRESHOLD * 2));
    write(root, "docs/big.md", &"x".repeat(THRESHOLD * 2));
    write(root, "docs/notes.txt", "notes\n");
    let before = head(root).await;
    let rules = gitignore(root);

    save_paths(root, None).await;

    // No file needed an exact rule, so `.gitignore` is left as it was; the
    // listed format waits for the block the opening of the Project writes.
    assert_eq!(gitignore(root), rules);
    let committed = committed_since(root, &before).await;
    assert!(committed.contains(&"docs/big.md".to_string()));
    assert!(committed.contains(&"docs/notes.txt".to_string()));
}

#[tokio::test]
async fn a_held_file_in_the_rewritten_block_takes_the_listed_formats_out_too() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    external_files(root);
    write(root, "docs/photo.jpg", &"x".repeat(10));
    let before = head(root).await;

    save_paths(root, None).await;

    assert_held(root, &before).await;
    assert!(ignored(root, "docs/photo.jpg").await);
}

#[tokio::test]
async fn a_status_path_held_by_an_earlier_commit_is_skipped_without_a_refusal() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    external_files(root);
    save_paths(root, Some(&["docs/data.bin"])).await;
    assert_eq!(exact_rules(root), ["docs/data.bin"]);
    let after_first = head(root).await;

    // A status read before the rule still names the held file.
    save_paths(root, Some(&["docs/data.bin", "page.md"])).await;

    assert_eq!(committed_since(root, &after_first).await, ["page.md"]);
}

#[tokio::test]
async fn the_rewrite_drops_exact_rules_of_gone_paths_and_keeps_present_ones() {
    let tmp = project(LOCAL).await;
    let root = tmp.path();
    write(root, "kept.bin", "small but recorded\n");
    write(
        root,
        ".gitignore",
        &format!(
            "build/\n{LOCAL_PATHS_START}\n# svode:path \"gone.bin\"\n/gone.bin\n# svode:path \"kept.bin\"\n/kept.bin\n{LOCAL_PATHS_END}\n"
        ),
    );
    external_files(root);

    save_paths(root, None).await;

    assert_eq!(exact_rules(root), ["docs/data.bin", "kept.bin"]);
    let rules = gitignore(root);
    assert!(rules.starts_with("build/\n"), "{rules}");
}

#[tokio::test]
async fn in_git_and_lfs_strategies_commit_a_large_file_as_before() {
    for assets in [
        r#"{"strategy":"in-git","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":1000}}"#,
        r#"{"strategy":"lfs-remote","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":1000}}"#,
    ] {
        let tmp = project(assets).await;
        let root = tmp.path();
        external_files(root);
        let before = head(root).await;
        let rules = gitignore(root);

        save_paths(root, None).await;

        assert_eq!(gitignore(root), rules, "{assets}");
        assert_eq!(
            committed_since(root, &before).await,
            ["docs/data.bin", "docs/notes.txt", "page.md"],
            "{assets}"
        );
    }
}
