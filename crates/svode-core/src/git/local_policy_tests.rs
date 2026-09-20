use super::{
    ops, policy as local_policy,
    staging_tests::{cli, git, repo, write},
};

const LOCALS: &[&str] = &[
    "local.json",
    "lfs-s3-agent.json",
    "variables.lock",
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
            crate::storage::s3::ensure_agent_gitignore(root.path()).unwrap();
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
