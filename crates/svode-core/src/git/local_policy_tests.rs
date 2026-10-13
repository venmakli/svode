use super::{
    ops, policy as local_policy,
    staging_tests::{cli, git, repo, write},
};

const LOCALS: &[&str] = &[
    "local.json",
    "navigation.json",
    "navigation.tmp-1",
    "lfs-s3-agent.json",
    "variables.lock",
    "write.lock",
    "variables.pending.json",
    "variables.tmp-1",
    "index.db",
    "index.db-wal",
    "index.db-shm",
    "index.db-journal",
    "index.db.incompatible-1",
    "routines.db-wal.corrupt-1",
    "agent-sessions.db.tmp-1",
];

const LEGACY_S3: &str =
    "# svode:lfs-s3-agent:start\n.svode/lfs-s3-agent.json\n# svode:lfs-s3-agent:end\n";

const BLOCK: &str = "# svode:local:start
.svode/local.json
.svode/navigation.*
.svode/write.lock
.svode/lfs-s3-agent.json
.svode/variables.*
.svode/*.db*
# svode:local:end
";

const INLINE_ENTRIES: &str = "# svode:inline:start
*/.svode/local.json
*/.svode/navigation.*
*/.svode/write.lock
*/.svode/lfs-s3-agent.json
*/.svode/variables.*
*/.svode/*.db*
";

/// `.gitignore` of a user project with S3 on 2026-09-28, verbatim (DF-151).
const EVIDENCE: &str = "# Svode local files
.svode/local.json
.svode/*.db
.svode/*.db-wal
.svode/*.db-shm
# svode:lfs-s3-agent:start
.svode/lfs-s3-agent.json
# svode:lfs-s3-agent:end
# Svode local files
.svode/*.db*
# Svode local files
.svode/variables.*
# Svode local files
.svode/write.lock
";

/// Root with independent Spaces and user rules between Svode records.
const ROOT_WITH_USER_RULES: &str = "# Svode local files
.svode/local.json
.svode/*.db
.svode/*.db-wal
.svode/*.db-shm
# svode:spaces:start
sale/
develop/
compliance/
support/
marketing/
# svode:spaces:end
.DS_Store
strategy/teamly-export/
# Svode local files
.svode/*.db*
# Svode local files
.svode/lfs-s3-agent.json
.svode/variables.*
# Svode local files
.svode/write.lock
# Svode local files
.svode/navigation.*
";

/// Independent Space with the S3 agent path under a header and in its block.
const SPACE_WITH_DOUBLE_S3: &str = "# Svode local files
.svode/local.json
.svode/*.db
.svode/*.db-wal
.svode/*.db-shm
# Svode local files
.svode/*.db*
# Svode local files
.svode/lfs-s3-agent.json
.svode/variables.*
# svode:lfs-s3-agent:start
.svode/lfs-s3-agent.json
# svode:lfs-s3-agent:end
# Svode local files
.svode/write.lock
# Svode local files
.svode/navigation.*
";

/// Pre-rename records, which repair leaves as they are.
const COMBAI_RUN: &str = "# CombAI local files
.combai/local.json
.combai/*.db
.combai/*.db-wal
.combai/*.db-shm
";

const COMBAI_BLOCKS: &str = "# combai:inline:start
*/.combai/local.json
*/.combai/*.db
*/.combai/*.db-*
# combai:inline:end
# combai:spaces:start
vtoroj/
# combai:spaces:end
";

const STALE_INLINE: &str = "# svode:inline:start
*/.svode/local.json
*/.svode/*.db
*/.svode/*.db-*
# svode:inline:end
";

const FOREIGN_BLOCKS: &str = "# svode:spaces:start
soprovozhdenie/
# svode:spaces:end
# svode:assets-ignore:start
.assets/
# svode:assets-ignore:end
";

/// Later root lines of a renamed project and of its independent Space.
const SVODE_RUNS: &str = "# Svode local files
.svode/*.db*
# Svode local files
.svode/lfs-s3-agent.json
.svode/variables.*
# Svode local files
.svode/write.lock
# Svode local files
.svode/navigation.*
";

const FIRST_RUN: &str = "# Svode local files
.svode/local.json
.svode/*.db
.svode/*.db-wal
.svode/*.db-shm
";

/// A user rule inside an upper block and its negation above a later record.
const NEGATED_USER_RULE: &str = "# svode:local:start
.svode/local.json
*.log
# svode:local:end
!keep.log
";

/// A negated path of an `ENTRIES` class between two records.
const NEGATED_LOCAL_CLASS: &str = "# Svode local files
.svode/local.json
.svode/*.db*
!.svode/keep.db
";

/// Evidence fixtures: name, `.gitignore` before and after root repair.
fn fixtures() -> Vec<(&'static str, String, String)> {
    let renamed_root =
        format!("{COMBAI_RUN}{COMBAI_BLOCKS}{FIRST_RUN}{STALE_INLINE}{FOREIGN_BLOCKS}{SVODE_RUNS}");
    vec![
        ("evidence 2026-09-28", EVIDENCE.into(), BLOCK.into()),
        (
            "root with user rules",
            ROOT_WITH_USER_RULES.into(),
            format!(
                "# svode:spaces:start\nsale/\ndevelop/\ncompliance/\nsupport/\nmarketing/\n# svode:spaces:end\n.DS_Store\nstrategy/teamly-export/\n{BLOCK}"
            ),
        ),
        (
            "space with double S3",
            SPACE_WITH_DOUBLE_S3.into(),
            BLOCK.into(),
        ),
        (
            "renamed root",
            renamed_root,
            format!("{COMBAI_RUN}{COMBAI_BLOCKS}{STALE_INLINE}{FOREIGN_BLOCKS}{BLOCK}"),
        ),
        (
            "renamed space",
            format!("{COMBAI_RUN}{FIRST_RUN}{SVODE_RUNS}"),
            format!("{COMBAI_RUN}{BLOCK}"),
        ),
        (
            "negated user rule",
            format!("{NEGATED_USER_RULE}{LEGACY_S3}"),
            format!("{NEGATED_USER_RULE}{BLOCK}"),
        ),
        (
            "negated local class",
            format!("{NEGATED_LOCAL_CLASS}{LEGACY_S3}"),
            format!("{NEGATED_LOCAL_CLASS}{BLOCK}"),
        ),
    ]
}

/// Repair `before` as the root `.gitignore` of `dir`, check that a second
/// repair keeps the bytes and that every `ENTRIES` rule is an exact line, so
/// earlier versions find nothing missing.
fn repair_text(dir: &std::path::Path, before: Option<&str>) -> String {
    let path = dir.join(".gitignore");
    match before {
        Some(before) => std::fs::write(&path, before).unwrap(),
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
    assert!(ops::ensure_svode_gitignore(dir).unwrap());
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(!ops::ensure_svode_gitignore(dir).unwrap());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), after);
    for entry in local_policy::ENTRIES {
        assert!(
            after
                .lines()
                .any(|line| line.trim_end_matches('\r') == *entry)
        );
    }
    after
}

#[test]
fn local_block_merges_evidence_records_and_repeats_byte_identical() {
    let tmp = tempfile::tempdir().unwrap();
    for (name, before, expected) in fixtures() {
        assert_eq!(repair_text(tmp.path(), Some(&before)), expected, "{name}");
        // A block above a negation stays where it is (R3).
        let blocks = if name == "negated user rule" { 2 } else { 1 };
        assert_eq!(
            expected.matches("# svode:local:start").count(),
            blocks,
            "{name}"
        );
    }
}

#[test]
fn local_block_boundaries_keep_user_lines_and_foreign_records() {
    let tmp = tempfile::tempdir().unwrap();
    let block =
        |user: &str| BLOCK.replace("# svode:local:end", &format!("{user}# svode:local:end"));
    for (before, expected) in [
        // A user line ends the run and stays with everything below it.
        (
            "# Svode local files\n.svode/local.json\ncustom.log\n.svode/*.db\n".to_string(),
            format!("{BLOCK}custom.log\n.svode/*.db\n"),
        ),
        // A header without a Svode line right below it is not a record.
        (
            "# Svode local files\n\n.svode/local.json\n".into(),
            format!("# Svode local files\n\n.svode/local.json\n{BLOCK}"),
        ),
        (
            "/.svode/local.json\n.svode/*.db\n".into(),
            format!("/.svode/local.json\n.svode/*.db\n{BLOCK}"),
        ),
        (
            format!("{BLOCK}user\n# Svode local files\n.svode/write.lock\n"),
            format!("user\n{BLOCK}"),
        ),
        (
            "# svode:local:start\n.svode/*.db\nbuild/\n.svode/local.json\n# svode:local:end\n".into(),
            block("build/\n"),
        ),
        (
            format!("{}mid\n{}", block("a/\n"), block("b/\n")),
            format!("mid\n{}", block("a/\nb/\n")),
        ),
        (
            "# svode:lfs-s3-agent:start\n.svode/lfs-s3-agent.json\ncustom\n# svode:lfs-s3-agent:end\n".into(),
            format!("# svode:lfs-s3-agent:start\n.svode/lfs-s3-agent.json\ncustom\n# svode:lfs-s3-agent:end\n{BLOCK}"),
        ),
        (
            EVIDENCE.replace('\n', "\r\n").replacen("# Svode", "user\r\n# Svode", 1),
            format!("user\r\n{}", BLOCK.replace('\n', "\r\n")),
        ),
        (String::new(), BLOCK.into()),
        ("user".into(), format!("user\n{BLOCK}")),
        (
            "user\n# Svode local files\n.svode/local.json".into(),
            format!("user\n{BLOCK}"),
        ),
    ] {
        assert_eq!(repair_text(tmp.path(), Some(&before)), expected, "{before:?}");
    }
    assert_eq!(repair_text(tmp.path(), None), BLOCK);
}

#[test]
fn inline_block_canonicalizes_previous_lines_and_keeps_user_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join(".gitignore");
    for (before, expected) in [
        (
            "user-rule\n# svode:inline:start\n*/.svode/local.json\n*/.svode/*.db\n*/.svode/*.db-*\ncustom-local-rule\n*/.svode/variables.*\n# svode:inline:end\nafter-rule\n".to_string(),
            format!("user-rule\n{INLINE_ENTRIES}custom-local-rule\n# svode:inline:end\nafter-rule\n"),
        ),
        (
            format!("{COMBAI_RUN}{COMBAI_BLOCKS}{STALE_INLINE}{FOREIGN_BLOCKS}"),
            format!("{COMBAI_RUN}{COMBAI_BLOCKS}{INLINE_ENTRIES}# svode:inline:end\n{FOREIGN_BLOCKS}"),
        ),
    ] {
        std::fs::write(&path, &before).unwrap();
        ops::ensure_inline_gitignore(tmp.path()).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after, expected);
        ops::ensure_inline_gitignore(tmp.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after);
    }
}

/// Paths of every DF-102 class, portable Svode files and user paths of the
/// fixtures, at the root and inside an inline Space.
fn probe_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for prefix in ["", "child/"] {
        for name in LOCALS
            .iter()
            .chain(&["config.json", "AGENTS.md", "keep.db"])
        {
            paths.push(format!("{prefix}.svode/{name}"));
        }
        paths.push(format!("{prefix}.combai/index.db"));
    }
    for path in [
        "out.log",
        "keep.log",
        "vtoroj/page.md",
        "soprovozhdenie/page.md",
        ".assets/file.bin",
        "strategy/teamly-export/data.csv",
        ".DS_Store",
    ] {
        paths.push(path.into());
    }
    paths
}

async fn ignored(
    cli: &super::cli::GitCli,
    root: &std::path::Path,
) -> std::collections::BTreeSet<String> {
    let paths = probe_paths();
    let mut args = vec!["check-ignore", "-v", "--no-index", "--"];
    args.extend(paths.iter().map(String::as_str));
    let out = cli.exec_redacted(root, &args).await.unwrap();
    assert!(out.exit_code <= 1, "{}", out.stderr);
    eprintln!("{}", out.stdout.trim_end());
    // `-v` also lists paths whose last matching pattern is a negation.
    out.stdout
        .lines()
        .filter_map(|line| {
            let (source, path) = line.split_once('\t').unwrap();
            let pattern = source.splitn(3, ':').nth(2).unwrap();
            (!pattern.starts_with('!')).then(|| path.to_string())
        })
        .collect()
}

#[tokio::test]
async fn local_block_repair_keeps_effective_git_ignores() {
    let cli = cli();
    for (name, before, _) in fixtures() {
        let tmp = repo(&cli, false).await;
        let root = tmp.path();
        git(&cli, root, &["config", "core.excludesFile", "/dev/null"]).await;
        for path in probe_paths() {
            write(root, &path, "bytes\n");
        }
        write(root, ".gitignore", &before);
        eprintln!("--- {name}: before");
        let previous = ignored(&cli, root).await;
        ops::ensure_svode_gitignore(root).unwrap();
        if before.contains("# svode:inline:start") {
            ops::ensure_inline_gitignore(root).unwrap();
        }
        eprintln!("--- {name}: after");
        let current = ignored(&cli, root).await;
        assert!(current.is_superset(&previous), "{name}");
        for path in current.difference(&previous) {
            let file = path.rsplit('/').next().unwrap();
            assert!(
                local_policy::contains(path) && (LOCALS.contains(&file) || file == "keep.db"),
                "{name}: {path} is not a local class path"
            );
        }
        for portable in [
            ".svode/config.json",
            ".svode/AGENTS.md",
            "child/.svode/config.json",
            "child/.svode/AGENTS.md",
        ] {
            assert!(!current.contains(portable), "{name}: {portable}");
        }
        if name == "negated user rule" {
            assert!(previous.contains("out.log"));
            assert!(!current.contains("keep.log"));
        }
        if name == "negated local class" {
            // R3: a negated path of an `ENTRIES` class becomes ignored by
            // the block below the negation, as any newly added class would.
            assert!(!previous.contains(".svode/keep.db"));
            assert!(current.contains(".svode/keep.db"));
        }
    }
}

#[tokio::test]
async fn local_policy_effective_topology_and_storage_blocks() {
    let cli = cli();
    for storage in ["local", "in-git", "lfs", "s3"] {
        let root = repo(&cli, true).await;
        let child_source = repo(&cli, true).await;
        git(
            &cli,
            root.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child_source.path().to_str().unwrap(),
                "submodule",
            ],
        )
        .await;
        let independent = root.path().join("independent");
        std::fs::create_dir(&independent).unwrap();
        git(&cli, &independent, &["init"]).await;
        ops::add_independent_gitignore(root.path(), "independent").unwrap();
        let initial = std::fs::read_to_string(root.path().join(".gitignore")).unwrap();
        let assets = if storage == "local" {
            "# svode:assets-ignore:start\n.assets/\n# svode:assets-ignore:end\n# svode:assets-local-paths:start\n/attachment.bin\n# svode:assets-local-paths:end\n"
        } else {
            ""
        };
        write(
            root.path(),
            ".gitignore",
            &format!("{initial}# user\nignored.md\n{assets}"),
        );
        let attrs = if matches!(storage, "lfs" | "s3") {
            "*.bin filter=lfs diff=lfs merge=lfs -text\n"
        } else {
            "# user attributes\n"
        };
        write(root.path(), ".gitattributes", attrs);
        if storage == "s3" {
            let current = std::fs::read_to_string(root.path().join(".gitignore")).unwrap();
            write(root.path(), ".gitignore", &format!("{current}{LEGACY_S3}"));
        }
        for target in [
            root.path().to_path_buf(),
            independent.clone(),
            root.path().join("submodule"),
        ] {
            git(&cli, &target, &["config", "core.excludesFile", "/dev/null"]).await;
            ops::ensure_svode_gitignore(&target).unwrap();
        }
        ops::ensure_inline_gitignore(root.path()).unwrap();
        assert!(root.path().join("submodule/.git").is_file());
        for (owner, effective, prefix) in [
            (root.path().to_path_buf(), root.path().to_path_buf(), ""),
            (
                root.path().join("inline"),
                root.path().to_path_buf(),
                "inline/",
            ),
            (independent.clone(), independent.clone(), ""),
            (
                root.path().join("submodule"),
                root.path().join("submodule"),
                "",
            ),
        ] {
            for name in LOCALS {
                write(&owner, &format!(".svode/{name}"), "local bytes\n");
                let path = format!("{prefix}.svode/{name}");
                let proof = git(
                    &cli,
                    &effective,
                    &["check-ignore", "-v", "--no-index", "--", &path],
                )
                .await;
                assert!(proof.contains(&path), "{storage}: {proof}");
            }
            for name in ["config.json", "AGENTS.md"] {
                write(&owner, &format!(".svode/{name}"), "portable\n");
                let path = format!("{prefix}.svode/{name}");
                assert_eq!(
                    cli.exec_redacted(&effective, &["check-ignore", "-q", "--", &path])
                        .await
                        .unwrap()
                        .exit_code,
                    1
                );
            }
            let raw = git(
                &cli,
                &effective,
                &["status", "--porcelain", "--untracked-files=all"],
            )
            .await;
            assert!(raw.contains("config.json"));
            assert!(!raw.contains("index.db"));
            assert!(
                ops::status(&cli, &owner)
                    .await
                    .unwrap()
                    .files
                    .iter()
                    .all(|p| !local_policy::contains(&p.path))
            );
        }
        for (effective, prefix) in [
            (root.path().to_path_buf(), ""),
            (root.path().to_path_buf(), "inline/"),
            (independent.clone(), ""),
            (root.path().join("submodule"), ""),
        ] {
            git(&cli, &effective, &["config", "user.name", "Test"]).await;
            git(
                &cli,
                &effective,
                &["config", "user.email", "test@example.test"],
            )
            .await;
            git(&cli, &effective, &["config", "commit.gpgsign", "false"]).await;
            ops::add_all(&cli, &effective).await.unwrap();
            let staged = git(&cli, &effective, &["diff", "--cached", "--name-only"]).await;
            assert!(staged.lines().all(|p| !local_policy::contains(p)));
            assert!(
                ops::commit_paths(
                    &cli,
                    &effective,
                    &[
                        format!("{prefix}.svode/config.json"),
                        format!("{prefix}.svode/AGENTS.md"),
                    ]
                )
                .await
                .unwrap()
            );
            let committed = git(
                &cli,
                &effective,
                &["show", "--format=", "--name-only", "HEAD"],
            )
            .await;
            assert!(committed.contains("config.json"));
            assert!(committed.lines().all(|p| !local_policy::contains(p)));
        }
        let before = std::fs::read(root.path().join(".gitignore")).unwrap();
        assert!(!ops::ensure_svode_gitignore(root.path()).unwrap());
        ops::ensure_inline_gitignore(root.path()).unwrap();
        assert_eq!(
            std::fs::read(root.path().join(".gitignore")).unwrap(),
            before
        );
        let text = String::from_utf8(before).unwrap();
        assert_eq!(text.matches("# svode:local:start").count(), 1);
        assert!(!text.contains(local_policy::LEGACY_S3_START));
        assert!(text.contains("# user\nignored.md\n"));
        assert!(text.contains(assets));
        assert_eq!(
            std::fs::read_to_string(root.path().join(".gitattributes")).unwrap(),
            attrs
        );
        assert_eq!(
            cli.exec_redacted(
                root.path(),
                &["check-ignore", "-q", "--", ".assets/file.bin"]
            )
            .await
            .unwrap()
            .exit_code,
            if storage == "local" { 0 } else { 1 }
        );
    }
}

#[tokio::test]
async fn local_policy_missing_rules_negation_and_staged_guard() {
    let cli = cli();
    for rules in [false, true] {
        let tmp = repo(&cli, true).await;
        let root = tmp.path();
        for prefix in ["", "inline/"] {
            for name in LOCALS {
                write(root, &format!("{prefix}.svode/{name}"), "legacy\n");
            }
        }
        git(&cli, root, &["add", "."]).await;
        git(&cli, root, &["commit", "-m", "Legacy local tracking"]).await;
        if rules {
            ops::ensure_svode_gitignore(root).unwrap();
            ops::ensure_inline_gitignore(root).unwrap();
            write(
                root,
                "inline/.gitignore",
                "# explicit user override\n!.svode/*.db*\n",
            );
        }
        for prefix in ["", "inline/"] {
            for name in LOCALS {
                write(root, &format!("{prefix}.svode/{name}"), "updated\n");
            }
            write(root, &format!("{prefix}.svode/new.db-journal"), "new\n");
            write(root, &format!("{prefix}.svode/config.json"), "portable\n");
        }
        let raw = git(
            &cli,
            root,
            &["status", "--porcelain", "--untracked-files=all"],
        )
        .await;
        assert!(raw.contains("inline/.svode/new.db-journal"));
        assert!(
            ops::status(&cli, root)
                .await
                .unwrap()
                .files
                .iter()
                .all(|p| !local_policy::contains(&p.path))
        );
        git(&cli, root, &["add", "-f", "--", ".svode/index.db"]).await;
        let staged = git(
            &cli,
            root,
            &["ls-files", "--stage", "--", ".svode/index.db"],
        )
        .await;
        ops::add_all(&cli, root).await.unwrap();
        assert!(
            ops::commit(&cli, root, "Must refuse staged local")
                .await
                .is_err()
        );
        assert!(ops::commit_paths(&cli, root, &[".".into()]).await.unwrap());
        assert_eq!(
            git(
                &cli,
                root,
                &["ls-files", "--stage", "--", ".svode/index.db"]
            )
            .await,
            staged
        );
        let changed = git(
            &cli,
            root,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        )
        .await;
        assert!(changed.contains("config.json"));
        assert!(changed.lines().all(|p| !local_policy::contains(p)));
        for prefix in ["", "inline/"] {
            for name in LOCALS {
                let path = format!("{prefix}.svode/{name}");
                assert!(ops::add(&cli, root, &path).await.is_err());
                assert!(
                    ops::commit_exact_path(&cli, root, &path, "Refuse")
                        .await
                        .is_err()
                );
                assert_eq!(
                    std::fs::read_to_string(root.join(path)).unwrap(),
                    "updated\n"
                );
            }
        }
        let status = ops::status(&cli, root).await.unwrap();
        assert!(status.files.is_empty());
        assert!(!status.has_staged && !status.has_unstaged);
        assert!(ops::commit(&cli, root, "Still refuses").await.is_err());
    }
}

#[tokio::test]
async fn local_policy_hidden_conflict_keeps_repository_safety_gate() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let root = tmp.path();
    write(root, ".svode/index.db", "base\n");
    git(&cli, root, &["add", "."]).await;
    git(&cli, root, &["commit", "-m", "Legacy"]).await;
    git(&cli, root, &["checkout", "-b", "other"]).await;
    write(root, ".svode/index.db", "other\n");
    git(&cli, root, &["commit", "-am", "Other"]).await;
    git(&cli, root, &["checkout", "-b", "current", "HEAD^"]).await;
    write(root, ".svode/index.db", "current\n");
    git(&cli, root, &["commit", "-am", "Current"]).await;
    assert_ne!(
        cli.exec_redacted(root, &["merge", "other"])
            .await
            .unwrap()
            .exit_code,
        0
    );
    let index = git(&cli, root, &["ls-files", "--stage", "-z"]).await;
    let status = ops::status(&cli, root).await.unwrap();
    assert!(status.files.is_empty());
    assert!(status.has_conflicts);
    assert!(
        ops::commit_paths(&cli, root, &["baseline.md".into()])
            .await
            .is_err()
    );
    assert_eq!(git(&cli, root, &["ls-files", "--stage", "-z"]).await, index);
}
