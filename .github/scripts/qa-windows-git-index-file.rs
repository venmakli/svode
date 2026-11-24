//! Run the Git commands of staging::commit_through against disposable indexes.
//! std::fs::canonicalize gives the same Windows path form as Svode.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Repo {
    dir: PathBuf,
    config: PathBuf,
}

impl Repo {
    fn git(&self, args: &[&str], index: Option<&Path>, stdin: &[u8]) -> Vec<u8> {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(&self.dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &self.config)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_INDEX_FILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        let mut child = command.spawn().unwrap();
        let written = child.stdin.take().unwrap().write_all(stdin);
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "git {args:?} with index {index:?} returned {}\n{}\n{}",
            result.status,
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr),
        );
        written.unwrap();
        result.stdout
    }
}

fn run(base: &Path, config: &Path, mode: &str, unborn: bool) {
    let fixture = base.join(format!(
        "{mode} {}",
        if unborn { "unborn" } else { "with HEAD" }
    ));
    fs::create_dir(&fixture).unwrap();
    let repo = Repo {
        dir: if mode == "canonical" {
            fixture.canonicalize().unwrap()
        } else {
            fixture
        },
        config: config.to_path_buf(),
    };
    let git = |args: &[&str]| repo.git(args, None, &[]);
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "--local", "user.name", "Git index fixture"]);
    git(&["config", "--local", "user.email", "fixture@example.invalid"]);
    git(&["config", "--local", "commit.gpgsign", "false"]);
    if !unborn {
        fs::write(repo.dir.join("Note.md"), b"first note\n").unwrap();
        fs::write(repo.dir.join("unrelated.md"), b"first unrelated\n").unwrap();
        git(&["add", "--", "Note.md", "unrelated.md"]);
        git(&["commit", "-qm", "Initial fixture"]);
        git(&["mv", "--", "Note.md", "intermediate.md"]);
        git(&["mv", "--", "intermediate.md", "note.md"]);
    }
    fs::write(repo.dir.join("note.md"), b"selected content\n").unwrap();
    fs::write(repo.dir.join("unrelated.md"), b"keep this staged\n").unwrap();
    git(&["add", "--", "note.md", "unrelated.md"]);
    let original_index = repo.dir.join(".git/index");
    let original_bytes = fs::read(&original_index).unwrap();
    let selected = git(&["ls-files", "--stage", "-z", "--", "note.md"]);
    assert!(
        !selected.is_empty(),
        "the main index must contain the selected file"
    );

    let hook = repo.dir.join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        b"#!/bin/sh\ngit diff --cached --no-renames --name-only > .git/qa-hook-paths\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let index_name = git(&["rev-parse", "--git-path", "svode-save.index"]);
    let index = repo
        .dir
        .join(std::str::from_utf8(&index_name).unwrap().trim());
    let index_text = index.to_str().unwrap();
    let has_prefix = index_text.as_bytes().starts_with(&[92, 92, 63, 92]);
    assert_eq!(has_prefix, cfg!(windows) && mode == "canonical");
    println!("{mode}, unborn={unborn}, GIT_INDEX_FILE={index_text}");
    assert!(!index.exists());

    let base_tree = if unborn { "--empty" } else { "HEAD" };
    repo.git(&["read-tree", base_tree], Some(&index), &[]);
    assert!(
        index.is_file(),
        "read-tree must create the intended alternate index"
    );
    repo.git(
        &[
            "-c",
            "core.ignorecase=false",
            "update-index",
            "-z",
            "--index-info",
        ],
        Some(&index),
        &selected,
    );
    if !unborn {
        repo.git(
            &[
                "-c",
                "core.ignorecase=false",
                "update-index",
                "--force-remove",
                "-z",
                "--stdin",
            ],
            Some(&index),
            b"Note.md\0",
        );
    }
    repo.git(&["commit", "-qm", "Selected changes"], Some(&index), &[]);
    assert_eq!(fs::read(&original_index).unwrap(), original_bytes);
    assert_eq!(git(&["show", "HEAD:note.md"]), b"selected content\n");
    assert_eq!(
        git(&["diff", "--cached", "--name-only", "-z"]),
        b"unrelated.md\0"
    );
    assert_eq!(git(&["show", ":unrelated.md"]), b"keep this staged\n");
    let names = git(&["ls-tree", "--name-only", "-z", "HEAD"]);
    let head_files = if unborn {
        &b"note.md\0"[..]
    } else {
        &b"note.md\0unrelated.md\0"[..]
    };
    assert_eq!(names, head_files);
    if !unborn {
        assert_eq!(git(&["show", "HEAD:unrelated.md"]), b"first unrelated\n");
    }
    let hook_names = fs::read_to_string(repo.dir.join(".git/qa-hook-paths")).unwrap();
    let expected = if unborn {
        vec!["note.md"]
    } else {
        vec!["Note.md", "note.md"]
    };
    assert_eq!(hook_names.lines().collect::<Vec<_>>(), expected);
    fs::remove_file(&index).unwrap();
    println!("PASS {mode}, unborn={unborn}: commit, hook, main index, and alternate index cleanup");
}

fn main() {
    let base = PathBuf::from(std::env::args_os().nth(1).expect("fixture parent"));
    assert!(base.is_absolute());
    fs::create_dir_all(&base).unwrap();
    let config = base.join("empty.gitconfig");
    fs::write(&config, b"").unwrap();
    let version = Command::new("git").arg("--version").output().unwrap();
    assert!(version.status.success());
    print!("{}", String::from_utf8_lossy(&version.stdout));
    for mode in ["ordinary", "canonical"] {
        for unborn in [false, true] {
            run(&base, &config, mode, unborn);
        }
    }
}
