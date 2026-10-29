//! The launcher through which the Codex adapter runs the user's Codex
//! (DF-213). `codex-acp` closes a session only by unsubscribing from its
//! thread, and `codex app-server` keeps an unsubscribed thread loaded with
//! its writer lock for `thread_unload_delay_secs` (60 s up to Codex 0.162,
//! 1800 s since 0.163), so the TUI and other clients cannot continue a
//! session Svode no longer drives. The adapter passes `app-server` no
//! arguments of Svode's, so its `CODEX_PATH` names this launcher: the
//! launcher runs the executable Svode resolved, adds
//! `-c thread_unload_delay_secs=0` to `app-server` only, and gives Codex the
//! environment of a direct launch. The user's Codex configuration, daemon
//! and terminals are untouched.
//!
//! Temporary: it goes once the pinned `codex-acp` lets Svode set the
//! configuration of its app-server process, or once Codex unloads a thread
//! when its last subscriber leaves.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The variable through which the launcher receives the Codex executable;
/// it never reaches Codex.
pub(super) const CODEX_EXECUTABLE_ENV: &str = "SVODE_CODEX_EXECUTABLE";

#[cfg(unix)]
const LAUNCHER_NAME: &str = "svode-codex";
#[cfg(unix)]
const LAUNCHER_SCRIPT: &str = r#"#!/bin/sh
# Written by Svode: the app-server of a Svode connection unloads a thread as
# soon as its last subscriber leaves. Codex gets the environment of a direct
# launch.
CODEX_PATH=$SVODE_CODEX_EXECUTABLE
unset SVODE_CODEX_EXECUTABLE
if [ "$1" = app-server ]; then
  exec "$CODEX_PATH" "$@" -c thread_unload_delay_secs=0
fi
exec "$CODEX_PATH" "$@"
"#;

/// `codex-acp` runs it through `cmd.exe` like any `.cmd`. Each line expands
/// its variables before running, so Codex starts after `CODEX_PATH` is
/// restored and the launcher's variable is cleared; no parentheses, so an
/// argument with `)` cannot end a block.
#[cfg(windows)]
const LAUNCHER_NAME: &str = "svode-codex.cmd";
#[cfg(windows)]
const LAUNCHER_SCRIPT: &str = concat!(
    "@echo off\r\n",
    "rem Written by Svode: the app-server of a Svode connection unloads a thread\r\n",
    "rem as soon as its last subscriber leaves. Codex gets the environment of a\r\n",
    "rem direct launch.\r\n",
    "setlocal DisableDelayedExpansion\r\n",
    "if not \"%~1\"==\"app-server\" goto other\r\n",
    "set \"CODEX_PATH=%SVODE_CODEX_EXECUTABLE%\" & set \"SVODE_CODEX_EXECUTABLE=\" & \"%SVODE_CODEX_EXECUTABLE%\" %* -c thread_unload_delay_secs=0\r\n",
    "exit /b %ERRORLEVEL%\r\n",
    ":other\r\n",
    "set \"CODEX_PATH=%SVODE_CODEX_EXECUTABLE%\" & set \"SVODE_CODEX_EXECUTABLE=\" & \"%SVODE_CODEX_EXECUTABLE%\" %*\r\n",
    "exit /b %ERRORLEVEL%\r\n",
);

/// The launcher in the adapter installation `dir`, written or rewritten
/// when it is missing or differs from this version's. A launcher another
/// launch plan writes at the same time is replaced whole, never mixed.
pub(super) fn codex_launcher(dir: &Path) -> io::Result<PathBuf> {
    let path = dir.join(LAUNCHER_NAME);
    if is_current(&path) {
        return Ok(path);
    }
    let staging = dir.join(format!(".{LAUNCHER_NAME}-{}", ulid::Ulid::new()));
    let written = write_executable(&staging).and_then(|()| fs::rename(&staging, &path));
    if written.is_err() {
        let _ = fs::remove_file(&staging);
    }
    written.map(|()| path)
}

fn is_current(path: &Path) -> bool {
    fs::read(path).is_ok_and(|content| content == LAUNCHER_SCRIPT.as_bytes()) && {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}

fn write_executable(path: &Path) -> io::Result<()> {
    fs::write(path, LAUNCHER_SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::{Command, Output, Stdio};

    use super::*;

    /// A stand-in for Codex: it reports its arguments and environment on
    /// stderr, copies stdin to stdout and exits with 7.
    #[cfg(unix)]
    fn fake_codex(dir: &Path) -> PathBuf {
        let path = dir.join("codex");
        svode_testkit::write_executable(
            &path,
            r#"#!/bin/sh
for arg in "$@"; do printf 'arg=%s\n' "$arg" >&2; done
if [ "$CODEX_PATH" = "$SVODE_TEST_CODEX" ]; then echo codex_path=codex >&2; else echo codex_path=other >&2; fi
if [ "${SVODE_CODEX_EXECUTABLE+set}" = set ]; then echo launcher_variable=set >&2; else echo launcher_variable=unset >&2; fi
cat
exit 7
"#,
        )
        .unwrap();
        path
    }

    #[cfg(windows)]
    fn fake_codex(dir: &Path) -> PathBuf {
        let path = dir.join("codex.cmd");
        fs::write(
            &path,
            concat!(
                "@echo off\r\n",
                ">&2 echo argv=%*\r\n",
                "if \"%CODEX_PATH%\"==\"%SVODE_TEST_CODEX%\" (>&2 echo codex_path=codex) else (>&2 echo codex_path=other)\r\n",
                "if defined SVODE_CODEX_EXECUTABLE (>&2 echo launcher_variable=set) else (>&2 echo launcher_variable=unset)\r\n",
                "findstr \"^\"\r\n",
                "exit /b 7\r\n",
            ),
        )
        .unwrap();
        path
    }

    /// The arguments the fake Codex received; the test arguments have no
    /// spaces, so the raw command line of `cmd.exe` splits on them, and
    /// only the quotes it may keep around an argument are dropped.
    fn received_args(stderr: &str) -> Vec<String> {
        if cfg!(windows) {
            stderr
                .lines()
                .find_map(|line| line.strip_prefix("argv="))
                .unwrap_or_default()
                .split_whitespace()
                .map(|arg| arg.trim_matches('"').to_string())
                .collect()
        } else {
            stderr
                .lines()
                .filter_map(|line| line.strip_prefix("arg="))
                .map(str::to_string)
                .collect()
        }
    }

    /// Runs the launcher as the adapter does: `CODEX_PATH` is the launcher,
    /// the launcher's variable the Codex executable.
    fn run(launcher: &Path, codex: &Path, args: &[&str]) -> Output {
        let mut attempts = 0;
        let mut child = loop {
            let spawned = Command::new(launcher)
                .args(args)
                .env("CODEX_PATH", launcher)
                .env(CODEX_EXECUTABLE_ENV, codex)
                .env("SVODE_TEST_CODEX", codex)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();
            match spawned {
                // A process another test thread spawns while the launcher
                // is written holds its descriptor until that process execs.
                Err(error)
                    if error.kind() == io::ErrorKind::ExecutableFileBusy && attempts < 50 =>
                {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                spawned => break spawned.unwrap(),
            }
        };
        child.stdin.take().unwrap().write_all(b"ping\n").unwrap();
        child.wait_with_output().unwrap()
    }

    /// Directories with spaces and non-ASCII names, like a data directory
    /// under a user's home and a Codex the user put anywhere.
    fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("Svode данные").join("codex").join("2.1.1");
        let bin = root.path().join("Codex путь");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&bin).unwrap();
        (root, data, bin)
    }

    #[test]
    fn app_server_unloads_threads_at_once_and_codex_gets_the_direct_environment() {
        let (_root, data, bin) = dirs();
        let codex = fake_codex(&bin);
        let launcher = codex_launcher(&data).unwrap();
        assert_eq!(launcher, data.join(LAUNCHER_NAME));

        for (args, expected) in [
            (
                &["app-server"][..],
                &["app-server", "-c", "thread_unload_delay_secs=0"][..],
            ),
            (
                &["app-server", "-c", "hooks={}"][..],
                &[
                    "app-server",
                    "-c",
                    "hooks={}",
                    "-c",
                    "thread_unload_delay_secs=0",
                ][..],
            ),
            (
                &["login", "--device-auth"][..],
                &["login", "--device-auth"][..],
            ),
            (&["--version"][..], &["--version"][..]),
        ] {
            let output = run(&launcher, &codex, args);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(received_args(&stderr), expected, "{args:?}: {stderr}");
            assert!(stderr.contains("codex_path=codex"), "{args:?}: {stderr}");
            assert!(
                stderr.contains("launcher_variable=unset"),
                "{args:?}: {stderr}"
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim_end(),
                "ping",
                "{args:?}"
            );
            assert_eq!(output.status.code(), Some(7), "{args:?}");
        }
    }

    #[test]
    fn a_missing_or_changed_launcher_is_written_again() {
        let (_root, data, _bin) = dirs();
        let launcher = codex_launcher(&data).unwrap();
        assert_eq!(fs::read_to_string(&launcher).unwrap(), LAUNCHER_SCRIPT);

        fs::write(&launcher, "an older launcher").unwrap();
        assert_eq!(codex_launcher(&data).unwrap(), launcher);
        assert_eq!(fs::read_to_string(&launcher).unwrap(), LAUNCHER_SCRIPT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o644)).unwrap();
            codex_launcher(&data).unwrap();
            assert_eq!(
                fs::metadata(&launcher).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        fs::remove_file(&launcher).unwrap();
        assert_eq!(codex_launcher(&data).unwrap(), launcher);
        assert!(launcher.is_file());
        // No staging file is left beside the launcher.
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
    }
}
