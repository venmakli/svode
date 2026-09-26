//! Skill links: `~/.claude/skills/svode` (the whole plugin for Claude Code)
//! and `~/.agents/skills/svode` (the skill shared by agents that read that
//! directory). A link that points exactly at the stable payload is Svode's;
//! anything else at that path belongs to somebody else.

use std::fs;
use std::path::Path;

use crate::error::ConnectError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Link {
    Absent,
    Managed,
    Foreign,
}

pub(crate) fn state(path: &Path, target: &Path) -> Link {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Link::Absent,
        Ok(meta)
            if meta.file_type().is_symlink()
                && fs::read_link(path).is_ok_and(|current| current == target) =>
        {
            Link::Managed
        }
        _ => Link::Foreign,
    }
}

pub(crate) fn conflict(path: &Path) -> ConnectError {
    ConnectError::new(
        "SKILL_CONFLICT",
        format!(
            "{} already exists and is not the Svode skill; Svode did not replace it",
            path.display()
        ),
    )
}

/// Creates the link unless it is already Svode's; returns whether it wrote.
pub(crate) fn ensure(path: &Path, target: &Path) -> Result<bool, ConnectError> {
    match state(path, target) {
        Link::Managed => return Ok(false),
        Link::Foreign => return Err(conflict(path)),
        Link::Absent => {}
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| ConnectError::io(parent, error))?;
    }
    match symlink(target, path) {
        Ok(()) => Ok(true),
        // Created meanwhile by another process: fine when it is Svode's.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            match state(path, target) {
                Link::Managed => Ok(false),
                _ => Err(conflict(path)),
            }
        }
        Err(error) => Err(ConnectError::io(path, error)),
    }
}

/// Removes the link only while it is Svode's; returns whether it removed.
pub(crate) fn remove(path: &Path, target: &Path) -> Result<bool, ConnectError> {
    if state(path, target) != Link::Managed {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ConnectError::io(path, error)),
    }
}

#[cfg(unix)]
fn symlink(target: &Path, path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "skill links are supported on macOS and Linux only",
    ))
}
