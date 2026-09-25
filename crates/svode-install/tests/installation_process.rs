//! The stable location through real processes: the installer and the
//! launchers run as the built `svode-launcher` binary in a temporary HOME,
//! desktop ownership through the library as the desktop app calls it.
//! Runtime binaries are scripts that print which runtime they belong to.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

use serde_json::Value;
use svode_install::{DesktopRuntime, Layout, Ownership, RuntimeKind, take_desktop_ownership};
use tempfile::TempDir;

const LAUNCHER: &str = env!("CARGO_BIN_EXE_svode-launcher");

/// Starts a binary the test has just written. On Linux a parallel test
/// that forks meanwhile keeps the file open for writing until its child
/// execs, and exec fails with ETXTBSY; the next attempt succeeds.
trait Run {
    fn run(&mut self) -> Output;
    fn start(&mut self) -> Child;
}

impl Run for Command {
    fn run(&mut self) -> Output {
        retry_busy(|| self.output())
    }

    fn start(&mut self) -> Child {
        retry_busy(|| self.spawn())
    }
}

fn retry_busy<T>(mut start: impl FnMut() -> std::io::Result<T>) -> T {
    for _ in 0..50 {
        match start() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            result => return result.unwrap(),
        }
    }
    start().unwrap()
}

struct Machine {
    _dir: TempDir,
    home: PathBuf,
}

impl Machine {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        Self { _dir: dir, home }
    }

    fn layout(&self) -> Layout {
        Layout::at(self.home.join(".svode"))
    }

    fn command(&self, program: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .env_clear()
            .env("HOME", &self.home)
            .env("SHELL", "/bin/zsh")
            .env("PATH", "/usr/bin:/bin")
            .current_dir(&self.home);
        command
    }

    /// An unpacked standalone archive whose binaries print `marker`.
    fn archive(&self, marker: &str) -> PathBuf {
        let root = self.home.join(format!("Downloads/svode-{marker}"));
        runtime_files(&root.join("bin"), &root.join("plugins/svode"), marker);
        root
    }

    /// An installed desktop app whose binaries print `marker`.
    fn desktop(&self, marker: &str) -> (PathBuf, PathBuf) {
        let bundle = self
            .home
            .join(format!("Applications/Svode-{marker}.app/Contents"));
        let (binaries, payload) = (bundle.join("MacOS"), bundle.join("Resources/plugins/svode"));
        runtime_files(&binaries, &payload, marker);
        (binaries, payload)
    }

    fn install(&self, archive: &Path) -> Output {
        self.command(&archive.join("bin/svode-launcher"))
            .arg("install")
            .run()
    }

    fn uninstall(&self) -> Output {
        self.command(&self.layout().active_binary("svode-launcher"))
            .arg("uninstall")
            .run()
    }

    /// Runs the `svode` launcher and returns its stdout.
    fn svode(&self) -> String {
        let output = self
            .command(&self.layout().launcher("svode"))
            .arg("--version")
            .run();
        assert!(output.status.success(), "{}", stderr(&output));
        stdout(&output)
    }
}

fn runtime_files(binaries: &Path, payload: &Path, marker: &str) {
    fs::create_dir_all(binaries).unwrap();
    for name in ["svode", "svode-mcp", "svode-lfs"] {
        let path = binaries.join(name);
        fs::write(&path, format!("#!/bin/sh\necho \"{name} {marker} $*\"\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::copy(LAUNCHER, binaries.join("svode-launcher")).unwrap();
    fs::create_dir_all(payload.join(".claude-plugin")).unwrap();
    fs::create_dir_all(payload.join("skills/svode")).unwrap();
    fs::write(
        payload.join(".claude-plugin/plugin.json"),
        format!("{{\"version\":\"{marker}\"}}"),
    )
    .unwrap();
    fs::write(payload.join("skills/svode/SKILL.md"), marker).unwrap();
}

fn take_desktop(machine: &Machine, binaries: &Path, payload: &Path) -> Ownership {
    take_desktop_ownership(
        &machine.layout(),
        &DesktopRuntime {
            binaries,
            payload,
            version: "0.0.8",
        },
    )
    .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn payload_marker(layout: &Layout) -> String {
    fs::read_to_string(layout.payload().join("skills/svode/SKILL.md")).unwrap()
}

fn runtime_dirs(layout: &Layout) -> usize {
    fs::read_dir(layout.root().join("runtimes"))
        .unwrap()
        .count()
}

#[test]
fn a_clean_standalone_install_needs_no_desktop_and_gives_stable_launchers_and_path() {
    let machine = Machine::new();
    let output = machine.install(&machine.archive("A"));
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("it is the active runtime"),
        "{}",
        stdout(&output)
    );

    let layout = machine.layout();
    assert_eq!(machine.svode(), "svode A --version\n");
    assert_eq!(
        layout.active().unwrap().record.kind,
        RuntimeKind::Standalone
    );
    assert_eq!(payload_marker(&layout), "A");
    // The payload is a copy: the unpacked archive can go.
    fs::remove_dir_all(machine.home.join("Downloads")).unwrap();
    assert_eq!(machine.svode(), "svode A --version\n");
    assert_eq!(payload_marker(&layout), "A");

    // Never a Svode project, no shell metacharacters in any client-facing path.
    assert!(!layout.root().join("config.json").exists());
    for path in [
        layout.launcher("svode"),
        layout.launcher("svode-mcp"),
        layout.payload(),
    ] {
        let relative = path.strip_prefix(&machine.home).unwrap().to_str().unwrap();
        assert!(
            relative
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "./-_".contains(c)),
            "{relative}"
        );
    }
    let zshrc = fs::read_to_string(machine.home.join(".zshrc")).unwrap();
    assert!(
        zshrc.contains("export PATH=\"$HOME/.svode/bin:$PATH\""),
        "{zshrc}"
    );
}

#[test]
fn an_update_switches_the_version_without_breaking_a_running_process() {
    let machine = Machine::new();
    let archive = machine.archive("A");
    fs::write(
        archive.join("bin/svode-mcp"),
        "#!/bin/sh\necho started\nread line\necho \"svode-mcp A $line\"\n",
    )
    .unwrap();
    assert!(machine.install(&archive).status.success());
    let mut running = machine
        .command(&machine.layout().launcher("svode-mcp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .start();
    let mut lines = BufReader::new(running.stdout.take().unwrap()).lines();
    assert_eq!(lines.next().unwrap().unwrap(), "started");

    let output = machine.install(&machine.archive("B"));
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(machine.svode(), "svode B --version\n");
    assert_eq!(payload_marker(&machine.layout()), "B");
    assert_eq!(runtime_dirs(&machine.layout()), 1);

    running
        .stdin
        .take()
        .unwrap()
        .write_all(b"still here\n")
        .unwrap();
    assert_eq!(lines.next().unwrap().unwrap(), "svode-mcp A still here");
    assert!(running.wait().unwrap().success());
}

#[test]
fn desktop_then_standalone_keeps_the_desktop_runtime_and_only_adds_missing_launchers() {
    let machine = Machine::new();
    let (binaries, payload) = machine.desktop("D");
    assert!(matches!(
        take_desktop(&machine, &binaries, &payload),
        Ownership::Taken { previous: None }
    ));
    let layout = machine.layout();
    fs::remove_file(layout.launcher("svode-mcp")).unwrap();

    let output = machine.install(&machine.archive("A"));
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("Svode Desktop 0.0.8 is installed"),
        "{}",
        stdout(&output)
    );
    assert_eq!(machine.svode(), "svode D --version\n");
    assert!(layout.launcher("svode-mcp").is_file());
    assert!(layout.standalone().is_none());
    assert_eq!(payload_marker(&layout), "D");
    assert!(machine.home.join(".zshrc").is_file());

    // Removing the desktop app leaves no standalone runtime to fall back to.
    fs::remove_dir_all(machine.home.join("Applications")).unwrap();
    let output = machine.command(&layout.launcher("svode")).run();
    assert_eq!(output.status.code(), Some(69));
    assert!(
        stderr(&output).contains("Svode Desktop is no longer at"),
        "{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains("hint: Reinstall Svode Desktop"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn standalone_then_desktop_makes_the_desktop_active_and_keeps_the_standalone_runtime() {
    let machine = Machine::new();
    assert!(machine.install(&machine.archive("A")).status.success());
    let (binaries, payload) = machine.desktop("D");
    let taken = take_desktop(&machine, &binaries, &payload);
    let Ownership::Taken {
        previous: Some(previous),
    } = taken
    else {
        panic!("{taken:?}");
    };
    assert_eq!(previous.kind, RuntimeKind::Standalone);

    let layout = machine.layout();
    assert_eq!(machine.svode(), "svode D --version\n");
    assert_eq!(payload_marker(&layout), "D");
    assert_eq!(
        layout.standalone().unwrap().record.kind,
        RuntimeKind::Standalone
    );
    // A later start of the same desktop app changes nothing.
    assert_eq!(
        take_desktop(&machine, &binaries, &payload),
        Ownership::Unchanged
    );
    assert_eq!(runtime_dirs(&layout), 2);

    // Updating the inactive standalone runtime does not switch the version.
    let output = machine.install(&machine.archive("B"));
    assert!(
        stdout(&output).contains("stays the active runtime"),
        "{}",
        stdout(&output)
    );
    assert_eq!(machine.svode(), "svode D --version\n");
    assert_eq!(runtime_dirs(&layout), 2);

    // Without the desktop app the launcher moves to the standalone runtime.
    fs::remove_dir_all(machine.home.join("Applications")).unwrap();
    assert_eq!(machine.svode(), "svode B --version\n");
    assert_eq!(
        layout.active().unwrap().record.kind,
        RuntimeKind::Standalone
    );
    assert_eq!(payload_marker(&layout), "B");
}

#[test]
fn the_mcp_launcher_without_a_runtime_serves_the_reason_over_mcp() {
    let machine = Machine::new();
    let (binaries, payload) = machine.desktop("D");
    take_desktop(&machine, &binaries, &payload);
    fs::remove_dir_all(machine.home.join("Applications")).unwrap();
    let layout = machine.layout();
    // The client's plugin and skill stay loadable.
    assert_eq!(payload_marker(&layout), "D");

    let mut server = machine
        .command(&layout.launcher("svode-mcp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .start();
    server
        .stdin
        .take()
        .unwrap()
        .write_all(
            concat!(
                r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#, "\n",
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, "\n",
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, "\n",
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_page","arguments":{}}}"#, "\n",
            )
            .as_bytes(),
        )
        .unwrap();
    let output = server.wait_with_output().unwrap();
    assert!(output.status.success());
    let responses = stdout(&output)
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "svode");
    assert_eq!(
        responses[1]["result"]["tools"][0]["name"],
        "get_svode_guide"
    );
    let error = &responses[2]["result"]["structuredContent"]["error"];
    assert_eq!(error["code"], "RUNTIME_UNAVAILABLE");
    assert!(
        error["message"].as_str().unwrap().contains("no longer at"),
        "{error}"
    );
}

#[test]
fn launchers_without_any_installation_report_it() {
    let machine = Machine::new();
    let bin = machine.home.join(".svode/bin");
    fs::create_dir_all(&bin).unwrap();
    fs::copy(LAUNCHER, bin.join("svode")).unwrap();
    let output = machine.command(&bin.join("svode")).run();
    assert_eq!(output.status.code(), Some(69));
    assert!(
        stderr(&output).contains("the Svode runtime is not installed"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn uninstall_removes_only_the_standalone_installation() {
    // Inactive: the desktop app keeps its launchers and payload.
    let machine = Machine::new();
    assert!(machine.install(&machine.archive("A")).status.success());
    let (binaries, payload) = machine.desktop("D");
    take_desktop(&machine, &binaries, &payload);
    let output = machine.uninstall();
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("stays the active runtime"),
        "{}",
        stdout(&output)
    );
    let layout = machine.layout();
    assert!(layout.standalone().is_none());
    assert_eq!(runtime_dirs(&layout), 1);
    assert_eq!(machine.svode(), "svode D --version\n");
    assert!(
        !fs::read_to_string(machine.home.join(".zshrc"))
            .unwrap()
            .contains(".svode")
    );

    // Active: the whole stable location and the PATH entry go; other files stay.
    let machine = Machine::new();
    fs::write(machine.home.join(".zshrc"), "alias ll='ls -l'\n").unwrap();
    assert!(machine.install(&machine.archive("A")).status.success());
    let output = machine.uninstall();
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(!machine.layout().root().exists());
    assert_eq!(
        fs::read_to_string(machine.home.join(".zshrc")).unwrap(),
        "alias ll='ls -l'\n"
    );
    assert!(machine.home.join("Downloads/svode-A/bin/svode").is_file());
}

#[test]
fn a_home_that_is_a_svode_project_is_refused() {
    let machine = Machine::new();
    fs::create_dir_all(machine.home.join(".svode")).unwrap();
    fs::write(machine.home.join(".svode/config.json"), "{}").unwrap();
    let output = machine.install(&machine.archive("A"));
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("STABLE_LOCATION_IS_PROJECT"),
        "{}",
        stderr(&output)
    );
    let (binaries, payload) = machine.desktop("D");
    let error = take_desktop_ownership(
        &machine.layout(),
        &DesktopRuntime {
            binaries: &binaries,
            payload: &payload,
            version: "0.0.8",
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "STABLE_LOCATION_IS_PROJECT");
    assert!(!machine.home.join(".svode/bin").exists());
}
