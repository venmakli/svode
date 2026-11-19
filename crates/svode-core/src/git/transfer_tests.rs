//! The transfer mechanism (DF-369 R1, R5) with a fake `git` that writes the
//! git-lfs report and Git's progress the way the real ones do, and an idle
//! limit shortened for the test.

use super::{TransferDirection, TransferProgress, parse_report_line, without_progress_lines};

#[test]
fn report_lines_keep_paths_with_spaces_and_skip_other_lines() {
    let line = parse_report_line(
        "download 2/6 300000/400000 Фото/photo 1.jpg",
        TransferDirection::Download,
    )
    .unwrap();
    assert_eq!(
        line,
        TransferProgress {
            direction: TransferDirection::Download,
            file: 2,
            files: 6,
            path: "Фото/photo 1.jpg".into(),
            bytes: 300_000,
            size: 400_000,
        }
    );
    assert!(parse_report_line("upload 1/2 nothing a.bin", TransferDirection::Upload).is_none());
    assert!(parse_report_line("something else", TransferDirection::Upload).is_none());
}

#[test]
fn progress_lines_leave_the_output_git_gives_without_progress() {
    let stderr = "Enumerating objects: 3, done.\n\
Counting objects:  50% (1/2)\rCounting objects: 100% (2/2), done.\n\
Delta compression using up to 8 threads\n\
Compressing objects: 100% (2/2), done.\n\
Writing objects: 100% (3/3), 250 bytes | 250.00 KiB/s, done.\n\
Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)\n\
remote: Resolving deltas:   0% (0/1)\rremote: Resolving deltas: 100% (1/1), done.\n\
remote: Permission to owner/repo.git denied.\n\
Uploading LFS objects: 100% (1/1), 10 MB | 1 MB/s, done.\n\
To github.com:owner/repo.git\n ! [remote rejected] main -> main (protected branch hook declined)\n\
error: failed to push some refs";
    assert_eq!(
        without_progress_lines(stderr),
        "remote: Permission to owner/repo.git denied.\n\
Uploading LFS objects: 100% (1/1), 10 MB | 1 MB/s, done.\n\
To github.com:owner/repo.git\n ! [remote rejected] main -> main (protected branch hook declined)\n\
error: failed to push some refs"
    );
    assert_eq!(without_progress_lines(""), "");
}

#[cfg(unix)]
mod process {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::super::{
        Transfer, TransferDirection, TransferObserver, TransferOutcome, TransferProgress,
        TransferStall,
    };
    use crate::git::cli::GitCli;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(PathBuf, Option<TransferProgress>)>>);

    impl TransferObserver for Recorder {
        fn transfer_progress(&self, repository: &Path, progress: Option<&TransferProgress>) {
            self.0
                .lock()
                .unwrap()
                .push((repository.to_path_buf(), progress.cloned()));
        }
    }

    impl Recorder {
        fn reports(&self) -> Vec<Option<TransferProgress>> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(_, progress)| progress.clone())
                .collect()
        }
    }

    /// A fake `git` running `script` in a fresh working directory, with a CLI
    /// that reports to the returned recorder.
    fn fake_git(script: &str) -> (tempfile::TempDir, PathBuf, GitCli, Arc<Recorder>) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("git");
        svode_testkit::write_executable(
            &path,
            format!("#!/bin/sh\n[ -n \"$WARM_UP\" ] && exit 0\n{script}"),
        )
        .unwrap();
        // The first start of a new executable may wait for a system check,
        // which would count against the idle limit.
        std::process::Command::new(&path)
            .env("WARM_UP", "1")
            .status()
            .unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let recorder = Arc::new(Recorder::default());
        let cli = GitCli::for_test(path).reporting_transfers_to(recorder.clone());
        (dir, work, cli, recorder)
    }

    const IDLE: Duration = Duration::from_secs(1);

    async fn run(cli: &GitCli, work: &Path) -> TransferOutcome {
        Transfer::new(work, TransferDirection::Upload)
            .idle_limit(IDLE)
            .run(cli, &["push"], &[])
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_transfer_that_keeps_reporting_outlasts_several_idle_limits() {
        // 4 s of reports every 0.2 s against an idle limit of 1 s.
        let (_dir, work, cli, recorder) = fake_git(
            "i=1
while [ $i -le 20 ]; do
  echo \"upload 1/2 ${i}000/20000 media/a b.mov\" >> \"$GIT_LFS_PROGRESS\"
  sleep 0.2
  i=$((i + 1))
done
echo pushed
",
        );
        let started = std::time::Instant::now();
        let out = match run(&cli, &work).await {
            TransferOutcome::Finished(out) => out,
            TransferOutcome::Stalled(stall) => {
                panic!(
                    "a reporting transfer was stopped: {stall:?} {:?}",
                    recorder.reports()
                )
            }
        };
        assert!(started.elapsed() > IDLE * 3);
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "pushed\n");
        let reports = recorder.reports();
        assert_eq!(reports.last(), Some(&None), "the end is reported");
        let bytes = reports
            .iter()
            .flatten()
            .map(|progress| progress.bytes)
            .collect::<Vec<_>>();
        assert!(bytes.len() >= 5, "{bytes:?}");
        assert!(bytes.windows(2).all(|pair| pair[0] < pair[1]), "{bytes:?}");
        let first = reports[0].as_ref().unwrap();
        assert_eq!(
            (
                first.direction,
                first.file,
                first.files,
                first.path.as_str(),
                first.size
            ),
            (TransferDirection::Upload, 1, 2, "media/a b.mov", 20_000)
        );
        let canonical = recorder.0.lock().unwrap()[0].0.clone();
        assert_eq!(canonical, work);
    }

    #[tokio::test]
    async fn a_transfer_without_progress_stops_with_its_last_file_and_no_descendants() {
        let (_dir, work, cli, recorder) = fake_git(
            "echo 'upload 1/2 1000/99614720 media/video.mov' >> \"$GIT_LFS_PROGRESS\"
sleep 60 &
echo \"$$ $!\" > pids
while :; do echo 'upload 1/2 1000/99614720 media/video.mov' >> \"$GIT_LFS_PROGRESS\"; sleep 0.1; done
",
        );
        let started = std::time::Instant::now();
        let TransferOutcome::Stalled(stall) = run(&cli, &work).await else {
            panic!("a transfer without progress finished");
        };
        let elapsed = started.elapsed();
        assert!(elapsed >= IDLE && elapsed < IDLE * 5, "{elapsed:?}");
        assert_eq!(
            stall,
            TransferStall {
                direction: TransferDirection::Upload,
                path: Some("media/video.mov".into()),
                size: Some(99_614_720),
                idle_limit: IDLE,
            }
        );
        assert_eq!(recorder.reports().last(), Some(&None));
        use crate::process::probes::{ends, exists};
        let pids = std::fs::read_to_string(work.join("pids")).unwrap();
        let (root, descendant) = pids.trim().split_once(' ').unwrap();
        assert!(!exists(root.parse().unwrap()), "git still runs");
        assert!(
            ends(descendant.parse().unwrap()).await,
            "a descendant of git still runs"
        );
    }

    #[tokio::test]
    async fn a_transfer_that_never_reported_stops_without_a_file() {
        let (_dir, work, cli, recorder) = fake_git(
            "printf 'Uploading LFS objects:   0%% (0/1), 0 B | 0 B/s\\r' >&2
while :; do printf 'Uploading LFS objects:   0%% (0/1), 0 B | 0 B/s\\r' >&2; sleep 0.1; done
",
        );
        let TransferOutcome::Stalled(stall) = run(&cli, &work).await else {
            panic!("a meter redrawn without change is no progress");
        };
        assert_eq!((stall.path, stall.size), (None, None));
        assert!(recorder.reports().is_empty());
    }

    #[tokio::test]
    async fn git_progress_alone_keeps_a_transfer_alive_and_leaves_the_output() {
        let (_dir, work, cli, recorder) = fake_git(
            "printf 'Enumerating objects: 5, done.\\n' >&2
i=1
while [ $i -le 18 ]; do
  printf 'Writing objects:  %d%% (%d/12), 1.00 MiB | 10.00 KiB/s\\r' $i $i >&2
  sleep 0.2
  i=$((i + 1))
done
printf 'Writing objects: 100%% (12/12), 2.00 MiB | 10.00 KiB/s, done.\\nTotal 12 (delta 0), reused 0 (delta 0), pack-reused 0\\n' >&2
printf 'To /remote.git\\n ! [rejected]        main -> main (fetch first)\\n' >&2
exit 1
",
        );
        let started = std::time::Instant::now();
        let TransferOutcome::Finished(out) = run(&cli, &work).await else {
            panic!(
                "Git's progress did not keep the transfer alive: {:?}",
                started.elapsed()
            );
        };
        assert_eq!(out.exit_code, 1);
        assert_eq!(
            out.stderr,
            "To /remote.git\n ! [rejected]        main -> main (fetch first)\n"
        );
        assert!(recorder.reports().is_empty(), "Git's progress is not shown");
    }
}
