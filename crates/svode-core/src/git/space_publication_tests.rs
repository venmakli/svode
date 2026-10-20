use super::blockers_tests::add_space;
use super::{Fixture, commit, git};
use crate::git::flow::{self, SpaceStepStatus, SpacesPublication};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::{GitError, publication::PublicationBlockReason, publication::SpaceBlockClass};
use crate::git::{host::GitHost, staging_tests::TestHost, state::GitRuntime};
use std::path::Path;
use std::sync::Arc;

const ONE: &str = "Пространство one";

fn runtime() -> Arc<GitRuntime> {
    Arc::new(GitRuntime::new())
}

fn policy(repo: &Path, auto_sync: bool, structural: bool) {
    std::fs::create_dir_all(repo.join(".svode")).unwrap();
    write_user_policy(
        repo,
        &GitUserPolicy {
            auto_sync,
            auto_commit_structural: structural,
            auto_commit_system: false,
        },
    )
    .unwrap();
}

fn head(repo: &Path) -> String {
    git(repo, &["rev-parse", "HEAD"])
}

fn main_of(source: &Path) -> String {
    git(source, &["rev-parse", "main"])
}

fn pointers(f: &Fixture, paths: &[&str], message: &str) {
    for path in paths {
        git(&f.root, &["add", path]);
    }
    git(&f.root, &["commit", "-m", message]);
}

fn steps(publication: &SpacesPublication) -> Vec<(String, SpaceStepStatus)> {
    publication
        .spaces
        .iter()
        .map(|step| (step.path.clone(), step.status))
        .collect()
}

fn blocked(error: &GitError) -> Vec<(String, SpaceBlockClass)> {
    match error {
        GitError::PublicationBlocked {
            reason: PublicationBlockReason::Spaces { spaces },
            ..
        } => spaces
            .iter()
            .map(|space| (space.path.clone(), space.class))
            .collect(),
        other => panic!("{other:?}"),
    }
}

async fn publish(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    f: &Fixture,
    spaces: &[&str],
) -> SpacesPublication {
    let spaces = spaces
        .iter()
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    flow::publish_spaces(runtime, host, &f.root, &spaces)
        .await
        .unwrap()
}

/// A published Space checkout matches what its explicit sync leaves.
fn assert_synced_space(space: &Path, source: &Path) {
    assert_eq!(head(space), main_of(source));
    assert_eq!(git(space, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(git(space, &["rev-parse", "origin/main"]), head(space));
}

#[tokio::test]
async fn publishable_spaces_are_published_one_by_one_before_the_project() {
    let f = Fixture::new();
    let (second, second_source) = add_space(&f, "second");
    commit(&f.child, "note", "first local");
    commit(&second, "note", "second local");
    pointers(&f, &[ONE, "second"], "pointers");
    let remote = main_of(&f.remote);
    let sources = (main_of(&f.source), main_of(&second_source));
    let runtime = runtime();
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

    // The ordinary explicit project sync still publishes no Space.
    let error = flow::sync(&runtime, &host, &f.root, false)
        .await
        .unwrap_err();
    assert_eq!(
        blocked(&error),
        vec![
            ("second".to_owned(), SpaceBlockClass::LocalCommits),
            (ONE.to_owned(), SpaceBlockClass::LocalCommits),
        ]
    );
    assert_eq!(
        (main_of(&f.source), main_of(&second_source)),
        sources.clone()
    );
    assert_eq!(main_of(&f.remote), remote);

    let publication = publish(&runtime, &host, &f, &[ONE, "second"]).await;
    assert_eq!(
        steps(&publication),
        vec![
            ("second".to_owned(), SpaceStepStatus::Published),
            (ONE.to_owned(), SpaceStepStatus::Published),
        ]
    );
    for step in &publication.spaces {
        let parent = step.report.as_ref().unwrap().parent.as_ref().unwrap();
        // The pointer step records the Space without its own project sync.
        assert!(
            parent.result.is_none() && parent.error.is_none(),
            "{parent:?}"
        );
    }
    let project = serde_json::to_value(publication.project.unwrap()).unwrap();
    assert_eq!(project["type"], "success", "{project}");
    assert!(publication.project_error.is_none());
    assert_synced_space(&f.child, &f.source);
    assert_synced_space(&second, &second_source);
    assert_eq!(main_of(&f.remote), head(&f.root));
    assert_eq!(
        git(&f.remote, &["rev-parse", &format!("main:{ONE}")]),
        head(&f.child)
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main:second"]), head(&second));
}

#[tokio::test]
async fn spaces_outside_the_set_or_of_other_classes_stay_untouched_without_a_project_sync() {
    let f = Fixture::new();
    let (second, second_source) = add_space(&f, "second");
    let (third, third_source) = add_space(&f, "third");
    commit(&f.child, "note", "taken");
    // A publishable Space the user cannot publish is left out of the set.
    commit(&second, "note", "left out");
    git(&third, &["checkout", "-b", "topic"]);
    commit(&third, "note", "outside the current branch");
    git(&third, &["checkout", "main"]);
    pointers(&f, &[ONE, "second"], "pointers");
    let topic = git(&third, &["rev-parse", "topic"]);
    git(
        &f.root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{topic},third"),
        ],
    );
    git(&f.root, &["commit", "-m", "third pointer"]);
    let remote = main_of(&f.remote);
    let untouched = [
        (head(&second), main_of(&second_source)),
        (head(&third), main_of(&third_source)),
    ];
    let runtime = runtime();
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

    // The outside-branch Space is passed too: its class keeps it out.
    let publication = publish(&runtime, &host, &f, &[ONE, "third"]).await;
    assert_eq!(
        steps(&publication),
        vec![(ONE.to_owned(), SpaceStepStatus::Published)]
    );
    assert!(publication.project.is_none() && publication.project_error.is_none());
    assert_synced_space(&f.child, &f.source);
    assert_eq!(main_of(&f.remote), remote);
    assert_eq!(
        [
            (head(&second), main_of(&second_source)),
            (head(&third), main_of(&third_source)),
        ],
        untouched
    );
    assert_eq!(git(&third, &["symbolic-ref", "HEAD"]), "refs/heads/main");
}

#[tokio::test]
async fn a_merge_pulled_into_a_space_moves_the_project_pointer_forward() {
    let f = Fixture::new();
    commit(&f.child, "note", "local");
    let local = head(&f.child);
    pointers(&f, &[ONE], "pointer");
    let author = f._temp.path().join("author");
    git(
        f._temp.path(),
        &[
            "clone",
            f.source.to_str().unwrap(),
            author.to_str().unwrap(),
        ],
    );
    git(&author, &["config", "user.name", "Fixture"]);
    git(&author, &["config", "user.email", "fixture@example.test"]);
    commit(&author, "other", "a colleague");
    git(&author, &["push", "origin", "main"]);
    let runtime = runtime();
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

    let publication = publish(&runtime, &host, &f, &[ONE]).await;
    assert_eq!(
        steps(&publication),
        vec![(ONE.to_owned(), SpaceStepStatus::Published)]
    );
    let merged = head(&f.child);
    assert_ne!(merged, local);
    git(&f.child, &["merge-base", "--is-ancestor", &local, &merged]);
    assert_synced_space(&f.child, &f.source);
    assert!(publication.project.is_some(), "{publication:?}");
    assert_eq!(main_of(&f.remote), head(&f.root));
    assert_eq!(
        git(&f.remote, &["rev-parse", &format!("main:{ONE}")]),
        merged
    );
}

#[tokio::test]
async fn a_refused_space_holds_the_project_and_a_repeat_continues_with_it() {
    let f = Fixture::new();
    let (second, second_source) = add_space(&f, "second");
    commit(&f.child, "note", "first local");
    commit(&second, "note", "second local");
    pointers(&f, &[ONE, "second"], "pointers");
    let remote = main_of(&f.remote);
    let refused = main_of(&second_source);
    let hook = second_source.join("hooks/pre-receive");
    svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    let runtime = runtime();
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

    let publication = publish(&runtime, &host, &f, &[ONE, "second"]).await;
    assert_eq!(
        steps(&publication),
        vec![
            ("second".to_owned(), SpaceStepStatus::Failed),
            (ONE.to_owned(), SpaceStepStatus::Published),
        ]
    );
    let failed = &publication.spaces[0];
    assert!(
        failed.report.is_some() || failed.error.is_some(),
        "{failed:?}"
    );
    assert!(publication.project.is_none() && publication.project_error.is_none());
    assert_synced_space(&f.child, &f.source);
    assert_eq!(main_of(&second_source), refused);
    assert_eq!(main_of(&f.remote), remote);

    std::fs::remove_file(&hook).unwrap();
    let publication = publish(&runtime, &host, &f, &[ONE, "second"]).await;
    // The published Space left the fresh list; the action resumes with the rest.
    assert_eq!(
        steps(&publication),
        vec![("second".to_owned(), SpaceStepStatus::Published)]
    );
    assert!(publication.project.is_some(), "{publication:?}");
    assert_synced_space(&second, &second_source);
    assert_eq!(main_of(&f.remote), head(&f.root));
}

#[tokio::test]
async fn background_project_sync_publishes_only_spaces_with_their_own_auto_sync() {
    for (space_auto, project_auto) in [(true, true), (false, true), (true, false), (false, false)] {
        let case = format!("space {space_auto}, project {project_auto}");
        let f = Fixture::new();
        // A save in a Space commits it and the project pointer locally.
        commit(&f.child, "note", "saved in the Space");
        pointers(&f, &[ONE], "pointer");
        policy(&f.child, space_auto, true);
        policy(&f.root, project_auto, true);
        let (space, remote) = (main_of(&f.source), main_of(&f.remote));
        let runtime = runtime();
        let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

        let result = flow::sync(&runtime, &host, &f.root, true).await;
        match (space_auto, project_auto) {
            (true, true) => {
                let report = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(report["type"], "success", "{case}: {report}");
                assert_synced_space(&f.child, &f.source);
                assert_eq!(main_of(&f.remote), head(&f.root), "{case}");
            }
            (false, true) => {
                assert_eq!(
                    blocked(&result.unwrap_err()),
                    vec![(ONE.to_owned(), SpaceBlockClass::LocalCommits)],
                    "{case}"
                );
                assert_eq!(main_of(&f.source), space, "{case}");
                assert_eq!(main_of(&f.remote), remote, "{case}");
            }
            _ => {
                // Without project auto-sync the background project sync never runs.
                let report = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(report["type"], "noRemote", "{case}: {report}");
                assert_eq!(main_of(&f.source), space, "{case}");
                assert_eq!(main_of(&f.remote), remote, "{case}");
            }
        }
    }
}

#[tokio::test]
async fn background_pointer_commits_follow_the_project_structural_policy() {
    for structural in [false, true] {
        let f = Fixture::new();
        commit(&f.child, "note", "pointed");
        let pointed = head(&f.child);
        pointers(&f, &[ONE], "pointer");
        commit(&f.child, "note", "after the pointer");
        policy(&f.child, true, true);
        policy(&f.root, true, structural);
        let runtime = runtime();
        let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

        flow::sync(&runtime, &host, &f.root, true).await.unwrap();
        assert_synced_space(&f.child, &f.source);
        assert_eq!(main_of(&f.remote), head(&f.root), "{structural}");
        let recorded = git(&f.remote, &["rev-parse", &format!("main:{ONE}")]);
        if structural {
            assert_eq!(recorded, head(&f.child));
        } else {
            assert_eq!(recorded, pointed);
        }
    }
}

#[tokio::test]
async fn background_project_sync_with_a_mixed_list_publishes_no_project() {
    let f = Fixture::new();
    let (second, second_source) = add_space(&f, "second");
    commit(&f.child, "note", "auto-sync Space");
    commit(&second, "note", "manual Space");
    pointers(&f, &[ONE, "second"], "pointers");
    policy(&f.child, true, true);
    policy(&second, false, true);
    policy(&f.root, true, true);
    let (manual, remote) = (main_of(&second_source), main_of(&f.remote));
    let runtime = runtime();
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());

    let error = flow::sync(&runtime, &host, &f.root, true)
        .await
        .unwrap_err();
    // The refusal stays the list the project sync observed.
    assert_eq!(blocked(&error).len(), 2);
    assert_synced_space(&f.child, &f.source);
    assert_eq!(main_of(&second_source), manual);
    assert_eq!(main_of(&f.remote), remote);
}

#[tokio::test]
async fn background_project_sync_skips_a_space_without_access() {
    let f = Fixture::new();
    commit(&f.child, "note", "no access");
    pointers(&f, &[ONE], "pointer");
    policy(&f.child, true, true);
    policy(&f.root, true, true);
    let (space, remote) = (main_of(&f.source), main_of(&f.remote));
    let child = std::fs::canonicalize(&f.child).unwrap();
    let host = Arc::new(TestHost {
        denied_repositories: vec![child.clone()],
        ..TestHost::default()
    });
    let shared: Arc<dyn GitHost> = host.clone();
    let runtime = runtime();

    let error = flow::sync(&runtime, &shared, &f.root, true)
        .await
        .unwrap_err();
    assert_eq!(
        blocked(&error),
        vec![(ONE.to_owned(), SpaceBlockClass::LocalCommits)]
    );
    let asked = host
        .authorized
        .lock()
        .unwrap()
        .iter()
        .filter(|path| **path == child)
        .count();
    assert_eq!(asked, 1);
    assert_eq!(main_of(&f.source), space);
    assert_eq!(main_of(&f.remote), remote);
}
