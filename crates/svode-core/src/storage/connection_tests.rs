use std::path::Path;

use super::config::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy};
use super::connection::*;
use super::lfs::LfsState;
use super::s3::{SecretBindings, SecretFailure, owners, register_owner};
use crate::git::state::GitRuntime;
use crate::variables::{Error, SourceOwner, SourceReference};

fn target() -> AssetsS3Config {
    AssetsS3Config {
        endpoint: "http://127.0.0.1:9".into(),
        bucket: "assets".into(),
        region: "us-east-1".into(),
        prefix: "project/root".into(),
        extensions: Default::default(),
    }
}

fn bindings() -> SecretBindings {
    let reference = |name: &str| SourceReference {
        owner: SourceOwner::Global,
        name: name.into(),
    };
    SecretBindings {
        access_key: reference("ACCESS"),
        secret_key: reference("SECRET"),
    }
}

#[test]
fn every_reason_has_its_code_and_next_step_without_a_value() {
    let secret = |error| {
        LfsNotReady::Secret(SecretFailure {
            error,
            name: "S3_KEY".into(),
            file: "/config/secrets.json".into(),
        })
    };
    for (reason, code, step) in [
        (
            LfsNotReady::StrategyMismatch {
                strategy: "in-git".into(),
            },
            Some(STORAGE_STRATEGY_MISMATCH),
            Some("svode storage s3 enable"),
        ),
        (
            LfsNotReady::S3AddressMissing,
            Some(STORAGE_STRATEGY_MISMATCH),
            Some("svode storage s3 enable"),
        ),
        (
            LfsNotReady::S3NotConnected { detail: None },
            Some(S3_NOT_CONNECTED),
            Some("svode storage s3 connect"),
        ),
        (
            LfsNotReady::S3CheckFailed {
                detail: "403".into(),
            },
            Some(S3_CHECK_FAILED),
            Some("bucket"),
        ),
        (
            LfsNotReady::LfsToolingUnavailable {
                detail: "git-lfs is not installed".into(),
            },
            Some(LFS_TOOLING_UNAVAILABLE),
            Some("install git-lfs"),
        ),
        (
            secret(Error::Missing),
            Some("SECRET_NOT_FOUND"),
            Some("svode secret set S3_KEY"),
        ),
        (
            secret(Error::SecretStore),
            Some("SECRET_STORE_UNAVAILABLE"),
            Some("SVODE_SECRET_S3_KEY"),
        ),
        (
            secret(Error::SecretFileUnsafe),
            Some("SECRET_FILE_UNSAFE"),
            Some("chmod 600 /config/secrets.json"),
        ),
        (
            secret(Error::SecretFileInvalid),
            Some("SECRET_FILE_INVALID"),
            Some("restore /config/secrets.json"),
        ),
        (LfsNotReady::RemoteUnreachable, None, None),
    ] {
        assert_eq!(reason.code(), code, "{reason}");
        let hint = reason.hint();
        match step {
            Some(step) => assert!(hint.as_deref().unwrap().contains(step), "{hint:?}"),
            None => assert!(hint.is_none()),
        }
        assert!(
            reason
                .import_message()
                .starts_with("Git LFS route is not ready")
        );
    }
    assert_eq!(
        LfsNotReady::RemoteUnreachable.import_message(),
        "Git LFS route is not ready: the Git LFS server of `origin` is not reachable"
    );
}

#[tokio::test]
async fn connect_refuses_another_strategy_or_a_missing_address_before_any_write() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let catalog = temp.path().join("config");
    std::fs::create_dir_all(&repo).unwrap();
    let git = GitRuntime::new();
    for (config, expected) in [
        (
            AssetsSpaceConfig {
                strategy: AssetsStrategy::InGit,
                ..AssetsSpaceConfig::default()
            },
            LfsNotReady::StrategyMismatch {
                strategy: "in-git".into(),
            },
        ),
        (
            AssetsSpaceConfig {
                strategy: AssetsStrategy::LfsS3,
                ..AssetsSpaceConfig::default()
            },
            LfsNotReady::S3AddressMissing,
        ),
    ] {
        let error = connect(
            &git,
            ConnectRequest {
                catalog_dir: &catalog,
                project_path: &repo,
                space_id: None,
                repo_dir: &repo,
                config: &config,
                bindings: bindings(),
            },
        )
        .await
        .unwrap_err();
        match error {
            ConnectError::NotReady(reason) => assert_eq!(reason, expected),
            other => panic!("{other}"),
        }
    }
    assert_eq!(std::fs::read_dir(&repo).unwrap().count(), 0);
    assert!(!catalog.exists());
}

#[tokio::test]
async fn an_lfs_s3_scope_without_git_lfs_or_this_device_is_not_ready_and_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    let config = AssetsSpaceConfig {
        strategy: AssetsStrategy::LfsS3,
        s3: Some(target()),
        ..AssetsSpaceConfig::default()
    };
    assert!(matches!(
        check_readiness(&GitRuntime::without_cli(), repo, &config, true).await,
        Err(LfsNotReady::LfsToolingUnavailable { .. })
    ));
    let git = GitRuntime::new();
    if git.detected().is_some_and(|cli| cli.lfs_available()) {
        let status = status(&git, repo, &config).await;
        assert_eq!(status.lfs, LfsState::MissingCreds);
        assert_eq!(status.bindings, None);
        assert_eq!(
            status.problem,
            Some(LfsNotReady::S3NotConnected { detail: None })
        );
    }
    assert_eq!(std::fs::read_dir(repo).unwrap().count(), 0);
}

#[test]
fn owners_are_recorded_once() {
    let temp = tempfile::tempdir().unwrap();
    let catalog = temp.path();
    std::fs::write(
        catalog.join("settings.json"),
        r#"{"appearance":{"theme":"dark"}}"#,
    )
    .unwrap();
    for _ in 0..2 {
        register_owner(catalog, Path::new("/project")).unwrap();
    }
    register_owner(catalog, Path::new("/project/space")).unwrap();
    assert_eq!(
        owners(catalog).unwrap().into_iter().collect::<Vec<_>>(),
        [Path::new("/project"), Path::new("/project/space")]
    );
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(catalog.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["appearance"]["theme"], "dark");
}

/// DF-377 R1: a managed import of an `lfs-remote` route checks only this
/// device. Git runs without global and system config, so the LFS filter
/// exists only where the test or the import puts it; `origin` answers over
/// SSH through a recorder that notes every connection and refuses it.
#[cfg(unix)]
mod remote_import {
    use std::path::{Path, PathBuf};

    use super::super::config::{AssetsSpaceConfig, AssetsStrategy};
    use super::super::connection::*;
    use crate::git::cli::GitCli;
    use crate::git::state::GitRuntime;

    pub(super) struct Device {
        pub temp: tempfile::TempDir,
        pub git: GitRuntime,
        pub repo: PathBuf,
        pub calls: PathBuf,
    }

    fn remote() -> AssetsSpaceConfig {
        AssetsSpaceConfig {
            strategy: AssetsStrategy::LfsRemote,
            ..AssetsSpaceConfig::default()
        }
    }

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) {
        let out = cli.exec(repo, args).await.unwrap();
        assert_eq!(out.exit_code, 0, "git {args:?}: {}", out.stderr);
    }

    async fn filter(cli: &GitCli, repo: &Path) -> String {
        let out = cli
            .exec(repo, &["config", "--get", "filter.lfs.process"])
            .await
            .unwrap();
        out.stdout.trim().to_string()
    }

    /// A repository with a committed LFS pointer whose `origin` is the
    /// recorder; `without_lfs` hides git-lfs from Git.
    async fn device(without_lfs: bool) -> Option<Device> {
        let real = GitCli::detect().ok()?;
        if !real.lfs_available() {
            return None;
        }
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let calls = base.join("ssh-calls");
        let ssh = base.join("ssh");
        svode_testkit::write_executable(
            &ssh,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\nexit 255\n",
                calls.display()
            ),
        )
        .unwrap();
        let hide = if without_lfs {
            "for arg; do [ \"$arg\" = lfs ] && { echo \"git: 'lfs' is not a git command\" >&2; exit 1; }; done\n"
        } else {
            ""
        };
        let wrapper = base.join("git");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh\n{hide}export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec '{}' \"$@\"\n",
                real.git_path().display()
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(wrapper);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_ok(&cli, &repo, &["init", "-q"]).await;
        std::fs::write(
            repo.join(".gitattributes"),
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        std::fs::write(
            repo.join("a.bin"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
        )
        .unwrap();
        let ssh = ssh.to_string_lossy().into_owned();
        for args in [
            &["remote", "add", "origin", "ssh://git@lfs.invalid/repo.git"][..],
            &["config", "core.sshCommand", &ssh],
            &["add", "."],
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "pointer",
            ],
        ] {
            git_ok(&cli, &repo, args).await;
        }
        Some(Device {
            temp,
            git: GitRuntime::with_cli(cli),
            repo,
            calls,
        })
    }

    impl Device {
        fn cli(&self) -> &GitCli {
            self.git.detected().unwrap()
        }
    }

    #[tokio::test]
    async fn an_import_of_a_remote_route_restores_the_lfs_filter_without_reaching_the_server() {
        let Some(device) = device(false).await else {
            return;
        };
        assert_eq!(filter(device.cli(), &device.repo).await, "");

        check_import_readiness(&device.git, &device.repo, &remote())
            .await
            .unwrap();
        assert!(!device.calls.exists(), "the import reached the server");
        assert_eq!(
            filter(device.cli(), &device.repo).await,
            "git-lfs filter-process"
        );
        // Once registered the filter is left as it is.
        check_import_readiness(&device.git, &device.repo, &remote())
            .await
            .unwrap();
        assert!(!device.calls.exists());

        // The status probe of the same route does reach the recorder, which
        // refuses it: the server is unreachable, the import was not refused.
        assert_eq!(
            check_readiness(&device.git, &device.repo, &remote(), false).await,
            Err(LfsNotReady::RemoteUnreachable)
        );
        assert!(device.calls.exists());
    }

    #[tokio::test]
    async fn an_import_of_a_remote_route_restores_a_disabled_lfs_filter() {
        let Some(device) = device(false).await else {
            return;
        };
        for key in ["filter.lfs.process", "filter.lfs.clean"] {
            git_ok(device.cli(), &device.repo, &["config", key, ""]).await;
        }

        check_import_readiness(&device.git, &device.repo, &remote())
            .await
            .unwrap();
        assert_eq!(
            filter(device.cli(), &device.repo).await,
            "git-lfs filter-process"
        );
        assert!(!device.calls.exists());
    }

    #[tokio::test]
    async fn an_import_of_a_remote_route_is_refused_without_git_lfs_or_a_filter_it_can_register() {
        let Some(hidden) = device(true).await else {
            return;
        };
        let refused = check_import_readiness(&hidden.git, &hidden.repo, &remote())
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(LFS_TOOLING_UNAVAILABLE), "{refused}");
        assert!(refused.hint().unwrap().contains("install git-lfs"));
        assert_eq!(
            refused.import_message(),
            "Git LFS route is not ready: git-lfs is not installed"
        );

        // Outside a repository there is nothing to register the filter in.
        let Some(device) = device(false).await else {
            return;
        };
        let elsewhere = device.temp.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let refused = check_import_readiness(&device.git, &elsewhere, &remote())
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(LFS_TOOLING_UNAVAILABLE), "{refused}");
        assert!(
            refused
                .to_string()
                .starts_with("the Git LFS filter is not set up for this repository"),
            "{refused}"
        );
        assert!(!device.calls.exists());
    }
}
