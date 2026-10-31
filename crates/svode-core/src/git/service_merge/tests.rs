#![cfg(unix)]
use super::*;
use crate::git::sync::{SyncResult, merge_service_files, preflight, sync};
use std::path::PathBuf;
use std::process::Command;

/// A rule only the set holds: a conflict in this file takes the sorted lines
/// of both sides.
pub(super) struct ProbeRule;

const PROBE: &str = "probe.svode-merge-test";

impl ServiceRule for ProbeRule {
    fn claims(&self, conflict: &ConflictedPath) -> bool {
        conflict.path == PROBE && conflict.sides().all(StageEntry::is_regular_file)
    }

    fn resolve<'a>(
        &'a self,
        ctx: &'a RuleContext<'a>,
        conflict: &'a ConflictedPath,
    ) -> RuleFuture<'a> {
        Box::pin(async move {
            let mut lines = std::collections::BTreeSet::new();
            for side in [&conflict.ours, &conflict.theirs] {
                let bytes = ctx.blob(side.as_ref()).await?.unwrap_or_default();
                lines.extend(String::from_utf8(bytes).unwrap().lines().map(str::to_owned));
            }
            let text: String = lines.into_iter().map(|line| line + "\n").collect();
            Ok(RuleOutcome::Resolved(Resolution::Content(
                text.into_bytes(),
            )))
        })
    }
}

const ORDER: &str = ".svode/order.json";
const INLINE_ORDER: &str = "docs/.svode/order.json";

/// A project published to a bare remote and cloned twice, `local` and
/// `other`; with [`Fixture::with_space`] it holds a submodule Space with its
/// own bare remote.
struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    remote: PathBuf,
    local: PathBuf,
    other: PathBuf,
    space_remote: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            "[user]\n\tname = Fixture\n\temail = fixture@example.test\n\
             [protocol \"file\"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n",
        )
        .unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            &format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
                global.display()
            ),
        )
        .unwrap();
        let f = Self {
            remote: temp.path().join("remote.git"),
            local: temp.path().join("local"),
            other: temp.path().join("other"),
            space_remote: temp.path().join("space.git"),
            cli: GitCli::for_test(wrapper),
            global,
            temp,
        };
        let seed = f.temp.path().join("seed");
        f.seed(
            &f.remote,
            &seed,
            &[
                (ORDER, r#"{".": ["a.md", "b.md"]}"#),
                (INLINE_ORDER, r#"{".": ["x.md"]}"#),
                ("page.md", "base\n"),
                (PROBE, "base\n"),
            ],
        );
        f.clone_into(&f.remote, &f.local);
        f.clone_into(&f.remote, &f.other);
        f
    }

    /// Adds the Space `space` at its first revision to both clones.
    fn with_space(self) -> Self {
        let seed = self.temp.path().join("space-seed");
        self.seed(&self.space_remote, &seed, &[("page.md", "space\n")]);
        let remote = self.space_remote.to_str().unwrap().to_owned();
        self.git(&self.local, &["submodule", "add", "-q", &remote, "space"]);
        self.git(&self.local, &["commit", "-qm", "space"]);
        self.git(&self.local, &["push", "-q", "origin", "main"]);
        self.git(
            &self.other,
            &["pull", "-q", "--no-rebase", "origin", "main"],
        );
        self.git(&self.other, &["submodule", "update", "-q", "--init"]);
        self
    }

    fn seed(&self, remote: &Path, clone: &Path, files: &[(&str, &str)]) {
        let root = self.temp.path();
        self.git(root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        self.clone_into(remote, clone);
        self.git(clone, &["checkout", "-q", "-B", "main"]);
        for (path, content) in files {
            self.write(clone, path, content);
        }
        self.git(clone, &["add", "."]);
        self.git(clone, &["commit", "-qm", "base"]);
        self.git(clone, &["push", "-q", "-u", "origin", "main"]);
    }

    fn clone_into(&self, remote: &Path, clone: &Path) {
        self.git(
            self.temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        crate::git::policy::exclude_device_local(clone);
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = self.run(repo, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim_end().into()
    }

    fn run(&self, repo: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", &self.global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap()
    }

    fn write(&self, repo: &Path, path: &str, content: &str) {
        let target = repo.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }

    fn read(&self, repo: &Path, path: &str) -> String {
        std::fs::read_to_string(repo.join(path)).unwrap()
    }

    /// Commits `files` in `repo`.
    fn commit(&self, repo: &Path, files: &[(&str, &str)]) -> String {
        for (path, content) in files {
            self.write(repo, path, content);
        }
        self.git(repo, &["add", "-A"]);
        self.git(repo, &["commit", "-qm", "change"]);
        self.git(repo, &["rev-parse", "HEAD"])
    }

    /// `other` publishes `files`.
    fn incoming(&self, files: &[(&str, &str)]) -> String {
        let oid = self.commit(&self.other, files);
        self.git(&self.other, &["push", "-q", "origin", "main"]);
        oid
    }

    fn head(&self, repo: &Path) -> String {
        self.git(repo, &["rev-parse", "HEAD"])
    }

    fn unmerged(&self, repo: &Path) -> Vec<String> {
        let listing = self.git(repo, &["diff", "--name-only", "--diff-filter=U"]);
        listing.lines().map(str::to_owned).collect()
    }

    fn order(&self, repo: &Path, path: &str) -> serde_json::Value {
        serde_json::from_str(&self.read(repo, path)).unwrap()
    }

    fn space(&self, clone: &Path) -> PathBuf {
        clone.join("space")
    }

    /// The pointer the HEAD of a project clone records.
    fn pointer(&self, clone: &Path) -> String {
        self.git(clone, &["rev-parse", "HEAD:space"])
    }

    /// Commits `file` in the Space of `clone` and records the pointer in
    /// the project, publishing the Space when asked.
    fn space_commit(&self, clone: &Path, file: &str, publish: bool) -> String {
        let space = self.space(clone);
        let oid = self.commit(&space, &[(file, file)]);
        if publish {
            self.git(&space, &["push", "-q", "origin", "HEAD:main"]);
        }
        self.git(clone, &["add", "space"]);
        self.git(clone, &["commit", "-qm", "pointer"]);
        oid
    }

    /// What the Space of `clone` shows besides its objects: checkout,
    /// refs, index, config and `FETCH_HEAD`.
    fn space_state(&self, clone: &Path) -> (String, String, String, String, bool) {
        let space = self.space(clone);
        let fetch_head = space.join(self.git(&space, &["rev-parse", "--git-path", "FETCH_HEAD"]));
        (
            self.head(&space),
            self.git(&space, &["for-each-ref"]),
            self.git(&space, &["ls-files", "--stage"]),
            self.git(&space, &["config", "--local", "--list"]),
            fetch_head.exists(),
        )
    }

    fn has_commit(&self, repo: &Path, oid: &str) -> bool {
        self.run(repo, &["cat-file", "-e", &format!("{oid}^{{commit}}")])
            .status
            .success()
    }
}

#[tokio::test]
async fn explicit_sync_merges_the_order_and_leaves_the_page_to_the_person() {
    let f = Fixture::new();
    f.incoming(&[
        (ORDER, r#"{".": ["a.md", "b.md", "theirs.md"]}"#),
        ("page.md", "remote\n"),
    ]);
    f.commit(
        &f.local,
        &[
            (ORDER, r#"{".": ["a.md", "mine.md", "b.md"]}"#),
            ("page.md", "local\n"),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            merged,
            service,
        } => {
            assert_eq!(files, &["page.md"]);
            assert_eq!(merged, &[ORDER]);
            assert!(service.is_empty(), "{service:?}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.unmerged(&f.local), ["page.md"]);
    assert_eq!(
        f.order(&f.local, ORDER),
        serde_json::json!({".": ["a.md", "mine.md", "b.md", "theirs.md"]})
    );
    // The merged order is staged as resolved; the page keeps its markers.
    assert_eq!(f.git(&f.local, &["diff", "--name-only", "--", ORDER]), "");
    assert!(f.read(&f.local, "page.md").contains("<<<<<<<"));
}

#[tokio::test]
async fn a_conflict_only_in_order_files_finishes_the_sync() {
    let f = Fixture::new();
    let incoming = f.incoming(&[
        (ORDER, r#"{".": ["b.md", "a.md", "c.md"]}"#),
        (INLINE_ORDER, r#"{".": ["x.md", "z.md"]}"#),
    ]);
    let local = f.commit(
        &f.local,
        &[
            (ORDER, r#"{".": ["a.md", "b.md", "d.md"], "sub": ["s.md"]}"#),
            (INLINE_ORDER, r#"{".": ["y.md", "x.md"]}"#),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[ORDER, INLINE_ORDER]),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        f.git(&f.local, &["rev-parse", "HEAD^1", "HEAD^2"]),
        format!("{local}\n{incoming}")
    );
    let message = f.git(&f.local, &["log", "-1", "--format=%B"]);
    assert_eq!(message, "Merge remote-tracking branch 'origin/main'");
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(
        f.order(&f.local, ORDER),
        // `d.md` follows its local neighbour `b.md`.
        serde_json::json!({".": ["b.md", "d.md", "a.md", "c.md"], "sub": ["s.md"]})
    );
    assert_eq!(
        f.order(&f.local, INLINE_ORDER),
        serde_json::json!({".": ["y.md", "x.md", "z.md"]})
    );
}

#[tokio::test]
async fn an_unreadable_order_side_stays_with_the_person() {
    let f = Fixture::new();
    f.incoming(&[(ORDER, r#"{".": ["a.md", "c.md"]}"#)]);
    f.commit(&f.local, &[(ORDER, "{ not json")]);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            merged,
            service,
        } => {
            assert_eq!(files, &[ORDER]);
            assert!(merged.is_empty() && service.is_empty(), "{result:?}");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_merge_started_outside_svode_is_left_until_the_action_applies_the_same_rule() {
    let f = Fixture::new();
    f.incoming(&[(ORDER, r#"{".": ["a.md", "b.md", "theirs.md"]}"#)]);
    let local = f.commit(
        &f.local,
        &[(ORDER, r#"{".": ["mine.md", "a.md", "b.md"]}"#)],
    );
    f.git(&f.local, &["fetch", "-q"]);
    // The terminal merges.
    assert!(!f.run(&f.local, &["merge", "origin/main"]).status.success());
    let index = f.git(&f.local, &["ls-files", "--stage"]);

    let stop = preflight(&f.cli, &f.local).await.unwrap();

    match &stop {
        Some(SyncResult::Conflict {
            files,
            merged,
            service,
        }) => {
            assert_eq!(files, &[ORDER]);
            assert!(merged.is_empty());
            assert_eq!(
                service,
                &[ServiceFile {
                    path: ORDER.into(),
                    state: ServiceFileState::Mergeable,
                }]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        f.git(&f.local, &["ls-files", "--stage"]),
        index,
        "Svode does not change the index itself"
    );

    let result = merge_service_files(&f.cli, &f.local, None).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[ORDER]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.git(&f.local, &["rev-parse", "HEAD^1"]), local);
    assert_eq!(
        f.order(&f.local, ORDER),
        serde_json::json!({".": ["mine.md", "a.md", "b.md", "theirs.md"]})
    );
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}

#[tokio::test]
async fn the_action_refuses_another_operation() {
    let f = Fixture::new();
    f.incoming(&[(ORDER, r#"{".": ["theirs.md"]}"#)]);
    f.commit(&f.local, &[(ORDER, r#"{".": ["mine.md"]}"#)]);
    f.git(&f.local, &["fetch", "-q"]);
    assert!(!f.run(&f.local, &["rebase", "origin/main"]).status.success());

    let result = merge_service_files(&f.cli, &f.local, None).await.unwrap();

    assert!(
        matches!(result, SyncResult::OperationInProgress { .. }),
        "{result:?}"
    );
    assert_eq!(f.unmerged(&f.local), [ORDER]);
}

// ---- A rule held only by the set applies in all three callers ----

#[tokio::test]
async fn a_rule_added_to_the_set_applies_to_svode_merges() {
    let f = Fixture::new();
    f.incoming(&[(PROBE, "base\ntheirs\n")]);
    f.commit(&f.local, &[(PROBE, "base\nmine\n")]);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[PROBE]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, PROBE), "base\nmine\ntheirs\n");
}

#[tokio::test]
async fn a_rule_added_to_the_set_applies_to_the_action_for_an_outside_merge() {
    let f = Fixture::new();
    f.incoming(&[(PROBE, "base\ntheirs\n")]);
    f.commit(&f.local, &[(PROBE, "base\nmine\n")]);
    f.git(&f.local, &["fetch", "-q"]);
    assert!(!f.run(&f.local, &["merge", "origin/main"]).status.success());

    let result = merge_service_files(&f.cli, &f.local, None).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[PROBE]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, PROBE), "base\nmine\ntheirs\n");
}

#[tokio::test]
async fn a_rule_added_to_the_set_applies_to_the_in_memory_preflight() {
    let f = Fixture::new();
    let incoming = f.incoming(&[(PROBE, "base\ntheirs\n"), (ORDER, r#"{".": ["t.md"]}"#)]);
    f.commit(
        &f.local,
        &[(PROBE, "base\nmine\n"), (ORDER, r#"{".": ["m.md"]}"#)],
    );
    f.git(&f.local, &["fetch", "-q"]);
    let head = f.head(&f.local);
    let out = f.run(
        &f.local,
        &["merge-tree", "--write-tree", "-z", "HEAD", &incoming],
    );
    assert_eq!(out.status.code(), Some(1), "merge-tree reports conflicts");

    let merge = parse_merge_tree(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
    let mut paths: Vec<&str> = merge.conflicts.iter().map(|c| c.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, [ORDER, PROBE]);
    assert!(
        merge
            .conflicts
            .iter()
            .all(|c| c.base.is_some() && c.ours.is_some() && c.theirs.is_some())
    );

    let evaluated = evaluate(&f.cli, &f.local, &merge.conflicts, Objects::Fetch)
        .await
        .unwrap();
    assert_eq!(evaluated.len(), 2);
    let probe = evaluated
        .iter()
        .find(|item| item.conflict.path == PROBE)
        .unwrap();
    assert_eq!(
        probe.outcome,
        RuleOutcome::Resolved(Resolution::Content(b"base\nmine\ntheirs\n".to_vec()))
    );
    assert!(
        resolves_all(&f.cli, &f.local, &merge.conflicts, Objects::Fetch)
            .await
            .unwrap()
    );
    // Nothing of the repository changed.
    assert_eq!(f.head(&f.local), head);
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");

    // A page conflict is not a service conflict.
    f.git(&f.local, &["reset", "-q", "--hard", "HEAD~1"]);
    f.commit(&f.local, &[("page.md", "mine\n")]);
    let other = f.incoming(&[("page.md", "theirs\n")]);
    f.git(&f.local, &["fetch", "-q"]);
    let out = f.run(
        &f.local,
        &["merge-tree", "--write-tree", "-z", "HEAD", &other],
    );
    let merge = parse_merge_tree(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
    assert!(
        !resolves_all(&f.cli, &f.local, &merge.conflicts, Objects::Fetch)
            .await
            .unwrap()
    );
}

#[test]
fn a_clean_merge_tree_has_no_conflicts() {
    let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    assert_eq!(
        parse_merge_tree(&format!("{tree}\0")),
        Some(MergeTree {
            tree: tree.into(),
            conflicts: Vec::new(),
            messages: Vec::new(),
        })
    );
    assert_eq!(parse_merge_tree(""), None);
}

// ---- Space pointer ----

#[tokio::test]
async fn an_incoming_descendant_pointer_is_taken_after_fetching_its_objects() {
    let f = Fixture::new().with_space();
    // The Space remote holds P1 and then P2; the local Space has only P1.
    let p1 = f.commit(&f.space(&f.other), &[("page.md", "p1\n")]);
    f.git(&f.space(&f.other), &["push", "-q", "origin", "HEAD:main"]);
    f.git(
        &f.space(&f.local),
        &["pull", "-q", "--no-rebase", "origin", "main"],
    );
    f.git(&f.local, &["add", "space"]);
    f.git(&f.local, &["commit", "-qm", "pointer p1"]);
    let p2 = f.space_commit(&f.other, "p2.md", true);
    f.git(&f.other, &["push", "-q", "origin", "main"]);
    assert_eq!(f.pointer(&f.local), p1);
    assert!(!f.has_commit(&f.space(&f.local), &p2));
    let before = f.space_state(&f.local);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &["space"]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.pointer(&f.local), p2);
    assert!(f.has_commit(&f.space(&f.local), &p2), "objects fetched");
    assert_eq!(
        f.space_state(&f.local),
        before,
        "Space checkout, refs, index and config stay"
    );
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}

#[tokio::test]
async fn the_pointer_rule_takes_the_descendant_side_or_the_space_checkout() {
    let f = Fixture::new().with_space();
    let space = f.space(&f.local);
    let base = f.head(&space);
    let older = f.commit(&space, &[("page.md", "older\n")]);
    let newer = f.commit(&space, &[("page.md", "newer\n")]);
    f.git(&space, &["checkout", "-q", "-b", "side", &base]);
    let side = f.commit(&space, &[("page.md", "side\n")]);
    f.git(&space, &["checkout", "-q", "main"]);
    let gitlink = |oid: &str| {
        Some(StageEntry {
            mode: "160000".into(),
            oid: oid.into(),
        })
    };
    let conflict = |ours: &str, theirs: &str| ConflictedPath {
        path: "space".into(),
        base: gitlink(&base),
        ours: gitlink(ours),
        theirs: gitlink(theirs),
    };
    let decide = |conflict: ConflictedPath| {
        let cli = f.cli.clone();
        let repo = f.local.clone();
        async move {
            evaluate(&cli, &repo, &[conflict], Objects::Local)
                .await
                .unwrap()
                .remove(0)
                .outcome
        }
    };
    let resolved = |oid: &str| RuleOutcome::Resolved(Resolution::Gitlink(oid.into()));

    assert_eq!(decide(conflict(&older, &newer)).await, resolved(&newer));
    assert_eq!(decide(conflict(&newer, &older)).await, resolved(&newer));
    assert_eq!(
        decide(conflict(&newer, &side)).await,
        RuleOutcome::Unresolved(UnresolvedReason::SpaceDiverged)
    );
    // After a merge in the Space its checkout contains both sides.
    f.git(&space, &["merge", "-q", "--no-edit", "-X", "ours", "side"]);
    let merged = f.head(&space);
    assert_eq!(decide(conflict(&newer, &side)).await, resolved(&merged));
    // A revision the Space lacks is not fetched in a local read.
    let absent = "1111111111111111111111111111111111111111";
    assert_eq!(
        decide(conflict(&newer, absent)).await,
        RuleOutcome::Unresolved(UnresolvedReason::SpaceUnavailable)
    );
    // A Space removed by one side is the person's conflict.
    let removed = ConflictedPath {
        theirs: None,
        ..conflict(&older, &newer)
    };
    assert!(
        evaluate(&f.cli, &f.local, &[removed], Objects::Local)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_diverged_pointer_resolves_after_the_space_is_synced() {
    let f = Fixture::new().with_space();
    let theirs = f.space_commit(&f.other, "theirs.md", true);
    f.git(&f.other, &["push", "-q", "origin", "main"]);
    let ours = f.space_commit(&f.local, "ours.md", false);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            merged,
            service,
        } => {
            assert_eq!(files, &["space"]);
            assert!(merged.is_empty());
            assert_eq!(
                service,
                &[ServiceFile {
                    path: "space".into(),
                    state: ServiceFileState::SpaceDiverged,
                }]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.head(&f.space(&f.local)), ours, "the Space checkout stays");

    // «Синхронизировать пространство»: the Space merges both revisions...
    let space_result = sync(&f.cli, &f.space(&f.local)).await.unwrap();
    assert!(
        matches!(space_result, SyncResult::Success { .. }),
        "{space_result:?}"
    );
    let space_head = f.head(&f.space(&f.local));
    assert_eq!(
        f.git(&f.space(&f.local), &["rev-parse", "HEAD^1", "HEAD^2"]),
        format!("{ours}\n{theirs}")
    );
    // ...and the pointer of the project merge resolves to its revision.
    let only = ["space".to_owned()];
    let result = merge_service_files(&f.cli, &f.local, Some(&only))
        .await
        .unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &["space"]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.pointer(&f.local), space_head);
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}

#[tokio::test]
async fn an_unavailable_space_revision_stays_a_conflict_with_its_reason() {
    let f = Fixture::new().with_space();
    // The colleague recorded a Space revision it never published.
    f.space_commit(&f.other, "unpublished.md", false);
    f.git(&f.other, &["push", "-q", "origin", "main"]);
    f.space_commit(&f.local, "ours.md", false);
    let before = f.space_state(&f.local);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict { files, service, .. } => {
            assert_eq!(files, &["space"]);
            assert_eq!(
                service,
                &[ServiceFile {
                    path: "space".into(),
                    state: ServiceFileState::SpaceUnavailable,
                }]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.space_state(&f.local), before);
}
