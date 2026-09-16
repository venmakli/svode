#![cfg(unix)]
use super::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim_end().into()
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    child: PathBuf,
    remote: PathBuf,
    source: PathBuf,
    cli: GitCli,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let seed = temp.path().join("seed");
        for repo in [&root, &seed] {
            std::fs::create_dir(repo).unwrap();
            git(repo, &["init", "-b", "main"]);
            git(repo, &["config", "user.name", "Fixture"]);
            git(repo, &["config", "user.email", "fixture@example.test"]);
            commit(repo, "note", "initial");
        }
        let source = temp.path().join("child.git");
        let remote = temp.path().join("root.git");
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                source.to_str().unwrap(),
            ],
        );
        git(
            &root,
            &[
                "submodule",
                "add",
                "--name",
                "logical child",
                source.to_str().unwrap(),
                "Пространство one",
            ],
        );
        git(&root, &["commit", "-am", "child"]);
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                root.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&root, &["push", "-u", "origin", "main"]);
        let child = root.join("Пространство one");
        git(&child, &["config", "user.name", "Fixture"]);
        git(&child, &["config", "user.email", "fixture@example.test"]);
        let wrapper = temp.path().join("git-test");
        std::fs::write(&wrapper, "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _temp: temp,
            root,
            child,
            remote,
            source,
            cli: GitCli::for_test(wrapper),
        }
    }
    fn pointer(&self) {
        git(&self.root, &["add", "Пространство one"]);
        git(&self.root, &["commit", "-m", "pointer"]);
    }
    async fn push(&self) -> Result<GitOutput, AppError> {
        super::push(&self.cli, &self.root, false).await
    }
}
fn commit(repo: &Path, file: &str, value: &str) {
    std::fs::write(repo.join(file), value).unwrap();
    git(repo, &["add", file]);
    git(repo, &["commit", "-m", value]);
}

#[tokio::test]
async fn child_must_be_reachable_from_project_source_and_fresh_clone_works() {
    let f = Fixture::new();
    let before = git(&f.remote, &["rev-parse", "main"]);
    commit(&f.child, "note", "new child");
    f.pointer();
    assert!(matches!(
        f.push().await,
        Err(AppError::GitPublicationBlocked {
            reason: PublicationBlockReason::RevisionUnavailable,
            ..
        })
    ));
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    let other = f._temp.path().join("other.git");
    git(f._temp.path(), &["init", "--bare", other.to_str().unwrap()]);
    git(
        &f.child,
        &["remote", "add", "other", other.to_str().unwrap()],
    );
    git(&f.child, &["push", "other", "main"]);
    assert!(f.push().await.is_err());
    git(&f.child, &["push", "origin", "main"]);
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    let clone = f._temp.path().join("fresh");
    git(
        f._temp.path(),
        &[
            "clone",
            "--recurse-submodules",
            f.remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    assert_eq!(
        std::fs::read_to_string(clone.join("Пространство one/note")).unwrap(),
        "new child"
    );
}

#[tokio::test]
async fn stale_deleted_refs_and_historical_sources_do_not_prove_publication() {
    let f = Fixture::new();
    commit(&f.child, "note", "historical");
    f.pointer();
    git(&f.child, &["push", "origin", "main:temporary"]);
    git(&f.source, &["update-ref", "-d", "refs/heads/temporary"]);
    assert!(f.push().await.is_err());
    // A later available pointer must not hide an unavailable intermediate one.
    git(&f.child, &["checkout", "--detach", "origin/main"]);
    f.pointer();
    assert!(f.push().await.is_err());
}

#[tokio::test]
async fn relative_url_uses_published_project_and_not_child_override() {
    let f = Fixture::new();
    git(
        &f.root,
        &[
            "config",
            "-f",
            ".gitmodules",
            "submodule.logical child.url",
            "../child.git",
        ],
    );
    git(&f.root, &["commit", "-am", "relative source"]);
    commit(&f.child, "note", "published");
    f.pointer();
    git(&f.child, &["push", "origin", "main"]);
    assert_eq!(f.push().await.unwrap().exit_code, 0);
}

#[tokio::test]
async fn first_publish_checks_all_history_and_uninitialized_child_is_blocked() {
    let f = Fixture::new();
    git(&f.remote, &["update-ref", "-d", "refs/heads/main"]);
    git(
        &f.root,
        &["submodule", "deinit", "-f", "--", "Пространство one"],
    );
    assert!(matches!(
        super::push(&f.cli, &f.root, true).await,
        Err(AppError::GitPublicationBlocked {
            reason: PublicationBlockReason::UninitializedChild,
            ..
        })
    ));
}

#[tokio::test]
async fn pointer_commit_is_immutable_and_preserves_unrelated_index_and_worktree() {
    let f = Fixture::new();
    commit(&f.child, "note", "first published");
    git(&f.child, &["push", "origin", "main"]);
    let published = git(&f.child, &["rev-parse", "HEAD"]);
    std::fs::write(f.root.join("note"), "staged version").unwrap();
    git(&f.root, &["add", "note"]);
    std::fs::write(f.root.join("note"), "disk version").unwrap();
    let staged = git(&f.root, &["show", ":note"]);
    assert!(
        super::super::published_pointer::commit(&f.cli, &f.root, &f.child, &published)
            .await
            .unwrap()
    );
    assert_eq!(git(&f.root, &["show", ":note"]), staged);
    assert_eq!(
        std::fs::read_to_string(f.root.join("note")).unwrap(),
        "disk version"
    );
    assert_eq!(git(&f.root, &["show", "HEAD:note"]), "initial");
    assert_eq!(
        git(&f.root, &["rev-parse", "HEAD:Пространство one"]),
        published
    );
    assert!(
        !super::super::published_pointer::commit(&f.cli, &f.root, &f.child, &published)
            .await
            .unwrap()
    );
    commit(&f.child, "note", "changed after publication");
    let before = git(&f.root, &["rev-parse", "HEAD"]);
    assert!(
        super::super::published_pointer::commit(&f.cli, &f.root, &f.child, &published)
            .await
            .is_err()
    );
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(&f.root, &["show", ":note"]), staged);
}

#[tokio::test]
async fn all_publishers_refuse_unpublished_historical_gitlinks() {
    let f = Fixture::new();
    commit(&f.child, "note", "unpublished");
    f.pointer();
    let before = git(&f.remote, &["rev-parse", "main"]);
    assert!(super::super::ops::push(&f.cli, &f.root).await.is_err());
    assert!(
        super::super::ops::push_set_upstream(&f.cli, &f.root)
            .await
            .is_err()
    );
    assert!(super::super::sync::sync(&f.cli, &f.root).await.is_err());
    // A real merge continuation has its own publisher entry point.
    git(&f.root, &["checkout", "-b", "side", "HEAD~1"]);
    commit(&f.root, "side", "side change");
    git(&f.root, &["checkout", "main"]);
    git(&f.root, &["merge", "--no-commit", "side"]);
    assert!(
        super::super::sync::resolve_and_continue(&f.cli, &f.root)
            .await
            .is_err()
    );
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
}

#[tokio::test]
async fn multiple_children_and_changed_historical_source_are_all_verified() {
    let f = Fixture::new();
    git(
        &f.root,
        &["submodule", "add", f.source.to_str().unwrap(), "second"],
    );
    git(&f.root, &["commit", "-am", "second child"]);
    commit(&f.child, "note", "new child");
    f.pointer();
    git(&f.child, &["push", "origin", "main"]);
    let missing = f._temp.path().join("missing.git");
    git(
        &f.root,
        &[
            "config",
            "-f",
            ".gitmodules",
            "submodule.logical child.url",
            missing.to_str().unwrap(),
        ],
    );
    git(&f.root, &["commit", "-am", "bad historical source"]);
    git(
        &f.root,
        &[
            "config",
            "-f",
            ".gitmodules",
            "submodule.logical child.url",
            f.source.to_str().unwrap(),
        ],
    );
    git(&f.root, &["commit", "-am", "restored source"]);
    assert!(matches!(
        f.push().await,
        Err(AppError::GitPublicationBlocked {
            reason: PublicationBlockReason::SourceUnavailable,
            ..
        })
    ));
}

#[tokio::test]
async fn concurrent_root_and_child_publish_never_expose_an_unavailable_pointer() {
    let f = Fixture::new();
    commit(&f.child, "note", "concurrent");
    f.pointer();
    let state = super::super::commands::GitState::new();
    let child_lock = state.get_lock(&f.child).await;
    let root_lock = state.get_lock(&f.root).await;
    let (root_result, child_result) = tokio::join!(
        async {
            let _guard = root_lock.lock().await;
            f.push().await
        },
        async {
            let _guard = child_lock.lock().await;
            super::super::ops::push(&f.cli, &f.child).await
        }
    );
    child_result.unwrap();
    if let Ok(out) = root_result {
        assert_eq!(out.exit_code, 0);
    }
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    let alias = f._temp.path().join("alias");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    assert!(std::sync::Arc::ptr_eq(
        &root_lock,
        &state.get_lock(&alias).await
    ));
    assert_eq!(
        git(&f.remote, &["rev-parse", "main:Пространство one"]),
        git(&f.source, &["rev-parse", "main"])
    );
}

#[tokio::test]
async fn background_policy_combinations_never_authorize_child_from_root() {
    for child_auto in [false, true] {
        for root_auto in [false, true] {
            let f = Fixture::new();
            for (repo, enabled) in [(&f.root, root_auto), (&f.child, child_auto)] {
                std::fs::create_dir_all(repo.join(".svode")).unwrap();
                std::fs::write(
                    repo.join(".svode/local.json"),
                    format!(r#"{{"git":{{"autoSync":{enabled}}}}}"#),
                )
                .unwrap();
            }
            commit(&f.child, "note", "policy child");
            f.pointer();
            let child_before = git(&f.source, &["rev-parse", "main"]);
            let root_before = git(&f.remote, &["rev-parse", "main"]);
            let result = super::super::sync::sync_if_enabled(&f.cli, &f.child, true)
                .await
                .unwrap();
            assert_eq!(result.is_some(), child_auto);
            let root_result = super::super::sync::sync_if_enabled(&f.cli, &f.root, true).await;
            if child_auto && root_auto {
                assert!(root_result.unwrap().is_some());
            } else if root_auto {
                assert!(root_result.is_err());
            } else {
                assert!(root_result.unwrap().is_none());
            }
            assert_eq!(
                git(&f.source, &["rev-parse", "main"]) != child_before,
                child_auto
            );
            assert_eq!(
                git(&f.remote, &["rev-parse", "main"]) != root_before,
                child_auto && root_auto
            );
        }
    }
}

#[tokio::test]
async fn independently_published_child_is_proven_without_cached_tracking_refs() {
    let f = Fixture::new();
    commit(&f.child, "note", "external publisher");
    f.pointer();
    // Publish from another checkout: the active child's tracking refs stay stale.
    let other = f._temp.path().join("external");
    git(
        f._temp.path(),
        &["clone", f.child.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["push", f.source.to_str().unwrap(), "main"]);
    let refs = git(&f.child, &["show-ref"]);
    assert_eq!(f.push().await.unwrap().exit_code, 0);
    assert_eq!(git(&f.child, &["show-ref"]), refs);
}

#[tokio::test]
async fn ref_or_target_change_during_proof_requires_a_new_attempt() {
    for change_head in [true, false] {
        let f = Fixture::new();
        commit(&f.child, "note", "race child");
        f.pointer();
        git(&f.child, &["push", "origin", "main"]);
        let before = git(&f.remote, &["rev-parse", "main"]);
        let marker = f._temp.path().join("injected");
        let replacement = f._temp.path().join("replacement.git");
        git(
            f._temp.path(),
            &["init", "--bare", replacement.to_str().unwrap()],
        );
        let mutation = if change_head {
            format!(
                "git -C '{}' -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -m concurrent >/dev/null",
                f.root.display()
            )
        } else {
            format!(
                "git -C '{}' remote set-url origin '{}'",
                f.root.display(),
                replacement.display()
            )
        };
        let script = format!(
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\ncase \"$*\" in *for-each-ref*--contains=*) if [ ! -f '{}' ]; then touch '{}'; {}; fi ;; esac\nexec git -c protocol.file.allow=always \"$@\"\n",
            marker.display(),
            marker.display(),
            mutation
        );
        std::fs::write(f.cli.git_path(), script).unwrap();
        assert!(matches!(
            f.push().await,
            Err(AppError::GitPublicationBlocked {
                reason: PublicationBlockReason::TargetChanged,
                ..
            })
        ));
        assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    }
}

#[tokio::test]
async fn parent_permission_is_optional_after_child_save_and_publication() {
    for denied in ["unknown", "read_only"] {
        let f = Fixture::new();
        let store = f._temp.path().join("access.json");
        let access = crate::git::access::RepositoryAccessState::new();
        access
            .record_writable_evidence(&f.cli, &f.child, &store)
            .await
            .unwrap();
        access
            .require_mutation(&f.cli, &f.child, &store)
            .await
            .unwrap();
        std::fs::write(f.child.join("note"), "child saved").unwrap();
        assert!(
            crate::git::ops::commit_paths(&f.cli, &f.child, &["note".into()])
                .await
                .unwrap()
        );
        let head = git(&f.child, &["rev-parse", "HEAD"]);
        let root_refs = git(&f.root, &["show-ref"]);
        let index_path = git(
            &f.root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        );
        let index = std::fs::read(&index_path).unwrap();
        let mut permission = access
            .require_mutation(&f.cli, &f.root, &store)
            .await
            .map(|_| ());
        if denied == "read_only" {
            std::fs::write(
                f.remote.join("hooks/pre-receive"),
                "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n",
            )
            .unwrap();
            std::fs::set_permissions(
                f.remote.join("hooks/pre-receive"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            let snapshot = access.verify(&f.cli, &f.root, &store).await.unwrap();
            assert_eq!(
                snapshot.status,
                crate::git::access::RepositoryAccessStatus::ReadOnly
            );
            permission = access
                .require_mutation(&f.cli, &f.root, &store)
                .await
                .map(|_| ());
        }
        let local = crate::git::publication_flow::parent_step_locked(
            &f.cli, &f.child, &f.root, &head, false, false, permission,
        )
        .await;
        let local = serde_json::to_value(local).unwrap();
        assert_eq!(local["error"]["status"], denied);
        assert_eq!(git(&f.root, &["show-ref"]), root_refs);
        assert_eq!(std::fs::read(&index_path).unwrap(), index);
        let child = crate::git::sync::sync(&f.cli, &f.child).await.unwrap();
        assert!(matches!(
            child,
            crate::git::sync::SyncResult::Success { .. }
        ));
        let permission = access
            .require_mutation(&f.cli, &f.root, &store)
            .await
            .map(|_| ());
        let outcome = crate::git::publication_flow::parent_step_locked(
            &f.cli, &f.child, &f.root, &head, false, true, permission,
        )
        .await;
        assert_eq!(
            serde_json::to_value(outcome).unwrap()["error"]["status"],
            denied
        );
        assert_eq!(git(&f.source, &["rev-parse", "main"]), head);
        assert_eq!(git(&f.root, &["show-ref"]), root_refs);
        assert_eq!(std::fs::read(&index_path).unwrap(), index);
    }
}

#[tokio::test]
async fn restart_remote_evidence_and_pointer_only_retry_preserve_child_and_staged_content() {
    let f = Fixture::new();
    commit(&f.child, "note", "child save");
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    assert!(
        !super::head_is_published(&f.cli, &f.child, &head)
            .await
            .unwrap()
    );
    git(&f.child, &["push", "origin", "main"]);
    git(&f.child, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let refs = git(&f.child, &["show-ref"]);
    assert!(
        super::head_is_published(&f.cli, &f.child, &head)
            .await
            .unwrap()
    );
    assert_eq!(git(&f.child, &["show-ref"]), refs);
    std::fs::write(f.root.join("other"), "staged").unwrap();
    git(&f.root, &["add", "other"]);
    std::fs::write(f.root.join("other"), "working copy").unwrap();
    // Keep root dirty for the local pointer phase, then remove the unrelated
    // work only from this fixture before exercising pull/push.
    let local = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        false,
        Ok(()),
    )
    .await;
    assert_eq!(serde_json::to_value(local).unwrap()["pointer"], "local");
    assert_eq!(git(&f.root, &["show", ":other"]), "staged");
    assert_eq!(
        std::fs::read_to_string(f.root.join("other")).unwrap(),
        "working copy"
    );
    git(&f.root, &["reset", "--", "other"]);
    std::fs::remove_file(f.root.join("other")).unwrap();
    for _ in 0..2 {
        let report = crate::git::publication_flow::parent_step_locked(
            &f.cli,
            &f.child,
            &f.root,
            &head,
            false,
            true,
            Ok(()),
        )
        .await;
        assert_eq!(
            serde_json::to_value(report).unwrap()["pointer"],
            "published"
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head);
    }
    assert!(
        super::head_is_published(&f.cli, &f.root, &git(&f.root, &["rev-parse", "HEAD"]))
            .await
            .unwrap()
    );
    git(&f.source, &["update-ref", "-d", "refs/heads/main"]);
    assert!(
        super::head_is_published(&f.cli, &f.child, &head)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn late_parent_rejection_and_policy_skip_keep_child_published() {
    let f = Fixture::new();
    commit(&f.child, "note", "published child");
    git(&f.child, &["push", "origin", "main"]);
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let root = git(&f.root, &["rev-parse", "HEAD"]);
    let report = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        true,
        true,
        Ok(()),
    )
    .await;
    assert_eq!(serde_json::to_value(report).unwrap()["policySkipped"], true);
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), root);
    std::fs::write(
        f.remote.join("hooks/pre-receive"),
        "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(
        f.remote.join("hooks/pre-receive"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let report = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        true,
        Ok(()),
    )
    .await;
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["pointer"], "local");
    assert!(report.get("error").is_some() || report["result"]["type"] == "authRequired");
    assert_eq!(git(&f.source, &["rev-parse", "main"]), head);
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), root);
    std::fs::remove_file(f.remote.join("hooks/pre-receive")).unwrap();
    let report = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        true,
        Ok(()),
    )
    .await;
    assert_eq!(
        serde_json::to_value(report).unwrap()["pointer"],
        "published"
    );
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head);
}

#[tokio::test]
async fn parent_retry_rejects_changed_head_or_remote_target() {
    let f = Fixture::new();
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let target = crate::git::publication_flow::publication_target(&f.cli, &f.child, &f.root)
        .await
        .unwrap();
    crate::git::publication_flow::validate_parent_target(&f.cli, &f.child, &head, &f.root, &target)
        .await
        .unwrap();
    git(
        &f.root,
        &[
            "remote",
            "set-url",
            "origin",
            "https://changed.invalid/root.git",
        ],
    );
    assert!(
        crate::git::publication_flow::validate_parent_target(
            &f.cli, &f.child, &head, &f.root, &target
        )
        .await
        .is_err()
    );
    git(
        &f.root,
        &["remote", "set-url", "origin", f.remote.to_str().unwrap()],
    );
    commit(&f.child, "note", "new local work");
    assert!(
        crate::git::publication_flow::validate_parent_target(
            &f.cli, &f.child, &head, &f.root, &target
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn parent_conflict_preserves_published_child_and_allows_retry_after_resolution() {
    let f = Fixture::new();
    let other = f._temp.path().join("collaborator");
    git(
        f._temp.path(),
        &["clone", f.remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Fixture"]);
    git(&other, &["config", "user.email", "fixture@example.test"]);
    commit(&other, "note", "remote root");
    git(&other, &["push", "origin", "main"]);
    commit(&f.root, "note", "local root");
    commit(&f.child, "note", "published child");
    git(&f.child, &["push", "origin", "main"]);
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let outcome = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        true,
        Ok(()),
    )
    .await;
    let outcome = serde_json::to_value(outcome).unwrap();
    assert_eq!(outcome["result"]["type"], "conflict");
    assert_eq!(outcome["pointer"], "local");
    assert_eq!(git(&f.source, &["rev-parse", "main"]), head);
    std::fs::write(f.root.join("note"), "resolved root").unwrap();
    git(&f.root, &["add", "note"]);
    git(&f.root, &["commit", "--no-edit"]);
    let outcome = crate::git::publication_flow::parent_step_locked(
        &f.cli,
        &f.child,
        &f.root,
        &head,
        false,
        true,
        Ok(()),
    )
    .await;
    assert_eq!(
        serde_json::to_value(outcome).unwrap()["pointer"],
        "published"
    );
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head);
}
