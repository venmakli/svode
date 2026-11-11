#![cfg(unix)]
//! Repositories Svode creates keep SHA-1 objects and take their first branch
//! from the user's `init.defaultBranch`, else `main`; their `.gitignore` gets
//! the system file rules once (DF-273 R2), an existing repository keeps its own.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::cli::GitCli;
use super::ops::{ensure_svode_gitignore, init_with_optional_scaffold_commit};
use super::system_files::{RULES, assert_rules_above_local_block, has_any_rule};

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

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn a_new_repository_ignores_system_files_from_its_scaffold_commit_on() {
    let machine = Machine::new("");
    let repo = machine.dir("project");

    init_with_optional_scaffold_commit(&machine.cli, &repo, true)
        .await
        .unwrap();

    let gitignore = read(&repo.join(".gitignore"));
    assert_rules_above_local_block(&gitignore);
    assert!(
        gitignore.starts_with("# Files that operating systems"),
        "{gitignore}"
    );
    assert!(
        machine
            .git(&repo, &["show", "--name-only", "--format=", "HEAD"])
            .lines()
            .any(|path| path == ".gitignore")
    );
    assert_eq!(
        machine.git(&repo, &["show", "HEAD:.gitignore"]),
        gitignore.trim_end()
    );

    // Files of the systems and office lock files stay out of Git at any
    // depth; lock files of projects and temporary files do not.
    for file in [
        ".DS_Store",
        "docs/.DS_Store",
        "Thumbs.db",
        "docs/desktop.ini",
        "~$report.docx",
        "docs/.~lock.report.docx#",
        "._photo.png",
        "Cargo.lock",
        "bun.lock",
        "draft.tmp",
    ] {
        let path = repo.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }
    let mut status = machine
        .git(&repo, &["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    status.sort();
    assert_eq!(status, ["?? Cargo.lock", "?? bun.lock", "?? draft.tmp"]);
}

#[tokio::test]
async fn a_folder_with_its_own_gitignore_gets_only_the_missing_rules() {
    let machine = Machine::new("");
    let repo = machine.dir("notes");
    std::fs::write(
        repo.join(".gitignore"),
        "target/\r\n!desktop.ini\r\n.DS_Store",
    )
    .unwrap();

    machine.init(&repo).await;

    let gitignore = read(&repo.join(".gitignore"));
    assert!(
        gitignore.starts_with("target/\r\n!desktop.ini\r\n.DS_Store\r\n\r\n# Files"),
        "{gitignore}"
    );
    assert_eq!(gitignore.matches(".DS_Store").count(), 1, "{gitignore}");
    assert!(!gitignore.replace("\r\n", "").contains('\n'), "{gitignore}");
    // The user's negation keeps `desktop.ini` in Git.
    assert!(
        !gitignore.lines().any(|line| line.trim() == "desktop.ini"),
        "{gitignore}"
    );
    std::fs::write(repo.join("desktop.ini"), "x").unwrap();
    assert_eq!(
        machine.git(
            &repo,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "desktop.ini"
            ]
        ),
        "?? desktop.ini"
    );
    for rule in RULES.iter().filter(|rule| **rule != "desktop.ini") {
        assert!(gitignore.lines().any(|line| line.trim() == *rule), "{rule}");
    }
}

#[tokio::test]
async fn the_rules_are_written_once_and_a_deleted_one_stays_deleted() {
    let machine = Machine::new("");
    let repo = machine.dir("project");
    machine.init(&repo).await;
    let gitignore = repo.join(".gitignore");
    let trimmed = read(&gitignore).replace(".DS_Store\n", "");
    std::fs::write(&gitignore, &trimmed).unwrap();

    // Neither the local block repair nor a later `git init` of the existing
    // repository brings the rule back or adds the others again.
    assert!(!ensure_svode_gitignore(&repo).unwrap());
    machine.init(&repo).await;

    assert_eq!(read(&gitignore), trimmed);
    for rule in RULES.iter().filter(|rule| **rule != ".DS_Store") {
        assert_eq!(
            trimmed.lines().filter(|line| line == rule).count(),
            1,
            "{rule}"
        );
    }
}

#[tokio::test]
async fn an_existing_repository_keeps_its_gitignore_without_the_rules() {
    let machine = Machine::new("");
    let repo = machine.dir("existing");
    machine.git(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".gitignore"), "build/\n").unwrap();

    machine.init(&repo).await;

    let gitignore = read(&repo.join(".gitignore"));
    assert!(
        gitignore.starts_with("build/\n# svode:local:start\n"),
        "{gitignore}"
    );
    assert!(!has_any_rule(&gitignore), "{gitignore}");
}
