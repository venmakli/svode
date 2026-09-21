use std::path::Path;

use super::config::{
    AssetsSpaceConfig, AssetsStrategy, BINARY_ROUTING_VERSION, BinaryRoutingConfig,
};
use super::lfs_declaration::LfsDeclarationState;
use super::policy::{
    LEGACY_ASSETS_ONLY_LFS_RULE, LFS_END, LFS_START, ManagedBinaryRoute, REPOSITORY_LFS_EXTENSIONS,
    StoragePolicyError, check_lfs_filters, diagnose_repo_lfs_policy, evaluate_managed_binary_route,
    is_repository_lfs_candidate, managed_lfs_attributes_body, managed_policy_current,
    normalize_binary_routing, supported_binary_routing,
};
use crate::git::GitError;
use crate::git::cli::GitCli;

fn legacy_routing() -> BinaryRoutingConfig {
    supported_binary_routing(&AssetsSpaceConfig::default()).expect("legacy routing")
}

fn lfs_config(routing: BinaryRoutingConfig) -> AssetsSpaceConfig {
    AssetsSpaceConfig {
        strategy: AssetsStrategy::LfsRemote,
        binary_routing: Some(routing),
        s3: None,
    }
}

#[test]
fn repository_lfs_preset_is_exact_unique_and_excludes_text_formats() {
    assert_eq!(REPOSITORY_LFS_EXTENSIONS.len(), 33);
    let unique: std::collections::BTreeSet<_> = REPOSITORY_LFS_EXTENSIONS.iter().copied().collect();
    assert_eq!(unique.len(), REPOSITORY_LFS_EXTENSIONS.len());

    for extension in ["png", "psd", "mp4", "pdf", "docx", "7z"] {
        assert!(REPOSITORY_LFS_EXTENSIONS.contains(&extension));
    }
    for extension in ["md", "yaml", "json", "csv", "svg"] {
        assert!(!REPOSITORY_LFS_EXTENSIONS.contains(&extension));
        let routing = legacy_routing();
        assert!(!is_repository_lfs_candidate(
            &format!("docs/file.{extension}"),
            &routing
        ));
    }
}

#[test]
fn repository_lfs_candidate_matching_is_case_insensitive_and_repo_scoped() {
    let routing = legacy_routing();
    assert!(is_repository_lfs_candidate(
        "campaigns/summer/banner.PsD",
        &routing
    ));
    assert!(is_repository_lfs_candidate(
        "presentations/demo.MP4",
        &routing
    ));
    assert!(is_repository_lfs_candidate(
        ".assets/no-extension",
        &routing
    ));
    assert!(!is_repository_lfs_candidate(
        "campaigns/.assets/no-extension",
        &routing
    ));
    assert!(!is_repository_lfs_candidate("icons/logo.svg", &routing));
    assert!(!is_repository_lfs_candidate("archive.bin", &routing));
}

#[test]
fn generated_lfs_body_is_deterministic_and_marks_old_block_as_stale() {
    let routing = legacy_routing();
    let body = managed_lfs_attributes_body(&routing);
    assert_eq!(body, managed_lfs_attributes_body(&routing));
    assert_eq!(body.lines().count(), REPOSITORY_LFS_EXTENSIONS.len() + 1);
    assert_eq!(
        body.lines()
            .filter(|line| *line == LEGACY_ASSETS_ONLY_LFS_RULE)
            .count(),
        1
    );
    assert!(body.contains("*.[pP][sS][dD] filter=lfs"));
    assert!(body.contains("*.7[zZ] filter=lfs"));
    assert!(!body.contains("[mM][dD] filter=lfs"));
    assert!(!body.contains("[sS][vV][gG] filter=lfs"));

    let old = format!("{LFS_START}\n{LEGACY_ASSETS_ONLY_LFS_RULE}\n{LFS_END}\n");
    assert!(!managed_policy_current(
        &old,
        AssetsStrategy::LfsRemote,
        &routing
    ));

    let current = format!("{LFS_START}\n{body}\n{LFS_END}\n");
    assert!(managed_policy_current(
        &current,
        AssetsStrategy::LfsRemote,
        &routing
    ));
    assert!(managed_policy_current(
        &current,
        AssetsStrategy::LfsS3,
        &routing
    ));
    assert!(!managed_policy_current(
        &current,
        AssetsStrategy::InGit,
        &routing
    ));
}

#[tokio::test]
async fn generated_rules_are_effective_for_nested_and_mixed_case_paths()
-> Result<(), StoragePolicyError> {
    let Some(cli) = detected_git() else {
        return Ok(());
    };
    let temp = tempfile::tempdir()?;
    init_repo(&cli, temp.path()).await?;
    std::fs::write(
        temp.path().join(".gitattributes"),
        managed_lfs_attributes_body(&legacy_routing()),
    )?;

    let paths: Vec<String> = [
        ".assets/photo.unknown",
        "root.PNG",
        "campaigns/summer/banner.PsD",
        "presentations/demo.MP4",
        "docs/brief.md",
        "icons/logo.svg",
    ]
    .into_iter()
    .map(ToString::to_string)
    .collect();
    let checks = check_lfs_filters(&cli, temp.path(), &paths).await?;

    assert_eq!(
        checks
            .iter()
            .map(|check| check.value.as_str())
            .collect::<Vec<_>>(),
        vec!["lfs", "lfs", "lfs", "lfs", "unspecified", "unspecified"]
    );
    Ok(())
}

#[tokio::test]
async fn diagnostics_report_only_dirty_uncovered_policy_candidates()
-> Result<(), StoragePolicyError> {
    let Some(cli) = detected_git() else {
        return Ok(());
    };
    let temp = tempfile::tempdir()?;
    let repo = temp.path();
    init_repo(&cli, repo).await?;

    std::fs::write(
        repo.join(".gitattributes"),
        "*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text\n",
    )?;
    write_file(repo, "covered/photo.PNG")?;
    write_file(repo, "campaigns/banner.psd")?;
    write_file(repo, ".assets/raw.bin")?;
    write_file(repo, "docs/brief.md")?;
    write_file(repo, "staged/manual.pdf")?;
    git_ok(&cli, repo, &["add", "staged/manual.pdf"]).await?;
    write_file(repo, "deleted/video.mp4")?;
    git_ok(&cli, repo, &["add", "deleted/video.mp4"]).await?;
    std::fs::remove_file(repo.join("deleted/video.mp4"))?;

    let diagnostic = diagnose_repo_lfs_policy(&cli, repo, &lfs_config(legacy_routing())).await?;

    assert!(!diagnostic.managed_policy_current);
    assert_eq!(
        diagnostic.uncovered_paths,
        vec![
            ".assets/raw.bin",
            "campaigns/banner.psd",
            "staged/manual.pdf"
        ]
    );
    assert_eq!(diagnostic.truncated_count, 0);
    assert_eq!(diagnostic.lfs_declaration, None);

    let s3_config = AssetsSpaceConfig {
        strategy: AssetsStrategy::LfsS3,
        ..lfs_config(legacy_routing())
    };
    let diagnostic = diagnose_repo_lfs_policy(&cli, repo, &s3_config).await?;
    assert_eq!(
        diagnostic.lfs_declaration,
        Some(LfsDeclarationState::Missing)
    );
    Ok(())
}

#[test]
fn routing_normalizes_and_applies_extension_before_threshold() {
    let routing = normalize_binary_routing(BinaryRoutingConfig {
        version: BINARY_ROUTING_VERSION,
        lfs_extensions: vec![" ZIP ".into(), ".psd".into(), "zip".into()],
        lfs_threshold_bytes: Some(10),
        extensions: Default::default(),
    })
    .expect("routing");
    assert_eq!(routing.lfs_extensions, vec!["psd", "zip"]);
    let config = lfs_config(routing);
    assert_eq!(
        evaluate_managed_binary_route(&config, "art.PSD", 1).unwrap(),
        ManagedBinaryRoute::LfsExtension
    );
    assert_eq!(
        evaluate_managed_binary_route(&config, "archive.bin", 10).unwrap(),
        ManagedBinaryRoute::LfsThreshold
    );
    assert_eq!(
        evaluate_managed_binary_route(&config, "data.json", 100).unwrap(),
        ManagedBinaryRoute::DirectGit
    );
    assert!(
        normalize_binary_routing(BinaryRoutingConfig {
            version: BINARY_ROUTING_VERSION,
            lfs_extensions: vec![".".into()],
            lfs_threshold_bytes: None,
            extensions: Default::default(),
        })
        .is_err()
    );
}

#[test]
fn unknown_routing_version_fails_closed_for_mutation() {
    let routing = BinaryRoutingConfig {
        version: 2,
        lfs_extensions: vec!["psd".into()],
        lfs_threshold_bytes: None,
        extensions: Default::default(),
    };
    for strategy in [
        AssetsStrategy::Local,
        AssetsStrategy::InGit,
        AssetsStrategy::LfsRemote,
        AssetsStrategy::LfsS3,
    ] {
        let config = AssetsSpaceConfig {
            strategy,
            binary_routing: Some(routing.clone()),
            s3: None,
        };
        assert!(evaluate_managed_binary_route(&config, "art.psd", 1).is_err());
    }
}

fn detected_git() -> Option<GitCli> {
    GitCli::detect().ok()
}

async fn init_repo(cli: &GitCli, repo: &Path) -> Result<(), StoragePolicyError> {
    git_ok(cli, repo, &["init"]).await
}

async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), StoragePolicyError> {
    let output = cli.exec(repo, args).await?;
    if output.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git {} failed: {}",
            args.join(" "),
            output.stderr.trim()
        ))
        .into());
    }
    Ok(())
}

fn write_file(repo: &Path, relative: &str) -> Result<(), StoragePolicyError> {
    let path = repo.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, b"binary-ish test content")?;
    Ok(())
}
