//! Path sets beyond the command line limit of every OS (DF-270): a save or an
//! automatic commit of any size is one commit, no Git call exceeds the budget
//! and the number of Git processes does not follow the number of paths.

use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use super::GitError;
use super::autocommit::AutocommitService;
use super::cli::GitCli;
use super::policy::{GitUserPolicy, write_user_policy};
use super::save::save;
use super::staging_tests::{TestHost, cli, git, repo, write};
use super::state::GitRuntime;

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
