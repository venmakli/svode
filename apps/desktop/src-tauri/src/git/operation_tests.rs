use super::{Fixture, commit, git};
use crate::git::{
    operations::*,
    publication_flow,
    sync::{self, SyncResult},
};
use crate::{
    AppError,
    space::{config::write_git_user_policy, types::GitUserPolicy},
};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, oneshot};

fn policy(repo: &Path, bits: u8) {
    std::fs::create_dir_all(repo.join(".svode")).unwrap();
    write_git_user_policy(
        repo,
        &GitUserPolicy {
            auto_sync: bits & 4 != 0,
            auto_commit_structural: bits & 2 != 0,
            auto_commit_system: bits & 1 != 0,
        },
    )
    .unwrap();
}

struct Run {
    entered: Option<oneshot::Sender<()>>,
    before: Option<Arc<Notify>>,
    after: Option<Arc<Notify>>,
    published: Option<oneshot::Sender<()>>,
    calls: Arc<AtomicUsize>,
    parent_calls: Arc<AtomicUsize>,
    parent_permission: bool,
    parent_lock: Arc<tokio::sync::Mutex<()>>,
}

impl Default for Run {
    fn default() -> Self {
        Self {
            entered: None,
            before: None,
            after: None,
            published: None,
            calls: Arc::default(),
            parent_calls: Arc::default(),
            parent_permission: true,
            parent_lock: Arc::default(),
        }
    }
}

// Uses the production admission owner and native publisher/parent primitives.
// Gates bound the observable Git stages without a GUI or timing-based races.
async fn execute(cli: crate::git::cli::GitCli, request: Request, run: Run) -> Completion {
    if let Some(entered) = run.entered {
        let _ = entered.send(());
    }
    if let Some(gate) = run.before {
        gate.notified().await;
    }
    let before = Snapshot::read(&cli, &request.repo).await.unwrap();
    let mut evidence = None;
    let result = async {
        if before.target != request.snapshot.target {
            return Err(target_changed(&request.repo));
        }
        if !request.intent.admitted(&request.repo) {
            return Ok(Output::Sync(publication_flow::SyncReport {
                child: SyncResult::NoRemote,
                parent: None,
            }));
        }
        run.calls.fetch_add(1, Ordering::SeqCst);
        let child = match request.intent {
            Intent::Push => {
                crate::git::ops::push(&cli, &request.repo).await?;
                return crate::git::ops::status(&cli, &request.repo)
                    .await
                    .map(Output::Status);
            }
            Intent::Publish => {
                crate::git::ops::push_set_upstream(&cli, &request.repo).await?;
                return crate::git::ops::status(&cli, &request.repo)
                    .await
                    .map(Output::Status);
            }
            Intent::Resolve => sync::resolve_and_continue(&cli, &request.repo).await?,
            _ => sync::sync(&cli, &request.repo).await?,
        };
        let mut parent_outcome = None;
        if let (SyncResult::Success { published_head }, Some((parent, _))) =
            (&child, &request.parent)
        {
            let _parent_guard = run.parent_lock.lock().await;
            let parent_before = Snapshot::read(&cli, parent).await?;
            let permission = if run.parent_permission {
                Ok(())
            } else {
                Err(AppError::RepositoryAccessDenied {
                    repository_id: "fixture-root".into(),
                    status: "unknown".into(),
                    reason: "verification_required".into(),
                })
            };
            let outcome = publication_flow::parent_step_locked(
                &cli,
                &request.repo,
                parent,
                published_head,
                request.intent.background(),
                true,
                permission,
            )
            .await;
            if let Some(result @ SyncResult::Success { .. }) = &outcome.result {
                run.parent_calls.fetch_add(1, Ordering::SeqCst);
                evidence = Some(ParentEvidence {
                    repo: parent.clone(),
                    before: parent_before,
                    after: Snapshot::read(&cli, parent).await?,
                    result: result.clone(),
                    background: request.intent.background(),
                });
            }
            parent_outcome = Some(outcome);
        }
        Ok(Output::Sync(publication_flow::SyncReport {
            child,
            parent: parent_outcome,
        }))
    }
    .await;
    let after = Snapshot::read(&cli, &request.repo).await.unwrap();
    if let Some(published) = run.published {
        let _ = published.send(());
    }
    if let Some(gate) = run.after {
        gate.notified().await;
    }
    Completion {
        result: result.map_err(Into::into),
        before,
        after,
        parent: evidence,
    }
}

fn start(
    owner: &Arc<Operations>,
    f: &Fixture,
    repo: &Path,
    intent: Intent,
    run: Run,
) -> tokio::task::JoinHandle<Result<Output, SharedError>> {
    let owner = owner.clone();
    let repo = repo.to_path_buf();
    let cli = f.cli.clone();
    tokio::spawn(async move {
        owner
            .run(cli.clone(), &repo, intent, move |request| {
                execute(cli, request, run)
            })
            .await
    })
}

fn sync_intent(background: bool) -> Intent {
    Intent::Sync { background }
}

#[tokio::test]
async fn concurrent_clients_and_inline_aliases_share_one_result_then_new_focus_is_fresh() {
    let f = Fixture::new();
    commit(&f.root, "note", "outgoing");
    std::fs::create_dir_all(f.root.join("inline")).unwrap();
    policy(&f.root, 7);
    let owner = Arc::new(Operations::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let first = start(
        &owner,
        &f,
        &f.root,
        sync_intent(false),
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            calls: calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    let mut waiters = Vec::new();
    for i in 0..4 {
        waiters.push(start(
            &owner,
            &f,
            &f.root.join("inline"),
            sync_intent(i % 2 == 0),
            Run {
                calls: calls.clone(),
                ..Run::default()
            },
        ));
    }
    owner.wait_for_readers(&f.root, 5).await;
    gate.notify_one();
    first.await.unwrap().unwrap();
    for waiter in waiters {
        waiter.await.unwrap().unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
    start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: calls.clone(),
            ..Run::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "independent later demand must read the remote again"
    );
}

#[tokio::test]
async fn finite_commit_burst_gets_one_additional_pass_without_losing_the_latest_save() {
    let f = Fixture::new();
    policy(&f.root, 7);
    commit(&f.root, "note", "first save");
    let owner = Arc::new(Operations::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let first = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            after: Some(gate.clone()),
            published: Some(tx),
            calls: calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    commit(&f.root, "note", "second save");
    let second_gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let a = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: calls.clone(),
            published: Some(tx),
            after: Some(second_gate.clone()),
            ..Run::default()
        },
    );
    // A is the admitted next pass; observers of that generation join it.
    owner.wait_for_readers(&f.root, 2).await;
    gate.notify_one();
    first.await.unwrap().unwrap();
    rx.await.unwrap();
    commit(&f.root, "note", "third save during second completion");
    let b = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: calls.clone(),
            ..Run::default()
        },
    );
    let c = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: calls.clone(),
            ..Run::default()
        },
    );
    owner.wait_for_readers(&f.root, 3).await;
    second_gate.notify_one();
    a.await.unwrap().unwrap();
    b.await.unwrap().unwrap();
    c.await.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn policy_is_read_after_wait_and_explicit_demand_keeps_its_authority() {
    let f = Fixture::new();
    policy(&f.root, 7);
    commit(&f.root, "note", "queued save");
    let owner = Arc::new(Operations::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let background = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            calls: calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    let explicit = start(
        &owner,
        &f,
        &f.root,
        sync_intent(false),
        Run {
            calls: calls.clone(),
            ..Run::default()
        },
    );
    owner.wait_for_readers(&f.root, 2).await;
    policy(&f.root, 0);
    gate.notify_one();
    let Output::Sync(bg) = background.await.unwrap().unwrap() else {
        panic!()
    };
    assert!(matches!(bg.child, SyncResult::NoRemote));
    let Output::Sync(result) = explicit.await.unwrap().unwrap() else {
        panic!()
    };
    assert!(matches!(result.child, SyncResult::Success { .. }));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn root_open_waits_for_reserved_parent_without_a_second_publication() {
    let f = Fixture::new();
    policy(&f.child, 7);
    policy(&f.root, 7);
    commit(&f.child, "note", "child save");
    let owner = Arc::new(Operations::default());
    let child_calls = Arc::new(AtomicUsize::new(0));
    let root_calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let child = start(
        &owner,
        &f,
        &f.child,
        sync_intent(true),
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            calls: child_calls.clone(),
            parent_calls: root_calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    let root = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: root_calls.clone(),
            ..Run::default()
        },
    );
    owner.wait_for_readers(&f.child, 2).await;
    assert_eq!(root_calls.load(Ordering::SeqCst), 0);
    gate.notify_one();
    child.await.unwrap().unwrap();
    let Output::Sync(root) = root.await.unwrap().unwrap() else {
        panic!()
    };
    assert!(matches!(root.child, SyncResult::Success { .. }));
    assert_eq!(root_calls.load(Ordering::SeqCst), 1);
    assert_eq!(child_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        git(&f.remote, &["rev-parse", "main:Пространство one"]),
        git(&f.source, &["rev-parse", "main"])
    );
}

#[tokio::test]
async fn skipped_or_failed_parent_never_satisfies_root_open() {
    for denied in [false, true] {
        let f = Fixture::new();
        policy(&f.child, 7);
        policy(&f.root, if denied { 7 } else { 0 });
        commit(&f.child, "note", "independent child success");
        let owner = Arc::new(Operations::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let (tx, rx) = oneshot::channel();
        let child = start(
            &owner,
            &f,
            &f.child,
            sync_intent(true),
            Run {
                entered: Some(tx),
                before: Some(gate.clone()),
                parent_permission: !denied,
                ..Run::default()
            },
        );
        rx.await.unwrap();
        let root = start(
            &owner,
            &f,
            &f.root,
            sync_intent(false),
            Run {
                calls: calls.clone(),
                ..Run::default()
            },
        );
        owner.wait_for_readers(&f.child, 2).await;
        gate.notify_one();
        let Output::Sync(result) = child.await.unwrap().unwrap() else {
            panic!()
        };
        assert!(matches!(result.child, SyncResult::Success { .. }));
        let parent = serde_json::to_value(result.parent.unwrap()).unwrap();
        assert_eq!(
            parent[if denied { "error" } else { "policySkipped" }].is_null(),
            false
        );
        root.await.unwrap().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "explicit root demand still needs its own admitted stage"
        );
    }
}

#[tokio::test]
async fn changed_target_rejects_queued_work_and_dropped_client_does_not_cancel_publication() {
    let f = Fixture::new();
    commit(&f.root, "note", "keep admitted work");
    let owner = Arc::new(Operations::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let first = start(
        &owner,
        &f,
        &f.root,
        sync_intent(false),
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            calls: calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    let second = start(
        &owner,
        &f,
        &f.root,
        sync_intent(false),
        Run {
            calls: calls.clone(),
            ..Run::default()
        },
    );
    owner.wait_for_readers(&f.root, 2).await;
    first.abort();
    gate.notify_one();
    second.await.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let queued = start(
        &owner,
        &f,
        &f.root,
        Intent::Push,
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            calls: calls.clone(),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    git(
        &f.root,
        &["config", "remote.origin.pushurl", "file:///does-not-exist"],
    );
    gate.notify_one();
    let error = queued.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), "git_publication_blocked");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_ssh_dns_failure_keeps_configured_remote_error() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let ssh = f.root.parent().unwrap().join("failed-ssh");
    std::fs::write(
        &ssh,
        "#!/bin/sh\necho 'ssh: Could not resolve hostname fixture.invalid' >&2\nexit 255\n",
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &f.root,
        &["config", "core.sshCommand", ssh.to_str().unwrap()],
    );
    git(
        &f.root,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://fixture.invalid/repo.git",
        ],
    );
    assert!(matches!(
        sync::sync(&f.cli, &f.root).await,
        Err(AppError::GitCommandFailed(_))
    ));
    assert!(matches!(
        crate::git::ops::fetch_remote(&f.cli, &f.root).await,
        Err(AppError::GitCommandFailed(_))
    ));
    git(&f.root, &["remote", "remove", "origin"]);
    assert!(matches!(
        sync::sync(&f.cli, &f.root).await.unwrap(),
        SyncResult::NoRemote
    ));
}

#[tokio::test]
async fn every_parent_policy_preserves_local_pointer_and_existing_pointer_publication_intents() {
    for bits in 0..8 {
        // These eight groups cover the parent effects of all 64 child/root
        // tuples; child commit admission is exercised by autocommit's matrix.
        let f = Fixture::new();
        policy(&f.root, bits);
        commit(&f.child, "note", "local child revision");
        let child_head = git(&f.child, &["rev-parse", "HEAD"]);
        let root_before = git(&f.root, &["rev-parse", "HEAD"]);
        let remote_before = git(&f.remote, &["rev-parse", "main"]);
        let local = publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &child_head,
            true,
            false,
            Ok(()),
        )
        .await;
        let local = serde_json::to_value(local).unwrap();
        assert_eq!(
            local["pointer"] == "local",
            bits & 2 != 0,
            "local T gate {bits}"
        );
        assert_eq!(
            git(&f.root, &["rev-parse", "HEAD"]) != root_before,
            bits & 2 != 0
        );
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]),
            remote_before,
            "local step must not publish"
        );
        git(&f.child, &["push", "origin", "main"]);
        let automatic = publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &child_head,
            true,
            true,
            Ok(()),
        )
        .await;
        let automatic = serde_json::to_value(automatic).unwrap();
        assert_eq!(
            automatic["pointer"] == "published",
            bits & 6 == 6,
            "new pointer S+T gate {bits}"
        );
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]) != remote_before,
            bits & 6 == 6
        );
        // Explicit local save remains authorized for every tuple. Subsequent
        // background publication of that existing pointer uses S alone.
        publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &child_head,
            false,
            false,
            Ok(()),
        )
        .await;
        let existing = publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &child_head,
            true,
            true,
            Ok(()),
        )
        .await;
        assert_eq!(
            serde_json::to_value(existing).unwrap()["pointer"] == "published",
            bits & 4 != 0,
            "existing pointer S gate {bits}"
        );
        let explicit = publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &child_head,
            false,
            true,
            Ok(()),
        )
        .await;
        assert_eq!(
            serde_json::to_value(explicit).unwrap()["pointer"],
            "published"
        );
    }
}

#[tokio::test]
async fn independent_descendant_has_no_parent_reservation_and_invalid_policy_never_enables_sync() {
    let f = Fixture::new();
    let independent = f.root.join("independent");
    git(
        &f.root,
        &[
            "clone",
            f.source.to_str().unwrap(),
            independent.to_str().unwrap(),
        ],
    );
    policy(&independent, 7);
    let owner = Arc::new(Operations::default());
    let gate = Arc::new(Notify::new());
    let (tx, rx) = oneshot::channel();
    let pending = start(
        &owner,
        &f,
        &independent,
        sync_intent(true),
        Run {
            entered: Some(tx),
            before: Some(gate.clone()),
            ..Run::default()
        },
    );
    rx.await.unwrap();
    let root = start(&owner, &f, &f.root, sync_intent(false), Run::default());
    tokio::time::timeout(std::time::Duration::from_secs(15), root)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    std::fs::write(independent.join(".svode/local.json"), "invalid").unwrap();
    gate.notify_one();
    let Output::Sync(result) = pending.await.unwrap().unwrap() else {
        panic!()
    };
    assert!(matches!(result.child, SyncResult::NoRemote));
    assert!(result.parent.is_none());
}

#[tokio::test]
async fn root_demand_waits_for_every_known_child_and_uses_the_last_covering_parent_stage() {
    let f = Fixture::new();
    let source = f.root.parent().unwrap().join("second.git");
    git(
        &f.root,
        &[
            "clone",
            "--bare",
            f.source.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    );
    git(
        &f.root,
        &["submodule", "add", source.to_str().unwrap(), "second"],
    );
    git(&f.root, &["commit", "-am", "second child"]);
    git(&f.root, &["push", "origin", "main"]);
    let second = f.root.join("second");
    git(&second, &["config", "user.name", "Fixture"]);
    git(&second, &["config", "user.email", "fixture@example.test"]);
    for repo in [&f.root, &f.child, &second] {
        policy(repo, 7);
    }
    commit(&f.child, "note", "first child update");
    commit(&second, "note", "second child update");
    let owner = Arc::new(Operations::default());
    let root_calls = Arc::new(AtomicUsize::new(0));
    let parent_lock = Arc::new(tokio::sync::Mutex::new(()));
    let mut children = Vec::new();
    let mut gates = Vec::new();
    for repo in [&f.child, &second] {
        let gate = Arc::new(Notify::new());
        let (tx, rx) = oneshot::channel();
        children.push(start(
            &owner,
            &f,
            repo,
            sync_intent(true),
            Run {
                entered: Some(tx),
                before: Some(gate.clone()),
                parent_calls: root_calls.clone(),
                parent_lock: parent_lock.clone(),
                ..Run::default()
            },
        ));
        rx.await.unwrap();
        gates.push(gate);
    }
    let root = start(
        &owner,
        &f,
        &f.root,
        sync_intent(true),
        Run {
            calls: root_calls.clone(),
            ..Run::default()
        },
    );
    owner.wait_for_parent_reader(&f.root).await;
    for gate in gates {
        gate.notify_one();
    }
    for child in children {
        child.await.unwrap().unwrap();
    }
    root.await.unwrap().unwrap();
    assert_eq!(
        root_calls.load(Ordering::SeqCst),
        2,
        "two required parent stages, no third root-open cycle"
    );
    assert_eq!(
        git(&f.remote, &["rev-parse", "main:second"]),
        git(&source, &["rev-parse", "main"])
    );
    assert_eq!(
        git(&f.remote, &["rev-parse", "main:Пространство one"]),
        git(&f.source, &["rev-parse", "main"])
    );
}

#[tokio::test]
async fn observer_during_success_effects_shares_publication_without_a_noop_cycle() {
    for first_publish in [false, true] {
        let f = Fixture::new();
        if first_publish {
            git(&f.root, &["branch", "--unset-upstream"]);
        }
        policy(&f.root, 7);
        commit(&f.root, "note", "late observer");
        let owner = Arc::new(Operations::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let (tx, rx) = oneshot::channel();
        let first = start(
            &owner,
            &f,
            &f.root,
            sync_intent(true),
            Run {
                published: Some(tx),
                after: Some(gate.clone()),
                calls: calls.clone(),
                ..Run::default()
            },
        );
        rx.await.unwrap();
        // A status reader may refresh index stat data without creating a generation.
        git(&f.root, &["status", "--porcelain"]);
        let second = start(
            &owner,
            &f,
            &f.root,
            sync_intent(true),
            Run {
                calls: calls.clone(),
                ..Run::default()
            },
        );
        owner.wait_for_readers(&f.root, 2).await;
        gate.notify_one();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn shared_errors_preserve_original_structured_ipc_payloads() {
    for error in [
        AppError::GitCommandFailed("transport unavailable".into()),
        AppError::GitBranchBlocked {
            reason: crate::git::branch::BranchBlockReason::LocalChanges,
        },
        target_changed(Path::new("fixture")),
        AppError::RepositoryAccessDenied {
            repository_id: "fixture".into(),
            status: "unknown".into(),
            reason: "expired".into(),
        },
    ] {
        let original = serde_json::to_value(&error).unwrap();
        let kind = error.kind();
        let shared = SharedError::from(error);
        assert_eq!(serde_json::to_value(&shared).unwrap(), original);
        assert_eq!(shared.kind(), kind);
    }
}

#[tokio::test]
async fn transport_change_during_pull_does_not_redirect_the_following_push() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let writer = f.root.parent().unwrap().join("remote-writer");
    let wrong = f.root.parent().unwrap().join("wrong.git");
    git(
        &f.root,
        &[
            "clone",
            f.remote.to_str().unwrap(),
            writer.to_str().unwrap(),
        ],
    );
    git(&writer, &["config", "user.name", "Fixture"]);
    git(&writer, &["config", "user.email", "fixture@example.test"]);
    commit(&writer, "incoming", "incoming change");
    git(&writer, &["push", "origin", "main"]);
    git(
        &f.root,
        &[
            "clone",
            "--bare",
            f.remote.to_str().unwrap(),
            wrong.to_str().unwrap(),
        ],
    );
    let before = git(&wrong, &["rev-parse", "main"]);
    commit(&f.root, "note", "outgoing change");
    let hook = f.root.join(".git/hooks/post-merge");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\ngit config remote.origin.pushurl '{}'\n",
            wrong.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = sync::sync(&f.cli, &f.root).await.unwrap_err();
    assert_eq!(error.kind(), "git_publication_blocked");
    assert_eq!(git(&wrong, &["rev-parse", "main"]), before);
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    assert_eq!(
        std::fs::read_to_string(f.root.join("incoming")).unwrap(),
        "incoming change"
    );
}
