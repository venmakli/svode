//! Path sets beyond the command line limit of every OS (DF-270): a save or an
//! automatic commit of any size is one commit, the other Git calls with path
//! sets (sync, merge continuation, Page dates, the LFS check) take sets of any
//! size, no Git call exceeds the budget and the number of Git processes does
//! not follow the number of paths.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;

use super::GitError;
use super::autocommit::AutocommitService;
use super::cli::GitCli;
use super::policy::{GitUserPolicy, write_user_policy};
use super::save::save;
use super::staging_tests::{TestHost, cli, git, repo, write};
use super::state::GitRuntime;
use super::sync::{SyncResult, resolve_and_continue, sync};

/// The Windows command line limit the sets of these tests exceed.
const WINDOWS_LIMIT: usize = 32_767;

/// `count` files in `folder` with names of `name` characters. The defaults of
/// these tests keep each absolute path within the Windows path limit.
fn bulk(root: &Path, folder: &str, count: usize, name: usize) -> Vec<String> {
    (0..count)
        .map(|index| {
            let path = format!("{folder}/{index:05}-{}.md", "ж".repeat(name - 9));
            write(root, &path, &format!("{index}\n"));
            path
        })
        .collect()
}

fn length(paths: &[String]) -> usize {
    paths.iter().map(|path| path.chars().count() + 1).sum()
}

async fn commits(cli: &GitCli, root: &Path) -> usize {
    git(cli, root, &["rev-list", "--count", "HEAD"])
        .await
        .trim()
        .parse()
        .unwrap()
}

async fn tree(cli: &GitCli, root: &Path) -> Vec<String> {
    git(cli, root, &["ls-tree", "-r", "--name-only", "-z", "HEAD"])
        .await
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect()
}

async fn commit_all(cli: &GitCli, root: &Path, message: &str) {
    git(cli, root, &["add", "--all"]).await;
    git(cli, root, &["commit", "-q", "-m", message]).await;
}

#[tokio::test]
async fn saving_a_folder_beyond_the_command_line_limit_commits_it_once() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let paths = bulk(root, "Папка", 600, 60);
    assert!(length(&paths) > WINDOWS_LIMIT);

    save(
        &Arc::new(GitRuntime::new()),
        &TestHost::default(),
        None,
        root,
        Some(vec!["Папка".into()]),
    )
    .await
    .expect("folder save");

    assert_eq!(commits(&cli, root).await, 2);
    let tree = tree(&cli, root).await;
    assert!(paths.iter().all(|path| tree.contains(path)));
    assert_eq!(
        git(&cli, root, &["status", "--porcelain", "--", "Папка"]).await,
        ""
    );
}

#[tokio::test]
async fn saving_all_beyond_the_command_line_limit_commits_deletions_and_a_case_only_relocation_once()
 {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let removed = bulk(root, "old", 600, 60);
    let relocated = bulk(root, "Case", 600, 60);
    commit_all(&cli, root, "Tracked").await;
    std::fs::remove_dir_all(root.join("old")).unwrap();
    std::fs::rename(root.join("Case"), root.join("case")).unwrap();
    let added = bulk(root, "new", 600, 60);
    for set in [&removed, &relocated, &added] {
        assert!(length(set) > WINDOWS_LIMIT);
    }

    save(
        &Arc::new(GitRuntime::new()),
        &TestHost::default(),
        None,
        root,
        None,
    )
    .await
    .expect("save all");

    assert_eq!(commits(&cli, root).await, 3);
    let tree = tree(&cli, root).await;
    assert!(removed.iter().all(|path| !tree.contains(path)));
    assert!(relocated.iter().all(|path| !tree.contains(path)));
    assert!(
        relocated
            .iter()
            .all(|path| tree.contains(&path.replacen("Case", "case", 1)))
    );
    assert!(added.iter().all(|path| tree.contains(path)));
    assert_eq!(git(&cli, root, &["status", "--porcelain"]).await, "");
}

#[tokio::test]
async fn a_structural_commit_of_a_moved_folder_beyond_the_command_line_limit_is_one_commit() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write_user_policy(
        root,
        &GitUserPolicy {
            auto_sync: false,
            auto_commit_structural: true,
            auto_commit_system: false,
        },
    )
    .unwrap();
    let moved = bulk(root, "Source/Folder", 600, 60);
    assert!(length(&moved) > WINDOWS_LIMIT);
    commit_all(&cli, root, "Tracked").await;
    std::fs::create_dir(root.join("Target")).unwrap();
    std::fs::rename(root.join("Source/Folder"), root.join("Target/Folder")).unwrap();
    let before = commits(&cli, root).await;

    AutocommitService::new(Arc::new(GitRuntime::new()), Arc::new(TestHost::default()))
        .commit_structural_paths_now(
            root.to_path_buf(),
            root.to_path_buf(),
            vec![root.join("Source/Folder"), root.join("Target/Folder")],
            "Move Folder",
        )
        .await
        .expect("structural commit");

    assert_eq!(commits(&cli, root).await, before + 1);
    assert_eq!(
        git(&cli, root, &["log", "-1", "--format=%s"]).await.trim(),
        "Move Folder"
    );
    let tree = tree(&cli, root).await;
    assert!(moved.iter().all(|path| !tree.contains(path)));
    assert!(
        moved
            .iter()
            .all(|path| tree.contains(&path.replacen("Source", "Target", 1)))
    );
}

/// A Git wrapper that logs the command line cost of every call, counted as
/// the budget counts it, before it runs the real Git.
#[cfg(unix)]
fn counting_cli(dir: &Path, real: &GitCli) -> (GitCli, std::path::PathBuf) {
    let script = dir.join("counting-git");
    let log = dir.join("calls.log");
    svode_testkit::write_executable(
        &script,
        format!(
            "#!/bin/sh\nn=$(( ${{#0}} + 3 ))\nfor arg in \"$@\"; do n=$(( n + ${{#arg}} + 3 )); done\necho \"$n\" >> '{}'\nexec '{}' \"$@\"\n",
            log.display(),
            real.git_path().display()
        ),
    )
    .unwrap();
    (GitCli::for_test(script), log)
}

/// Commit `count` new files and the deletion of `count / 2` tracked ones in
/// one set and return the cost of each Git call.
#[cfg(unix)]
async fn commit_calls(count: usize) -> Vec<usize> {
    let real = cli();
    let tmp = repo(&real, true).await;
    let root = tmp.path();
    let removed = (0..count / 2)
        .map(|index| format!("gone/file-{index:05}.md"))
        .collect::<Vec<_>>();
    for path in &removed {
        write(root, path, "tracked\n");
    }
    commit_all(&real, root, "Tracked").await;
    std::fs::remove_dir_all(root.join("gone")).unwrap();
    let mut paths = (0..count)
        .map(|index| format!("new/file-{index:05}.md"))
        .collect::<Vec<_>>();
    for path in &paths {
        write(root, path, "new\n");
    }
    paths.extend(removed);
    let dir = tempfile::TempDir::new().unwrap();
    let (counting, log) = counting_cli(dir.path(), &real);
    assert!(
        super::ops::commit_paths(&counting, root, &paths)
            .await
            .unwrap()
    );
    assert_eq!(commits(&real, root).await, 3);
    assert_eq!(git(&real, root, &["status", "--porcelain"]).await, "");
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|cost| cost.parse().unwrap())
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn the_git_calls_of_a_path_set_stay_within_the_budget_and_do_not_follow_its_size() {
    let small = commit_calls(30).await;
    let large = commit_calls(6_000).await;
    let budget = super::cli::PATH_SET_COMMAND_LINE_BUDGET;
    assert!(large.iter().all(|cost| *cost <= budget), "{large:?}");
    // 200 times the paths take a few more batches of reads, not a process each.
    assert!(
        large.len() <= small.len() + 30,
        "{} calls for 45 paths, {} for 9 000",
        small.len(),
        large.len()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_path_set_beyond_the_macos_argument_limit_commits_once() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let paths = (0..4_400)
        .map(|index| {
            let path = format!("long/{index:05}-{}.md", "x".repeat(230));
            write(root, &path, "");
            path
        })
        .collect::<Vec<_>>();
    assert!(length(&paths) > 1_048_576);

    assert!(
        super::ops::commit_paths(&cli, root, &["long".into()])
            .await
            .unwrap()
    );
    assert_eq!(commits(&cli, root).await, 2);
    assert_eq!(tree(&cli, root).await.len(), paths.len() + 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_hook_on_a_large_set_is_a_save_failure_of_the_commit() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let paths = bulk(root, "Папка", 600, 60);
    svode_testkit::write_executable(root.join(".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n")
        .unwrap();

    let error = super::ops::commit_paths(&cli, root, &["Папка".into()])
        .await
        .unwrap_err();

    let GitError::SaveFailed {
        stage,
        reason,
        exit_code,
        path_count,
        path_sample,
    } = error
    else {
        panic!("{error:?}");
    };
    assert_eq!(
        (stage, reason, exit_code),
        ("commit", "command_failed", Some(1))
    );
    assert_eq!(path_count, paths.len());
    assert_eq!(path_sample.as_deref(), Some(paths[0].as_str()));
    assert_eq!(commits(&cli, root).await, 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_space_pointer_check_is_a_save_failure_of_the_preparation() {
    let real = cli();
    let (tmp, _child) = super::staging_tests::submodule_project(&real).await;
    let root = tmp.path();
    write(root, "page.md", "page\n");
    let fault = tempfile::TempDir::new().unwrap();
    // Only the pointer read lists HEAD entries with their modes.
    let cli = super::staging_tests::fault_cli(
        fault.path(),
        &real,
        "case \" $* \" in *\" ls-tree -r -z HEAD \"*) exit 128;; esac",
    );

    let error = super::ops::commit_paths(&cli, root, &["page.md".into(), "Исследования".into()])
        .await
        .unwrap_err();

    let GitError::SaveFailed {
        stage,
        reason,
        path_count,
        ..
    } = error
    else {
        panic!("{error:?}");
    };
    assert_eq!(
        (stage, reason, path_count),
        ("prepare", "inventory_failed", 2)
    );
}

/// Acceptance 3 of DF-270 on the development machine: «Save all» of
/// `count` new files with names of 250 characters, timed.
#[cfg(unix)]
async fn save_all_long_names(count: usize) {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    std::fs::create_dir(root.join("bulk")).unwrap();
    for index in 0..count {
        std::fs::write(
            root.join(format!("bulk/{index:05}-{}.md", "x".repeat(242))),
            "",
        )
        .unwrap();
    }
    let started = std::time::Instant::now();
    save(
        &Arc::new(GitRuntime::new()),
        &TestHost::default(),
        None,
        root,
        None,
    )
    .await
    .expect("save all");
    let elapsed = started.elapsed();
    eprintln!("save all of {count} paths: {elapsed:?}");
    assert_eq!(commits(&cli, root).await, 2);
    let tree = tree(&cli, root).await;
    assert_eq!(
        tree.iter().filter(|path| path.starts_with("bulk/")).count(),
        count
    );
    assert!(elapsed.as_secs() <= 60, "{elapsed:?}");
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "timing probe of DF-270 acceptance 3, run on demand"]
async fn saving_all_of_17_000_long_paths_takes_at_most_a_minute() {
    save_all_long_names(17_000).await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "timing probe of DF-240 and DF-270 beyond the status list, run on demand"]
async fn saving_all_of_21_000_long_paths_takes_at_most_a_minute() {
    save_all_long_names(21_000).await;
}

/// Clones `local` and `other` of a remote seeded with `count` files of long
/// names in `Папка`, and those paths.
async fn clones(cli: &GitCli, count: usize) -> (TempDir, PathBuf, PathBuf, Vec<String>) {
    let seed = repo(cli, true).await;
    let paths = bulk(seed.path(), "Папка", count, 60);
    commit_all(cli, seed.path(), "Seed").await;
    let tmp = TempDir::new().unwrap();
    let remote = tmp.path().join("remote.git");
    let remote = remote.to_str().unwrap();
    let seed = seed.path().to_str().unwrap();
    git(cli, tmp.path(), &["clone", "-q", "--bare", seed, remote]).await;
    let [local, other] = ["local", "other"].map(|name| tmp.path().join(name));
    for clone in [&local, &other] {
        git(
            cli,
            tmp.path(),
            &["clone", "-q", remote, clone.to_str().unwrap()],
        )
        .await;
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.test"),
            ("commit.gpgsign", "false"),
        ] {
            git(cli, clone, &["config", key, value]).await;
        }
    }
    (tmp, local, other, paths)
}

/// `local` behind a remote commit that edits its `count` tracked files and
/// adds `count` new ones, with the same edits and new files uncommitted in
/// `local`, and the paths of both.
async fn matching_edits(cli: &GitCli, count: usize) -> (TempDir, PathBuf, Vec<String>) {
    let (tmp, local, other, mut paths) = clones(cli, count).await;
    let mut added = Vec::new();
    for clone in [&other, &local] {
        for path in &paths {
            write(clone, path, "incoming\n");
        }
        added = bulk(clone, "Новое", count, 60);
    }
    commit_all(cli, &other, "Incoming").await;
    git(cli, &other, &["push", "-q", "origin", "HEAD"]).await;
    paths.extend(added);
    (tmp, local, paths)
}

/// `local` and the remote each commit a different edit of the `count`
/// tracked files.
async fn conflicting_edits(cli: &GitCli, count: usize) -> (TempDir, PathBuf, Vec<String>) {
    let (tmp, local, other, paths) = clones(cli, count).await;
    for (clone, content) in [(&other, "theirs\n"), (&local, "ours\n")] {
        for path in &paths {
            write(clone, path, content);
        }
        commit_all(cli, clone, "Edit").await;
    }
    git(cli, &other, &["push", "-q", "origin", "HEAD"]).await;
    (tmp, local, paths)
}

/// Sync of `local` stops on a conflict in exactly `paths`.
async fn conflict(cli: &GitCli, local: &Path, paths: &[String]) -> Vec<String> {
    let result = sync(cli, local).await;
    let Ok(SyncResult::Conflict { mut files }) = result else {
        panic!("{result:?}");
    };
    files.sort();
    let mut expected = paths.to_vec();
    expected.sort();
    assert_eq!(files, expected);
    files
}

async fn assert_synced(cli: &GitCli, local: &Path) {
    assert_eq!(git(cli, local, &["status", "--porcelain"]).await, "");
    assert_eq!(
        git(cli, local, &["rev-parse", "HEAD"]).await,
        git(cli, local, &["rev-parse", "@{upstream}"]).await
    );
}

#[tokio::test]
async fn edits_equal_to_incoming_beyond_the_command_line_limit_do_not_block_sync() {
    let cli = cli();
    let (_tmp, local, paths) = matching_edits(&cli, 600).await;
    let (tracked, added) = paths.split_at(600);
    assert!(length(tracked) > WINDOWS_LIMIT && length(added) > WINDOWS_LIMIT);

    let result = sync(&cli, &local).await;

    assert!(
        matches!(result, Ok(SyncResult::Success { .. })),
        "{result:?}"
    );
    assert_synced(&cli, &local).await;
    let content = |path: &String| {
        std::fs::read_to_string(local.join(path))
            .unwrap()
            .replace('\r', "")
    };
    assert!(tracked.iter().all(|path| content(path) == "incoming\n"));
    for (index, path) in added.iter().enumerate() {
        assert_eq!(content(path), format!("{index}\n"));
    }
}

#[tokio::test]
async fn continuing_a_merge_beyond_the_command_line_limit_commits_every_resolved_path() {
    let cli = cli();
    let (_tmp, local, paths) = conflicting_edits(&cli, 600).await;
    assert!(length(&paths) > WINDOWS_LIMIT);
    let files = conflict(&cli, &local, &paths).await;
    let (last, resolved) = files.split_last().unwrap();
    for path in resolved {
        write(&local, path, "resolved\n");
    }

    // A marker left in one file of the set refuses the whole set.
    let refusal = resolve_and_continue(&cli, &local, &files).await;
    assert!(
        matches!(&refusal, Err(GitError::Conflict(message)) if message.contains(last.as_str())),
        "{refusal:?}"
    );
    let unmerged = git(&cli, &local, &["ls-files", "--unmerged", "-z"]).await;
    assert_eq!(
        unmerged.split('\0').filter(|r| !r.is_empty()).count(),
        3 * files.len()
    );

    write(&local, last, "resolved\n");
    let result = resolve_and_continue(&cli, &local, &files).await;

    assert!(
        matches!(result, Ok(SyncResult::Success { .. })),
        "{result:?}"
    );
    assert_synced(&cli, &local).await;
    let parents = git(&cli, &local, &["rev-list", "--parents", "-n", "1", "HEAD"]).await;
    assert_eq!(parents.split_whitespace().count(), 3);
    for path in [&files[0], last] {
        let blob = format!("HEAD:{path}");
        assert_eq!(git(&cli, &local, &["show", &blob]).await, "resolved\n");
    }
}

#[tokio::test]
async fn page_dates_of_a_path_set_beyond_the_command_line_limit_cover_every_path() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    // 256 such paths, the former batch, are beyond the Windows limit too.
    let paths = bulk(root, "Папка/Вложенная папка с длинным именем", 300, 110);
    assert!(length(&paths[..256]) > WINDOWS_LIMIT);
    commit_all(&cli, root, "Pages").await;
    write(root, &paths[0], "edited\n");

    let dates = crate::page::dates::derive_date_overrides(&cli, root, &paths).await;

    assert_eq!(dates.len(), paths.len());
    for (index, path) in paths.iter().enumerate() {
        let date = &dates[path];
        assert!(date.created.is_some(), "{path}");
        // A Page with uncommitted edits keeps its own modification date.
        assert_eq!(date.updated.is_some(), index > 0, "{path}");
    }
}

#[tokio::test]
async fn the_lfs_filter_check_of_a_path_set_beyond_the_command_line_limit_answers_every_path() {
    let cli = cli();
    let tmp = repo(&cli, false).await;
    let root = tmp.path();
    write(
        root,
        ".gitattributes",
        "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    let paths = (0..300)
        .map(|index| {
            let extension = if index % 2 == 0 { "png" } else { "md" };
            format!("Папка/{index:05}-{}.{extension}", "ж".repeat(250))
        })
        .collect::<Vec<_>>();
    // 128 such paths, the former batch, are beyond the Windows limit too.
    assert!(length(&paths[..128]) > WINDOWS_LIMIT);

    let checks = crate::storage::policy::check_lfs_filters(&cli, root, &paths)
        .await
        .unwrap();

    assert_eq!(checks.len(), paths.len());
    for (check, path) in checks.iter().zip(&paths) {
        assert_eq!(&check.path, path);
        let expected = if path.ends_with(".png") {
            "lfs"
        } else {
            "unspecified"
        };
        assert_eq!(check.value, expected, "{path}");
    }
}

#[cfg(unix)]
fn costs(log: &Path) -> Vec<usize> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(|cost| cost.parse().unwrap())
        .collect()
}

/// Costs of the Git calls of a sync that sets aside `count` matching edits
/// and `count` matching new files, and of continuing a merge with `count`
/// resolved paths.
#[cfg(unix)]
async fn sync_and_continuation_calls(count: usize) -> (Vec<usize>, Vec<usize>) {
    let real = cli();
    let (tmp, local, _) = matching_edits(&real, count).await;
    let (counting, log) = counting_cli(tmp.path(), &real);
    let result = sync(&counting, &local).await;
    assert!(
        matches!(result, Ok(SyncResult::Success { .. })),
        "{result:?}"
    );
    let set_aside = costs(&log);

    let (tmp, local, paths) = conflicting_edits(&real, count).await;
    let files = conflict(&real, &local, &paths).await;
    for path in &files {
        write(&local, path, "resolved\n");
    }
    let (counting, log) = counting_cli(tmp.path(), &real);
    let result = resolve_and_continue(&counting, &local, &files).await;
    assert!(
        matches!(result, Ok(SyncResult::Success { .. })),
        "{result:?}"
    );
    (set_aside, costs(&log))
}

#[cfg(unix)]
#[tokio::test]
async fn the_git_calls_of_sync_and_merge_continuation_stay_within_the_budget_and_do_not_follow_the_set_size()
 {
    let (small_sync, small_resolve) = sync_and_continuation_calls(3).await;
    let (large_sync, large_resolve) = sync_and_continuation_calls(600).await;
    let budget = super::cli::PATH_SET_COMMAND_LINE_BUDGET;
    for calls in [&large_sync, &large_resolve] {
        assert!(calls.iter().all(|cost| *cost <= budget), "{calls:?}");
    }
    // 200 times the paths take a few more batches of reads, not a process each.
    assert!(
        large_sync.len() <= small_sync.len() + 30,
        "{} sync calls for 6 paths, {} for 1 200",
        small_sync.len(),
        large_sync.len()
    );
    assert_eq!(large_resolve.len(), small_resolve.len());
}
