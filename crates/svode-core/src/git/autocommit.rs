use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use super::GitError;
use super::cli::GitCli;
use super::host::GitHost;
use super::ops;
use super::pending::PendingPaths;
pub use super::pending::StructuralOp;
use super::state::GitRuntime;
use crate::storage::config::SpaceGitType;

const FLUSH_ALL_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Copy)]
enum CommitIntent {
    ContentWorkspace,
    StructuralLifecycle,
    SystemConfig,
    ManualExplicit,
}

/// Categories of system-level auto-commits — messages and file scopes.
#[derive(Debug, Clone, Copy)]
pub enum SystemCommitKind {
    SpaceConfig,
    ReorderSpaces,
    Gitignore,
    AgentInstructions,
    CliIntegration,
    AssetsStrategy,
}

impl SystemCommitKind {
    fn message(self) -> &'static str {
        match self {
            SystemCommitKind::SpaceConfig => "Update space config",
            SystemCommitKind::ReorderSpaces => "Reorder spaces",
            SystemCommitKind::Gitignore => "Update .gitignore",
            SystemCommitKind::AgentInstructions => "Update agent instructions",
            SystemCommitKind::CliIntegration => "Update CLI integration",
            SystemCommitKind::AssetsStrategy => "Update assets strategy",
        }
    }

    /// Paths to stage, relative to the space root.
    pub fn paths(self) -> &'static [&'static str] {
        match self {
            SystemCommitKind::SpaceConfig => &[".svode/config.json"],
            SystemCommitKind::ReorderSpaces => &[".svode/config.json"],
            SystemCommitKind::Gitignore => &[".gitignore"],
            SystemCommitKind::AgentInstructions => &[".svode/AGENTS.md"],
            SystemCommitKind::CliIntegration => &["CLAUDE.md", ".mcp.json", ".claude"],
            SystemCommitKind::AssetsStrategy => &[
                ".gitattributes",
                ".gitignore",
                ".lfsconfig",
                ".svode/config.json",
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExactPathPendingReason {
    PolicyOff,
    TargetDirty,
    IndexStaged,
    TargetChanged,
    IndexInterference,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExactPathPersistenceOutcome {
    Committed,
    Pending { reason: ExactPathPendingReason },
    Failed { message: String },
    Clean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardedExactPathPlan {
    Eligible,
    Pending(ExactPathPendingReason),
}

/// Managed Git history of Svode's own structural, system and scaffold
/// changes. Policy admission, staging, the commit and the parent pointer
/// belong here; the host only authorizes the repository and delivers the
/// resulting notifications.
pub struct AutocommitService {
    runtime: Arc<GitRuntime>,
    host: Arc<dyn GitHost>,
    pending: Arc<PendingPaths>,
}

impl AutocommitService {
    pub fn new(runtime: Arc<GitRuntime>, host: Arc<dyn GitHost>) -> Self {
        let pending = runtime.pending();
        Self {
            runtime,
            host,
            pending,
        }
    }

    /// Register path-scoped content/workspace changes for the next explicit
    /// manual commit. Stage 6 keeps these dirty by default: no debounce timer
    /// and no background commit are created from this path.
    ///
    /// The op is pushed into `pending` synchronously, before returning — this
    /// way any explicit manual commit invoked afterwards sees the effect
    /// immediately.
    pub fn schedule_structural_paths(
        &self,
        _project_path: PathBuf,
        space_path: PathBuf,
        op: StructuralOp,
        paths: Vec<PathBuf>,
    ) {
        if !background_commit_allowed(&space_path, CommitIntent::ContentWorkspace) {
            self.pending.record(&space_path, Some(op), paths);
        }
    }
}

impl AutocommitService {
    /// Commit a system-level change (config / AI settings / CLI integration)
    /// immediately. Runs inline with the caller so any subsequent IPC call
    /// sees the commit already landed.
    pub async fn commit_system_now(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
        kind: SystemCommitKind,
    ) -> Result<(), GitError> {
        if !space_path.exists() {
            tracing::warn!(
                "commit_system_now: space path missing, skipping: {}",
                space_path.display()
            );
            return Ok(());
        }

        let cli = self.runtime.require_cli()?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::SystemConfig) {
            return Ok(());
        }

        do_commit_system(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            git_type,
            kind,
            CommitIntent::SystemConfig,
        )
        .await
    }

    /// Commit a system-level change from an explicit user save path. Manual
    /// entrypoints are intentionally not gated by background autocommit flags.
    pub async fn commit_system_manual_now(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
        kind: SystemCommitKind,
    ) -> Result<(), GitError> {
        if !space_path.exists() {
            return Ok(());
        }

        let cli = self.runtime.require_cli()?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;

        if !background_commit_allowed(&space_path, CommitIntent::ManualExplicit) {
            return Ok(());
        }

        do_commit_system(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            git_type,
            kind,
            CommitIntent::ManualExplicit,
        )
        .await
    }

    /// Capture background exact-path eligibility before the owning mutation.
    /// The caller must hold the effective repository's `GitState` lock across
    /// this preflight, the mutation, and `finish_guarded_exact_path_commit`.
    pub async fn plan_guarded_system_exact_path(
        &self,
        cli: &GitCli,
        repo: &Path,
        path: &str,
    ) -> Result<GuardedExactPathPlan, GitError> {
        plan_guarded_system_exact_path(cli, repo, path).await
    }

    /// Capture background eligibility for an exact-path structural commit in
    /// the root repository. A newly registered local submodule with clean,
    /// tracked metadata is the one safe exception to the usual clean-target
    /// requirement: before its first child commit the root necessarily reports
    /// that direct child as untracked.
    pub async fn plan_guarded_structural_exact_path(
        &self,
        cli: &GitCli,
        repo: &Path,
        path: &str,
        allow_registered_unborn_submodule: bool,
    ) -> Result<GuardedExactPathPlan, GitError> {
        plan_guarded_structural_exact_path(cli, repo, path, allow_registered_unborn_submodule).await
    }

    /// Complete a previously planned background exact-path commit.
    /// `target_matches_expected` is supplied by the artifact owner after it
    /// re-reads and validates the just-published result.
    pub async fn finish_guarded_exact_path_commit(
        &self,
        cli: &GitCli,
        space_path: &Path,
        repo: &Path,
        path: &str,
        message: &str,
        plan: GuardedExactPathPlan,
        target_matches_expected: bool,
    ) -> ExactPathPersistenceOutcome {
        super::local_repair::repair_locked_best_effort(self.host.as_ref(), cli, repo).await;
        let outcome =
            finish_guarded_exact_path(cli, repo, path, message, plan, target_matches_expected)
                .await;
        if outcome == ExactPathPersistenceOutcome::Committed {
            self.host.publish_commit(space_path, repo);
            schedule_auto_sync(self.host.as_ref(), repo);
        }
        outcome
    }

    /// Manual exact-path save. Background policy is intentionally ignored;
    /// consent and stale-review validation belong to the artifact owner.
    pub async fn commit_exact_path_manual(
        &self,
        cli: &GitCli,
        space_path: &Path,
        repo: &Path,
        path: &str,
        message: &str,
    ) -> ExactPathPersistenceOutcome {
        self.commit_exact_path_with_effects(cli, space_path, repo, path, message)
            .await
    }

    async fn commit_exact_path_with_effects(
        &self,
        cli: &GitCli,
        space_path: &Path,
        repo: &Path,
        path: &str,
        message: &str,
    ) -> ExactPathPersistenceOutcome {
        super::local_repair::repair_locked_best_effort(self.host.as_ref(), cli, repo).await;
        let outcome = exact_path_outcome(cli, repo, path, message).await;
        if outcome == ExactPathPersistenceOutcome::Committed {
            self.host.publish_commit(space_path, repo);
            schedule_auto_sync(self.host.as_ref(), repo);
        }
        outcome
    }

    /// Commit an explicit touched-path set with a fixed operational message.
    /// Stage-4 schema mutations use this when `schema.yaml` and migrated
    /// markdown entries must land in one path-scoped commit.
    pub async fn commit_paths_now(
        &self,
        _project_path: PathBuf,
        space_path: PathBuf,
        paths: Vec<PathBuf>,
        _message: String,
    ) -> Result<(), GitError> {
        if paths.is_empty() || !space_path.exists() {
            return Ok(());
        }

        if !background_commit_allowed(&space_path, CommitIntent::ContentWorkspace) {
            self.pending.record(&space_path, None, paths);
        }
        Ok(())
    }

    /// Commit a lifecycle-scoped set of paths. Used for project/space boundary
    /// changes whose files look like config, but whose operation intent is
    /// structural (for example importing submodule space refs).
    pub async fn commit_structural_paths_now(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
        paths: Vec<PathBuf>,
        message: &'static str,
    ) -> Result<(), GitError> {
        if paths.is_empty() || !space_path.exists() {
            return Ok(());
        }

        let cli = self.runtime.require_cli()?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::StructuralLifecycle) {
            return Ok(());
        }

        do_commit_paths(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            git_type,
            paths,
            message,
        )
        .await
    }

    /// Commit the scaffolded `.svode/` directory.
    pub async fn commit_scaffold(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), GitError> {
        do_commit_scaffold(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            false,
        )
        .await
    }

    /// Commit the scaffolded `.svode/` directory plus a newly-created README.
    pub async fn commit_scaffold_with_readme(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), GitError> {
        do_commit_scaffold(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            true,
        )
        .await
    }

    /// Commit a newly-created scope home README without staging existing scaffold files.
    pub async fn commit_scope_readme(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), GitError> {
        if !space_path.exists() {
            return Ok(());
        }

        let cli = self.runtime.require_cli()?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::StructuralLifecycle) {
            return Ok(());
        }

        do_commit_paths(
            &self.runtime,
            self.host.as_ref(),
            &project_path,
            &space_path,
            git_type,
            vec![space_path.join("README.md")],
            "Scaffold README",
        )
        .await
    }

    /// Flush all pending timers on shutdown. Wrapped in a timeout so a hung
    /// network or lock doesn't prevent process exit.
    pub async fn flush_all(&self) {
        let fut = async {
            self.pending.clear();
        };

        if let Err(_) = tokio::time::timeout(Duration::from_secs(FLUSH_ALL_TIMEOUT_SECS), fut).await
        {
            tracing::warn!(
                "flush_all: timeout after {}s, pending commits dropped",
                FLUSH_ALL_TIMEOUT_SECS
            );
        }
    }
}

pub async fn plan_guarded_system_exact_path(
    cli: &GitCli,
    repo: &Path,
    path: &str,
) -> Result<GuardedExactPathPlan, GitError> {
    if !background_commit_allowed(repo, CommitIntent::SystemConfig) {
        return Ok(classify_guarded_exact_path_preflight(false, false, false));
    }
    if ops::exact_path_has_changes(cli, repo, path).await? {
        return Ok(classify_guarded_exact_path_preflight(true, true, false));
    }
    Ok(classify_guarded_exact_path_preflight(
        true,
        false,
        ops::has_staged_changes(cli, repo).await?,
    ))
}
pub async fn plan_guarded_structural_exact_path(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    allow_registered_unborn_submodule: bool,
) -> Result<GuardedExactPathPlan, GitError> {
    if !background_commit_allowed(repo, CommitIntent::StructuralLifecycle) {
        return Ok(classify_guarded_exact_path_preflight(false, false, false));
    }
    let mut target_dirty = ops::exact_path_has_changes(cli, repo, path).await?;
    if target_dirty
        && allow_registered_unborn_submodule
        && ops::is_registered_unborn_submodule_target(cli, repo, path).await?
    {
        target_dirty = false;
    }
    if target_dirty {
        return Ok(classify_guarded_exact_path_preflight(true, true, false));
    }
    Ok(classify_guarded_exact_path_preflight(
        true,
        false,
        ops::has_staged_changes(cli, repo).await?,
    ))
}
pub struct ExactPathCommitResult {
    pub outcome: ExactPathPersistenceOutcome,
    pub oid: Option<String>,
}
impl From<ExactPathPersistenceOutcome> for ExactPathCommitResult {
    fn from(outcome: ExactPathPersistenceOutcome) -> Self {
        Self { outcome, oid: None }
    }
}
pub async fn finish_guarded_exact_path(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
    plan: GuardedExactPathPlan,
    target_matches_expected: bool,
) -> ExactPathPersistenceOutcome {
    finish_guarded_exact_path_receipt(cli, repo, path, message, plan, target_matches_expected)
        .await
        .outcome
}
pub async fn finish_guarded_exact_path_receipt(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
    plan: GuardedExactPathPlan,
    target_matches_expected: bool,
) -> ExactPathCommitResult {
    if let GuardedExactPathPlan::Pending(reason) = plan {
        return ExactPathPersistenceOutcome::Pending { reason }.into();
    }
    if !target_matches_expected {
        return ExactPathPersistenceOutcome::Pending {
            reason: ExactPathPendingReason::TargetChanged,
        }
        .into();
    }
    match ops::has_staged_changes(cli, repo).await {
        Ok(true) => {
            return ExactPathPersistenceOutcome::Pending {
                reason: ExactPathPendingReason::IndexInterference,
            }
            .into();
        }
        Ok(false) => {}
        Err(error) => {
            return ExactPathPersistenceOutcome::Failed {
                message: error.to_string(),
            }
            .into();
        }
    }
    exact_path_receipt(cli, repo, path, message).await
}
async fn exact_path_receipt(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
) -> ExactPathCommitResult {
    match ops::commit_exact_path_receipt(cli, repo, path, message).await {
        Ok(Some(receipt)) => ExactPathCommitResult {
            outcome: ExactPathPersistenceOutcome::Committed,
            oid: receipt.oid,
        },
        Ok(None) => ExactPathPersistenceOutcome::Clean.into(),
        Err(error) => ExactPathPersistenceOutcome::Failed {
            message: error.to_string(),
        }
        .into(),
    }
}
async fn exact_path_outcome(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
) -> ExactPathPersistenceOutcome {
    exact_path_receipt(cli, repo, path, message).await.outcome
}
fn classify_guarded_exact_path_preflight(
    policy_enabled: bool,
    target_dirty: bool,
    index_staged: bool,
) -> GuardedExactPathPlan {
    if !policy_enabled {
        GuardedExactPathPlan::Pending(ExactPathPendingReason::PolicyOff)
    } else if target_dirty {
        GuardedExactPathPlan::Pending(ExactPathPendingReason::TargetDirty)
    } else if index_staged {
        GuardedExactPathPlan::Pending(ExactPathPendingReason::IndexStaged)
    } else {
        GuardedExactPathPlan::Eligible
    }
}

async fn commit_prepared_paths(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    message: &str,
    intent: CommitIntent,
    optional: bool,
) -> Result<bool, GitError> {
    if !background_commit_allowed(repo, intent) {
        return Ok(false);
    }
    let mut scopes = Vec::new();
    for path in paths {
        if optional && !repo.join(path).exists() {
            let known = cli
                .exec_redacted(
                    repo,
                    &[
                        "ls-files",
                        "--error-unmatch",
                        "--",
                        &format!(":(literal){path}"),
                    ],
                )
                .await?;
            if known.exit_code == 1 {
                let staged = super::staging::exec(
                    cli,
                    repo,
                    &[
                        "diff",
                        "--cached",
                        "--name-only",
                        "-z",
                        "--",
                        &format!(":(literal){path}"),
                    ],
                    "prepare",
                    std::slice::from_ref(path),
                )
                .await?;
                if staged.exit_code != 0 {
                    return Err(super::staging::failure(
                        "prepare",
                        "inventory_failed",
                        Some(staged.exit_code),
                        std::slice::from_ref(path),
                    ));
                }
                if staged.stdout.is_empty() {
                    continue;
                }
            }
            if known.exit_code != 0 && known.exit_code != 1 {
                return Err(super::staging::failure(
                    "prepare",
                    "inventory_failed",
                    Some(known.exit_code),
                    std::slice::from_ref(path),
                ));
            }
        }
        scopes.push(path.clone());
    }
    super::branch::prepare_existing(cli, repo).await?;
    let concrete = super::staging::resolve(cli, repo, &scopes).await?;
    if concrete.is_empty() {
        return Ok(false);
    }
    super::staging::prepare(cli, repo, &concrete).await?;
    ops::commit(cli, repo, message).await
}

async fn commit_parent_pointer(
    cli: &GitCli,
    root: &Path,
    child: &Path,
    intent: CommitIntent,
) -> Result<bool, GitError> {
    if !background_commit_allowed(root, intent) {
        return Ok(false);
    }
    let path =
        crate::git::path::repo_relative_from_base(root, child, crate::git::path::RootMode::Reject)?;
    ops::commit_exact_path(cli, root, &path, &format!("Update {path}")).await
}

/// Stage the paths for a system-kind commit, relative to the space root, and
/// commit under the right repo lock. `space_path` may equal `project_path`
/// for root-level spaces (inline).
#[allow(clippy::too_many_arguments)]
async fn do_commit_paths(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    paths: Vec<PathBuf>,
    message: &str,
) -> Result<(), GitError> {
    super::local_repair::repair_scope_best_effort(runtime, host, project_path, space_path).await;
    let cli = runtime.require_cli()?;

    let (repo, needs_pointer_update) = match git_type {
        SpaceGitType::Inline => (project_path, false),
        SpaceGitType::Independent => (space_path, false),
        SpaceGitType::Submodule => (space_path, true),
    };

    let lock = runtime.get_lock(repo).await;
    let guard = lock.lock().await;
    let paths = paths
        .iter()
        .map(|path| {
            crate::git::path::repo_relative_from_base(
                repo,
                path,
                crate::git::path::RootMode::Reject,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let created = commit_prepared_paths(
        &cli,
        repo,
        &paths,
        message,
        CommitIntent::StructuralLifecycle,
        false,
    )
    .await?;
    drop(guard);

    if created {
        finish_commit(
            runtime,
            host,
            &cli,
            project_path,
            space_path,
            repo,
            needs_pointer_update.then_some(CommitIntent::StructuralLifecycle),
        )
        .await?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn do_commit_system(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    kind: SystemCommitKind,
    intent: CommitIntent,
) -> Result<(), GitError> {
    super::local_repair::repair_scope_best_effort(runtime, host, project_path, space_path).await;
    let cli = runtime.require_cli()?;
    let message = kind.message();
    let paths = kind.paths();

    let target_repo = policy_path_for_git_type(project_path, space_path, git_type).to_path_buf();
    let paths = paths
        .iter()
        .map(|path| {
            crate::git::path::repo_relative_from_base(
                &target_repo,
                &space_path.join(path),
                crate::git::path::RootMode::Reject,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let lock = runtime.get_lock(&target_repo).await;
    let guard = lock.lock().await;
    let created = commit_prepared_paths(
        &cli,
        &target_repo,
        &paths,
        message,
        intent,
        matches!(
            kind,
            SystemCommitKind::CliIntegration | SystemCommitKind::AssetsStrategy
        ),
    )
    .await?;
    drop(guard);
    if created {
        let pointer_intent = if matches!(intent, CommitIntent::ManualExplicit) {
            intent
        } else {
            CommitIntent::StructuralLifecycle
        };
        finish_commit(
            runtime,
            host,
            &cli,
            project_path,
            space_path,
            &target_repo,
            matches!(git_type, SpaceGitType::Submodule).then_some(pointer_intent),
        )
        .await?;
    }

    Ok(())
}

async fn do_commit_scaffold(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project_path: &Path,
    space_path: &Path,
    include_readme: bool,
) -> Result<(), GitError> {
    if !space_path.exists() {
        return Ok(());
    }

    if super::local_repair::repair_scope(runtime, host, project_path, space_path).await?
        == super::local_repair::RepairOutcome::Skipped
    {
        return Ok(());
    }

    let cli = runtime.require_cli()?;
    let git_type = ops::detect_space_git_type(&cli, project_path, space_path).await?;

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let message = "Scaffold .svode";
    match git_type {
        SpaceGitType::Inline => {
            let lock = runtime.get_lock(project_path).await;
            let _guard = lock.lock().await;
            let rel = if space_path == project_path {
                ".svode".to_string()
            } else {
                format!("{}/.svode", space_folder)
            };
            if !background_commit_allowed(project_path, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            let mut paths = vec![".gitignore".into(), rel];
            if include_readme {
                let readme = if space_path == project_path {
                    "README.md".to_string()
                } else {
                    format!("{}/README.md", space_folder)
                };
                if project_path.join(&readme).exists() {
                    paths.push(readme);
                }
            }
            let created = commit_prepared_paths(
                &cli,
                project_path,
                &paths,
                message,
                CommitIntent::StructuralLifecycle,
                false,
            )
            .await?;
            if created {
                finish_commit(
                    runtime,
                    host,
                    &cli,
                    project_path,
                    space_path,
                    project_path,
                    None,
                )
                .await?;
            }
        }
        SpaceGitType::Independent => {
            let lock = runtime.get_lock(space_path).await;
            let _guard = lock.lock().await;
            if !background_commit_allowed(space_path, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            let mut paths = vec![".gitignore".into(), ".svode".into()];
            if include_readme && space_path.join("README.md").exists() {
                paths.push("README.md".into());
            }
            let created = commit_prepared_paths(
                &cli,
                space_path,
                &paths,
                message,
                CommitIntent::StructuralLifecycle,
                false,
            )
            .await?;
            if created {
                finish_commit(
                    runtime,
                    host,
                    &cli,
                    project_path,
                    space_path,
                    space_path,
                    None,
                )
                .await?;
            }
        }
        SpaceGitType::Submodule => {
            let lock = runtime.get_lock(space_path).await;
            let _guard = lock.lock().await;
            if !background_commit_allowed(space_path, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            let mut paths = vec![".gitignore".into(), ".svode".into()];
            if include_readme && space_path.join("README.md").exists() {
                paths.push("README.md".into());
            }
            let created = commit_prepared_paths(
                &cli,
                space_path,
                &paths,
                message,
                CommitIntent::StructuralLifecycle,
                false,
            )
            .await?;
            drop(_guard);
            if created {
                finish_commit(
                    runtime,
                    host,
                    &cli,
                    project_path,
                    space_path,
                    space_path,
                    Some(CommitIntent::StructuralLifecycle),
                )
                .await?;
            }
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn finish_commit(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    project: &Path,
    space: &Path,
    repo: &Path,
    pointer_intent: Option<CommitIntent>,
) -> Result<(), GitError> {
    host.publish_commit(space, repo);
    let pointer = if let Some(intent) = pointer_intent {
        let child_lock = runtime.get_lock(repo).await;
        let _child_guard = child_lock.lock().await;
        let lock = runtime.get_lock(project).await;
        let _guard = lock.lock().await;
        match host.authorize_repository(project).await {
            Ok(()) => commit_parent_pointer(cli, project, space, intent).await,
            Err(error) => Err(error),
        }
    } else {
        Ok(false)
    };
    schedule_auto_sync(host, repo);
    if pointer.unwrap_or_else(|error| {
        tracing::warn!(kind = error.kind(), "child saved; project pointer pending");
        false
    }) {
        host.publish_commit(space, project);
        // With child auto-sync enabled, its pipeline owns the parent step.
        // Otherwise root policy may publish only already available pointers.
        if !super::policy::effective_user_policy(repo).auto_sync {
            schedule_auto_sync(host, project);
        }
    }
    Ok(())
}

/// A commit only starts a background sync where the user enabled it.
pub fn schedule_auto_sync(host: &dyn GitHost, repo: &Path) {
    if super::policy::effective_user_policy(repo).auto_sync {
        host.schedule_auto_sync(repo);
    }
}

fn background_commit_allowed(config_path: &Path, intent: CommitIntent) -> bool {
    match intent {
        CommitIntent::ContentWorkspace => false,
        CommitIntent::ManualExplicit => true,
        CommitIntent::StructuralLifecycle => {
            super::policy::effective_user_policy(config_path).auto_commit_structural
        }
        CommitIntent::SystemConfig => {
            super::policy::effective_user_policy(config_path).auto_commit_system
        }
    }
}

fn policy_path_for_git_type<'a>(
    project_path: &'a Path,
    space_path: &'a Path,
    git_type: SpaceGitType,
) -> &'a Path {
    match git_type {
        SpaceGitType::Inline => project_path,
        SpaceGitType::Independent | SpaceGitType::Submodule => space_path,
    }
}

/// Aggregate multiple structural ops into a single commit message.
#[allow(dead_code)]
fn aggregate_message(ops: &[StructuralOp]) -> String {
    if ops.is_empty() {
        return "Update space".to_string();
    }

    // Collapse consecutive Reorder ops to just one Reorder overall.
    let has_reorder = ops.iter().any(|o| matches!(o, StructuralOp::Reorder));
    let non_reorder: Vec<&StructuralOp> = ops
        .iter()
        .filter(|o| !matches!(o, StructuralOp::Reorder))
        .collect();

    // If reorder only — one message.
    if non_reorder.is_empty() && has_reorder {
        return "Reorder files".to_string();
    }

    // Collect per-kind counts and items.
    let mut creates: Vec<&String> = Vec::new();
    let mut deletes: Vec<&String> = Vec::new();
    let mut moves: Vec<&String> = Vec::new();
    let mut renames: Vec<(&String, &String)> = Vec::new();
    let mut converts_to_folder: Vec<&String> = Vec::new();
    let mut converts_to_leaf: Vec<&String> = Vec::new();
    let mut make_collections: Vec<&String> = Vec::new();
    let mut duplicates: Vec<(&String, &String)> = Vec::new();
    let mut create_templates: Vec<&String> = Vec::new();
    let mut delete_templates: Vec<&String> = Vec::new();
    let mut duplicate_templates: Vec<(&String, &String)> = Vec::new();
    let mut instantiate_templates: Vec<(&String, &String)> = Vec::new();

    for op in &non_reorder {
        match op {
            StructuralOp::Create(n) => creates.push(n),
            StructuralOp::Delete(n) => deletes.push(n),
            StructuralOp::Move(n) => moves.push(n),
            StructuralOp::Rename { old, new } => renames.push((old, new)),
            StructuralOp::Reorder => {}
            StructuralOp::ConvertToFolder(n) => converts_to_folder.push(n),
            StructuralOp::ConvertToLeaf(n) => converts_to_leaf.push(n),
            StructuralOp::MakeCollection(n) => make_collections.push(n),
            StructuralOp::Duplicate { old, new } => duplicates.push((old, new)),
            StructuralOp::CreateTemplate(n) => create_templates.push(n),
            StructuralOp::DeleteTemplate(n) => delete_templates.push(n),
            StructuralOp::DuplicateTemplate { old, new } => duplicate_templates.push((old, new)),
            StructuralOp::InstantiateTemplate { title, parent } => {
                instantiate_templates.push((title, parent))
            }
        }
    }

    // UI "Make collection from leaf" is implemented as convert-to-folder
    // followed by make-collection. Collapse that batch to the user-facing op.
    let mut collapsed_converts_to_folder = converts_to_folder.clone();
    if !make_collections.is_empty() {
        collapsed_converts_to_folder.retain(|name| {
            !make_collections
                .iter()
                .any(|collection| *collection == *name)
        });
    }

    // How many distinct kinds are non-empty?
    let mut kinds = 0;
    if !creates.is_empty() {
        kinds += 1;
    }
    if !deletes.is_empty() {
        kinds += 1;
    }
    if !moves.is_empty() {
        kinds += 1;
    }
    if !renames.is_empty() {
        kinds += 1;
    }
    if !collapsed_converts_to_folder.is_empty() {
        kinds += 1;
    }
    if !converts_to_leaf.is_empty() {
        kinds += 1;
    }
    if !make_collections.is_empty() {
        kinds += 1;
    }
    if !duplicates.is_empty() {
        kinds += 1;
    }
    if !create_templates.is_empty() {
        kinds += 1;
    }
    if !delete_templates.is_empty() {
        kinds += 1;
    }
    if !duplicate_templates.is_empty() {
        kinds += 1;
    }
    if !instantiate_templates.is_empty() {
        kinds += 1;
    }
    if has_reorder {
        kinds += 1;
    }

    // Helper: render one kind as a single message segment.
    let render_creates = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Create {}", items[0]),
            n => format!("Create {} files", n),
        }
    };
    let render_deletes = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Delete {}", items[0]),
            n => format!("Delete {} files", n),
        }
    };
    let render_moves = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Move {}", items[0]),
            n => format!("Move {} files", n),
        }
    };
    let render_renames = |items: &[(&String, &String)]| -> String {
        match items.len() {
            0 => String::new(),
            1 if items[0].0 == items[0].1 => format!("Rename {}", items[0].0),
            1 => format!("Rename {} \u{2192} {}", items[0].0, items[0].1),
            n => format!("Rename {} files", n),
        }
    };
    let render_convert_to_folder = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Convert {} to folder", items[0]),
            n => format!("Convert {} entries to folder", n),
        }
    };
    let render_convert_to_leaf = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Convert {} to leaf", items[0]),
            n => format!("Convert {} entries to leaf", n),
        }
    };
    let render_make_collections = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Make collection {}", items[0]),
            n => format!("Make {} collections", n),
        }
    };
    let render_duplicates = |items: &[(&String, &String)]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Duplicate {} \u{2192} {}", items[0].0, items[0].1),
            n => format!("Duplicate {} entries", n),
        }
    };
    let render_create_templates = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Create template \"{}\"", items[0]),
            n => format!("Create {} templates", n),
        }
    };
    let render_delete_templates = |items: &[&String]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Delete template \"{}\"", items[0]),
            n => format!("Delete {} templates", n),
        }
    };
    let render_duplicate_templates = |items: &[(&String, &String)]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!(
                "Duplicate template \"{}\" \u{2192} \"{}\"",
                items[0].0, items[0].1
            ),
            n => format!("Duplicate {} templates", n),
        }
    };
    let render_instantiate_templates = |items: &[(&String, &String)]| -> String {
        match items.len() {
            0 => String::new(),
            1 => format!("Instantiate template \"{}\" in {}", items[0].0, items[0].1),
            n => format!("Instantiate {} templates", n),
        }
    };

    // Single kind path — cleanest.
    if kinds == 1 {
        if !creates.is_empty() {
            return render_creates(&creates);
        }
        if !deletes.is_empty() {
            return render_deletes(&deletes);
        }
        if !moves.is_empty() {
            return render_moves(&moves);
        }
        if !renames.is_empty() {
            return render_renames(&renames);
        }
        if !collapsed_converts_to_folder.is_empty() {
            return render_convert_to_folder(&collapsed_converts_to_folder);
        }
        if !converts_to_leaf.is_empty() {
            return render_convert_to_leaf(&converts_to_leaf);
        }
        if !make_collections.is_empty() {
            return render_make_collections(&make_collections);
        }
        if !duplicates.is_empty() {
            return render_duplicates(&duplicates);
        }
        if !create_templates.is_empty() {
            return render_create_templates(&create_templates);
        }
        if !delete_templates.is_empty() {
            return render_delete_templates(&delete_templates);
        }
        if !duplicate_templates.is_empty() {
            return render_duplicate_templates(&duplicate_templates);
        }
        if !instantiate_templates.is_empty() {
            return render_instantiate_templates(&instantiate_templates);
        }
        if has_reorder {
            return "Reorder files".to_string();
        }
    }

    // Mixed kinds. If total individual items is small (≤5), join per-op messages.
    let total: usize = creates.len()
        + deletes.len()
        + moves.len()
        + renames.len()
        + collapsed_converts_to_folder.len()
        + converts_to_leaf.len()
        + make_collections.len()
        + duplicates.len()
        + create_templates.len()
        + delete_templates.len()
        + duplicate_templates.len()
        + instantiate_templates.len();
    let total_with_reorder = total + if has_reorder { 1 } else { 0 };

    if total_with_reorder <= 5 {
        let mut segs: Vec<String> = Vec::new();
        // Preserve original order of ops so the message feels natural.
        for op in ops {
            match op {
                StructuralOp::Create(n) => segs.push(format!("Create {}", n)),
                StructuralOp::Delete(n) => segs.push(format!("Delete {}", n)),
                StructuralOp::Move(n) => segs.push(format!("Move {}", n)),
                StructuralOp::Rename { old, new } => {
                    segs.push(format!("Rename {} \u{2192} {}", old, new))
                }
                StructuralOp::ConvertToFolder(n) => {
                    if !make_collections.iter().any(|collection| *collection == n) {
                        segs.push(format!("Convert {} to folder", n));
                    }
                }
                StructuralOp::ConvertToLeaf(n) => segs.push(format!("Convert {} to leaf", n)),
                StructuralOp::MakeCollection(n) => segs.push(format!("Make collection {}", n)),
                StructuralOp::Duplicate { old, new } => {
                    segs.push(format!("Duplicate {} \u{2192} {}", old, new))
                }
                StructuralOp::CreateTemplate(n) => segs.push(format!("Create template \"{}\"", n)),
                StructuralOp::DeleteTemplate(n) => segs.push(format!("Delete template \"{}\"", n)),
                StructuralOp::DuplicateTemplate { old, new } => segs.push(format!(
                    "Duplicate template \"{}\" \u{2192} \"{}\"",
                    old, new
                )),
                StructuralOp::InstantiateTemplate { title, parent } => {
                    segs.push(format!("Instantiate template \"{}\" in {}", title, parent))
                }
                StructuralOp::Reorder => {
                    // Collapse — only keep first reorder occurrence.
                    if !segs.iter().any(|s| s == "Reorder files") {
                        segs.push("Reorder files".to_string());
                    }
                }
            }
        }
        return segs.join("; ");
    }

    // Many items across multiple kinds — summarize each.
    let mut parts: Vec<String> = Vec::new();
    let s = render_creates(&creates);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_deletes(&deletes);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_moves(&moves);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_renames(&renames);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_convert_to_folder(&collapsed_converts_to_folder);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_convert_to_leaf(&converts_to_leaf);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_make_collections(&make_collections);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_duplicates(&duplicates);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_create_templates(&create_templates);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_delete_templates(&delete_templates);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_duplicate_templates(&duplicate_templates);
    if !s.is_empty() {
        parts.push(s);
    }
    let s = render_instantiate_templates(&instantiate_templates);
    if !s.is_empty() {
        parts.push(s);
    }
    if has_reorder {
        parts.push("Reorder files".to_string());
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::super::policy::{GitUserPolicy, write_user_policy};
    use super::*;
    use crate::git::staging_tests::TestHost;

    #[tokio::test]
    async fn staging_consumers_execute_all_policy_combinations_and_routing() {
        use crate::git::staging_tests::{cli, git, repo, write};
        let cli = cli();
        for structural in [false, true] {
            for system in [false, true] {
                for sync in [false, true] {
                    for kind in [
                        SpaceGitType::Inline,
                        SpaceGitType::Independent,
                        SpaceGitType::Submodule,
                    ] {
                        let root_tmp = repo(&cli, true).await;
                        let child_tmp = repo(&cli, true).await;
                        let root = root_tmp.path();
                        let child = if kind == SpaceGitType::Inline {
                            root.join("Исследования")
                        } else {
                            child_tmp.path().to_path_buf()
                        };
                        let target = policy_path_for_git_type(root, &child, kind);
                        write_local_git_policy(
                            target,
                            GitUserPolicy {
                                auto_sync: sync,
                                auto_commit_structural: structural,
                                auto_commit_system: system,
                            },
                        );
                        for (intent, name, expected) in [
                            (
                                CommitIntent::StructuralLifecycle,
                                "zadachi-komplaens/lifecycle.md",
                                structural,
                            ),
                            (
                                CommitIntent::SystemConfig,
                                "Исследования/.svode/config.json",
                                system,
                            ),
                            (
                                CommitIntent::ContentWorkspace,
                                "documents/content.md",
                                false,
                            ),
                            (CommitIntent::ManualExplicit, "manual.md", true),
                        ] {
                            let abs = child.join(name);
                            let path = crate::git::path::repo_relative_from_base(
                                target,
                                &abs,
                                crate::git::path::RootMode::Reject,
                            )
                            .unwrap();
                            write(target, &path, "source mutation\n");
                            let head = git(&cli, target, &["rev-parse", "HEAD"]).await;
                            let index = git(&cli, target, &["ls-files", "--stage", "-z"]).await;
                            assert_eq!(
                                commit_prepared_paths(
                                    &cli,
                                    target,
                                    &[path.clone()],
                                    "Policy fixture",
                                    intent,
                                    false
                                )
                                .await
                                .unwrap(),
                                expected
                            );
                            assert_eq!(
                                super::super::policy::effective_user_policy(target).auto_sync,
                                sync
                            );
                            if expected {
                                assert_ne!(git(&cli, target, &["rev-parse", "HEAD"]).await, head);
                                assert_eq!(
                                    git(&cli, target, &["show", &format!("HEAD:{path}")]).await,
                                    "source mutation\n"
                                );
                            } else {
                                assert_eq!(git(&cli, target, &["rev-parse", "HEAD"]).await, head);
                                assert_eq!(
                                    git(&cli, target, &["ls-files", "--stage", "-z"]).await,
                                    index
                                );
                            }
                            assert_eq!(std::fs::read_to_string(abs).unwrap(), "source mutation\n");
                        }
                        // The same caller reads fresh policy, rather than retaining its previous skip.
                        let path = "switched/.svode/config.json".to_string();
                        write(target, &path, "switched\n");
                        write_local_git_policy(
                            target,
                            GitUserPolicy {
                                auto_sync: sync,
                                auto_commit_structural: false,
                                auto_commit_system: false,
                            },
                        );
                        assert!(
                            !commit_prepared_paths(
                                &cli,
                                target,
                                &[path.clone()],
                                "Off",
                                CommitIntent::SystemConfig,
                                false
                            )
                            .await
                            .unwrap()
                        );
                        write_local_git_policy(
                            target,
                            GitUserPolicy {
                                auto_sync: sync,
                                auto_commit_structural: false,
                                auto_commit_system: true,
                            },
                        );
                        assert!(
                            commit_prepared_paths(
                                &cli,
                                target,
                                &[path],
                                "On",
                                CommitIntent::SystemConfig,
                                false
                            )
                            .await
                            .unwrap()
                        );
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn staging_failure_stops_system_and_structural_commits_with_staged_siblings() {
        use crate::git::staging_tests::{cli, fault_cli, git, repo, write};
        let real = cli();
        for intent in [
            CommitIntent::StructuralLifecycle,
            CommitIntent::SystemConfig,
        ] {
            let tmp = repo(&real, true).await;
            let root = tmp.path();
            write_local_git_policy(
                root,
                GitUserPolicy {
                    auto_sync: true,
                    auto_commit_structural: true,
                    auto_commit_system: true,
                },
            );
            write(root, "sibling.md", "staged sibling\n");
            git(&real, root, &["add", "sibling.md"]).await;
            let head = git(&real, root, &["rev-parse", "HEAD"]).await;
            let index = git(&real, root, &["ls-files", "--stage", "-z"]).await;
            write(root, "Исследования/config.json", "source mutation\n");
            let fault = tempfile::TempDir::new().unwrap();
            let broken = fault_cli(
                fault.path(),
                &real,
                "for arg in \"$@\"; do if [ \"$arg\" = add ]; then exit 31; fi; done",
            );
            assert!(
                commit_prepared_paths(
                    &broken,
                    root,
                    &["Исследования/config.json".into()],
                    "Must fail",
                    intent,
                    false
                )
                .await
                .is_err()
            );
            assert_eq!(git(&real, root, &["rev-parse", "HEAD"]).await, head);
            assert_eq!(
                git(&real, root, &["ls-files", "--stage", "-z"]).await,
                index
            );
            assert_eq!(
                std::fs::read_to_string(root.join("Исследования/config.json")).unwrap(),
                "source mutation\n"
            );
        }
    }

    #[tokio::test]
    async fn assets_strategy_commit_carries_lfs_declaration_for_repository_owners() {
        use crate::git::staging_tests::{cli, git, repo, write};
        use crate::storage::config::AssetsStrategy;
        use crate::storage::lfs_declaration::apply_lfs_declaration;
        let cli = cli();
        let service =
            AutocommitService::new(Arc::new(GitRuntime::new()), Arc::new(TestHost::default()));
        for kind in [
            None,
            Some(SpaceGitType::Independent),
            Some(SpaceGitType::Submodule),
        ] {
            let tmp = repo(&cli, true).await;
            let root = tmp.path();
            let owner = match kind {
                None => root.to_path_buf(),
                Some(kind) => {
                    let child = root.join("Исследования");
                    std::fs::create_dir(&child).unwrap();
                    git(&cli, &child, &["init"]).await;
                    git(&cli, &child, &["config", "user.name", "Test"]).await;
                    git(&cli, &child, &["config", "user.email", "test@example.test"]).await;
                    write(&child, "README.md", "child baseline\n");
                    ops::commit_paths(&cli, &child, &["README.md".into()])
                        .await
                        .unwrap();
                    if kind == SpaceGitType::Submodule {
                        write(
                            root,
                            ".gitmodules",
                            "[submodule \"Исследования\"]\n\tpath = Исследования\n\turl = ./Исследования\n",
                        );
                        ops::commit_paths(
                            &cli,
                            root,
                            &[".gitmodules".into(), "Исследования".into()],
                        )
                        .await
                        .unwrap();
                    }
                    child
                }
            };
            write_local_git_policy(
                &owner,
                GitUserPolicy {
                    auto_sync: false,
                    auto_commit_structural: false,
                    auto_commit_system: true,
                },
            );
            // Other strategies commit without a `.lfsconfig` to stage.
            write(&owner, ".gitignore", "strategy\n");
            service
                .commit_system_now(
                    root.to_path_buf(),
                    owner.clone(),
                    SystemCommitKind::AssetsStrategy,
                )
                .await
                .unwrap();
            assert!(
                git(&cli, &owner, &["show", "HEAD:.gitignore"])
                    .await
                    .starts_with("strategy\n")
            );

            apply_lfs_declaration(&owner, AssetsStrategy::LfsS3).unwrap();
            let head = git(&cli, &owner, &["rev-parse", "HEAD"]).await;
            service
                .commit_system_now(
                    root.to_path_buf(),
                    owner.clone(),
                    SystemCommitKind::AssetsStrategy,
                )
                .await
                .unwrap();
            assert_ne!(git(&cli, &owner, &["rev-parse", "HEAD"]).await, head);
            assert_eq!(
                git(&cli, &owner, &["log", "-1", "--format=%s"])
                    .await
                    .trim(),
                "Update assets strategy"
            );
            assert_eq!(
                git(&cli, &owner, &["show", "HEAD:.lfsconfig"]).await,
                "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n"
            );
            assert!(
                git(&cli, &owner, &["status", "--porcelain", "--", ".lfsconfig"])
                    .await
                    .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn optional_cli_absence_is_not_a_failed_expected_target() {
        use crate::git::staging_tests::{cli, git, repo, write};
        let cli = cli();
        let tmp = repo(&cli, true).await;
        let root = tmp.path();
        write_local_git_policy(
            root,
            GitUserPolicy {
                auto_sync: false,
                auto_commit_structural: false,
                auto_commit_system: true,
            },
        );
        write(root, "CLAUDE.md", "instructions\n");
        let paths = SystemCommitKind::CliIntegration
            .paths()
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>();
        assert!(
            commit_prepared_paths(&cli, root, &paths, "CLI", CommitIntent::SystemConfig, true)
                .await
                .unwrap()
        );
        assert_eq!(
            git(&cli, root, &["show", "HEAD:CLAUDE.md"]).await,
            "instructions\n"
        );
        assert!(
            commit_prepared_paths(
                &cli,
                root,
                &["expected-missing.md".into()],
                "Failure",
                CommitIntent::SystemConfig,
                false
            )
            .await
            .is_err()
        );
        std::fs::remove_file(root.join("CLAUDE.md")).unwrap();
        ops::add(&cli, root, "CLAUDE.md").await.unwrap();
        assert!(
            commit_prepared_paths(
                &cli,
                root,
                &paths,
                "Remove CLI",
                CommitIntent::SystemConfig,
                true
            )
            .await
            .unwrap()
        );
        assert!(
            !git(&cli, root, &["ls-tree", "-r", "--name-only", "HEAD"])
                .await
                .contains("CLAUDE.md")
        );
    }

    #[tokio::test]
    async fn child_success_root_policy_off_then_manual_pointer_only_retry() {
        use crate::git::staging_tests::{cli, git, repo, write};
        let cli = cli();
        for root_on in [false, true] {
            let tmp = repo(&cli, true).await;
            let root = tmp.path();
            let child = root.join("Исследования");
            std::fs::create_dir(&child).unwrap();
            git(&cli, &child, &["init"]).await;
            git(&cli, &child, &["config", "user.name", "Test"]).await;
            git(&cli, &child, &["config", "user.email", "test@example.test"]).await;
            write(&child, "README.md", "child baseline\n");
            ops::commit_paths(&cli, &child, &["README.md".into()])
                .await
                .unwrap();
            write(
                root,
                ".gitmodules",
                "[submodule \"Исследования\"]\n\tpath = Исследования\n\turl = ./Исследования\n",
            );
            ops::commit_paths(&cli, root, &[".gitmodules".into(), "Исследования".into()])
                .await
                .unwrap();
            write_local_git_policy(
                root,
                GitUserPolicy {
                    auto_sync: true,
                    auto_commit_structural: root_on,
                    auto_commit_system: false,
                },
            );
            write_local_git_policy(
                &child,
                GitUserPolicy {
                    auto_sync: false,
                    auto_commit_structural: false,
                    auto_commit_system: true,
                },
            );
            write(&child, ".svode/config.json", "child config\n");
            assert!(
                commit_prepared_paths(
                    &cli,
                    &child,
                    &[".svode/config.json".into()],
                    "Child system",
                    CommitIntent::SystemConfig,
                    false
                )
                .await
                .unwrap()
            );
            let child_head = git(&cli, &child, &["rev-parse", "HEAD"]).await;
            let root_head = git(&cli, root, &["rev-parse", "HEAD"]).await;
            let root_index = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
            assert_eq!(
                commit_parent_pointer(&cli, root, &child, CommitIntent::StructuralLifecycle)
                    .await
                    .unwrap(),
                root_on
            );
            if !root_on {
                assert_eq!(git(&cli, root, &["rev-parse", "HEAD"]).await, root_head);
                assert_eq!(
                    git(&cli, root, &["ls-files", "--stage", "-z"]).await,
                    root_index
                );
                assert!(
                    commit_parent_pointer(&cli, root, &child, CommitIntent::ManualExplicit)
                        .await
                        .unwrap()
                );
            }
            assert_eq!(git(&cli, &child, &["rev-parse", "HEAD"]).await, child_head);
            assert_eq!(
                git(&cli, root, &["rev-parse", "HEAD:Исследования"]).await,
                child_head
            );
            assert!(
                !commit_parent_pointer(&cli, root, &child, CommitIntent::ManualExplicit)
                    .await
                    .unwrap()
            );
        }
    }

    #[tokio::test]
    async fn autosync_requires_a_created_commit_and_its_own_flag() {
        use crate::git::staging_tests::{cli, git, repo, write};
        let cli = cli();
        for sync in [false, true] {
            let tmp = repo(&cli, true).await;
            let root = tmp.path();
            let remote = tempfile::TempDir::new().unwrap();
            git(&cli, remote.path(), &["init", "--bare"]).await;
            git(
                &cli,
                root,
                &["remote", "add", "origin", remote.path().to_str().unwrap()],
            )
            .await;
            let branch = git(&cli, root, &["branch", "--show-current"]).await;
            let branch = branch.trim();
            git(&cli, root, &["push", "-u", "origin", branch]).await;
            let before = git(&cli, remote.path(), &["rev-parse", branch]).await;
            write_local_git_policy(
                root,
                GitUserPolicy {
                    auto_sync: sync,
                    auto_commit_structural: false,
                    auto_commit_system: false,
                },
            );
            write(root, "manual.md", "manual\n");
            let created = ops::commit_paths(&cli, root, &["manual.md".into()])
                .await
                .unwrap();
            super::super::sync::sync_if_enabled(&cli, root, false)
                .await
                .unwrap();
            assert_eq!(
                git(&cli, remote.path(), &["rev-parse", branch]).await,
                before
            );
            super::super::sync::sync_if_enabled(&cli, root, created)
                .await
                .unwrap();
            let remote_head = git(&cli, remote.path(), &["rev-parse", branch]).await;
            if sync {
                assert_eq!(remote_head, git(&cli, root, &["rev-parse", "HEAD"]).await);
            } else {
                assert_eq!(remote_head, before);
            }
        }
    }

    #[tokio::test]
    async fn scaffold_and_readme_scopes_use_the_same_preparation_and_structural_gate() {
        use crate::git::staging_tests::{cli, git, repo, write};
        let cli = cli();
        for enabled in [false, true] {
            for prefix in ["", "Исследования/", "zadachi-komplaens/"] {
                let tmp = repo(&cli, true).await;
                let root = tmp.path();
                write_local_git_policy(
                    root,
                    GitUserPolicy {
                        auto_sync: false,
                        auto_commit_structural: enabled,
                        auto_commit_system: !enabled,
                    },
                );
                write(root, &format!("{prefix}.svode/config.json"), "config\n");
                write(root, &format!("{prefix}.svode/index.db"), "local\n");
                write(root, &format!("{prefix}README.md"), "readme\n");
                ops::ensure_svode_gitignore(root).unwrap();
                let before = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
                let paths = vec![".gitignore".into(), format!("{prefix}.svode")];
                assert_eq!(
                    commit_prepared_paths(
                        &cli,
                        root,
                        &paths,
                        "Scaffold",
                        CommitIntent::StructuralLifecycle,
                        false
                    )
                    .await
                    .unwrap(),
                    enabled
                );
                let tree = git(&cli, root, &["ls-tree", "-r", "--name-only", "HEAD"]).await;
                assert_eq!(tree.contains("config.json"), enabled);
                assert!(!tree.contains("index.db"));
                assert!(!tree.contains("README.md"));
                if !enabled {
                    assert_eq!(
                        git(&cli, root, &["ls-files", "--stage", "-z"]).await,
                        before
                    );
                }
                assert_eq!(
                    commit_prepared_paths(
                        &cli,
                        root,
                        &[format!("{prefix}README.md")],
                        "Readme",
                        CommitIntent::StructuralLifecycle,
                        false
                    )
                    .await
                    .unwrap(),
                    enabled
                );
            }
        }
    }

    fn s(x: &str) -> String {
        x.to_string()
    }

    /// Legacy shared Git automation in `.svode/config.json` is never a policy
    /// source; only the device-local config decides.
    fn write_git_config(path: &Path, git: LegacySharedGitConfig) {
        std::fs::create_dir_all(path.join(".svode")).unwrap();
        std::fs::write(
            path.join(".svode/config.json"),
            serde_json::json!({
                "name": "Space",
                "description": "",
                "icon": "folder",
                "git": {
                    "autoSync": git.auto_sync,
                    "autoCommitStructural": git.auto_commit_structural,
                    "autoCommitSystem": git.auto_commit_system,
                },
            })
            .to_string(),
        )
        .expect("write space config");
    }

    struct LegacySharedGitConfig {
        auto_sync: Option<bool>,
        auto_commit_structural: Option<bool>,
        auto_commit_system: Option<bool>,
    }

    fn write_local_git_policy(path: &Path, policy: GitUserPolicy) {
        std::fs::create_dir_all(path.join(".svode")).unwrap();
        write_user_policy(path, &policy).expect("write local git policy");
    }

    #[test]
    fn guarded_exact_path_preflight_covers_policy_target_and_index_matrix() {
        assert_eq!(
            classify_guarded_exact_path_preflight(false, false, false),
            GuardedExactPathPlan::Pending(ExactPathPendingReason::PolicyOff)
        );
        assert_eq!(
            classify_guarded_exact_path_preflight(true, true, false),
            GuardedExactPathPlan::Pending(ExactPathPendingReason::TargetDirty)
        );
        assert_eq!(
            classify_guarded_exact_path_preflight(true, false, true),
            GuardedExactPathPlan::Pending(ExactPathPendingReason::IndexStaged)
        );
        assert_eq!(
            classify_guarded_exact_path_preflight(true, false, false),
            GuardedExactPathPlan::Eligible
        );
        assert_eq!(
            classify_guarded_exact_path_preflight(false, true, true),
            GuardedExactPathPlan::Pending(ExactPathPendingReason::PolicyOff)
        );
    }

    #[test]
    fn background_policy_reads_local_git_user_policy() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let inline_space = project.join("docs");

        write_git_config(
            &project,
            LegacySharedGitConfig {
                auto_sync: Some(true),
                auto_commit_structural: Some(true),
                auto_commit_system: Some(true),
            },
        );
        write_git_config(
            &inline_space,
            LegacySharedGitConfig {
                auto_sync: Some(true),
                auto_commit_structural: Some(true),
                auto_commit_system: Some(true),
            },
        );
        write_local_git_policy(
            &inline_space,
            GitUserPolicy {
                auto_sync: true,
                auto_commit_structural: true,
                auto_commit_system: true,
            },
        );

        assert!(!super::super::policy::effective_user_policy(&project).auto_sync);
        assert!(super::super::policy::effective_user_policy(&inline_space).auto_sync);
        assert!(!background_commit_allowed(
            &project,
            CommitIntent::StructuralLifecycle
        ));
        assert!(background_commit_allowed(
            &inline_space,
            CommitIntent::StructuralLifecycle
        ));
        assert!(!background_commit_allowed(
            &project,
            CommitIntent::SystemConfig
        ));
        assert!(background_commit_allowed(
            &inline_space,
            CommitIntent::SystemConfig
        ));
    }

    #[test]
    fn all_64_child_root_policy_tuples_preserve_each_commit_and_sync_intent() {
        for child_bits in 0..8 {
            for root_bits in 0..8 {
                let temp = tempfile::tempdir().unwrap();
                let root = temp.path().join("project");
                let child = root.join("space");
                std::fs::create_dir_all(&child).unwrap();
                for (repo, bits) in [(&child, child_bits), (&root, root_bits)] {
                    write_local_git_policy(
                        repo,
                        GitUserPolicy {
                            auto_sync: bits & 4 != 0,
                            auto_commit_structural: bits & 2 != 0,
                            auto_commit_system: bits & 1 != 0,
                        },
                    );
                    for (intent, expected) in [
                        (CommitIntent::ContentWorkspace, false),
                        (CommitIntent::ManualExplicit, true),
                        (CommitIntent::StructuralLifecycle, bits & 2 != 0),
                        (CommitIntent::SystemConfig, bits & 1 != 0),
                    ] {
                        let created = background_commit_allowed(repo, intent);
                        assert_eq!(created, expected, "tuple {child_bits}/{root_bits}");
                        let mut triggers = 0;
                        // Production callbacks are dispatched only for a commit receipt.
                        if created {
                            let host = TestHost::default();
                            schedule_auto_sync(&host, repo);
                            triggers += host.auto_syncs.lock().unwrap().len();
                        }
                        assert_eq!(triggers, usize::from(expected && bits & 4 != 0));
                    }
                    assert_eq!(
                        super::super::operations::Intent::Sync { background: true }.admitted(repo),
                        bits & 4 != 0
                    );
                    assert!(
                        super::super::operations::Intent::Sync { background: false }.admitted(repo)
                    );
                    assert!(super::super::operations::Intent::Push.admitted(repo));
                    assert!(super::super::operations::Intent::Publish.admitted(repo));
                }
                // A local structural/system child commit permits a local pointer
                // via Troot regardless of Sroot or Yroot. Parent process groups
                // separately check new vs pre-existing pointer publication.
                for (intent, child_allowed) in [
                    (CommitIntent::StructuralLifecycle, child_bits & 2 != 0),
                    (CommitIntent::SystemConfig, child_bits & 1 != 0),
                ] {
                    let allowed = background_commit_allowed(&child, intent)
                        && background_commit_allowed(&root, CommitIntent::StructuralLifecycle);
                    assert_eq!(allowed, child_allowed && root_bits & 2 != 0);
                }
            }
        }
    }

    #[test]
    fn single_create() {
        let ops = vec![StructuralOp::Create(s("meeting.md"))];
        assert_eq!(aggregate_message(&ops), "Create meeting.md");
    }

    #[test]
    fn multi_create_same_kind() {
        let ops = vec![
            StructuralOp::Create(s("a.md")),
            StructuralOp::Create(s("b.md")),
            StructuralOp::Create(s("c.md")),
        ];
        assert_eq!(aggregate_message(&ops), "Create 3 files");
    }

    #[test]
    fn multi_delete_same_kind() {
        let ops = vec![
            StructuralOp::Delete(s("a.md")),
            StructuralOp::Delete(s("b.md")),
        ];
        assert_eq!(aggregate_message(&ops), "Delete 2 files");
    }

    #[test]
    fn single_rename() {
        let ops = vec![StructuralOp::Rename {
            old: s("old.md"),
            new: s("new.md"),
        }];
        assert_eq!(aggregate_message(&ops), "Rename old.md \u{2192} new.md");
    }

    #[test]
    fn single_safe_rename_omits_repeated_target() {
        let ops = vec![StructuralOp::Rename {
            old: s("collection entry"),
            new: s("collection entry"),
        }];
        assert_eq!(aggregate_message(&ops), "Rename collection entry");
    }

    #[test]
    fn multi_rename() {
        let ops = vec![
            StructuralOp::Rename {
                old: s("a.md"),
                new: s("a2.md"),
            },
            StructuralOp::Rename {
                old: s("b.md"),
                new: s("b2.md"),
            },
            StructuralOp::Rename {
                old: s("c.md"),
                new: s("c2.md"),
            },
        ];
        assert_eq!(aggregate_message(&ops), "Rename 3 files");
    }

    #[test]
    fn single_move() {
        let ops = vec![StructuralOp::Move(s("x.md"))];
        assert_eq!(aggregate_message(&ops), "Move x.md");
    }

    #[test]
    fn multi_move() {
        let ops = vec![
            StructuralOp::Move(s("a.md")),
            StructuralOp::Move(s("b.md")),
            StructuralOp::Move(s("c.md")),
            StructuralOp::Move(s("d.md")),
        ];
        assert_eq!(aggregate_message(&ops), "Move 4 files");
    }

    #[test]
    fn reorder_only() {
        let ops = vec![StructuralOp::Reorder];
        assert_eq!(aggregate_message(&ops), "Reorder files");
    }

    #[test]
    fn reorder_collapses() {
        let ops = vec![
            StructuralOp::Reorder,
            StructuralOp::Reorder,
            StructuralOp::Reorder,
        ];
        assert_eq!(aggregate_message(&ops), "Reorder files");
    }

    #[test]
    fn mixed_small_joins() {
        let ops = vec![
            StructuralOp::Create(s("meeting.md")),
            StructuralOp::Delete(s("draft.md")),
        ];
        assert_eq!(
            aggregate_message(&ops),
            "Create meeting.md; Delete draft.md"
        );
    }

    #[test]
    fn collection_conversion_messages() {
        let ops = vec![StructuralOp::ConvertToFolder(s("tasks"))];
        assert_eq!(aggregate_message(&ops), "Convert tasks to folder");

        let ops = vec![StructuralOp::ConvertToLeaf(s("tasks.md"))];
        assert_eq!(aggregate_message(&ops), "Convert tasks.md to leaf");
    }

    #[test]
    fn make_collection_chain_collapses() {
        let ops = vec![
            StructuralOp::ConvertToFolder(s("tasks")),
            StructuralOp::MakeCollection(s("tasks")),
        ];
        assert_eq!(aggregate_message(&ops), "Make collection tasks");
    }

    #[test]
    fn duplicate_entry_message() {
        let ops = vec![StructuralOp::Duplicate {
            old: s("tasks"),
            new: s("tasks-copy"),
        }];
        assert_eq!(
            aggregate_message(&ops),
            "Duplicate tasks \u{2192} tasks-copy"
        );
    }

    #[test]
    fn template_messages() {
        let ops = vec![StructuralOp::CreateTemplate(s("Meeting"))];
        assert_eq!(aggregate_message(&ops), "Create template \"Meeting\"");

        let ops = vec![StructuralOp::DeleteTemplate(s("Meeting"))];
        assert_eq!(aggregate_message(&ops), "Delete template \"Meeting\"");

        let ops = vec![StructuralOp::DuplicateTemplate {
            old: s("Meeting"),
            new: s("Meeting (copy)"),
        }];
        assert_eq!(
            aggregate_message(&ops),
            "Duplicate template \"Meeting\" \u{2192} \"Meeting (copy)\""
        );

        let ops = vec![StructuralOp::InstantiateTemplate {
            title: s("Meeting"),
            parent: s("projects"),
        }];
        assert_eq!(
            aggregate_message(&ops),
            "Instantiate template \"Meeting\" in projects"
        );
    }

    #[test]
    fn mixed_large_summarizes() {
        let ops = vec![
            StructuralOp::Create(s("a.md")),
            StructuralOp::Create(s("b.md")),
            StructuralOp::Create(s("c.md")),
            StructuralOp::Delete(s("d.md")),
            StructuralOp::Delete(s("e.md")),
            StructuralOp::Move(s("f.md")),
        ];
        assert_eq!(
            aggregate_message(&ops),
            "Create 3 files; Delete 2 files; Move f.md"
        );
    }

    #[test]
    fn empty_fallback() {
        let ops: Vec<StructuralOp> = Vec::new();
        assert_eq!(aggregate_message(&ops), "Update space");
    }
}
