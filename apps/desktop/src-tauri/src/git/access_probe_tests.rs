use super::*;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    repo: PathBuf,
    remote: PathBuf,
    cli: GitCli,
    real: GitCli,
}

impl Fixture {
    async fn new(fault: &str) -> Self {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        let remote = temp.path().join("remote.git");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&remote).unwrap();
        let real = GitCli::detect().unwrap();
        ok(&real, &repo, &["init", "-b", "main"]).await;
        ok(&real, &remote, &["init", "--bare"]).await;
        ok(&real, &repo, &["config", "user.name", "Fixture"]).await;
        ok(
            &real,
            &repo,
            &["config", "user.email", "fixture@example.test"],
        )
        .await;
        fs::write(repo.join("note"), "committed\n").unwrap();
        ok(&real, &repo, &["add", "note"]).await;
        ok(&real, &repo, &["commit", "-m", "seed"]).await;
        ok(
            &real,
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .await;
        ok(&real, &repo, &["push", "origin", "main"]).await;
        fs::write(repo.join("note"), "staged\n").unwrap();
        ok(&real, &repo, &["add", "note"]).await;
        fs::write(repo.join("note"), "unstaged\n").unwrap();
        let wrapper = temp.path().join("git-fault");
        let real_path = real.git_path().to_string_lossy().replace('\'', "'\\''");
        fs::write(
            &wrapper,
            format!(
                r#"#!/bin/sh
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
shift 4
printf '%s\n' "$1" >> .git/probe-calls
{fault}
exec '{real_path}' "$@"
"#
            ),
        )
        .unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _temp: temp,
            repo,
            remote,
            cli: GitCli::for_test(wrapper),
            real,
        }
    }

    async fn probe(&self) -> Result<ProbeResult, AppError> {
        probe_remote(
            &self.cli,
            &self.repo,
            &RemoteConfig {
                push_url: self.remote.to_string_lossy().into_owned(),
                fingerprint: "fixture".into(),
            },
            "fixture",
            1_700_000_000,
        )
        .await
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.repo.join(".git/probe-calls"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    async fn user_state(&self) -> (String, String, Vec<u8>, Vec<u8>) {
        (
            ok(&self.real, &self.repo, &["show-ref"]).await,
            ok(
                &self.real,
                &self.remote,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                    "refs/tags",
                ],
            )
            .await,
            fs::read(self.repo.join(".git/index")).unwrap(),
            fs::read(self.repo.join("note")).unwrap(),
        )
    }
}

async fn ok(cli: &GitCli, repo: &Path, args: &[&str]) -> String {
    let output = cli.exec(repo, args).await.unwrap();
    assert_eq!(output.exit_code, 0, "{args:?}: {}", output.stderr);
    output.stdout
}

fn unknown(reason: RepositoryAccessReason) -> ProbeResult {
    ProbeResult {
        status: RepositoryAccessStatus::Unknown,
        reason: Some(reason),
    }
}

#[tokio::test]
async fn prewrite_failures_never_claim_remote_write_denial() {
    for (message, reason) in [
        (
            "Permission denied",
            RepositoryAccessReason::AmbiguousRejection,
        ),
        (
            "remote: Write access to repository not granted.",
            RepositoryAccessReason::AmbiguousRejection,
        ),
        (
            "Permission denied (publickey)",
            RepositoryAccessReason::AuthRequired,
        ),
        (
            "connection timed out",
            RepositoryAccessReason::OfflineOrTimeout,
        ),
    ] {
        let fixture = Fixture::new(&format!(
            "if [ \"$1\" = ls-remote ]; then echo '{message}' >&2; exit 1; fi"
        ))
        .await;
        let before = fixture.user_state().await;
        assert_eq!(fixture.probe().await.unwrap(), unknown(reason), "{message}");
        assert_eq!(fixture.calls(), ["ls-remote"]);
        assert_eq!(fixture.user_state().await, before);
    }
    for stage in ["hash-object", "commit-tree"] {
        let fixture = Fixture::new(&format!(
            "if [ \"$1\" = {stage} ]; then echo 'Permission denied' >&2; exit 1; fi"
        ))
        .await;
        let state = RepositoryAccessState::default();
        let store = fixture._temp.path().join("access.json");
        let before = fixture.user_state().await;
        assert!(
            state
                .verify(&fixture.cli, &fixture.repo, &store)
                .await
                .is_err()
        );
        let snapshot = state
            .snapshot(&fixture.cli, &fixture.repo, &store)
            .await
            .unwrap();
        assert_eq!(snapshot.status, RepositoryAccessStatus::Unknown);
        assert!(!fixture.calls().iter().any(|call| call == "push"));
        assert_eq!(fixture.user_state().await, before);
    }
}

#[tokio::test]
async fn push_failure_matrix_requires_explicit_remote_permission_evidence() {
    use RepositoryAccessReason::*;
    let read_only = ProbeResult {
        status: RepositoryAccessStatus::ReadOnly,
        reason: None,
    };
    for (message, expected) in [
        ("Permission denied", unknown(AmbiguousRejection)),
        ("remote rejected", unknown(AmbiguousRejection)),
        ("not allowed to push", unknown(AmbiguousRejection)),
        (
            "Write access to repository not granted",
            unknown(AmbiguousRejection),
        ),
        ("remote: Write access to repository not granted.", read_only),
        (
            "remote: You are not allowed to push code to this project.",
            read_only,
        ),
        (
            "remote: Write access to repository not granted.\npre-receive hook declined",
            unknown(AmbiguousRejection),
        ),
        (
            "remote: Write access to repository not granted.\nprohibited by config",
            unknown(UnsupportedRef),
        ),
        ("Authentication failed", unknown(AuthRequired)),
        ("connection timed out", unknown(OfflineOrTimeout)),
        ("deny updating a hidden ref", unknown(UnsupportedRef)),
        ("stale info", unknown(LeaseConflict)),
    ] {
        let fixture = Fixture::new(&format!(
            "if [ \"$1\" = push ]; then echo '{message}' >&2; exit 1; fi"
        ))
        .await;
        let before = fixture.user_state().await;
        let state = RepositoryAccessState::default();
        let store = fixture._temp.path().join("access.json");
        let snapshot = state
            .verify(&fixture.cli, &fixture.repo, &store)
            .await
            .unwrap();
        assert_eq!(snapshot.status, expected.status, "{message}");
        assert_eq!(snapshot.reason, expected.reason, "{message}");
        assert!(fixture.calls().iter().any(|call| call == "push"));
        assert!(
            state
                .require_mutation(&fixture.cli, &fixture.repo, &store)
                .await
                .is_err()
        );
        assert_eq!(fixture.user_state().await, before);
        let evidence = fs::read_to_string(store).unwrap();
        assert!(!evidence.contains(message));
        assert!(!evidence.contains(fixture.remote.to_str().unwrap()));
    }
}

#[tokio::test]
async fn actual_hook_rejection_is_not_repository_permission_evidence() {
    let fixture = Fixture::new("").await;
    let hook = fixture.remote.join("hooks/pre-receive");
    fs::write(
        &hook,
        "#!/bin/sh\necho 'Write access to repository not granted.' >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let before = fixture.user_state().await;
    assert_eq!(
        fixture.probe().await.unwrap(),
        unknown(RepositoryAccessReason::AmbiguousRejection)
    );
    assert_eq!(fixture.user_state().await, before);
}

#[tokio::test]
async fn uncertain_push_requires_exact_readback_and_preserves_exact_lease() {
    for outcome in ["exact", "other", "missing", "denied"] {
        let fixture = Fixture::new(&format!(
            r#"
if [ "$1" = push ]; then
  printf '%s\n' "$@" > .git/push-args
  if [ '{outcome}' = exact ]; then git "$@" || exit; fi
  touch .git/pushed
  echo 'remote end hung up unexpectedly' >&2
  exit 1
fi
if [ "$1" = ls-remote ] && [ -f .git/pushed ]; then
  case '{outcome}' in
    other) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/svode/access/fixture\n'; exit 0;;
    missing) exit 0;;
    denied) echo 'remote: Write access to repository not granted.' >&2; exit 1;;
  esac
fi
"#
        ))
        .await;
        let before = fixture.user_state().await;
        let result = fixture.probe().await.unwrap();
        assert_eq!(
            result,
            if outcome == "exact" {
                ProbeResult {
                    status: RepositoryAccessStatus::Writable,
                    reason: None,
                }
            } else {
                unknown(RepositoryAccessReason::OfflineOrTimeout)
            }
        );
        let args = fs::read_to_string(fixture.repo.join(".git/push-args")).unwrap();
        assert!(args.contains("--force-with-lease=refs/svode/access/fixture:\n"));
        assert_eq!(
            fixture
                .calls()
                .iter()
                .filter(|call| *call == "ls-remote")
                .count(),
            2
        );
        assert_eq!(fixture.user_state().await, before);
        if outcome == "exact" {
            let old = ok(
                &fixture.real,
                &fixture.remote,
                &["rev-parse", "refs/svode/access/fixture"],
            )
            .await;
            assert_eq!(
                fixture.probe().await.unwrap().status,
                RepositoryAccessStatus::Writable
            );
            let args = fs::read_to_string(fixture.repo.join(".git/push-args")).unwrap();
            assert!(args.contains(&format!(
                "--force-with-lease=refs/svode/access/fixture:{}\n",
                old.trim()
            )));
        }
    }
}

#[tokio::test]
async fn routine_service_ref_failure_and_uncertain_success_keep_claim_semantics() {
    for (fault, expected) in [
        (
            "if [ \"$1\" = ls-remote ]; then echo 'Permission denied' >&2; exit 1; fi",
            false,
        ),
        (
            "if [ \"$1\" = push ]; then echo 'stale info' >&2; exit 1; fi",
            false,
        ),
        (
            "if [ \"$1\" = push ]; then git \"$@\" || exit; echo 'connection reset' >&2; exit 1; fi",
            true,
        ),
    ] {
        let fixture = Fixture::new(fault).await;
        let before = fixture.user_state().await;
        let result = claim_remote_routine(
            &fixture.cli,
            &fixture.repo,
            &RemoteConfig {
                push_url: fixture.remote.to_string_lossy().into_owned(),
                fingerprint: "fixture".into(),
            },
            "routine",
            &RoutineClaimPayload {
                run_key: "slot".into(),
                definition_hash: "definition".into(),
                claimed_by: "fixture".into(),
                claimed_at: 1_700_000_000,
            },
        )
        .await
        .unwrap();
        if expected {
            assert!(matches!(result, RoutineClaimResult::Claimed { .. }));
        } else {
            assert_eq!(
                result,
                RoutineClaimResult::Unavailable {
                    reason: if fault.contains("stale info") {
                        RepositoryAccessReason::LeaseConflict
                    } else {
                        RepositoryAccessReason::AmbiguousRejection
                    }
                }
            );
        }
        assert_eq!(fixture.user_state().await, before);
    }
}

#[tokio::test]
async fn evidence_deadline_starts_after_delayed_probe_and_exact_readback() {
    struct FileClock(PathBuf);
    impl Clock for FileClock {
        fn now_unix(&self) -> i64 {
            fs::read_to_string(&self.0).unwrap().trim().parse().unwrap()
        }
    }
    for outcome in ["success", "denied", "readback"] {
        let fixture = Fixture::new(&format!(r#"
if [ "$1" = push ]; then
  echo 2000000 > .git/clock
  if [ '{outcome}' = denied ]; then echo 'remote: Write access to repository not granted.' >&2; exit 1; fi
  if [ '{outcome}' = readback ]; then
    git "$@" || exit
    touch .git/pushed
    echo 'connection reset' >&2
    exit 1
  fi
fi
if [ "$1" = ls-remote ] && [ -f .git/pushed ]; then echo 3000000 > .git/clock; fi
"#)).await;
        let clock_path = fixture.repo.join(".git/clock");
        fs::write(&clock_path, "1000000").unwrap();
        let state = RepositoryAccessState::with_clock(Arc::new(FileClock(clock_path)));
        let store = fixture._temp.path().join("access.json");
        let result = state
            .verify(&fixture.cli, &fixture.repo, &store)
            .await
            .unwrap();
        let finished = if outcome == "readback" {
            3_000_000
        } else {
            2_000_000
        };
        assert_eq!(result.checked_at, Some(finished));
        assert_eq!(result.expires_at, Some(finished + 604_800));
        assert_eq!(
            result.status,
            if outcome == "denied" {
                RepositoryAccessStatus::ReadOnly
            } else {
                RepositoryAccessStatus::Writable
            }
        );
        let calls = fixture.calls();
        state
            .snapshot(&fixture.cli, &fixture.repo, &store)
            .await
            .unwrap();
        let _ = state
            .require_mutation(&fixture.cli, &fixture.repo, &store)
            .await;
        let later = fixture.calls();
        assert_eq!(
            later
                .iter()
                .filter(|c| c.as_str() == "push" || c.as_str() == "ls-remote")
                .count(),
            calls
                .iter()
                .filter(|c| c.as_str() == "push" || c.as_str() == "ls-remote")
                .count()
        );
    }
}

#[tokio::test]
async fn late_probe_cannot_replace_new_push_evidence_or_changed_origin() {
    for changed_origin in [false, true] {
        let fixture = Fixture::new(
            r#"
if [ "$1" = push ]; then
  touch .git/probe-wait
  while [ ! -f .git/probe-release ]; do sleep 0.01; done
  echo 'remote: Write access to repository not granted.' >&2
  exit 1
fi
"#,
        )
        .await;
        let store = fixture._temp.path().join("access.json");
        let state = Arc::new(RepositoryAccessState::new());
        state
            .record_writable_evidence(&fixture.real, &fixture.repo, &store)
            .await
            .unwrap();
        let pending = {
            let state = state.clone();
            let cli = fixture.cli.clone();
            let repo = fixture.repo.clone();
            let store = store.clone();
            tokio::spawn(async move { state.verify(&cli, &repo, &store).await })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture.repo.join(".git/probe-wait").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let newer = if changed_origin {
            ok(
                &fixture.real,
                &fixture.repo,
                &["remote", "set-url", "origin", "changed"],
            )
            .await;
            state
                .invalidate(&fixture.real, &fixture.repo)
                .await
                .unwrap();
            state
                .snapshot(&fixture.real, &fixture.repo, &store)
                .await
                .unwrap()
        } else {
            state
                .record_writable_evidence(&fixture.real, &fixture.repo, &store)
                .await
                .unwrap()
        };
        let bytes = fs::read(&store).unwrap();
        fs::write(fixture.repo.join(".git/probe-release"), "").unwrap();
        let completed = pending.await.unwrap().unwrap();
        assert_eq!(completed, newer);
        assert_eq!(fs::read(&store).unwrap(), bytes);
        assert_eq!(
            state
                .require_mutation(&fixture.real, &fixture.repo, &store)
                .await
                .is_ok(),
            !changed_origin
        );
    }
}
