//! The SSH defaults of every Git process Svode starts (DF-378 R1, R2): a time
//! limit for each SSH connection and one retry of git-lfs, both left out
//! where the user set their own.

use std::ffi::OsString;
use std::path::Path;

use super::{UserSsh, configure_std_process_env, ssh_defaults, user_ssh, user_ssh_blocking};

fn pairs(env: Vec<(OsString, OsString)>) -> Vec<(String, String)> {
    env.into_iter()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn owned(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[test]
fn the_defaults_leave_out_what_the_user_set() {
    let none = UserSsh::default();
    assert_eq!(
        pairs(ssh_defaults(none, Some(0))),
        owned(&[
            ("GIT_SSH_COMMAND", "ssh -o ConnectTimeout=10"),
            ("GIT_CONFIG_KEY_0", "lfs.ssh.retries"),
            ("GIT_CONFIG_VALUE_0", "1"),
            ("GIT_CONFIG_COUNT", "1"),
        ])
    );
    // Entries the environment already holds stay in place.
    assert_eq!(
        pairs(ssh_defaults(none, Some(2)))[1..],
        owned(&[
            ("GIT_CONFIG_KEY_2", "lfs.ssh.retries"),
            ("GIT_CONFIG_VALUE_2", "1"),
            ("GIT_CONFIG_COUNT", "3"),
        ])
    );
    assert_eq!(
        pairs(ssh_defaults(none, None)),
        owned(&[("GIT_SSH_COMMAND", "ssh -o ConnectTimeout=10")])
    );
    let command = UserSsh {
        command: true,
        retries: false,
    };
    assert!(
        pairs(ssh_defaults(command, Some(0)))
            .iter()
            .all(|(key, _)| key != "GIT_SSH_COMMAND")
    );
    let both = UserSsh {
        command: true,
        retries: true,
    };
    assert!(ssh_defaults(both, Some(0)).is_empty());
}

fn git(cwd: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Whether Git itself finds `key` in the configuration of `repo`.
fn configured(repo: &Path, key: &str) -> bool {
    std::process::Command::new("git")
        .args(["config", "--get", key])
        .current_dir(repo)
        .output()
        .unwrap()
        .status
        .success()
}

/// The settings are read from the configuration Git applies in the
/// directory, by both the blocking and the asynchronous read.
#[tokio::test]
async fn the_settings_of_the_user_come_from_the_configuration_of_the_directory() {
    let temp = tempfile::tempdir().unwrap();
    let git_path = crate::page::dates::detect_git_binary().unwrap();
    let git_path = git_path.as_os_str();
    let plain = temp.path().join("plain");
    let command = temp.path().join("command");
    let retries = temp.path().join("retries");
    for repo in [&plain, &command, &retries] {
        std::fs::create_dir(repo).unwrap();
        git(repo, &["init", "-q"]);
    }
    git(&command, &["config", "core.sshCommand", "ssh -i key"]);
    git(&retries, &["config", "lfs.ssh.retries", "3"]);

    for (repo, expected_command, expected_retries) in [
        (&command, true, configured(&command, "lfs.ssh.retries")),
        (&retries, configured(&retries, "core.sshCommand"), true),
        // The configuration of this machine decides for a plain repository.
        (
            &plain,
            configured(&plain, "core.sshCommand"),
            configured(&plain, "lfs.ssh.retries"),
        ),
    ] {
        let found = user_ssh(git_path, Some(repo)).await;
        let in_env = std::env::var_os("GIT_SSH_COMMAND").is_some_and(|v| !v.is_empty())
            || std::env::var_os("GIT_SSH").is_some_and(|v| !v.is_empty());
        assert_eq!(found.retries, expected_retries, "{repo:?}");
        assert_eq!(found.command, expected_command || in_env, "{repo:?}");
        assert_eq!(user_ssh_blocking(git_path, Some(repo)), found, "{repo:?}");
    }
}

/// A setting Svode writes through [`super::GitCli`] applies to the next Git
/// process, not only after the read of the settings expires.
#[tokio::test]
async fn a_setting_svode_writes_applies_at_once() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git(repo, &["init", "-q"]);
    let git_path = crate::page::dates::detect_git_binary().unwrap();
    let cli = super::GitCli::for_test(git_path.clone());
    let before = user_ssh(git_path.as_os_str(), Some(repo)).await;
    assert_eq!(before.retries, configured(repo, "lfs.ssh.retries"));
    if before.retries {
        return;
    }
    let write = cli
        .exec(repo, &["config", "lfs.ssh.retries", "3"])
        .await
        .unwrap();
    assert_eq!(write.exit_code, 0, "{}", write.stderr);
    assert!(user_ssh(git_path.as_os_str(), Some(repo)).await.retries);
}

/// A Git process of a blocking caller gets the same defaults.
#[test]
fn a_blocking_git_process_gets_the_defaults() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git(repo, &["init", "-q"]);
    let git_path = crate::page::dates::detect_git_binary().unwrap();
    let mut command = std::process::Command::new(&git_path);
    configure_std_process_env(&mut command, Some(repo));
    let expected = !configured(repo, "core.sshCommand")
        && std::env::var_os("GIT_SSH_COMMAND").is_none()
        && std::env::var_os("GIT_SSH").is_none();
    let ssh_command = command
        .get_envs()
        .find(|(key, _)| *key == "GIT_SSH_COMMAND")
        .and_then(|(_, value)| value);
    assert_eq!(
        ssh_command.is_some_and(|value| value == "ssh -o ConnectTimeout=10"),
        expected
    );
    assert_eq!(command.get_current_dir(), Some(repo));
}

#[cfg(unix)]
mod processes {
    use std::path::{Path, PathBuf};

    use crate::git::cli::GitCli;
    use crate::git::state::GitRuntime;
    use crate::storage::config::{AssetsSpaceConfig, AssetsStrategy};
    use crate::storage::connection::{LfsNotReady, check_readiness};

    const REMOTE: &str = "ssh://git@files.example.test:2222/space.git";

    /// An `ssh` that records its arguments, one call per line, to `log` and
    /// fails as for a host that does not answer.
    fn unreachable_ssh(path: &Path, log: &Path) {
        svode_testkit::write_executable(
            path,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n\
                 echo 'ssh: connect to host files.example.test port 2222: Operation timed out' >&2\n\
                 exit 255\n",
                log.display()
            ),
        )
        .unwrap();
    }

    /// A Git whose processes find the fake `ssh` first in `PATH` and read no
    /// configuration of this machine, a fake SSH command of the user and a
    /// repository whose `origin` is reached by SSH.
    struct Fixture {
        _temp: tempfile::TempDir,
        repo: PathBuf,
        wrapper: PathBuf,
        user_ssh: PathBuf,
        ssh_log: PathBuf,
        user_log: PathBuf,
        cli: GitCli,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let bin = temp.path().join("bin");
            std::fs::create_dir(&bin).unwrap();
            let ssh_log = temp.path().join("ssh.log");
            let user_log = temp.path().join("user-ssh.log");
            unreachable_ssh(&bin.join("ssh"), &ssh_log);
            let user_ssh = temp.path().join("user-ssh");
            unreachable_ssh(&user_ssh, &user_log);
            let global = temp.path().join("gitconfig");
            std::fs::write(
                &global,
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n",
            )
            .unwrap();
            let wrapper = temp.path().join("git-test");
            svode_testkit::write_executable(
                &wrapper,
                format!(
                    "#!/bin/sh\nexport PATH='{}':\"$PATH\" GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
                    bin.display(),
                    global.display()
                ),
            )
            .unwrap();
            let repo = temp.path().join("repo");
            std::fs::create_dir(&repo).unwrap();
            let f = Self {
                cli: GitCli::for_test(wrapper.clone()),
                _temp: temp,
                repo,
                wrapper,
                user_ssh,
                ssh_log,
                user_log,
            };
            f.git(&["init", "-q", "-b", "main"]);
            f.git(&["remote", "add", "origin", REMOTE]);
            f
        }

        fn git(&self, args: &[&str]) {
            let output = std::process::Command::new(&self.wrapper)
                .args(args)
                .current_dir(&self.repo)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        /// A commit with the pointer of an LFS object this clone lacks.
        fn missing_lfs_object(&self) {
            std::fs::write(
                self.repo.join(".gitattributes"),
                "*.bin filter=lfs diff=lfs merge=lfs -text\n",
            )
            .unwrap();
            std::fs::write(
                self.repo.join("a.bin"),
                "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
            )
            .unwrap();
            self.git(&[
                "-c",
                "filter.lfs.clean=cat",
                "-c",
                "filter.lfs.required=false",
                "add",
                ".",
            ]);
            self.git(&["commit", "-qm", "pointer"]);
        }

        fn calls(log: &Path) -> Vec<String> {
            std::fs::read_to_string(log)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        fn ssh_calls(&self) -> Vec<String> {
            Self::calls(&self.ssh_log)
        }

        fn user_calls(&self) -> Vec<String> {
            Self::calls(&self.user_log)
        }

        /// The probe of the `lfs-remote` readiness: its outcome and the
        /// `git-lfs-authenticate` attempts among the SSH calls of `calls`.
        async fn probe(&self) -> (Result<(), LfsNotReady>, usize) {
            let git = GitRuntime::with_cli(self.cli.clone());
            let config = AssetsSpaceConfig {
                strategy: AssetsStrategy::LfsRemote,
                ..AssetsSpaceConfig::default()
            };
            let outcome = check_readiness(&git, &self.repo, &config, false)
                .await
                .map(|_| ());
            let attempts = self
                .ssh_calls()
                .iter()
                .filter(|call| call.contains("git-lfs-authenticate"))
                .count();
            (outcome, attempts)
        }
    }

    fn lfs_available() -> bool {
        std::process::Command::new("git")
            .args(["lfs", "version"])
            .output()
            .is_ok_and(|out| out.status.success())
    }

    /// Whether Svode runs with an SSH command of the user in its environment,
    /// which these tests do not set up.
    fn user_command_in_env() -> bool {
        std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some()
    }

    #[tokio::test]
    async fn a_network_git_call_connects_with_the_time_limit() {
        if user_command_in_env() {
            return;
        }
        let f = Fixture::new();
        let out = f.cli.exec(&f.repo, &["fetch", "origin"]).await.unwrap();
        assert_ne!(out.exit_code, 0);
        let calls = f.ssh_calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].starts_with("-o ConnectTimeout=10 "), "{calls:?}");
        assert!(calls[0].contains("-p 2222"), "{calls:?}");
    }

    /// One git-lfs operation against a host that does not answer makes at
    /// most three connections, each with the time limit: `git-lfs-transfer`
    /// and two attempts of `git-lfs-authenticate`. The probe reads it as a
    /// server out of reach, not a refusal of access.
    #[tokio::test]
    async fn the_lfs_readiness_probe_connects_at_most_three_times_with_the_time_limit() {
        if user_command_in_env() || !lfs_available() {
            return;
        }
        let f = Fixture::new();
        f.missing_lfs_object();
        let (outcome, attempts) = f.probe().await;
        assert!(
            matches!(outcome, Err(LfsNotReady::RemoteOffline)),
            "{outcome:?}"
        );
        let calls = f.ssh_calls();
        assert!(!calls.is_empty() && calls.len() <= 3, "{calls:?}");
        assert!(
            calls
                .iter()
                .all(|call| call.starts_with("-o ConnectTimeout=10 ")),
            "{calls:?}"
        );
        assert_eq!(attempts, 2, "{calls:?}");
    }

    /// The retries the user set stay: three retries are four attempts.
    #[tokio::test]
    async fn the_lfs_retries_of_the_user_stay() {
        if user_command_in_env() || !lfs_available() {
            return;
        }
        let f = Fixture::new();
        f.missing_lfs_object();
        f.git(&["config", "lfs.ssh.retries", "3"]);
        let (_, attempts) = f.probe().await;
        assert_eq!(attempts, 4, "{:?}", f.ssh_calls());
    }

    /// `core.sshCommand` of the repository runs as the user set it, for Git
    /// and for git-lfs.
    #[tokio::test]
    async fn the_ssh_command_of_the_user_in_the_configuration_gets_no_time_limit() {
        let f = Fixture::new();
        f.git(&["config", "core.sshCommand", f.user_ssh.to_str().unwrap()]);
        let out = f.cli.exec(&f.repo, &["fetch", "origin"]).await.unwrap();
        assert_ne!(out.exit_code, 0);
        if lfs_available() {
            f.missing_lfs_object();
            let (outcome, _) = f.probe().await;
            assert!(outcome.is_err());
        }
        let calls = f.user_calls();
        assert!(!calls.is_empty());
        assert!(
            calls.iter().all(|call| !call.contains("ConnectTimeout")),
            "{calls:?}"
        );
        assert_eq!(f.ssh_calls(), Vec::<String>::new());
    }

    const CHILD_WRAPPER: &str = "SVODE_SSH_CHILD_WRAPPER";
    const CHILD_REPO: &str = "SVODE_SSH_CHILD_REPO";

    /// The Git call of [`an_ssh_command_of_the_user_in_the_environment_gets_no_time_limit`],
    /// run in a process of its own with that environment.
    #[tokio::test]
    async fn ssh_environment_child() {
        let (Some(wrapper), Some(repo)) = (
            std::env::var_os(CHILD_WRAPPER),
            std::env::var_os(CHILD_REPO),
        ) else {
            return;
        };
        let cli = GitCli::for_test(wrapper.into());
        let out = cli
            .exec(Path::new(&repo), &["fetch", "origin"])
            .await
            .unwrap();
        assert_ne!(out.exit_code, 0);
    }

    /// `GIT_SSH_COMMAND` or `GIT_SSH` in the environment of Svode runs as the
    /// user set it.
    #[test]
    fn an_ssh_command_of_the_user_in_the_environment_gets_no_time_limit() {
        for variable in ["GIT_SSH_COMMAND", "GIT_SSH"] {
            let f = Fixture::new();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "git::cli::ssh_tests::processes::ssh_environment_child",
                    "--nocapture",
                ])
                .env_remove("GIT_SSH_COMMAND")
                .env_remove("GIT_SSH")
                .env(variable, &f.user_ssh)
                .env(CHILD_WRAPPER, &f.wrapper)
                .env(CHILD_REPO, &f.repo)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("1 passed;"),
                "{variable}: {stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let calls = f.user_calls();
            assert!(!calls.is_empty(), "{variable}");
            assert!(
                calls.iter().all(|call| !call.contains("ConnectTimeout")),
                "{variable}: {calls:?}"
            );
            assert_eq!(f.ssh_calls(), Vec::<String>::new(), "{variable}");
        }
    }
}
