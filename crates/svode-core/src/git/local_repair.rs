//! Roll out local Git policy independently of scaffold creation.

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

/// The caller holds the effective repository lock and supplies current access evidence.
async fn repair_authorized(
    cli: &GitCli,
    repository: &Path,
    inline: bool,
    authorization: Result<(), GitError>,
) -> Result<RepairOutcome, GitError> {
    if let Err(error) = authorization {
        tracing::info!(repository = %repository.display(), error_kind = error.kind(), "local ignore repair skipped; retry on writable open");
        return Ok(RepairOutcome::Skipped);
    }
    let status = ops::status(cli, repository).await?;
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
    if repository.join(".svode/config.json").exists() {
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
    Ok(if std::fs::read(path)? == before {
        RepairOutcome::Unchanged
    } else {
        RepairOutcome::Changed
    })
}

pub async fn repair_scope(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
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
    repair_authorized(cli, repository, inline, authorization).await
}

pub async fn require_scope_repair(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
    space: &Path,
) -> Result<(), GitError> {
    if repair_scope(runtime, host, project, space).await? == RepairOutcome::Skipped {
        return Err(GitError::GitCommandFailed(
            "Repository is not safe for ignore repair".into(),
        ));
    }
    Ok(())
}

/// Exact-path callers already serialize their repository before preflight/publication.
pub async fn repair_locked_best_effort(host: &dyn GitHost, cli: &GitCli, repository: &Path) {
    let authorization = host.authorize_repository(repository).await;
    if let Err(error) = repair_authorized(cli, repository, false, authorization).await {
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

pub async fn repair_project(runtime: &GitRuntime, host: &dyn GitHost, root: &Path) {
    repair_scope_best_effort(runtime, host, root, root).await;
    match ready_children(root) {
        Ok(children) => {
            for child in children {
                repair_scope_best_effort(runtime, host, root, &child).await;
            }
        }
        Err(error) => tracing::warn!(
            error_kind = error.kind(),
            "local ignore child inventory failed; retry on next open"
        ),
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
        repair_authorized(cli, root, inline, authorization).await
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
        assert!(
            std::fs::read_to_string(root.path().join(".gitignore"))
                .unwrap()
                .starts_with(LEGACY)
        );
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
            repair_authorized(&cli, root.path(), false, Err(denial))
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
            repair_authorized(&cli, root.path(), false, Ok(()))
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
            repair_authorized(&cli, root.path(), false, Ok(()))
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
            outcomes.push(repair_authorized(&cli, &child, false, Ok(())).await);
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
            repair_authorized(&cli, &missing, false, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
        assert_eq!(
            repair_authorized(&cli, &missing, false, Ok(()))
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
        let result = repair_authorized(&cli, root.path(), false, Ok(())).await;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# retained\n");
        assert_eq!(
            repair_authorized(&cli, root.path(), false, Ok(()))
                .await
                .unwrap(),
            RepairOutcome::Changed
        );
    }
}
