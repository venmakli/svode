use super::{Fixture, commit, git};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::{flow, staging_tests::TestHost, state::GitRuntime};
use std::path::Path;
use std::sync::Arc;

fn auto_sync(repo: &Path, enabled: bool) {
    std::fs::create_dir_all(repo.join(".svode")).unwrap();
    write_user_policy(
        repo,
        &GitUserPolicy {
            auto_sync: enabled,
            auto_commit_structural: true,
            auto_commit_system: false,
        },
    )
    .unwrap();
}

/// A Space revision published to its source, as the Space sync leaves it.
fn published_space(f: &Fixture, value: &str) -> String {
    commit(&f.child, "note", value);
    git(&f.child, &["push", "origin", "main"]);
    git(&f.child, &["rev-parse", "HEAD"])
}

async fn space_step(
    f: &Fixture,
    head: &str,
    background: bool,
    space_sync: bool,
) -> serde_json::Value {
    let outcome = flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        head,
        background,
        true,
        Ok(()),
        space_sync,
    )
    .await;
    serde_json::to_value(outcome).unwrap()
}

fn recorded(f: &Fixture) -> String {
    git(&f.root, &["rev-parse", "HEAD:Пространство one"])
}

#[tokio::test]
async fn pointer_only_project_commits_are_published_by_an_explicit_space_sync() {
    let f = Fixture::new();
    // An earlier local pointer and the new one: both only move the gitlink.
    published_space(&f, "first");
    f.pointer();
    let head = published_space(&f, "second");
    let outcome = space_step(&f, &head, false, true).await;
    assert_eq!(outcome["pointer"], "published", "{outcome}");
    assert!(outcome.get("unpublishedCommits").is_none());
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn unrelated_project_commits_keep_the_pointer_local() {
    let f = Fixture::new();
    let remote = git(&f.remote, &["rev-parse", "main"]);
    commit(&f.root, "Page.md", "root page");
    let head = published_space(&f, "space change");
    let outcome = space_step(&f, &head, false, true).await;
    assert_eq!(outcome["pointer"], "local", "{outcome}");
    assert_eq!(outcome["unpublishedCommits"], 2);
    assert!(outcome.get("result").is_none() && outcome.get("error").is_none());
    assert_eq!(recorded(&f), head);
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), remote);
    // The source of the Space keeps its publication.
    assert_eq!(git(&f.source, &["rev-parse", "main"]), head);
}

#[tokio::test]
async fn merge_commits_are_not_counted_as_project_changes() {
    let f = Fixture::new();
    git(&f.root, &["checkout", "-b", "side"]);
    published_space(&f, "side pointer");
    f.pointer();
    git(&f.root, &["checkout", "main"]);
    git(&f.root, &["merge", "--no-ff", "-m", "merge side", "side"]);
    let head = published_space(&f, "after merge");
    let outcome = space_step(&f, &head, false, true).await;
    assert_eq!(outcome["pointer"], "published", "{outcome}");
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn a_project_branch_without_upstream_keeps_the_pointer_local() {
    let f = Fixture::new();
    let remote = git(&f.remote, &["rev-parse", "main"]);
    git(&f.root, &["branch", "--unset-upstream"]);
    let head = published_space(&f, "space change");
    let outcome = space_step(&f, &head, false, true).await;
    assert_eq!(outcome["pointer"], "local", "{outcome}");
    assert_eq!(outcome["unpublishedCommits"], 1);
    assert_eq!(recorded(&f), head);
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), remote);
}

#[tokio::test]
async fn project_auto_sync_background_and_project_actions_skip_the_check() {
    for case in ["auto-sync", "background", "project"] {
        let f = Fixture::new();
        commit(&f.root, "Page.md", "root page");
        if case != "project" {
            auto_sync(&f.root, true);
        }
        let head = published_space(&f, "space change");
        let outcome = match case {
            "auto-sync" => space_step(&f, &head, false, true).await,
            "background" => space_step(&f, &head, true, false).await,
            _ => space_step(&f, &head, false, false).await,
        };
        assert_eq!(outcome["pointer"], "published", "{case}: {outcome}");
        assert!(outcome.get("unpublishedCommits").is_none(), "{case}");
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]),
            git(&f.root, &["rev-parse", "HEAD"]),
            "{case}"
        );
    }
}

#[tokio::test]
async fn explicit_space_sync_holds_the_project_and_its_retry_publishes_everything() {
    let f = Fixture::new();
    let remote = git(&f.remote, &["rev-parse", "main"]);
    commit(&f.root, "Page.md", "root page");
    commit(&f.child, "note", "space save");
    let runtime = Arc::new(GitRuntime::new());
    let host: Arc<dyn crate::git::host::GitHost> = Arc::new(TestHost::default());

    let report = flow::sync(&runtime, &host, &f.child, false).await.unwrap();
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    assert_eq!(git(&f.source, &["rev-parse", "main"]), head);
    let parent = report.parent.expect("parent step");
    assert!(matches!(parent.pointer, flow::PointerState::Local));
    assert_eq!(parent.unpublished_commits, Some(2));
    assert!(parent.result.is_none() && parent.error.is_none());
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), remote);
    assert_eq!(recorded(&f), head);

    let root = std::fs::canonicalize(&f.root).unwrap();
    let retried = flow::retry_parent(&runtime, &host, &f.child, &head, &root, &parent.target)
        .await
        .unwrap();
    let retried = serde_json::to_value(retried).unwrap();
    assert_eq!(retried["parent"]["pointer"], "published", "{retried}");
    assert!(retried["parent"].get("unpublishedCommits").is_none());
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}
