//! The files a tool call works with (Stage 10 `08` R2 and R7): the paths of
//! its diffs with the lines they change, the agent's locations, and the
//! objects a call of the Svode MCP server changes by the Svode tool catalog.
//! The Svode MCP server does not know the session that calls it, so what
//! the agent sent in the tool call is the only link.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use svode_core::agent_adapters::AgentAdapterKind;
use svode_core::page::{
    project_for_directory, ready_child_space_for_directory, resolve_space_target,
};
use svode_tools::catalog::{self, ChangedObject, ObjectChange};
use svode_tools::target::ROOT_SPACE_ID;

use crate::acp::mcp::{self, McpCall, McpResult, McpTool};
use crate::acp::normalize::URI_LIMIT;
use crate::activity::{
    DetailBlock, FileChange, ItemStatus, LineChanges, McpCallRef, ToolKind, ToolLocation,
};

/// Edits beyond this are counted as one replaced block between the common
/// head and tail of the texts instead of the shortest diff.
const MAX_EDIT: usize = 10_000;
/// Rough bound of the work of one count, in compared lines.
const MAX_WORK: usize = 20_000_000;

/// What the updates of one tool call said so far about its files.
#[derive(Debug, Default)]
pub(crate) struct ToolPaths {
    /// The agent's latest locations.
    locations: Vec<String>,
    /// The files of the latest diffs.
    diffs: Vec<ToolLocation>,
    calls: Vec<CallPaths>,
}

#[derive(Debug)]
struct CallPaths {
    tool: McpTool,
    /// What the call changes when it is a mutating call of the Svode MCP
    /// server; `None` for any other call.
    objects: Option<&'static [ChangedObject]>,
    /// The Space the call addresses, resolved from its `spaceId`.
    space: Option<PathBuf>,
    /// Per object, its path as the arguments and the result name it.
    named: Vec<(Option<String>, Option<String>)>,
    failed: bool,
}

impl ToolPaths {
    /// The MCP calls earlier updates were recognized as.
    pub(crate) fn tools(&self) -> Vec<McpTool> {
        self.calls.iter().map(|call| call.tool.clone()).collect()
    }

    /// The tool call is an MCP call in the form of its agent.
    pub(crate) fn is_mcp(&self) -> bool {
        !self.calls.is_empty()
    }

    /// The agent's own latest locations of the call.
    pub(crate) fn agent_locations(&self) -> &[String] {
        &self.locations
    }

    /// Takes what one update of the tool call says. `cwd` is the session's
    /// directory, the one the agent's Svode MCP server serves.
    pub(crate) fn update(
        &mut self,
        agent: Option<AgentAdapterKind>,
        cwd: &Path,
        locations: Option<Vec<String>>,
        blocks: Option<&[DetailBlock]>,
        calls: Vec<McpCall>,
    ) {
        if let Some(locations) = locations {
            self.locations = locations;
        }
        if let Some(blocks) = blocks {
            self.diffs = diff_locations(blocks);
        }
        if calls.is_empty() {
            return;
        }
        let same = calls.len() == self.calls.len()
            && calls
                .iter()
                .zip(&self.calls)
                .all(|(call, known)| call.tool == known.tool);
        if !same {
            self.calls = calls
                .iter()
                .map(|call| {
                    let objects = mcp::is_svode_server(agent, &call.tool.server)
                        .then(|| catalog::project_changes(&call.tool.tool))
                        .flatten();
                    CallPaths {
                        tool: call.tool.clone(),
                        objects,
                        space: None,
                        named: vec![(None, None); objects.map_or(0, <[_]>::len)],
                        failed: false,
                    }
                })
                .collect();
        }
        for (call, known) in calls.into_iter().zip(&mut self.calls) {
            let Some(objects) = known.objects else {
                continue;
            };
            if let Some(arguments) = &call.arguments {
                known.space = Some(space_dir(
                    cwd,
                    arguments.get("spaceId").and_then(Value::as_str),
                ));
                for (object, named) in objects.iter().zip(&mut known.named) {
                    named.0 = object.in_arguments(arguments);
                }
            }
            match &call.result {
                Some(McpResult::Value(result)) => {
                    for (object, named) in objects.iter().zip(&mut known.named) {
                        named.1 = object.in_result(result);
                    }
                }
                Some(McpResult::Error) => known.failed = true,
                None => {}
            }
        }
    }

    /// The calls as the snapshot names them.
    pub(crate) fn call_refs(&self) -> Vec<McpCallRef> {
        self.calls
            .iter()
            .map(|call| McpCallRef {
                server: call.tool.server.clone(),
                tool: call.tool.tool.clone(),
                changes_project: call.objects.is_some(),
            })
            .collect()
    }

    /// The files of a tool call of `kind` in `status`, without repeats, in
    /// order of first appearance. A failed Svode call changed nothing.
    pub(crate) fn locations(
        &self,
        kind: ToolKind,
        status: Option<ItemStatus>,
    ) -> Vec<ToolLocation> {
        let mut locations: Vec<ToolLocation> = Vec::new();
        let mut add = |location: ToolLocation| match locations
            .iter_mut()
            .find(|known| known.path == location.path)
        {
            Some(known) => {
                known.change = known.change.or(location.change);
                known.lines = known.lines.or(location.lines);
            }
            None => locations.push(location),
        };
        for diff in &self.diffs {
            add(diff.clone());
        }
        let change = match kind {
            ToolKind::Delete => Some(FileChange::Deleted),
            ToolKind::Move => Some(FileChange::Moved),
            _ => None,
        };
        for path in &self.locations {
            add(ToolLocation {
                path: path.clone(),
                change,
                lines: None,
            });
        }
        if status == Some(ItemStatus::Failed) {
            return locations;
        }
        for call in self.calls.iter().filter(|call| !call.failed) {
            let (Some(objects), Some(space)) = (call.objects, &call.space) else {
                continue;
            };
            for (object, (argument, result)) in objects.iter().zip(&call.named) {
                let Some(path) = result.as_ref().or(argument.as_ref()) else {
                    continue;
                };
                let Some(path) = inside(space, path) else {
                    continue;
                };
                add(ToolLocation {
                    path,
                    change: Some(match object.change {
                        ObjectChange::Created => FileChange::Created,
                        ObjectChange::Modified => FileChange::Modified,
                        ObjectChange::Deleted => FileChange::Deleted,
                        ObjectChange::Moved => FileChange::Moved,
                    }),
                    lines: None,
                });
            }
        }
        locations
    }
}

/// The files of the diffs in `blocks` with the lines each changes; diffs of
/// one file are summed.
fn diff_locations(blocks: &[DetailBlock]) -> Vec<ToolLocation> {
    let mut locations: Vec<ToolLocation> = Vec::new();
    for block in blocks {
        let DetailBlock::Diff {
            path,
            old_text,
            new_text,
        } = block
        else {
            continue;
        };
        let lines = line_changes(old_text.as_deref(), new_text);
        match locations.iter_mut().find(|known| &known.path == path) {
            Some(known) => {
                let total = known.lines.get_or_insert(LineChanges {
                    added: 0,
                    removed: 0,
                });
                total.added += lines.added;
                total.removed += lines.removed;
            }
            None => locations.push(ToolLocation {
                path: path.clone(),
                change: Some(match old_text {
                    None => FileChange::Created,
                    Some(_) => FileChange::Modified,
                }),
                lines: Some(lines),
            }),
        }
    }
    locations
}

/// Lines a diff from `old` (none for a new file) to `new` adds and removes,
/// by the shortest edit between their lines.
pub(crate) fn line_changes(old: Option<&str>, new: &str) -> LineChanges {
    let old: Vec<&str> = old.map(|text| text.lines().collect()).unwrap_or_default();
    let new: Vec<&str> = new.lines().collect();
    let head = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (old, new) = (&old[head..old.len() - tail], &new[head..new.len() - tail]);
    let (n, m) = (old.len(), new.len());
    let limit = MAX_EDIT.min(MAX_WORK / (n + m).max(1)).max(1);
    match edit_distance(old, new, limit) {
        // The shortest edit deletes `(n - m + d) / 2` lines and inserts the rest.
        Some(d) => LineChanges {
            added: ((m + d - n) / 2) as u64,
            removed: ((n + d - m) / 2) as u64,
        },
        None => LineChanges {
            added: m as u64,
            removed: n as u64,
        },
    }
}

/// Myers' greedy shortest edit: the number of inserted and deleted lines
/// between `a` and `b`, or `None` beyond `limit`.
fn edit_distance(a: &[&str], b: &[&str], limit: usize) -> Option<usize> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = limit.min(a.len() + b.len()) as isize;
    let offset = max + 1;
    let mut furthest = vec![0isize; 2 * max as usize + 3];
    for d in 0..=max {
        for k in (-d..=d).step_by(2) {
            let index = (k + offset) as usize;
            let mut x = if k == -d || (k != d && furthest[index - 1] < furthest[index + 1]) {
                furthest[index + 1]
            } else {
                furthest[index - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            furthest[index] = x;
            if x >= n && y >= m {
                return Some(d as usize);
            }
        }
    }
    None
}

/// Directory of the Space a Svode MCP call with `space_id` addresses from
/// `cwd`: the root project for `root`, a registered child Space by its id,
/// else the most specific ready child Space containing `cwd`. Outside a
/// readable project, `cwd` itself.
fn space_dir(cwd: &Path, space_id: Option<&str>) -> PathBuf {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let Some(project) = project_for_directory(&cwd) else {
        return cwd;
    };
    let project = project.canonicalize().unwrap_or(project);
    match space_id {
        Some(ROOT_SPACE_ID) => project,
        Some(id) => resolve_space_target(&project, Some(id))
            .map(|target| target.space_path)
            .unwrap_or(cwd),
        None => ready_child_space_for_directory(&project, &cwd)
            .map(|(_, path)| path)
            .unwrap_or(project),
    }
}

/// `path` relative to `space` as an absolute path; a path the agent sent
/// that leaves the Space is not kept.
fn inside(space: &Path, path: &str) -> Option<String> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    // Joined part by part, so the path has the separators of this platform.
    let path = relative
        .components()
        .fold(space.to_path_buf(), |path, part| path.join(part))
        .to_string_lossy()
        .into_owned();
    (path.len() <= URI_LIMIT).then_some(path)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn lines(added: u64, removed: u64) -> LineChanges {
        LineChanges { added, removed }
    }

    #[test]
    fn line_changes_count_the_shortest_edit() {
        assert_eq!(line_changes(Some("a\nb\nc"), "a\nb\nc"), lines(0, 0));
        assert_eq!(line_changes(None, "a\nb\n"), lines(2, 0));
        assert_eq!(line_changes(Some("one\ntwo"), "one\n2"), lines(1, 1));
        assert_eq!(
            line_changes(Some("a\nb\nc\nd"), "a\nx\nc\nd\ne"),
            lines(2, 1)
        );
        assert_eq!(line_changes(Some("a\nb\nc"), "c\nb\na"), lines(2, 2));
        assert_eq!(line_changes(Some("x\ny"), ""), lines(0, 2));
    }

    #[test]
    fn an_edit_beyond_the_bound_counts_the_replaced_middle() {
        let a: Vec<&str> = vec!["a"; 10];
        let b: Vec<&str> = vec!["b"; 10];
        assert_eq!(edit_distance(&a, &b, 5), None);
        assert_eq!(edit_distance(&a, &b, 20), Some(20));
    }

    #[test]
    fn diffs_and_agent_locations_merge_without_repeats() {
        let mut paths = ToolPaths::default();
        paths.update(
            Some(AgentAdapterKind::ClaudeCode),
            Path::new("/p"),
            Some(vec!["/p/a.txt".into(), "/p/b.txt".into()]),
            Some(&[
                DetailBlock::Diff {
                    path: "/p/a.txt".into(),
                    old_text: Some("one\ntwo".into()),
                    new_text: "one\n2".into(),
                },
                DetailBlock::Diff {
                    path: "/p/a.txt".into(),
                    old_text: Some("x".into()),
                    new_text: "x\ny".into(),
                },
                DetailBlock::Diff {
                    path: "/p/new.txt".into(),
                    old_text: None,
                    new_text: "n".into(),
                },
            ]),
            Vec::new(),
        );
        assert_eq!(
            paths.locations(ToolKind::Edit, Some(ItemStatus::Completed)),
            vec![
                ToolLocation {
                    path: "/p/a.txt".into(),
                    change: Some(FileChange::Modified),
                    lines: Some(lines(2, 1)),
                },
                ToolLocation {
                    path: "/p/new.txt".into(),
                    change: Some(FileChange::Created),
                    lines: Some(lines(1, 0)),
                },
                ToolLocation {
                    path: "/p/b.txt".into(),
                    change: None,
                    lines: None,
                },
            ]
        );
        assert_eq!(
            paths.locations(ToolKind::Delete, None)[2].change,
            Some(FileChange::Deleted)
        );
    }

    #[test]
    fn a_path_leaving_the_space_is_not_kept() {
        let space = Path::new("/p");
        assert_eq!(inside(space, "notes/a.md"), Some("/p/notes/a.md".into()));
        assert_eq!(inside(space, "../a.md"), None);
        assert_eq!(inside(space, "/etc/passwd"), None);
        assert_eq!(inside(space, ""), None);
    }

    #[test]
    fn the_space_of_a_call_is_resolved_from_the_session_directory() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".svode")).unwrap();
        std::fs::write(root.join(".svode/config.json"), json!({}).to_string()).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        assert_eq!(space_dir(&root.join("notes"), Some("root")), root);
        assert_eq!(space_dir(&root, None), root);
        assert_eq!(space_dir(&root, Some("missing")), root);
        let outside = tempfile::tempdir().unwrap();
        let outside = outside.path().canonicalize().unwrap();
        assert_eq!(space_dir(&outside, None), outside);
    }
}
