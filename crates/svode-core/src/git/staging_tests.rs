use super::flow::{ParentPublication, SyncReport};
use super::host::{GitHost, HostFuture};
use super::operations::SharedError;
use super::{GitError, cli::GitCli, ops};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::TempDir;

/// Counting host: the services keep their own effects, the fixture only
/// records what the runtime was asked to deliver and whether it may write.
#[derive(Default)]
pub(super) struct TestHost {
    pub(super) authorization: Option<GitError>,
    pub(super) commits: Mutex<Vec<(PathBuf, PathBuf)>>,
    pub(super) auto_syncs: Mutex<Vec<PathBuf>>,
    pub(super) sync_states: Mutex<Vec<(PathBuf, bool)>>,
    pub(super) publications: Mutex<Vec<(PathBuf, String)>>,
    pub(super) refreshed: Mutex<Vec<PathBuf>>,
}

impl TestHost {
    pub(super) fn denied(error: GitError) -> Self {
        Self {
            authorization: Some(error),
            ..Self::default()
        }
    }

    fn authorization(&self) -> Result<(), GitError> {
        match &self.authorization {
            None => Ok(()),
            Some(GitError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            }) => Err(GitError::RepositoryAccessDenied {
                repository_id: repository_id.clone(),
                status: status.clone(),
                reason: reason.clone(),
            }),
            Some(error) => Err(GitError::General(error.to_string())),
        }
    }
}

impl GitHost for TestHost {
    fn authorize_repository<'a>(&'a self, _: &'a Path) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move { self.authorization() })
    }

    fn authorize_paths<'a>(&'a self, _: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move { self.authorization() })
    }

    fn invalidate_repository_access<'a>(
        &'a self,
        _: &'a GitCli,
        _: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn record_write_evidence<'a>(&'a self, _: &'a GitCli, _: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn refresh_synced_repository<'a>(
        &'a self,
        _: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            self.refreshed
                .lock()
                .unwrap()
                .push(repository.to_path_buf());
        })
    }

    fn invalidate_actor_space<'a>(&'a self, _: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn publish_commit(&self, space: &Path, repository: &Path) {
        self.commits
            .lock()
            .unwrap()
            .push((space.to_path_buf(), repository.to_path_buf()));
    }

    fn schedule_auto_sync(&self, repository: &Path) {
        self.auto_syncs
            .lock()
            .unwrap()
            .push(repository.to_path_buf());
    }

    fn publish_sync_state(
        &self,
        repository: &Path,
        active: bool,
        _: Option<&SyncReport>,
        _: Option<&SharedError>,
    ) {
        self.sync_states
            .lock()
            .unwrap()
            .push((repository.to_path_buf(), active));
    }

    fn publish_publication(
        &self,
        repository: &Path,
        child_head: &str,
        _: Option<&ParentPublication>,
    ) {
        self.publications
            .lock()
            .unwrap()
            .push((repository.to_path_buf(), child_head.to_string()));
    }
}

pub(super) fn cli() -> GitCli {
    #[cfg(target_os = "macos")]
    {
        GitCli::for_test("/usr/bin/git".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        GitCli::detect().unwrap()
    }
}

pub(super) async fn git(cli: &GitCli, repo: &Path, args: &[&str]) -> String {
    let out = cli.exec_redacted(repo, args).await.unwrap();
    assert_eq!(out.exit_code, 0, "{args:?}: {}", out.stderr);
    out.stdout
}

pub(super) fn write(repo: &Path, path: &str, content: &str) {
    let path = repo.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// Minimal Space source layout: portable config, local config and a home README.
pub(super) fn scaffold(path: &Path, name: &str) {
    std::fs::create_dir_all(path.join(".svode")).unwrap();
    std::fs::write(
        path.join(".svode/config.json"),
        format!("{{\n  \"name\": \"{name}\",\n  \"description\": \"\",\n  \"icon\": \"\\u{{1F4C1}}\"\n}}\n"),
    )
    .unwrap();
    std::fs::write(path.join(".svode/local.json"), "{}\n").unwrap();
    std::fs::write(
        path.join("README.md"),
        format!("---\ntitle: {name}\n---\n\n"),
    )
    .unwrap();
}

pub(super) async fn repo(cli: &GitCli, born: bool) -> TempDir {
    let tmp = TempDir::new().unwrap();
    git(cli, tmp.path(), &["init"]).await;
    git(cli, tmp.path(), &["config", "user.name", "Test"]).await;
    git(
        cli,
        tmp.path(),
        &["config", "user.email", "test@example.test"],
    )
    .await;
    git(cli, tmp.path(), &["config", "commit.gpgsign", "false"]).await;
    if born {
        write(tmp.path(), "baseline.md", "baseline\n");
        git(cli, tmp.path(), &["add", "."]).await;
        git(cli, tmp.path(), &["commit", "-m", "Baseline"]).await;
    }
    tmp
}

/// Born root repository that tracks one real submodule Space `Исследования`
/// (own repository, `.gitmodules` entry and a committed gitlink).
pub(super) async fn submodule_project(cli: &GitCli) -> (TempDir, PathBuf) {
    let tmp = repo(cli, true).await;
    let root = tmp.path();
    let child = root.join("Исследования");
    std::fs::create_dir(&child).unwrap();
    git(cli, &child, &["init"]).await;
    git(cli, &child, &["config", "user.name", "Test"]).await;
    git(cli, &child, &["config", "user.email", "test@example.test"]).await;
    git(cli, &child, &["config", "commit.gpgsign", "false"]).await;
    write(&child, "README.md", "child baseline\n");
    ops::commit_paths(cli, &child, &["README.md".into()])
        .await
        .unwrap();
    write(
        root,
        ".gitmodules",
        "[submodule \"Исследования\"]\n\tpath = Исследования\n\turl = ./Исследования\n",
    );
    ops::commit_paths(cli, root, &[".gitmodules".into(), "Исследования".into()])
        .await
        .unwrap();
    (tmp, child)
}

#[tokio::test]
async fn selected_prefix_and_index_matrix() {
    let cli = cli();
    for staged in 0..4 {
        let tmp = repo(&cli, true).await;
        let root = tmp.path();
        let paths = [
            "Research/a.md",
            "Исследования/README.md",
            "Исследования/Рынок и конкуренты/README.md",
            "zadachi-komplaens/a.md",
            "abcdefghijklm/f.md",
            "abcdefghijklmn/f.md",
            "d/a-very-long-file-name.md",
            "literal [*?]/[note].md",
        ];
        for path in paths {
            write(root, path, "selected\n");
        }
        write(root, "baseline.md", "selected tracked\n");
        write(root, "outside.md", "staged outside\n");
        let before = if staged > 0 {
            git(&cli, root, &["add", "outside.md"]).await;
            write(root, "outside.md", "working outside\n");
            git(&cli, root, &["ls-files", "--stage", "-z", "outside.md"]).await
        } else {
            String::new()
        };
        if staged >= 2 {
            git(&cli, root, &["add", "Research/a.md"]).await;
        }
        if staged == 3 {
            git(&cli, root, &["add", "baseline.md"]).await;
            write(root, "baseline.md", "current selected\n");
        }
        let selected = paths
            .into_iter()
            .chain(["baseline.md"])
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert!(ops::commit_paths(&cli, root, &selected).await.unwrap());
        let tree = git(&cli, root, &["ls-tree", "-r", "--name-only", "HEAD"]).await;
        for path in selected {
            assert!(tree.lines().any(|p| p == path), "{tree} missing {path}");
        }
        assert!(!tree.contains("outside.md"));
        assert_eq!(
            git(&cli, root, &["ls-files", "--stage", "-z", "outside.md"]).await,
            before
        );
        if staged > 0 {
            assert_eq!(
                std::fs::read_to_string(root.join("outside.md")).unwrap(),
                "working outside\n"
            );
        }
        assert_eq!(
            git(&cli, root, &["show", "HEAD:baseline.md"]).await,
            if staged == 3 {
                "current selected\n"
            } else {
                "selected tracked\n"
            }
        );
    }
}

#[tokio::test]
async fn directory_save_filters_local_families_preserves_staged_and_ignore_rules() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    let mut locals = vec![];
    for prefix in ["", "Research/", "Исследования/", "zadachi-komplaens/"] {
        for name in [
            "index.db",
            "index.db-wal",
            "index.db.broken",
            "local.json",
            "lfs-s3-agent.json",
            "variables.lock",
        ] {
            let path = format!("{prefix}.svode/{name}");
            write(root, &path, "legacy\n");
            locals.push(path);
        }
        write(root, &format!("{prefix}.svode/config.json"), "portable\n");
    }
    git(&cli, root, &["add", "."]).await;
    git(&cli, root, &["commit", "-m", "Legacy"]).await;
    for path in &locals {
        write(root, path, "staged local\n");
    }
    git(&cli, root, &["add", "."]).await;
    let before = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
    for prefix in ["", "Research/", "Исследования/", "zadachi-komplaens/"] {
        write(
            root,
            &format!("{prefix}.svode/new.db-shm"),
            "untracked local\n",
        );
        write(
            root,
            &format!("{prefix}.svode/config.json"),
            "updated portable\n",
        );
    }
    write(root, ".gitignore", "ignored.md\n");
    write(root, "ignored.md", "ignored\n");
    assert!(ops::commit_paths(&cli, root, &[".".into()]).await.unwrap());
    let committed = git(&cli, root, &["show", "--format=", "--name-only", "HEAD"]).await;
    assert!(committed.contains("Исследования/.svode/config.json"));
    assert!(!committed.contains(".db"));
    assert!(!committed.contains("local.json"));
    let after = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
    for path in locals {
        let suffix = format!("\t{path}");
        assert_eq!(
            before.split('\0').find(|p| p.ends_with(&suffix)),
            after.split('\0').find(|p| p.ends_with(&suffix))
        );
        assert!(ops::commit_paths(&cli, root, &[path]).await.is_err());
    }
    assert!(
        !git(&cli, root, &["ls-tree", "-r", "--name-only", "HEAD"])
            .await
            .contains("ignored.md")
    );
}

#[tokio::test]
async fn deletion_rename_directory_noop_and_unborn() {
    let cli = cli();
    for staged_delete in [false, true] {
        let tmp = repo(&cli, true).await;
        let root = tmp.path();
        write(root, "folder/old.md", "rename\n");
        write(root, "folder/deleted.md", "delete\n");
        ops::commit_paths(&cli, root, &["folder".into()])
            .await
            .unwrap();
        std::fs::rename(root.join("folder/old.md"), root.join("folder/new.md")).unwrap();
        std::fs::remove_file(root.join("folder/deleted.md")).unwrap();
        if staged_delete {
            git(&cli, root, &["add", "folder"]).await;
        }
        assert!(
            ops::commit_paths(&cli, root, &["folder".into()])
                .await
                .unwrap()
        );
        assert_eq!(
            git(
                &cli,
                root,
                &["ls-tree", "-r", "--name-only", "HEAD", "folder"]
            )
            .await
            .trim(),
            "folder/new.md"
        );
        assert!(
            !ops::commit_paths(&cli, root, &["folder".into()])
                .await
                .unwrap()
        );
    }
    let tmp = repo(&cli, false).await;
    write(tmp.path(), "Исследования/README.md", "initial\n");
    assert!(
        ops::commit_paths(&cli, tmp.path(), &["Исследования".into()])
            .await
            .unwrap()
    );
    assert!(!ops::commit_paths(&cli, tmp.path(), &[]).await.unwrap());
}

#[cfg(unix)]
pub(super) fn executable(path: &Path, content: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
pub(super) fn fault_cli(tmp: &Path, real: &GitCli, body: &str) -> GitCli {
    let script = tmp.join("fault-git");
    executable(
        &script,
        &format!(
            "#!/bin/sh\n{body}\nexec '{}' \"$@\"\n",
            real.git_path().display()
        ),
    );
    GitCli::for_test(script)
}

#[cfg(unix)]
#[tokio::test]
async fn staging_faults_and_hook_text_never_report_success_or_leak_output() {
    let real = cli();
    for (body, stage) in [
        (
            "for arg in \"$@\"; do if [ \"$arg\" = add ]; then exit 0; fi; done",
            "verify",
        ),
        (
            "for arg in \"$@\"; do if [ \"$arg\" = add ]; then echo SECRET_HOME_AND_TOKEN >&2; exit 23; fi; done",
            "prepare",
        ),
    ] {
        for new in [false, true] {
            let tmp = repo(&real, true).await;
            let root = tmp.path();
            let fault = TempDir::new().unwrap();
            let cli = fault_cli(fault.path(), &real, body);
            let path = if new {
                "zadachi-komplaens/new.md"
            } else {
                "baseline.md"
            };
            write(root, path, "changed\n");
            let head = git(&real, root, &["rev-parse", "HEAD"]).await;
            let err = ops::commit_paths(&cli, root, &[path.into()])
                .await
                .unwrap_err();
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["stage"], stage);
            assert!(!json.to_string().contains("SECRET"));
            assert!(
                !json
                    .to_string()
                    .contains(&root.to_string_lossy().to_string())
            );
            assert_eq!(git(&real, root, &["rev-parse", "HEAD"]).await, head);
            assert_eq!(
                std::fs::read_to_string(root.join(path)).unwrap(),
                "changed\n"
            );
        }
    }
    let tmp = repo(&real, true).await;
    let root = tmp.path();
    write(root, "baseline.md", "changed\n");
    executable(
        &root.join(".git/hooks/pre-commit"),
        "#!/bin/sh\necho 'nothing to commit SECRET_HOME_AND_TOKEN' >&2\nexit 1\n",
    );
    let err = ops::commit_paths(&real, root, &["baseline.md".into()])
        .await
        .unwrap_err();
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["stage"], "commit");
    assert!(!json.to_string().contains("SECRET"));
    assert!(ops::commit(&real, root, "Retry").await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn clean_filter_and_nested_repo_are_git_owned() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    git(&cli, root, &["config", "filter.upper.clean", "tr a-z A-Z"]).await;
    git(&cli, root, &["config", "filter.upper.smudge", "cat"]).await;
    write(root, ".gitattributes", "*.filtered filter=upper\n");
    write(root, "Исследования/a.filtered", "lowercase\n");
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    git(&cli, &nested, &["init"]).await;
    git(&cli, &nested, &["config", "user.name", "Test"]).await;
    git(
        &cli,
        &nested,
        &["config", "user.email", "test@example.test"],
    )
    .await;
    write(&nested, "secret.md", "nested content\n");
    git(&cli, &nested, &["add", "."]).await;
    git(&cli, &nested, &["commit", "-m", "Nested"]).await;
    assert!(ops::commit_paths(&cli, root, &[".".into()]).await.unwrap());
    assert_eq!(
        git(&cli, root, &["show", "HEAD:Исследования/a.filtered"]).await,
        "LOWERCASE\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("Исследования/a.filtered")).unwrap(),
        "lowercase\n"
    );
    let tree = git(&cli, root, &["ls-tree", "-r", "HEAD"]).await;
    assert!(tree.contains("160000 commit"));
    assert!(!tree.contains("secret.md"));
}

#[cfg(unix)]
#[tokio::test]
async fn worktree_changes_after_staging_fail_before_commit() {
    let real = cli();
    for action in [
        "rm baseline.md",
        "printf 'concurrent change\\n' > baseline.md",
    ] {
        let tmp = repo(&real, true).await;
        let root = tmp.path();
        write(root, "baseline.md", "selected\n");
        let head = git(&real, root, &["rev-parse", "HEAD"]).await;
        let fault = TempDir::new().unwrap();
        let cli = fault_cli(
            fault.path(),
            &real,
            &format!("for arg in \"$@\"; do if [ \"$arg\" = --stat ]; then {action}; fi; done"),
        );
        let error = ops::commit_paths(&cli, root, &["baseline.md".into()])
            .await
            .unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap()["stage"], "verify");
        assert_eq!(git(&real, root, &["rev-parse", "HEAD"]).await, head);
    }
}

#[tokio::test]
async fn conflict_preflight_preserves_index_and_worktree() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    git(&cli, root, &["checkout", "-b", "other"]).await;
    write(root, "baseline.md", "other\n");
    git(&cli, root, &["commit", "-am", "Other"]).await;
    git(&cli, root, &["checkout", "-b", "current", "HEAD^"]).await;
    write(root, "baseline.md", "current\n");
    git(&cli, root, &["commit", "-am", "Current"]).await;
    assert_ne!(
        cli.exec_redacted(root, &["merge", "other"])
            .await
            .unwrap()
            .exit_code,
        0
    );
    let index = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
    let source = std::fs::read(root.join("baseline.md")).unwrap();
    assert!(matches!(
        ops::commit_paths(&cli, root, &["baseline.md".into()]).await,
        Err(GitError::Conflict(_))
    ));
    assert_eq!(git(&cli, root, &["ls-files", "--stage", "-z"]).await, index);
    assert_eq!(std::fs::read(root.join("baseline.md")).unwrap(), source);
}

#[tokio::test]
async fn selected_commit_preserves_lfs_clean_filter() {
    let cli = cli();
    if !cli.lfs_available() {
        return;
    }
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    git(&cli, root, &["lfs", "install", "--local"]).await;
    write(
        root,
        ".gitattributes",
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    write(root, "Исследования/asset.bin", "binary fixture\n");
    assert!(
        ops::commit_paths(
            &cli,
            root,
            &[".gitattributes".into(), "Исследования".into()]
        )
        .await
        .unwrap()
    );
    let blob = git(&cli, root, &["show", "HEAD:Исследования/asset.bin"]).await;
    assert!(blob.starts_with("version https://git-lfs.github.com/spec/v1\n"));
    assert!(blob.contains("oid sha256:"));
    assert_eq!(
        std::fs::read_to_string(root.join("Исследования/asset.bin")).unwrap(),
        "binary fixture\n"
    );
}
