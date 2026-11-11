//! Roll out local Git policy independently of scaffold creation: the
//! `# svode:local` block of `.gitignore` and the block of system file rules
//! in `info/exclude`.

use std::path::Path;

use super::GitError;
use super::host::GitHost;
use super::path::normalize_space_folder;
use super::state::GitRuntime;
use super::{cli::GitCli, ops};
use crate::content_tree::{ContentTreeError, list_project_children};
use crate::page::SpaceReadiness;
use crate::storage::config::SpaceGitType;

/// One child Space as the parent registry records it. The folder is kept raw
/// so each caller normalizes it in its own order.
struct RegisteredChild {
    folder: String,
    path: std::path::PathBuf,
    ready: bool,
}

fn registered_children(root: &Path) -> Result<Vec<RegisteredChild>, GitError> {
    let children = list_project_children(root).map_err(|error| match error {
        ContentTreeError::Io(error) => GitError::Io(error),
        ContentTreeError::Serde(error) => GitError::Serde(error),
        error => GitError::General(error.to_string()),
    })?;
    Ok(children
        .into_iter()
        .map(|child| RegisteredChild {
            folder: child.folder,
            ready: child.status == SpaceReadiness::Ready,
            path: child.path,
        })
        .collect())
}

fn ready_children(root: &Path) -> Result<Vec<std::path::PathBuf>, GitError> {
    registered_children(root)?
        .into_iter()
        .filter(|child| child.ready)
        .map(|child| normalize_space_folder(&child.folder).map(|_| child.path))
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum RepairOutcome {
    Unchanged,
    Changed,
    Skipped,
}

/// Whether a repair also brings the rules of the `local` assets strategy up
/// to date. Only opening the Project does: a save or a commit must not add
/// a `.gitignore` change of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StorageRules {
    Skip,
    Repair,
}

/// The caller holds the effective repository lock and supplies current access evidence.
async fn repair_authorized(
    cli: &GitCli,
    repository: &Path,
    inline: bool,
    storage_rules: StorageRules,
    authorization: Result<(), GitError>,
) -> Result<RepairOutcome, GitError> {
    if let Err(error) = authorization {
        tracing::info!(repository = %repository.display(), error_kind = error.kind(), "local ignore repair skipped; retry on writable open");
        return Ok(RepairOutcome::Skipped);
    }
    let status = ops::full_status(cli, repository).await?;
    if status.has_conflicts || status.branch == "(detached)" || status.branch == "HEAD" {
        tracing::info!(repository = %repository.display(), "local ignore repair skipped for unsafe repository");
        return Ok(RepairOutcome::Skipped);
    }
    let path = repository.join(".gitignore");
    let before = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    ops::ensure_svode_gitignore(repository)?;
    if inline {
        ops::ensure_inline_gitignore(repository)?;
    }
    if storage_rules == StorageRules::Repair {
        crate::storage::local_rules::repair_local_rules(cli, repository).await?;
    }
    // Only a readable config registers children; one that cannot be read
    // leaves their rollout to an open after it is fixed.
    if crate::space_config::read(repository).is_ok() {
        for child in registered_children(repository)? {
            let folder = normalize_space_folder(&child.folder)?;
            if !child.ready {
                continue;
            }
            match ops::detect_space_git_type(cli, repository, &child.path).await? {
                SpaceGitType::Inline => ops::ensure_inline_gitignore(repository)?,
                SpaceGitType::Independent => ops::add_independent_gitignore(repository, &folder)?,
                SpaceGitType::Submodule => {}
            }
        }
    }
    let outcome = if std::fs::read(path)? == before {
        RepairOutcome::Unchanged
    } else {
        RepairOutcome::Changed
    };
    ensure_system_exclude(cli, repository).await?;
    Ok(outcome)
}

/// Keep the `system_files` block in `info/exclude` of the Git directory of
/// `repository` (DF-273 R3). Git resolves the path, so a submodule or a
/// worktree with a `.git` file gets the file of its own Git directory. The
/// file lies outside the working tree, so its change is not a `Changed`
/// outcome, which reports `.gitignore`.
async fn ensure_system_exclude(cli: &GitCli, repository: &Path) -> Result<(), GitError> {
    let out = cli
        .exec(
            repository,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(out.stderr.trim().to_string()));
    }
    let path = Path::new(out.stdout.trim_end_matches(['\n', '\r']));
    let content = ops::read_gitignore(path)?;
    let updated = super::system_files::exclude_with_block(&content);
    if updated != content {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, updated)?;
    }
    Ok(())
}

pub async fn repair_scope(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
) -> Result<RepairOutcome, GitError> {
    repair_scope_with(runtime, host, project, space, StorageRules::Skip).await
}

async fn repair_scope_with(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
    storage_rules: StorageRules,
) -> Result<RepairOutcome, GitError> {
    if !space.is_dir() {
        tracing::info!(space = %space.display(), "local ignore repair skipped for missing space");
        return Ok(RepairOutcome::Skipped);
    }
    let inline = space != project && space.join(".git").symlink_metadata().is_err();
    let repository = if inline { project } else { space };
    if repository.join(".git").symlink_metadata().is_err() {
        tracing::info!(repository = %repository.display(), "local ignore repair deferred until Git initialization");
        return Ok(RepairOutcome::Skipped);
    }
    let cli = runtime.cli()?;
    let lock = runtime.get_lock(repository).await;
    let Ok(_guard) = lock.try_lock() else {
        tracing::info!(repository = %repository.display(), "local ignore repair deferred while repository operation is active");
        return Ok(RepairOutcome::Skipped);
    };
    let authorization = host.authorize_repository(repository).await;
    repair_authorized(cli, repository, inline, storage_rules, authorization).await
}

/// A repair that has to happen: `Changed` or `Unchanged`, never `Skipped`.
pub async fn require_scope_repair(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
) -> Result<RepairOutcome, GitError> {
    match repair_scope(runtime, host, project, space).await? {
        RepairOutcome::Skipped => Err(GitError::GitCommandFailed(
            "Repository is not safe for ignore repair".into(),
        )),
        outcome => Ok(outcome),
    }
}

/// Exact-path callers already serialize their repository before preflight/publication.
pub async fn repair_locked_best_effort(host: &dyn GitHost, cli: &GitCli, repository: &Path) {
    let authorization = host.authorize_repository(repository).await;
    if let Err(error) =
        repair_authorized(cli, repository, false, StorageRules::Skip, authorization).await
    {
        tracing::warn!(repository = %repository.display(), error_kind = error.kind(), "local ignore repair failed before exact-path staging; retry on next open");
    }
}

/// Read/open paths remain available after repair denial or I/O failure.
pub async fn repair_scope_best_effort(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
) {
    if let Err(error) = repair_scope(runtime, host, project, space).await {
        tracing::warn!(space = %space.display(), error_kind = error.kind(), "local ignore repair failed; retry on next open");
    }
}

/// Opening a Project repairs its repository and those of its ready Spaces,
/// the rules of the `local` assets strategy included.
pub async fn repair_project(runtime: &GitRuntime, host: &dyn GitHost, root: &Path) {
    repair_on_open(runtime, host, root, root).await;
    match ready_children(root) {
        Ok(children) => {
            for child in children {
                repair_on_open(runtime, host, root, &child).await;
            }
        }
        Err(error) => tracing::warn!(
            error_kind = error.kind(),
            "local ignore child inventory failed; retry on next open"
        ),
    }
}

async fn repair_on_open(runtime: &GitRuntime, host: &dyn GitHost, project: &Path, space: &Path) {
    if let Err(error) = repair_scope_with(runtime, host, project, space, StorageRules::Repair).await
    {
        tracing::warn!(space = %space.display(), error_kind = error.kind(), "local ignore repair failed; retry on next open");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::staging_tests::{cli, git, repo, write};

    const LEGACY: &str = "# user rules\ncustom.tmp\n# Svode local files\n.svode/local.json\n.svode/*.db\n.svode/*.db-wal\n.svode/*.db-shm\n";

    async fn repair(cli: &GitCli, root: &Path, inline: bool) -> Result<RepairOutcome, GitError> {
        let access = crate::git::access::RepositoryAccessState::new();
        let authorization = access
            .require_mutation(cli, root, &root.join("access-test.json"))
            .await
            .map(|_| ());
        repair_authorized(cli, root, inline, StorageRules::Skip, authorization).await
    }

    fn legacy(root: &Path) {
        write(root, ".gitignore", LEGACY);
        write(root, "README.md", "# Existing home\n");
        write(
            root,
            ".svode/config.json",
            r#"{"name":"Existing","icon":"","description":""}"#,
        );
        write(
            root,
            ".svode/local.json",
            r#"{"git":{"autoCommitSystem":false,"autoCommitStructural":false}}"#,
        );
        for name in [
            "index.db-journal",
            "index.db.incompatible-1",
            "routines.db-wal.corrupt-1",
            "agent-sessions.db",
            "variables.tmp-1",
            "lfs-s3-agent.json",
        ] {
            write(root, &format!(".svode/{name}"), "retained bytes");
        }
    }

    async fn coverage(cli: &GitCli, root: &Path, prefix: &str) {
        for name in [
            "index.db-journal",
            "index.db.incompatible-1",
            "routines.db-wal.corrupt-1",
            "agent-sessions.db",
            "variables.tmp-1",
            "lfs-s3-agent.json",
        ] {
            let path = format!("{prefix}.svode/{name}");
            let out = cli
                .exec(root, &["check-ignore", "-v", "--no-index", &path])
                .await
                .unwrap();
            assert_eq!(out.exit_code, 0, "{path}: {}", out.stdout);
            assert_eq!(
                std::fs::read_to_string(root.join(&path)).unwrap(),
                "retained bytes"
            );
        }
        let portable = format!("{prefix}.svode/config.json");
        assert_eq!(
            cli.exec(root, &["check-ignore", &portable])
                .await
                .unwrap()
                .exit_code,
            1
        );
    }

    #[tokio::test]
    async fn a_config_that_cannot_be_read_repairs_the_repository_without_its_children() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let config = r#"{"icon":"x","spaces":[{"id":"i","path":"inline"}]}"#;
        write(root.path(), ".svode/config.json", config);

        repair(&cli, root.path(), false).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(root.path().join(".svode/config.json")).unwrap(),
            config
        );
    }

    #[tokio::test]
    async fn legacy_ready_children_repair_before_stores_without_scaffold_or_commits() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let source = repo(&cli, true).await;
        git(
            &cli,
            root.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.path().to_str().unwrap(),
                "submodule",
            ],
        )
        .await;
        git(
            &cli,
            &root.path().join("submodule"),
            &["remote", "remove", "origin"],
        )
        .await;
        let independent = root.path().join("independent");
        std::fs::create_dir(&independent).unwrap();
        git(&cli, &independent, &["init"]).await;
        let inline = root.path().join("inline");
        for owner in [
            root.path(),
            &independent,
            &inline,
            &root.path().join("submodule"),
        ] {
            legacy(owner);
        }
        write(
            root.path(),
            ".svode/config.json",
            r#"{"name":"Existing","icon":"","description":"","spaces":[{"id":"i","path":"inline"},{"id":"d","path":"independent","repo":"unused"},{"id":"s","path":"submodule"},{"id":"m","path":"missing","repo":"unused"}]}"#,
        );
        let head = git(&cli, root.path(), &["rev-parse", "HEAD"]).await;
        let index = git(&cli, root.path(), &["ls-files", "--stage", "-z"]).await;
        let children = ready_children(root.path()).unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Changed
        );
        for owner in children {
            let is_inline = owner.join(".git").symlink_metadata().is_err();
            let effective = if is_inline { root.path() } else { &owner };
            repair(&cli, effective, is_inline).await.unwrap();
            coverage(&cli, effective, if is_inline { "inline/" } else { "" }).await;
            let pools = crate::index::state::IndexRuntimeState::default();
            let stores = crate::routines::store_state::RoutineStoreState::new();
            let key = crate::index::IndexKey::Root(owner.clone());
            // The lifecycle driver repairs all owners before any store opens.
            pools.get_or_create(&key).await.unwrap();
            stores.get_or_create(&key, &owner).await.unwrap();
            pools.close_project(&owner).await;
            stores.close_project(&owner).await;
            let before = std::fs::read(effective.join(".gitignore")).unwrap();
            assert_eq!(
                repair(&cli, effective, is_inline).await.unwrap(),
                RepairOutcome::Unchanged
            );
            assert_eq!(std::fs::read(effective.join(".gitignore")).unwrap(), before);
        }
        coverage(&cli, root.path(), "").await;
        assert!(root.path().join("submodule/.git").is_file());
        assert!(!root.path().join("missing").exists());
        assert_eq!(git(&cli, root.path(), &["rev-parse", "HEAD"]).await, head);
        assert_eq!(
            git(&cli, root.path(), &["ls-files", "--stage", "-z"]).await,
            index
        );
        let repaired = std::fs::read_to_string(root.path().join(".gitignore")).unwrap();
        assert!(repaired.starts_with("# user rules\ncustom.tmp\n# svode:local:start\n"));
        assert!(!repaired.contains("# Svode local files"));
    }

    #[tokio::test]
    async fn opening_the_project_adds_local_storage_rules_and_a_save_repair_does_not() {
        use crate::git::staging_tests::{TestHost, scaffold};
        use crate::storage::local_rules::LOCAL_EXTENSIONS_START;

        let cli = cli();
        let root = repo(&cli, true).await;
        let root = root.path();
        scaffold(root, "Root");
        let child = root.join("child");
        std::fs::create_dir_all(&child).unwrap();
        git(&cli, &child, &["init"]).await;
        scaffold(&child, "Child");
        write(
            root,
            ".svode/config.json",
            r#"{"name":"Root","spaces":[{"id":"child","path":"child","repo":null}],"assets":{"strategy":"local"}}"#,
        );
        write(
            &child,
            ".svode/config.json",
            r#"{"name":"Child","assets":{"strategy":"in-git"}}"#,
        );
        let runtime = GitRuntime::with_cli(cli.clone());
        let host = TestHost::default();

        repair_scope(&runtime, &host, root, root).await.unwrap();
        let saved = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(!saved.contains(LOCAL_EXTENSIONS_START), "{saved}");

        repair_project(&runtime, &host, root).await;
        let opened = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(opened.starts_with(&saved), "{opened}");
        assert!(opened.contains(LOCAL_EXTENSIONS_START), "{opened}");
        let child_rules = std::fs::read_to_string(child.join(".gitignore")).unwrap();
        assert!(
            !child_rules.contains(LOCAL_EXTENSIONS_START),
            "{child_rules}"
        );
        let photo = cli
            .exec(root, &["check-ignore", "--quiet", "--", "notes/photo.png"])
            .await
            .unwrap();
        assert_eq!(photo.exit_code, 0);

        repair_project(&runtime, &host, root).await;
        assert_eq!(
            std::fs::read_to_string(root.join(".gitignore")).unwrap(),
            opened
        );
    }

    #[tokio::test]
    async fn repair_neither_adds_nor_restores_system_file_rules() {
        let cli = cli();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        ops::init_with_optional_scaffold_commit(&cli, root, false)
            .await
            .unwrap();
        git(&cli, root, &["config", "user.name", "Test"]).await;
        git(&cli, root, &["config", "user.email", "test@example.test"]).await;
        git(&cli, root, &["config", "commit.gpgsign", "false"]).await;
        let gitignore = root.join(".gitignore");
        let trimmed = std::fs::read_to_string(&gitignore)
            .unwrap()
            .replace("Thumbs.db\n", "");
        write(root, ".gitignore", &trimmed);
        git(&cli, root, &["add", "-A"]).await;
        git(&cli, root, &["commit", "-qm", "Drop a rule"]).await;

        assert_eq!(
            repair(&cli, root, false).await.unwrap(),
            RepairOutcome::Unchanged
        );
        assert_eq!(std::fs::read_to_string(&gitignore).unwrap(), trimmed);

        // A cloned or existing repository without the rules keeps its file.
        let existing = repo(&cli, true).await;
        write(existing.path(), ".gitignore", "build/\n");
        repair(&cli, existing.path(), false).await.unwrap();
        let repaired = std::fs::read_to_string(existing.path().join(".gitignore")).unwrap();
        assert!(
            !crate::git::system_files::has_any_rule(&repaired),
            "{repaired}"
        );
    }

    const SYSTEM_FILES: [&str; 5] = [
        ".DS_Store",
        "docs/.DS_Store",
        "Thumbs.db",
        "~$a.docx",
        "desktop.ini",
    ];

    /// Untracked paths of `root` by `git status`, without the global excludes
    /// of the machine running the test.
    async fn untracked(cli: &GitCli, root: &Path) -> Vec<String> {
        let none = format!("core.excludesFile={}", root.join(".no-excludes").display());
        git(
            cli,
            root,
            &[
                "-c",
                &none,
                "status",
                "--porcelain",
                "--untracked-files=all",
            ],
        )
        .await
        .lines()
        .filter_map(|line| line.strip_prefix("?? "))
        .map(str::to_string)
        .collect()
    }

    fn system_block() -> String {
        let (start, end) = crate::git::system_files::EXCLUDE_BLOCK;
        let rules = crate::git::system_files::RULES.join("\n");
        format!("{start}\n{rules}\n{end}\n")
    }

    #[tokio::test]
    async fn repair_keeps_the_system_file_block_in_info_exclude_with_the_lines_of_the_user() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let user = "# user excludes\nsecret.txt\n";
        write(root.path(), ".git/info/exclude", user);
        for name in SYSTEM_FILES.iter().chain(&["secret.txt"]) {
            write(root.path(), name, "bytes");
        }
        let visible = untracked(&cli, root.path()).await;
        for name in SYSTEM_FILES {
            assert!(visible.iter().any(|path| path == name), "{visible:?}");
        }

        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Changed
        );
        let exclude = root.path().join(".git/info/exclude");
        let repaired = std::fs::read_to_string(&exclude).unwrap();
        assert_eq!(repaired, format!("{user}{}", system_block()));
        let visible = untracked(&cli, root.path()).await;
        assert_eq!(visible, [".gitignore"], "{visible:?}");
        let gitignore = std::fs::read_to_string(root.path().join(".gitignore")).unwrap();
        assert!(
            !crate::git::system_files::has_any_rule(&gitignore),
            "{gitignore}"
        );

        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Unchanged
        );
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), repaired);

        // A removed block comes back on the next open; the outcome reports
        // only `.gitignore` of the working tree.
        write(root.path(), ".git/info/exclude", user);
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Unchanged
        );
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), repaired);
        std::fs::remove_dir_all(root.path().join(".git/info")).unwrap();
        repair(&cli, root.path(), false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), system_block());

        // `.gitignore` outranks `info/exclude`: the negation of the user
        // returns the file to Git.
        write(
            root.path(),
            ".gitignore",
            &format!("{gitignore}!desktop.ini\n"),
        );
        let visible = untracked(&cli, root.path()).await;
        assert!(
            visible.iter().any(|path| path == "desktop.ini"),
            "{visible:?}"
        );
        assert!(
            !visible.iter().any(|path| path.ends_with(".DS_Store")),
            "{visible:?}"
        );
    }

    #[tokio::test]
    async fn repair_writes_the_system_file_block_into_the_git_directory_of_a_submodule() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let source = repo(&cli, true).await;
        git(
            &cli,
            root.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.path().to_str().unwrap(),
                "submodule",
            ],
        )
        .await;
        let submodule = root.path().join("submodule");
        git(&cli, &submodule, &["remote", "remove", "origin"]).await;
        assert!(submodule.join(".git").is_file());
        for name in SYSTEM_FILES {
            write(&submodule, name, "bytes");
        }

        repair(&cli, &submodule, false).await.unwrap();

        let exclude = root.path().join(".git/modules/submodule/info/exclude");
        let repaired = std::fs::read_to_string(&exclude).unwrap();
        assert!(repaired.ends_with(&system_block()), "{repaired}");
        let visible = untracked(&cli, &submodule).await;
        assert_eq!(visible, [".gitignore"], "{visible:?}");
        repair(&cli, &submodule, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), repaired);
    }

    #[tokio::test]
    async fn denied_unsafe_and_failed_repairs_preserve_bytes_and_retry() {
        let cli = cli();
        let root = repo(&cli, true).await;
        legacy(root.path());
        let denial = GitError::RepositoryAccessDenied {
            repository_id: "test".into(),
            status: "read_only".into(),
            reason: "auth_required".into(),
        };
        assert_eq!(
            repair_authorized(&cli, root.path(), false, StorageRules::Skip, Err(denial))
                .await
                .unwrap(),
            RepairOutcome::Skipped
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(".gitignore")).unwrap(),
            LEGACY
        );
        // Unknown remote evidence is also denied without any remote probe.
        git(
            &cli,
            root.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
        )
        .await;
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Skipped
        );
        git(&cli, root.path(), &["remote", "remove", "origin"]).await;
        git(&cli, root.path(), &["checkout", "--detach"]).await;
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Skipped
        );
        git(&cli, root.path(), &["checkout", "-b", "writable"]).await;
        std::fs::remove_file(root.path().join(".gitignore")).unwrap();
        std::fs::create_dir(root.path().join(".gitignore")).unwrap();
        assert!(repair(&cli, root.path(), false).await.is_err());
        assert!(
            !ops::status(&cli, root.path())
                .await
                .unwrap()
                .files
                .iter()
                .any(|file| super::super::policy::contains(&file.path))
        );
        std::fs::remove_dir(root.path().join(".gitignore")).unwrap();
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Changed
        );
        coverage(&cli, root.path(), "").await;
        assert_eq!(
            repair(&cli, root.path(), false).await.unwrap(),
            RepairOutcome::Unchanged
        );
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::git::staging_tests::{cli, git, repo, write};

    #[tokio::test]
    async fn repair_reads_every_path_of_a_large_repository() {
        let cli = cli();
        let root = repo(&cli, true).await;
        crate::git::status::untracked_bulk(root.path(), 0..21_000);
        assert_eq!(
            repair_authorized(&cli, root.path(), false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
        assert!(root.path().join(".gitignore").is_file());
    }

    #[tokio::test]
    async fn conflict_prevents_repair_until_resolved() {
        let cli = cli();
        let root = repo(&cli, true).await;
        git(&cli, root.path(), &["checkout", "-b", "other"]).await;
        write(root.path(), "baseline.md", "other\n");
        git(&cli, root.path(), &["commit", "-am", "Other"]).await;
        git(&cli, root.path(), &["checkout", "-"]).await;
        write(root.path(), "baseline.md", "current\n");
        git(&cli, root.path(), &["commit", "-am", "Current"]).await;
        assert_ne!(
            cli.exec(root.path(), &["merge", "other"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            repair_authorized(&cli, root.path(), false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Skipped
        );
        assert!(!root.path().join(".gitignore").exists());
        let index = git(&cli, root.path(), &["ls-files", "--stage", "-z"]).await;
        assert!(ops::status(&cli, root.path()).await.unwrap().has_conflicts);
        assert_eq!(
            git(&cli, root.path(), &["ls-files", "--stage", "-z"]).await,
            index
        );
        git(&cli, root.path(), &["merge", "--abort"]).await;
        assert_eq!(
            repair_authorized(&cli, root.path(), false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
    }

    #[tokio::test]
    async fn failed_child_does_not_block_siblings_and_missing_child_repairs_after_materialization()
    {
        let cli = cli();
        let root = repo(&cli, true).await;
        write(
            root.path(),
            ".svode/config.json",
            r#"{"name":"Root","spaces":[{"id":"a","path":"failed","repo":"unused"},{"id":"b","path":"healthy","repo":"unused"},{"id":"c","path":"missing","repo":"unused"}]}"#,
        );
        for folder in ["failed", "healthy"] {
            let child = root.path().join(folder);
            std::fs::create_dir(&child).unwrap();
            git(&cli, &child, &["init"]).await;
        }
        std::fs::create_dir(root.path().join("failed/.gitignore")).unwrap();
        let children = ready_children(root.path()).unwrap();
        assert_eq!(children.len(), 2);
        let mut outcomes = Vec::new();
        for child in children {
            outcomes.push(repair_authorized(&cli, &child, false, StorageRules::Skip, Ok(())).await);
        }
        assert!(outcomes[0].is_err());
        assert_eq!(outcomes[1].as_ref().unwrap(), &RepairOutcome::Changed);
        assert!(!root.path().join("missing").exists());
        let missing = root.path().join("missing");
        std::fs::create_dir(&missing).unwrap();
        git(&cli, &missing, &["init"]).await;
        write(&missing, "README.md", "# Restored existing scaffold");
        assert_eq!(ready_children(root.path()).unwrap().len(), 3);
        assert_eq!(
            repair_authorized(&cli, &missing, false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
        assert_eq!(
            repair_authorized(&cli, &missing, false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Unchanged
        );
        assert!(
            !missing.join(".svode").exists(),
            "repair does not create a scaffold or store"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_failure_is_an_error_and_writable_retry_repairs() {
        use std::os::unix::fs::PermissionsExt;
        let cli = cli();
        let root = repo(&cli, true).await;
        write(root.path(), ".gitignore", "# retained\n");
        let path = root.path().join(".gitignore");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let result = repair_authorized(&cli, root.path(), false, StorageRules::Skip, Ok(())).await;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# retained\n");
        assert_eq!(
            repair_authorized(&cli, root.path(), false, StorageRules::Skip, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
    }
}
