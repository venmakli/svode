use super::reuse_tests::{count, traced};
use super::*;
use crate::git::{flow, staging_tests::TestHost, state};
use std::sync::Arc;

/// Add a Submodule Space with its own source, published together with the project.
pub(super) fn add_space(f: &Fixture, name: &str) -> (PathBuf, PathBuf) {
    let seed = f._temp.path().join(format!("{name}-seed"));
    std::fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-b", "main"]);
    git(&seed, &["config", "user.name", "Fixture"]);
    git(&seed, &["config", "user.email", "fixture@example.test"]);
    commit(&seed, "note", name);
    let source = f._temp.path().join(format!("{name}.git"));
    git(
        f._temp.path(),
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    );
    git(
        &f.root,
        &["submodule", "add", source.to_str().unwrap(), name],
    );
    git(&f.root, &["commit", "-m", name]);
    git(&f.root, &["push", "origin", "main"]);
    let child = f.root.join(name);
    git(&child, &["config", "user.name", "Fixture"]);
    git(&child, &["config", "user.email", "fixture@example.test"]);
    (child, source)
}

fn record_pointer(f: &Fixture, path: &str, revision: &str) {
    git(
        &f.root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{revision},{path}"),
        ],
    );
}

fn source_fetches(log: &Path) -> usize {
    count(log, " fetch --prune ")
}

#[tokio::test]
async fn every_blocked_space_is_listed_with_its_class_within_the_proof_budget() {
    let f = Fixture::new();
    let (second, _) = add_space(&f, "second");
    let (_, third_source) = add_space(&f, "third");
    commit(&f.child, "note", "local commits");
    git(&second, &["checkout", "-b", "topic"]);
    commit(&second, "note", "outside the current branch");
    let topic = git(&second, &["rev-parse", "HEAD"]);
    git(&second, &["checkout", "main"]);
    let author = f._temp.path().join("author");
    git(
        f._temp.path(),
        &[
            "clone",
            third_source.to_str().unwrap(),
            author.to_str().unwrap(),
        ],
    );
    git(&author, &["config", "user.name", "Fixture"]);
    git(&author, &["config", "user.email", "fixture@example.test"]);
    commit(&author, "note", "nowhere");
    let nowhere = git(&author, &["rev-parse", "HEAD"]);
    record_pointer(&f, "second", &topic);
    record_pointer(&f, "third", &nowhere);
    git(&f.root, &["add", "Пространство one"]);
    git(&f.root, &["commit", "-m", "pointers"]);
    let before = git(&f.remote, &["rev-parse", "main"]);

    let log = traced(&f, "");
    assert_eq!(
        blocked_spaces(f.push().await),
        vec![
            ("second".to_owned(), SpaceBlockClass::OutsideBranch),
            ("third".to_owned(), SpaceBlockClass::Missing),
            ("Пространство one".to_owned(), SpaceBlockClass::LocalCommits),
        ]
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    let blocked = source_fetches(&log);
    assert_eq!(blocked, 3);

    // The same outgoing commits once every revision is published.
    git(&f.child, &["push", "origin", "main"]);
    git(&second, &["push", "origin", "topic"]);
    git(&author, &["push", "origin", "main"]);
    let log = traced(&f, "");
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(source_fetches(&log), blocked);
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn several_revisions_of_one_space_keep_the_most_restrictive_class() {
    for mode in ["local", "outside", "detached"] {
        let f = Fixture::new();
        commit(&f.child, "note", "first local");
        f.pointer();
        match mode {
            "outside" => {
                git(&f.child, &["checkout", "-b", "topic"]);
                commit(&f.child, "note", "topic");
                f.pointer();
                git(&f.child, &["checkout", "main"]);
            }
            _ => {
                commit(&f.child, "note", "second local");
                f.pointer();
            }
        }
        if mode == "detached" {
            git(&f.child, &["checkout", "--detach"]);
        }
        let expected = if mode == "local" {
            SpaceBlockClass::LocalCommits
        } else {
            SpaceBlockClass::OutsideBranch
        };
        assert_eq!(blocked_spaces(f.push().await), one(expected), "{mode}");
    }
}

#[tokio::test]
async fn an_unavailable_source_is_contacted_once_for_all_its_revisions() {
    let f = Fixture::new();
    for value in ["first", "second"] {
        commit(&f.child, "note", value);
        f.pointer();
    }
    std::fs::rename(&f.source, f._temp.path().join("moved.git")).unwrap();
    let log = traced(&f, "");
    assert_eq!(
        blocked_spaces(f.push().await),
        one(SpaceBlockClass::SourceUnavailable)
    );
    assert_eq!(source_fetches(&log), 1);
}

#[tokio::test]
async fn a_project_refusal_after_a_space_blocker_stays_single() {
    let f = Fixture::new();
    commit(&f.child, "note", "first local");
    f.pointer();
    let first = git(&f.root, &["rev-parse", "HEAD"]);
    commit(&f.child, "note", "second local");
    f.pointer();
    let log = traced(
        &f,
        &format!("case \"$*\" in *\" read-tree {first}\") exit 1 ;; esac"),
    );
    let result = f.push().await;
    assert!(
        matches!(
            result,
            Err(GitError::PublicationBlocked {
                reason: PublicationBlockReason::Configuration,
                ..
            })
        ),
        "{result:?}"
    );
    // The newer pointer was classified before the older commit failed.
    assert_eq!(count(&log, "merge-base --is-ancestor"), 1);
}

#[tokio::test]
async fn parent_retry_names_its_unpublished_space_as_local_commits() {
    let f = Fixture::new();
    commit(&f.child, "note", "unpublished head");
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let runtime = Arc::new(state::GitRuntime::new());
    let host: Arc<dyn crate::git::host::GitHost> = Arc::new(TestHost::default());
    let root = std::fs::canonicalize(&f.root).unwrap();
    let target = flow::publication_target(&runtime.require_cli().unwrap(), &f.child, &root)
        .await
        .unwrap();
    let error = flow::retry_parent(&runtime, &host, &f.child, &head, &root, &target)
        .await
        .unwrap_err();
    match &*error {
        GitError::PublicationBlocked {
            repository,
            reason: PublicationBlockReason::Spaces { spaces },
        } => {
            assert_eq!(repository, &root.to_string_lossy());
            assert_eq!(
                spaces,
                &[BlockedSpace {
                    path: "Пространство one".into(),
                    class: SpaceBlockClass::LocalCommits,
                }]
            );
        }
        other => panic!("{other:?}"),
    }
}
