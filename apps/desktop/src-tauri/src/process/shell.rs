use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

pub(crate) fn login_shell() -> String {
    select_login_shell(std::env::var("SHELL").ok().as_deref(), |command| {
        if Path::new(command).is_absolute() {
            Path::new(command).is_file()
        } else {
            which::which(command).is_ok()
        }
    })
}

/// Stdout of a short shell script, at most `max_bytes`, within `deadline`;
/// the shell is killed when it hangs, fails or prints too much.
pub(crate) async fn read_output(
    mut command: tokio::process::Command,
    deadline: Duration,
    max_bytes: u64,
) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind};
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
        stdout.take(max_bytes + 1).read_to_end(&mut output).await?;
        if output.len() as u64 > max_bytes {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "shell output exceeds limit",
            ));
        }
        if !child.wait().await?.success() {
            return Err(Error::other("shell command failed"));
        }
        Ok(output)
    })
    .await
    .unwrap_or_else(|_| Err(Error::new(ErrorKind::TimedOut, "shell timed out")));
    if result.is_err() {
        // Reap the direct child even when startup hangs or leaves stdout open.
        let _ = child.kill().await;
    }
    result
}

pub(crate) fn select_login_shell(env_shell: Option<&str>, exists: impl Fn(&str) -> bool) -> String {
    if let Some(shell) = env_shell.filter(|shell| !shell.trim().is_empty() && exists(shell)) {
        return shell.to_string();
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|candidate| exists(candidate))
        .unwrap_or("/bin/sh")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_shell_prefers_valid_shell_env() {
        assert_eq!(
            select_login_shell(Some("/custom/zsh"), |candidate| candidate == "/custom/zsh"),
            "/custom/zsh",
        );
    }

    #[test]
    fn unix_shell_falls_back_to_standard_shells() {
        for env_shell in [None, Some(""), Some("/missing/shell")] {
            assert_eq!(
                select_login_shell(env_shell, |candidate| candidate == "/bin/bash"),
                "/bin/bash"
            );
        }
        assert_eq!(select_login_shell(None, |_| false), "/bin/sh");
    }
}
