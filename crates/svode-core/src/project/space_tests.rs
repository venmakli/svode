//! Creation of a Space and its creation commit (Stage 11 05 «Коммиты
//! создания», «Git-эффекты по типу», «Ошибки и stable codes», invariants
//! 3–6): what each Git type writes, that the operation never commits, what
//! a refusal and a rollback leave, concurrent creators, and the creation
//! commit with the automatic versions that wait for it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

use super::ProjectError;
use super::scaffold::{self, Storage};
use super::space::{CreationCommit, SpaceCreate, SpaceCreated, create};
use crate::git::cli::GitCli;
use crate::git::flow::{ParentPublication, SyncReport};
use crate::git::host::{GitHost, HostFuture};
use crate::git::operations::SharedError;
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::space_creation;
use crate::git::state::GitRuntime;
use crate::git::versions::MessageLanguage;
use crate::git::versions::auto::{AutoVersions, Closing, Held, close};
use crate::git::{GitError, ops, write_guard};
use crate::space_config;
use crate::storage::config::SpaceGitType;

/// Records commits; refuses repositories named as denied.
#[derive(Default)]
struct Host {
    denied: Vec<PathBuf>,
    commits: Mutex<Vec<PathBuf>>,
}

impl GitHost for Host {
    fn authorize_repository<'a>(
        &'a self,
        repository: &'a Path,
    ) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move {
            if self.denied.iter().any(|denied| denied == repository) {
                return Err(GitError::RepositoryAccessDenied {
                    repository_id: "denied".into(),
                    status: "read_only".into(),
                    reason: "fixture".into(),
                });
            }
            Ok(())
        })
    }

    fn authorize_paths<'a>(&'a self, _paths: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async { Ok(()) })
    }

    fn invalidate_repository_access<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn record_write_evidence<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn refresh_synced_repository<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn invalidate_actor_space<'a>(&'a self, _space: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn publish_commit(&self, _space: &Path, repository: &Path) {
        self.commits.lock().unwrap().push(repository.to_path_buf());
    }

    fn schedule_auto_sync(&self, _repository: &Path) {}

    fn publish_sync_state(
        &self,
        _repository: &Path,
        _active: bool,
        _background: bool,
        _report: Option<&SyncReport>,
        _error: Option<&SharedError>,
    ) {
    }

    fn publish_publication(
        &self,
        _repository: &Path,
        _child_head: &str,
        _parent: Option<&ParentPublication>,
    ) {
    }
}

fn cli() -> GitCli {
    #[cfg(target_os = "macos")]
    {
        GitCli::for_test("/usr/bin/git".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        GitCli::detect().unwrap()
    }
}

async fn git(cli: &GitCli, repo: &Path, args: &[&str]) -> String {
    let out = cli.exec_redacted(repo, args).await.unwrap();
    assert_eq!(out.exit_code, 0, "{args:?}: {}", out.stderr);
    out.stdout
}

fn lines(text: &str) -> Vec<String> {
    let mut lines = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.sort();
    lines
}

/// A Project repository with a committed scaffold, a local identity and the
/// given device flags.
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    cli: GitCli,
    runtime: GitRuntime,
    host: Host,
}

impl Fixture {
    async fn new(policy: GitUserPolicy) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let cli = cli();
        ops::init_with_optional_scaffold_commit(&cli, &root, false)
            .await
            .unwrap();
        git(&cli, &root, &["config", "user.name", "Fixture"]).await;
        git(
            &cli,
            &root,
            &["config", "user.email", "fixture@example.test"],
        )
        .await;
        git(&cli, &root, &["config", "commit.gpgsign", "false"]).await;
        let hooks = temp.path().join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        git(
            &cli,
            &root,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        )
        .await;
        scaffold::scaffold(&root, "Root", "", "", Storage::Own).unwrap();
        git(&cli, &root, &["add", "-A"]).await;
        git(&cli, &root, &["commit", "-qm", "Base"]).await;
        write_user_policy(&root, &policy).unwrap();
        Self {
            _temp: temp,
            root: root.clone(),
            runtime: GitRuntime::with_cli(cli.clone()),
            cli,
            host: Host::default(),
        }
    }

    fn hooks(&self) -> PathBuf {
        self._temp.path().join("hooks")
    }

    async fn create(
        &self,
        folder: &str,
        git_type: SpaceGitType,
    ) -> Result<SpaceCreated, ProjectError> {
        create(
            &self.runtime,
            &self.host,
            request(&self.root, folder, git_type),
        )
        .await
    }

    async fn commit_creations(&self) -> Result<usize, GitError> {
        space_creation::commit_pending(&self.runtime, &self.host, &self.root).await
    }

    async fn head(&self) -> String {
        git(&self.cli, &self.root, &["rev-parse", "HEAD"]).await
    }

    async fn subjects(&self) -> Vec<String> {
        git(&self.cli, &self.root, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    async fn committed(&self, rev: &str) -> Vec<String> {
        lines(
            &git(
                &self.cli,
                &self.root,
                &["show", "--name-only", "--format=", rev],
            )
            .await,
        )
    }

    async fn close(&self) -> Result<AutoVersions, GitError> {
        close(
            &self.runtime,
            &self.host,
            &self.root,
            &Closing::all(Duration::from_secs(60)),
            MessageLanguage::En,
        )
        .await
    }

    fn spaces(&self) -> Vec<String> {
        space_config::read(&self.root)
            .unwrap()
            .spaces
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.path)
            .collect()
    }
}

fn request(root: &Path, folder: &str, git_type: SpaceGitType) -> SpaceCreate {
    SpaceCreate {
        project: root.to_path_buf(),
        name: format!("Space {folder}"),
        folder: folder.to_string(),
        git_type,
        icon: None,
        description: None,
    }
}

fn structural() -> GitUserPolicy {
    GitUserPolicy {
        auto_commit_structural: true,
        ..GitUserPolicy::default()
    }
}

fn content() -> GitUserPolicy {
    GitUserPolicy {
        auto_commit_content: true,
        ..GitUserPolicy::default()
    }
}

/// Every file under `root` with its contents, `.git` internals included, so
/// a refusal can be shown to write nothing.
fn tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if !path.ends_with("write.lock") && !path.ends_with("variables.lock") {
                out.push((path.clone(), std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort();
    out
}

async fn default_branch(cli: &GitCli) -> String {
    let out = cli
        .exec_no_dir(&["config", "--global", "--get", "init.defaultBranch"])
        .await
        .unwrap();
    match out.stdout.trim() {
        branch if out.exit_code == 0 && !branch.is_empty() => branch.to_string(),
        _ => "main".to_string(),
    }
}

#[tokio::test]
async fn each_type_writes_its_scaffold_and_git_effects_without_a_commit() {
    let f = Fixture::new(structural()).await;
    let base = f.head().await;
    let branch = default_branch(&f.cli).await;
    let project_assets = space_config::read(&f.root).unwrap().assets;

    let inline = f.create("notes", SpaceGitType::Inline).await.unwrap();
    let independent = f
        .create("clients", SpaceGitType::Independent)
        .await
        .unwrap();
    let submodule = f.create("code", SpaceGitType::Submodule).await.unwrap();

    // No commit anywhere: neither the Project nor a new repository.
    assert_eq!(f.head().await, base);
    for space in ["clients", "code"] {
        let out = f
            .cli
            .exec(&f.root.join(space), &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap();
        assert_ne!(out.exit_code, 0, "{space} has no commit");
    }
    assert!(f.host.commits.lock().unwrap().is_empty());

    // Inline: scaffold without a storage block, the inline ignore block.
    let notes = f.root.join("notes");
    assert!(notes.join(".svode/local.json").is_file());
    assert!(notes.join("README.md").is_file());
    assert!(!notes.join(".git").exists());
    assert!(space_config::read(&notes).unwrap().assets.is_none());
    let gitignore = std::fs::read_to_string(f.root.join(".gitignore")).unwrap();
    assert!(gitignore.contains("*/.svode/local.json"), "{gitignore}");
    assert!(inline.storage.inherited);
    assert_eq!(
        serde_json::to_value(&inline.storage.assets).unwrap(),
        serde_json::to_value(&project_assets).unwrap()
    );
    assert_eq!(inline.repositories.len(), 1);
    assert_eq!(inline.repositories[0].path, ".");
    assert_eq!(
        inline.repositories[0].commit,
        CreationCommit::Desktop {
            message: "Add inline space notes".into()
        }
    );

    // Independent: own repository by 1.A, the identity of the root, the
    // folder line in the root `.gitignore`.
    let clients = f.root.join("clients");
    let assets = space_config::read(&clients).unwrap().assets.unwrap();
    assert_eq!(
        serde_json::to_value(&assets).unwrap()["binaryRouting"]["lfsThresholdBytes"],
        10_000_000
    );
    for (space, outcome) in [("clients", &independent), ("code", &submodule)] {
        let dir = f.root.join(space);
        assert_eq!(
            git(&f.cli, &dir, &["rev-parse", "--show-object-format"])
                .await
                .trim(),
            "sha1"
        );
        assert_eq!(
            git(&f.cli, &dir, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim(),
            branch
        );
        assert_eq!(
            git(&f.cli, &dir, &["config", "--local", "user.email"])
                .await
                .trim(),
            "fixture@example.test"
        );
        assert!(dir.join(".gitignore").is_file());
        assert!(!outcome.storage.inherited);
        let new = &outcome.repositories[1];
        assert_eq!(new.path, space);
        assert!(new.created);
        assert_eq!(new.initial_branch.as_deref(), Some(branch.as_str()));
        assert_eq!(new.commit, CreationCommit::Manual);
    }
    let gitignore = std::fs::read_to_string(f.root.join(".gitignore")).unwrap();
    assert!(
        gitignore.lines().any(|line| line == "clients/"),
        "{gitignore}"
    );
    assert!(
        !gitignore.lines().any(|line| line == "code/"),
        "{gitignore}"
    );

    // Submodule: local metadata, no gitlink without a commit of the Space.
    let gitmodules = std::fs::read_to_string(f.root.join(".gitmodules")).unwrap();
    assert!(gitmodules.contains("path = code"), "{gitmodules}");
    assert_eq!(
        git(&f.cli, &f.root, &["config", "submodule.code.active"])
            .await
            .trim(),
        "true"
    );
    assert!(
        git(&f.cli, &f.root, &["ls-files", "--stage", "code"])
            .await
            .is_empty()
    );

    assert_eq!(f.spaces(), ["notes", "clients", "code"]);
    assert!(
        inline
            .changed_paths
            .contains(&f.root.join(".svode/config.json"))
    );
}

#[tokio::test]
async fn the_creation_commit_follows_the_structural_flag_and_comes_once() {
    for (git_type, folder, paths) in [
        (
            SpaceGitType::Inline,
            "notes",
            vec![
                ".gitignore",
                ".svode/config.json",
                "notes/.svode/config.json",
                "notes/README.md",
            ],
        ),
        (
            SpaceGitType::Independent,
            "clients",
            vec![".gitignore", ".svode/config.json"],
        ),
        (
            SpaceGitType::Submodule,
            "code",
            vec![".gitmodules", ".svode/config.json"],
        ),
    ] {
        // Off: the changes wait for a manual commit.
        let off = Fixture::new(GitUserPolicy::default()).await;
        let base = off.head().await;
        let created = off.create(folder, git_type).await.unwrap();
        assert_eq!(created.repositories[0].commit, CreationCommit::Manual);
        assert_eq!(off.commit_creations().await.unwrap(), 0);
        assert_eq!(off.head().await, base);
        let pending = space_creation::pending(&off.cli, &off.root).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].git_type, git_type);

        // On: one commit with exactly the creation paths.
        let on = Fixture::new(structural()).await;
        on.create(folder, git_type).await.unwrap();
        assert_eq!(on.commit_creations().await.unwrap(), 1, "{folder}");
        let message = space_creation::creation_message(git_type, folder);
        assert_eq!(on.subjects().await[0], message);
        assert_eq!(on.committed("HEAD").await, paths, "{folder}");
        assert_eq!(*on.host.commits.lock().unwrap(), [on.root.clone()]);

        // A committed `SpaceRef` gives no second commit.
        let head = on.head().await;
        assert!(
            space_creation::pending(&on.cli, &on.root)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(on.commit_creations().await.unwrap(), 0);
        assert_eq!(on.head().await, head);
    }
}

#[tokio::test]
async fn the_creation_commit_leaves_other_changes_and_later_pages_out() {
    let f = Fixture::new(structural()).await;
    std::fs::write(f.root.join("staged.md"), "staged\n").unwrap();
    git(&f.cli, &f.root, &["add", "staged.md"]).await;
    std::fs::write(f.root.join("README.md"), "unstaged edit\n").unwrap();

    f.create("notes", SpaceGitType::Inline).await.unwrap();
    std::fs::write(f.root.join("notes/Page.md"), "---\ntitle: Page\n---\n").unwrap();
    assert_eq!(f.commit_creations().await.unwrap(), 1);

    assert_eq!(
        f.committed("HEAD").await,
        [
            ".gitignore",
            ".svode/config.json",
            "notes/.svode/config.json",
            "notes/README.md"
        ]
    );
    assert_eq!(
        lines(&git(&f.cli, &f.root, &["diff", "--cached", "--name-only"]).await),
        ["staged.md"]
    );
    assert_eq!(
        lines(&git(&f.cli, &f.root, &["diff", "--name-only"]).await),
        ["README.md"]
    );
    let untracked = git(
        &f.cli,
        &f.root,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .await;
    assert_eq!(lines(&untracked), ["notes/Page.md"]);
}

#[tokio::test]
async fn refusals_before_the_first_write_leave_everything_as_it_was() {
    let f = Fixture::new(structural()).await;
    std::fs::create_dir(f.root.join("taken")).unwrap();
    let before = tree(&f.root);

    let refusals = [
        (request(&f.root, "taken", SpaceGitType::Inline), "taken"),
        (request(&f.root, "поддержка", SpaceGitType::Inline), "ascii"),
        (request(&f.root, "a/b", SpaceGitType::Inline), "segment"),
        (
            SpaceCreate {
                name: "  ".into(),
                ..request(&f.root, "blank", SpaceGitType::Inline)
            },
            "name",
        ),
    ];
    for (request, case) in refusals {
        let error = create(&f.runtime, &f.host, request).await.unwrap_err();
        match case {
            "taken" => assert!(
                matches!(error, ProjectError::FileAlreadyExists(_)),
                "{error}"
            ),
            "name" => assert!(matches!(error, ProjectError::NameRequired), "{error}"),
            _ => assert!(matches!(error, ProjectError::InvalidFolder(_)), "{error}"),
        }
        assert_eq!(tree(&f.root), before, "{case}");
    }

    // No Git for a repository of its own.
    let without_git = GitRuntime::without_cli();
    for git_type in [SpaceGitType::Independent, SpaceGitType::Submodule] {
        let error = create(&without_git, &f.host, request(&f.root, "own", git_type))
            .await
            .unwrap_err();
        assert!(
            matches!(error, ProjectError::Git(GitError::GitNotFound)),
            "{error}"
        );
        assert_eq!(tree(&f.root), before);
    }

    // Repository access refused.
    let denied = Host {
        denied: vec![f.root.clone()],
        ..Host::default()
    };
    let error = create(
        &f.runtime,
        &denied,
        request(&f.root, "denied", SpaceGitType::Inline),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(
            error,
            ProjectError::Git(GitError::RepositoryAccessDenied { .. })
        ),
        "{error}"
    );
    assert_eq!(tree(&f.root), before);

    // A Project config that cannot be read.
    let conflict = "{\n<<<<<<< HEAD\n  \"name\": \"Ours\"\n=======\n  \"name\": \"Theirs\"\n>>>>>>> origin/main\n}\n";
    std::fs::write(f.root.join(".svode/config.json"), conflict).unwrap();
    let before = tree(&f.root);
    let error = f.create("new", SpaceGitType::Inline).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        ".svode/config.json cannot be read: it is in a conflict after sync"
    );
    assert_eq!(tree(&f.root), before);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_git_init_rolls_the_creation_back() {
    let f = Fixture::new(structural()).await;
    let fault = tempfile::tempdir().unwrap();
    let script = fault.path().join("git");
    svode_testkit::write_executable(
        &script,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = init ]; then exit 7; fi; done\nexec '{}' \"$@\"\n",
            f.cli.git_path().display()
        ),
    )
    .unwrap();
    let runtime = GitRuntime::with_cli(GitCli::for_test(script));
    let config = std::fs::read(f.root.join(".svode/config.json")).unwrap();
    let gitignore = std::fs::read(f.root.join(".gitignore")).unwrap();

    for git_type in [SpaceGitType::Independent, SpaceGitType::Submodule] {
        let error = create(&runtime, &f.host, request(&f.root, "own", git_type))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("git init failed"), "{error}");
        assert!(!f.root.join("own").exists());
        assert_eq!(
            std::fs::read(f.root.join(".svode/config.json")).unwrap(),
            config
        );
        assert_eq!(std::fs::read(f.root.join(".gitignore")).unwrap(), gitignore);
        assert!(!f.root.join(".gitmodules").exists());
    }
}

#[tokio::test]
async fn a_failed_space_ref_write_rolls_back_the_folder_and_git_effects() {
    for git_type in [
        SpaceGitType::Inline,
        SpaceGitType::Independent,
        SpaceGitType::Submodule,
    ] {
        let f = Fixture::new(structural()).await;
        let config = std::fs::read(f.root.join(".svode/config.json")).unwrap();
        let gitignore = std::fs::read(f.root.join(".gitignore")).unwrap();
        let git_config = std::fs::read(f.root.join(".git/config")).unwrap();
        // A Variables recovery in progress refuses every Project config write.
        std::fs::write(f.root.join(".svode/variables.pending.json"), "{}").unwrap();

        let error = f.create("own", git_type).await.unwrap_err();

        assert!(matches!(error, ProjectError::Config(_)), "{error}");
        assert!(!f.root.join("own").exists(), "{git_type:?}");
        assert_eq!(
            std::fs::read(f.root.join(".svode/config.json")).unwrap(),
            config
        );
        assert_eq!(std::fs::read(f.root.join(".gitignore")).unwrap(), gitignore);
        assert!(!f.root.join(".gitmodules").exists());
        let after = std::fs::read_to_string(f.root.join(".git/config")).unwrap();
        assert!(!after.contains("submodule"), "{after}");
        assert_eq!(after.len(), String::from_utf8(git_config).unwrap().len());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_refused_creation_commit_keeps_the_space_and_returns_the_cause() {
    let f = Fixture::new(structural()).await;
    svode_testkit::write_executable(&f.hooks().join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
    let base = f.head().await;

    f.create("notes", SpaceGitType::Inline).await.unwrap();
    let error = f.commit_creations().await.unwrap_err();

    assert!(matches!(error, GitError::SaveFailed { .. }), "{error}");
    assert_eq!(f.head().await, base);
    assert!(f.root.join("notes/README.md").is_file());
    assert_eq!(f.spaces(), ["notes"]);
    assert_eq!(
        space_creation::pending(&f.cli, &f.root)
            .await
            .unwrap()
            .len(),
        1
    );

    // The next attempt commits once the hook passes.
    std::fs::remove_file(f.hooks().join("pre-commit")).unwrap();
    assert_eq!(f.commit_creations().await.unwrap(), 1);
}

/// Each creator runs on its own thread with its own runtime and Git state,
/// as two processes would; the write guard is a lock on a file.
fn create_concurrently(
    root: &Path,
    folders: [&'static str; 2],
) -> Vec<Result<SpaceCreated, ProjectError>> {
    let barrier = Arc::new(Barrier::new(2));
    let threads = folders
        .into_iter()
        .map(|folder| {
            let barrier = barrier.clone();
            let root = root.to_path_buf();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async move {
                    let git = GitRuntime::with_cli(cli());
                    let host = Host::default();
                    barrier.wait();
                    create(&git, &host, request(&root, folder, SpaceGitType::Inline)).await
                })
            })
        })
        .collect::<Vec<_>>();
    threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect()
}

#[tokio::test]
async fn two_creators_of_different_spaces_both_land_in_the_config() {
    let f = Fixture::new(GitUserPolicy::default()).await;
    let results = create_concurrently(&f.root, ["one", "two"]);
    for result in &results {
        assert!(result.is_ok(), "{:?}", result.as_ref().err());
    }
    let mut spaces = f.spaces();
    spaces.sort();
    assert_eq!(spaces, ["one", "two"]);
}

#[tokio::test]
async fn one_folder_goes_to_one_creator() {
    let f = Fixture::new(GitUserPolicy::default()).await;
    let results = create_concurrently(&f.root, ["same", "same"]);
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let refused = results.into_iter().find_map(Result::err).unwrap();
    assert!(
        matches!(refused, ProjectError::FileAlreadyExists(_)),
        "{refused}"
    );
    assert_eq!(f.spaces(), ["same"]);
}

#[tokio::test]
async fn a_version_waits_for_a_creation_and_never_takes_its_readme_alone() {
    let f = Fixture::new(content()).await;
    let base = f.head().await;

    // Started while a creation holds the guard: nothing is committed.
    let repository = std::fs::canonicalize(&f.root).unwrap();
    let held = write_guard::acquire(&BTreeSet::from([repository]), &[])
        .await
        .unwrap();
    std::fs::write(f.root.join("Edited.md"), "---\ntitle: Edited\n---\n").unwrap();
    assert_eq!(f.close().await.unwrap(), AutoVersions::Held(Held::Writer));
    assert_eq!(f.head().await, base);
    drop(held);

    // Started before the creation commit: the creation commit comes first
    // and carries the README.
    f.create("notes", SpaceGitType::Inline).await.unwrap();
    assert!(matches!(
        f.close().await.unwrap(),
        AutoVersions::Done { .. }
    ));
    let subjects = f.subjects().await;
    let creation = subjects
        .iter()
        .position(|subject| subject == "Add inline space notes")
        .expect("creation commit");
    let revision = format!("HEAD~{creation}");
    assert!(
        f.committed(&revision)
            .await
            .contains(&"notes/README.md".to_string())
    );
    let log = git(
        &f.cli,
        &f.root,
        &["log", "--format=%s", "--", "notes/README.md"],
    )
    .await;
    assert_eq!(lines(&log), ["Add inline space notes"]);
}

#[tokio::test]
async fn pages_of_a_new_inline_space_wait_for_its_creation_commit() {
    let f = Fixture::new(content()).await;
    let base = f.head().await;
    f.create("notes", SpaceGitType::Inline).await.unwrap();
    std::fs::write(
        f.root.join("notes/Page.md"),
        "---\ntitle: Page\n---\nText\n",
    )
    .unwrap();

    // A refused creation commit stops the closing: the page waits with it.
    let lock = f.root.join(".git/index.lock");
    std::fs::write(&lock, "").unwrap();
    assert!(f.close().await.is_err());
    assert_eq!(f.head().await, base);
    std::fs::remove_file(&lock).unwrap();

    // The next closing makes the creation commit first, then the page.
    assert!(matches!(
        f.close().await.unwrap(),
        AutoVersions::Done { commits: 1, .. }
    ));
    let subjects = f.subjects().await;
    assert_eq!(subjects.len(), 3, "{subjects:?}");
    assert_eq!(subjects[1], "Add inline space notes");
    assert_eq!(f.committed("HEAD").await, ["notes/Page.md"]);
    assert!(
        !f.committed("HEAD~1")
            .await
            .contains(&"notes/Page.md".to_string())
    );
}

#[tokio::test]
async fn a_pending_creation_holds_its_paths_and_its_inline_folder() {
    // With structural commits off the creation stays pending; a version
    // takes neither its paths nor anything inside its folder.
    let f = Fixture::new(GitUserPolicy::default()).await;
    f.create("notes", SpaceGitType::Inline).await.unwrap();
    let creations = space_creation::pending(&f.cli, &f.root).await.unwrap();
    let creation = &creations[0];
    for path in [
        ".svode/config.json",
        ".gitignore",
        "notes",
        "notes/",
        "notes/README.md",
        "notes/Page.md",
        "notes/deep/Page.md",
    ] {
        assert!(creation.holds(path), "{path}");
    }
    for path in ["notesbook.md", "README.md", "other/notes/Page.md"] {
        assert!(!creation.holds(path), "{path}");
    }
}
