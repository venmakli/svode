//! Kinds of conflicted paths (module 01, 1.F): one vocabulary for the stop
//! «Конфликт с правками коллег» of the in-memory preflight (1.B) and for the
//! unresolved paths of a merge. A kind follows the index stages of the path
//! and whether Git merged it as text, not its extension; a Page is told
//! apart by where its conflict markers stand.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::cli::GitCli;
use super::markers;
use super::service_merge::{self, ConflictedPath, StageEntry};

/// Git decides a side is binary by a NUL byte among its first bytes.
const BINARY_PROBE: usize = 8000;
/// A merged Page larger than this is not read for the place of its markers.
const MAX_PAGE: usize = 4 * 1024 * 1024;
/// The first line of a Git LFS pointer file.
pub(crate) const LFS_POINTER: &[u8] = b"version https://git-lfs.github.com/spec/v1";

/// What kind of conflict a path holds, as the person resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    /// Both sides changed the text of a Page.
    PageText,
    /// Both sides changed the properties (frontmatter) of a Page.
    PageProperties,
    /// Both sides changed a text file outside a Page.
    Text,
    /// Both sides changed a file Git does not merge as text, LFS included.
    Binary,
    /// One side changed the file, the other deleted it.
    ModifyDelete,
    /// Both sides added a file at the path.
    AddAdd,
    /// Both sides renamed the same file differently.
    RenameRename,
    /// One side renamed the file, the other deleted it.
    RenameDelete,
    /// The Space pointer (gitlink) of the project.
    SpacePointer,
}

/// A conflicted path and its kind; the path is relative to the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathConflict {
    pub path: String,
    pub kind: ConflictKind,
    /// The other paths of the same conflict, resolved with it: the original
    /// name and the incoming name of a rename/rename conflict, whose entry
    /// stands at my name.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<String>,
}

impl PathConflict {
    /// Whether the conflict holds `path`, at its entry or among [`Self::also`].
    pub fn holds(&self, path: &str) -> bool {
        self.path == path || self.also.iter().any(|other| other == path)
    }
}

/// The paths of one rename/rename conflict: a file of the merge base that my
/// side and the incoming side renamed differently. Each name holds one
/// index stage: the original the base, mine my side, the incoming one theirs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameGroup {
    pub original: String,
    pub ours: String,
    pub theirs: String,
}

impl RenameGroup {
    pub fn holds(&self, path: &str) -> bool {
        self.original == path || self.ours == path || self.theirs == path
    }
}

/// What decides a kind besides the stages of the path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KindFacts {
    /// Git did not merge the sides as text.
    pub binary: bool,
    /// The path takes part in a rename conflict:
    /// [`ConflictKind::RenameRename`] or [`ConflictKind::RenameDelete`].
    pub rename: Option<ConflictKind>,
    /// Conflict markers of the merged Page stand in its frontmatter.
    pub frontmatter: bool,
}

/// The kind of `conflict` by its stages and `facts`.
pub fn classify(conflict: &ConflictedPath, facts: KindFacts) -> ConflictKind {
    if conflict.sides().any(StageEntry::is_gitlink) {
        return ConflictKind::SpacePointer;
    }
    if let Some(rename) = facts.rename {
        return rename;
    }
    match (&conflict.base, &conflict.ours, &conflict.theirs) {
        (None, Some(_), Some(_)) => ConflictKind::AddAdd,
        (Some(_), Some(_), Some(_)) if facts.binary => ConflictKind::Binary,
        (Some(_), Some(_), Some(_)) if super::versions::is_page(&conflict.path) => {
            if facts.frontmatter {
                ConflictKind::PageProperties
            } else {
                ConflictKind::PageText
            }
        }
        (Some(_), Some(_), Some(_)) => ConflictKind::Text,
        _ => ConflictKind::ModifyDelete,
    }
}

/// The unresolved paths of the index of the repository `repo` (its top
/// level) with their kinds, in the order of the index; the paths are
/// relative to `repo`. The kinds follow the index stages: a path with one
/// stage is a side of a rename/rename conflict, a path with the base and one
/// side that the merge base lacks is the renamed side of a rename/delete
/// conflict (known only while a merge is in progress); a side Git does not
/// merge as text — a NUL byte among its first bytes, an LFS pointer or the
/// `merge` attribute unset — makes the path binary; where the markers of a
/// Page stand in its working file tells its properties from its text.
pub async fn unresolved(cli: &GitCli, repo: &Path) -> Result<Vec<PathConflict>, GitError> {
    let conflicts = service_merge::index_conflicts(cli, repo).await?;
    if conflicts.is_empty() {
        return Ok(Vec::new());
    }
    let absent = absent_from_merge_base(cli, repo, &conflicts).await?;
    let unmergeable = merge_unset(cli, repo, &conflicts).await?;
    let mut facts = Vec::with_capacity(conflicts.len());
    for conflict in &conflicts {
        let stages = [&conflict.base, &conflict.ours, &conflict.theirs]
            .iter()
            .filter(|stage| stage.is_some())
            .count();
        let rename = if stages == 1 {
            Some(ConflictKind::RenameRename)
        } else if conflict.base.is_some()
            && (conflict.ours.is_none() || conflict.theirs.is_none())
            && absent.contains(conflict.path.as_str())
        {
            Some(ConflictKind::RenameDelete)
        } else {
            None
        };
        let binary = conflict.ours.is_some()
            && conflict.theirs.is_some()
            && (unmergeable.contains(conflict.path.as_str())
                || binary_side(cli, repo, conflict).await?);
        facts.push(KindFacts {
            binary,
            rename,
            frontmatter: false,
        });
    }
    let pages: Vec<String> = conflicts
        .iter()
        .zip(&facts)
        .filter(|(conflict, facts)| classify(conflict, **facts) == ConflictKind::PageText)
        .map(|(conflict, _)| conflict.path.clone())
        .collect();
    let sizes = markers::marker_sizes(cli, repo, &pages).await?;
    for (conflict, facts) in conflicts.iter().zip(facts.iter_mut()) {
        let Some(size) = sizes.get(&conflict.path) else {
            continue;
        };
        if let Some(content) = read_page(&repo.join(&conflict.path))? {
            facts.frontmatter = markers_in_frontmatter(&content, *size);
        }
    }
    let kinds: Vec<PathConflict> = conflicts
        .iter()
        .zip(facts)
        .map(|(conflict, facts)| PathConflict {
            path: conflict.path.clone(),
            kind: classify(conflict, facts),
            also: Vec::new(),
        })
        .collect();
    let groups = if kinds
        .iter()
        .any(|conflict| conflict.kind == ConflictKind::RenameRename)
    {
        rename_groups(cli, repo, &conflicts).await?
    } else {
        Vec::new()
    };
    Ok(group_renames(kinds, &groups))
}

/// `kinds` with the paths of every rename/rename conflict of `groups` in one
/// entry at my name; a path of no group keeps its own entry.
fn group_renames(kinds: Vec<PathConflict>, groups: &[RenameGroup]) -> Vec<PathConflict> {
    kinds
        .into_iter()
        .filter_map(|mut conflict| {
            if conflict.kind != ConflictKind::RenameRename {
                return Some(conflict);
            }
            match groups.iter().find(|group| group.holds(&conflict.path)) {
                Some(group) if group.ours == conflict.path => {
                    conflict.also = vec![group.original.clone(), group.theirs.clone()];
                    Some(conflict)
                }
                Some(_) => None,
                None => Some(conflict),
            }
        })
        .collect()
}

/// The rename/rename conflicts among `conflicts` of a merge in progress in
/// `repo`, paired by the renames each side made since the merge base, as
/// Git found them in the merge. A path the renames do not pair stays out of
/// every group; without a merge nothing is paired.
pub async fn rename_groups(
    cli: &GitCli,
    repo: &Path,
    conflicts: &[ConflictedPath],
) -> Result<Vec<RenameGroup>, GitError> {
    let only = |stage: fn(&ConflictedPath) -> bool| -> HashSet<&str> {
        conflicts
            .iter()
            .filter(|conflict| stage(conflict))
            .map(|conflict| conflict.path.as_str())
            .collect()
    };
    let originals = only(|c| c.base.is_some() && c.ours.is_none() && c.theirs.is_none());
    let ours = only(|c| c.base.is_none() && c.ours.is_some() && c.theirs.is_none());
    let theirs = only(|c| c.base.is_none() && c.ours.is_none() && c.theirs.is_some());
    if originals.is_empty() || ours.is_empty() || theirs.is_empty() {
        return Ok(Vec::new());
    }
    let out = cli
        .exec(repo, &["merge-base", "HEAD", "MERGE_HEAD"])
        .await?;
    let base = out.stdout.lines().next().unwrap_or("").trim().to_owned();
    if out.exit_code != 0 || base.is_empty() {
        return Ok(Vec::new());
    }
    let mine = renames(cli, repo, &base, "HEAD").await?;
    let incoming = renames(cli, repo, &base, "MERGE_HEAD").await?;
    Ok(originals
        .into_iter()
        .filter_map(|original| {
            let ours_name = mine
                .iter()
                .find(|(from, to)| from == original && ours.contains(to.as_str()))?;
            let theirs_name = incoming
                .iter()
                .find(|(from, to)| from == original && theirs.contains(to.as_str()))?;
            Some(RenameGroup {
                original: original.to_owned(),
                ours: ours_name.1.clone(),
                theirs: theirs_name.1.clone(),
            })
        })
        .collect())
}

/// The renames between the commits `from` and `to`, as `(old, new)` paths.
async fn renames(
    cli: &GitCli,
    repo: &Path,
    from: &str,
    to: &str,
) -> Result<Vec<(String, String)>, GitError> {
    let out = cli
        .exec(
            repo,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-relative",
                "--name-status",
                "-z",
                "--find-renames",
                "--diff-filter=R",
                from,
                to,
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git diff failed: {}",
            out.stderr.trim()
        )));
    }
    let fields: Vec<&str> = out.stdout.split_terminator('\0').collect();
    Ok(fields
        .chunks_exact(3)
        .filter(|record| record[0].starts_with('R'))
        .map(|record| (record[1].to_owned(), record[2].to_owned()))
        .collect())
}

/// [`unresolved`] of the repository holding `requested`, for the paths under
/// it and relative to it, as its status names them.
pub async fn unresolved_under(
    cli: &GitCli,
    requested: &Path,
) -> Result<Vec<PathConflict>, GitError> {
    let (repo, prefix) = super::conflict_file::repository_of(cli, requested).await?;
    let under = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    Ok(unresolved(cli, &repo)
        .await?
        .into_iter()
        .filter_map(|conflict| {
            let path = conflict.path.strip_prefix(&under)?.to_owned();
            let also = conflict
                .also
                .iter()
                .filter_map(|other| other.strip_prefix(&under).map(str::to_owned))
                .collect();
            Some(PathConflict {
                path,
                also,
                ..conflict
            })
        })
        .collect())
}

/// The paths among `conflicts` with a base stage and one side that the
/// merge base of a merge in progress does not hold. Without a merge
/// nothing is known, so nothing is absent.
async fn absent_from_merge_base(
    cli: &GitCli,
    repo: &Path,
    conflicts: &[ConflictedPath],
) -> Result<HashSet<String>, GitError> {
    let candidates: Vec<&ConflictedPath> = conflicts
        .iter()
        .filter(|conflict| {
            conflict.base.is_some() && (conflict.ours.is_none() || conflict.theirs.is_none())
        })
        .collect();
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    let out = cli
        .exec(repo, &["merge-base", "HEAD", "MERGE_HEAD"])
        .await?;
    let base = out.stdout.lines().next().unwrap_or("").trim();
    if out.exit_code != 0 || base.is_empty() {
        return Ok(HashSet::new());
    }
    // One `<base>:<path>` object name per line; a path with a newline cannot
    // be named so and stays a modify/delete conflict.
    let named: Vec<&ConflictedPath> = candidates
        .into_iter()
        .filter(|conflict| !conflict.path.contains('\n'))
        .collect();
    let input: String = named
        .iter()
        .map(|conflict| format!("{base}:{}\n", conflict.path))
        .collect();
    let out = cli
        .exec_with_input(
            repo,
            &["cat-file", "--batch-check=%(objecttype)"],
            &[],
            input.as_bytes(),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git cat-file failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(named
        .iter()
        .zip(out.stdout.lines())
        .filter(|(_, line)| line.ends_with(" missing"))
        .map(|(conflict, _)| conflict.path.clone())
        .collect())
}

/// The paths among `conflicts` whose `merge` attribute is unset, as the
/// `binary` macro sets it: Git keeps a side of them instead of merging.
async fn merge_unset(
    cli: &GitCli,
    repo: &Path,
    conflicts: &[ConflictedPath],
) -> Result<HashSet<String>, GitError> {
    let paths: Vec<String> = conflicts
        .iter()
        .map(|conflict| conflict.path.clone())
        .collect();
    let out = cli
        .exec_with_input(
            repo,
            &["check-attr", "-z", "--stdin", "merge"],
            &[],
            &super::cli::nul_paths_input(&paths),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git check-attr failed: {}",
            out.stderr.trim()
        )));
    }
    let fields: Vec<&str> = out.stdout.split_terminator('\0').collect();
    Ok(fields
        .chunks_exact(3)
        .filter(|record| record[2] == "unset" || record[2] == "binary")
        .map(|record| record[0].to_owned())
        .collect())
}

/// Whether Git does not merge the sides of `conflict` as text: its `merge`
/// attribute is unset or a side is binary or an LFS pointer.
pub async fn is_binary(
    cli: &GitCli,
    repo: &Path,
    conflict: &ConflictedPath,
) -> Result<bool, GitError> {
    Ok(merge_unset(cli, repo, std::slice::from_ref(conflict))
        .await?
        .contains(conflict.path.as_str())
        || binary_side(cli, repo, conflict).await?)
}

/// Whether a side of `conflict` is binary to Git or an LFS pointer.
async fn binary_side(
    cli: &GitCli,
    repo: &Path,
    conflict: &ConflictedPath,
) -> Result<bool, GitError> {
    for side in conflict.sides() {
        if !side.is_regular_file() {
            continue;
        }
        let (_, bytes) =
            super::cli::read_bounded(cli, repo, &["cat-file", "blob", &side.oid], BINARY_PROBE)
                .await?;
        let probe = &bytes[..bytes.len().min(BINARY_PROBE)];
        if probe.contains(&0) || probe.starts_with(LFS_POINTER) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The working file of a Page, `None` when it is gone or too large to read.
fn read_page(file: &Path) -> Result<Option<Vec<u8>>, GitError> {
    match std::fs::metadata(file) {
        Ok(meta) if meta.len() as usize > MAX_PAGE => return Ok(None),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    match std::fs::read(file) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Whether a conflict marker of `size` in the merged `content` of a Page
/// opens before the end of its frontmatter: the conflict is in the
/// properties, including a conflict that spans the closing `---` and the
/// start of the text.
pub fn markers_in_frontmatter(content: &[u8], size: usize) -> bool {
    let mut lines = content.split(|byte| *byte == b'\n').map(|line| {
        // As Git reads lines: a `\r` belongs to the line ending only before `\n`.
        line.strip_suffix(b"\r").unwrap_or(line)
    });
    let opens = |line: &[u8]| {
        line.len() >= size
            && line[..size].iter().all(|byte| *byte == b'<')
            && line.get(size).is_none_or(|next| *next == b' ')
    };
    match lines.next() {
        Some(b"---") => {}
        // A conflict from the first line that holds the opening `---`.
        Some(first) if opens(first) => return lines.next() == Some(b"---"),
        _ => return false,
    }
    for line in lines {
        if opens(line) {
            return true;
        }
        if line == b"---" {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(mode: &str) -> Option<StageEntry> {
        Some(StageEntry {
            mode: mode.into(),
            oid: "0".repeat(40),
        })
    }

    fn conflict(path: &str, stages: [bool; 3]) -> ConflictedPath {
        let side = |present: bool| present.then(|| entry("100644")).flatten();
        ConflictedPath {
            path: path.into(),
            base: side(stages[0]),
            ours: side(stages[1]),
            theirs: side(stages[2]),
        }
    }

    #[test]
    fn kinds_follow_the_stages_and_facts() {
        let none = KindFacts::default();
        assert_eq!(
            classify(&conflict("notes.txt", [true, true, true]), none),
            ConflictKind::Text
        );
        assert_eq!(
            classify(&conflict("page.md", [true, true, true]), none),
            ConflictKind::PageText
        );
        let frontmatter = KindFacts {
            frontmatter: true,
            ..none
        };
        assert_eq!(
            classify(&conflict("page.md", [true, true, true]), frontmatter),
            ConflictKind::PageProperties
        );
        let binary = KindFacts {
            binary: true,
            ..none
        };
        // A binary file named like a Page is still binary.
        assert_eq!(
            classify(&conflict("image.md", [true, true, true]), binary),
            ConflictKind::Binary
        );
        assert_eq!(
            classify(&conflict("a.txt", [true, true, false]), none),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(&conflict("a.txt", [true, false, true]), none),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(&conflict("a.txt", [false, true, true]), none),
            ConflictKind::AddAdd
        );
        let renamed = KindFacts {
            rename: Some(ConflictKind::RenameDelete),
            ..none
        };
        assert_eq!(
            classify(&conflict("b.txt", [true, true, false]), renamed),
            ConflictKind::RenameDelete
        );
        let pointer = ConflictedPath {
            path: "space".into(),
            base: entry("160000"),
            ours: entry("160000"),
            theirs: entry("160000"),
        };
        assert_eq!(classify(&pointer, none), ConflictKind::SpacePointer);
    }

    #[test]
    fn a_marker_before_the_closing_line_is_in_the_properties() {
        let properties =
            b"---\n<<<<<<< ours\ntitle: A\n=======\ntitle: B\n>>>>>>> theirs\n---\nText\n";
        assert!(markers_in_frontmatter(properties, 7));
        let text = b"---\ntitle: A\n---\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n";
        assert!(!markers_in_frontmatter(text, 7));
        // A conflict spanning the closing line and the start of the text.
        let spanning = b"---\ntitle: A\n<<<<<<< ours\n---\nA\n=======\n---\nB\n>>>>>>> theirs\n";
        assert!(markers_in_frontmatter(spanning, 7));
        // CRLF line endings and the marker size of the path.
        let crlf =
            b"---\r\n<<<<<<<<<< ours\r\na: 1\r\n==========\r\na: 2\r\n>>>>>>>>>> theirs\r\n---\r\n";
        assert!(markers_in_frontmatter(crlf, 10));
        assert!(!markers_in_frontmatter(crlf, 7));
        // No frontmatter: every conflict is in the text.
        assert!(!markers_in_frontmatter(
            b"<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
        // A conflict from the first line over the opening `---`.
        assert!(markers_in_frontmatter(
            b"<<<<<<< ours\n---\ntitle: A\n---\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
    }
}
