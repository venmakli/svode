use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkHealthReport {
    pub ok: usize,
    pub restored: usize,
    pub errors: Vec<String>,
}

struct SymlinkMapping {
    source: &'static str,
    target: &'static str,
    is_dir: bool,
}

fn claude_mappings() -> Vec<SymlinkMapping> {
    vec![
        SymlinkMapping {
            source: "AGENTS.md",
            target: "CLAUDE.md",
            is_dir: false,
        },
        SymlinkMapping {
            source: "mcp.json",
            target: ".mcp.json",
            is_dir: false,
        },
        SymlinkMapping {
            source: "skills",
            target: ".claude/skills",
            is_dir: true,
        },
        SymlinkMapping {
            source: "agents",
            target: ".claude/agents",
            is_dir: true,
        },
    ]
}

fn get_mappings(cli_name: &str) -> Vec<SymlinkMapping> {
    match cli_name {
        "claude" => claude_mappings(),
        _ => vec![],
    }
}

/// Compute relative path from `from_dir` to `to_path`.
fn relative_path(from_dir: &Path, to_path: &Path) -> String {
    // from_dir is the parent directory of the symlink target
    // to_path is the source file/dir
    // We need to compute how to get from from_dir to to_path
    let from_components: Vec<_> = from_dir.components().collect();
    let to_components: Vec<_> = to_path.components().collect();

    // Find common prefix length
    let common = from_components
        .iter()
        .zip(to_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = from_components.len() - common;
    let mut parts: Vec<String> = (0..ups).map(|_| "..".to_string()).collect();
    for comp in &to_components[common..] {
        parts.push(comp.as_os_str().to_string_lossy().to_string());
    }

    parts.join("/")
}

/// Create symlinks from space root files to `.svode/` sources.
///
/// For each mapping, creates `space/{target}` as a symlink pointing to
/// `.svode/{source}` using a relative path. Skips if target already exists.
pub fn setup_cli_symlinks(space_path: &Path, cli_name: &str) -> Result<Vec<String>, AppError> {
    let mappings = get_mappings(cli_name);
    let mut created = Vec::new();

    for m in &mappings {
        let source = space_path.join(".svode").join(m.source);
        let target = space_path.join(m.target);

        // Skip if target already exists (symlink or real)
        if target.exists() || target.symlink_metadata().is_ok() {
            continue;
        }

        // Create parent dirs for target
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }

        // Compute relative path from target's parent to source
        let target_parent = target.parent().unwrap_or(space_path);
        let rel = relative_path(target_parent, &source);

        create_symlink(&rel, &target, m.is_dir)?;
        created.push(m.target.to_string());
    }

    Ok(created)
}

/// Remove symlinks created by `setup_cli_symlinks`.
///
/// Only removes targets that are actual symlinks (not real files/dirs).
/// Cleans up empty `.claude/` directory if applicable.
pub fn teardown_cli_symlinks(space_path: &Path, cli_name: &str) -> Result<(), AppError> {
    let mappings = get_mappings(cli_name);

    for m in &mappings {
        let target = space_path.join(m.target);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                fs::remove_file(&target)?;
            }
        }
    }

    // Clean up empty .claude/ dir
    let claude_dir = space_path.join(".claude");
    if claude_dir.exists() && claude_dir.is_dir() {
        if fs::read_dir(&claude_dir)?.next().is_none() {
            fs::remove_dir(&claude_dir)?;
        }
    }

    Ok(())
}

/// Check health of CLI symlinks and restore broken ones.
///
/// For each mapping:
/// - Correct symlink -> ok
/// - Missing or broken -> recreate, restored
/// - Real file/dir replaced symlink -> move contents to source, recreate, restored
pub fn health_check_symlinks(
    space_path: &Path,
    cli_name: &str,
) -> Result<SymlinkHealthReport, AppError> {
    let mappings = get_mappings(cli_name);
    let mut ok = 0usize;
    let mut restored = 0usize;
    let mut errors = Vec::new();

    for m in &mappings {
        let source = space_path.join(".svode").join(m.source);
        let target = space_path.join(m.target);

        let target_parent = target.parent().unwrap_or(space_path);
        let rel = relative_path(target_parent, &source);

        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                // Check if symlink points to the right place
                match fs::read_link(&target) {
                    Ok(link_target) if link_target.to_string_lossy() == rel => {
                        ok += 1;
                    }
                    Ok(_) | Err(_) => {
                        // Wrong target or broken — recreate
                        match recreate_symlink(&target, &rel, m.is_dir) {
                            Ok(()) => restored += 1,
                            Err(e) => errors.push(format!("{}: {}", m.target, e)),
                        }
                    }
                }
            }
            Ok(_meta) => {
                // Real file/dir replaced symlink — move contents to source, recreate
                match replace_real_with_symlink(&source, &target, &rel, m.is_dir) {
                    Ok(()) => restored += 1,
                    Err(e) => errors.push(format!("{}: {}", m.target, e)),
                }
            }
            Err(_) => {
                // Missing — create parent and symlink
                if let Some(parent) = target.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                match create_symlink(&rel, &target, m.is_dir) {
                    Ok(()) => restored += 1,
                    Err(e) => errors.push(format!("{}: {}", m.target, e)),
                }
            }
        }
    }

    Ok(SymlinkHealthReport {
        ok,
        restored,
        errors,
    })
}

fn recreate_symlink(target: &Path, rel: &str, is_dir: bool) -> Result<(), AppError> {
    fs::remove_file(target)?;
    create_symlink(rel, target, is_dir)?;
    Ok(())
}

fn replace_real_with_symlink(
    source: &Path,
    target: &Path,
    rel: &str,
    is_dir: bool,
) -> Result<(), AppError> {
    if is_dir {
        // Move directory contents to source
        if target.is_dir() {
            // Ensure source dir exists
            fs::create_dir_all(source)?;
            // Move contents
            for entry in fs::read_dir(target)? {
                let entry = entry?;
                let dest = source.join(entry.file_name());
                fs::rename(entry.path(), dest)?;
            }
            fs::remove_dir(target)?;
        } else {
            fs::remove_file(target)?;
        }
    } else {
        // Move file to source
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(target, source)?;
    }
    create_symlink(rel, target, is_dir)?;
    Ok(())
}

#[cfg(unix)]
fn create_symlink(rel: &str, target: &Path, _is_dir: bool) -> Result<(), std::io::Error> {
    std::os::unix::fs::symlink(rel, target)
}

#[cfg(windows)]
fn create_symlink(rel: &str, target: &Path, is_dir: bool) -> Result<(), std::io::Error> {
    if is_dir {
        std::os::windows::fs::symlink_dir(rel, target)
    } else {
        std::os::windows::fs::symlink_file(rel, target)
    }
}
