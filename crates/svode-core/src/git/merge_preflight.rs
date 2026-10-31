//! In-memory preflight of the integration step (module 01, 1.B).
//!
//! Before background sync changes the working copy, Svode merges HEAD and
//! the observed revision with `git merge-tree --write-tree`, which writes
//! objects only: the working copy, the index and HEAD stay as they are. A
//! conflict counts as service-only when the rule set of Svode service files
//! resolves it ([`service_merge`]), the same set an explicit sync merges by,
//! so a rule added to the set applies here without a change. Git older than
//! 2.38 has no such merge: background sync then only fast-forwards.

use std::collections::HashMap;
use std::path::Path;

use super::GitError;
use super::cli::GitCli;
use super::conflict_kind::{self, ConflictKind, KindFacts, PathConflict};
use super::markers;
use super::service_merge::{self, Objects, RuleOutcome, ServiceFile};

/// A merged Page larger than this is not read for the place of its markers.
const MAX_PAGE: usize = 4 * 1024 * 1024;

/// What integrating the observed revision would do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Preflight {
    /// HEAD contains the revision.
    UpToDate,
    /// The branch moves forward to the revision (or an unborn branch takes it).
    FastForward,
    /// A merge without conflicts.
    Clean,
    /// A merge whose conflicts the rule set of service files resolves.
    ServiceOnly,
    /// A merge with conflicts the person resolves: `files` with their
    /// kinds, without the service files the rule set merges; `service` are
    /// the claimed service files it leaves in conflict, with their reason.
    Conflicts {
        files: Vec<PathConflict>,
        service: Vec<ServiceFile>,
    },
    /// The branches diverged and this Git cannot merge in memory.
    Unchecked,
}

impl Preflight {
    /// Whether background sync integrates after this outcome (1.B): a
    /// fast-forward, a clean merge or one with service conflicts only.
    pub fn integrates_in_background(&self) -> bool {
        matches!(
            self,
            Self::UpToDate | Self::FastForward | Self::Clean | Self::ServiceOnly
        )
    }
}

/// A preflight and the HEAD it merged from; an integration that finds HEAD
/// moved checks again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub head: Option<String>,
    pub outcome: Preflight,
}

/// Merge HEAD and `revision` of `repo` in memory and say what integrating
/// it would do. Nothing of the repository changes; objects of a merge or of
/// a Space the pointer rule fetches are added to object stores only.
pub async fn check(cli: &GitCli, repo: &Path, revision: &str) -> Result<Checked, GitError> {
    let head = read_revision(cli, repo, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).await?;
    let outcome = match head.as_deref() {
        None => Preflight::FastForward,
        Some(head) if is_ancestor(cli, repo, revision, head).await? => Preflight::UpToDate,
        Some(head) if is_ancestor(cli, repo, head, revision).await? => Preflight::FastForward,
        Some(_) if !cli.background_merge() => Preflight::Unchecked,
        Some(head) => merge_in_memory(cli, repo, head, revision).await?,
    };
    Ok(Checked { head, outcome })
}

async fn merge_in_memory(
    cli: &GitCli,
    repo: &Path,
    head: &str,
    revision: &str,
) -> Result<Preflight, GitError> {
    let out = cli
        .exec(repo, &["merge-tree", "--write-tree", "-z", head, revision])
        .await?;
    match out.exit_code {
        0 => return Ok(Preflight::Clean),
        1 => {}
        _ => {
            return Err(GitError::GitCommandFailed(format!(
                "git merge-tree failed: {}",
                out.stderr.trim()
            )));
        }
    }
    let merge = service_merge::parse_merge_tree(&out.stdout)
        .ok_or_else(|| GitError::GitCommandFailed("git merge-tree returned no tree".to_owned()))?;
    let evaluated = service_merge::evaluate(cli, repo, &merge.conflicts, Objects::Fetch).await?;
    if service_merge::all_resolved(&merge.conflicts, &evaluated) {
        return Ok(Preflight::ServiceOnly);
    }
    let outcomes: HashMap<&str, &RuleOutcome> = evaluated
        .iter()
        .map(|item| (item.conflict.path.as_str(), &item.outcome))
        .collect();
    let service = evaluated
        .iter()
        .filter(|item| !matches!(item.outcome, RuleOutcome::Resolved(_)))
        .filter_map(ServiceFile::from_evaluated)
        .collect();
    let left: Vec<_> = merge
        .conflicts
        .iter()
        .filter(|conflict| {
            !matches!(
                outcomes.get(conflict.path.as_str()),
                Some(RuleOutcome::Resolved(_))
            )
        })
        .collect();

    let mut facts: HashMap<&str, KindFacts> = HashMap::new();
    for message in &merge.messages {
        let fact = |facts: &mut KindFacts| match message.kind.as_str() {
            "CONFLICT (binary)" => facts.binary = true,
            "CONFLICT (rename/rename)" => facts.rename = Some(ConflictKind::RenameRename),
            "CONFLICT (rename/delete)" => facts.rename = Some(ConflictKind::RenameDelete),
            _ => {}
        };
        for path in &message.paths {
            fact(facts.entry(path.as_str()).or_default());
        }
    }
    // Where the markers of a merged Page stand tells its text from its properties.
    let pages: Vec<String> = left
        .iter()
        .filter(|conflict| {
            conflict_kind::classify(
                conflict,
                facts
                    .get(conflict.path.as_str())
                    .copied()
                    .unwrap_or_default(),
            ) == ConflictKind::PageText
        })
        .map(|conflict| conflict.path.clone())
        .collect();
    let sizes = markers::marker_sizes(cli, repo, &pages).await?;
    for page in &pages {
        let object = format!("{}:{page}", merge.tree);
        let (complete, content) =
            super::cli::read_bounded(cli, repo, &["cat-file", "blob", &object], MAX_PAGE).await?;
        let size = sizes
            .get(page)
            .copied()
            .unwrap_or(markers::DEFAULT_MARKER_SIZE);
        if complete && conflict_kind::markers_in_frontmatter(&content, size) {
            facts.entry(page.as_str()).or_default().frontmatter = true;
        }
    }
    let files = left
        .into_iter()
        .map(|conflict| PathConflict {
            path: conflict.path.clone(),
            kind: conflict_kind::classify(
                conflict,
                facts
                    .get(conflict.path.as_str())
                    .copied()
                    .unwrap_or_default(),
            ),
            also: Vec::new(),
        })
        .collect();
    Ok(Preflight::Conflicts { files, service })
}

async fn is_ancestor(
    cli: &GitCli,
    repo: &Path,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, GitError> {
    let out = cli
        .exec(repo, &["merge-base", "--is-ancestor", ancestor, descendant])
        .await?;
    match out.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(GitError::GitCommandFailed(format!(
            "git merge-base failed: {}",
            out.stderr.trim()
        ))),
    }
}

async fn read_revision(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
) -> Result<Option<String>, GitError> {
    let out = cli.exec(repo, args).await?;
    let oid = out.stdout.trim();
    Ok((out.exit_code == 0 && !oid.is_empty()).then(|| oid.to_owned()))
}

#[cfg(test)]
#[path = "merge_preflight_tests.rs"]
mod tests;
