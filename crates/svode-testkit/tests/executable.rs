#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use svode_testkit::write_executable;

const SPAWNERS: usize = 4;
const ROUNDS: usize = 150;

fn git(repo: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args([
            "-c",
            "user.name=Testkit",
            "-c",
            "user.email=testkit@example.test",
        ])
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap()
}

/// Other test threads spawn processes the whole time: each of them would
/// inherit a write descriptor the test process held while writing the file.
#[test]
fn rewritten_executables_run_directly_and_as_git_hooks_while_other_threads_spawn() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let init = git(&repo, &["init", "-q"]);
    assert!(init.status.success(), "{init:?}");
    let script = temp.path().join("script");
    let hook = repo.join(".git/hooks/pre-commit");
    let marker = temp.path().join("hook-round");

    let stop = Arc::new(AtomicBool::new(false));
    let spawners: Vec<_> = (0..SPAWNERS)
        .map(|_| {
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let mut spawned = 0usize;
                while !stop.load(Ordering::Relaxed) {
                    Command::new("true").stdin(Stdio::null()).status().unwrap();
                    spawned += 1;
                }
                spawned
            })
        })
        .collect();

    for round in 0..ROUNDS {
        write_executable(&script, format!("#!/bin/sh\necho round-{round}\n")).unwrap();
        let direct = Command::new(&script).output().unwrap();
        assert!(direct.status.success(), "round {round}: {direct:?}");
        assert_eq!(
            String::from_utf8_lossy(&direct.stdout),
            format!("round-{round}\n")
        );

        write_executable(
            &hook,
            format!("#!/bin/sh\necho {round} > '{}'\n", marker.display()),
        )
        .unwrap();
        let commit = git(
            &repo,
            &["commit", "-q", "--allow-empty", "-m", &round.to_string()],
        );
        assert!(commit.status.success(), "round {round}: {commit:?}");
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            format!("{round}\n")
        );
    }

    stop.store(true, Ordering::Relaxed);
    for spawner in spawners {
        assert!(spawner.join().unwrap() > 0);
    }
}

#[test]
fn an_existing_file_is_overwritten_and_made_executable() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tool");
    std::fs::write(&path, "a much longer previous content than the next one\n").unwrap();
    write_executable(&path, "#!/bin/sh\necho next\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "#!/bin/sh\necho next\n"
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let output = Command::new(&path).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout), "next\n");
}

#[test]
fn a_missing_directory_is_an_error() {
    let temp = tempfile::tempdir().unwrap();
    let error = write_executable(temp.path().join("missing/tool"), "#!/bin/sh\n").unwrap_err();
    assert!(error.to_string().contains("missing/tool"), "{error}");
}
