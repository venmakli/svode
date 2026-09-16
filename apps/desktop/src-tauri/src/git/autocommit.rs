use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::commands::GitState;
use super::ops;
use crate::AppError;
use crate::space::types::SpaceGitType;

const FLUSH_ALL_TIMEOUT_SECS: u64 = 10;
const EVENT_COMMITTED: &str = "git:committed";

#[derive(Debug, Clone, Copy)]
enum CommitIntent {
    ContentWorkspace,
    StructuralLifecycle,
    SystemConfig,
    ManualExplicit,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuralOp {
    Create(String),
    Delete(String),
    Rename { old: String, new: String },
    Move(String),
    Reorder,
    ConvertToFolder(String),
    ConvertToLeaf(String),
    MakeCollection(String),
    Duplicate { old: String, new: String },
    CreateTemplate(String),
    DeleteTemplate(String),
    DuplicateTemplate { old: String, new: String },
    InstantiateTemplate { title: String, parent: String },
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
    pub(crate) fn paths(self) -> &'static [&'static str] {
        match self {
            SystemCommitKind::SpaceConfig => &[".svode/config.json"],
            SystemCommitKind::ReorderSpaces => &[".svode/config.json"],
            SystemCommitKind::Gitignore => &[".gitignore"],
            SystemCommitKind::AgentInstructions => &[".svode/AGENTS.md"],
            SystemCommitKind::CliIntegration => &["CLAUDE.md", ".mcp.json", ".claude"],
            SystemCommitKind::AssetsStrategy => {
                &[".gitattributes", ".gitignore", ".svode/config.json"]
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommittedPayload {
    space_path: String,
    repo_path: String,
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

#[derive(Clone)]
struct PendingItem {
    op: Option<StructuralOp>,
    paths: Vec<PathBuf>,
}

struct PendingBatch {
    items: Vec<PendingItem>,
}

pub(crate) struct PendingSave {
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
    space: PathBuf,
    items: Vec<PendingItem>,
}

impl PendingSave {
    pub fn paths(&self) -> Vec<PathBuf> {
        dedupe_paths(self.items.iter().flat_map(|item| item.paths.clone()))
    }

    pub fn complete(&mut self) {
        self.items.clear();
    }
}

impl Drop for PendingSave {
    fn drop(&mut self) {
        if self.items.is_empty() {
            return;
        }
        let mut map = self.pending.lock().unwrap();
        map.entry(self.space.clone())
            .or_insert_with(|| PendingBatch { items: Vec::new() })
            .items
            .append(&mut self.items);
    }
}

pub struct AutocommitService {
    app: AppHandle,
    /// Keyed by `space_path` — different spaces never share a batch even when
    /// they target the same repo (multiple inline children of one project).
    /// Uses a sync Mutex so `schedule_structural` can push synchronously from
    /// sync IPC handlers without racing against later flush/commit calls.
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
}

impl AutocommitService {
    pub(crate) fn begin_manual_save(
        &self,
        space: &Path,
        anchors: Option<&[PathBuf]>,
    ) -> PendingSave {
        let mut map = self.pending.lock().unwrap();
        let mut selected = Vec::new();
        if let Some(batch) = map.get_mut(space) {
            let ops = anchors.map(|anchors| {
                batch
                    .items
                    .iter()
                    .filter(|item| pending_item_touches(item, anchors))
                    .filter_map(|item| item.op.clone())
                    .collect::<Vec<_>>()
            });
            batch.items.retain(|item| {
                let related = anchors.is_none_or(|anchors| {
                    pending_item_touches(item, anchors)
                        || item
                            .op
                            .as_ref()
                            .is_some_and(|op| ops.as_ref().is_some_and(|ops| ops.contains(op)))
                });
                if related {
                    selected.push(item.clone());
                }
                !related
            });
        }
        PendingSave {
            pending: self.pending.clone(),
            space: space.to_path_buf(),
            items: selected,
        }
    }

    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
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
        project_path: PathBuf,
        space_path: PathBuf,
        op: StructuralOp,
        paths: Vec<PathBuf>,
    ) {
        if !background_commit_allowed(&space_path, CommitIntent::ContentWorkspace) {
            self.record_pending_paths(project_path, space_path, Some(op), paths);
        }
    }

    fn record_pending_paths(
        &self,
        _project_path: PathBuf,
        space_path: PathBuf,
        op: Option<StructuralOp>,
        paths: Vec<PathBuf>,
    ) {
        let mut map = self.pending.lock().unwrap();
        let entry = map
            .entry(space_path.clone())
            .or_insert_with(|| PendingBatch { items: Vec::new() });
        entry.items.push(PendingItem {
            op,
            paths: paths
                .into_iter()
                .map(|path| {
                    if path.is_absolute() {
                        path
                    } else {
                        space_path.join(path)
                    }
                })
                .collect(),
        });
    }

    /// Drain pending content/schema paths for one space so an explicit manual
    /// commit can stage them together with the user's active file. This is
    /// keyed by `space_path`, not target repo, to avoid draining sibling inline
    /// spaces that share the same root repository.
    pub fn take_pending_paths_for_space(
        &self,
        _project_path: &Path,
        space_path: &Path,
    ) -> Vec<PathBuf> {
        let batch = {
            let mut map = self.pending.lock().unwrap();
            map.remove(space_path)
        };
        let Some(batch) = batch else {
            return Vec::new();
        };

        dedupe_paths(batch.items.into_iter().flat_map(|item| item.paths))
    }
}

fn pending_item_touches(item: &PendingItem, anchor_paths: &[PathBuf]) -> bool {
    item.paths
        .iter()
        .any(|path| anchor_paths.iter().any(|anchor| path == anchor))
}

#[cfg(test)]
fn split_related_pending_items(
    items: Vec<PendingItem>,
    anchor_paths: &[PathBuf],
    matching_ops: &[Option<StructuralOp>],
) -> (Vec<PathBuf>, Vec<PendingItem>) {
    let mut kept = Vec::new();
    let mut drained = Vec::new();
    for item in items {
        let related_by_path = pending_item_touches(&item, anchor_paths);
        let related_by_op = item.op.is_some() && matching_ops.iter().any(|op| *op == item.op);
        if related_by_path || related_by_op {
            drained.extend(item.paths);
        } else {
            kept.push(item);
        }
    }
    (drained, kept)
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.iter().any(|existing: &PathBuf| existing == &path) {
            unique.push(path);
        }
    }
    unique
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
    ) -> Result<(), AppError> {
        if !space_path.exists() {
            tracing::warn!(
                "commit_system_now: space path missing, skipping: {}",
                space_path.display()
            );
            return Ok(());
        }

        let git_state = self.app.state::<GitState>();
        let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::SystemConfig) {
            return Ok(());
        }

        do_commit_system(
            &self.app,
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
    ) -> Result<(), AppError> {
        if !space_path.exists() {
            return Ok(());
        }

        let git_state = self.app.state::<GitState>();
        let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;

        if !background_commit_allowed(&space_path, CommitIntent::ManualExplicit) {
            return Ok(());
        }

        do_commit_system(
            &self.app,
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
        cli: &super::cli::GitCli,
        repo: &Path,
        path: &str,
    ) -> Result<GuardedExactPathPlan, AppError> {
        plan_guarded_system_exact_path(cli, repo, path).await
    }

    /// Capture background eligibility for an exact-path structural commit in
    /// the root repository. A newly registered local submodule with clean,
    /// tracked metadata is the one safe exception to the usual clean-target
    /// requirement: before its first child commit the root necessarily reports
    /// that direct child as untracked.
    pub async fn plan_guarded_structural_exact_path(
        &self,
        cli: &super::cli::GitCli,
        repo: &Path,
        path: &str,
        allow_registered_unborn_submodule: bool,
    ) -> Result<GuardedExactPathPlan, AppError> {
        plan_guarded_structural_exact_path(cli, repo, path, allow_registered_unborn_submodule).await
    }

    /// Complete a previously planned background exact-path commit.
    /// `target_matches_expected` is supplied by the artifact owner after it
    /// re-reads and validates the just-published result.
    pub async fn finish_guarded_exact_path_commit(
        &self,
        cli: &super::cli::GitCli,
        space_path: &Path,
        repo: &Path,
        path: &str,
        message: &str,
        plan: GuardedExactPathPlan,
        target_matches_expected: bool,
    ) -> ExactPathPersistenceOutcome {
        super::local_repair::repair_locked_best_effort(&self.app, cli, repo).await;
        let outcome =
            finish_guarded_exact_path(cli, repo, path, message, plan, target_matches_expected)
                .await;
        if outcome == ExactPathPersistenceOutcome::Committed {
            publish_exact_path_commit(&self.app, cli, space_path, repo);
        }
        outcome
    }

    /// Manual exact-path save. Background policy is intentionally ignored;
    /// consent and stale-review validation belong to the artifact owner.
    pub async fn commit_exact_path_manual(
        &self,
        cli: &super::cli::GitCli,
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
        cli: &super::cli::GitCli,
        space_path: &Path,
        repo: &Path,
        path: &str,
        message: &str,
    ) -> ExactPathPersistenceOutcome {
        super::local_repair::repair_locked_best_effort(&self.app, cli, repo).await;
        let outcome = exact_path_outcome(cli, repo, path, message).await;
        if outcome == ExactPathPersistenceOutcome::Committed {
            publish_exact_path_commit(&self.app, cli, space_path, repo);
        }
        outcome
    }

    /// Commit an explicit touched-path set with a fixed operational message.
    /// Stage-4 schema mutations use this when `schema.yaml` and migrated
    /// markdown entries must land in one path-scoped commit.
    pub async fn commit_paths_now(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
        paths: Vec<PathBuf>,
        _message: String,
    ) -> Result<(), AppError> {
        if paths.is_empty() || !space_path.exists() {
            return Ok(());
        }

        if !background_commit_allowed(&space_path, CommitIntent::ContentWorkspace) {
            self.record_pending_paths(project_path, space_path, None, paths);
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
    ) -> Result<(), AppError> {
        if paths.is_empty() || !space_path.exists() {
            return Ok(());
        }

        let git_state = self.app.state::<GitState>();
        let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::StructuralLifecycle) {
            return Ok(());
        }

        do_commit_paths(
            &self.app,
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
    ) -> Result<(), AppError> {
        do_commit_scaffold(&self.app, &project_path, &space_path, false).await
    }

    /// Commit the scaffolded `.svode/` directory plus a newly-created README.
    pub async fn commit_scaffold_with_readme(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), AppError> {
        do_commit_scaffold(&self.app, &project_path, &space_path, true).await
    }

    /// Commit a newly-created scope home README without staging existing scaffold files.
    pub async fn commit_scope_readme(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), AppError> {
        if !space_path.exists() {
            return Ok(());
        }

        let git_state = self.app.state::<GitState>();
        let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
        let git_type = ops::detect_space_git_type(&cli, &project_path, &space_path).await?;
        let policy_path = policy_path_for_git_type(&project_path, &space_path, git_type);
        if !background_commit_allowed(policy_path, CommitIntent::StructuralLifecycle) {
            return Ok(());
        }

        do_commit_paths(
            &self.app,
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
            let keys: Vec<PathBuf> = {
                let map = self.pending.lock().unwrap();
                map.keys().cloned().collect()
            };
            for key in keys {
                let _ = self.take_pending_paths_for_space(Path::new(""), &key);
            }
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

pub(crate) async fn plan_guarded_system_exact_path(
    cli: &super::cli::GitCli,
    repo: &Path,
    path: &str,
) -> Result<GuardedExactPathPlan, AppError> {
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
pub(crate) async fn plan_guarded_structural_exact_path(
    cli: &super::cli::GitCli,
    repo: &Path,
    path: &str,
    allow_registered_unborn_submodule: bool,
) -> Result<GuardedExactPathPlan, AppError> {
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
pub(crate) struct ExactPathCommitResult {
    pub outcome: ExactPathPersistenceOutcome,
    pub oid: Option<String>,
}
impl From<ExactPathPersistenceOutcome> for ExactPathCommitResult {
    fn from(outcome: ExactPathPersistenceOutcome) -> Self {
        Self { outcome, oid: None }
    }
}
pub(crate) async fn finish_guarded_exact_path(
    cli: &super::cli::GitCli,
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
pub(crate) async fn finish_guarded_exact_path_receipt(
    cli: &super::cli::GitCli,
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
    cli: &super::cli::GitCli,
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
    cli: &super::cli::GitCli,
    repo: &Path,
    path: &str,
    message: &str,
) -> ExactPathPersistenceOutcome {
    exact_path_receipt(cli, repo, path, message).await.outcome
}
pub(crate) fn publish_exact_path_commit(
    app: &AppHandle,
    _cli: &super::cli::GitCli,
    space_path: &Path,
    repo: &Path,
) {
    dispatch_exact_path_commit(
        space_path,
        repo,
        |space, repo| emit_committed(app, space, repo),
        |repo| {
            let app = app.clone();
            let repo = repo.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = super::publication_flow::sync(&app, &repo, true, false).await {
                    tracing::warn!(kind = error.kind(), "auto-sync (exact path) failed");
                }
            });
        },
    );
}

pub(crate) fn dispatch_exact_path_commit(
    space: &Path,
    repo: &Path,
    emit: impl FnOnce(&Path, &Path),
    sync: impl FnOnce(&Path),
) {
    emit(space, repo);
    if is_auto_sync_enabled(repo) {
        sync(repo);
    }
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
    cli: &super::cli::GitCli,
    repo: &Path,
    paths: &[String],
    message: &str,
    intent: CommitIntent,
    optional: bool,
) -> Result<bool, AppError> {
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
    cli: &super::cli::GitCli,
    root: &Path,
    child: &Path,
    intent: CommitIntent,
) -> Result<bool, AppError> {
    if !background_commit_allowed(root, intent) {
        return Ok(false);
    }
    let path =
        crate::repo_path::repo_relative_from_base(root, child, crate::repo_path::RootMode::Reject)?;
    ops::commit_exact_path(cli, root, &path, &format!("Update {path}")).await
}

/// Stage the paths for a system-kind commit, relative to the space root, and
/// commit under the right repo lock. `space_path` may equal `project_path`
/// for root-level spaces (inline).
async fn do_commit_paths(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    paths: Vec<PathBuf>,
    message: &str,
) -> Result<(), AppError> {
    super::local_repair::repair_scope_best_effort(app, project_path, space_path).await;
    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;

    let (repo, needs_pointer_update) = match git_type {
        SpaceGitType::Inline => (project_path, false),
        SpaceGitType::Independent => (space_path, false),
        SpaceGitType::Submodule => (space_path, true),
    };

    let lock = git_state.get_lock(repo).await;
    let guard = lock.lock().await;
    let paths = paths
        .iter()
        .map(|path| {
            crate::repo_path::repo_relative_from_base(
                repo,
                path,
                crate::repo_path::RootMode::Reject,
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
            app,
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

async fn do_commit_system(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    kind: SystemCommitKind,
    intent: CommitIntent,
) -> Result<(), AppError> {
    super::local_repair::repair_scope_best_effort(app, project_path, space_path).await;
    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let message = kind.message();
    let paths = kind.paths();

    let target_repo = policy_path_for_git_type(project_path, space_path, git_type).to_path_buf();
    let paths = paths
        .iter()
        .map(|path| {
            crate::repo_path::repo_relative_from_base(
                &target_repo,
                &space_path.join(path),
                crate::repo_path::RootMode::Reject,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let lock = git_state.get_lock(&target_repo).await;
    let guard = lock.lock().await;
    let created = commit_prepared_paths(
        &cli,
        &target_repo,
        &paths,
        message,
        intent,
        matches!(kind, SystemCommitKind::CliIntegration),
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
            app,
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
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
    include_readme: bool,
) -> Result<(), AppError> {
    if !space_path.exists() {
        return Ok(());
    }

    if super::local_repair::repair_scope(app, project_path, space_path).await?
        == super::local_repair::RepairOutcome::Skipped
    {
        return Ok(());
    }

    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let git_type = ops::detect_space_git_type(&cli, project_path, space_path).await?;

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let message = "Scaffold .svode";
    match git_type {
        SpaceGitType::Inline => {
            let lock = git_state.get_lock(project_path).await;
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
                finish_commit(app, &cli, project_path, space_path, project_path, None).await?;
            }
        }
        SpaceGitType::Independent => {
            let lock = git_state.get_lock(space_path).await;
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
                finish_commit(app, &cli, project_path, space_path, space_path, None).await?;
            }
        }
        SpaceGitType::Submodule => {
            let lock = git_state.get_lock(space_path).await;
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
                    app,
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

async fn finish_commit(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    project: &Path,
    space: &Path,
    repo: &Path,
    pointer_intent: Option<CommitIntent>,
) -> Result<(), AppError> {
    emit_committed(app, space, repo);
    let pointer = if let Some(intent) = pointer_intent {
        let state = app.state::<GitState>();
        let child_lock = state.get_lock(repo).await;
        let _child_guard = child_lock.lock().await;
        let lock = state.get_lock(project).await;
        let _guard = lock.lock().await;
        match super::access::require_repository_mutation(app, project).await {
            Ok(_) => commit_parent_pointer(cli, project, space, intent).await,
            Err(error) => Err(error),
        }
    } else {
        Ok(false)
    };
    schedule_committed_sync(app, repo);
    if pointer.unwrap_or_else(|error| {
        tracing::warn!(kind = error.kind(), "child saved; project pointer pending");
        false
    }) {
        emit_committed(app, space, project);
        // With child auto-sync enabled, its pipeline owns the parent step.
        // Otherwise root policy may publish only already available pointers.
        if !is_auto_sync_enabled(repo) {
            schedule_committed_sync(app, project);
        }
    }
    Ok(())
}

fn schedule_committed_sync(app: &AppHandle, repo: &Path) {
    if !is_auto_sync_enabled(repo) { return; }
    let app = app.clone();
    let repo = repo.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::publication_flow::sync(&app, &repo, true, false).await {
            tracing::warn!(kind = error.kind(), "auto-sync after commit failed");
        }
    });
}


fn emit_committed(app: &AppHandle, space_path: &Path, repo_path: &Path) {
    if let Err(error) = crate::actors::invalidate_repository(app, repo_path) {
        tracing::warn!(
            repository = %repo_path.display(),
            "failed to invalidate actor catalog after commit: {error}"
        );
    }
    let payload = CommittedPayload {
        space_path: space_path.to_string_lossy().to_string(),
        repo_path: repo_path.to_string_lossy().to_string(),
    };
    if let Err(e) = app.emit(EVENT_COMMITTED, payload) {
        tracing::warn!("failed to emit {}: {}", EVENT_COMMITTED, e);
    }
}

fn is_auto_sync_enabled(repo_path: &Path) -> bool {
    crate::space::config::effective_git_user_policy(repo_path).auto_sync
}

fn background_commit_allowed(config_path: &Path, intent: CommitIntent) -> bool {
    match intent {
        CommitIntent::ContentWorkspace => false,
        CommitIntent::ManualExplicit => true,
        CommitIntent::StructuralLifecycle => {
            crate::space::config::effective_git_user_policy(config_path).auto_commit_structural
        }
        CommitIntent::SystemConfig => {
            crate::space::config::effective_git_user_policy(config_path).auto_commit_system
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
    #[test]
    fn failed_manual_save_restores_pending_and_success_retains_new_events() {
        let space = std::path::PathBuf::from("/space");
        let pending = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        {
            let _lease = super::PendingSave {
                pending: pending.clone(),
                space: space.clone(),
                items: vec![super::PendingItem {
                    op: None,
                    paths: vec![space.join("old.md"), space.join("new.md")],
                }],
            };
        }
        assert_eq!(pending.lock().unwrap().get(&space).unwrap().items.len(), 1);
        let items = pending.lock().unwrap().remove(&space).unwrap().items;
        let mut lease = super::PendingSave {
            pending: pending.clone(),
            space: space.clone(),
            items,
        };
        pending.lock().unwrap().insert(
            space.clone(),
            super::PendingBatch {
                items: vec![super::PendingItem {
                    op: None,
                    paths: vec![space.join("later.md")],
                }],
            },
        );
        lease.complete();
        drop(lease);
        assert_eq!(
            pending.lock().unwrap().get(&space).unwrap().items[0].paths,
            vec![space.join("later.md")]
        );
    }

    use super::*;
    use crate::space::config::{write_git_user_policy, write_space_config};
    use crate::space::types::{GitSpaceConfig, GitUserPolicy, SpaceConfig};

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
                            let path = crate::repo_path::repo_relative_from_base(
                                target,
                                &abs,
                                crate::repo_path::RootMode::Reject,
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
                            assert_eq!(is_auto_sync_enabled(target), sync);
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
            super::super::sync::sync_if_enabled(&cli, root, false).await.unwrap();
            assert_eq!(
                git(&cli, remote.path(), &["rev-parse", branch]).await,
                before
            );
            super::super::sync::sync_if_enabled(&cli, root, created).await.unwrap();
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

    fn write_git_config(path: &Path, git: GitSpaceConfig) {
        write_space_config(
            path,
            &SpaceConfig {
                name: "Space".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: Some(git),
                assets: None,
                tree: None,
            },
        )
        .expect("write space config");
    }

    fn write_local_git_policy(path: &Path, policy: GitUserPolicy) {
        write_git_user_policy(path, &policy).expect("write local git policy");
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
            GitSpaceConfig {
                auto_sync: Some(true),
                auto_commit_structural: Some(true),
                auto_commit_system: Some(true),
            },
        );
        write_git_config(
            &inline_space,
            GitSpaceConfig {
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

        assert!(!is_auto_sync_enabled(&project));
        assert!(is_auto_sync_enabled(&inline_space));
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
    fn submodule_mailmap_and_root_pointer_policies_are_independent() {
        for child_system in [false, true] {
            for root_structural in [false, true] {
                for child_sync in [false, true] {
                    for root_sync in [false, true] {
                        let temp = tempfile::tempdir().expect("temp dir");
                        let root = temp.path().join("project");
                        let child = root.join("space");
                        std::fs::create_dir_all(&child).expect("create policy roots");
                        write_local_git_policy(
                            &root,
                            GitUserPolicy {
                                auto_sync: root_sync,
                                auto_commit_structural: root_structural,
                                auto_commit_system: false,
                            },
                        );
                        write_local_git_policy(
                            &child,
                            GitUserPolicy {
                                auto_sync: child_sync,
                                auto_commit_structural: false,
                                auto_commit_system: child_system,
                            },
                        );

                        let child_plan = classify_guarded_exact_path_preflight(
                            background_commit_allowed(&child, CommitIntent::SystemConfig),
                            false,
                            false,
                        );
                        let root_plan = classify_guarded_exact_path_preflight(
                            background_commit_allowed(&root, CommitIntent::StructuralLifecycle),
                            false,
                            false,
                        );
                        assert_eq!(child_plan == GuardedExactPathPlan::Eligible, child_system);
                        assert_eq!(root_plan == GuardedExactPathPlan::Eligible, root_structural);
                        assert_eq!(is_auto_sync_enabled(&child), child_sync);
                        assert_eq!(is_auto_sync_enabled(&root), root_sync);

                        // Root eligibility never upgrades a system-policy-pending
                        // child mutation into an automatic `.mailmap` commit.
                        let root_can_follow_created_child = child_plan
                            == GuardedExactPathPlan::Eligible
                            && root_plan == GuardedExactPathPlan::Eligible;
                        assert_eq!(
                            root_can_follow_created_child,
                            child_system && root_structural
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn single_file_save_drains_only_related_pending_paths() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let space = project.join("docs");

        let unrelated = space.join("other.md");
        let old_path = space.join("old.md");
        let active = space.join("new.md");
        let backlink_source = space.join("source.md");
        let rename_op = StructuralOp::Rename {
            old: "old.md".to_string(),
            new: "new.md".to_string(),
        };

        let items = vec![
            PendingItem {
                op: Some(StructuralOp::Create("other.md".to_string())),
                paths: vec![unrelated.clone()],
            },
            PendingItem {
                op: Some(rename_op.clone()),
                paths: vec![old_path.clone(), active.clone()],
            },
            PendingItem {
                op: Some(rename_op),
                paths: vec![backlink_source.clone()],
            },
        ];
        let anchors = vec![active.clone()];
        let matching_ops: Vec<Option<StructuralOp>> = items
            .iter()
            .filter(|item| pending_item_touches(item, &anchors))
            .map(|item| item.op.clone())
            .collect();
        let (drained, kept) = split_related_pending_items(items, &anchors, &matching_ops);

        assert!(drained.contains(&old_path));
        assert!(drained.contains(&active));
        assert!(drained.contains(&backlink_source));
        assert!(!drained.contains(&unrelated));

        assert_eq!(
            dedupe_paths(kept.into_iter().flat_map(|item| item.paths)),
            vec![unrelated]
        );
    }

    #[test]
    fn structural_pending_items_keep_expected_paths_by_operation() {
        let temp = tempfile::tempdir().expect("temp dir");
        let space = temp.path().join("space");
        let order = space.join(".svode").join("order.json");
        let created = space.join("new.md");
        let deleted = space.join("old.md");
        let move_old = space.join("from.md");
        let move_new = space.join("Folder").join("from.md");
        let reordered = space.join("reordered.md");

        let items = vec![
            PendingItem {
                op: Some(StructuralOp::Create("new.md".to_string())),
                paths: vec![order.clone(), created.clone()],
            },
            PendingItem {
                op: Some(StructuralOp::Delete("old.md".to_string())),
                paths: vec![order.clone(), deleted.clone()],
            },
            PendingItem {
                op: Some(StructuralOp::Move("from.md".to_string())),
                paths: vec![order.clone(), move_old.clone(), move_new.clone()],
            },
            PendingItem {
                op: Some(StructuralOp::Reorder),
                paths: vec![order.clone(), reordered.clone()],
            },
        ];

        let (drained, kept) = split_related_pending_items(
            items,
            std::slice::from_ref(&move_new),
            &[Some(StructuralOp::Move("from.md".to_string()))],
        );

        assert_eq!(
            dedupe_paths(drained),
            vec![order.clone(), move_old, move_new]
        );
        assert_eq!(kept.len(), 3);
        assert_eq!(
            dedupe_paths(kept.into_iter().flat_map(|item| item.paths)),
            vec![order, created, deleted, reordered]
        );
    }

    #[test]
    fn single_file_save_drains_move_backlink_sources_by_operation() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let space = project.join("docs");

        let unrelated_create = space.join("draft.md");
        let old_path = space.join("Source.md");
        let moved_path = space.join("Folder").join("Source.md");
        let backlink_source = space.join("Backlink.md");
        let move_op = StructuralOp::Move("Source.md".to_string());

        let items = vec![
            PendingItem {
                op: Some(StructuralOp::Create("draft.md".to_string())),
                paths: vec![unrelated_create.clone()],
            },
            PendingItem {
                op: Some(move_op.clone()),
                paths: vec![old_path.clone(), moved_path.clone()],
            },
            PendingItem {
                op: Some(move_op),
                paths: vec![backlink_source.clone()],
            },
        ];
        let anchors = vec![moved_path.clone()];
        let matching_ops: Vec<Option<StructuralOp>> = items
            .iter()
            .filter(|item| pending_item_touches(item, &anchors))
            .map(|item| item.op.clone())
            .collect();
        let (drained, kept) = split_related_pending_items(items, &anchors, &matching_ops);

        assert!(drained.contains(&old_path));
        assert!(drained.contains(&moved_path));
        assert!(drained.contains(&backlink_source));
        assert!(!drained.contains(&unrelated_create));

        assert_eq!(
            dedupe_paths(kept.into_iter().flat_map(|item| item.paths)),
            vec![unrelated_create]
        );
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
