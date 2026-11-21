//! Strategy apply, its transition rule and the S3 prefix defaults. Moved from
//! the desktop app with their expectations unchanged.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::config::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig};
use super::local_release::files_held_by_local_rules;
use super::local_rules::LOCAL_EXTENSIONS_START;
use super::policy::{
    LEGACY_ASSETS_ONLY_LFS_RULE, LFS_END, LFS_START, check_lfs_filters, diagnose_repo_lfs_policy,
    managed_lfs_attributes_body, managed_policy_current, supported_binary_routing,
};
use super::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, lfs_path_rule,
    parse_managed_paths, rebase_managed_import_routes, rewrite_managed_path_block,
};
use super::strategy::{
    StrategyRequest, StrategyScope, StrategyWarning, StrategyWarningCode, apply_strategy,
    default_repo_space_prefix, default_root_prefix, ensure_storage_strategy_git_args_safe,
    ensure_supported_strategy_transition, normalize_prefix_part, normalize_prefix_path, plan,
    rewrite_managed_lfs_attributes, store_assets,
};
use crate::git::cli::GitCli;
use crate::git::state::GitRuntime;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn legacy_routing() -> BinaryRoutingConfig {
    supported_binary_routing(&AssetsSpaceConfig::default()).expect("legacy routing")
}

/// Routing whose extension rules leave `.mov` to the threshold.
fn threshold_routing() -> BinaryRoutingConfig {
    let mut routing = BinaryRoutingConfig::new_project_default();
    routing.lfs_extensions = vec!["png".into()];
    routing.lfs_threshold_bytes = Some(10);
    routing
}

#[test]
fn managed_lfs_rewrite_is_idempotent_and_preserves_user_attributes() {
    let existing = format!(
        "*.bin binary\n{LFS_START}\n{LEGACY_ASSETS_ONLY_LFS_RULE}\n{LFS_END}\n*.custom merge=ours\n"
    );

    let routing = legacy_routing();
    let first = rewrite_managed_lfs_attributes(&existing, true, &routing);
    let second = rewrite_managed_lfs_attributes(&first, true, &routing);

    assert_eq!(second, first);
    assert!(first.contains("*.bin binary\n"));
    assert!(first.contains("*.custom merge=ours\n"));
    assert_eq!(first.matches(LFS_START).count(), 1);
    assert_eq!(first.matches(LFS_END).count(), 1);
    assert!(first.contains(&managed_lfs_attributes_body(&routing)));

    let removed = rewrite_managed_lfs_attributes(&first, false, &routing);
    assert_eq!(removed, "*.bin binary\n*.custom merge=ours\n");
}

/// `.gitattributes` with a user line, the extension block and an exact-path
/// block whose rule for a name with a space is in the old backslash form.
fn attributes_with_an_old_exact_rule(routing: &BinaryRoutingConfig) -> String {
    format!(
        "*.custom merge=ours\n{LFS_START}\n{}\n{LFS_END}\n{LFS_PATHS_START}\n\
         # svode:path \"My Notes/big.mov\"\n\
         My\\ Notes/big.mov filter=lfs diff=lfs merge=lfs -text\n\
         {LFS_PATHS_END}\n*.bin binary\n",
        managed_lfs_attributes_body(routing)
    )
}

/// DF-380 R3 (b): re-applying an LFS policy rebuilds the exact-path block
/// from its metadata without new paths; leaving LFS still drops the block.
#[test]
fn managed_lfs_rewrite_rebuilds_exact_path_rules_from_their_metadata() {
    let routing = threshold_routing();
    let existing = attributes_with_an_old_exact_rule(&routing);

    let first = rewrite_managed_lfs_attributes(&existing, true, &routing);
    let second = rewrite_managed_lfs_attributes(&first, true, &routing);

    assert_eq!(second, first);
    assert!(
        first.contains(&format!(
            "# svode:path \"My Notes/big.mov\"\n{}\n",
            lfs_path_rule("My Notes/big.mov")
        )) && !first.contains("\nMy\\ Notes/big.mov"),
        "{first}"
    );
    assert_eq!(
        parse_managed_paths(&first, LFS_PATHS_START, LFS_PATHS_END).expect("exact paths"),
        BTreeSet::from(["My Notes/big.mov".to_string()])
    );
    assert!(first.starts_with("*.custom merge=ours\n"), "{first}");
    assert!(first.contains("\n*.bin binary\n"), "{first}");
    assert!(managed_policy_current(
        &first,
        AssetsStrategy::LfsRemote,
        &routing
    ));

    let removed = rewrite_managed_lfs_attributes(&existing, false, &routing);
    assert_eq!(removed, "*.custom merge=ours\n*.bin binary\n");
}

#[test]
fn storage_strategy_git_guard_blocks_history_rewrites() {
    for args in [
        &["lfs", "migrate", "import"][..],
        &["filter-branch"][..],
        &["filter-repo"][..],
        &["rebase"][..],
        &["reset", "--hard"][..],
        &["checkout", "main"][..],
        &["switch", "main"][..],
        &["commit", "--amend"][..],
    ] {
        assert!(ensure_storage_strategy_git_args_safe(args).is_err());
    }
}

#[test]
fn storage_strategy_git_guard_allows_setup_commands() {
    for args in [
        &["lfs", "install", "--local"][..],
        &[
            "config",
            "--local",
            "lfs.standalonetransferagent",
            "lfs-dal",
        ][..],
        &[
            "config",
            "--local",
            "--unset",
            "lfs.standalonetransferagent",
        ][..],
    ] {
        assert!(ensure_storage_strategy_git_args_safe(args).is_ok());
    }
}

#[test]
fn exact_path_rules_rebase_a_managed_subtree_and_preserve_user_content() {
    let paths = BTreeSet::from([
        "docs/Topic/archive.bin".to_string(),
        "other/keep.bin".to_string(),
    ]);
    let contents = rewrite_managed_path_block(
        "*.custom merge=ours\n",
        LFS_PATHS_START,
        LFS_PATHS_END,
        &paths,
        true,
    );
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::write(temp.path().join(".gitattributes"), contents).expect("attributes");

    let changed = rebase_managed_import_routes(temp.path(), "docs/Topic", "docs/Renamed", true)
        .expect("rebase exact rules");
    let next = std::fs::read_to_string(temp.path().join(".gitattributes")).expect("attributes");

    assert_eq!(changed, vec![temp.path().join(".gitattributes")]);
    assert!(next.contains("*.custom merge=ours"));
    assert!(next.contains("docs/Renamed/archive.bin"));
    assert!(next.contains("other/keep.bin"));
    assert!(!next.contains("docs/Topic/archive.bin"));
}

#[test]
fn strategy_transition_guard_allows_only_local_enrollment_or_same_strategy() {
    for next in [
        AssetsStrategy::Local,
        AssetsStrategy::InGit,
        AssetsStrategy::LfsRemote,
        AssetsStrategy::LfsS3,
    ] {
        assert!(ensure_supported_strategy_transition(&AssetsStrategy::Local, &next).is_ok());
    }

    assert!(
        ensure_supported_strategy_transition(&AssetsStrategy::LfsS3, &AssetsStrategy::LfsS3)
            .is_ok()
    );
    assert!(
        ensure_supported_strategy_transition(&AssetsStrategy::InGit, &AssetsStrategy::LfsRemote)
            .is_err()
    );
    assert!(
        ensure_supported_strategy_transition(&AssetsStrategy::LfsRemote, &AssetsStrategy::Local)
            .is_err()
    );
    assert!(
        ensure_supported_strategy_transition(&AssetsStrategy::LfsRemote, &AssetsStrategy::LfsS3)
            .is_err()
    );
}

#[test]
fn strategy_transition_guard_refuses_an_unknown_current_or_next_strategy() {
    let unknown = AssetsStrategy::Unknown("lfs-future".into());
    for (current, next) in [
        (&unknown, &unknown),
        (&unknown, &AssetsStrategy::Local),
        (&AssetsStrategy::Local, &unknown),
    ] {
        let error = ensure_supported_strategy_transition(current, next)
            .expect_err("unknown strategy refused");
        assert!(error.to_string().contains("newer Svode version"), "{error}");
    }
}

#[test]
fn stored_assets_strategy_keeps_unknown_config_keys() {
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
    std::fs::write(
        temp.path().join(".svode/config.json"),
        r#"{"name":"Project","futureRoot":1,"assets":{"strategy":"local","futureAssets":2}}"#,
    )
    .expect("config");
    let config = crate::space_config::read(temp.path()).expect("read config");

    store_assets(
        temp.path(),
        config,
        AssetsSpaceConfig {
            strategy: AssetsStrategy::InGit,
            binary_routing: Some(BinaryRoutingConfig::new_project_default()),
            s3: None,
            extensions: Default::default(),
        },
    )
    .expect("store assets");

    let value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(temp.path().join(".svode/config.json")).expect("config"),
    )
    .expect("json");
    assert_eq!(value["assets"]["strategy"], "in-git");
    assert_eq!(value["futureRoot"], 1);
    assert_eq!(value["assets"]["futureAssets"], 2);
}

#[test]
fn plan_refuses_an_inherited_scope_and_an_active_strategy_change_before_writing() {
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
    let config = r#"{"name":"Project","assets":{"strategy":"in-git"}}"#;
    std::fs::write(temp.path().join(".svode/config.json"), config).expect("config");
    let request = || StrategyRequest {
        strategy: AssetsStrategy::LfsS3,
        binary_routing: BinaryRoutingConfig::new_project_default(),
        s3: None,
    };
    let scope = |inherited_from_project| StrategyScope {
        config_dir: temp.path(),
        inherited_from_project,
        default_s3_prefix: "project/root",
    };

    let inherited = plan(scope(true), request()).expect_err("inherited");
    assert_eq!(inherited.to_string(), "strategy is inherited from project");
    let active = plan(scope(false), request()).expect_err("active strategy");
    assert!(
        active
            .to_string()
            .starts_with("Changing an active assets storage strategy is not supported yet"),
        "{active}"
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join(".svode/config.json")).expect("config"),
        config
    );
}

#[test]
fn plan_normalizes_the_s3_prefix_with_the_scope_default() {
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
    std::fs::write(
        temp.path().join(".svode/config.json"),
        r#"{"name":"Project"}"#,
    )
    .expect("config");
    let target = |prefix: &str| AssetsS3Config {
        endpoint: "https://s3.example.test".into(),
        bucket: "bucket".into(),
        region: "us-east-1".into(),
        prefix: prefix.into(),
        extensions: Default::default(),
    };
    for (prefix, expected) in [("", "project/root"), (" / Big Quest // x ", "big-quest/x")] {
        let planned = plan(
            StrategyScope {
                config_dir: temp.path(),
                inherited_from_project: false,
                default_s3_prefix: "project/root",
            },
            StrategyRequest {
                strategy: AssetsStrategy::LfsS3,
                binary_routing: BinaryRoutingConfig::new_project_default(),
                s3: Some(target(prefix)),
            },
        )
        .expect("planned");
        assert_eq!(planned.assets().s3.as_ref().unwrap().prefix, expected);
    }
}

#[test]
fn prefix_part_normalization_builds_path_safe_slugs() {
    assert_eq!(normalize_prefix_part(" Big Quest ", "project"), "big-quest");
    assert_eq!(
        normalize_prefix_part("Marketing Docs/2026", "space"),
        "marketing-docs-2026"
    );
    assert_eq!(normalize_prefix_part("!!!", "space"), "space");
}

#[test]
fn default_prefixes_use_project_root_and_repo_space_layout() {
    let project = Path::new("/tmp/Big Quest");
    assert_eq!(
        default_root_prefix(project, Some("Ignored")),
        "big-quest/root"
    );
    assert_eq!(
        default_repo_space_prefix(
            project,
            Some("Ignored"),
            Path::new("/tmp/Big Quest/Marketing")
        ),
        "big-quest/marketing"
    );
}

#[test]
fn prefix_path_normalization_preserves_safe_segments() {
    assert_eq!(
        normalize_prefix_path(" / Big Quest // Marketing Docs / ", "fallback/root"),
        "big-quest/marketing-docs"
    );
    assert_eq!(
        normalize_prefix_path("///", "fallback/root"),
        "fallback/root"
    );
}

fn make_fake_binary(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    std::fs::write(&path, b"#!/bin/sh\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

#[tokio::test]
async fn in_git_apply_keeps_head_on_remote_tracking_history() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };

    let cli = git.detected().expect("checked above");
    let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    let origin_head = git_stdout(cli, &repo, &["rev-parse", "origin/main"]).await?;

    apply_strategy(
        &git,
        &repo,
        AssetsStrategy::InGit,
        &legacy_routing(),
        None,
        None,
    )
    .await?;

    let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    let merge_base = git_stdout(cli, &repo, &["merge-base", "HEAD", "origin/main"]).await?;
    assert_eq!(head_after, head_before);
    assert_eq!(merge_base, origin_head);
    Ok(())
}

#[tokio::test]
async fn in_git_apply_removes_raw_svode_lfs_rule_without_moving_head() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };

    let cli = git.detected().expect("checked above");
    let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    std::fs::write(
        repo.join(".gitattributes"),
        ".assets/** filter=lfs diff=lfs merge=lfs -text\n",
    )?;

    apply_strategy(
        &git,
        &repo,
        AssetsStrategy::InGit,
        &legacy_routing(),
        None,
        None,
    )
    .await?;

    let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    assert_eq!(head_after, head_before);
    assert!(!repo.join(".gitattributes").exists());
    Ok(())
}

#[tokio::test]
async fn lfs_remote_apply_keeps_head_on_remote_tracking_history_when_lfs_available() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }

    let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    let origin_head = git_stdout(cli, &repo, &["rev-parse", "origin/main"]).await?;

    apply_strategy(
        &git,
        &repo,
        AssetsStrategy::LfsRemote,
        &legacy_routing(),
        None,
        None,
    )
    .await?;

    let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
    let merge_base = git_stdout(cli, &repo, &["merge-base", "HEAD", "origin/main"]).await?;
    assert_eq!(head_after, head_before);
    assert_eq!(merge_base, origin_head);
    Ok(())
}

#[tokio::test]
async fn local_apply_writes_the_extension_block_and_leaving_local_removes_it() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    std::fs::write(repo.join(".gitignore"), "user/\n")?;
    let mut routing = BinaryRoutingConfig::new_project_default();

    for _ in 0..2 {
        apply_strategy(&git, &repo, AssetsStrategy::Local, &routing, None, None).await?;
    }
    let defaults = std::fs::read_to_string(repo.join(".gitignore"))?;
    assert!(defaults.starts_with("user/\n"), "{defaults}");
    assert!(defaults.contains(LOCAL_EXTENSIONS_START), "{defaults}");
    assert_eq!(
        git_stdout(cli, &repo, &["check-ignore", "docs/photo.JPG"]).await?,
        "docs/photo.JPG"
    );

    routing.local_extensions = Some(vec!["bin".into()]);
    apply_strategy(&git, &repo, AssetsStrategy::Local, &routing, None, None).await?;
    let custom = std::fs::read_to_string(repo.join(".gitignore"))?;
    assert!(custom.contains("*.[bB][iI][nN]"), "{custom}");
    assert!(!custom.contains("*.[jJ][pP][gG]"), "{custom}");

    routing.local_extensions = Some(Vec::new());
    apply_strategy(&git, &repo, AssetsStrategy::Local, &routing, None, None).await?;
    let size_only = std::fs::read_to_string(repo.join(".gitignore"))?;
    assert!(!size_only.contains(LOCAL_EXTENSIONS_START), "{size_only}");

    routing.local_extensions = None;
    apply_strategy(&git, &repo, AssetsStrategy::Local, &routing, None, None).await?;
    apply_strategy(&git, &repo, AssetsStrategy::InGit, &routing, None, None).await?;
    assert_eq!(std::fs::read_to_string(repo.join(".gitignore"))?, "user/\n");
    Ok(())
}

/// A `local` repository with files its blocks hold: `docs/big.bin` by an
/// exact rule, the jpg files by the extension block; `docs/clip.png` is a
/// format of the LFS list in the tests below.
async fn local_repo_with_held_files(
    git: &GitRuntime,
    repo: &Path,
) -> Result<BinaryRoutingConfig, Box<dyn std::error::Error>> {
    let mut routing = BinaryRoutingConfig::new_project_default();
    routing.lfs_extensions = vec!["png".into()];
    routing.lfs_threshold_bytes = Some(10);
    apply_strategy(git, repo, AssetsStrategy::Local, &routing, None, None).await?;
    let gitignore = std::fs::read_to_string(repo.join(".gitignore"))?;
    std::fs::write(
        repo.join(".gitignore"),
        rewrite_managed_path_block(
            &gitignore,
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            &BTreeSet::from(["docs/big.bin".to_string()]),
            false,
        ),
    )?;
    std::fs::create_dir_all(repo.join("docs"))?;
    for (path, size) in [
        ("docs/big.bin", 20),
        ("docs/photo.jpg", 5),
        ("docs/huge.jpg", 20),
        ("docs/clip.png", 20),
    ] {
        std::fs::write(repo.join(path), vec![b'x'; size])?;
    }
    Ok(routing)
}

async fn untracked_docs(
    cli: &GitCli,
    repo: &Path,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let status = git_stdout(cli, repo, &["status", "--porcelain", "-uall", "--", "docs"]).await?;
    Ok(status.lines().map(str::to_string).collect())
}

#[tokio::test]
async fn leaving_local_for_lfs_gives_large_files_of_other_formats_exact_lfs_rules() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }
    let routing = local_repo_with_held_files(&git, &repo).await?;
    assert_eq!(
        files_held_by_local_rules(cli, &repo).await?,
        [
            "docs/big.bin",
            "docs/clip.png",
            "docs/huge.jpg",
            "docs/photo.jpg"
        ]
    );

    apply_strategy(&git, &repo, AssetsStrategy::LfsRemote, &routing, None, None).await?;

    let attributes = std::fs::read_to_string(repo.join(".gitattributes"))?;
    assert_eq!(
        parse_managed_paths(&attributes, LFS_PATHS_START, LFS_PATHS_END).expect("exact LFS rules"),
        BTreeSet::from(["docs/big.bin".to_string(), "docs/huge.jpg".to_string()])
    );
    assert_eq!(
        git_stdout(cli, &repo, &["check-attr", "filter", "--", "docs/huge.jpg"]).await?,
        "docs/huge.jpg: filter: lfs"
    );
    assert!(files_held_by_local_rules(cli, &repo).await?.is_empty());
    assert_eq!(
        git_stdout(cli, &repo, &["diff", "--cached", "--name-only"]).await?,
        ""
    );
    assert_eq!(
        untracked_docs(cli, &repo).await?,
        [
            "?? docs/big.bin",
            "?? docs/clip.png",
            "?? docs/huge.jpg",
            "?? docs/photo.jpg"
        ]
    );
    Ok(())
}

/// DF-380 R1, R2: a large `local` file with spaces in its name released to
/// Git LFS by a strategy change gets an exact rule Git applies.
#[tokio::test]
async fn leaving_local_for_lfs_routes_a_released_name_with_spaces_to_lfs() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }
    let mut routing = BinaryRoutingConfig::new_project_default();
    routing.lfs_extensions = vec!["png".into()];
    routing.lfs_threshold_bytes = Some(10);
    apply_strategy(&git, &repo, AssetsStrategy::Local, &routing, None, None).await?;
    let released = "My Notes/screen recording.mov";
    let gitignore = std::fs::read_to_string(repo.join(".gitignore"))?;
    std::fs::write(
        repo.join(".gitignore"),
        rewrite_managed_path_block(
            &gitignore,
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            &BTreeSet::from([released.to_string()]),
            false,
        ),
    )?;
    std::fs::create_dir_all(repo.join("My Notes"))?;
    std::fs::write(repo.join(released), vec![b'x'; 20])?;
    assert_eq!(files_held_by_local_rules(cli, &repo).await?, [released]);

    apply_strategy(&git, &repo, AssetsStrategy::LfsRemote, &routing, None, None).await?;

    let attributes = std::fs::read_to_string(repo.join(".gitattributes"))?;
    assert!(
        attributes.contains(&lfs_path_rule(released)),
        "{attributes}"
    );
    assert_eq!(
        check_lfs_filters(cli, &repo, &[released.to_string()]).await?[0].value,
        "lfs"
    );
    Ok(())
}

/// DF-380 R3 (b, c): an exact rule left in the old form makes the policy
/// stale and Git ignores it; re-applying the same LFS strategy without new
/// paths rebuilds it, Git routes the file to LFS, the policy is current and
/// user lines stay as they were. A second re-apply changes nothing.
#[tokio::test]
async fn reapplying_the_lfs_policy_repairs_an_old_exact_rule_without_new_paths() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }
    let routing = threshold_routing();
    let old = attributes_with_an_old_exact_rule(&routing);
    std::fs::write(repo.join(".gitattributes"), &old)?;
    let path = "My Notes/big.mov".to_string();
    let neighbour = "My Notes/big2.mov".to_string();
    let config = AssetsSpaceConfig {
        strategy: AssetsStrategy::LfsRemote,
        binary_routing: Some(routing.clone()),
        s3: None,
        extensions: Default::default(),
    };
    assert!(
        !diagnose_repo_lfs_policy(cli, &repo, &config)
            .await?
            .managed_policy_current
    );
    assert_eq!(
        check_lfs_filters(cli, &repo, std::slice::from_ref(&path)).await?[0].value,
        "unspecified"
    );

    apply_strategy(&git, &repo, AssetsStrategy::LfsRemote, &routing, None, None).await?;

    let repaired = std::fs::read_to_string(repo.join(".gitattributes"))?;
    assert!(
        repaired.contains(&lfs_path_rule(&path)) && !repaired.contains("\nMy\\ Notes/big.mov"),
        "{repaired}"
    );
    assert!(
        diagnose_repo_lfs_policy(cli, &repo, &config)
            .await?
            .managed_policy_current
    );
    let user_lines = |contents: &str| {
        contents
            .lines()
            .filter(|line| matches!(*line, "*.custom merge=ours" | "*.bin binary"))
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(user_lines(&repaired), user_lines(&old));
    let checks = check_lfs_filters(cli, &repo, &[path, neighbour]).await?;
    assert_eq!(checks[0].value, "lfs", "{checks:?}");
    assert_eq!(checks[1].value, "unspecified", "{checks:?}");

    apply_strategy(&git, &repo, AssetsStrategy::LfsRemote, &routing, None, None).await?;
    assert_eq!(
        std::fs::read_to_string(repo.join(".gitattributes"))?,
        repaired
    );
    Ok(())
}

#[tokio::test]
async fn leaving_local_for_git_removes_the_blocks_and_indexes_nothing() -> TestResult {
    let Some((git, _temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    let routing = local_repo_with_held_files(&git, &repo).await?;
    assert_eq!(files_held_by_local_rules(cli, &repo).await?.len(), 4);

    apply_strategy(&git, &repo, AssetsStrategy::InGit, &routing, None, None).await?;

    assert!(!repo.join(".gitignore").exists());
    assert!(!repo.join(".gitattributes").exists());
    assert_eq!(
        git_stdout(cli, &repo, &["diff", "--cached", "--name-only"]).await?,
        ""
    );
    assert_eq!(untracked_docs(cli, &repo).await?.len(), 4);
    Ok(())
}

fn s3_target() -> AssetsS3Config {
    AssetsS3Config {
        endpoint: "https://s3.example.test".into(),
        bucket: "bucket".into(),
        region: "us-east-1".into(),
        prefix: "project".into(),
        extensions: Default::default(),
    }
}

#[tokio::test]
async fn lfs_s3_apply_declares_once_and_other_strategy_removes_only_own_value() -> TestResult {
    let Some((git, temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }
    let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;
    let s3 = s3_target();
    let user = "# team\n[lfs]\n\tfetchexclude = archive/**\n";
    std::fs::write(repo.join(".lfsconfig"), user)?;
    let declared = format!("{user}[lfs]\n\turl = https://lfs-s3.svode.invalid/\n");

    for _ in 0..2 {
        let result = apply_strategy(
            &git,
            &repo,
            AssetsStrategy::LfsS3,
            &legacy_routing(),
            Some(&s3),
            Some(&bin),
        )
        .await?;
        assert!(
            result
                .warnings
                .iter()
                .all(|w| w.code != StrategyWarningCode::ForeignLfsConfig)
        );
        assert_eq!(std::fs::read_to_string(repo.join(".lfsconfig"))?, declared);
    }

    apply_strategy(
        &git,
        &repo,
        AssetsStrategy::InGit,
        &legacy_routing(),
        None,
        None,
    )
    .await?;
    assert_eq!(std::fs::read_to_string(repo.join(".lfsconfig"))?, user);

    std::fs::write(
        repo.join(".lfsconfig"),
        "[lfs]\n\turl = https://lfs.example.test/\n",
    )?;
    let result = apply_strategy(
        &git,
        &repo,
        AssetsStrategy::LfsS3,
        &legacy_routing(),
        Some(&s3),
        Some(&bin),
    )
    .await?;
    assert!(
        result
            .warnings
            .contains(&StrategyWarning::new(StrategyWarningCode::ForeignLfsConfig))
    );
    assert_eq!(
        std::fs::read_to_string(repo.join(".lfsconfig"))?,
        "[lfs]\n\turl = https://lfs.example.test/\n"
    );
    Ok(())
}

#[tokio::test]
async fn lfs_s3_apply_ignores_agent_config_in_the_local_block() -> TestResult {
    let Some((git, temp, repo)) = setup_remote_tracking_repo().await? else {
        return Ok(());
    };
    let cli = git.detected().expect("checked above");
    if !cli.lfs_available() {
        return Ok(());
    }
    let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;
    let s3 = s3_target();
    let block = "# svode:local:start\n.svode/local.json\n.svode/navigation.*\n.svode/write.lock\n.svode/lfs-s3-agent.json\n.svode/variables.*\n.svode/*.db*\n# svode:local:end\n";
    let legacy = "user/\n# Svode local files\n.svode/local.json\n.svode/*.db*\n# svode:lfs-s3-agent:start\n.svode/lfs-s3-agent.json\n# svode:lfs-s3-agent:end\n";

    for (before, expected) in [
        (None, block.to_string()),
        (Some(legacy), format!("user/\n{block}")),
    ] {
        if let Some(before) = before {
            std::fs::write(repo.join(".gitignore"), before)?;
        }
        apply_strategy(
            &git,
            &repo,
            AssetsStrategy::LfsS3,
            &legacy_routing(),
            Some(&s3),
            Some(&bin),
        )
        .await?;
        assert_eq!(std::fs::read_to_string(repo.join(".gitignore"))?, expected);
        assert_eq!(
            git_stdout(cli, &repo, &["check-ignore", ".svode/lfs-s3-agent.json"]).await?,
            ".svode/lfs-s3-agent.json"
        );
    }
    Ok(())
}

async fn setup_remote_tracking_repo()
-> Result<Option<(GitRuntime, tempfile::TempDir, PathBuf)>, Box<dyn std::error::Error>> {
    let Some(cli) = crate::git::state::detected_cli() else {
        return Ok(None);
    };
    let git = GitRuntime::with_cli(cli.clone());

    let temp = tempfile::tempdir()?;
    let root = temp.path();
    let remote = root.join("remote.git");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo)?;

    git_ok_no_dir(&cli, &["init", "--bare", path_str(&remote)?]).await?;
    git_ok(&cli, &repo, &["init"]).await?;
    git_ok(&cli, &repo, &["config", "user.email", "test@example.com"]).await?;
    git_ok(&cli, &repo, &["config", "user.name", "Svode Test"]).await?;
    git_ok(&cli, &repo, &["branch", "-M", "main"]).await?;

    std::fs::write(repo.join("README.md"), "# Project\n")?;
    git_ok(&cli, &repo, &["add", "README.md"]).await?;
    git_ok(&cli, &repo, &["commit", "-m", "Initial commit"]).await?;
    git_ok(
        &cli,
        &repo,
        &["remote", "add", "origin", path_str(&remote)?],
    )
    .await?;
    git_ok(&cli, &repo, &["push", "-u", "origin", "main"]).await?;

    std::fs::write(repo.join("local.md"), "local\n")?;
    git_ok(&cli, &repo, &["add", "local.md"]).await?;
    git_ok(&cli, &repo, &["commit", "-m", "Local work"]).await?;

    Ok(Some((git, temp, repo)))
}

async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), String> {
    let out = cli.exec(repo, args).await.map_err(|e| e.to_string())?;
    if out.exit_code != 0 {
        return Err(format!("git {} failed: {}", args.join(" "), out.stderr));
    }
    Ok(())
}

async fn git_ok_no_dir(cli: &GitCli, args: &[&str]) -> Result<(), String> {
    let out = cli.exec_no_dir(args).await.map_err(|e| e.to_string())?;
    if out.exit_code != 0 {
        return Err(format!("git {} failed: {}", args.join(" "), out.stderr));
    }
    Ok(())
}

async fn git_stdout(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = cli.exec(repo, args).await.map_err(|e| e.to_string())?;
    if out.exit_code != 0 {
        return Err(format!("git {} failed: {}", args.join(" "), out.stderr));
    }
    Ok(out.stdout.trim().to_string())
}

fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("path not accessible: {}", path.display()))
}
