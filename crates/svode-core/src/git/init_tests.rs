#![cfg(unix)]
//! Repositories Svode creates keep SHA-1 objects and take their first branch
//! from the user's `init.defaultBranch`, else `main`.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::cli::GitCli;
use super::ops::init_with_optional_scaffold_commit;

struct Machine {
    temp: tempfile::TempDir,
    cli: GitCli,
}

impl Machine {
    /// A Git whose global config is `global` and which ignores the system one.
    fn new(global: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("global.gitconfig");
        std::fs::write(&config, global).unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.test\nexec git \"$@\"\n",
                config.display()
            ),
        )
        .unwrap();
        Self {
            cli: GitCli::for_test(wrapper),
            temp,
        }
    }

    fn dir(&self, name: &str) -> PathBuf {
        let dir = self.temp.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = Command::new(self.cli.git_path())
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    async fn init(&self, repo: &Path) {
        init_with_optional_scaffold_commit(&self.cli, repo, false)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn new_repository_is_sha1_on_main_without_a_configured_branch() {
    // Git 3.0 defaults: SHA-256 objects; the explicit format wins.
    let machine = Machine::new("[init]\n\tdefaultObjectFormat = sha256\n");
    let repo = machine.dir("project");

    machine.init(&repo).await;

    assert_eq!(
        machine.git(&repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/main"
    );
    assert_eq!(
        machine.git(&repo, &["rev-parse", "--show-object-format"]),
        "sha1"
    );
}

#[tokio::test]
async fn new_repository_takes_the_users_default_branch() {
    let machine = Machine::new("[init]\n\tdefaultBranch = trunk\n");
    let repo = machine.dir("project");

    machine.init(&repo).await;

    assert_eq!(
        machine.git(&repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/trunk"
    );
}

#[tokio::test]
async fn space_folder_ignores_the_config_of_the_repository_around_it_like_git_init() {
    let machine = Machine::new("");
    let project = machine.dir("project");
    machine.git(&project, &["init", "-q", "-b", "main"]);
    machine.git(&project, &["config", "init.defaultBranch", "project-local"]);
    let space = machine.dir("project/Space");

    machine.init(&space).await;

    assert_eq!(
        machine.git(&space, &["rev-parse", "--show-toplevel"]),
        space.canonicalize().unwrap().display().to_string()
    );
    assert_eq!(
        machine.git(&space, &["symbolic-ref", "HEAD"]),
        "refs/heads/main"
    );
}

#[tokio::test]
async fn reinitializing_keeps_the_format_and_branch_of_an_existing_repository() {
    let machine = Machine::new("");
    let repo = machine.dir("existing");
    machine.git(
        &repo,
        &["init", "-q", "-b", "develop", "--object-format=sha256"],
    );
    std::fs::write(repo.join("note.md"), "note\n").unwrap();
    machine.git(&repo, &["add", "note.md"]);
    machine.git(&repo, &["commit", "-q", "-m", "note"]);

    machine.init(&repo).await;

    assert_eq!(
        machine.git(&repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/develop"
    );
    assert_eq!(
        machine.git(&repo, &["rev-parse", "--show-object-format"]),
        "sha256"
    );
}
