#![cfg(unix)]

use super::*;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    child: PathBuf,
    seed: PathBuf,
    remote: PathBuf,
    cli: GitCli,
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .trim_end()
        .to_string()
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let seed = temp.path().join("seed");
        let remote = temp.path().join("child.git");
        for repo in [&root, &seed] {
            std::fs::create_dir(repo).unwrap();
            git(repo, &["init", "-b", "main"]);
            git(repo, &["config", "user.name", "Fixture"]);
            git(repo, &["config", "user.email", "fixture@example.test"]);
            std::fs::write(repo.join("note.md"), "base\n").unwrap();
            git(repo, &["add", "."]);
            git(repo, &["commit", "-m", "initial"]);
        }
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["checkout", "-b", "develop"]);
        std::fs::write(seed.join("develop.md"), "develop\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "develop"]);
        git(&seed, &["push", "origin", "develop"]);
        git(
            &root,
            &[
                "submodule",
                "add",
                "--name",
                "logical child",
                remote.to_str().unwrap(),
                "Пространство one",
            ],
        );
        git(&root, &["commit", "-am", "child"]);
        let child = root.join("Пространство one");
        git(&child, &["config", "user.name", "Fixture"]);
        git(&child, &["config", "user.email", "fixture@example.test"]);
        git(&child, &["checkout", "--detach"]);
        let wrapper = temp.path().join("git-test");
        std::fs::write(&wrapper, "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _temp: temp,
            root,
            child,
            seed,
            remote,
            cli: GitCli::for_test(wrapper),
        }
    }
    fn branch(&self, branch: &str) {
        git(
            &self.root,
            &[
                "config",
                "-f",
                ".gitmodules",
                "submodule.logical child.branch",
                branch,
            ],
        );
    }
    async fn prepare(&self) -> Result<(), AppError> {
        prepare(&self.cli, &self.root, &self.child, false).await
    }
    fn snapshot(&self) -> (String, String, String, Vec<u8>) {
        let index = git(
            &self.child,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        );
        (
            git(&self.child, &["rev-parse", "HEAD"]),
            git(&self.child, &["show-ref"]),
            git(&self.child, &["status", "--porcelain=v1", "-uall"]),
            std::fs::read(index).unwrap(),
        )
    }
}

fn reason(error: AppError, expected: BranchBlockReason) {
    assert!(
        matches!(error, AppError::GitBranchBlocked { reason } if reason == expected),
        "{error:?}"
    );
}

#[tokio::test]
async fn configured_branch_uses_exact_section_and_path_with_upstream() {
    let f = Fixture::new();
    f.branch("develop");
    f.prepare().await.unwrap();
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "develop");
    assert_eq!(
        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/develop"
    );
    assert!(f.child.join("develop.md").exists());
}

#[tokio::test]
async fn remote_default_is_authoritative_over_missing_or_stale_origin_head() {
    for missing in [true, false] {
        let f = Fixture::new();
        git(&f.remote, &["symbolic-ref", "HEAD", "refs/heads/develop"]);
        if missing {
            git(
                &f.child,
                &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
            );
        }
        f.prepare().await.unwrap();
        assert_eq!(git(&f.child, &["branch", "--show-current"]), "develop");
    }
}

#[tokio::test]
async fn dot_branch_requires_attached_root() {
    let f = Fixture::new();
    f.branch(".");
    git(&f.root, &["checkout", "-b", "develop"]);
    f.prepare().await.unwrap();
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "develop");
    git(&f.child, &["checkout", "--detach"]);
    git(&f.root, &["checkout", "--detach"]);
    let before = f.snapshot();
    reason(
        f.prepare().await.unwrap_err(),
        BranchBlockReason::RootDetached,
    );
    assert_eq!(f.snapshot(), before);
}

#[tokio::test]
async fn missing_branch_and_offline_preserve_checkout_and_refs() {
    for offline in [true, false] {
        let f = Fixture::new();
        f.branch("absent");
        if offline {
            git(
                &f.child,
                &["remote", "set-url", "origin", "/nonexistent/df126-remote"],
            );
        }
        let before = f.snapshot();
        reason(
            f.prepare().await.unwrap_err(),
            if offline {
                BranchBlockReason::RemoteUnavailable
            } else {
                BranchBlockReason::MissingBranch
            },
        );
        assert_eq!(f.snapshot(), before);
    }
}

#[tokio::test]
async fn detached_dirty_staged_untracked_and_local_commits_are_preserved() {
    for case in ["dirty", "staged", "untracked", "local-commit"] {
        let f = Fixture::new();
        f.branch("develop");
        let path = if case == "untracked" {
            "new.md"
        } else {
            "note.md"
        };
        std::fs::write(f.child.join(path), "local work\n").unwrap();
        if case == "staged" || case == "local-commit" {
            git(&f.child, &["add", "."]);
        }
        if case == "local-commit" {
            git(&f.child, &["commit", "-m", "local only"]);
        }
        let before = f.snapshot();
        reason(
            f.prepare().await.unwrap_err(),
            if case == "local-commit" {
                BranchBlockReason::LocalHistory
            } else {
                BranchBlockReason::LocalChanges
            },
        );
        assert_eq!(f.snapshot(), before, "{case}");
        assert_eq!(
            std::fs::read_to_string(f.child.join(path)).unwrap(),
            "local work\n"
        );
    }
}

#[tokio::test]
async fn incompatible_local_branch_and_operation_are_preserved() {
    let f = Fixture::new();
    f.branch("develop");
    git(&f.child, &["branch", "develop"]);
    git(&f.child, &["checkout", "develop"]);
    std::fs::write(f.child.join("local.md"), "local\n").unwrap();
    git(&f.child, &["add", "."]);
    git(&f.child, &["commit", "-m", "local"]);
    git(&f.child, &["checkout", "--detach", "main"]);
    let before = f.snapshot();
    reason(
        f.prepare().await.unwrap_err(),
        BranchBlockReason::IncompatibleBranch,
    );
    assert_eq!(f.snapshot(), before);
    let merge = git(
        &f.child,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "MERGE_HEAD",
        ],
    );
    std::fs::write(merge, git(&f.child, &["rev-parse", "HEAD"])).unwrap();
    reason(
        f.prepare().await.unwrap_err(),
        BranchBlockReason::OperationInProgress,
    );
}

#[tokio::test]
async fn attached_user_branch_saves_offline_and_preserves_upstream() {
    let f = Fixture::new();
    git(
        &f.child,
        &["checkout", "-b", "personal", "--track", "origin/main"],
    );
    f.branch("develop");
    git(
        &f.child,
        &["remote", "set-url", "origin", "/nonexistent/df126-remote"],
    );
    std::fs::write(f.child.join("note.md"), "saved offline\n").unwrap();
    super::super::ops::commit_paths(&f.cli, &f.child, &["note.md".into()])
        .await
        .unwrap();
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "personal");
    assert_eq!(
        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/main"
    );
}

#[tokio::test]
async fn missing_upstream_is_repaired_only_for_expected_branch() {
    let f = Fixture::new();
    f.branch("develop");
    git(
        &f.child,
        &["checkout", "-b", "develop", "--no-track", "origin/develop"],
    );
    f.prepare().await.unwrap();
    assert_eq!(
        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/develop"
    );
    git(&f.child, &["checkout", "-b", "personal", "--no-track"]);
    reason(
        f.prepare().await.unwrap_err(),
        BranchBlockReason::IncompatibleBranch,
    );
}

#[tokio::test]
async fn partial_materialization_retry_never_resets_existing_work() {
    let f = Fixture::new();
    f.branch("develop");
    std::fs::write(f.child.join("note.md"), "local\n").unwrap();
    let before = f.snapshot();
    reason(
        materialize(&f.cli, &f.root, &f.child, "Пространство one")
            .await
            .unwrap_err(),
        BranchBlockReason::LocalChanges,
    );
    assert_eq!(f.snapshot(), before);
}

#[tokio::test]
async fn managed_commit_entrypoints_refuse_before_staging() {
    for entry in ["paths", "exact", "add", "system"] {
        let f = Fixture::new();
        std::fs::write(f.child.join("note.md"), "pending\n").unwrap();
        let before = f.snapshot();
        let error = match entry {
            "paths" => super::super::ops::commit_paths(&f.cli, &f.child, &["note.md".into()])
                .await
                .unwrap_err(),
            "exact" => super::super::ops::commit_exact_path(&f.cli, &f.child, "note.md", "save")
                .await
                .unwrap_err(),
            "add" => super::super::ops::add(&f.cli, &f.child, "note.md")
                .await
                .unwrap_err(),
            _ => super::super::ops::commit(&f.cli, &f.child, "save")
                .await
                .unwrap_err(),
        };
        reason(error, BranchBlockReason::LocalChanges);
        assert_eq!(f.snapshot(), before, "{entry}");
    }
}

#[tokio::test]
async fn root_pull_never_checks_out_child_even_with_recursion_enabled() {
    let f = Fixture::new();
    f.branch("develop");
    f.prepare().await.unwrap();
    let remote = f._temp.path().join("root.git");
    git(
        f._temp.path(),
        &[
            "clone",
            "--bare",
            f.root.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    git(
        &f.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&f.root, &["push", "-u", "origin", "main"]);
    let other = f._temp.path().join("other");
    git(
        f._temp.path(),
        &["clone", remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Fixture"]);
    git(&other, &["config", "user.email", "fixture@example.test"]);
    std::fs::write(other.join("root-change.md"), "remote\n").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-m", "root change"]);
    git(&other, &["push"]);
    git(&f.root, &["config", "submodule.recurse", "true"]);
    std::fs::write(f.child.join("note.md"), "child work\n").unwrap();
    let before = f.snapshot();
    assert!(matches!(
        super::super::sync::sync(&f.cli, &f.root).await.unwrap(),
        super::super::sync::SyncResult::Success
    ));
    assert_eq!(f.snapshot(), before);
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "develop");
    assert!(f.root.join("root-change.md").exists());
}

#[tokio::test]
async fn attached_divergence_uses_merge_conflict_flow_and_keeps_local_commit() {
    let f = Fixture::new();
    f.branch("develop");
    f.prepare().await.unwrap();
    std::fs::write(f.child.join("note.md"), "local\n").unwrap();
    git(&f.child, &["add", "."]);
    git(&f.child, &["commit", "-m", "local"]);
    let local = git(&f.child, &["rev-parse", "HEAD"]);
    std::fs::write(f.seed.join("note.md"), "remote\n").unwrap();
    git(&f.seed, &["add", "."]);
    git(&f.seed, &["commit", "-m", "remote"]);
    git(&f.seed, &["push", "origin", "develop"]);
    assert!(matches!(
        super::super::sync::sync(&f.cli, &f.child).await.unwrap(),
        super::super::sync::SyncResult::Conflict { .. }
    ));
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), local);
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "develop");
}

#[tokio::test]
async fn initial_materialization_and_retry_use_the_same_owner() {
    let f = Fixture::new();
    f.branch("develop");
    git(&f.root, &["add", ".gitmodules"]);
    git(&f.root, &["commit", "-m", "configure branch"]);
    let clone = f._temp.path().join("fresh");
    git(
        f._temp.path(),
        &["clone", f.root.to_str().unwrap(), clone.to_str().unwrap()],
    );
    let child = clone.join("Пространство one");
    materialize(&f.cli, &clone, &child, "Пространство one")
        .await
        .unwrap();
    assert_eq!(git(&child, &["branch", "--show-current"]), "develop");
    assert_eq!(
        git(&child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/develop"
    );
    std::fs::write(child.join("note.md"), "keep on retry\n").unwrap();
    materialize(&f.cli, &clone, &child, "Пространство one")
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(child.join("note.md")).unwrap(),
        "keep on retry\n"
    );
}

#[tokio::test]
async fn ignored_collision_does_not_overwrite_files_or_create_branch() {
    let f = Fixture::new();
    f.branch("develop");
    let exclude = git(
        &f.child,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    );
    std::fs::write(exclude, "develop.md\n").unwrap();
    std::fs::write(f.child.join("develop.md"), "keep ignored\n").unwrap();
    let before = f.snapshot();
    reason(
        f.prepare().await.unwrap_err(),
        BranchBlockReason::CheckoutFailed,
    );
    assert_eq!(f.snapshot(), before);
    assert_eq!(
        std::fs::read_to_string(f.child.join("develop.md")).unwrap(),
        "keep ignored\n"
    );
}

#[tokio::test]
async fn auth_failure_and_custom_tracking_refspec_fail_without_local_mutations() {
    for auth in [true, false] {
        let f = Fixture::new();
        f.branch("develop");
        if auth {
            let wrapper = f.cli.git_path();
            std::fs::write(wrapper, "#!/bin/sh\ncase \" $* \" in *' ls-remote '*) echo 'Authentication failed' >&2; exit 128;; esac\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n").unwrap();
        } else {
            git(
                &f.child,
                &[
                    "config",
                    "remote.origin.fetch",
                    "+refs/heads/main:refs/remotes/custom/main",
                ],
            );
        }
        let before = f.snapshot();
        reason(
            f.prepare().await.unwrap_err(),
            if auth {
                BranchBlockReason::RemoteUnavailable
            } else {
                BranchBlockReason::Configuration
            },
        );
        assert_eq!(f.snapshot(), before);
    }
}

#[tokio::test]
async fn dirty_attached_pull_never_autostashes_local_work() {
    let f = Fixture::new();
    f.branch("develop");
    f.prepare().await.unwrap();
    std::fs::write(f.seed.join("note.md"), "remote\n").unwrap();
    git(&f.seed, &["add", "."]);
    git(&f.seed, &["commit", "-m", "remote"]);
    git(&f.seed, &["push", "origin", "develop"]);
    std::fs::write(f.child.join("note.md"), "unsaved local\n").unwrap();
    git(&f.child, &["config", "merge.autoStash", "true"]);
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    assert!(super::super::sync::sync(&f.cli, &f.child).await.is_err());
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(f.child.join("note.md")).unwrap(),
        "unsaved local\n"
    );
    assert!(git(&f.child, &["stash", "list"]).is_empty());
}

#[tokio::test]
async fn existing_checkout_discovery_handles_aliased_project_paths() {
    let f = Fixture::new();
    let alias = f._temp.path().join("project-alias");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    prepare_existing(&f.cli, &alias.join("Пространство one"))
        .await
        .unwrap();
    assert_eq!(git(&f.child, &["branch", "--show-current"]), "main");
}
