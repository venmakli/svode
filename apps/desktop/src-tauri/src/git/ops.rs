use std::path::Path;

use serde::Serialize;
use std::collections::BTreeMap;

use super::cli::GitCli;
use crate::AppError;
use crate::properties;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::types::SpaceGitType;

const GITIGNORE_TEMPLATE: &str = "# Svode local files
.svode/local.json
.svode/*.db
.svode/*.db-wal
.svode/*.db-shm
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_staged: bool,
    pub has_unstaged: bool,
    pub has_conflicts: bool,
    pub tracking: Option<String>,
    pub files: Vec<FileGitStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGitStatus {
    pub path: String,
    /// "modified" | "untracked" | "conflict"
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmoduleConfig {
    pub path: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NameStatusRecord {
    status: char,
    path: String,
}

/// Get configured remote URL (origin).
pub async fn get_remote(cli: &GitCli, space_dir: &Path) -> Result<Option<String>, AppError> {
    let out = cli
        .exec(space_dir, &["config", "--get", "remote.origin.url"])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let url = out.stdout.trim().to_string();
    if url.is_empty() {
        Ok(None)
    } else {
        Ok(Some(url))
    }
}

/// List submodules declared in `.gitmodules`.
pub async fn list_submodules(
    cli: &GitCli,
    project_path: &Path,
) -> Result<Vec<SubmoduleConfig>, AppError> {
    if !project_path.join(".gitmodules").exists() {
        return Ok(Vec::new());
    }

    let out = cli
        .exec(
            project_path,
            &[
                "config",
                "-f",
                ".gitmodules",
                "--get-regexp",
                "^submodule\\..*\\.",
            ],
        )
        .await?;

    if out.exit_code != 0 {
        return Ok(Vec::new());
    }

    Ok(parse_submodule_config_output(&out.stdout))
}

fn parse_submodule_config_output(stdout: &str) -> Vec<SubmoduleConfig> {
    #[derive(Default)]
    struct PartialSubmodule {
        path: Option<String>,
        url: Option<String>,
    }

    let mut by_name: BTreeMap<String, PartialSubmodule> = BTreeMap::new();

    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };

        let value = value.trim().to_string();
        if let Some(name) = rest.strip_suffix(".path") {
            by_name.entry(name.to_string()).or_default().path = Some(value);
        } else if let Some(name) = rest.strip_suffix(".url") {
            by_name.entry(name.to_string()).or_default().url = Some(value);
        }
    }

    by_name
        .into_values()
        .filter_map(|partial| {
            partial.path.map(|path| SubmoduleConfig {
                path,
                url: partial.url,
            })
        })
        .collect()
}

/// Set or add the `origin` remote URL.
pub async fn set_remote(cli: &GitCli, space_dir: &Path, url: &str) -> Result<(), AppError> {
    // Check if origin exists
    let exists = cli
        .exec(space_dir, &["remote", "get-url", "origin"])
        .await?;
    let args: Vec<&str> = if exists.exit_code == 0 {
        vec!["remote", "set-url", "origin", url]
    } else {
        vec!["remote", "add", "origin", url]
    };
    let out = cli.exec(space_dir, &args).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git remote failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Push current branch silently. Used for app-focus auto-push of unpushed commits.
pub async fn push(cli: &GitCli, space_dir: &Path) -> Result<(), AppError> {
    let out = cli.exec(space_dir, &["push"]).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(stderr.to_string()));
        }
        if stderr.contains("No configured push destination")
            || stderr.contains("does not appear to be a git repository")
        {
            return Err(AppError::GitNoRemote);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }
    Ok(())
}

/// Initialize a new git repo in space_dir.
pub async fn init(cli: &GitCli, space_dir: &Path) -> Result<(), AppError> {
    // git init
    let out = cli.exec(space_dir, &["init"]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git init failed: {}",
            out.stderr
        )));
    }

    // config core.quotePath false (for unicode filenames)
    cli.exec(space_dir, &["config", "core.quotePath", "false"])
        .await?;

    // write .gitignore
    let gitignore_path = space_dir.join(".gitignore");
    if !gitignore_path.exists() {
        tokio::fs::write(&gitignore_path, GITIGNORE_TEMPLATE).await?;
    }

    // git add .
    let out = cli.exec(space_dir, &["add", "."]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }

    // initial commit
    let _ = commit(cli, space_dir, "Scaffold .svode").await?;

    tracing::info!("Initialized git repo at {}", space_dir.display());
    Ok(())
}

/// Get space git status by parsing `git status --porcelain=v2 --branch -z`.
pub async fn status(cli: &GitCli, space_dir: &Path) -> Result<GitStatus, AppError> {
    let out = cli
        .exec(space_dir, &["status", "--porcelain=v2", "--branch", "-z"])
        .await?;

    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git status failed: {}",
            out.stderr
        )));
    }

    parse_status_porcelain_v2_z(&out.stdout)
}

fn parse_status_porcelain_v2_z(stdout: &str) -> Result<GitStatus, AppError> {
    let mut branch = String::from("HEAD");
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut has_staged = false;
    let mut has_unstaged = false;
    let mut has_conflicts = false;
    let mut tracking: Option<String> = None;
    let mut files: Vec<FileGitStatus> = Vec::new();

    let records: Vec<&str> = stdout.split('\0').collect();
    let mut idx = 0;
    while idx < records.len() {
        let record = records[idx];
        idx += 1;
        if record.is_empty() {
            continue;
        }

        if let Some(rest) = record.strip_prefix("# branch.head ") {
            branch = rest.to_string();
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            tracking = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }

        if record.starts_with("u ") {
            has_conflicts = true;
            if let Some(path) = split_status_fields(record, 11).get(10) {
                files.push(FileGitStatus {
                    path: normalize_git_path(path)?,
                    state: "conflict".to_string(),
                });
            }
            continue;
        }

        if record.starts_with("1 ") {
            let fields = split_status_fields(record, 9);
            if fields.len() >= 9 {
                update_staged_flags(fields[1], &mut has_staged, &mut has_unstaged);
                files.push(FileGitStatus {
                    path: normalize_git_path(fields[8])?,
                    state: "modified".to_string(),
                });
            }
            continue;
        }

        if record.starts_with("2 ") {
            let fields = split_status_fields(record, 10);
            if fields.len() >= 10 {
                update_staged_flags(fields[1], &mut has_staged, &mut has_unstaged);
                files.push(FileGitStatus {
                    path: normalize_git_path(fields[9])?,
                    state: "modified".to_string(),
                });
                if idx < records.len() && !records[idx].is_empty() {
                    idx += 1;
                }
            }
            continue;
        }

        if let Some(rest) = record.strip_prefix("? ") {
            has_unstaged = true;
            files.push(FileGitStatus {
                path: normalize_git_path(rest)?,
                state: "untracked".to_string(),
            });
        }
    }

    Ok(GitStatus {
        branch,
        ahead,
        behind,
        has_staged,
        has_unstaged,
        has_conflicts,
        tracking,
        files,
    })
}

fn split_status_fields(record: &str, fields: usize) -> Vec<&str> {
    record.splitn(fields, ' ').collect()
}

fn update_staged_flags(xy: &str, has_staged: &mut bool, has_unstaged: &mut bool) {
    if xy.len() < 2 {
        return;
    }
    let x = xy.as_bytes()[0];
    let y = xy.as_bytes()[1];
    if x != b'.' {
        *has_staged = true;
    }
    if y != b'.' {
        *has_unstaged = true;
    }
}

fn normalize_git_path(path: &str) -> Result<String, AppError> {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    normalize_repo_relative(trimmed, RootMode::Reject)
}

/// Stage a specific file.
pub async fn add(cli: &GitCli, space_dir: &Path, path: &str) -> Result<(), AppError> {
    let out = cli.exec(space_dir, &["add", path]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Stage all changes.
pub async fn add_all(cli: &GitCli, space_dir: &Path) -> Result<(), AppError> {
    let out = cli.exec(space_dir, &["add", "."]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Commit with a given message. Returns `Ok(false)` if there was nothing
/// to commit, `Ok(true)` if a commit was created.
pub async fn commit(cli: &GitCli, space_dir: &Path, message: &str) -> Result<bool, AppError> {
    let out = cli.exec(space_dir, &["commit", "-m", message]).await?;
    if out.exit_code != 0 {
        let combined = format!("{}{}", out.stdout, out.stderr);
        if combined.contains("nothing to commit")
            || combined.contains("no changes added to commit")
            || combined.contains("nothing added to commit")
        {
            return Ok(false);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            out.stderr
        )));
    }
    Ok(true)
}

/// Stage a specific file and auto-commit with a generated message.
/// Returns `true` if a commit was actually created.
pub async fn commit_file(
    cli: &GitCli,
    space_dir: &Path,
    file_path: &str,
) -> Result<bool, AppError> {
    add(cli, space_dir, file_path).await?;
    let message = generate_commit_message(cli, space_dir).await?;
    let created = commit(cli, space_dir, &message).await?;
    if created {
        tracing::info!(
            "Auto-committed file {} in {}",
            file_path,
            space_dir.display()
        );
    }
    Ok(created)
}

/// Stage all changes and auto-commit with a generated message.
pub async fn commit_all(cli: &GitCli, space_dir: &Path) -> Result<bool, AppError> {
    add_all(cli, space_dir).await?;
    let message = generate_commit_message(cli, space_dir).await?;
    let created = commit(cli, space_dir, &message).await?;
    if created {
        tracing::info!("Auto-committed all in {}", space_dir.display());
    }
    Ok(created)
}

/// Generate a commit message based on staged changes.
pub async fn generate_commit_message(cli: &GitCli, space_dir: &Path) -> Result<String, AppError> {
    let out = cli.exec(space_dir, &["diff", "--cached", "--stat"]).await?;

    if out.stdout.trim().is_empty() {
        return Ok("Update space".to_string());
    }

    let mut added: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();

    // Also check diff --cached --name-status for accurate categorization
    let name_status = cli
        .exec(space_dir, &["diff", "--cached", "--name-status", "-z"])
        .await?;
    let records = parse_name_status_z(&name_status.stdout)?;

    if staged_changes_touch_sensitive_collection(space_dir, &records) {
        return Ok(sensitive_commit_message(&records));
    }

    for record in records {
        let file = record
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&record.path)
            .to_string();

        match record.status {
            'A' => added.push(file),
            'M' => modified.push(file),
            'D' => deleted.push(file),
            'R' => modified.push(file),
            _ => modified.push(file),
        }
    }

    let total = added.len() + modified.len() + deleted.len();

    if total == 0 {
        return Ok("Update space".to_string());
    }

    if total <= 5 {
        // List individual files
        let mut parts: Vec<String> = Vec::new();
        if !modified.is_empty() {
            parts.push(format!("Update {}", modified.join(", ")));
        }
        if !added.is_empty() {
            parts.push(format!("Add {}", added.join(", ")));
        }
        if !deleted.is_empty() {
            parts.push(format!("Delete {}", deleted.join(", ")));
        }
        Ok(parts.join("; "))
    } else {
        // Summarize counts
        let mut parts: Vec<String> = Vec::new();
        if !modified.is_empty() {
            parts.push(format!(
                "Update {} file{}",
                modified.len(),
                if modified.len() == 1 { "" } else { "s" }
            ));
        }
        if !added.is_empty() {
            parts.push(format!(
                "Add {} file{}",
                added.len(),
                if added.len() == 1 { "" } else { "s" }
            ));
        }
        if !deleted.is_empty() {
            parts.push(format!(
                "Delete {} file{}",
                deleted.len(),
                if deleted.len() == 1 { "" } else { "s" }
            ));
        }
        Ok(parts.join(", "))
    }
}

fn staged_changes_touch_sensitive_collection(
    repo_dir: &Path,
    records: &[NameStatusRecord],
) -> bool {
    let repo = repo_dir.to_string_lossy();
    records.iter().any(|record| {
        properties::resolve_collection_schema_result(&repo, &record.path)
            .ok()
            .flatten()
            .is_some_and(|(schema, _)| properties::schema_has_sensitive_columns(&schema))
    })
}

fn sensitive_commit_message(records: &[NameStatusRecord]) -> String {
    let total = records.len();
    if total == 0 {
        return "Update space".to_string();
    }
    if total > 1 {
        return "Update collection entries".to_string();
    }
    match records[0].status {
        'A' => "Create collection entry".to_string(),
        'D' => "Delete collection entry".to_string(),
        'R' => "Rename collection entry".to_string(),
        _ => "Update collection entry".to_string(),
    }
}

fn parse_name_status_z(stdout: &str) -> Result<Vec<NameStatusRecord>, AppError> {
    let tokens: Vec<&str> = stdout
        .split('\0')
        .filter(|token| !token.is_empty())
        .collect();
    let mut records = Vec::new();
    let mut idx = 0;
    while idx < tokens.len() {
        let status = tokens[idx];
        idx += 1;
        let Some(kind) = status.chars().next() else {
            continue;
        };
        if matches!(kind, 'R' | 'C') {
            if idx + 1 >= tokens.len() {
                break;
            }
            idx += 1;
            let path = normalize_git_path(tokens[idx])?;
            idx += 1;
            records.push(NameStatusRecord { status: kind, path });
            continue;
        }
        if idx >= tokens.len() {
            break;
        }
        let path = normalize_git_path(tokens[idx])?;
        idx += 1;
        records.push(NameStatusRecord { status: kind, path });
    }
    Ok(records)
}

fn parse_nul_paths(stdout: &str) -> Result<Vec<String>, AppError> {
    stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(normalize_git_path)
        .collect()
}

/// Get list of files changed since last pull.
pub async fn diff_after_pull(cli: &GitCli, space_dir: &Path) -> Result<Vec<String>, AppError> {
    let out = cli
        .exec(
            space_dir,
            &["diff", "--name-only", "-z", "HEAD@{1}", "HEAD"],
        )
        .await?;

    if out.exit_code != 0 {
        // HEAD@{1} may not exist if no reflog yet
        return Ok(Vec::new());
    }

    parse_nul_paths(&out.stdout)
}

// --- Per-space git type ---

/// Detect the git type of a space relative to its project.
///
/// Assumes a space is a direct child of the project (no nested spaces) —
/// `.gitmodules` submodule paths and staged relative paths elsewhere rely on
/// that topology too.
pub async fn detect_space_git_type(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<SpaceGitType, AppError> {
    // Inline = no own git entry at the space root. We deliberately do NOT
    // use `git rev-parse --git-dir` here: for a subfolder of a parent repo,
    // it walks up and succeeds with the parent's `.git`, which would
    // misclassify inline as independent. `symlink_metadata` returns Ok for
    // both `.git` directories (regular repos) and `.git` files (submodule
    // worktrees), and Err when no `.git` entry exists at all.
    if space_path.join(".git").symlink_metadata().is_err() {
        return Ok(SpaceGitType::Inline);
    }

    // Has own `.git` — either independent or submodule. Submodule is
    // identified by the parent repo listing this folder in `.gitmodules`.
    let gitmodules = project_path.join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(SpaceGitType::Independent);
    }

    let config_out = cli
        .exec(
            project_path,
            &["config", "-f", ".gitmodules", "--get-regexp", "path"],
        )
        .await?;
    if config_out.exit_code != 0 {
        return Ok(SpaceGitType::Independent);
    }

    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    for line in config_out.stdout.lines() {
        // Format: "submodule.<name>.path <value>"
        if let Some(path_val) = line.split_whitespace().nth(1) {
            if path_val == space_folder {
                return Ok(SpaceGitType::Submodule);
            }
        }
    }

    Ok(SpaceGitType::Independent)
}

/// Detect git type and resolve which repo should be the commit target.
/// Inline → project repo, Independent/Submodule → the space's own repo.
pub async fn resolve_target_repo(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<(SpaceGitType, std::path::PathBuf), AppError> {
    let git_type = detect_space_git_type(cli, project_path, space_path).await?;
    let target = match git_type {
        SpaceGitType::Inline => project_path.to_path_buf(),
        SpaceGitType::Independent | SpaceGitType::Submodule => space_path.to_path_buf(),
    };
    Ok((git_type, target))
}

/// Get the configured URL for a submodule from .gitmodules.
pub async fn get_submodule_url(
    cli: &GitCli,
    root_path: &Path,
    space_folder: &str,
) -> Result<Option<String>, AppError> {
    let key = format!("submodule.{}.url", space_folder);
    let out = cli
        .exec(root_path, &["config", "-f", ".gitmodules", "--get", &key])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let url = out.stdout.trim().to_string();
    if url.is_empty() {
        Ok(None)
    } else {
        Ok(Some(url))
    }
}

/// Validate a clone URL (HTTPS or SSH).
pub fn validate_clone_url(url: &str) -> Result<(), AppError> {
    let trimmed = url.trim();
    let valid = trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || (trimmed.contains('@')
            && trimmed.contains(':')
            && !trimmed.starts_with("ssh://")
            && !trimmed.starts_with("git://")
            && !trimmed.starts_with("file://"));
    if !valid {
        return Err(AppError::InvalidUrl(trimmed.to_string()));
    }
    Ok(())
}

// --- .gitignore managed blocks ---

const INLINE_BLOCK_START: &str = "# svode:inline:start";
const INLINE_BLOCK_END: &str = "# svode:inline:end";
const INLINE_BLOCK_CONTENT: &str = "*/.svode/local.json\n*/.svode/*.db\n*/.svode/*.db-*";

const SPACES_BLOCK_START: &str = "# svode:spaces:start";
const SPACES_BLOCK_END: &str = "# svode:spaces:end";

/// Ensure the inline wildcard block exists in root .gitignore.
pub fn ensure_inline_gitignore(project_path: &Path) -> Result<(), AppError> {
    let gitignore = project_path.join(".gitignore");
    let content = if gitignore.exists() {
        std::fs::read_to_string(&gitignore)?
    } else {
        String::new()
    };

    if content.contains(INLINE_BLOCK_START) {
        return Ok(());
    }

    let mut new_content = content;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&format!(
        "{}\n{}\n{}\n",
        INLINE_BLOCK_START, INLINE_BLOCK_CONTENT, INLINE_BLOCK_END
    ));
    std::fs::write(&gitignore, new_content)?;
    Ok(())
}

/// Add an independent space path to the managed block in root .gitignore.
pub fn add_independent_gitignore(project_path: &Path, space_folder: &str) -> Result<(), AppError> {
    let gitignore = project_path.join(".gitignore");
    let content = if gitignore.exists() {
        std::fs::read_to_string(&gitignore)?
    } else {
        String::new()
    };

    let entry = format!("{}/", space_folder);

    if let Some((before, block, after)) =
        extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END)
    {
        if block.lines().any(|l| l.trim() == entry) {
            return Ok(());
        }
        let mut new_block = block.to_string();
        if !new_block.is_empty() && !new_block.ends_with('\n') {
            new_block.push('\n');
        }
        new_block.push_str(&entry);
        new_block.push('\n');
        let new_content = format!(
            "{}{}\n{}{}\n{}",
            before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after
        );
        std::fs::write(&gitignore, new_content)?;
    } else {
        let mut new_content = content;
        if !new_content.is_empty() && !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        new_content.push_str(&format!(
            "{}\n{}\n{}\n",
            SPACES_BLOCK_START, entry, SPACES_BLOCK_END
        ));
        std::fs::write(&gitignore, new_content)?;
    }
    Ok(())
}

/// Remove an independent space path from the managed block.
pub fn remove_independent_gitignore(
    project_path: &Path,
    space_folder: &str,
) -> Result<(), AppError> {
    let gitignore = project_path.join(".gitignore");
    if !gitignore.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&gitignore)?;
    let entry = format!("{}/", space_folder);

    if let Some((before, block, after)) =
        extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END)
    {
        let new_block: String = block
            .lines()
            .filter(|l| l.trim() != entry)
            .map(|l| format!("{}\n", l))
            .collect();
        let new_content = format!(
            "{}{}\n{}{}\n{}",
            before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after
        );
        std::fs::write(&gitignore, new_content)?;
    }
    Ok(())
}

/// Extract content between start/end markers. Returns (before, block_content, after).
fn extract_block<'a>(
    content: &'a str,
    start: &str,
    end: &str,
) -> Option<(&'a str, &'a str, &'a str)> {
    let start_idx = content.find(start)?;
    let block_start = start_idx + start.len();
    // Skip the newline after the start marker
    let block_start = if content[block_start..].starts_with('\n') {
        block_start + 1
    } else {
        block_start
    };
    let end_idx = content[block_start..].find(end)?;
    let block_end = block_start + end_idx;
    let after_end = block_end + end.len();
    // Skip the newline after end marker
    let after_end = if content[after_end..].starts_with('\n') {
        after_end + 1
    } else {
        after_end
    };
    Some((
        &content[..start_idx],
        &content[block_start..block_end],
        &content[after_end..],
    ))
}

// --- Routed commit ---

/// Stage and commit a file, routing to the correct repo based on git type.
pub async fn commit_file_routed(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
    file_path: &str,
) -> Result<bool, AppError> {
    let git_type = detect_space_git_type(cli, project_path, space_path).await?;
    match git_type {
        SpaceGitType::Inline => {
            let space_folder = space_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let relative = format!("{}/{}", space_folder, file_path);
            add(cli, project_path, &relative).await?;
            let message = generate_commit_message(cli, project_path).await?;
            commit(cli, project_path, &message).await
        }
        SpaceGitType::Independent => commit_file(cli, space_path, file_path).await,
        SpaceGitType::Submodule => {
            let created = commit_file(cli, space_path, file_path).await?;
            if created {
                submodule_update_pointer(cli, project_path, space_path).await?;
            }
            Ok(created)
        }
    }
}

/// Stage all and commit, routing to the correct repo based on git type.
pub async fn commit_all_routed(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<bool, AppError> {
    let git_type = detect_space_git_type(cli, project_path, space_path).await?;
    match git_type {
        SpaceGitType::Inline => {
            let space_folder = space_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            add(cli, project_path, &space_folder).await?;
            let message = generate_commit_message(cli, project_path).await?;
            commit(cli, project_path, &message).await
        }
        SpaceGitType::Independent => commit_all(cli, space_path).await,
        SpaceGitType::Submodule => {
            let created = commit_all(cli, space_path).await?;
            if created {
                submodule_update_pointer(cli, project_path, space_path).await?;
            }
            Ok(created)
        }
    }
}

/// After committing inside a submodule, update the pointer in the parent repo.
pub async fn submodule_update_pointer(
    cli: &GitCli,
    root_path: &Path,
    space_path: &Path,
) -> Result<(), AppError> {
    let space_folder = space_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    add(cli, root_path, &space_folder).await?;
    commit(cli, root_path, &format!("Update {}", space_folder)).await?;
    Ok(())
}

/// Stage a specific path inside a repo and commit with a fixed message.
pub async fn commit_path_with_message(
    cli: &GitCli,
    repo_dir: &Path,
    path_in_repo: &str,
    message: &str,
) -> Result<bool, AppError> {
    add(cli, repo_dir, path_in_repo).await?;
    commit(cli, repo_dir, message).await
}

/// Current branch name (via `git rev-parse --abbrev-ref HEAD`).
pub async fn current_branch(cli: &GitCli, space_dir: &Path) -> Result<String, AppError> {
    let out = cli
        .exec(space_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr
        )));
    }
    Ok(out.stdout.trim().to_string())
}

/// Push with --set-upstream origin <current-branch>.
pub async fn push_set_upstream(cli: &GitCli, space_dir: &Path) -> Result<(), AppError> {
    let branch = current_branch(cli, space_dir).await?;
    let out = cli
        .exec(space_dir, &["push", "-u", "origin", &branch])
        .await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(stderr.to_string()));
        }
        if (stderr.contains("rejected")
            && (stderr.contains("fetch first")
                || stderr.contains("non-fast-forward")
                || stderr.contains("Updates were rejected")))
            || stderr.contains("Updates were rejected")
        {
            return Err(AppError::GitRemoteNotEmpty);
        }
        if stderr.contains("No configured push destination")
            || stderr.contains("does not appear to be a git repository")
        {
            return Err(AppError::GitNoRemote);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: String,
}

/// List commits on the current branch that are not in origin/<branch>.
pub async fn unpushed_commits(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<Vec<UnpushedCommit>, AppError> {
    let branch = match current_branch(cli, space_dir).await {
        Ok(b) => b,
        Err(_) => return Ok(Vec::new()),
    };

    // No origin at all → nothing can be "unpushed" (no push destination exists).
    let origin_check = cli
        .exec(space_dir, &["remote", "get-url", "origin"])
        .await?;
    if origin_check.exit_code != 0 {
        return Ok(Vec::new());
    }

    let upstream_ref = format!("refs/remotes/origin/{}", branch);
    let upstream_check = cli
        .exec(space_dir, &["rev-parse", "--verify", &upstream_ref])
        .await?;

    let format_arg = "--format=%h%x00%s%x00%an%x00%aI";

    let range_arg;
    let args: Vec<&str> = if upstream_check.exit_code == 0 {
        range_arg = format!("origin/{}..HEAD", branch);
        vec!["log", format_arg, &range_arg]
    } else {
        // Origin exists but upstream branch not fetched yet (pre-first-push).
        // All local commits on the current branch are unpushed.
        vec!["log", format_arg, "--max-count=50", "HEAD"]
    };

    let out = cli.exec(space_dir, &args).await?;
    if out.exit_code != 0 {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for line in out.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\u{0}').collect();
        if parts.len() >= 4 {
            result.push(UnpushedCommit {
                sha: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                timestamp: parts[3].to_string(),
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parses_status_z_with_spaces_cyrillic_untracked_modified_conflict_and_rename() {
        let output = concat!(
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 abc abc docs/space file.md\0",
            "u UU N... 100644 100644 100644 100644 a b c конфликт.md\0",
            "2 R. N... 100644 100644 100644 abc abc R100 renamed file.md\0old file.md\0",
            "? новый файл.md\0",
            "? .assets/\0",
        );

        let status = parse_status_porcelain_v2_z(output).unwrap();

        assert_eq!(status.branch, "main");
        assert_eq!(status.tracking.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert!(status.has_staged);
        assert!(status.has_unstaged);
        assert!(status.has_conflicts);
        assert_eq!(status.files.len(), 5);
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "docs/space file.md" && file.state == "modified" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "конфликт.md" && file.state == "conflict" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "renamed file.md" && file.state == "modified" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "новый файл.md" && file.state == "untracked" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == ".assets" && file.state == "untracked" })
        );
    }

    #[test]
    fn parses_name_status_z_including_rename_records() {
        let output = concat!(
            "A\0new file.md\0",
            "M\0папка/старый файл.md\0",
            "R100\0old name.md\0new name.md\0",
        );

        let records = parse_name_status_z(output).unwrap();

        assert_eq!(
            records,
            vec![
                NameStatusRecord {
                    status: 'A',
                    path: "new file.md".to_string()
                },
                NameStatusRecord {
                    status: 'M',
                    path: "папка/старый файл.md".to_string()
                },
                NameStatusRecord {
                    status: 'R',
                    path: "new name.md".to_string()
                },
            ]
        );
    }

    #[test]
    fn sensitive_collection_changes_use_generic_commit_messages() {
        let tmp = TempDir::new().unwrap();
        let contacts = tmp.path().join("contacts");
        std::fs::create_dir_all(&contacts).unwrap();
        std::fs::write(
            contacts.join("schema.yaml"),
            "columns:\n  - { name: Phone, type: phone }\nviews: []\n",
        )
        .unwrap();

        let records = vec![NameStatusRecord {
            status: 'M',
            path: "contacts/ivan-petrov.md".to_string(),
        }];

        assert!(staged_changes_touch_sensitive_collection(
            tmp.path(),
            &records
        ));
        assert_eq!(
            sensitive_commit_message(&records),
            "Update collection entry"
        );
        assert_eq!(
            sensitive_commit_message(&[
                NameStatusRecord {
                    status: 'M',
                    path: "contacts/ivan-petrov.md".to_string(),
                },
                NameStatusRecord {
                    status: 'A',
                    path: "contacts/jane.md".to_string(),
                },
            ]),
            "Update collection entries"
        );
    }

    #[test]
    fn parses_nul_path_output() {
        let paths = parse_nul_paths("docs/a file.md\0кириллица.md\0").unwrap();

        assert_eq!(paths, vec!["docs/a file.md", "кириллица.md"]);
    }
}
