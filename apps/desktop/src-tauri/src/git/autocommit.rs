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
#[derive(Debug, Clone)]
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
    fn paths(self) -> &'static [&'static str] {
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

struct PendingBatch {
    paths: Vec<PathBuf>,
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
            .or_insert_with(|| PendingBatch { paths: Vec::new() });
        let _ = op;
        entry.paths.extend(paths.into_iter().map(|path| {
            if path.is_absolute() {
                path
            } else {
                space_path.join(path)
            }
        }));
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

        let mut unique = Vec::new();
        for path in batch.paths {
            if !unique.iter().any(|existing: &PathBuf| existing == &path) {
                unique.push(path);
            }
        }
        unique
    }

    /// Drop pending content/schema bookkeeping for one space before a manual
    /// Save All. The commit itself stages the whole routed space/repo.
    pub fn drop_pending_paths_for_space(&self, project_path: &Path, space_path: &Path) {
        let _ = self.take_pending_paths_for_space(project_path, space_path);
    }

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
        let target_repo: PathBuf = match git_type {
            SpaceGitType::Inline => project_path.clone(),
            SpaceGitType::Independent | SpaceGitType::Submodule => space_path.clone(),
        };

        if !background_commit_allowed(&target_repo, CommitIntent::SystemConfig) {
            return Ok(());
        }

        do_commit_system(&self.app, &project_path, &space_path, git_type, kind).await
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

        do_commit_system(&self.app, &project_path, &space_path, git_type, kind).await
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
        let target_repo: PathBuf = match git_type {
            SpaceGitType::Inline => project_path.clone(),
            SpaceGitType::Independent | SpaceGitType::Submodule => space_path.clone(),
        };

        if !background_commit_allowed(&target_repo, CommitIntent::StructuralLifecycle) {
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
    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;

    let (repo, needs_pointer_update) = match git_type {
        SpaceGitType::Inline => (project_path, false),
        SpaceGitType::Independent => (space_path, false),
        SpaceGitType::Submodule => (space_path, true),
    };

    let lock = git_state.get_lock(repo).await;
    let guard = lock.lock().await;
    for abs_path in &paths {
        let rel = abs_path
            .strip_prefix(repo)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .replace('\\', "/");
        let _ = ops::add(&cli, repo, &rel).await;
    }
    let created = ops::commit(&cli, repo, message).await?;
    drop(guard);

    if created {
        emit_committed(app, space_path, repo);

        if needs_pointer_update {
            let root_lock = git_state.get_lock(project_path).await;
            let _root_guard = root_lock.lock().await;
            ops::submodule_update_pointer(&cli, project_path, space_path).await?;
            emit_committed(app, space_path, project_path);
        }

        if is_auto_sync_enabled(repo) {
            let cli_sync = cli.clone();
            let sync_target = repo.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &sync_target).await {
                    tracing::warn!(
                        "auto-sync (paths) failed for {}: {}",
                        sync_target.display(),
                        e
                    );
                }
            });
        }

        if needs_pointer_update && is_auto_sync_enabled(project_path) {
            let cli_sync = cli.clone();
            let root = project_path.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &root).await {
                    tracing::warn!(
                        "auto-sync (paths, root) failed for {}: {}",
                        root.display(),
                        e
                    );
                }
            });
        }
    }

    Ok(())
}

async fn do_commit_system(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    kind: SystemCommitKind,
) -> Result<(), AppError> {
    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let message = kind.message();
    let paths = kind.paths();

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let (created, target_repo): (bool, PathBuf) = match git_type {
        SpaceGitType::Inline => {
            let lock = git_state.get_lock(project_path).await;
            let _guard = lock.lock().await;
            for rel in paths {
                let staged = if space_path == project_path {
                    (*rel).to_string()
                } else {
                    format!("{}/{}", space_folder, rel)
                };
                // Ignore add errors for paths that may not exist (e.g. `.claude`
                // when no CLI integration is active) — they just contribute
                // nothing to the commit.
                let _ = ops::add(&cli, project_path, &staged).await;
            }
            let c = ops::commit(&cli, project_path, message).await?;
            if c {
                emit_committed(app, space_path, project_path);
            }
            (c, project_path.to_path_buf())
        }
        SpaceGitType::Independent => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            for rel in paths {
                let _ = ops::add(&cli, space_path, rel).await;
            }
            let c = ops::commit(&cli, space_path, message).await?;
            if c {
                emit_committed(app, space_path, space_path);
            }
            (c, space_path.to_path_buf())
        }
        SpaceGitType::Submodule => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            for rel in paths {
                let _ = ops::add(&cli, space_path, rel).await;
            }
            let c = ops::commit(&cli, space_path, message).await?;
            drop(_guard);
            if c {
                emit_committed(app, space_path, space_path);
                let root_lock = git_state.get_lock(project_path).await;
                let _root_guard = root_lock.lock().await;
                ops::submodule_update_pointer(&cli, project_path, space_path).await?;
                emit_committed(app, space_path, project_path);
            }
            (c, space_path.to_path_buf())
        }
    };

    if created {
        let config_repo: PathBuf = match git_type {
            SpaceGitType::Inline => project_path.to_path_buf(),
            SpaceGitType::Independent | SpaceGitType::Submodule => space_path.to_path_buf(),
        };
        if is_auto_sync_enabled(&config_repo) {
            let cli_sync = cli.clone();
            let sync_target = target_repo.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &sync_target).await {
                    tracing::warn!(
                        "auto-sync (system) failed for {}: {}",
                        sync_target.display(),
                        e
                    );
                }
            });
        }
        if matches!(git_type, SpaceGitType::Submodule) && is_auto_sync_enabled(project_path) {
            let cli_sync = cli.clone();
            let root = project_path.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &root).await {
                    tracing::warn!(
                        "auto-sync (system, root) failed for {}: {}",
                        root.display(),
                        e
                    );
                }
            });
        }
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

    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let git_type = ops::detect_space_git_type(&cli, project_path, space_path).await?;

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let message = "Scaffold .svode";
    let target_repo = match git_type {
        SpaceGitType::Inline => project_path,
        SpaceGitType::Independent | SpaceGitType::Submodule => space_path,
    };

    match git_type {
        SpaceGitType::Inline => {
            let lock = git_state.get_lock(project_path).await;
            let _guard = lock.lock().await;
            let rel = if space_path == project_path {
                ops::ensure_svode_gitignore(project_path)?;
                ".svode".to_string()
            } else {
                ops::ensure_inline_gitignore(project_path)?;
                format!("{}/.svode", space_folder)
            };
            if !background_commit_allowed(target_repo, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            ops::add(&cli, project_path, ".gitignore").await?;
            ops::add(&cli, project_path, &rel).await?;
            if include_readme {
                let readme = if space_path == project_path {
                    "README.md".to_string()
                } else {
                    format!("{}/README.md", space_folder)
                };
                if project_path.join(&readme).exists() {
                    ops::add(&cli, project_path, &readme).await?;
                }
            }
            let created = ops::commit(&cli, project_path, message).await?;
            if created {
                emit_committed(app, space_path, project_path);
            }
        }
        SpaceGitType::Independent => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            ops::ensure_svode_gitignore(space_path)?;
            if !background_commit_allowed(target_repo, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            ops::add(&cli, space_path, ".gitignore").await?;
            ops::add(&cli, space_path, ".svode").await?;
            if include_readme && space_path.join("README.md").exists() {
                ops::add(&cli, space_path, "README.md").await?;
            }
            let created = ops::commit(&cli, space_path, message).await?;
            if created {
                emit_committed(app, space_path, space_path);
            }
        }
        SpaceGitType::Submodule => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            ops::ensure_svode_gitignore(space_path)?;
            if !background_commit_allowed(target_repo, CommitIntent::StructuralLifecycle) {
                return Ok(());
            }
            ops::add(&cli, space_path, ".gitignore").await?;
            ops::add(&cli, space_path, ".svode").await?;
            if include_readme && space_path.join("README.md").exists() {
                ops::add(&cli, space_path, "README.md").await?;
            }
            let created = ops::commit(&cli, space_path, message).await?;
            drop(_guard);
            if created {
                emit_committed(app, space_path, space_path);
                let root_lock = git_state.get_lock(project_path).await;
                let _root_guard = root_lock.lock().await;
                ops::submodule_update_pointer(&cli, project_path, space_path).await?;
                emit_committed(app, space_path, project_path);
            }
        }
    }

    Ok(())
}

fn emit_committed(app: &AppHandle, space_path: &Path, repo_path: &Path) {
    let payload = CommittedPayload {
        space_path: space_path.to_string_lossy().to_string(),
        repo_path: repo_path.to_string_lossy().to_string(),
    };
    if let Err(e) = app.emit(EVENT_COMMITTED, payload) {
        tracing::warn!("failed to emit {}: {}", EVENT_COMMITTED, e);
    }
}

fn is_auto_sync_enabled(repo_path: &Path) -> bool {
    crate::space::config::read_space_config(repo_path)
        .ok()
        .and_then(|c| c.git)
        .and_then(|g| g.auto_sync)
        .unwrap_or(false)
}

fn background_commit_allowed(config_path: &Path, intent: CommitIntent) -> bool {
    match intent {
        CommitIntent::ContentWorkspace => false,
        CommitIntent::ManualExplicit => true,
        CommitIntent::StructuralLifecycle => crate::space::config::read_space_config(config_path)
            .ok()
            .and_then(|c| c.git)
            .and_then(|g| g.auto_commit_structural)
            .unwrap_or(false),
        CommitIntent::SystemConfig => crate::space::config::read_space_config(config_path)
            .ok()
            .and_then(|c| c.git)
            .and_then(|g| g.auto_commit_system)
            .unwrap_or(false),
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
    use super::*;

    fn s(x: &str) -> String {
        x.to_string()
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
