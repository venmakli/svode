use super::{Fixture, commit, git};
use crate::git::{flow, operations::Snapshot, ops, readers, staging_tests::TestHost, state};
use std::sync::Arc;

const SPACE: &str = "Пространство one";

/// Record `revision` as the project pointer without touching the Space checkout.
fn record_pointer(f: &Fixture, revision: &str) {
    git(
        &f.root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{revision},{SPACE}"),
        ],
    );
    git(&f.root, &["commit", "-m", "pointer"]);
}

/// A Space revision published by a collaborator and absent from this checkout.
fn foreign_revision(f: &Fixture, value: &str) -> String {
    let author = f._temp.path().join(format!("author-{value}"));
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
    commit(&author, "note", value);
    git(&author, &["push", "origin", "main"]);
    git(&author, &["rev-parse", "HEAD"])
}

/// Leave the Space behind the project pointer in one of the R4 shapes.
fn space_behind(f: &Fixture, shape: &str) -> String {
    let base = git(&f.child, &["rev-parse", "HEAD"]);
    match shape {
        "ancestor" => {
            commit(&f.child, "note", "pointer");
            git(&f.child, &["push", "origin", "main"]);
            f.pointer();
            git(&f.child, &["reset", "--hard", &base]);
        }
        "missing" => {
            let pointer = foreign_revision(f, "collaborator");
            record_pointer(f, &pointer);
            assert_ne!(
                std::process::Command::new("git")
                    .args(["cat-file", "-e", &format!("{pointer}^{{commit}}")])
                    .current_dir(&f.child)
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .code(),
                Some(0)
            );
        }
        "diverged" => {
            commit(&f.child, "note", "pointer");
            f.pointer();
            git(&f.child, &["reset", "--hard", &base]);
            commit(&f.child, "note", "diverged");
            git(&f.child, &["push", "--force", "origin", "main"]);
        }
        _ => unreachable!(),
    }
    git(&f.child, &["rev-parse", "HEAD"])
}

fn pointer(f: &Fixture) -> String {
    git(&f.root, &["rev-parse", &format!("HEAD:{SPACE}")])
}

#[tokio::test]
async fn a_space_behind_the_project_pointer_is_reported_and_never_moves_it_back() {
    for shape in ["ancestor", "missing", "diverged"] {
        let f = Fixture::new();
        let head = space_behind(&f, shape);
        let recorded = pointer(&f);
        let root_head = git(&f.root, &["rev-parse", "HEAD"]);
        let remote = git(&f.remote, &["rev-parse", "main"]);
        let index = git(&f.root, &["ls-files", "--stage", "--", SPACE]);
        assert_ne!(recorded, head, "{shape}");

        let current = Snapshot::read(&f.cli, &f.child).await.unwrap();
        let read = readers::inspect(&f.cli, &f.child, &f.root, None, &current, Ok(()))
            .await
            .unwrap();
        let status = serde_json::to_value(read.status.unwrap()).unwrap();
        assert_eq!(status["parent"]["pointer"], "newer", "{shape}");

        for (background, publish) in [(false, false), (false, true), (true, true)] {
            let outcome = flow::parent_step_locked(
                &f.cli,
                &f.child,
                &f.root,
                &head,
                background,
                publish,
                Ok(()),
                false,
            )
            .await;
            let outcome = serde_json::to_value(outcome).unwrap();
            assert_eq!(outcome["pointer"], "newer", "{shape}");
            assert!(outcome.get("error").is_none(), "{shape}: {outcome}");
            assert!(outcome.get("result").is_none(), "{shape}");
        }

        let runtime = Arc::new(state::GitRuntime::new());
        let host: Arc<dyn crate::git::host::GitHost> = Arc::new(TestHost::default());
        // The runtime's Git reads the machine configuration the target hashes.
        // Retry addresses the canonical project the publication status reports.
        let root = std::fs::canonicalize(&f.root).unwrap();
        let target = flow::publication_target(&runtime.require_cli().unwrap(), &f.child, &root)
            .await
            .unwrap();
        let retried = flow::retry_parent(&runtime, &host, &f.child, &head, &root, &target)
            .await
            .unwrap();
        let retried = serde_json::to_value(retried).unwrap();
        assert_eq!(retried["parent"]["pointer"], "newer", "{shape}: {retried}");
        assert!(retried["parent"].get("error").is_none(), "{shape}");

        assert!(
            crate::git::published_pointer::commit(&f.cli, &f.root, &f.child, &head)
                .await
                .is_err(),
            "{shape}"
        );
        assert!(
            !ops::commit_paths(&f.cli, &f.root, &[SPACE.into()])
                .await
                .unwrap(),
            "{shape}"
        );
        assert!(
            !ops::commit_exact_path(&f.cli, &f.root, SPACE, "Update pointer")
                .await
                .unwrap(),
            "{shape}"
        );
        ops::add_all(&f.cli, &f.root).await.unwrap();

        assert_eq!(pointer(&f), recorded, "{shape}");
        assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), root_head, "{shape}");
        assert_eq!(git(&f.remote, &["rev-parse", "main"]), remote, "{shape}");
        assert_eq!(
            git(&f.root, &["ls-files", "--stage", "--", SPACE]),
            index,
            "{shape}"
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head, "{shape}");
    }
}

#[tokio::test]
async fn a_space_ahead_of_the_project_pointer_still_moves_it_forward() {
    let f = Fixture::new();
    commit(&f.child, "note", "ahead");
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let current = Snapshot::read(&f.cli, &f.child).await.unwrap();
    let read = readers::inspect(&f.cli, &f.child, &f.root, None, &current, Ok(()))
        .await
        .unwrap();
    let status = serde_json::to_value(read.status.unwrap()).unwrap();
    assert_eq!(status["parent"]["pointer"], "pending");
    assert!(
        ops::commit_paths(&f.cli, &f.root, &[SPACE.into()])
            .await
            .unwrap()
    );
    assert_eq!(pointer(&f), head);

    commit(&f.child, "note", "ahead again");
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let outcome = flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        false,
        Ok(()),
        false,
    )
    .await;
    assert_eq!(serde_json::to_value(outcome).unwrap()["pointer"], "local");
    assert_eq!(pointer(&f), head);
}

#[tokio::test]
async fn merge_continuation_keeps_a_merged_pointer_the_space_does_not_contain() {
    let f = Fixture::new();
    let base = git(&f.child, &["rev-parse", "HEAD"]);
    let collaborator = f._temp.path().join("collaborator");
    git(
        f._temp.path(),
        &[
            "clone",
            f.remote.to_str().unwrap(),
            collaborator.to_str().unwrap(),
        ],
    );
    git(&collaborator, &["config", "user.name", "Fixture"]);
    git(
        &collaborator,
        &["config", "user.email", "fixture@example.test"],
    );
    let advanced = foreign_revision(&f, "published elsewhere");
    git(
        &collaborator,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{advanced},{SPACE}"),
        ],
    );
    commit(&collaborator, "note", "theirs");
    git(&collaborator, &["push", "origin", "main"]);
    commit(&f.root, "note", "ours");

    let pulled = crate::git::sync::sync(&f.cli, &f.root).await.unwrap();
    assert!(matches!(
        pulled,
        crate::git::sync::SyncResult::Conflict { .. }
    ));
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), base);
    std::fs::write(f.root.join("note"), "resolved").unwrap();
    // Even a resolution that names the Space path keeps the merged pointer.
    let resolved =
        crate::git::sync::resolve_and_continue(&f.cli, &f.root, &["note".into(), SPACE.into()])
            .await
            .unwrap();
    assert!(matches!(
        resolved,
        crate::git::sync::SyncResult::Success { .. }
    ));

    assert_eq!(git(&f.root, &["rev-parse", "HEAD^2"]).len(), 40);
    assert_eq!(pointer(&f), advanced);
    assert_eq!(git(&f.root, &["show", "HEAD:note"]), "resolved");
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), base);
}
