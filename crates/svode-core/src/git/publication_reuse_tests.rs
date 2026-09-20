use super::*;

fn shell(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}

fn traced(f: &Fixture, injection: &str) -> PathBuf {
    let log = f._temp.path().join("commands");
    std::fs::write(&log, "").unwrap();
    std::fs::write(f.cli.git_path(), format!(
        "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nprintf '%s\\t%s\\n' \"$PWD\" \"$*\" >> {}\n{}\nexec git -c protocol.file.allow=always \"$@\"\n", shell(&log), injection,
    )).unwrap();
    log
}

fn count(log: &Path, pattern: &str) -> usize {
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .filter(|line| line.contains(pattern))
        .count()
}

fn destination_fetches(log: &Path) -> usize {
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .filter(|line| {
            line.contains("svode-publication-")
                && line.contains("/project\t")
                && line.contains("fetch --")
        })
        .count()
}

#[tokio::test]
async fn every_publisher_uses_one_discovery_and_complete_local_destination_history() {
    for publisher in ["push", "publish", "sync", "first-sync", "resolve", "noop"] {
        let f = Fixture::new();
        if publisher != "noop" {
            commit(&f.root, "note", "outgoing content");
        }
        if matches!(publisher, "publish" | "first-sync") {
            git(&f.remote, &["update-ref", "-d", "refs/heads/main"]);
            git(&f.root, &["branch", "--unset-upstream"]);
        }
        if publisher == "resolve" {
            git(&f.root, &["checkout", "-b", "side", "HEAD~1"]);
            commit(&f.root, "side", "merge side");
            git(&f.root, &["checkout", "main"]);
            git(&f.root, &["merge", "--no-commit", "side"]);
        }
        let calls = counting_hook(&f.root, "cat >/dev/null");
        let log = traced(&f, "");
        match publisher {
            "push" | "noop" => crate::git::ops::push(&f.cli, &f.root).await.unwrap(),
            "publish" => crate::git::ops::push_set_upstream(&f.cli, &f.root)
                .await
                .unwrap(),
            "resolve" => {
                crate::git::sync::resolve_and_continue(&f.cli, &f.root)
                    .await
                    .unwrap();
            }
            _ => {
                crate::git::sync::sync(&f.cli, &f.root).await.unwrap();
            }
        }
        assert_eq!(count(&log, "--dry-run"), 1, "{publisher}");
        assert_eq!(destination_fetches(&log), 0, "{publisher}");
        assert_eq!(
            hook_count(&calls),
            usize::from(publisher != "noop"),
            "{publisher}"
        );
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]),
            git(&f.root, &["rev-parse", "HEAD"])
        );
    }
}

#[tokio::test]
async fn custom_rules_keep_authoritative_discovery_without_disabling_history_reuse() {
    for (mode, discoveries) in [
        ("simple", 1),
        ("current", 1),
        ("matching", 2),
        ("upstream", 2),
        ("refspec", 2),
        ("followtags", 2),
        ("legacy", 2),
        ("helper-rule", 2),
        ("rewrite", 2),
    ] {
        let f = Fixture::new();
        commit(&f.root, "note", "configured outgoing");
        match mode {
            "refspec" => {
                git(
                    &f.root,
                    &[
                        "config",
                        "remote.origin.push",
                        "refs/heads/main:refs/heads/main",
                    ],
                );
            }
            "followtags" => {
                git(&f.root, &["config", "push.followTags", "true"]);
                git(&f.root, &["tag", "-am", "release", "release"]);
            }
            "legacy" => {
                std::fs::create_dir(f.root.join(".git/remotes")).unwrap();
            }
            "helper-rule" => {
                git(&f.root, &["config", "remote.unused.vcs", "custom"]);
            }
            "rewrite" => {
                git(
                    &f.root,
                    &["config", "url.unused.insteadOf", "unused-prefix:"],
                );
            }
            _ => {
                git(&f.root, &["config", "push.default", mode]);
            }
        }
        let log = traced(&f, "");
        assert_eq!(f.push().await.unwrap().exit_code, 0, "{mode}");
        assert_eq!(count(&log, "--dry-run"), discoveries, "{mode}");
        assert_eq!(destination_fetches(&log), 0, "{mode}");
    }
}

#[tokio::test]
async fn unknown_destination_head_shallow_and_promisor_use_one_fetch() {
    for mode in ["unknown-head", "shallow", "promisor", "both-fallbacks"] {
        let mut f = Fixture::new();
        if mode == "unknown-head" || mode == "both-fallbacks" {
            let external = f._temp.path().join("external");
            git(
                f._temp.path(),
                &[
                    "clone",
                    f.remote.to_str().unwrap(),
                    external.to_str().unwrap(),
                ],
            );
            git(&external, &["config", "user.name", "Fixture"]);
            git(&external, &["config", "user.email", "fixture@example.test"]);
            git(&external, &["checkout", "-b", "other"]);
            commit(&external, "external", "unknown remote head");
            git(&external, &["push", "origin", "other"]);
        } else if mode == "shallow" {
            let shallow = f._temp.path().join("shallow");
            git(
                f._temp.path(),
                &[
                    "clone",
                    "--depth=1",
                    &format!("file://{}", f.remote.display()),
                    shallow.to_str().unwrap(),
                ],
            );
            f.root = shallow;
            git(&f.root, &["config", "user.name", "Fixture"]);
            git(&f.root, &["config", "user.email", "fixture@example.test"]);
        } else {
            git(&f.root, &["config", "remote.origin.promisor", "true"]);
        }
        if mode == "both-fallbacks" {
            git(&f.root, &["config", "push.default", "matching"]);
        }
        commit(&f.root, "note", "outgoing content");
        let before = git(&f.root, &["show-ref"]);
        let log = traced(&f, "");
        assert_eq!(f.push().await.unwrap().exit_code, 0, "{mode}");
        assert_eq!(destination_fetches(&log), 1, "{mode}");
        assert_eq!(
            count(&log, "--dry-run"),
            if mode == "both-fallbacks" { 2 } else { 1 },
            "{mode}"
        );
        assert_eq!(
            git(&f.remote, &["rev-parse", "main"]),
            git(&f.root, &["rev-parse", "HEAD"])
        );
        assert_eq!(
            git(&f.root, &["show-ref"])
                .lines()
                .filter(|s| !s.ends_with(" refs/remotes/origin/main")
                    && !s.ends_with(" refs/remotes/origin/HEAD"))
                .collect::<Vec<_>>(),
            before
                .lines()
                .filter(|s| !s.ends_with(" refs/remotes/origin/main")
                    && !s.ends_with(" refs/remotes/origin/HEAD"))
                .collect::<Vec<_>>()
        );
        if mode == "shallow" {
            assert_eq!(
                git(&f.root, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
                "refs/remotes/origin/main"
            );
            assert_eq!(
                git(&f.root, &["rev-parse", "--is-shallow-repository"]),
                "true"
            );
        }
    }
}

#[tokio::test]
async fn historical_sources_of_the_same_oid_have_independent_proofs_and_one_native_ref() {
    for deleted in [None, Some("old"), Some("new")] {
        let f = Fixture::new();
        let other = f._temp.path().join("other-source.git");
        git(
            f._temp.path(),
            &[
                "clone",
                "--bare",
                f.source.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(
            &f.root,
            &[
                "config",
                "-f",
                ".gitmodules",
                "submodule.logical child.url",
                other.to_str().unwrap(),
            ],
        );
        git(
            &f.root,
            &[
                "commit",
                "-am",
                "historical source change with the same child",
            ],
        );
        git(&f.remote, &["update-ref", "-d", "refs/heads/main"]);
        git(&f.root, &["branch", "--unset-upstream"]);
        if let Some(which) = deleted {
            git(
                if which == "old" { &f.source } else { &other },
                &["update-ref", "-d", "refs/heads/main"],
            );
        }
        let refs = git(&f.child, &["show-ref"]);
        let log = traced(&f, "");
        let result = super::super::push(&f.cli, &f.root, true).await;
        if deleted.is_some() {
            assert!(result.is_err(), "{deleted:?}");
            assert!(git(&f.remote, &["for-each-ref"]).is_empty());
        } else {
            assert_eq!(result.unwrap().exit_code, 0);
            assert_eq!(count(&log, "update-ref refs/remotes/svode-publication-"), 1);
            assert_eq!(count(&log, "ls-remote --refs --heads --tags"), 4);
            let recipient = f._temp.path().join("fresh");
            git(
                f._temp.path(),
                &[
                    "clone",
                    "--recurse-submodules",
                    f.remote.to_str().unwrap(),
                    recipient.to_str().unwrap(),
                ],
            );
            assert_eq!(
                git(&recipient.join("Пространство one"), &["rev-parse", "HEAD"]),
                git(&f.child, &["rev-parse", "HEAD"])
            );
        }
        assert_eq!(git(&f.child, &["show-ref"]), refs);
    }
}

#[tokio::test]
async fn local_snapshot_races_stop_publication_including_same_oid_branch_and_pseudo_refs() {
    for change in [
        "branch",
        "ref",
        "tag",
        "config",
        "modules",
        "fetch-url",
        "push-url",
        "pseudo-ref",
    ] {
        let f = Fixture::new();
        commit(&f.root, "note", "outgoing");
        if change == "pseudo-ref" {
            git(&f.root, &["update-ref", "ORIG_HEAD", "HEAD"]);
            git(
                &f.root,
                &["config", "remote.origin.push", "ORIG_HEAD:refs/heads/main"],
            );
        }
        let before = git(&f.remote, &["show-ref"]);
        let fixed = snapshot(&f.cli, &f.root, false).await.unwrap().unwrap();
        match change {
            "branch" => {
                git(&f.root, &["checkout", "-b", "same-oid"]);
            }
            "ref" => {
                git(&f.root, &["branch", "new-ref"]);
            }
            "tag" => {
                git(&f.root, &["tag", "new-tag"]);
            }
            "config" => {
                git(&f.root, &["config", "push.default", "matching"]);
            }
            "modules" => {
                std::fs::write(f.root.join(".gitmodules"), "changed source\n").unwrap();
            }
            "fetch-url" => {
                git(
                    &f.root,
                    &["remote", "set-url", "origin", f.source.to_str().unwrap()],
                );
            }
            "push-url" => {
                git(
                    &f.root,
                    &[
                        "remote",
                        "set-url",
                        "--push",
                        "origin",
                        f.source.to_str().unwrap(),
                    ],
                );
            }
            "pseudo-ref" => {
                git(&f.root, &["update-ref", "ORIG_HEAD", "HEAD~1"]);
            }
            _ => unreachable!(),
        }
        assert!(
            fixed.revalidate(&f.cli, &f.root, false).await.is_err(),
            "{change}"
        );
        assert_eq!(git(&f.remote, &["show-ref"]), before);
    }
}

#[tokio::test]
async fn final_destination_and_each_source_advertisement_detect_deletion() {
    for changed in ["destination", "source"] {
        let f = Fixture::new();
        commit(&f.child, "note", "published child");
        git(&f.child, &["push"]);
        f.pointer();
        let before = git(&f.remote, &["rev-parse", "main"]);
        let mutation_repo = if changed == "source" {
            &f.source
        } else {
            &f.remote
        };
        let injected = f._temp.path().join("injected");
        let injection = format!(
            "case \"$*\" in *for-each-ref*--contains=*) if [ ! -f {} ]; then touch {}; git -C {} update-ref -d refs/heads/main; fi ;; esac",
            shell(&injected),
            shell(&injected),
            shell(mutation_repo)
        );
        traced(&f, &injection);
        assert!(
            matches!(
                f.push().await,
                Err(GitError::PublicationBlocked {
                    reason: PublicationBlockReason::TargetChanged,
                    ..
                })
            ),
            "{changed}"
        );
        if changed == "destination" {
            assert!(git(&f.remote, &["for-each-ref"]).is_empty());
        } else {
            assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
        }
        assert!(!git(&f.child, &["show-ref"]).contains("svode-publication-"));
    }
}

#[tokio::test]
async fn fetch_and_push_targets_are_not_interchangeable_and_missing_objects_fail_closed() {
    for mode in ["push-target", "missing-blob"] {
        let f = Fixture::new();
        commit(&f.root, "note", "outgoing");
        let before = git(&f.remote, &["rev-parse", "main"]);
        if mode == "push-target" {
            let target = f._temp.path().join("push.git");
            git(
                f._temp.path(),
                &[
                    "clone",
                    "--bare",
                    f.remote.to_str().unwrap(),
                    target.to_str().unwrap(),
                ],
            );
            git(&target, &["update-ref", "-d", "refs/heads/main"]);
            git(
                &f.root,
                &[
                    "remote",
                    "set-url",
                    "--push",
                    "origin",
                    target.to_str().unwrap(),
                ],
            );
            assert_eq!(f.push().await.unwrap().exit_code, 0);
            assert_eq!(
                git(&target, &["rev-parse", "main"]),
                git(&f.root, &["rev-parse", "HEAD"])
            );
        } else {
            let fixed = snapshot(&f.cli, &f.root, false).await.unwrap().unwrap();
            let oid = git(&f.root, &["rev-parse", "HEAD:note"]);
            std::fs::remove_file(f.root.join(".git/objects").join(&oid[..2]).join(&oid[2..]))
                .unwrap();
            assert!(super::super::prove(&f.cli, &f.root, &fixed).await.is_err());
        }
        assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    }
}

#[tokio::test]
async fn pull_merge_checks_gitlinks_introduced_by_the_new_outgoing_history() {
    let f = Fixture::new();
    let other = f._temp.path().join("collaborator");
    git(
        f._temp.path(),
        &["clone", f.remote.to_str().unwrap(), other.to_str().unwrap()],
    );
    git(&other, &["config", "user.name", "Fixture"]);
    git(&other, &["config", "user.email", "fixture@example.test"]);
    commit(&f.child, "note", "not published to the clone source");
    let child = git(&f.child, &["rev-parse", "HEAD"]);
    git(
        &other,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{child},Пространство one"),
        ],
    );
    git(&other, &["commit", "-m", "external pointer"]);
    git(&other, &["push", "--recurse-submodules=no"]);
    let before = git(&f.remote, &["rev-parse", "main"]);
    commit(&f.root, "note", "local content");
    assert!(matches!(
        crate::git::sync::sync(&f.cli, &f.root).await,
        Err(GitError::PublicationBlocked {
            reason: PublicationBlockReason::RevisionUnavailable,
            ..
        })
    ));
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), before);
    assert_eq!(
        git(&f.root, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    git(&f.child, &["push"]);
    assert!(matches!(
        crate::git::sync::sync(&f.cli, &f.root).await,
        Ok(crate::git::sync::SyncResult::Success { .. })
    ));
}
