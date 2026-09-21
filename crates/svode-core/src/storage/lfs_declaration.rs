//! Portable declaration of where an `lfs-s3` repository keeps its LFS objects.
//!
//! The S3 transfer wiring lives in local Git config and cannot be made
//! portable: git-lfs ignores `lfs.standalonetransferagent` in `.lfsconfig`.
//! Without a committed declaration, a client lacking the wiring derives the
//! endpoint from the remote and silently uploads objects to the Git provider,
//! splitting the repository between provider LFS and S3. Svode therefore
//! commits `.lfsconfig` with `lfs.url` pointing at a reserved `.invalid` host:
//! the provider stops expecting its own objects, and a client without the agent
//! fails before any ref update instead of uploading elsewhere.
//!
//! Svode owns only its exact `lfs.url` value; every other byte of `.lfsconfig`
//! belongs to the user.

use std::path::Path;

use serde::Serialize;

use crate::git::cli::GitCli;

use super::config::AssetsStrategy;
use super::policy::StoragePolicyError;
use super::routes::{read_or_empty, write_or_remove};

pub const LFS_CONFIG_FILE: &str = ".lfsconfig";
/// Normative declaration value. The reserved `.invalid` TLD never resolves, so
/// a client without the Svode agent fails immediately without credentials
/// prompts or traffic to a foreign host.
pub const LFS_DECLARATION_URL: &str = "https://lfs-s3.svode.invalid/";

const DECLARATION_BLOCK: &str = "[lfs]\n\turl = https://lfs-s3.svode.invalid/\n";

/// Declaration state of one repository owner, as shown in Storage diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LfsDeclarationState {
    /// The working tree and `HEAD` both carry Svode's declaration.
    Published,
    /// The working tree carries the declaration, `HEAD` does not yet.
    Pending,
    /// The working tree has no `lfs.url`.
    Missing,
    /// The user set `lfs.url` to another value; Svode leaves it alone.
    Foreign,
}

/// Result of materializing or removing the declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfsDeclarationWrite {
    Unchanged,
    Written,
    Removed,
    /// A user-owned `lfs.url` with another value blocks the declaration.
    Foreign,
}

/// Bring `.lfsconfig` in `repo_dir` in line with `strategy`: `lfs-s3` gets the
/// declaration, every other strategy loses Svode's own value. A file that
/// becomes empty is removed; an unchanged file is not rewritten.
pub fn apply_lfs_declaration(
    repo_dir: &Path,
    strategy: AssetsStrategy,
) -> Result<LfsDeclarationWrite, std::io::Error> {
    let path = repo_dir.join(LFS_CONFIG_FILE);
    let current = read_or_empty(&path)?;
    let (next, outcome) = rewrite_lfs_declaration(&current, strategy == AssetsStrategy::LfsS3);
    if next != current {
        write_or_remove(&path, &next)?;
    }
    Ok(outcome)
}

/// Read the declaration state of `repo_dir` from its working tree and `HEAD`.
/// Performs one local Git read and no network access.
pub async fn lfs_declaration_state(
    cli: &GitCli,
    repo_dir: &Path,
) -> Result<LfsDeclarationState, StoragePolicyError> {
    let working_tree = read_or_empty(&repo_dir.join(LFS_CONFIG_FILE))?;
    match declared_lfs_url(&working_tree) {
        None => return Ok(LfsDeclarationState::Missing),
        Some(url) if url != LFS_DECLARATION_URL => return Ok(LfsDeclarationState::Foreign),
        Some(_) => {}
    }
    let head = cli
        .exec(repo_dir, &["cat-file", "-p", "HEAD:.lfsconfig"])
        .await?;
    let committed = head.exit_code == 0
        && declared_lfs_url(&head.stdout).as_deref() == Some(LFS_DECLARATION_URL);
    Ok(if committed {
        LfsDeclarationState::Published
    } else {
        LfsDeclarationState::Pending
    })
}

/// Pure `.lfsconfig` rewrite. With `declare`, append Svode's section unless an
/// `lfs.url` already exists; without it, drop only lines carrying Svode's exact
/// value and the `[lfs]` header they leave empty.
pub(crate) fn rewrite_lfs_declaration(
    contents: &str,
    declare: bool,
) -> (String, LfsDeclarationWrite) {
    if declare {
        return match declared_lfs_url(contents) {
            Some(url) if url == LFS_DECLARATION_URL => {
                (contents.to_string(), LfsDeclarationWrite::Unchanged)
            }
            Some(_) => (contents.to_string(), LfsDeclarationWrite::Foreign),
            None => {
                let mut next = contents.to_string();
                if !next.is_empty() && !next.ends_with('\n') {
                    next.push('\n');
                }
                next.push_str(DECLARATION_BLOCK);
                (next, LfsDeclarationWrite::Written)
            }
        };
    }

    let lines = parse_lines(contents);
    let mut keep = vec![true; lines.len()];
    for (index, line) in lines.iter().enumerate() {
        if line.url.as_deref() != Some(LFS_DECLARATION_URL) {
            continue;
        }
        keep[index] = false;
        let Some(header) = index.checked_sub(1) else {
            continue;
        };
        let section_now_empty = lines
            .get(index + 1)
            .is_none_or(|next| matches!(next.kind, LineKind::Header));
        if lines[header].kind == LineKind::Header && lines[header].lfs && section_now_empty {
            keep[header] = false;
        }
    }
    if keep.iter().all(|kept| *kept) {
        return (contents.to_string(), LfsDeclarationWrite::Unchanged);
    }
    let next: String = lines
        .iter()
        .zip(keep)
        .filter(|(_, kept)| *kept)
        .map(|(line, _)| line.raw)
        .collect();
    (next, LfsDeclarationWrite::Removed)
}

/// Effective `lfs.url` of a git-config formatted file (last value wins, as in
/// Git). Only the plain `[lfs]` section counts; subsections are other keys.
pub(crate) fn declared_lfs_url(contents: &str) -> Option<String> {
    parse_lines(contents)
        .into_iter()
        .filter_map(|line| line.url)
        .next_back()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineKind {
    Header,
    Other,
}

struct ConfigLine<'a> {
    raw: &'a str,
    kind: LineKind,
    /// For a header: whether it opens the plain `[lfs]` section.
    lfs: bool,
    /// For an entry inside `[lfs]`: the value of its `url` key.
    url: Option<String>,
}

fn parse_lines(contents: &str) -> Vec<ConfigLine<'_>> {
    let mut in_lfs = false;
    contents
        .split_inclusive('\n')
        .map(|raw| {
            let trimmed = raw.trim();
            if let Some(rest) = trimmed.strip_prefix('[') {
                let name = rest.split(']').next().unwrap_or_default().trim();
                in_lfs = name.eq_ignore_ascii_case("lfs");
                return ConfigLine {
                    raw,
                    kind: LineKind::Header,
                    lfs: in_lfs,
                    url: None,
                };
            }
            let url = in_lfs.then(|| entry_url(trimmed)).flatten();
            ConfigLine {
                raw,
                kind: LineKind::Other,
                lfs: false,
                url,
            }
        })
        .collect()
}

fn entry_url(line: &str) -> Option<String> {
    if line.starts_with('#') || line.starts_with(';') {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    if !key.trim().eq_ignore_ascii_case("url") {
        return None;
    }
    Some(config_value(value))
}

/// Decode a git-config value: surrounding whitespace, double quotes and a
/// trailing comment outside quotes.
fn config_value(raw: &str) -> String {
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = raw.trim().chars();
    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' => {
                if let Some(escaped) = chars.next() {
                    value.push(escaped);
                }
            }
            '#' | ';' if !quoted => break,
            _ => value.push(character),
        }
    }
    value.trim().to_string()
}
