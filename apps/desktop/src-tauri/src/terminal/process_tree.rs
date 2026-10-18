//! The processes under the shell of a managed PTY (DF-163 R2). Svode started
//! the shell, so its descendants are processes of its own terminal; the
//! process table is read only to follow parent links from that shell, and no
//! other process tells anything about a session.

use std::collections::HashMap;

use sysinfo::{ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

/// A running process in the tree of a PTY shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PtyProcess {
    pub pid: u32,
    /// 0 for the shell itself, 1 for its children and so on.
    pub depth: usize,
    /// Seconds since the epoch; 0 when the start time cannot be read.
    pub start_time: u64,
    /// The name of its executable, as the process table tells it.
    pub name: String,
}

/// One running process of the table: pid, parent, start time and name.
#[derive(Debug, Clone)]
struct TableEntry {
    pid: u32,
    parent: Option<u32>,
    start_time: u64,
    name: String,
}

/// The running processes in the tree of each shell, the shell first and
/// nearer processes before deeper ones. A shell that no longer runs has none.
pub(crate) fn descendants(shells: &[u32]) -> HashMap<u32, Vec<PtyProcess>> {
    if shells.is_empty() {
        return HashMap::new();
    }
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let table = system
        .processes()
        .values()
        // Threads of a process are listed with it on Linux.
        .filter(|process| process.thread_kind().is_none())
        .filter(|process| process.status() != ProcessStatus::Zombie)
        .map(|process| TableEntry {
            pid: process.pid().as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            start_time: process.start_time(),
            name: process.name().to_string_lossy().into_owned(),
        })
        .collect::<Vec<_>>();
    trees(&table, shells)
}

fn trees(table: &[TableEntry], shells: &[u32]) -> HashMap<u32, Vec<PtyProcess>> {
    let by_pid = table
        .iter()
        .map(|entry| (entry.pid, entry))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<u32, Vec<&TableEntry>>::new();
    for entry in table {
        let Some(parent) = entry.parent.and_then(|parent| by_pid.get(&parent)) else {
            continue;
        };
        // A process that started before its recorded parent names the
        // reused pid of a parent that exited.
        if entry.pid != parent.pid && entry.start_time >= parent.start_time {
            children.entry(parent.pid).or_default().push(entry);
        }
    }
    shells
        .iter()
        .map(|shell| {
            let mut tree = Vec::new();
            if let Some(root) = by_pid.get(shell) {
                let mut level = vec![*root];
                let mut depth = 0;
                while !level.is_empty() {
                    let mut next = Vec::new();
                    for entry in level {
                        tree.push(PtyProcess {
                            pid: entry.pid,
                            depth,
                            start_time: entry.start_time,
                            name: entry.name.clone(),
                        });
                        next.extend(children.get(&entry.pid).into_iter().flatten().copied());
                    }
                    level = next;
                    depth += 1;
                }
            }
            (*shell, tree)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, parent: Option<u32>, start_time: u64) -> TableEntry {
        TableEntry {
            pid,
            parent,
            start_time,
            name: format!("p{pid}"),
        }
    }

    fn process(pid: u32, depth: usize, start_time: u64) -> PtyProcess {
        PtyProcess {
            pid,
            depth,
            start_time,
            name: format!("p{pid}"),
        }
    }

    #[test]
    fn a_shell_tree_holds_its_descendants_nearest_first() {
        let table = [
            entry(1, None, 10),
            entry(100, Some(1), 100),
            entry(101, Some(100), 101),
            entry(102, Some(101), 102),
            entry(103, Some(100), 103),
            entry(200, Some(1), 100),
        ];
        let trees = trees(&table, &[100]);
        assert_eq!(
            trees[&100],
            vec![
                process(100, 0, 100),
                process(101, 1, 101),
                process(103, 1, 103),
                process(102, 2, 102),
            ]
        );
    }

    #[test]
    fn a_shell_that_no_longer_runs_has_no_tree() {
        let trees = trees(&[entry(1, None, 10)], &[100]);
        assert_eq!(trees[&100], Vec::new());
    }

    #[test]
    fn a_process_older_than_its_parent_is_not_its_child() {
        let table = [entry(100, None, 100), entry(101, Some(100), 50)];
        assert_eq!(trees(&table, &[100])[&100], vec![process(100, 0, 100)]);
    }

    #[test]
    fn the_running_shell_of_this_test_is_found_with_its_child() {
        let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["-n", "60", "127.0.0.1"]
            } else {
                vec!["60"]
            })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a child process");
        let this = std::process::id();
        let tree = descendants(&[this]).remove(&this).unwrap_or_default();
        child.kill().ok();
        child.wait().ok();
        assert_eq!(tree.first().map(|process| process.pid), Some(this));
        let found = tree
            .iter()
            .find(|process| process.pid == child.id() && process.depth == 1);
        assert!(found.is_some(), "{tree:?}");
        if cfg!(unix) {
            assert_eq!(found.map(|process| process.name.as_str()), Some("sleep"));
        }
    }
}
