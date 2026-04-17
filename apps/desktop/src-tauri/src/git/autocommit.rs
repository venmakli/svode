use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use super::commands::GitState;
use super::ops;
use crate::space::types::SpaceGitType;
use crate::AppError;

const DEBOUNCE_MS: u64 = 500;
const EVENT_COMMITTED: &str = "git:committed";

#[derive(Debug, Clone)]
pub enum StructuralOp {
    Create(String),
    Delete(String),
    Rename { old: String, new: String },
    Move(String),
    Reorder,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommittedPayload {
    space_path: String,
    repo_path: String,
}

struct PendingBatch {
    project_path: PathBuf,
    git_type: SpaceGitType,
    target_repo: PathBuf,
    ops: Vec<StructuralOp>,
    timer: Option<JoinHandle<()>>,
}

pub struct AutocommitService {
    app: AppHandle,
    /// Keyed by `space_path` — different spaces never share a batch even when
    /// they target the same repo (multiple inline children of one project).
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
}

impl AutocommitService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Schedule an autocommit for a structural change in the given space.
    pub fn schedule_structural(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
        op: StructuralOp,
    ) {
        let app = self.app.clone();
        let pending = self.pending.clone();
        tauri::async_runtime::spawn(async move {
            let (git_type, target_repo) =
                match resolve_target_repo(&app, &project_path, &space_path).await {
                    Some(t) => t,
                    None => return,
                };

            let mut map = pending.lock().await;
            let entry = map.entry(space_path.clone()).or_insert_with(|| PendingBatch {
                project_path: project_path.clone(),
                git_type,
                target_repo: target_repo.clone(),
                ops: Vec::new(),
                timer: None,
            });
            // Project path is stable for a given space, but keep in sync defensively.
            entry.project_path = project_path.clone();
            entry.git_type = git_type;
            entry.target_repo = target_repo.clone();
            entry.ops.push(op);

            if let Some(handle) = entry.timer.take() {
                handle.abort();
            }

            let app_fire = app.clone();
            let pending_fire = pending.clone();
            let key_fire = space_path.clone();
            let handle = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                fire_batch(&app_fire, pending_fire, &key_fire).await;
            });
            entry.timer = Some(handle);
        });
    }

    /// Drain any pending structural batch for this space and commit it
    /// synchronously. Called before a user ⌘S/⌘⇧S so the two categories
    /// don't share a commit.
    pub async fn flush_space(&self, space_path: &Path) {
        {
            let mut map = self.pending.lock().await;
            if let Some(batch) = map.get_mut(space_path) {
                if let Some(h) = batch.timer.take() {
                    h.abort();
                }
            }
        }
        fire_batch(&self.app, self.pending.clone(), space_path).await;
    }

    /// Commit a system config change immediately (no debounce).
    pub fn commit_config_now(&self, project_path: PathBuf, space_path: PathBuf) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = do_commit_config(&app, &project_path, &space_path).await {
                tracing::warn!(
                    "commit_config_now failed for {}: {}",
                    space_path.display(),
                    e
                );
            }
        });
    }

    /// Commit the scaffolded `.combai/` directory after a clone.
    pub async fn commit_scaffold(
        &self,
        project_path: PathBuf,
        space_path: PathBuf,
    ) -> Result<(), AppError> {
        do_commit_scaffold(&self.app, &project_path, &space_path).await
    }

    /// Flush all pending timers: cancel each and run the pending commits synchronously.
    pub async fn flush_all(&self) {
        let keys: Vec<PathBuf> = {
            let map = self.pending.lock().await;
            map.keys().cloned().collect()
        };
        for key in keys {
            // Cancel timer to prevent it from racing with us.
            {
                let mut map = self.pending.lock().await;
                if let Some(batch) = map.get_mut(&key) {
                    if let Some(h) = batch.timer.take() {
                        h.abort();
                    }
                }
            }
            fire_batch(&self.app, self.pending.clone(), &key).await;
        }
    }
}

/// Determine the commit target repo and git type for this (project, space).
async fn resolve_target_repo(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
) -> Option<(SpaceGitType, PathBuf)> {
    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone()?;
    match ops::resolve_target_repo(&cli, project_path, space_path).await {
        Ok(pair) => Some(pair),
        Err(e) => {
            tracing::warn!(
                "autocommit: resolve_target_repo failed for {}: {}",
                space_path.display(),
                e
            );
            None
        }
    }
}

/// Drain the pending batch for `space_path` and commit.
async fn fire_batch(
    app: &AppHandle,
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
    space_path: &Path,
) {
    let batch_opt = {
        let mut map = pending.lock().await;
        map.remove(space_path)
    };
    let Some(batch) = batch_opt else { return };
    if batch.ops.is_empty() {
        return;
    }

    if !space_path.exists() {
        tracing::warn!(
            "autocommit: space path missing, skipping commit: {}",
            space_path.display()
        );
        return;
    }

    let message = aggregate_message(&batch.ops);

    if let Err(e) = run_autocommit(
        app,
        &batch.project_path,
        space_path,
        batch.git_type,
        &batch.target_repo,
        &message,
    )
    .await
    {
        tracing::warn!("autocommit failed for {}: {}", space_path.display(), e);
    }
}

/// Run a routed commit under the target repo's lock and emit event.
async fn run_autocommit(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
    git_type: SpaceGitType,
    target_repo: &Path,
    message: &str,
) -> Result<(), AppError> {
    let git_state = app.state::<GitState>();
    let cli = match git_state.cli.clone() {
        Some(c) => c,
        None => return Err(AppError::GitNotFound),
    };

    let lock = git_state.get_lock(target_repo).await;
    let _guard = lock.lock().await;

    let created =
        ops::commit_all_routed_with_message(&cli, project_path, space_path, message).await?;

    if created {
        emit_committed(app, space_path, target_repo);
        // Pointer update in root for submodule is done inside commit_all_routed_with_message.
        if matches!(git_type, SpaceGitType::Submodule) {
            emit_committed(app, space_path, project_path);
        }

        // Trigger auto-sync if enabled on the config repo (inline reads root,
        // independent/submodule read the space's own config).
        let config_repo: PathBuf = match git_type {
            SpaceGitType::Inline => project_path.to_path_buf(),
            SpaceGitType::Independent | SpaceGitType::Submodule => space_path.to_path_buf(),
        };
        if is_auto_sync_enabled(&config_repo) {
            let cli_sync = cli.clone();
            let sync_target = target_repo.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &sync_target).await {
                    tracing::warn!(
                        "auto-sync failed for {}: {}",
                        sync_target.display(),
                        e
                    );
                }
            });
        }

        // For submodule, also auto-sync root if enabled there.
        if matches!(git_type, SpaceGitType::Submodule) && is_auto_sync_enabled(project_path) {
            let cli_sync = cli.clone();
            let root = project_path.to_path_buf();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::git::sync::sync(&cli_sync, &root).await {
                    tracing::warn!("auto-sync (root) failed for {}: {}", root.display(), e);
                }
            });
        }
    }

    Ok(())
}

async fn do_commit_config(
    app: &AppHandle,
    project_path: &Path,
    space_path: &Path,
) -> Result<(), AppError> {
    if !space_path.exists() {
        tracing::warn!(
            "commit_config_now: space path missing, skipping: {}",
            space_path.display()
        );
        return Ok(());
    }

    let git_state = app.state::<GitState>();
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let git_type = ops::detect_space_git_type(&cli, project_path, space_path).await?;

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let (created, target_repo): (bool, PathBuf) = match git_type {
        SpaceGitType::Inline => {
            let lock = git_state.get_lock(project_path).await;
            let _guard = lock.lock().await;
            let rel = if space_path == project_path {
                ".combai/config.json".to_string()
            } else {
                format!("{}/.combai/config.json", space_folder)
            };
            let c = ops::commit_path_with_message(
                &cli,
                project_path,
                &rel,
                "Update space config",
            )
            .await?;
            if c {
                emit_committed(app, space_path, project_path);
            }
            (c, project_path.to_path_buf())
        }
        SpaceGitType::Independent => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            let c = ops::commit_path_with_message(
                &cli,
                space_path,
                ".combai/config.json",
                "Update space config",
            )
            .await?;
            if c {
                emit_committed(app, space_path, space_path);
            }
            (c, space_path.to_path_buf())
        }
        SpaceGitType::Submodule => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            let c = ops::commit_path_with_message(
                &cli,
                space_path,
                ".combai/config.json",
                "Update space config",
            )
            .await?;
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
        // Auto-sync mirrors the structural path: commit's own repo if enabled;
        // for submodule also sync root if its auto-sync is on.
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
                        "auto-sync (config) failed for {}: {}",
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
                        "auto-sync (config, root) failed for {}: {}",
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
    let message = "Scaffold .combai";

    match git_type {
        SpaceGitType::Inline => {
            let lock = git_state.get_lock(project_path).await;
            let _guard = lock.lock().await;
            let rel = if space_path == project_path {
                ".combai".to_string()
            } else {
                format!("{}/.combai", space_folder)
            };
            let created = ops::commit_path_with_message(&cli, project_path, &rel, message).await?;
            if created {
                emit_committed(app, space_path, project_path);
            }
        }
        SpaceGitType::Independent => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            let created =
                ops::commit_path_with_message(&cli, space_path, ".combai", message).await?;
            if created {
                emit_committed(app, space_path, space_path);
            }
        }
        SpaceGitType::Submodule => {
            let lock = git_state.get_lock(space_path).await;
            let _guard = lock.lock().await;
            let created =
                ops::commit_path_with_message(&cli, space_path, ".combai", message).await?;
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

/// Aggregate multiple structural ops into a single commit message.
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

    for op in &non_reorder {
        match op {
            StructuralOp::Create(n) => creates.push(n),
            StructuralOp::Delete(n) => deletes.push(n),
            StructuralOp::Move(n) => moves.push(n),
            StructuralOp::Rename { old, new } => renames.push((old, new)),
            StructuralOp::Reorder => {}
        }
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
            1 => format!("Rename {} \u{2192} {}", items[0].0, items[0].1),
            n => format!("Rename {} files", n),
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
        if has_reorder {
            return "Reorder files".to_string();
        }
    }

    // Mixed kinds. If total individual items is small (≤5), join per-op messages.
    let total: usize = creates.len() + deletes.len() + moves.len() + renames.len();
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
