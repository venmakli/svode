//! Merging of Svode service files (module 01, 1.C).
//!
//! The mechanism belongs to Git: the sides of a conflicted path come from its
//! index stages, the result marks the path resolved explicitly and the merged
//! paths are named. The value of a merged file comes from the rule of its
//! owner: `.svode/order.json` from Pages ([`crate::content_tree`]), the Space
//! pointer from Git ([`pointer`]). One rule set serves the in-memory preflight
//! over `git merge-tree --write-tree` ([`parse_merge_tree`], [`evaluate`]),
//! the merge Svode started and the action for a merge started outside Svode
//! ([`merge_in_index`]); a rule added to [`RULES`] applies to all three.

pub mod pointer;

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use serde::Serialize;

use super::GitError;
use super::cli::{GitCli, literal_pathspec_input};

/// The rules of Svode service files, one per owner. Adding a rule is one
/// entry here and its owner's [`ServiceRule`]; every caller picks it up.
const RULES: &[&dyn ServiceRule] = &[
    &crate::content_tree::order_merge::OrderRule,
    &pointer::PointerRule,
];

/// A service file larger than this is not one Svode wrote.
const MAX_SERVICE_FILE: usize = 16 * 1024 * 1024;

/// One index stage of a conflicted path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageEntry {
    pub mode: String,
    pub oid: String,
}

impl StageEntry {
    pub fn is_gitlink(&self) -> bool {
        self.mode == "160000"
    }

    pub fn is_regular_file(&self) -> bool {
        self.mode == "100644" || self.mode == "100755"
    }
}

/// A conflicted path with its base (stage 1), ours (stage 2, the local side)
/// and theirs (stage 3, the incoming side). A missing stage is a side
/// without the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictedPath {
    pub path: String,
    pub base: Option<StageEntry>,
    pub ours: Option<StageEntry>,
    pub theirs: Option<StageEntry>,
}

impl ConflictedPath {
    /// Every side that has the path.
    pub fn sides(&self) -> impl Iterator<Item = &StageEntry> {
        [&self.base, &self.ours, &self.theirs].into_iter().flatten()
    }
}

/// How a rule may read objects it lacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Objects {
    /// Fetch missing objects of a Space into its object store only, as the
    /// pointer rule needs (invariant 6). Merges and the preflight.
    Fetch,
    /// Local objects only: a read of the current state, such as the Dialog.
    Local,
}

/// What a rule reads while it decides a conflicted path.
pub struct RuleContext<'a> {
    pub cli: &'a GitCli,
    /// The repository of the merge.
    pub repo: &'a Path,
    pub objects: Objects,
}

impl RuleContext<'_> {
    /// The bytes of a side, `None` for a side without the path. A blob that
    /// cannot be read in full is an error: the rule cannot decide on it.
    pub async fn blob(&self, side: Option<&StageEntry>) -> Result<Option<Vec<u8>>, GitError> {
        let Some(side) = side else {
            return Ok(None);
        };
        let (complete, bytes) = super::cli::read_bounded(
            self.cli,
            self.repo,
            &["cat-file", "blob", &side.oid],
            MAX_SERVICE_FILE,
        )
        .await?;
        if !complete {
            return Err(GitError::GitCommandFailed(format!(
                "Cannot read {} of a conflicted service file",
                side.oid
            )));
        }
        Ok(Some(bytes))
    }
}

/// The value a rule gives a conflicted path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The merged content of a regular file.
    Content(Vec<u8>),
    /// The Space revision the pointer records.
    Gitlink(String),
}

/// Why a claimed path stays in conflict with an action Svode names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    /// Neither Space revision contains the other and the Space checkout
    /// contains neither both: sync the Space, then the pointer resolves.
    SpaceDiverged,
    /// A Space revision cannot be read or fetched.
    SpaceUnavailable,
}

/// The decision of a rule on a path it claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleOutcome {
    Resolved(Resolution),
    Unresolved(UnresolvedReason),
    /// Not a conflict the rule can merge, such as a side it cannot parse:
    /// the path stays an ordinary conflict for the person.
    Declined,
}

pub type RuleFuture<'a> = Pin<Box<dyn Future<Output = Result<RuleOutcome, GitError>> + Send + 'a>>;

/// The value rule of one kind of Svode service file, given by its owner.
pub trait ServiceRule: Sync {
    /// Whether the conflicted path is a file of this rule.
    fn claims(&self, conflict: &ConflictedPath) -> bool;
    /// The value of the claimed path.
    fn resolve<'a>(
        &'a self,
        ctx: &'a RuleContext<'a>,
        conflict: &'a ConflictedPath,
    ) -> RuleFuture<'a>;
}

fn rules() -> impl Iterator<Item = &'static dyn ServiceRule> {
    RULES.iter().copied().chain(test_rules())
}

#[cfg(not(test))]
fn test_rules() -> impl Iterator<Item = &'static dyn ServiceRule> {
    std::iter::empty()
}

/// A rule that exists only in the set: the tests prove that each caller
/// applies whatever the set holds.
#[cfg(test)]
fn test_rules() -> impl Iterator<Item = &'static dyn ServiceRule> {
    std::iter::once(&tests::ProbeRule as &dyn ServiceRule)
}

/// The decision of the rule set on one conflicted path it claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluated {
    pub conflict: ConflictedPath,
    pub outcome: RuleOutcome,
}

/// Decide every conflicted path a rule claims; the others are not service
/// files. Nothing is written: the in-memory preflight treats the conflicts
/// as service-only when every path is here as [`RuleOutcome::Resolved`].
pub async fn evaluate(
    cli: &GitCli,
    repo: &Path,
    conflicts: &[ConflictedPath],
    objects: Objects,
) -> Result<Vec<Evaluated>, GitError> {
    let ctx = RuleContext { cli, repo, objects };
    let mut evaluated = Vec::new();
    for conflict in conflicts {
        let Some(rule) = rules().find(|rule| rule.claims(conflict)) else {
            continue;
        };
        let outcome = rule.resolve(&ctx, conflict).await?;
        evaluated.push(Evaluated {
            conflict: conflict.clone(),
            outcome,
        });
    }
    Ok(evaluated)
}

/// Whether the rule set resolves every one of `conflicts`.
pub async fn resolves_all(
    cli: &GitCli,
    repo: &Path,
    conflicts: &[ConflictedPath],
    objects: Objects,
) -> Result<bool, GitError> {
    let evaluated = evaluate(cli, repo, conflicts, objects).await?;
    Ok(evaluated.len() == conflicts.len()
        && evaluated
            .iter()
            .all(|item| matches!(item.outcome, RuleOutcome::Resolved(_))))
}

/// A conflicted service file as the Dialog names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceFile {
    pub path: String,
    pub state: ServiceFileState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceFileState {
    /// The rule set merges it: «Слить служебные файлы Svode».
    Mergeable,
    SpaceDiverged,
    SpaceUnavailable,
}

impl ServiceFile {
    fn from_evaluated(item: &Evaluated) -> Option<Self> {
        let state = match item.outcome {
            RuleOutcome::Resolved(_) => ServiceFileState::Mergeable,
            RuleOutcome::Unresolved(UnresolvedReason::SpaceDiverged) => {
                ServiceFileState::SpaceDiverged
            }
            RuleOutcome::Unresolved(UnresolvedReason::SpaceUnavailable) => {
                ServiceFileState::SpaceUnavailable
            }
            RuleOutcome::Declined => return None,
        };
        Some(Self {
            path: item.conflict.path.clone(),
            state,
        })
    }
}

/// What merging service files in the index did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServiceMerge {
    /// Paths Svode merged and marked resolved.
    pub merged: Vec<String>,
    /// Claimed paths left in conflict with their reason.
    pub unresolved: Vec<ServiceFile>,
}

/// Parse NUL-separated `<mode> <oid> <stage>\t<path>` records, as
/// `git ls-files --unmerged -z` and the conflicted file info of
/// `git merge-tree --write-tree -z` write them, into conflicted paths in
/// the order of the records.
pub fn parse_staged<'a>(records: impl IntoIterator<Item = &'a str>) -> Vec<ConflictedPath> {
    let mut conflicts: Vec<ConflictedPath> = Vec::new();
    for record in records {
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split(' ');
        let (Some(mode), Some(oid), Some(stage), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let entry = Some(StageEntry {
            mode: mode.to_owned(),
            oid: oid.to_owned(),
        });
        let index = match conflicts.iter().position(|known| known.path == path) {
            Some(index) => index,
            None => {
                conflicts.push(ConflictedPath {
                    path: path.to_owned(),
                    base: None,
                    ours: None,
                    theirs: None,
                });
                conflicts.len() - 1
            }
        };
        let conflict = &mut conflicts[index];
        match stage {
            "1" => conflict.base = entry,
            "2" => conflict.ours = entry,
            "3" => conflict.theirs = entry,
            _ => {}
        }
    }
    conflicts
}

/// The result of `git merge-tree --write-tree -z`: the merged tree and the
/// conflicted paths with their stages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeTree {
    pub tree: String,
    pub conflicts: Vec<ConflictedPath>,
}

/// Parse the output of `git merge-tree --write-tree -z` (without
/// `--name-only`): the tree, then the conflicted file info up to an empty
/// record, then informational messages, which are not read.
pub fn parse_merge_tree(output: &str) -> Option<MergeTree> {
    let mut records = output.split('\0');
    let tree = records.next().filter(|tree| !tree.is_empty())?.to_owned();
    let conflicts = parse_staged(records.take_while(|record| !record.is_empty()));
    Some(MergeTree { tree, conflicts })
}

/// The conflicted paths of the index of `repo`.
pub async fn index_conflicts(cli: &GitCli, repo: &Path) -> Result<Vec<ConflictedPath>, GitError> {
    let out = cli
        .exec(repo, &["ls-files", "--unmerged", "-z", "--full-name"])
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git ls-files failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(parse_staged(out.stdout.split('\0')))
}

/// The conflicted service files of the index and what the rule set says
/// about them now, from local objects only; nothing is written.
pub async fn inspect_in_index(cli: &GitCli, repo: &Path) -> Result<Vec<ServiceFile>, GitError> {
    let conflicts = index_conflicts(cli, repo).await?;
    if conflicts.is_empty() {
        return Ok(Vec::new());
    }
    Ok(evaluate(cli, repo, &conflicts, Objects::Local)
        .await?
        .iter()
        .filter_map(ServiceFile::from_evaluated)
        .collect())
}

/// Merge the conflicted service files of the index of `repo` by the rule
/// set, limited to `only` when given: a merged file is written to the
/// working tree and marked resolved, a pointer is recorded in the index
/// without touching the Space checkout. Other paths stay as they are.
pub async fn merge_in_index(
    cli: &GitCli,
    repo: &Path,
    only: Option<&[String]>,
) -> Result<ServiceMerge, GitError> {
    let mut conflicts = index_conflicts(cli, repo).await?;
    if let Some(only) = only {
        conflicts.retain(|conflict| only.contains(&conflict.path));
    }
    if conflicts.is_empty() {
        return Ok(ServiceMerge::default());
    }
    let evaluated = evaluate(cli, repo, &conflicts, Objects::Fetch).await?;
    let mut merge = ServiceMerge::default();
    let mut contents = Vec::new();
    for item in &evaluated {
        let path = &item.conflict.path;
        match &item.outcome {
            RuleOutcome::Resolved(Resolution::Content(bytes)) => {
                let target = repo.join(path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&target, bytes)?;
                contents.push(path.clone());
            }
            RuleOutcome::Resolved(Resolution::Gitlink(oid)) => {
                // A stage 0 entry replaces the unmerged stages of the path.
                let cache = format!("160000,{oid},{path}");
                let out = cli
                    .exec(repo, &["update-index", "--add", "--cacheinfo", &cache])
                    .await?;
                if out.exit_code != 0 {
                    return Err(GitError::GitCommandFailed(format!(
                        "git update-index failed: {}",
                        out.stderr.trim()
                    )));
                }
                merge.merged.push(path.clone());
            }
            RuleOutcome::Unresolved(_) | RuleOutcome::Declined => {
                merge.unresolved.extend(ServiceFile::from_evaluated(item));
            }
        }
    }
    if !contents.is_empty() {
        let out = cli
            .exec_with_input(
                repo,
                &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                &[],
                &literal_pathspec_input(&contents),
            )
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git add failed: {}",
                out.stderr.trim()
            )));
        }
        merge.merged.extend(contents);
    }
    merge.merged.sort();
    if !merge.merged.is_empty() {
        tracing::info!(
            "Merged {} Svode service files in {}",
            merge.merged.len(),
            repo.display()
        );
    }
    Ok(merge)
}

#[cfg(test)]
mod tests;
