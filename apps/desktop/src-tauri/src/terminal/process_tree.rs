//! The processes under the shell of a managed PTY (DF-163 R2). Svode started
//! the shell, so its descendants are processes of its own terminal; the
//! process table is read only to follow parent links from that shell, and no
//! other process tells anything about a session. The command lines are read
//! only for the processes of these trees (DF-225 R2).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind};

/// Interpreters an agent CLI runs under: the process table names the
/// interpreter, and the script it runs names the CLI.
const INTERPRETERS: [&str; 5] = ["node", "nodejs", "bun", "deno", "python"];

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
    /// The file names its command line gives it: what it was started as
    /// and, for an interpreter, the script it runs (DF-225 R2).
    pub command_names: Vec<String>,
}

impl PtyProcess {
    /// Whether the process runs `executable`: by its name, what it was
    /// started as or the script an interpreter runs, an extension such as
    /// `.exe` or `.js` aside.
    pub(crate) fn runs(&self, executable: &str) -> bool {
        std::iter::once(&self.name)
            .chain(&self.command_names)
            .any(|name| {
                Path::new(name)
                    .file_stem()
                    .is_some_and(|stem| stem.eq_ignore_ascii_case(executable))
            })
    }
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
    let mut trees = trees(&table, shells);
    let pids = trees
        .values()
        .flatten()
        .map(|process| Pid::from_u32(process.pid))
        .collect::<Vec<_>>();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    for process in trees.values_mut().flatten() {
        if let Some(entry) = system.process(Pid::from_u32(process.pid)) {
            process.command_names = command_names(&process.name, entry.cmd());
        }
    }
    trees
}

/// The file names of `argv[0]` and, when the process or `argv[0]` is an
/// interpreter, of the script it runs: its first argument that is no
/// option.
fn command_names(name: &str, cmd: &[OsString]) -> Vec<String> {
    let file_name = |arg: &OsString| {
        Path::new(arg)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    };
    let Some((first, args)) = cmd.split_first() else {
        return Vec::new();
    };
    let started_as = file_name(first);
    let interpreted = is_interpreter(name) || started_as.as_deref().is_some_and(is_interpreter);
    let script = interpreted
        .then(|| {
            args.iter()
                .find(|arg| !arg.to_string_lossy().starts_with('-'))
        })
        .flatten()
        .and_then(file_name);
    started_as.into_iter().chain(script).collect()
}

/// Whether the executable is an interpreter of [`INTERPRETERS`], a
/// versioned Python such as `python3.12` included.
fn is_interpreter(name: &str) -> bool {
    let Some(stem) = Path::new(name).file_stem() else {
        return false;
    };
    let stem = stem.to_string_lossy().to_ascii_lowercase();
    let stem = match stem.strip_prefix("python") {
        Some(version) if version.chars().all(|c| c.is_ascii_digit() || c == '.') => "python",
        _ => stem.as_str(),
    };
    INTERPRETERS.contains(&stem)
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
                            command_names: Vec::new(),
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
            command_names: Vec::new(),
        }
    }

    fn args(cmd: &[&str]) -> Vec<OsString> {
        cmd.iter().map(OsString::from).collect()
    }

    impl PtyProcess {
        fn with_name(self, name: &str) -> Self {
            Self {
                name: name.to_string(),
                ..self
            }
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
    fn a_cli_is_told_by_its_name_what_it_was_started_as_or_the_script_its_interpreter_runs() {
        let process = |name: &str, cmd: &[&str]| {
            PtyProcess {
                command_names: command_names(name, &args(cmd)),
                ..process(1, 1, 1)
            }
            .with_name(name)
        };

        // A native binary, also one whose file is named by its version.
        assert!(process("codex", &["codex"]).runs("codex"));
        assert!(process("codex.exe", &[r"C:\bin\codex.exe"]).runs("codex"));
        assert!(process("2.1.312", &["/Users/u/.local/bin/claude"]).runs("claude"));
        // A CLI under its interpreter.
        assert!(
            process(
                "node",
                &["node", "--no-warnings", "/opt/homebrew/bin/claude", "-p"]
            )
            .runs("claude")
        );
        assert!(
            process(
                "node",
                &["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"]
            )
            .runs("codex")
        );
        assert!(
            process(
                "python3.12",
                &[
                    "/u/.local/share/uv/tools/kimi-cli/bin/python",
                    "/u/.local/bin/kimi"
                ]
            )
            .runs("kimi")
        );
        assert!(process("Python", &["/u/.venv/bin/python3", "/u/.local/bin/kimi"]).runs("kimi"));
        // An argument of another program names no CLI.
        assert!(!process("vim", &["vim", "claude"]).runs("claude"));
        assert!(!process("node", &["node", "server.js", "claude"]).runs("claude"));
        assert!(!process("zsh", &["-zsh"]).runs("claude"));
        assert!(!process("node", &[]).runs("claude"));
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
            assert_eq!(
                found.map(|process| process.command_names.clone()),
                Some(vec!["sleep".to_string()]),
                "the command line of a process in the tree is read"
            );
        }
    }
}
