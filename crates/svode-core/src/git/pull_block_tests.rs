#![cfg(unix)]
use super::*;
use std::path::PathBuf;
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
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

fn identify(repo: &Path) {
    git(repo, &["config", "user.name", "Fixture"]);
    git(repo, &["config", "user.email", "fixture@example.test"]);
}

/// A clone of a remote whose next commit, pushed from another clone, changes
/// `.gitignore` and adds `.gitattributes`.
struct Fixture {
    _temp: tempfile::TempDir,
    local: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        std::fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-b", "main"]);
        identify(&seed);
        std::fs::write(seed.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(seed.join("note.md"), "initial\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "initial"]);
        let remote = temp.path().join("remote.git");
        let other = temp.path().join("other");
        let local = temp.path().join("local");
        let url = remote.to_str().unwrap();
        git(
            temp.path(),
            &["clone", "--bare", seed.to_str().unwrap(), url],
        );
        git(temp.path(), &["clone", url, other.to_str().unwrap()]);
        git(temp.path(), &["clone", url, local.to_str().unwrap()]);
        identify(&other);
        identify(&local);
        std::fs::write(other.join(".gitignore"), "target/\n.svode/local.json\n").unwrap();
        std::fs::write(other.join(".gitattributes"), "*.png filter=lfs\n").unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-m", "service files"]);
        git(&other, &["push"]);
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(&wrapper, "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n").unwrap();
        Self {
            _temp: temp,
            local,
            cli: GitCli::for_test(wrapper),
        }
    }

    fn write(&self, path: &str, content: &str) {
        std::fs::write(self.local.join(path), content).unwrap();
    }

    /// HEAD, index entries and every working tree file outside `.git`. A
    /// refused merge may still refresh the stat cache of the index.
    fn snapshot(&self) -> (String, String, Vec<(String, Vec<u8>)>) {
        let mut files: Vec<_> = std::fs::read_dir(&self.local)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_name() != ".git")
            .map(|entry| {
                (
                    entry.file_name().into_string().unwrap(),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect();
        files.sort();
        (
            git(&self.local, &["rev-parse", "HEAD"]),
            git(&self.local, &["ls-files", "--stage"]),
            files,
        )
    }

    async fn refusal(&self) -> (String, Vec<String>) {
        match sync(&self.cli, &self.local).await {
            Err(GitError::PullBlocked { repository, files }) => (repository, files),
            other => panic!("expected a pull refusal, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn both_pull_call_sites_name_tracked_and_untracked_files_and_change_nothing() {
    for first_publication in [false, true] {
        let f = Fixture::new();
        if first_publication {
            git(&f.local, &["branch", "--unset-upstream"]);
        }
        f.write(".gitignore", "target/\nnode_modules/\n");
        f.write(".gitattributes", "*.pdf filter=lfs\n");
        // Local work the incoming commit does not touch stays out of the list.
        f.write("note.md", "edited\n");
        f.write("draft.md", "untracked\n");
        let before = f.snapshot();

        let (repository, files) = f.refusal().await;

        assert_eq!(repository, f.local.to_string_lossy(), "{first_publication}");
        assert_eq!(
            files,
            [".gitattributes", ".gitignore"],
            "{first_publication}"
        );
        assert_eq!(f.snapshot(), before, "{first_publication}");
        let json = serde_json::to_value(GitError::PullBlocked { repository, files }).unwrap();
        assert_eq!(json["kind"], "git_pull_blocked");
        assert_eq!(
            json["files"],
            serde_json::json!([".gitattributes", ".gitignore"])
        );
    }
}

#[tokio::test]
async fn a_merge_that_is_not_a_fast_forward_also_names_every_staged_file() {
    let f = Fixture::new();
    f.write("local.md", "local commit\n");
    git(&f.local, &["add", "local.md"]);
    git(&f.local, &["commit", "-m", "local"]);
    f.write("staged.md", "staged\n");
    git(&f.local, &["add", "staged.md"]);
    f.write(".gitignore", "target/\nnode_modules/\n");
    let before = f.snapshot();

    let (_, files) = f.refusal().await;

    assert_eq!(files, [".gitignore", "staged.md"]);
    assert_eq!(f.snapshot(), before);
}

#[test]
fn only_overwrite_refusals_are_classified() {
    assert!(blocked_by_local_files(
        "error: Your local changes to the following files would be overwritten by merge:\n\t.gitignore"
    ));
    assert!(blocked_by_local_files(
        "error: The following untracked working tree files would be overwritten by merge:\n\t.gitattributes"
    ));
    assert!(blocked_by_local_files(
        "error: The following untracked working tree files would be removed by merge:\n\tdocs/a.md"
    ));
    assert!(blocked_by_local_files(
        "error: Updating the following directories would lose untracked files in them:\n\tdocs"
    ));
    for other in [
        "CONFLICT (content): Merge conflict in note.md\nAutomatic merge failed",
        "fatal: Authentication failed for 'https://example.test/repo.git/'",
        "fatal: refusing to merge unrelated histories",
    ] {
        assert!(!blocked_by_local_files(other), "{other}");
    }
    assert!(paths_overlap("docs", "docs/a.md"));
    assert!(paths_overlap("docs/a.md", "docs"));
    assert!(!paths_overlap("docs", "docs-old/a.md"));
}
