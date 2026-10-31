//! Automatic versions over real repositories (Stage 11 1.E): the content
//! flag and its routing, the closing events, the states in which versions
//! wait, a refused commit and the separation of kinds of commits.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::MessageLanguage;
use super::auto::{AutoVersions, Closing, Held, close, enabled, repository_of};
use crate::git::autocommit::{AutocommitService, SystemCommitKind};
use crate::git::diagnostics::{GitFailureCause, GitStage};
use crate::git::pending::{Relocation, StructuralChange, StructuralOp};
use crate::git::policy::{GitUserPolicy, effective_user_policy, write_user_policy};
use crate::git::staging_tests::{TestHost, cli, git, repo, submodule_project, write};
use crate::git::state::GitRuntime;

const PAUSE: Duration = Duration::from_secs(60);

fn content_on(repo: &Path) {
    set_policy(
        repo,
        GitUserPolicy {
            auto_commit_content: true,
            ..GitUserPolicy::default()
        },
    );
}

fn set_policy(repo: &Path, policy: GitUserPolicy) {
    write_user_policy(repo, &policy).expect("write policy");
}

/// Mark the last change of a file `ago` in the past.
fn changed_ago(repo: &Path, path: &str, ago: Duration) {
    std::fs::File::options()
        .write(true)
        .open(repo.join(path))
        .expect("open")
        .set_modified(SystemTime::now() - ago)
        .expect("set modified");
}

async fn commit_all(root: &Path) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Base"]).await;
}

async fn log(root: &Path) -> Vec<String> {
    git(&cli(), root, &["log", "--format=%s"])
        .await
        .lines()
        .map(str::to_string)
        .collect()
}

async fn dirty(root: &Path) -> Vec<String> {
    let mut paths = git(&cli(), root, &["status", "--porcelain", "-uall"])
        .await
        .lines()
        .map(|line| line[3..].to_string())
        .filter(|path| !crate::git::policy::contains(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

/// The files of the last commit.
async fn last_commit(root: &Path) -> Vec<String> {
    let mut paths = git(
        &cli(),
        root,
        &["show", "--name-only", "--no-renames", "--format=", "HEAD"],
    )
    .await
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    paths.sort();
    paths
}

struct Fixture {
    runtime: GitRuntime,
    host: TestHost,
}

impl Fixture {
    fn new() -> Self {
        Self {
            runtime: GitRuntime::with_cli(cli()),
            host: TestHost::default(),
        }
    }

    async fn close(&self, repo: &Path, closing: Closing) -> AutoVersions {
        close(
            &self.runtime,
            &self.host,
            repo,
            &closing,
            MessageLanguage::En,
        )
        .await
        .expect("close")
    }
}

/// A born repository with two committed Pages.
async fn pages() -> tempfile::TempDir {
    let tmp = repo(&cli(), true).await;
    write(tmp.path(), "a.md", "---\ntitle: A\n---\nA\n");
    write(tmp.path(), "b.md", "---\ntitle: B\n---\nB\n");
    write(tmp.path(), ".gitignore", ".svode/local.json\n");
    commit_all(tmp.path()).await;
    tmp
}

#[test]
fn the_content_flag_is_off_by_default_and_existing_flags_keep_their_values() {
    let temp = tempfile::tempdir().expect("temp dir");
    assert!(!GitUserPolicy::default().auto_commit_content);
    assert!(!enabled(temp.path()));
    std::fs::create_dir_all(temp.path().join(".svode")).unwrap();
    std::fs::write(
        temp.path().join(".svode/local.json"),
        r#"{"git":{"autoSync":true,"autoCommitStructural":true,"autoCommitSystem":true}}"#,
    )
    .unwrap();
    assert_eq!(
        effective_user_policy(temp.path()),
        GitUserPolicy {
            auto_sync: true,
            auto_commit_structural: true,
            auto_commit_system: true,
            auto_commit_content: false,
        }
    );
    content_on(temp.path());
    assert!(enabled(temp.path()));
    let written = std::fs::read_to_string(temp.path().join(".svode/local.json")).unwrap();
    assert!(written.contains("\"autoCommitContent\": true"), "{written}");
}

#[tokio::test]
async fn the_flag_routes_like_the_other_flags_for_inline_independent_and_submodule_spaces() {
    let cli = cli();
    let (project, child) = submodule_project(&cli).await;
    let root = project.path();
    let inline = root.join("Inline");
    std::fs::create_dir_all(&inline).unwrap();
    let independent = repo(&cli, true).await;

    // An Inline Space reads the flags of the project root.
    assert_eq!(repository_of(&inline).as_deref(), Some(root));
    // Independent and Submodule Spaces read their own.
    assert_eq!(
        repository_of(independent.path()).as_deref(),
        Some(independent.path())
    );
    assert_eq!(repository_of(&child).as_deref(), Some(child.as_path()));

    content_on(root);
    assert!(enabled(&repository_of(&inline).unwrap()));
    assert!(!enabled(&repository_of(&child).unwrap()));
    assert!(!enabled(&repository_of(independent.path()).unwrap()));
    content_on(&child);
    content_on(independent.path());
    set_policy(root, GitUserPolicy::default());
    assert!(!enabled(&repository_of(&inline).unwrap()));
    assert!(enabled(&repository_of(&child).unwrap()));
    assert!(enabled(&repository_of(independent.path()).unwrap()));
}

#[tokio::test]
async fn without_the_flag_no_versions_are_created() {
    let tmp = pages().await;
    let root = tmp.path();
    write(root, "a.md", "---\ntitle: A\n---\nEdited\n");
    let fixture = Fixture::new();
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Off
    );
    assert_eq!(dirty(root).await, ["a.md"]);
}

#[tokio::test]
async fn a_pause_closes_only_the_groups_idle_for_it() {
    let tmp = pages().await;
    let root = tmp.path();
    content_on(root);
    write(root, "a.md", "---\ntitle: A\n---\nEdited long ago\n");
    changed_ago(root, "a.md", Duration::from_secs(90));
    write(root, "b.md", "---\ntitle: B\n---\nEditing now\n");
    changed_ago(root, "b.md", Duration::from_secs(20));
    let fixture = Fixture::new();

    let AutoVersions::Done { commits, next } = fixture.close(root, Closing::paused(PAUSE)).await
    else {
        panic!("versions expected");
    };
    assert_eq!(commits, 1);
    // The open group reaches the pause in about 40 seconds: a version comes
    // well within 2 minutes of its last change.
    let next = next.expect("open group");
    assert!(
        next <= Duration::from_secs(41) && next >= Duration::from_secs(35),
        "{next:?}"
    );
    assert_eq!(last_commit(root).await, ["a.md"]);
    assert_eq!(dirty(root).await, ["b.md"]);
    assert_eq!(fixture.host.commits.lock().unwrap().len(), 1);

    changed_ago(root, "b.md", Duration::from_secs(61));
    assert_eq!(
        fixture.close(root, Closing::paused(PAUSE)).await,
        AutoVersions::Done {
            commits: 1,
            next: None
        }
    );
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn leaving_a_page_and_closing_all_create_versions_at_once() {
    let tmp = pages().await;
    let root = tmp.path();
    content_on(root);
    write(root, "a.md", "---\ntitle: A\n---\nA2\n");
    write(root, "b.md", "---\ntitle: B\n---\nB2\n");
    write(root, "Docs/c.md", "---\ntitle: C\n---\nC\n");
    let fixture = Fixture::new();

    // Leaving the Page closes its group only.
    let left = Closing {
        left: vec!["a.md".into()],
        ..Closing::paused(PAUSE)
    };
    assert!(matches!(
        fixture.close(root, left).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert_eq!(last_commit(root).await, ["a.md"]);

    // Leaving a folder or Collection closes the groups under it.
    let left = Closing {
        left: vec!["Docs".into()],
        ..Closing::paused(PAUSE)
    };
    assert!(matches!(
        fixture.close(root, left).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert_eq!(last_commit(root).await, ["Docs/c.md"]);

    // Leaving the window, a sync and quitting close every group.
    assert!(matches!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert!(dirty(root).await.is_empty());
    let log = log(root).await;
    assert_eq!(log.len(), 5, "{log:?}");
}

#[tokio::test]
async fn an_operation_on_a_committed_page_closes_right_after_it() {
    let tmp = pages().await;
    let root = tmp.path();
    content_on(root);
    let fixture = Fixture::new();
    git(&cli(), root, &["mv", "a.md", "renamed.md"]).await;
    git(&cli(), root, &["reset", "-q"]).await;
    fixture.runtime.pending().record(
        root,
        Some(
            StructuralChange::new(StructuralOp::Rename {
                old: "A".into(),
                new: "Renamed".into(),
            })
            .relocating(Relocation {
                source: root.join("a.md"),
                target: root.join("renamed.md"),
            }),
        ),
        vec![root.join("a.md"), root.join("renamed.md")],
    );
    // A Page edited a moment ago stays open.
    write(root, "b.md", "---\ntitle: B\n---\nB2\n");

    assert!(matches!(
        fixture.close(root, Closing::paused(PAUSE)).await,
        AutoVersions::Done {
            commits: 1,
            next: Some(_)
        }
    ));
    assert_eq!(last_commit(root).await, ["a.md", "renamed.md"]);
    assert_eq!(dirty(root).await, ["b.md"]);
    // The registration landed with its version.
    assert!(fixture.runtime.pending().peek_under(root).is_empty());
}

#[tokio::test]
async fn versions_wait_during_a_merge_conflicts_and_a_detached_head() {
    let cli = cli();
    let tmp = pages().await;
    let root = tmp.path();
    content_on(root);
    let fixture = Fixture::new();
    let main = git(&cli, root, &["symbolic-ref", "--short", "HEAD"]).await;
    let main = main.trim();

    // A merge stopped by a conflict.
    git(&cli, root, &["checkout", "-q", "-b", "other"]).await;
    write(root, "a.md", "---\ntitle: A\n---\nTheirs\n");
    commit_all(root).await;
    git(&cli, root, &["checkout", "-q", main]).await;
    write(root, "a.md", "---\ntitle: A\n---\nMine\n");
    commit_all(root).await;
    let merge = cli.exec(root, &["merge", "other"]).await.unwrap();
    assert_ne!(merge.exit_code, 0);
    write(root, "b.md", "---\ntitle: B\n---\nDuring the merge\n");
    let head = git(&cli, root, &["rev-parse", "HEAD"]).await;
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Held(Held::Operation)
    );

    // Files in conflict with no operation.
    std::fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Held(Held::Conflicts)
    );
    assert_eq!(git(&cli, root, &["rev-parse", "HEAD"]).await, head);

    // After the state ends, the edits become versions.
    git(&cli, root, &["checkout", "-q", "--ours", "a.md"]).await;
    git(&cli, root, &["reset", "-q"]).await;
    assert!(matches!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert_eq!(last_commit(root).await, ["b.md"]);

    // A detached HEAD.
    git(&cli, root, &["checkout", "-q", "--detach"]).await;
    write(root, "b.md", "---\ntitle: B\n---\nDetached\n");
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Held(Held::DetachedHead)
    );
    git(&cli, root, &["checkout", "-q", main]).await;
    assert!(matches!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert!(dirty(root).await.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_refused_commit_names_its_cause_and_keeps_the_edits() {
    let tmp = pages().await;
    let root = tmp.path();
    content_on(root);
    let fixture = Fixture::new();
    write(root, "a.md", "---\ntitle: A\n---\nA2\n");
    let hook = root.join(".git/hooks/pre-commit");
    svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();

    let error = close(
        &fixture.runtime,
        &fixture.host,
        root,
        &Closing::all(PAUSE),
        MessageLanguage::En,
    )
    .await
    .unwrap_err();
    let failure = error.failure().expect("failure");
    assert_eq!(failure.stage, GitStage::Commit);
    assert_eq!(failure.cause, Some(GitFailureCause::Hook));
    assert_eq!(dirty(root).await, ["a.md"]);
    assert!(fixture.host.commits.lock().unwrap().is_empty());

    // The next closing tries again.
    std::fs::remove_file(&hook).unwrap();
    assert!(matches!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Done { commits: 1, .. }
    ));
}

#[tokio::test]
async fn versions_never_take_system_or_structural_paths_and_system_commits_never_take_content() {
    let cli = cli();
    let tmp = pages().await;
    let root = tmp.path();
    write(root, ".svode/config.json", "{\"name\":\"Root\"}\n");
    commit_all(root).await;
    set_policy(
        root,
        GitUserPolicy {
            auto_commit_content: true,
            auto_commit_system: true,
            ..GitUserPolicy::default()
        },
    );
    let fixture = Fixture::new();
    write(root, "a.md", "---\ntitle: A\n---\nA2\n");
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    write(root, ".gitignore", ".svode/local.json\n*.tmp\n");
    write(
        root,
        ".gitmodules",
        "[submodule \"x\"]\n\tpath = x\n\turl = ./x\n",
    );

    assert!(matches!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert_eq!(last_commit(root).await, ["a.md"]);
    assert_eq!(
        dirty(root).await,
        [".gitignore", ".gitmodules", ".svode/config.json"]
    );

    write(root, "b.md", "---\ntitle: B\n---\nB2\n");
    let service = AutocommitService::new(
        std::sync::Arc::new(GitRuntime::with_cli(cli.clone())),
        std::sync::Arc::new(TestHost::default()),
    );
    service
        .commit_system_now(
            root.to_path_buf(),
            root.to_path_buf(),
            SystemCommitKind::SpaceConfig,
        )
        .await
        .expect("system commit");
    assert_eq!(last_commit(root).await, [".svode/config.json"]);
    assert_eq!(dirty(root).await, [".gitignore", ".gitmodules", "b.md"]);
}

#[tokio::test]
async fn a_submodule_version_commits_its_pointer_only_with_structural_commits_in_the_project() {
    let cli = cli();
    for structural in [false, true] {
        let (project, child) = submodule_project(&cli).await;
        let root = project.path();
        content_on(&child);
        set_policy(
            root,
            GitUserPolicy {
                auto_commit_structural: structural,
                ..GitUserPolicy::default()
            },
        );
        let root_head = git(&cli, root, &["rev-parse", "HEAD"]).await;
        write(&child, "README.md", "child edited\n");
        let fixture = Fixture::new();

        assert!(matches!(
            fixture.close(&child, Closing::all(PAUSE)).await,
            AutoVersions::Done { commits: 1, .. }
        ));
        assert_eq!(last_commit(&child).await, ["README.md"]);
        let moved = git(&cli, root, &["rev-parse", "HEAD"]).await != root_head;
        assert_eq!(moved, structural, "structural {structural}");
        if structural {
            assert_eq!(last_commit(root).await, ["Исследования"]);
        }
    }
}

#[test]
fn registrations_are_peeked_by_the_spaces_of_a_repository() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let pending = crate::git::pending::PendingPaths::default();
    let inline: PathBuf = root.join("Inline");
    pending.record(&inline, None, vec![inline.join("a.md")]);
    pending.record(
        Path::new("/elsewhere"),
        None,
        vec![PathBuf::from("/elsewhere/b.md")],
    );
    let peeked = pending.peek_under(root);
    assert_eq!(peeked.len(), 1);
    assert_eq!(peeked[0].space, inline);
    // Peeking takes nothing.
    assert_eq!(pending.peek_under(root).len(), 1);
}

#[tokio::test]
async fn a_registered_operation_reaches_the_host_and_waits_for_a_commit() {
    let host = std::sync::Arc::new(TestHost::default());
    let runtime = std::sync::Arc::new(GitRuntime::with_cli(cli()));
    let service = AutocommitService::new(runtime.clone(), host.clone());
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().to_path_buf();
    let space = project.join("Inline");
    std::fs::create_dir_all(&space).unwrap();
    service.schedule_structural_paths(
        project.clone(),
        space.clone(),
        StructuralChange::new(StructuralOp::Delete("a.md".into())),
        vec![space.join("a.md")],
    );
    service
        .commit_paths_now(
            project.clone(),
            space.clone(),
            vec![space.join("schema.yaml")],
            String::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        *host.content_recorded.lock().unwrap(),
        [space.clone(), space]
    );
    assert_eq!(runtime.pending().peek_under(&project).len(), 2);
}
