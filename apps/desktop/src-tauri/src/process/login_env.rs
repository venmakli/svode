//! The environment of agent processes (Stage 10 `03` A1): the user's login
//! shell environment, as a terminal launch gets it, so keys from the shell
//! profile work in chat as in the terminal. The shell starts with only the
//! session basics, so variables of whatever launched Svode (such as a parent
//! agent's session markers) never reach an agent. Read once per app session
//! and kept in memory only; it is never stored, logged or diagnosed.

use std::sync::{Arc, LazyLock};

use svode_agents::LaunchEnvironment;
use tokio::sync::OnceCell;

static SESSION: LazyLock<Arc<LoginEnvironment>> = LazyLock::new(Arc::default);

#[derive(Default)]
pub(crate) struct LoginEnvironment {
    environment: OnceCell<Option<LaunchEnvironment>>,
}

impl LoginEnvironment {
    pub(crate) fn session() -> Arc<Self> {
        Arc::clone(&SESSION)
    }

    /// `None` where there is no login shell or it could not be read: the
    /// agent then inherits the app's environment.
    pub(crate) async fn get(&self) -> Option<LaunchEnvironment> {
        self.environment.get_or_init(discover).await.clone()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn discover() -> Option<LaunchEnvironment> {
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn discover() -> Option<LaunchEnvironment> {
    let shell = super::shell::login_shell();
    match read_environment(environment_command(&shell, std::env::vars_os())).await {
        Ok(environment) => Some(environment),
        Err(error) => {
            tracing::warn!(
                "Could not read the login shell environment; agents inherit the app's: {error}"
            );
            None
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
const ENV_MARKER: &[u8] = b"\0SVODE_ENV\0";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_OUTPUT_BYTES: u64 = 512 * 1024;

/// What a login session starts with before the profile runs.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const SESSION_BASICS: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "__CF_USER_TEXT_ENCODING",
];

/// Variables the shell sets about itself rather than the user's session.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const SHELL_OWN: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_"];

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn environment_command(
    shell: &str,
    inherited: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(shell);
    // The interactive login shell of the PTY, .zshrc/.bashrc included.
    command.args(["-i", "-l", "-c", "printf '\\0SVODE_ENV\\0'; env -0"]);
    command.env_clear();
    let mut home = None;
    for (name, value) in inherited {
        if SESSION_BASICS.iter().any(|basic| name == *basic) {
            if name == "HOME" {
                home = Some(value.clone());
            }
            command.env(name, value);
        }
    }
    // Shell startup must not depend on whichever App happened to launch first.
    command.current_dir(home.unwrap_or_else(|| "/".into()));
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn read_environment(command: tokio::process::Command) -> std::io::Result<LaunchEnvironment> {
    let output =
        super::shell::read_output(command, std::time::Duration::from_secs(3), MAX_OUTPUT_BYTES)
            .await?;
    parse_environment(&output)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_environment(output: &[u8]) -> std::io::Result<LaunchEnvironment> {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let start = output
        .windows(ENV_MARKER.len())
        .rposition(|window| window == ENV_MARKER)
        .map(|position| position + ENV_MARKER.len())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "shell did not print its environment",
            )
        })?;
    let variables: Vec<(OsString, OsString)> = output[start..]
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            let split = entry.iter().position(|byte| *byte == b'=')?;
            let (name, value) = (&entry[..split], &entry[split + 1..]);
            (!name.is_empty() && !SHELL_OWN.iter().any(|own| name == own.as_bytes())).then(|| {
                (
                    OsString::from_vec(name.to_vec()),
                    OsString::from_vec(value.to_vec()),
                )
            })
        })
        .collect();
    if !variables.iter().any(|(name, _)| name == "PATH") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "shell environment has no PATH",
        ));
    }
    Ok(LaunchEnvironment::new(variables))
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::*;

    #[test]
    fn the_environment_follows_the_last_marker_without_the_shells_own_variables() {
        let environment = parse_environment(
            b"banner \0SVODE_ENV\0 noise\n\0SVODE_ENV\0PATH=/bin\0KEY=a=b\0PWD=/x\0_=/usr/bin/env\0\0",
        )
        .unwrap();
        assert_eq!(environment.get("PATH"), Some(OsStr::new("/bin")));
        assert_eq!(environment.get("KEY"), Some(OsStr::new("a=b")));
        assert_eq!(environment.get("PWD"), None);
        assert_eq!(environment.get("_"), None);
        assert!(parse_environment(b"no marker").is_err());
        assert!(parse_environment(b"\0SVODE_ENV\0KEY=a\0").is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn profile_variables_reach_the_snapshot_and_launcher_variables_do_not() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join(".zprofile"),
            "export SVODE_TEST_PROFILE_KEY=from-profile\n",
        )
        .unwrap();
        std::fs::write(
            temp.path().join(".zshrc"),
            "export PATH=\"/interactive-only-bin:$PATH\"\n",
        )
        .unwrap();
        let mut command = environment_command(
            "/bin/zsh",
            [
                ("HOME", temp.path().as_os_str()),
                ("PATH", OsStr::new("/usr/bin:/bin")),
                ("CLAUDECODE", OsStr::new("1")),
            ]
            .map(|(name, value)| (OsString::from(name), value.to_os_string())),
        );
        command.env("ZDOTDIR", temp.path());
        let environment = read_environment(command).await.unwrap();
        assert_eq!(
            environment.get("SVODE_TEST_PROFILE_KEY"),
            Some(OsStr::new("from-profile"))
        );
        assert!(
            environment
                .get("PATH")
                .unwrap()
                .to_string_lossy()
                .starts_with("/interactive-only-bin:")
        );
        assert_eq!(environment.get("CLAUDECODE"), None);
    }
}
