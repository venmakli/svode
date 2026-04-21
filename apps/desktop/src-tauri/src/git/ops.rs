use std::path::Path;

use serde::Serialize;

use super::cli::GitCli;
use crate::space::types::SpaceGitType;
use crate::AppError;

const GITIGNORE_TEMPLATE: &str = "# CombAI local files
.combai/local.json
.combai/*.db
.combai/*.db-wal
.combai/*.db-shm
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

/// Set or add the `origin` remote URL.
pub async fn set_remote(
    cli: &GitCli,
    space_dir: &Path,
    url: &str,
) -> Result<(), AppError> {
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
    let _ = commit(cli, space_dir, "Scaffold .combai").await?;

    tracing::info!("Initialized git repo at {}", space_dir.display());
    Ok(())
}

/// Get space git status by parsing `git status --porcelain=v2 --branch`.
pub async fn status(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<GitStatus, AppError> {
    let out = cli
        .exec(space_dir, &["status", "--porcelain=v2", "--branch"])
        .await?;

    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git status failed: {}",
            out.stderr
        )));
    }

    let mut branch = String::from("HEAD");
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut has_staged = false;
    let mut has_unstaged = false;
    let mut has_conflicts = false;
    let mut tracking: Option<String> = None;
    let mut files: Vec<FileGitStatus> = Vec::new();

    for line in out.stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            tracking = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: +N -M
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("u ") {
            // Unmerged entry: "u XY sub m1 m2 m3 h1 h2 h3 path"
            has_conflicts = true;
            if let Some(path) = line.split_whitespace().nth(10) {
                files.push(FileGitStatus {
                    path: path.to_string(),
                    state: "conflict".to_string(),
                });
            }
        } else if line.starts_with("1 ") {
            // Changed entry: "1 XY sub mH mI mW hH hI path"
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                if xy.len() >= 2 {
                    let x = xy.as_bytes()[0];
                    let y = xy.as_bytes()[1];
                    if x != b'.' {
                        has_staged = true;
                    }
                    if y != b'.' {
                        has_unstaged = true;
                    }
                }
                files.push(FileGitStatus {
                    path: parts[8].to_string(),
                    state: "modified".to_string(),
                });
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied: "2 XY sub mH mI mW hH hI Xscore path\tsource"
            let parts: Vec<&str> = line.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1];
                if xy.len() >= 2 {
                    let x = xy.as_bytes()[0];
                    let y = xy.as_bytes()[1];
                    if x != b'.' {
                        has_staged = true;
                    }
                    if y != b'.' {
                        has_unstaged = true;
                    }
                }
                let path_field = parts[9];
                let path = path_field.split('\t').next().unwrap_or(path_field);
                files.push(FileGitStatus {
                    path: path.to_string(),
                    state: "modified".to_string(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            // Untracked file
            has_unstaged = true;
            files.push(FileGitStatus {
                path: rest.to_string(),
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

/// Stage a specific file.
pub async fn add(
    cli: &GitCli,
    space_dir: &Path,
    path: &str,
) -> Result<(), AppError> {
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
pub async fn add_all(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<(), AppError> {
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
pub async fn commit(
    cli: &GitCli,
    space_dir: &Path,
    message: &str,
) -> Result<bool, AppError> {
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
pub async fn commit_all(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<bool, AppError> {
    add_all(cli, space_dir).await?;
    let message = generate_commit_message(cli, space_dir).await?;
    let created = commit(cli, space_dir, &message).await?;
    if created {
        tracing::info!("Auto-committed all in {}", space_dir.display());
    }
    Ok(created)
}

/// Generate a commit message based on staged changes.
pub async fn generate_commit_message(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<String, AppError> {
    let out = cli
        .exec(space_dir, &["diff", "--cached", "--stat"])
        .await?;

    if out.stdout.trim().is_empty() {
        return Ok("Update space".to_string());
    }

    let mut added: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();

    // Also check diff --cached --name-status for accurate categorization
    let name_status = cli
        .exec(space_dir, &["diff", "--cached", "--name-status"])
        .await?;

    for line in name_status.stdout.lines() {
        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0].trim();
        let file = parts[1]
            .rsplit('/')
            .next()
            .unwrap_or(parts[1])
            .to_string();

        match status.chars().next() {
            Some('A') => added.push(file),
            Some('M') => modified.push(file),
            Some('D') => deleted.push(file),
            Some('R') => modified.push(file),
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

/// Get list of files changed since last pull.
pub async fn diff_after_pull(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<Vec<String>, AppError> {
    let out = cli
        .exec(
            space_dir,
            &["diff", "--name-only", "HEAD@{1}", "HEAD"],
        )
        .await?;

    if out.exit_code != 0 {
        // HEAD@{1} may not exist if no reflog yet
        return Ok(Vec::new());
    }

    Ok(out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

// --- Per-space git type ---

/// Detect the git type of a space relative to its project.
pub async fn detect_space_git_type(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<SpaceGitType, AppError> {
    let out = cli.exec(space_path, &["rev-parse", "--git-dir"]).await?;
    if out.exit_code != 0 {
        return Ok(SpaceGitType::Inline);
    }

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

const INLINE_BLOCK_START: &str = "# combai:inline:start";
const INLINE_BLOCK_END: &str = "# combai:inline:end";
const INLINE_BLOCK_CONTENT: &str = "*/.combai/local.json\n*/.combai/*.db\n*/.combai/*.db-*";

const SPACES_BLOCK_START: &str = "# combai:spaces:start";
const SPACES_BLOCK_END: &str = "# combai:spaces:end";

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

    if let Some((before, block, after)) = extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END) {
        if block.lines().any(|l| l.trim() == entry) {
            return Ok(());
        }
        let mut new_block = block.to_string();
        if !new_block.is_empty() && !new_block.ends_with('\n') {
            new_block.push('\n');
        }
        new_block.push_str(&entry);
        new_block.push('\n');
        let new_content = format!("{}{}\n{}{}\n{}", before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after);
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
pub fn remove_independent_gitignore(project_path: &Path, space_folder: &str) -> Result<(), AppError> {
    let gitignore = project_path.join(".gitignore");
    if !gitignore.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&gitignore)?;
    let entry = format!("{}/", space_folder);

    if let Some((before, block, after)) = extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END) {
        let new_block: String = block
            .lines()
            .filter(|l| l.trim() != entry)
            .map(|l| format!("{}\n", l))
            .collect();
        let new_content = format!("{}{}\n{}{}\n{}", before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after);
        std::fs::write(&gitignore, new_content)?;
    }
    Ok(())
}

/// Extract content between start/end markers. Returns (before, block_content, after).
fn extract_block<'a>(content: &'a str, start: &str, end: &str) -> Option<(&'a str, &'a str, &'a str)> {
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
    Some((&content[..start_idx], &content[block_start..block_end], &content[after_end..]))
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
        SpaceGitType::Independent => {
            commit_file(cli, space_path, file_path).await
        }
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
        SpaceGitType::Independent => {
            commit_all(cli, space_path).await
        }
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

/// Commit routed with an explicit message.
pub async fn commit_all_routed_with_message(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
    message: &str,
) -> Result<bool, AppError> {
    let git_type = detect_space_git_type(cli, project_path, space_path).await?;
    match git_type {
        SpaceGitType::Inline => {
            let space_folder = space_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            // For root-level ops (project_path == space_path) stage everything.
            if space_path == project_path {
                add_all(cli, project_path).await?;
            } else {
                add(cli, project_path, &space_folder).await?;
            }
            commit(cli, project_path, message).await
        }
        SpaceGitType::Independent => {
            add_all(cli, space_path).await?;
            commit(cli, space_path, message).await
        }
        SpaceGitType::Submodule => {
            add_all(cli, space_path).await?;
            let created = commit(cli, space_path, message).await?;
            if created {
                submodule_update_pointer(cli, project_path, space_path).await?;
            }
            Ok(created)
        }
    }
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
