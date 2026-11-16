#![cfg(unix)]
use super::GitError;
use super::cli::GitCli;
use super::sync::{SyncResult, resolve_and_continue, sync};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim_end().into()
}

fn lines(output: String) -> Vec<String> {
    output.lines().map(str::to_string).collect()
}

fn write(repo: &Path, file: &str, value: &str) {
    let path = repo.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}

fn init(repo: &Path) {
    std::fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-b", "main"]);
    git(repo, &["config", "user.name", "Fixture"]);
    git(repo, &["config", "user.email", "fixture@example.test"]);
}

fn test_cli(temp: &Path) -> GitCli {
    let wrapper = temp.join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
    )
    .unwrap();
    GitCli::for_test(wrapper)
}

/// Two clones of one remote; pulling into `local` conflicts in `plan.md`,
/// `data.json` and `old.md` (modify/delete) while `notes.md` and
/// `stray.md` carry unrelated uncommitted work.
struct MergeFixture {
    _temp: tempfile::TempDir,
    remote: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl MergeFixture {
    async fn conflicted() -> Self {
        Self::conflicted_with_attributes("").await
    }

    /// Git attributes of `local` apply to the merge, as a checked-in
    /// `.gitattributes` would.
    async fn conflicted_with_attributes(attributes: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        init(&seed);
        write(&seed, "plan.md", "# Plan\n\nshared line\n");
        write(&seed, "old.md", "old\n");
        write(&seed, "notes.md", "notes\n");
        write(&seed, "data.json", "{\"order\":[\"plan.md\"]}\n");
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "base"]);
        let remote = temp.path().join("remote.git");
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );

        let other = temp.path().join("other");
        let local = temp.path().join("local");
        for clone in [&other, &local] {
            git(
                temp.path(),
                &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
            );
            git(clone, &["config", "user.name", "Fixture"]);
            git(clone, &["config", "user.email", "fixture@example.test"]);
            crate::git::policy::exclude_device_local(clone);
        }
        write(&other, "plan.md", "# Plan\n\ntheir line\n");
        write(
            &other,
            "data.json",
            "{\"order\":[\"plan.md\",\"theirs.md\"]}\n",
        );
        git(&other, &["rm", "-q", "old.md"]);
        git(&other, &["commit", "-am", "theirs"]);
        git(&other, &["push", "-q", "origin", "main"]);

        write(&local, "plan.md", "# Plan\n\nour line\n");
        write(
            &local,
            "data.json",
            "{\"order\":[\"plan.md\",\"ours.md\"]}\n",
        );
        write(&local, "old.md", "old, kept\n");
        git(&local, &["commit", "-am", "ours"]);
        write(&local, "notes.md", "unsaved notes\n");
        write(&local, "stray.md", "stray\n");
        write(&local, ".git/info/attributes", attributes);

        let cli = test_cli(temp.path());
        let result = sync(&cli, &local).await.unwrap();
        let SyncResult::Conflict { mut files, .. } = result else {
            panic!("{result:?}");
        };
        files.sort();
        assert_eq!(files, ["data.json", "old.md", "plan.md"]);
        Self {
            _temp: temp,
            remote,
            local,
            cli,
        }
    }

    async fn resolve(&self, paths: &[&str]) -> Result<SyncResult, GitError> {
        let paths = paths
            .iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>();
        resolve_and_continue(&self.cli, &self.local, &paths).await
    }

    fn unmerged(&self) -> Vec<String> {
        let mut files = lines(git(
            &self.local,
            &["diff", "--name-only", "--diff-filter=U"],
        ));
        files.dedup();
        files
    }

    fn remote_main(&self) -> String {
        git(&self.remote, &["rev-parse", "main"])
    }
}

#[tokio::test]
async fn resolving_one_path_keeps_the_merge_open_and_unrelated_work_unstaged() {
    let f = MergeFixture::conflicted().await;
    let head = git(&f.local, &["rev-parse", "HEAD"]);
    let remote = f.remote_main();

    // A lone `=======` is a Markdown heading underline, not a marker.
    write(
        &f.local,
        "plan.md",
        "Plan\n=======\n\nour line\ntheir line\n",
    );
    // A passed path that still carries markers is refused, by its reason and
    // path, without touching the index or committing.
    let index = git(&f.local, &["ls-files", "--stage"]);
    let refused = f.resolve(&["plan.md", "data.json"]).await;
    assert!(
        matches!(&refused, Err(GitError::ConflictMarkers { path }) if path == "data.json"),
        "{refused:?}"
    );
    assert_eq!(git(&f.local, &["ls-files", "--stage"]), index);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), head);

    let result = f
        .resolve(&["plan.md", "notes.md", "stray.md"])
        .await
        .unwrap();
    let SyncResult::Conflict { mut files, .. } = result else {
        panic!("{result:?}");
    };
    files.sort();
    assert_eq!(files, ["data.json", "old.md"]);
    assert_eq!(f.unmerged(), ["data.json", "old.md"]);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), head);
    // The merge stays in progress.
    git(&f.local, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    assert_eq!(f.remote_main(), remote);
    let staged = lines(git(&f.local, &["diff", "--cached", "--name-only"]));
    assert!(staged.contains(&"plan.md".to_string()), "{staged:?}");
    assert!(!staged.contains(&"notes.md".to_string()), "{staged:?}");
    assert!(!staged.contains(&"stray.md".to_string()), "{staged:?}");
}

#[tokio::test]
async fn merge_commit_holds_only_the_merge_and_resolved_paths_and_is_pushed() {
    let f = MergeFixture::conflicted().await;
    let ours = git(&f.local, &["rev-parse", "HEAD"]);
    write(&f.local, "plan.md", "# Plan\n\nour line\ntheir line\n");
    assert!(matches!(
        f.resolve(&["plan.md"]).await.unwrap(),
        SyncResult::Conflict { .. }
    ));
    write(
        &f.local,
        "data.json",
        "{\"order\":[\"plan.md\",\"ours.md\",\"theirs.md\"]}\n",
    );
    assert!(matches!(
        f.resolve(&["data.json"]).await.unwrap(),
        SyncResult::Conflict { .. }
    ));
    // The modify/delete conflict of `old.md` ends by an explicit choice.
    let result = super::conflict_file::resolve(
        &f.cli,
        &f.local,
        "old.md",
        &super::conflict_file::FileResolution::Side {
            side: super::conflict_file::Side::Ours,
        },
    )
    .await
    .unwrap();
    let SyncResult::Success { published_head, .. } = result else {
        panic!("{result:?}");
    };

    let head = git(&f.local, &["rev-parse", "HEAD"]);
    assert_eq!(published_head, head);
    assert_eq!(f.remote_main(), head);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD^1"]), ours);
    assert!(f.unmerged().is_empty());
    let mut committed = lines(git(&f.local, &["diff", "--name-only", "HEAD^1", "HEAD"]));
    committed.sort();
    assert_eq!(committed, ["data.json", "plan.md"]);
    assert_eq!(git(&f.local, &["show", "HEAD:old.md"]), "old, kept");
    assert_eq!(git(&f.local, &["show", "HEAD:notes.md"]), "notes");
    assert!(
        git(&f.local, &["ls-tree", "--name-only", "HEAD", "stray.md"]).is_empty(),
        "untracked work stays out of the merge"
    );
    assert_eq!(
        git(&f.local, &["status", "--porcelain"]),
        " M notes.md\n?? stray.md"
    );
}

#[tokio::test]
async fn conflicts_without_a_merge_never_commit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init(&repo);
    write(&repo, "plan.md", "base plan\n");
    write(&repo, "old.md", "base old\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    write(&repo, "plan.md", "stashed plan\n");
    write(&repo, "old.md", "stashed old\n");
    git(&repo, &["stash"]);
    write(&repo, "plan.md", "committed plan\n");
    write(&repo, "old.md", "committed old\n");
    git(&repo, &["commit", "-am", "committed"]);
    let pop = Command::new("git")
        .args(["stash", "pop"])
        .current_dir(&repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(!pop.status.success());
    let cli = test_cli(temp.path());
    let head = git(&repo, &["rev-parse", "HEAD"]);

    write(&repo, "plan.md", "resolved plan\n");
    let result = resolve_and_continue(&cli, &repo, &["plan.md".into()])
        .await
        .unwrap();
    assert!(
        matches!(&result, SyncResult::Conflict { files, .. } if files == &["old.md"]),
        "{result:?}"
    );

    write(&repo, "old.md", "resolved old\n");
    let result = resolve_and_continue(&cli, &repo, &["old.md".into()])
        .await
        .unwrap();
    assert!(matches!(result, SyncResult::Resolved), "{result:?}");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert!(git(&repo, &["ls-files", "--unmerged"]).is_empty());
    assert!(!super::ops::status(&cli, &repo).await.unwrap().has_conflicts);
}

#[tokio::test]
async fn markers_of_the_path_marker_size_refuse_resolution_under_any_line_endings() {
    for size in [10, 3] {
        let f = MergeFixture::conflicted_with_attributes(&format!(
            "*.md conflict-marker-size={size}\n"
        ))
        .await;
        // Git wrote markers of the configured size.
        let merged = std::fs::read_to_string(f.local.join("plan.md")).unwrap();
        assert!(
            merged.starts_with(&format!("# Plan\n\n{} HEAD\n", "<".repeat(size))),
            "{merged:?}"
        );
        let index = git(&f.local, &["ls-files", "--stage"]);
        for ending in ["\n", "\r\n"] {
            for marker in [
                format!("{} HEAD", "<".repeat(size)),
                "|".repeat(size),
                format!("{} base", "|".repeat(size)),
                format!("{} theirs", ">".repeat(size)),
            ] {
                write(
                    &f.local,
                    "plan.md",
                    &["# Plan", "", "our line", &marker, "their line", ""].join(ending),
                );
                let refused = f.resolve(&["plan.md"]).await;
                assert!(
                    matches!(&refused, Err(GitError::ConflictMarkers { path }) if path == "plan.md"),
                    "{size} {ending:?} {marker:?}: {refused:?}"
                );
                assert_eq!(git(&f.local, &["ls-files", "--stage"]), index);
            }
        }
    }
}

#[tokio::test]
async fn crlf_file_with_default_markers_is_not_resolved() {
    let f = MergeFixture::conflicted().await;
    let index = git(&f.local, &["ls-files", "--stage"]);
    for marker in ["<<<<<<< HEAD", "|||||||", "||||||| base", ">>>>>>> theirs"] {
        write(
            &f.local,
            "plan.md",
            &format!("# Plan\r\n\r\nour line\r\n{marker}\r\ntheir line\r\n"),
        );
        let refused = f.resolve(&["plan.md"]).await;
        assert!(
            matches!(&refused, Err(GitError::ConflictMarkers { path }) if path == "plan.md"),
            "{marker:?}: {refused:?}"
        );
        assert_eq!(git(&f.local, &["ls-files", "--stage"]), index);
    }
}

#[tokio::test]
async fn marker_like_lines_of_another_size_and_lone_separators_resolve() {
    for (attributes, content) in [
        (
            "*.md conflict-marker-size=10\n",
            "# Plan\r\n<<<<<<< a\r\n||||||| b\r\n|||||||\r\n=======\r\n==========\r\n>>>>>>> c\r\n",
        ),
        (
            "*.md conflict-marker-size=3\n",
            "# Plan\n<<<<<<< a\n||||||| b\n===\n>>>>>>> c\n> quote\n",
        ),
        (
            "",
            "# Plan\n<<<<<<<<<< a\n<<<<<<<x\n|||||||| b\n=======\n>>>>>> c\n",
        ),
    ] {
        let f = MergeFixture::conflicted_with_attributes(attributes).await;
        write(&f.local, "plan.md", content);
        let result = f.resolve(&["plan.md"]).await.unwrap();
        assert!(
            matches!(&result, SyncResult::Conflict { files, .. } if !files.contains(&"plan.md".to_string())),
            "{attributes:?}: {result:?}"
        );
        let staged = lines(git(&f.local, &["diff", "--cached", "--name-only"]));
        assert!(staged.contains(&"plan.md".to_string()), "{staged:?}");
    }
}

fn git_status(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap()
        .status
        .success()
}

fn stage_pointer(repo: &Path, digit: char) {
    let oid: String = std::iter::repeat_n(digit, 40).collect();
    git(
        repo,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{oid},space"),
        ],
    );
}

/// A merge in progress in `local` of a clone of a remote, with every kind of
/// conflict: text `notes.md`, modify/delete `edited.md` and `dir/gone.md`,
/// rename/delete `renamed.md` → `renamed-ours.md`, rename/rename `moved.md`
/// → `moved-ours.md` / `moved-theirs.md`, binary `image.png`, binary add/add
/// `both.md`, text add/add `added.md` and the Space pointer `space`.
async fn every_kind() -> (tempfile::TempDir, PathBuf, GitCli) {
    let temp = tempfile::tempdir().unwrap();
    let seed = temp.path().join("seed");
    init(&seed);
    write(&seed, "notes.md", "a\nb\nc\n");
    write(&seed, "edited.md", "one\n");
    write(&seed, "dir/gone.md", "gone\n");
    write(&seed, "renamed.md", "rename me\nplease\n");
    write(&seed, "moved.md", "line 1\nline 2\nline 3\n");
    std::fs::write(seed.join("image.png"), b"PNG\0base").unwrap();
    git(&seed, &["add", "-A"]);
    stage_pointer(&seed, '1');
    std::fs::create_dir_all(seed.join("space")).unwrap();
    git(&seed, &["commit", "-qm", "base"]);
    let remote = temp.path().join("remote.git");
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            "--bare",
            seed.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    let other = temp.path().join("other");
    let local = temp.path().join("local");
    for clone in [&other, &local] {
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        git(clone, &["config", "user.name", "Fixture"]);
        git(clone, &["config", "user.email", "fixture@example.test"]);
    }

    write(&other, "notes.md", "a\ntheirs\nc\n");
    std::fs::remove_file(other.join("edited.md")).unwrap();
    write(&other, "dir/gone.md", "gone, theirs\n");
    std::fs::remove_file(other.join("renamed.md")).unwrap();
    git(&other, &["mv", "moved.md", "moved-theirs.md"]);
    std::fs::write(other.join("image.png"), b"PNG\0theirs").unwrap();
    std::fs::write(other.join("both.md"), b"theirs\0").unwrap();
    write(&other, "added.md", "theirs\n");
    git(&other, &["add", "-A"]);
    stage_pointer(&other, '2');
    git(&other, &["commit", "-qm", "theirs"]);
    git(&other, &["push", "-q", "origin", "main"]);

    write(&local, "notes.md", "a\nours\nc\n");
    write(&local, "edited.md", "one, ours\n");
    std::fs::remove_file(local.join("dir/gone.md")).unwrap();
    git(&local, &["mv", "renamed.md", "renamed-ours.md"]);
    git(&local, &["mv", "moved.md", "moved-ours.md"]);
    std::fs::write(local.join("image.png"), b"PNG\0ours").unwrap();
    std::fs::write(local.join("both.md"), b"ours\0").unwrap();
    write(&local, "added.md", "ours\n");
    git(&local, &["add", "-A"]);
    stage_pointer(&local, '3');
    git(&local, &["commit", "-qm", "ours"]);
    git(&local, &["fetch", "-q", "origin"]);
    assert!(!git_status(&local, &["merge", "-q", "origin/main"]));

    let cli = test_cli(temp.path());
    let mut kinds: Vec<_> = super::conflict_kind::unresolved(&cli, &local)
        .await
        .unwrap()
        .into_iter()
        .map(|conflict| (conflict.path, conflict.kind))
        .collect();
    kinds.sort_by(|a, b| a.0.cmp(&b.0));
    use super::conflict_kind::ConflictKind::*;
    assert_eq!(
        kinds,
        [
            ("added.md".to_string(), AddAdd),
            ("both.md".to_string(), AddAdd),
            ("dir/gone.md".to_string(), ModifyDelete),
            ("edited.md".to_string(), ModifyDelete),
            ("image.png".to_string(), Binary),
            ("moved-ours.md".to_string(), RenameRename),
            ("notes.md".to_string(), PageText),
            ("renamed-ours.md".to_string(), RenameDelete),
            ("space".to_string(), SpacePointer),
        ]
    );
    (temp, local, cli)
}

#[tokio::test]
async fn a_conflict_its_markers_do_not_decide_refuses_the_request_and_changes_nothing() {
    let (_temp, local, cli) = every_kind().await;
    write(&local, "notes.md", "a\nours\ntheirs\nc\n");
    write(&local, "added.md", "ours\ntheirs\n");
    let index = git(&local, &["ls-files", "--stage"]);
    let merge_head = git(&local, &["rev-parse", "MERGE_HEAD"]);
    let head = git(&local, &["rev-parse", "HEAD"]);

    for (requested, refused) in [
        ("edited.md", "edited.md"),
        // A pathspec refuses by the entry under it.
        ("dir", "dir/gone.md"),
        ("renamed-ours.md", "renamed-ours.md"),
        ("moved-ours.md", "moved-ours.md"),
        ("moved-theirs.md", "moved-theirs.md"),
        ("moved.md", "moved.md"),
        ("image.png", "image.png"),
        ("both.md", "both.md"),
        ("space", "space"),
    ] {
        // Neither the refused path nor the text Page beside it is staged.
        let paths = ["notes.md".to_string(), requested.to_string()];
        let result = resolve_and_continue(&cli, &local, &paths).await;
        assert!(
            matches!(&result, Err(GitError::Conflict(message)) if message.starts_with(&format!("{refused} "))),
            "{requested}: {result:?}"
        );
        assert_eq!(git(&local, &["ls-files", "--stage"]), index, "{requested}");
        assert_eq!(git(&local, &["rev-parse", "MERGE_HEAD"]), merge_head);
        assert_eq!(git(&local, &["rev-parse", "HEAD"]), head);
    }

    // Text kinds resolve as before; the refused kinds stay in conflict.
    let result = resolve_and_continue(&cli, &local, &["notes.md".into(), "added.md".into()])
        .await
        .unwrap();
    let SyncResult::Conflict { mut files, .. } = result else {
        panic!("{result:?}");
    };
    files.sort();
    assert_eq!(
        files,
        [
            "both.md",
            "dir/gone.md",
            "edited.md",
            "image.png",
            "moved-ours.md",
            "moved-theirs.md",
            "moved.md",
            "renamed-ours.md",
            "space",
        ]
    );
    let staged = lines(git(&local, &["diff", "--cached", "--name-only"]));
    assert!(staged.contains(&"notes.md".to_string()), "{staged:?}");
    assert!(staged.contains(&"added.md".to_string()), "{staged:?}");
    assert_eq!(git(&local, &["rev-parse", "MERGE_HEAD"]), merge_head);
}

#[tokio::test]
async fn a_file_the_merge_attribute_makes_binary_is_not_resolved_by_its_file() {
    let f = MergeFixture::conflicted_with_attributes("*.json binary\n").await;
    let index = git(&f.local, &["ls-files", "--stage"]);
    let refused = f.resolve(&["data.json"]).await;
    assert!(
        matches!(&refused, Err(GitError::Conflict(message)) if message.starts_with("data.json ")),
        "{refused:?}"
    );
    assert_eq!(git(&f.local, &["ls-files", "--stage"]), index);
}
