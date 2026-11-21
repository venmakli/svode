//! The download of LFS content (DF-368): the plan, the order, the partial
//! result after a stall and the causes, with the real git-lfs and a local
//! LFS store next to a bare remote.

use super::*;

fn pointer(path: &str, size: u64, oid: &str, local: bool) -> Pointer {
    Pointer {
        file: LfsFile {
            path: path.into(),
            size,
        },
        oid: oid.into(),
        local,
    }
}

#[test]
fn patterns_match_exactly_the_file_from_the_root() {
    assert_eq!(pattern("media/video.mov"), "/media/video.mov");
    assert_eq!(pattern("-x.bin"), "/-x.bin");
    assert_eq!(pattern("a,b [1]*?.bin"), "/a?b ?1???.bin");
    assert_eq!(pattern("back\\slash.bin"), "/back?slash.bin");
    assert_eq!(pattern("ends with "), "/ends with?");
    assert_eq!(pattern("Фото/кадр 1.jpg"), "/Фото/кадр 1.jpg");
}

#[test]
fn groups_keep_small_files_from_waiting_for_large_ones() {
    let files = [
        pointer("a", 50_000, "1", false),
        pointer("b", 100_000, "2", false),
        pointer("c", 400_000, "3", false),
        pointer("d", 20_000_000, "4", false),
        pointer("e", 60_000_000, "5", false),
        pointer("f", 100_000_000, "6", false),
    ];
    let refs = files.iter().collect::<Vec<_>>();
    let names = groups(&refs)
        .iter()
        .map(|group| {
            group
                .iter()
                .map(|pointer| pointer.file.path.as_str())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert_eq!(names, [vec!["a", "b", "c"], vec!["d", "e"], vec!["f"]]);
}

#[test]
fn groups_and_layout_commands_stay_inside_the_pattern_budget() {
    let long = "d/".repeat(1000);
    let files = (0..10)
        .map(|index| pointer(&format!("{long}{index}.bin"), 10, &index.to_string(), false))
        .collect::<Vec<_>>();
    let refs = files.iter().collect::<Vec<_>>();
    for split in [groups(&refs), chunks(&refs)] {
        assert!(split.len() > 1);
        assert_eq!(split.iter().map(Vec::len).sum::<usize>(), 10);
        for group in split {
            assert!(patterns(&group).join(",").len() <= PATTERNS_BUDGET);
        }
    }
}

#[test]
fn stops_are_told_apart_and_other_text_has_no_credentials() {
    assert_eq!(
        stop_cause("batch response: Authentication required: Authorization error"),
        DownloadStop::NoAccess
    );
    assert_eq!(
        stop_cause("git@host: Permission denied (publickey).\nerror: failed to fetch some objects"),
        DownloadStop::NoAccess
    );
    assert_eq!(
        stop_cause(
            "error transferring \"ab\": [3] S3 download p/ab: PermissionDenied (permanent) at read, context: { response: Parts { status: 403 } }"
        ),
        DownloadStop::NoAccess
    );
    assert_eq!(
        stop_cause("ssh: connect to host 10.0.0.1 port 2222: Connection refused"),
        DownloadStop::Unreachable
    );
    assert_eq!(
        stop_cause(
            "Post \"https://lfs.example/objects/batch\": dial tcp: lookup lfs.example: no such host"
        ),
        DownloadStop::Unreachable
    );
    assert_eq!(
        stop_cause("[404] Object does not exist on the server"),
        DownloadStop::NotOnServer
    );
    assert_eq!(
        stop_cause("error transferring \"ab\": [0] remote missing object ab"),
        DownloadStop::NotOnServer
    );
    assert_eq!(
        stop_cause("error transferring \"ab\": [3] NotFound (persistent) at read"),
        DownloadStop::NotOnServer
    );
    assert_eq!(
        stop_cause(
            "Fetching reference refs/heads/main\nerror: disk full writing to https://user:token@lfs.example/x\n"
        ),
        DownloadStop::Other {
            detail: "error: disk full writing to https://***@lfs.example/x".into()
        }
    );
    let long = "x".repeat(2000);
    let DownloadStop::Other { detail } = stop_cause(&long) else {
        panic!("other");
    };
    assert_eq!(detail.chars().count(), DETAIL_MAX_CHARS + 1);
}

#[test]
fn the_status_follows_the_plan_the_download_and_readiness_checks() {
    let missing = MissingFiles(vec![
        pointer("a.png", 10, "1", false),
        pointer("v.mov", 90, "2", false),
    ]);
    let pulling = LfsStatus::default().planned(&DownloadPlan::Download(missing.clone()));
    assert_eq!(pulling.state, LfsState::Pulling);
    assert_eq!(pulling.missing, None);
    // A readiness check during the download does not end it.
    assert_eq!(pulling.probed(LfsState::Ready), pulling);
    assert_eq!(
        pulling.probed(LfsState::NotApplicable),
        LfsStatus::default()
    );

    let stalled = LfsStatus::downloaded(&DownloadOutcome {
        missing: missing.clone(),
        stop: Some(DownloadStop::Stalled),
    });
    assert_eq!(stalled.state, LfsState::Ready);
    let left = stalled.missing.clone().unwrap();
    assert_eq!((left.files.len(), left.bytes), (2, 100));
    assert_eq!(left.stop, DownloadStop::Stalled);
    // The files stay missing after a later readiness check.
    assert_eq!(stalled.probed(LfsState::Ready), stalled);

    let refused = LfsStatus::downloaded(&DownloadOutcome {
        missing: missing.clone(),
        stop: Some(DownloadStop::NoAccess),
    });
    assert_eq!(refused.state, LfsState::MissingCreds);

    let complete = LfsStatus::downloaded(&DownloadOutcome {
        missing: MissingFiles::default(),
        stop: None,
    });
    assert_eq!(
        complete,
        LfsStatus {
            state: LfsState::Ready,
            missing: None,
            unsent: None,
        }
    );

    let not_ready = LfsStatus::default().planned(&DownloadPlan::NotReady {
        state: LfsState::MissingCreds,
        missing: missing.clone(),
    });
    assert_eq!(not_ready.state, LfsState::MissingCreds);
    assert_eq!(not_ready.missing.unwrap().stop, DownloadStop::NoAccess);

    // Nothing missing keeps what a readiness check said and clears the list.
    let nothing = stalled.planned(&DownloadPlan::NothingMissing);
    assert_eq!(
        nothing,
        LfsStatus {
            state: LfsState::Ready,
            missing: None,
            unsent: None,
        }
    );
    assert_eq!(
        LfsStatus::default().planned(&DownloadPlan::NothingMissing),
        LfsStatus::default()
    );
    assert_eq!(
        stalled.planned(&DownloadPlan::NotApplicable),
        LfsStatus::default()
    );

    let json = serde_json::to_value(&stalled).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "state": "ready",
            "missing": {
                "files": [{ "path": "a.png", "size": 10 }, { "path": "v.mov", "size": 90 }],
                "bytes": 100,
                "stop": { "kind": "stalled" }
            },
            "unsent": null
        })
    );
    assert_eq!(
        serde_json::to_value(DownloadStop::Other { detail: "x".into() }).unwrap(),
        serde_json::json!({ "kind": "other", "detail": "x" })
    );
}

#[test]
fn only_a_new_or_changed_missing_file_asks_for_another_download() {
    let before = MissingFiles(vec![
        pointer("a", 1, "1", false),
        pointer("b", 2, "2", false),
    ]);
    let fewer = MissingFiles(vec![pointer("b", 2, "2", false)]);
    let added = MissingFiles(vec![
        pointer("b", 2, "2", false),
        pointer("c", 3, "3", false),
    ]);
    let changed = MissingFiles(vec![pointer("a", 1, "9", false)]);
    assert!(!fewer.adds_to(&before));
    assert!(!before.adds_to(&before));
    assert!(added.adds_to(&before));
    assert!(changed.adds_to(&before));
}

#[cfg(unix)]
mod process {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::super::*;
    use crate::git::state::GitRuntime;

    fn lfs_available() -> bool {
        std::process::Command::new("git")
            .args(["lfs", "version"])
            .output()
            .is_ok_and(|out| out.status.success())
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        git_with(repo, args, &[])
    }

    fn git_with(repo: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "protocol.file.allow=always"])
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .envs(env.iter().copied())
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    fn bytes(seed: u8, size: usize) -> Vec<u8> {
        (0..size)
            .map(|index| (index as u32).wrapping_mul(2_654_435_761).to_le_bytes()[0] ^ seed)
            .collect()
    }

    const TINY: usize = 1_000;
    const MIDDLE: usize = 1_500_000;
    const LARGE: usize = 7_000_000;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Option<TransferProgress>>>);

    impl TransferObserver for Recorder {
        fn transfer_progress(&self, _repository: &Path, progress: Option<&TransferProgress>) {
            self.0.lock().unwrap().push(progress.cloned());
        }
    }

    struct Fixture {
        temp: tempfile::TempDir,
        remote: PathBuf,
        clone: PathBuf,
        marks: PathBuf,
        recorder: Arc<Recorder>,
        cli: GitCli,
        runtime: GitRuntime,
    }

    impl Fixture {
        fn mark(&self, name: &str) {
            std::fs::write(self.marks.join(name), "").unwrap();
        }

        /// The `--include` of every fetch, in order.
        fn fetches(&self) -> Vec<String> {
            std::fs::read_to_string(self.marks.join("fetches"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn config(&self, strategy: &str) -> AssetsSpaceConfig {
            serde_json::from_value(serde_json::json!({ "strategy": strategy })).unwrap()
        }

        async fn plan(&self) -> DownloadPlan {
            plan_download(&self.runtime, &self.clone, &self.config("lfs-remote"))
                .await
                .unwrap()
        }

        async fn download(&self, idle_limit: Duration) -> DownloadOutcome {
            let DownloadPlan::Download(missing) = self.plan().await else {
                panic!("a download is due");
            };
            download_with(&self.runtime, &self.cli, &self.clone, &missing, idle_limit).await
        }

        fn content(&self, path: &str) -> Vec<u8> {
            std::fs::read(self.clone.join(path)).unwrap()
        }

        fn object(&self, path: &str) -> PathBuf {
            let oid = git(&self.clone, &["show", &format!("HEAD:{path}")])
                .lines()
                .find_map(|line| line.strip_prefix("oid sha256:").map(str::to_owned))
                .unwrap();
            self.remote
                .join("lfs/objects")
                .join(&oid[..2])
                .join(&oid[2..4])
                .join(oid)
        }
    }

    /// A project with three LFS files of different sizes published to a bare
    /// remote with its LFS store, cloned without LFS content as Svode clones,
    /// and a Git that records every fetch, stalls a fetch of `large.bin`
    /// while the `stall` mark exists and holds a fetch while `hold` exists
    /// until `release` does.
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let remote = base.join("remote.git");
        let clone = base.join("clone");
        let marks = base.join("marks");
        std::fs::create_dir_all(&marks).unwrap();
        std::fs::create_dir_all(source.join("media")).unwrap();
        git(
            &base,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(&source, &["config", "user.email", "fixture@example.test"]);
        git(&source, &["lfs", "install", "--local"]);
        git(&source, &["lfs", "track", "*.bin"]);
        std::fs::write(source.join("large.bin"), bytes(3, LARGE)).unwrap();
        std::fs::write(source.join("media/кадр, part [1].bin"), bytes(2, MIDDLE)).unwrap();
        std::fs::write(source.join("tiny.bin"), bytes(1, TINY)).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-q", "-m", "files"]);
        git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&source, &["push", "-q", "-u", "origin", "main"]);
        git_with(
            &base,
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
            &[("GIT_LFS_SKIP_SMUDGE", "1")],
        );
        git(&clone, &["config", "user.name", "Fixture"]);
        git(&clone, &["config", "user.email", "fixture@example.test"]);
        git(&clone, &["lfs", "install", "--local"]);

        let wrapper = base.join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh
[ -n \"$WARM_UP\" ] && exit 0
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
marks='{marks}'
include=
for arg in \"$@\"; do
  case \"$arg\" in --include=*) include=$arg ;; esac
done
case \"$include\" in
--include=*)
  echo \"$include\" >> \"$marks/fetches\"
  echo \"download 1/1 1/2 reported\" >> \"$GIT_LFS_PROGRESS\"
  sleep 0.6
  case \"$include\" in
  *large.bin*) [ -e \"$marks/stall\" ] && exec sleep 30 ;;
  esac
  if [ -e \"$marks/hold\" ]; then
    touch \"$marks/held\"
    while [ ! -e \"$marks/release\" ]; do sleep 0.05; done
  fi ;;
esac
exec git -c protocol.file.allow=always \"$@\"
",
                marks = marks.display()
            ),
        )
        .unwrap();
        std::process::Command::new(&wrapper)
            .env("WARM_UP", "1")
            .status()
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let plain = GitCli::for_test(wrapper);
        Fixture {
            remote,
            clone,
            marks,
            cli: plain.reporting_transfers_to(recorder.clone()),
            runtime: GitRuntime::with_cli(plain),
            recorder,
            temp,
        }
    }

    const PATHS: [&str; 3] = ["tiny.bin", "media/кадр, part [1].bin", "large.bin"];

    #[tokio::test]
    async fn a_fresh_clone_downloads_every_missing_file_smaller_first_as_one_transfer() {
        if !lfs_available() {
            eprintln!("git-lfs is not installed; skipped");
            return;
        }
        let f = fixture();
        let DownloadPlan::Download(missing) = f.plan().await else {
            panic!("a fresh clone misses its LFS content");
        };
        assert_eq!(
            missing.files(),
            vec![
                LfsFile {
                    path: PATHS[0].into(),
                    size: TINY as u64
                },
                LfsFile {
                    path: PATHS[1].into(),
                    size: MIDDLE as u64
                },
                LfsFile {
                    path: PATHS[2].into(),
                    size: LARGE as u64
                },
            ]
        );
        // No LFS strategy, no download.
        assert_eq!(
            plan_download(&f.runtime, &f.clone, &f.config("in-git"))
                .await
                .unwrap(),
            DownloadPlan::NotApplicable
        );

        let outcome = f.download(IDLE_LIMIT).await;
        assert_eq!(
            outcome,
            DownloadOutcome {
                missing: MissingFiles::default(),
                stop: None
            }
        );
        assert_eq!(
            f.fetches(),
            [
                "--include=/tiny.bin",
                "--include=/media/кадр? part ?1?.bin",
                "--include=/large.bin",
            ]
        );
        assert_eq!(f.content(PATHS[0]), bytes(1, TINY));
        assert_eq!(f.content(PATHS[1]), bytes(2, MIDDLE));
        assert_eq!(f.content(PATHS[2]), bytes(3, LARGE));
        assert_eq!(git(&f.clone, &["status", "--porcelain"]), "");
        // Files are numbered across the fetches, and the end comes once.
        let reports = f.recorder.0.lock().unwrap().clone();
        let mut numbers = reports
            .iter()
            .flatten()
            .map(|progress| (progress.file, progress.files, progress.direction))
            .collect::<Vec<_>>();
        numbers.dedup();
        assert_eq!(
            numbers,
            [
                (1, 3, TransferDirection::Download),
                (2, 3, TransferDirection::Download),
                (3, 3, TransferDirection::Download),
            ]
        );
        assert_eq!(reports.last(), Some(&None));
        assert_eq!(reports.iter().filter(|report| report.is_none()).count(), 1);

        // Everything in place: nothing to download, without the network.
        assert_eq!(f.plan().await, DownloadPlan::NothingMissing);
    }

    #[tokio::test]
    async fn a_stalled_download_keeps_what_it_got_in_a_clean_working_copy() {
        if !lfs_available() {
            eprintln!("git-lfs is not installed; skipped");
            return;
        }
        let f = fixture();
        // A file the user changed is neither missing nor overwritten.
        std::fs::write(f.clone.join(PATHS[0]), "edited by the user\n").unwrap();
        f.mark("stall");
        let outcome = f.download(Duration::from_secs(1)).await;
        assert_eq!(outcome.stop, Some(DownloadStop::Stalled));
        assert_eq!(
            outcome.missing.files(),
            vec![LfsFile {
                path: PATHS[2].into(),
                size: LARGE as u64
            }]
        );
        assert_eq!(f.content(PATHS[0]), b"edited by the user\n");
        assert_eq!(f.content(PATHS[1]), bytes(2, MIDDLE));
        assert_eq!(git(&f.clone, &["status", "--porcelain"]), " M tiny.bin\n");
        assert_eq!(
            LfsStatus::downloaded(&outcome).missing.unwrap().stop,
            DownloadStop::Stalled
        );

        // The next download fetches only what is still missing.
        std::fs::remove_file(f.marks.join("stall")).unwrap();
        std::fs::remove_file(f.marks.join("fetches")).unwrap();
        let outcome = f.download(IDLE_LIMIT).await;
        assert_eq!(outcome.stop, None);
        assert_eq!(f.fetches(), ["--include=/large.bin"]);
        assert_eq!(f.content(PATHS[2]), bytes(3, LARGE));
    }

    #[tokio::test]
    async fn the_repository_lock_is_free_while_objects_travel() {
        if !lfs_available() {
            eprintln!("git-lfs is not installed; skipped");
            return;
        }
        let f = fixture();
        f.mark("hold");
        let DownloadPlan::Download(missing) = f.plan().await else {
            panic!("a download is due");
        };
        let runtime = Arc::new(GitRuntime::with_cli(f.runtime.cli().unwrap().clone()));
        let download = tokio::spawn({
            let (runtime, cli, clone) = (runtime.clone(), f.cli.clone(), f.clone.clone());
            async move { download(&runtime, &cli, &clone, &missing).await }
        });
        let held = f.marks.join("held");
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !held.exists() {
            assert!(std::time::Instant::now() < deadline, "the fetch starts");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // A commit under the lock of the same repository completes meanwhile.
        let committed = tokio::time::timeout(Duration::from_secs(20), async {
            let lock = runtime.get_lock(&f.clone).await;
            let _guard = lock.lock().await;
            std::fs::write(f.clone.join("note.md"), "note\n").unwrap();
            git(&f.clone, &["add", "note.md"]);
            git(&f.clone, &["commit", "-q", "-m", "note"]);
        })
        .await;
        assert!(committed.is_ok(), "the commit waited for the download");
        f.mark("release");
        let outcome = download.await.unwrap();
        assert_eq!(outcome.stop, None);
        assert_eq!(git(&f.clone, &["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn objects_already_in_the_store_are_laid_out_without_the_network() {
        if !lfs_available() {
            eprintln!("git-lfs is not installed; skipped");
            return;
        }
        let f = fixture();
        git(&f.clone, &["lfs", "fetch"]);
        // Without a remote the readiness check would refuse.
        git(&f.clone, &["remote", "remove", "origin"]);
        let DownloadPlan::Download(missing) = f.plan().await else {
            panic!("the files are still pointers");
        };
        assert_eq!(missing.files().len(), 3);
        let outcome = download_with(&f.runtime, &f.cli, &f.clone, &missing, IDLE_LIMIT).await;
        assert_eq!(outcome.stop, None);
        assert!(f.fetches().is_empty());
        assert_eq!(f.content(PATHS[2]), bytes(3, LARGE));
        assert_eq!(git(&f.clone, &["status", "--porcelain"]), "");
    }

    #[tokio::test]
    async fn an_object_missing_on_the_server_leaves_only_its_file() {
        if !lfs_available() {
            eprintln!("git-lfs is not installed; skipped");
            return;
        }
        let f = fixture();
        std::fs::remove_file(f.object(PATHS[1])).unwrap();
        let outcome = f.download(IDLE_LIMIT).await;
        assert_eq!(outcome.stop, Some(DownloadStop::NotOnServer));
        assert_eq!(
            outcome.missing.files(),
            vec![LfsFile {
                path: PATHS[1].into(),
                size: MIDDLE as u64
            }]
        );
        assert_eq!(f.content(PATHS[0]), bytes(1, TINY));
        assert_eq!(f.content(PATHS[2]), bytes(3, LARGE));
        let _ = &f.temp;
    }
}
