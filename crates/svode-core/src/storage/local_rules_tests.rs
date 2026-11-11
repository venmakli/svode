use std::path::Path;

use super::{LOCAL_EXTENSIONS_END, LOCAL_EXTENSIONS_START, repair_local_rules};
use super::{local_extensions_body, rewrite_local_extensions_block};
use crate::git::cli::GitCli;
use crate::storage::policy::DEFAULT_LOCAL_EXTENSIONS;
use crate::storage::routes::{LOCAL_PATHS_END, LOCAL_PATHS_START};

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn write(repo: &Path, relative: &str, contents: &[u8]) {
    let path = repo.join(relative);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    std::fs::write(path, contents).expect("write");
}

fn write_config(repo: &Path, assets: &str) {
    write(
        repo,
        ".svode/config.json",
        format!(r#"{{"name":"Project","assets":{assets}}}"#).as_bytes(),
    );
}

async fn repo() -> Option<(GitCli, tempfile::TempDir)> {
    let cli = GitCli::detect().ok()?;
    let temp = tempfile::tempdir().expect("temp");
    let out = cli.exec(temp.path(), &["init"]).await.expect("init");
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    Some((cli, temp))
}

async fn ignored(cli: &GitCli, repo: &Path, path: &str) -> bool {
    cli.exec(repo, &["check-ignore", "--quiet", "--", path])
        .await
        .expect("check-ignore")
        .exit_code
        == 0
}

fn gitignore(repo: &Path) -> String {
    std::fs::read_to_string(repo.join(".gitignore")).unwrap_or_default()
}

#[test]
fn extension_block_is_rewritten_in_place_and_removed_without_touching_user_lines() {
    let user = "build/\n# keep\n*.log\n";
    let first = rewrite_local_extensions_block(user, Some(&strings(&["jpg", "7z"])));
    assert_eq!(
        first,
        format!(
            "{user}{LOCAL_EXTENSIONS_START}\n*.[jJ][pP][gG]\n*.7[zZ]\n{LOCAL_EXTENSIONS_END}\n"
        )
    );
    assert_eq!(
        rewrite_local_extensions_block(&first, Some(&strings(&["jpg", "7z"]))),
        first
    );

    let with_tail = format!("{first}tail/\n");
    let changed = rewrite_local_extensions_block(&with_tail, Some(&strings(&["pdf"])));
    assert_eq!(
        changed,
        format!("{user}{LOCAL_EXTENSIONS_START}\n*.[pP][dD][fF]\n{LOCAL_EXTENSIONS_END}\ntail/\n")
    );

    let empty = rewrite_local_extensions_block(&changed, Some(&[][..]));
    assert_eq!(empty, format!("{user}tail/\n"));
    assert_eq!(rewrite_local_extensions_block(&changed, None), empty);
}

#[tokio::test]
async fn repair_writes_the_default_block_and_git_hides_only_listed_formats() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write_config(
        repo,
        r#"{"strategy":"local","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":2048}}"#,
    );
    let config = std::fs::read(repo.join(".svode/config.json")).unwrap();
    write(repo, ".gitignore", b"user/\n");
    write(repo, "docs/photo.JPG", b"jpg");
    write(repo, "docs/notes.txt", &[b'n'; 1024]);
    write(repo, "docs/data.bin", &[b'b'; 4096]);

    assert!(repair_local_rules(&cli, repo).await.unwrap());
    let defaults = strings(DEFAULT_LOCAL_EXTENSIONS);
    assert_eq!(
        gitignore(repo),
        format!(
            "user/\n{LOCAL_EXTENSIONS_START}\n{}\n{LOCAL_EXTENSIONS_END}\n",
            local_extensions_body(&defaults)
        )
    );
    assert!(ignored(&cli, repo, "docs/photo.JPG").await);
    assert!(ignored(&cli, repo, "deep/a/b/scan.Pdf").await);
    assert!(!ignored(&cli, repo, "docs/notes.txt").await);
    assert!(!ignored(&cli, repo, "docs/data.bin").await);
    assert!(!ignored(&cli, repo, "diagram.svg").await);
    assert!(!ignored(&cli, repo, ".svode/config.json").await);

    assert!(!repair_local_rules(&cli, repo).await.unwrap());
    assert_eq!(
        std::fs::read(repo.join(".svode/config.json")).unwrap(),
        config
    );
}

#[tokio::test]
async fn repair_with_an_empty_list_writes_no_extension_rules() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write_config(
        repo,
        r#"{"strategy":"local","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":null,"localExtensions":[]}}"#,
    );
    write(repo, ".gitignore", b"user/\n");

    assert!(!repair_local_rules(&cli, repo).await.unwrap());
    assert_eq!(gitignore(repo), "user/\n");
    assert!(!ignored(&cli, repo, "photo.jpg").await);
}

#[tokio::test]
async fn repair_adds_the_block_keeps_rules_of_existing_files_and_drops_gone_paths() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write_config(
        repo,
        r#"{"strategy":"local","binaryRouting":{"version":1,"lfsExtensions":[],"lfsThresholdBytes":10000000,"localExtensions":["psd"]}}"#,
    );
    let old = format!(
        "user/\n# svode:assets-ignore:start\n.assets/\n# svode:assets-ignore:end\n{LOCAL_PATHS_START}\n# svode:path \"docs/kept.bin\"\n/docs/kept.bin\n# svode:path \"docs/gone.bin\"\n/docs/gone.bin\n# svode:path \"docs/staged.bin\"\n/docs/staged.bin\n{LOCAL_PATHS_END}\n"
    );
    write(repo, ".gitignore", old.as_bytes());
    write(repo, "docs/kept.bin", b"small but local");
    write(repo, "docs/staged.bin", b"in the index");
    let out = cli
        .exec(repo, &["add", "-f", "--", "docs/staged.bin"])
        .await
        .unwrap();
    assert_eq!(out.exit_code, 0, "{}", out.stderr);
    std::fs::remove_file(repo.join("docs/staged.bin")).unwrap();

    assert!(repair_local_rules(&cli, repo).await.unwrap());
    assert_eq!(
        gitignore(repo),
        format!(
            "user/\n# svode:assets-ignore:start\n.assets/\n# svode:assets-ignore:end\n{LOCAL_PATHS_START}\n# svode:path \"docs/kept.bin\"\n/docs/kept.bin\n# svode:path \"docs/staged.bin\"\n/docs/staged.bin\n{LOCAL_PATHS_END}\n{LOCAL_EXTENSIONS_START}\n*.[pP][sS][dD]\n{LOCAL_EXTENSIONS_END}\n"
        )
    );
    assert!(ignored(&cli, repo, "docs/kept.bin").await);
    assert!(!ignored(&cli, repo, "docs/gone.bin").await);

    let repaired = gitignore(repo);
    assert!(!repair_local_rules(&cli, repo).await.unwrap());
    assert_eq!(gitignore(repo), repaired);
}

#[tokio::test]
async fn repair_leaves_other_strategies_newer_routing_and_missing_config_alone() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    let stale =
        format!("{LOCAL_PATHS_START}\n# svode:path \"gone.bin\"\n/gone.bin\n{LOCAL_PATHS_END}\n");
    write(repo, ".gitignore", stale.as_bytes());

    assert!(!repair_local_rules(&cli, repo).await.unwrap());
    for assets in [
        r#"{"strategy":"in-git"}"#,
        r#"{"strategy":"lfs-remote"}"#,
        r#"{"strategy":"local-future"}"#,
        r#"{"strategy":"local","binaryRouting":{"version":2}}"#,
    ] {
        write_config(repo, assets);
        assert!(!repair_local_rules(&cli, repo).await.unwrap(), "{assets}");
        assert_eq!(gitignore(repo), stale, "{assets}");
    }
}

#[tokio::test]
async fn a_project_without_assets_config_has_the_local_default_block() {
    let Some((cli, temp)) = repo().await else {
        return;
    };
    let repo = temp.path();
    write(repo, ".svode/config.json", br#"{"name":"Project"}"#);

    assert!(repair_local_rules(&cli, repo).await.unwrap());
    assert!(ignored(&cli, repo, "photo.png").await);
}
