use std::ffi::{OsStr, OsString};

use tokio::sync::OnceCell;

/// A session snapshot for direct child processes; never mutates the host environment.
#[derive(Default)]
pub(crate) struct ProcessPath {
    path: OnceCell<Option<OsString>>,
}

impl ProcessPath {
    pub(crate) async fn get(&self) -> Option<&OsStr> {
        self.path.get_or_init(discover).await.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn fixed(path: Option<OsString>) -> Self {
        Self {
            path: OnceCell::new_with(Some(path)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn discover() -> Option<OsString> {
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn discover() -> Option<OsString> {
    let mut command = shell_path_command(&super::shell::login_shell());
    // Shell startup must not depend on whichever App happened to launch first.
    command.current_dir(std::env::var_os("HOME").unwrap_or_else(|| "/".into()));
    match read_shell_path(command, std::time::Duration::from_secs(3)).await {
        Ok(path) => Some(path),
        Err(error) => {
            tracing::warn!(
                "Could not read login shell PATH; using inherited process PATH: {error}"
            );
            None
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
const PATH_MARKER: &[u8] = b"\0SVODE_PATH\0";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_OUTPUT_BYTES: u64 = 64 * 1024;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_path_command(shell: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(shell);
    // Match the interactive login shell in the PTY, including .zshrc/.bashrc.
    // This fixed script receives no recipe arguments or resolved App secrets.
    command.args(["-i", "-l", "-c", "printf '\\0SVODE_PATH\\0%s\\0' \"$PATH\""]);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn read_shell_path(
    mut command: tokio::process::Command,
    deadline: std::time::Duration,
) -> std::io::Result<OsString> {
    use std::io::{Error, ErrorKind};
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("shell stdout is piped");
    let result = tokio::time::timeout(deadline, async {
        let mut output = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .await?;
        if output.len() as u64 > MAX_OUTPUT_BYTES {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "shell PATH output exceeds limit",
            ));
        }
        if !child.wait().await?.success() {
            return Err(Error::other("shell PATH command failed"));
        }
        parse_shell_path(&output)
    })
    .await
    .unwrap_or_else(|_| {
        Err(Error::new(
            ErrorKind::TimedOut,
            "shell PATH lookup timed out",
        ))
    });
    if result.is_err() {
        // Reap the direct child even when startup hangs or leaves stdout open.
        let _ = child.kill().await;
    }
    result
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_shell_path(output: &[u8]) -> std::io::Result<OsString> {
    use std::os::unix::ffi::OsStringExt;

    let value = output
        .windows(PATH_MARKER.len())
        .rposition(|window| window == PATH_MARKER)
        .map(|position| &output[position + PATH_MARKER.len()..])
        .and_then(|tail| {
            tail.iter()
                .position(|byte| *byte == 0)
                .map(|end| &tail[..end])
        })
        .filter(|value| !value.is_empty());
    value
        .map(|value| OsString::from_vec(value.to_vec()))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "shell did not return a non-empty PATH",
            )
        })
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::os::unix::ffi::OsStrExt;
    use std::time::Duration;
    use tokio::process::Command;

    #[test]
    fn path_framing_ignores_startup_output_and_preserves_native_bytes() {
        assert_eq!(
            parse_shell_path(b"banner\n\0SVODE_PATH\0/custom path/\xff:/bin\0logout\n")
                .unwrap()
                .as_bytes(),
            b"/custom path/\xff:/bin",
        );
        for output in [
            b"banner only".as_slice(),
            b"\0SVODE_PATH\0\0",
            b"\0SVODE_PATH\0/truncated",
        ] {
            assert_eq!(
                parse_shell_path(output).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
    }

    #[tokio::test]
    async fn rejects_failed_noisy_or_hung_shells_without_hanging_the_caller() {
        let mut failed = Command::new("/bin/sh");
        failed.args(["-c", "exit 7"]);
        assert!(
            read_shell_path(failed, Duration::from_secs(2))
                .await
                .is_err()
        );

        let mut noisy = Command::new("/bin/sh");
        noisy.args(["-c", "while :; do printf 'startup output'; done"]);
        assert_eq!(
            read_shell_path(noisy, Duration::from_secs(2))
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidData
        );

        let mut hung = Command::new("/bin/sh");
        hung.args(["-c", "exec /bin/sleep 30"]);
        assert_eq!(
            read_shell_path(hung, Duration::from_millis(100))
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::TimedOut
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn gui_path_reads_both_login_and_interactive_zsh_configuration() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join(".zprofile"),
            "export SVODE_TEST_LOGIN_BIN=/login-only-bin\n",
        )
        .unwrap();
        std::fs::write(temp.path().join(".zshrc"), "printf 'interactive startup banner\\n'\nexport PATH=\"$SVODE_TEST_LOGIN_BIN:/interactive-only-bin:/usr/bin:/bin\"\n").unwrap();
        let mut command = shell_path_command("/bin/zsh");
        command
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("ZDOTDIR", temp.path());
        let path = read_shell_path(command, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            path,
            OsString::from("/login-only-bin:/interactive-only-bin:/usr/bin:/bin")
        );
    }

    #[tokio::test]
    #[ignore = "manual host smoke: run the test binary with GUI PATH and SVODE_PATH_SMOKE_PROGRAM set"]
    async fn installed_user_command_is_found_with_gui_path() {
        let program =
            std::env::var_os("SVODE_PATH_SMOKE_PROGRAM").expect("set the installed CLI to probe");
        let before = Command::new(&program)
            .arg("--version")
            .output()
            .await
            .unwrap_err();
        assert_eq!(before.kind(), ErrorKind::NotFound);
        let resolver = ProcessPath::default();
        let path = resolver.get().await.expect("login shell PATH");
        let after = Command::new(&program)
            .arg("--version")
            .env("PATH", path)
            .output()
            .await
            .unwrap();
        assert!(after.status.success());
        println!(
            "Recovered {:?}: {}",
            program,
            String::from_utf8_lossy(&after.stdout).trim()
        );
    }
}
