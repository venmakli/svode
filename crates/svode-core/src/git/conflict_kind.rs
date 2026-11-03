//! Kinds of conflicted paths (module 01, 1.F): one vocabulary for the stop
//! «Конфликт с правками коллег» of the in-memory preflight (1.B) and for the
//! unresolved paths of a merge. A kind follows the index stages of the path
//! and whether Git merged it as text, not its extension; a Page is told
//! apart by where the places of the merge of its stages stand, not by its
//! working file.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::cli::GitCli;
use super::markers;
use super::service_merge::{self, ConflictedPath, StageEntry};
use super::stage_merge::{self, ConflictStyle, MAX_STAGE};

/// Git decides a side is binary by a NUL byte among its first bytes.
const BINARY_PROBE: usize = 8000;
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
    /// The title of the Page at the path, as [`page_names`] reads it from
    /// its versions; `None` for a path that is not a Page or whose versions
    /// do not read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    /// A conflict place of the merged Page lies in its frontmatter.
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
/// `merge` attribute unset — makes the path binary; a conflict place in the
/// frontmatter of a Page merged again from its index stages with the marker
/// size of its path tells its properties from its text, whatever its working
/// file holds now. A Page is named by its versions ([`page_names`]).
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
        if let Some(merged) =
            stage_merge::merge_stages(cli, repo, conflict, *size, ConflictStyle::Merge).await?
        {
            facts.frontmatter = super::conflict_file::places_in_frontmatter(&merged, *size);
        }
    }
    let mut names = page_names(cli, repo, &conflicts, ["HEAD", "MERGE_HEAD"]).await;
    let kinds: Vec<PathConflict> = conflicts
        .iter()
        .zip(facts)
        .map(|(conflict, facts)| PathConflict {
            path: conflict.path.clone(),
            kind: classify(conflict, facts),
            name: names.remove(&conflict.path),
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

/// The names of the Pages among `conflicts`, by path (DF-301): the title of
/// my version as the Space tree shows a Page — its `title` property,
/// otherwise the name of its file, for the `README.md` of a folder the name
/// of the folder — or of the incoming version when mine is missing or does
/// not read. A path that is not a Page, or none of whose versions reads,
/// has no name. My version is the stage of my side; at a side of a
/// rename/rename, whose single stage Git fills with the merge of both
/// renamed versions, it is the path in `revisions[0]`, the incoming one in
/// `revisions[1]`. The versions of a side are read by one `git cat-file
/// --batch` for all the paths, a version larger than [`MAX_STAGE`] is not
/// read, and the title is taken from the frontmatter at its head; the
/// working file, which may hold markers in its frontmatter, takes no part.
pub(crate) async fn page_names<'a>(
    cli: &GitCli,
    repo: &Path,
    conflicts: impl IntoIterator<Item = &'a ConflictedPath>,
    revisions: [&str; 2],
) -> HashMap<String, String> {
    let mut pending: Vec<&ConflictedPath> = conflicts
        .into_iter()
        .filter(|conflict| names_a_page(&conflict.path))
        .collect();
    let sides: [fn(&ConflictedPath) -> Option<&StageEntry>; 2] = [
        |conflict| conflict.ours.as_ref(),
        |conflict| conflict.theirs.as_ref(),
    ];
    let mut names = HashMap::new();
    for (side, revision) in sides.into_iter().zip(revisions) {
        let read: Vec<(&str, String)> = pending
            .iter()
            .filter_map(|conflict| {
                let stage = side(conflict).filter(|stage| stage.is_regular_file())?;
                let object = if conflict.sides().count() > 1 {
                    stage.oid.clone()
                } else if conflict.path.contains('\n') {
                    return None;
                } else {
                    format!("{revision}:{}", conflict.path)
                };
                Some((conflict.path.as_str(), object))
            })
            .collect();
        if read.is_empty() {
            continue;
        }
        for ((path, _), title) in read.iter().zip(version_titles(cli, repo, &read).await) {
            if let Some(title) = title {
                names.insert((*path).to_owned(), title);
            }
        }
        pending.retain(|conflict| !names.contains_key(&conflict.path));
    }
    names
}

/// How long reading the versions that name the Pages may take.
const NAME_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether `path` is a Page the Space tree shows: a Markdown file outside
/// hidden folders, not hidden itself and not the README of the Space.
fn names_a_page(path: &str) -> bool {
    super::versions::is_page(path)
        && crate::page::naming::is_user_document(path)
        && !path.rsplit('/').next().unwrap_or(path).starts_with('.')
}

/// The titles of the Pages at the paths of `read` from their versions, the
/// objects named there, in their order; `None` for a version that is
/// missing or does not read, and for every one when the read fails.
async fn version_titles(cli: &GitCli, repo: &Path, read: &[(&str, String)]) -> Vec<Option<String>> {
    let input: String = read
        .iter()
        .map(|(_, object)| format!("{object}\n"))
        .collect();
    let mut titles = Vec::with_capacity(read.len());
    if let Ok(Some(output)) = super::cli::read_with_input(
        cli,
        repo,
        &["cat-file", "--batch"],
        input.as_bytes(),
        read.len() * (MAX_STAGE + 128),
        NAME_READ_TIMEOUT,
    )
    .await
    {
        let mut rest = output.as_slice();
        for (path, _) in read {
            let Some(end) = rest.iter().position(|byte| *byte == b'\n') else {
                break;
            };
            let header = String::from_utf8_lossy(&rest[..end]).into_owned();
            rest = &rest[end + 1..];
            // A missing object is its header alone.
            if header.ends_with(" missing") || header.ends_with(" ambiguous") {
                titles.push(None);
                continue;
            }
            let [_, kind, size] = header.split(' ').collect::<Vec<_>>()[..] else {
                break;
            };
            let Ok(size) = size.parse::<usize>() else {
                break;
            };
            if rest.len() <= size {
                break;
            }
            titles.push(
                (kind == "blob" && size <= MAX_STAGE)
                    .then(|| page_title(path, &rest[..size]))
                    .flatten(),
            );
            rest = &rest[size + 1..];
        }
    }
    titles.resize(read.len(), None);
    titles
}

/// The title of the Page at `path` from its `version`, as the Space tree
/// shows it; `None` when its frontmatter does not read.
fn page_title(path: &str, version: &[u8]) -> Option<String> {
    let (folder, file) = path.rsplit_once('/').unwrap_or(("", path));
    let fallback = if file.eq_ignore_ascii_case("README.md") {
        folder.rsplit('/').next().unwrap_or(folder)
    } else {
        file.strip_suffix(".md").unwrap_or(file)
    };
    let title = crate::content_tree::source_title(version, fallback.to_owned())?;
    Some(if title.trim().is_empty() {
        fallback.to_owned()
    } else {
        title
    })
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

#[cfg(all(test, unix))]
#[path = "conflict_kind_tests.rs"]
mod stage_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::conflict_file::places_in_frontmatter;

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
    fn a_page_is_named_as_the_space_tree_shows_it() {
        let title = |path: &str, version: &str| page_title(path, version.as_bytes());
        assert_eq!(
            title(
                "Задачи/Вторая.md",
                "---\ntitle: Вторая\nСтатус: Открыта\n---\nТекст\n"
            ),
            Some("Вторая".into())
        );
        // Without a `title` property, the name of the file.
        assert_eq!(
            title("Задачи/Вторая.md", "---\nСтатус: Открыта\n---\n"),
            Some("Вторая".into())
        );
        assert_eq!(title("notes/plan.md", "Plain text\n"), Some("plan".into()));
        assert_eq!(
            title("plan.md", "---\ntitle: \"\"\n---\n"),
            Some("plan".into())
        );
        // The README of a folder names the folder-Page.
        assert_eq!(
            title("docs/guide/README.md", "---\ntitle: Guide\n---\n"),
            Some("Guide".into())
        );
        assert_eq!(
            title("docs/guide/README.md", "# Guide\n"),
            Some("guide".into())
        );
        // Frontmatter that does not read names nothing.
        assert_eq!(title("plan.md", "---\ntitle: [\n---\n"), None);
        assert_eq!(title("plan.md", "---\ntitle: A\n"), None);

        assert!(names_a_page("Задачи/Вторая.md"));
        assert!(names_a_page("docs/README.md"));
        assert!(!names_a_page("README.md"), "the README of the Space");
        assert!(!names_a_page("Задачи/schema.yaml"));
        assert!(!names_a_page(".svode/notes.md"));
        assert!(!names_a_page("docs/.draft.md"));
    }

    #[test]
    fn a_marker_before_the_closing_line_is_in_the_properties() {
        let properties =
            b"---\n<<<<<<< ours\ntitle: A\n=======\ntitle: B\n>>>>>>> theirs\n---\nText\n";
        assert!(places_in_frontmatter(properties, 7));
        let text = b"---\ntitle: A\n---\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n";
        assert!(!places_in_frontmatter(text, 7));
        // A conflict spanning the closing line and the start of the text.
        let spanning = b"---\ntitle: A\n<<<<<<< ours\n---\nA\n=======\n---\nB\n>>>>>>> theirs\n";
        assert!(places_in_frontmatter(spanning, 7));
        // CRLF line endings and the marker size of the path.
        let crlf =
            b"---\r\n<<<<<<<<<< ours\r\na: 1\r\n==========\r\na: 2\r\n>>>>>>>>>> theirs\r\n---\r\n";
        assert!(places_in_frontmatter(crlf, 10));
        assert!(!places_in_frontmatter(crlf, 7));
        // No frontmatter: every conflict is in the text.
        assert!(!places_in_frontmatter(
            b"<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
        // A conflict from the first line over the opening `---`.
        assert!(places_in_frontmatter(
            b"<<<<<<< ours\n---\ntitle: A\n---\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
        // Only the incoming side of a conflict from the first line opens one.
        assert!(places_in_frontmatter(
            b"<<<<<<< ours\nHello\n=======\n---\ntitle: B\n---\nHello\n>>>>>>> theirs\n",
            7
        ));
        // A `<` line in the frontmatter that folds into no block.
        assert!(places_in_frontmatter(
            b"---\ntitle: A\n<<<<<<< ours\nnote: x\n---\nText\n",
            7
        ));
        // A conflict place after the frontmatter that starts with `---` text.
        assert!(!places_in_frontmatter(
            b"---\ntitle: A\n---\n<<<<<<< ours\n---\nA\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
    }
}
