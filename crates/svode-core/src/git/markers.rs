//! Git conflict marker lines: the marker size of a path and the check for
//! marker lines left in a file.

use std::path::Path;

use super::GitError;
use super::cli::GitCli;

/// Marker size Git uses when a path sets no valid `conflict-marker-size`.
pub const DEFAULT_MARKER_SIZE: usize = 7;

/// Size of the conflict markers Git writes for `file`: its
/// `conflict-marker-size` attribute in the repository holding it when that is a
/// positive integer, otherwise [`DEFAULT_MARKER_SIZE`], as Git merges. A file
/// outside any repository gets the default.
pub async fn marker_size(cli: &GitCli, file: &Path) -> Result<usize, GitError> {
    let (Some(dir), Some(name)) = (file.parent(), file.file_name()) else {
        return Err(GitError::PathNotAccessible(file.display().to_string()));
    };
    let name = name
        .to_str()
        .ok_or_else(|| GitError::PathNotAccessible(file.display().to_string()))?;
    // Run beside the file so a nested repository answers for its own paths.
    let out = cli
        .exec(
            dir,
            &["check-attr", "-z", "conflict-marker-size", "--", name],
        )
        .await?;
    if out.exit_code != 0 {
        if out.stderr.contains("not a git repository") {
            return Ok(DEFAULT_MARKER_SIZE);
        }
        return Err(GitError::GitCommandFailed(format!(
            "git check-attr failed: {}",
            out.stderr.trim()
        )));
    }
    match out.stdout.split_terminator('\0').collect::<Vec<_>>()[..] {
        [_, "conflict-marker-size", value] => Ok(parse_marker_size(value)),
        _ => Err(GitError::GitCommandFailed(
            "git check-attr returned malformed NUL-delimited output".into(),
        )),
    }
}

/// `unspecified`, `set`, `unset` and anything but a positive integer fall back
/// to the default, as in Git.
fn parse_marker_size(value: &str) -> usize {
    match value.parse::<i32>() {
        Ok(size) if size > 0 => size as usize,
        _ => DEFAULT_MARKER_SIZE,
    }
}

/// Whether `content` has a `<`, `|` or `>` marker line of `size` under any line
/// endings. A lone `=` line is valid Markdown, so it does not count.
pub fn has_marker_lines(content: &[u8], size: usize) -> bool {
    content.split_inclusive(|byte| *byte == b'\n').any(|line| {
        // As Git reads lines: a `\r` belongs to the line ending only before `\n`.
        let line = line
            .strip_suffix(b"\r\n")
            .or_else(|| line.strip_suffix(b"\n"))
            .unwrap_or(line);
        is_marker_line(line, b'<', size, false)
            || is_marker_line(line, b'|', size, true)
            || is_marker_line(line, b'>', size, false)
    })
}

/// `size` copies of `marker`, then a space and a label, or the end of the line
/// when the marker may stand alone.
fn is_marker_line(line: &[u8], marker: u8, size: usize, alone: bool) -> bool {
    line.len() >= size
        && line[..size].iter().all(|byte| *byte == marker)
        && match line.get(size) {
            None => alone,
            Some(next) => *next == b' ',
        }
}

#[cfg(test)]
#[path = "markers_tests.rs"]
mod tests;
