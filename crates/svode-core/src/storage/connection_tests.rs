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
    // The remote route keeps the earlier refusal text.
    assert_eq!(
        LfsNotReady::RemoteUnreachable.import_message(),
        "Git LFS route is not ready; repair the configured backend before importing"
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
