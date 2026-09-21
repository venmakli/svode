use super::*;
use crate::git::ops;
use crate::git::push_rejection::PushRejectionReason;
use crate::storage::config::AssetsStrategy;
use crate::storage::lfs_declaration::{LfsDeclarationState, apply_lfs_declaration};

const GH008_HOOK: &str = "cat >/dev/null
echo 'error: GH008: Your push referenced at least 1 unknown Git LFS object:' >&2
echo '    0966c80e8f42ed27d36e0152a2df5d4631fdebe4b68159c379fb4c05e15d413c' >&2
echo \"Try to push them with 'git lfs push --all'.\" >&2
exit 1";

const NO_AGENT_HOOK: &str = "cat >/dev/null
echo 'batch response: Post \"https://lfs-s3.svode.invalid/objects/batch\": dial tcp: lookup lfs-s3.svode.invalid: no such host' >&2
exit 1";

/// Provider-side rejection, as GitHub runs it from `pre-receive`.
fn remote_hook(remote: &Path, body: Option<&str>) {
    let hook = remote.join("hooks/pre-receive");
    match body {
        Some(body) => {
            std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
            std::fs::write(&hook, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        None => std::fs::remove_file(&hook).unwrap(),
    }
}

fn set_strategy(repo: &Path, strategy: &str) {
    std::fs::create_dir_all(repo.join(".svode")).unwrap();
    std::fs::write(
        repo.join(".svode/config.json"),
        format!(r#"{{"name":"Fixture","assets":{{"strategy":"{strategy}"}}}}"#),
    )
    .unwrap();
    git(repo, &["add", ".svode/config.json"]);
    git(repo, &["commit", "-m", "strategy"]);
}

fn rejection(result: Result<(), GitError>) -> serde_json::Value {
    match result {
        Err(error @ GitError::PushRejected { .. }) => serde_json::to_value(&error).unwrap(),
        other => panic!("expected a typed push rejection, got {other:?}"),
    }
}

#[tokio::test]
async fn every_publisher_types_provider_lfs_rejection_and_retries_after_recovery() {
    use crate::git::sync;
    for publisher in ["push", "publish", "sync", "first-sync", "resolve"] {
        let f = Fixture::new();
        commit(&f.root, "note", "outgoing content");
        if matches!(publisher, "publish" | "first-sync") {
            git(&f.remote, &["update-ref", "-d", "refs/heads/main"]);
            git(&f.root, &["branch", "--unset-upstream"]);
        }
        if publisher == "resolve" {
            git(&f.root, &["checkout", "-b", "side", "HEAD~1"]);
            commit(&f.root, "side", "side change");
            git(&f.root, &["checkout", "main"]);
            git(&f.root, &["merge", "--no-commit", "side"]);
        }
        let before = git(&f.remote, &["for-each-ref"]);
        remote_hook(&f.remote, Some(GH008_HOOK));
        let result = match publisher {
            "push" => ops::push(&f.cli, &f.root).await,
            "publish" => ops::push_set_upstream(&f.cli, &f.root).await,
            "sync" | "first-sync" => sync::sync(&f.cli, &f.root).await.map(|_| ()),
            "resolve" => sync::resolve_and_continue(&f.cli, &f.root)
                .await
                .map(|_| ()),
            _ => unreachable!(),
        };
        assert_eq!(
            rejection(result),
            serde_json::json!({
                "kind": "git_push_rejected",
                "reason": "lfs_objects_missing",
                "objectCount": 1,
                "lfsDeclaration": null,
            }),
            "{publisher}"
        );
        // The commit stays local and an ordinary retry publishes it.
        assert_eq!(git(&f.remote, &["for-each-ref"]), before, "{publisher}");
        remote_hook(&f.remote, None);
        let retry = sync::sync(&f.cli, &f.root).await;
        assert!(
            matches!(retry, Ok(sync::SyncResult::Success { .. })),
            "{publisher}: {retry:?}"
        );
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]),
            git(&f.root, &["rev-parse", "HEAD"])
        );
    }
}

#[tokio::test]
async fn lfs_s3_rejection_carries_the_declaration_state_for_recovery() {
    let f = Fixture::new();
    set_strategy(&f.root, "lfs-s3");
    remote_hook(&f.remote, Some(GH008_HOOK));
    let state = |result| rejection(result)["lfsDeclaration"].clone();

    assert_eq!(state(ops::push(&f.cli, &f.root).await), "missing");

    apply_lfs_declaration(&f.root, AssetsStrategy::LfsS3).unwrap();
    assert_eq!(state(ops::push(&f.cli, &f.root).await), "pending");

    git(&f.root, &["add", ".lfsconfig"]);
    git(&f.root, &["commit", "-m", "declaration"]);
    assert_eq!(state(ops::push(&f.cli, &f.root).await), "published");

    std::fs::write(
        f.root.join(".lfsconfig"),
        "[lfs]\n\turl = https://lfs.example.test/\n",
    )
    .unwrap();
    assert_eq!(state(ops::push(&f.cli, &f.root).await), "foreign");

    // The recovery vocabulary is the Storage diagnostics vocabulary.
    assert_eq!(
        serde_json::to_value(LfsDeclarationState::Foreign).unwrap(),
        "foreign"
    );
}

#[tokio::test]
async fn push_without_s3_transfer_wiring_is_typed_and_leaves_auth_and_other_failures() {
    use crate::git::sync;
    let f = Fixture::new();
    commit(&f.root, "note", "outgoing content");
    let before = git(&f.remote, &["rev-parse", "main"]);

    counting_hook(&f.root, NO_AGENT_HOOK);
    let error = sync::sync(&f.cli, &f.root).await.unwrap_err();
    assert!(
        matches!(
            error,
            GitError::PushRejected {
                reason: PushRejectionReason::LfsTransferUnconfigured,
                object_count: None,
                lfs_declaration: None,
            }
        ),
        "{error:?}"
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);

    counting_hook(
        &f.root,
        "cat >/dev/null\necho 'fatal: Authentication failed for https://lfs-s3.svode.invalid/' >&2\nexit 1",
    );
    assert!(matches!(
        sync::sync(&f.cli, &f.root).await,
        Ok(sync::SyncResult::AuthRequired { .. })
    ));

    counting_hook(
        &f.root,
        "cat >/dev/null\necho 'fixture hook declined publication' >&2\nexit 1",
    );
    let error = sync::sync(&f.cli, &f.root).await.unwrap_err();
    assert!(
        matches!(&error, GitError::GitCommandFailed(message) if message.contains("fixture hook declined publication")),
        "{error:?}"
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
}

/// Real git-lfs with the committed declaration and no local agent.
#[tokio::test]
async fn real_git_lfs_without_agent_reports_unconfigured_transfer() {
    let f = Fixture::new();
    if !f.cli.lfs_available() {
        return;
    }
    git(&f.root, &["lfs", "install", "--local"]);
    git(&f.root, &["lfs", "track", "*.bin"]);
    apply_lfs_declaration(&f.root, AssetsStrategy::LfsS3).unwrap();
    std::fs::write(f.root.join("asset.bin"), "outsider bytes\n".repeat(64)).unwrap();
    git(
        &f.root,
        &["add", ".gitattributes", ".lfsconfig", "asset.bin"],
    );
    git(&f.root, &["commit", "-m", "declared LFS payload"]);
    let before = git(&f.remote, &["rev-parse", "main"]);

    let error = ops::push(&f.cli, &f.root).await.unwrap_err();
    assert!(
        matches!(
            error,
            GitError::PushRejected {
                reason: PushRejectionReason::LfsTransferUnconfigured,
                ..
            }
        ),
        "{error:?}"
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    assert!(!f.remote.join("lfs/objects").exists());
}
