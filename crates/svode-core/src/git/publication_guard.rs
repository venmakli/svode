//! Publication guard (invariant 13): what a push sends to its upstream for
//! the first time carries no conflict marker lines and no Svode service file
//! that Svode cannot read. Every check reads local objects only.

use std::collections::{BTreeMap, BTreeSet};

use super::{ContentFinding, GitCli, GitError, Path, PublicationBlockReason, Snapshot, blocked};

/// The local reads never contact a promisor remote for a missing object.
const LOCAL: &[(&str, &str)] = &[("GIT_NO_LAZY_FETCH", "1"), ("GIT_OPTIONAL_LOCKS", "0")];
const MARKER: &str = ": leftover conflict marker";

/// Refuse the push when a target update brings a finding. A target the
/// remote already has is checked from its advertised revision; a new target
/// and a first publish check the whole tree.
pub(super) async fn check(
    cli: &GitCli,
    repo: &Path,
    snapshot: &Snapshot,
    first: bool,
) -> Result<(), GitError> {
    let advertised: BTreeMap<&str, &str> = snapshot
        .remote_refs
        .lines()
        .filter_map(|line| {
            let (oid, reference) = line.split_once('\t')?;
            Some((reference, oid))
        })
        .collect();
    let mut empty_tree: Option<String> = None;
    for (target, oid) in &snapshot.updates {
        let tip = format!("{oid}^{{commit}}");
        if read(cli, repo, &["rev-parse", "--verify", "--quiet", &tip])
            .await?
            .exit_code
            != 0
        {
            // A tag of a tree or blob publishes no commit of its own.
            continue;
        }
        let range = match advertised.get(target.as_str()).filter(|_| !first) {
            Some(base) => {
                let ancestor =
                    read(cli, repo, &["merge-base", "--is-ancestor", base, &tip]).await?;
                if ancestor.exit_code != 0 {
                    // Not a fast-forward: the remote refuses this update.
                    continue;
                }
                Some((*base).to_owned())
            }
            None => None,
        };
        let base = match &range {
            Some(base) => base.clone(),
            None => match &empty_tree {
                Some(tree) => tree.clone(),
                None => {
                    let tree = empty_tree_oid(cli, repo).await?;
                    empty_tree.insert(tree).clone()
                }
            },
        };
        if let Some((path, finding)) = inspect(cli, repo, &base, &tip).await? {
            let commit = last_change(cli, repo, range.as_deref(), &tip, &path).await?;
            return Err(blocked(
                repo,
                PublicationBlockReason::Content {
                    path,
                    commit: commit.unwrap_or_else(|| oid.clone()),
                    finding,
                },
            ));
        }
    }
    Ok(())
}

/// The first finding of the change from `base` to `tip`: marker lines that
/// Git's own check reports, other than side separators, then a changed
/// service file that does not parse.
async fn inspect(
    cli: &GitCli,
    repo: &Path,
    base: &str,
    tip: &str,
) -> Result<Option<(String, ContentFinding)>, GitError> {
    let common = [
        "--no-relative",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
    ];
    let mut args = vec!["diff", "--name-only", "-z", "--diff-filter=d"];
    args.extend(common);
    args.extend([base, tip, "--"]);
    let names = read(cli, repo, &args).await?;
    if names.exit_code != 0 {
        return Err(failed("git diff --name-only", &names.stderr));
    }
    let changed: BTreeSet<&str> = names.stdout.split_terminator('\0').collect();
    if changed.is_empty() {
        return Ok(None);
    }
    let mut args = vec!["diff", "--check"];
    args.extend(common);
    args.extend([base, tip, "--"]);
    let checked = read(cli, repo, &args).await?;
    // Git exits with 2 when it reports a problem, and only whitespace
    // problems and marker lines are reported.
    if !matches!(checked.exit_code, 0..=2) {
        return Err(failed("git diff --check", &checked.stderr));
    }
    let reported = checked.stdout.lines().filter_map(|line| {
        let (path, number) = line.strip_suffix(MARKER)?.rsplit_once(':')?;
        let digits = number.bytes().all(|byte| byte.is_ascii_digit());
        let number = number.parse::<usize>().ok().filter(|_| digits)?;
        changed.contains(path).then_some((path, number))
    });
    // Git reports a lone side separator line as well, which is a Markdown
    // setext heading; a conflict left in a file always keeps its opening and
    // closing lines, which Git reports on their own.
    let mut published: Option<(&str, Option<String>)> = None;
    for (path, number) in reported {
        if published.as_ref().is_none_or(|(cached, _)| *cached != path) {
            published = Some((path, published_text(cli, repo, tip, path).await?));
        }
        let text = published.as_ref().and_then(|(_, text)| text.as_deref());
        if !text.is_some_and(|text| separator_line(text, number)) {
            return Ok(Some((path.to_owned(), ContentFinding::ConflictMarkers)));
        }
    }
    for path in changed {
        let Some(parse) = service_parser(path) else {
            continue;
        };
        let object = format!("{tip}:{path}");
        let (complete, bytes) = super::super::cli::read_bounded(
            cli,
            repo,
            &["cat-file", "blob", &object],
            MAX_SERVICE_FILE,
        )
        .await?;
        if !complete || parse(&bytes).is_err() {
            return Ok(Some((path.to_owned(), ContentFinding::Unreadable)));
        }
    }
    Ok(None)
}

/// The version of `path` that `tip` publishes, or `None` when Git cannot
/// read it locally; a finding then stands.
async fn published_text(
    cli: &GitCli,
    repo: &Path,
    tip: &str,
    path: &str,
) -> Result<Option<String>, GitError> {
    let object = format!("{tip}:{path}");
    let out = read(cli, repo, &["cat-file", "blob", &object]).await?;
    Ok((out.exit_code == 0).then_some(out.stdout))
}

/// Whether line `number`, counted from one as Git reports it, is a side
/// separator: its first character is `=`.
fn separator_line(text: &str, number: usize) -> bool {
    number
        .checked_sub(1)
        .and_then(|index| text.split('\n').nth(index))
        .is_some_and(|line| line.starts_with('='))
}

/// A service file larger than this is not one Svode wrote.
const MAX_SERVICE_FILE: usize = 16 * 1024 * 1024;

/// The reader Svode applies to a service file at `path`, if it is one: it
/// says why the bytes do not read. Collection views live in their
/// `schema.yaml` and are parsed with it.
pub(crate) fn service_parser(path: &str) -> Option<fn(&[u8]) -> Result<(), String>> {
    let mut components = path.rsplit('/');
    let name = components.next()?;
    let parent = components.next();
    match (parent, name) {
        (Some(".svode"), "config.json") => Some(|bytes| {
            crate::space_config::parse(bytes)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }),
        (Some(".svode"), "order.json") => Some(|bytes| {
            let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
            crate::content_tree::parse_order(text)
                .map(|_| ())
                .map_err(|error| error.to_string())
        }),
        // Hidden folders, such as `.templates`, hold no Collection.
        (_, "schema.yaml") if !path.split('/').any(|part| part.starts_with('.')) => Some(|bytes| {
            let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
            crate::collections::schema::parse_schema(text).map(|_| ())
        }),
        _ => None,
    }
}

/// The last outgoing commit that changed `path`, whose version the push
/// publishes; with no published base, the last commit of the tree.
async fn last_change(
    cli: &GitCli,
    repo: &Path,
    base: Option<&str>,
    tip: &str,
    path: &str,
) -> Result<Option<String>, GitError> {
    let revisions = match base {
        Some(base) => format!("{base}..{tip}"),
        None => tip.to_owned(),
    };
    let out = cli
        .exec_with_env(
            repo,
            &["log", "-1", "--format=%H", &revisions, "--", path],
            &[LOCAL[0], LOCAL[1], ("GIT_LITERAL_PATHSPECS", "1")],
        )
        .await?;
    let commit = out.stdout.trim();
    Ok((out.exit_code == 0 && !commit.is_empty()).then(|| commit.to_owned()))
}

async fn empty_tree_oid(cli: &GitCli, repo: &Path) -> Result<String, GitError> {
    let out = cli
        .exec_with_input(repo, &["hash-object", "-t", "tree", "--stdin"], LOCAL, b"")
        .await?;
    if out.exit_code != 0 {
        return Err(failed("git hash-object", &out.stderr));
    }
    Ok(out.stdout.trim().to_owned())
}

async fn read(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<super::GitOutput, GitError> {
    cli.exec_with_env(repo, args, LOCAL).await
}

fn failed(command: &str, stderr: &str) -> GitError {
    GitError::GitCommandFailed(format!("{command} failed: {}", stderr.trim()))
}
