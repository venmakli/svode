use std::path::Path;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::cli::GitCli;
use crate::{AppError, process};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub space_path: String,
    pub phase: String,
    pub percent: u32,
}

/// Clone a repository while streaming `--progress` output to the frontend
/// via the `clone:progress` Tauri event.
pub async fn clone_with_progress(
    cli: &GitCli,
    app: &AppHandle,
    url: &str,
    target_dir: &Path,
) -> Result<(), AppError> {
    let target_str = target_dir
        .to_str()
        .ok_or_else(|| AppError::General("Invalid target path".to_string()))?;

    // Fail early: git clone would error out anyway, and this gives us a
    // clean, user-friendly error instead of raw git stderr.
    if target_dir.exists() {
        return Err(AppError::FileAlreadyExists(target_str.to_string()));
    }

    // Re-build the command manually since we need stdio piping.
    //
    // `GIT_LFS_SKIP_SMUDGE=1` keeps LFS pointers as plain text on clone — we
    // defer the actual content fetch to the explicit Repair LFS gesture or
    // post-clone probe in `storage/lfs.rs`. Without this, a missing/wrong
    // LFS credential would fail the entire clone.
    let mut cmd = Command::new(cli.git_path());
    process::hide_tokio_window(&mut cmd);
    let mut child = cmd
        .args([
            "-c",
            "core.quotePath=false",
            "clone",
            "--progress",
            "--",
            url,
            target_str,
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::GitCommandFailed("Missing stderr".into()))?;

    let space_path = target_str.to_string();
    let app_clone = app.clone();
    let parser = tokio::spawn(async move {
        // Byte-level loop: git --progress writes in-place updates terminated
        // with '\r' (no '\n'), so a line-based reader would buffer everything
        // until the final newline. We flush the accumulator on EITHER '\r'
        // or '\n' so each 1% tick reaches the frontend immediately.
        let mut reader = stderr;
        let mut chunk = [0u8; 256];
        let mut line = Vec::<u8>::new();
        let mut collected_stderr = String::new();
        loop {
            let n = match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            for &byte in &chunk[..n] {
                if byte == b'\r' || byte == b'\n' {
                    if !line.is_empty() {
                        let text = String::from_utf8_lossy(&line).into_owned();
                        collected_stderr.push_str(&text);
                        collected_stderr.push('\n');
                        if let Some((phase, percent)) = parse_progress(text.trim()) {
                            let _ = app_clone.emit(
                                "clone:progress",
                                CloneProgress {
                                    space_path: space_path.clone(),
                                    phase,
                                    percent,
                                },
                            );
                        }
                        line.clear();
                    }
                } else {
                    line.push(byte);
                }
            }
        }
        if !line.is_empty() {
            let text = String::from_utf8_lossy(&line).into_owned();
            collected_stderr.push_str(&text);
        }
        collected_stderr
    });

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::GitCommandFailed(format!("git clone wait failed: {e}")))?;
    let stderr_text = parser.await.unwrap_or_default();

    if !status.success() {
        let trimmed = stderr_text.trim().to_string();
        if trimmed.contains("Authentication")
            || trimmed.contains("could not read Username")
            || trimmed.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(trimmed));
        }
        return Err(AppError::GitCommandFailed(format!(
            "git clone failed: {trimmed}"
        )));
    }

    let config_out = cli
        .exec(target_dir, &["config", "core.quotePath", "false"])
        .await?;
    if config_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git config core.quotePath failed: {}",
            config_out.stderr.trim()
        )));
    }

    Ok(())
}

/// Run `git submodule add --progress <url> <space_folder>` from the project
/// root while streaming progress to the frontend.
pub async fn submodule_add_with_progress(
    cli: &GitCli,
    app: &AppHandle,
    project_path: &Path,
    url: &str,
    space_folder: &str,
) -> Result<(), AppError> {
    let target_str = project_path
        .join(space_folder)
        .to_str()
        .unwrap_or_default()
        .to_string();

    let mut cmd = Command::new(cli.git_path());
    process::hide_tokio_window(&mut cmd);
    let mut child = cmd
        .args([
            "-c",
            "core.quotePath=false",
            "submodule",
            "add",
            "--progress",
            "--",
            url,
            space_folder,
        ])
        .current_dir(project_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::GitCommandFailed("Missing stderr".into()))?;

    let space_path = target_str;
    let app_clone = app.clone();
    let parser = tokio::spawn(async move {
        let mut reader = stderr;
        let mut chunk = [0u8; 256];
        let mut line = Vec::<u8>::new();
        let mut collected_stderr = String::new();
        loop {
            let n = match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            for &byte in &chunk[..n] {
                if byte == b'\r' || byte == b'\n' {
                    if !line.is_empty() {
                        let text = String::from_utf8_lossy(&line).into_owned();
                        collected_stderr.push_str(&text);
                        collected_stderr.push('\n');
                        if let Some((phase, percent)) = parse_progress(text.trim()) {
                            let _ = app_clone.emit(
                                "clone:progress",
                                CloneProgress {
                                    space_path: space_path.clone(),
                                    phase,
                                    percent,
                                },
                            );
                        }
                        line.clear();
                    }
                } else {
                    line.push(byte);
                }
            }
        }
        if !line.is_empty() {
            let text = String::from_utf8_lossy(&line).into_owned();
            collected_stderr.push_str(&text);
        }
        collected_stderr
    });

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::GitCommandFailed(format!("git submodule add wait failed: {e}")))?;
    let stderr_text = parser.await.unwrap_or_default();

    if !status.success() {
        let trimmed = stderr_text.trim().to_string();
        if trimmed.contains("Authentication")
            || trimmed.contains("could not read Username")
            || trimmed.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(trimmed));
        }
        return Err(AppError::GitCommandFailed(format!(
            "git submodule add failed: {trimmed}"
        )));
    }

    let target_dir = project_path.join(space_folder);
    let config_out = cli
        .exec(&target_dir, &["config", "core.quotePath", "false"])
        .await?;
    if config_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git config core.quotePath failed: {}",
            config_out.stderr.trim()
        )));
    }

    Ok(())
}

/// Parse a single git --progress line, e.g.
///   "Receiving objects:  45% (450/1000), 1.2 MiB"
/// → ("Receiving objects", 45)
fn parse_progress(line: &str) -> Option<(String, u32)> {
    let (phase, rest) = line.split_once(':')?;
    let percent_str = rest.trim_start();
    let percent_str = percent_str.split('%').next()?.trim();
    let percent: u32 = percent_str.parse().ok()?;
    Some((phase.trim().to_string(), percent))
}
