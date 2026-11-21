//! Bounded Git calls run as process trees (DF-370 R1, R3): the deadline or a
//! dropped call ends `git` together with everything it started, and nothing
//! of the tree waits on a terminal.

use std::path::Path;
use std::time::{Duration, Instant};

use super::cli::GitCli;

/// The interval at which the processes of [`TREE`] write.
#[cfg(unix)]
const TICK: Duration = Duration::from_millis(50);
#[cfg(windows)]
const TICK: Duration = Duration::from_secs(1);

/// A `git` that leaves a descendant appending to `descendant` and itself
/// appends to `root`, both in the working directory, until killed; on Unix it
/// first writes `<git pid> <descendant pid>` to `pids`.
#[cfg(unix)]
const TREE: &str = "( while :; do echo tick >> descendant; sleep 0.05; done ) &
echo \"$$ $!\" > pids
while :; do echo tick >> root; sleep 0.05; done
";
#[cfg(windows)]
const TREE: &str = "start \"\" /b cmd /d /c \"for /l %%i in (0,0,1) do @(echo tick>>descendant & ping -n 2 127.0.0.1 >nul)\"
for /l %%i in (0,0,1) do @(echo tick>>root & ping -n 2 127.0.0.1 >nul)
";

/// A fake `git` in `dir` running `script`: a shell script on Unix, a batch
/// file on Windows.
fn fake_git(dir: &Path, script: &str) -> GitCli {
    #[cfg(unix)]
    let path = {
        let path = dir.join("git");
        svode_testkit::write_executable(&path, format!("#!/bin/sh\n{script}")).unwrap();
        path
    };
    #[cfg(windows)]
    let path = {
        let path = dir.join("git.cmd");
        let script = format!("@echo off\n{script}").replace('\n', "\r\n");
        std::fs::write(&path, script).unwrap();
        path
    };
    GitCli::for_test(path)
}

/// A temporary directory with a [`TREE`] `git` and the working directory
/// `work` for its files.
pub(crate) fn tree_git() -> (tempfile::TempDir, GitCli, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().unwrap();
    let cli = fake_git(dir.path(), TREE);
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    (dir, cli, work)
}

fn size(work: &Path, name: &str) -> u64 {
    std::fs::metadata(work.join(name)).map_or(0, |meta| meta.len())
}

/// Resolves once both processes of a [`TREE`] have written.
async fn tree_runs(work: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while size(work, "root") == 0 || size(work, "descendant") == 0 {
        assert!(Instant::now() < deadline, "the tree starts");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether no process of a [`TREE`] writes any more.
pub(crate) async fn tree_stopped(work: &Path) -> bool {
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = (size(work, "root"), size(work, "descendant"));
    tokio::time::sleep(TICK * 3).await;
    before == (size(work, "root"), size(work, "descendant"))
}

/// The `git` and descendant pids a [`TREE`] wrote.
#[cfg(unix)]
pub(crate) fn tree_pids(work: &Path) -> (u32, u32) {
    let text = std::fs::read_to_string(work.join("pids")).unwrap();
    let (root, descendant) = text.trim().split_once(' ').unwrap();
    (root.parse().unwrap(), descendant.parse().unwrap())
}

#[tokio::test]
async fn a_call_past_its_deadline_ends_git_with_its_descendants_before_it_returns() {
    let (_dir, cli, work) = tree_git();
    let deadline = if cfg!(windows) {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(3)
    };
    let output = cli
        .exec_sensitive_with_stdin(&work, &["push"], &[], None, deadline)
        .await
        .unwrap();
    assert!(output.is_timed_out());
    assert_eq!(output.exit_code, -2);
    assert!(output.stdout.is_empty());
    assert!(size(&work, "root") > 0 && size(&work, "descendant") > 0);
    #[cfg(unix)]
    {
        use crate::process::probes::{ends, exists};

        let (root, descendant) = tree_pids(&work);
        // Collected before the call returned.
        assert!(!exists(root), "git still runs");
        assert!(ends(descendant).await, "the descendant of git still runs");
    }
    assert!(tree_stopped(&work).await, "the tree still writes");
}

#[tokio::test]
async fn a_dropped_call_ends_git_with_its_descendants() {
    let (_dir, cli, work) = tree_git();
    let mut call = Box::pin(cli.exec_sensitive_with_stdin(
        &work,
        &["push"],
        &[],
        None,
        Duration::from_secs(120),
    ));
    tokio::select! {
        output = &mut call => panic!("the call ended by itself: {output:?}"),
        () = tree_runs(&work) => {}
    }
    drop(call);
    #[cfg(unix)]
    {
        use crate::process::probes::ends;

        let (root, descendant) = tree_pids(&work);
        assert!(ends(root).await, "git still runs");
        assert!(ends(descendant).await, "the descendant of git still runs");
    }
    assert!(tree_stopped(&work).await, "the tree still writes");
}

/// A finished call keeps its output and exit code, and what its `git` left
/// running in the tree ends with the call, also while it holds the pipes of
/// `git` (as every child on Windows does).
#[tokio::test]
async fn a_finished_call_keeps_its_output_and_ends_what_git_left_running() {
    #[cfg(unix)]
    let script = "( while :; do echo tick >> descendant; sleep 0.05; done ) &
echo \"$!\" > pids
while [ ! -s descendant ]; do sleep 0.02; done
read input
printf 'out %s' \"$input\"
printf 'err' >&2
exit 3
";
    #[cfg(windows)]
    let script = "start \"\" /b cmd /d /c \"for /l %%i in (0,0,1) do @(echo tick>>descendant & ping -n 2 127.0.0.1 >nul)\" <nul >nul 2>nul
:wait
if not exist descendant (ping -n 2 127.0.0.1 >nul & goto wait)
set /p input=
echo out %input%
echo err 1>&2
exit /b 3
";
    let dir = tempfile::TempDir::new().unwrap();
    let cli = fake_git(dir.path(), script);
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let output = cli
        .exec_sensitive_with_stdin(&work, &["push"], &[], Some("in\n"), Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(output.exit_code, 3);
    assert_eq!(output.stdout.trim(), "out in");
    assert_eq!(output.stderr.trim(), "err");
    #[cfg(unix)]
    {
        let descendant = std::fs::read_to_string(work.join("pids")).unwrap();
        let descendant = descendant.trim().parse().unwrap();
        assert!(
            crate::process::probes::ends(descendant).await,
            "the descendant of git still runs"
        );
    }
    assert!(tree_stopped(&work).await, "the descendant still writes");
}

/// `svode` in a terminal (R3): the test runs a copy of itself as the leader
/// of a session whose controlling terminal is a new pseudo-terminal.
#[cfg(unix)]
mod terminal {
    use std::ffi::CStr;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::process::CommandExt;

    use super::*;
    use crate::process::probes::ends;

    /// Set for the copy of the test binary that owns the terminal: the
    /// directory of its fake `git`s.
    const OWNER_DIR: &str = "SVODE_TEST_TERMINAL_OWNER_DIR";

    /// A new pseudo-terminal: its master and its slave.
    fn pseudo_terminal() -> Option<(File, File)> {
        // SAFETY: each descriptor is checked before use and owned by a
        // `File` once valid; `ptsname` is read at once, before another call
        // on this thread could reuse its buffer.
        unsafe {
            let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if master < 0 {
                return None;
            }
            let master = File::from_raw_fd(master);
            libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
            if libc::grantpt(master.as_raw_fd()) != 0 || libc::unlockpt(master.as_raw_fd()) != 0 {
                return None;
            }
            let name = libc::ptsname(master.as_raw_fd());
            if name.is_null() {
                return None;
            }
            let name = CStr::from_ptr(name).to_owned();
            let slave = libc::open(
                name.as_ptr(),
                libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
            );
            if slave < 0 {
                return None;
            }
            Some((master, File::from_raw_fd(slave)))
        }
    }

    #[tokio::test]
    async fn in_a_terminal_git_gets_no_prompt_and_an_interrupt_ends_its_tree() {
        let Some((master, slave)) = pseudo_terminal() else {
            eprintln!("no pseudo-terminal here, skipped");
            return;
        };
        let dir = tempfile::TempDir::new().unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "git::sensitive_tree_tests::terminal::the_owner_of_a_terminal",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env(OWNER_DIR, dir.path())
            .stdin(slave.try_clone().unwrap())
            .stdout(slave.try_clone().unwrap())
            .stderr(slave);
        // SAFETY: `setsid` and `ioctl` are async-signal-safe; the slave is
        // the new stdin by then.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut owner = command.spawn().unwrap();
        drop(command);
        let mut input = master.try_clone().unwrap();
        // What the owner wrote to its terminal, for the failure messages.
        let transcript = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        std::thread::spawn({
            let transcript = transcript.clone();
            move || {
                let mut master = master;
                let mut buffer = [0u8; 4096];
                // EOF or EIO once the owner and its processes have closed it.
                while let Ok(read @ 1..) = master.read(&mut buffer) {
                    transcript
                        .lock()
                        .unwrap()
                        .extend_from_slice(&buffer[..read]);
                }
            }
        });
        let transcript = move || String::from_utf8_lossy(&transcript.lock().unwrap()).into_owned();

        let work = dir.path().join("tree/work");
        let deadline = Instant::now() + Duration::from_secs(60);
        while size(&work, "root") == 0 || size(&work, "descendant") == 0 {
            if Instant::now() > deadline || owner.try_wait().unwrap().is_some() {
                let _ = owner.kill();
                let _ = owner.wait();
                drop(input);
                panic!("the owner did not start the tree: {}", transcript());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Ctrl-C.
        input.write_all(b"\x03").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = owner.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > deadline {
                let _ = owner.kill();
                break owner.wait().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        drop(input);
        let (root, descendant) = tree_pids(&work);
        let tree_ended = ends(root).await && ends(descendant).await;
        let stopped = tree_stopped(&work).await;
        assert!(status.success(), "the owner failed: {}", transcript());
        assert!(tree_ended, "the tree of git still runs: {}", transcript());
        assert!(stopped, "the tree of git still writes: {}", transcript());
    }

    /// Runs only as the copy started above. Like `svode`, it handles Ctrl-C
    /// by dropping the command it runs.
    #[tokio::test]
    #[ignore = "started by in_a_terminal_git_gets_no_prompt_and_an_interrupt_ends_its_tree"]
    async fn the_owner_of_a_terminal() {
        use tokio::signal::unix::{SignalKind, signal};

        let Some(dir) = std::env::var_os(OWNER_DIR) else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let mut interrupt = signal(SignalKind::interrupt()).unwrap();
        assert!(File::open("/dev/tty").is_ok(), "the owner has a terminal");

        // SSH asking for a passphrase reads the terminal: refused at once,
        // neither stopped in the background nor waiting for an answer.
        let prompt = dir.join("prompt");
        std::fs::create_dir(&prompt).unwrap();
        let cli = fake_git(
            &prompt,
            "if read answer < /dev/tty; then exit 0; fi\nexit 7\n",
        );
        let started = Instant::now();
        let output = cli
            .exec_sensitive_with_stdin(&prompt, &["push"], &[], None, Duration::from_secs(20))
            .await
            .unwrap();
        assert_eq!(output.exit_code, 7, "{output:?}");
        assert!(started.elapsed() < Duration::from_secs(10));

        let tree = dir.join("tree");
        std::fs::create_dir(&tree).unwrap();
        let cli = fake_git(&tree, TREE);
        let work = tree.join("work");
        std::fs::create_dir(&work).unwrap();
        let call =
            cli.exec_sensitive_with_stdin(&work, &["push"], &[], None, Duration::from_secs(60));
        tokio::select! {
            output = call => panic!("the call ended by itself: {output:?}"),
            _ = interrupt.recv() => {}
        }
    }
}
