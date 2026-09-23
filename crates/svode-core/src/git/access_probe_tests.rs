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

    async fn probe(&self) -> Result<ProbeResult, GitError> {
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
    for (changed_origin, automatic) in [(false, false), (true, false), (false, true), (true, true)]
    {
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
        if !automatic {
            state
                .record_writable_evidence(&fixture.real, &fixture.repo, &store)
                .await
                .unwrap();
        }
        let pending = {
            let state = state.clone();
            let cli = fixture.cli.clone();
            let repo = fixture.repo.clone();
            let store = store.clone();
            tokio::spawn(async move {
                state
                    .verify_requested(&cli, &repo, &store, automatic, |_| {})
                    .await
            })
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

struct AutoClock(std::sync::atomic::AtomicI64);
impl AutoClock {
    fn new(now: i64) -> Self {
        Self(std::sync::atomic::AtomicI64::new(now))
    }
    fn set(&self, now: i64) {
        self.0.store(now, Ordering::SeqCst);
    }
}
impl Clock for AutoClock {
    fn now_unix(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

async fn activate(
    f: &Fixture,
    state: &RepositoryAccessState,
    store: &Path,
) -> RepositoryAccessSnapshot {
    state
        .verify_requested(&f.cli, &f.repo, store, true, |_| {})
        .await
        .unwrap()
}

fn network_calls(f: &Fixture) -> usize {
    f.calls()
        .iter()
        .filter(|c| c.as_str() == "push" || c.as_str() == "ls-remote")
        .count()
}

#[tokio::test]
async fn automatic_first_open_expiry_restart_and_positive_renewal() {
    let f = Fixture::new("").await;
    let clock = Arc::new(AutoClock::new(1_000_000));
    let state = RepositoryAccessState::with_clock(clock.clone());
    let store = f._temp.path().join("access.json");
    let first = activate(&f, &state, &store).await;
    assert_eq!(first.status, RepositoryAccessStatus::Writable);
    assert_eq!(network_calls(&f), 2);
    let state = RepositoryAccessState::with_clock(clock.clone());
    activate(&f, &state, &store).await;
    clock.set(first.expires_at.unwrap() - 1);
    activate(&f, &state, &store).await;
    assert_eq!(network_calls(&f), 2);
    clock.set(first.expires_at.unwrap());
    let second = activate(&f, &state, &store).await;
    assert_eq!(second.status, RepositoryAccessStatus::Writable);
    assert_eq!(network_calls(&f), 4);
    state
        .record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    activate(&f, &state, &store).await;
    assert_eq!(network_calls(&f), 4);
    clock.set(second.expires_at.unwrap());
    let restarted = RepositoryAccessState::with_clock(clock);
    activate(&f, &restarted, &store).await;
    assert_eq!(network_calls(&f), 6);
}

#[tokio::test]
async fn automatic_failures_stay_manual_across_restart_and_time() {
    for fault in [
        "if [ \"$1\" = ls-remote ]; then echo 'connection timed out' >&2; exit 1; fi",
        "if [ \"$1\" = ls-remote ]; then echo 'Permission denied (publickey)' >&2; exit 1; fi",
        "if [ \"$1\" = push ]; then echo 'remote: Write access to repository not granted.' >&2; exit 1; fi",
        "if [ \"$1\" = hash-object ]; then exit 1; fi",
    ] {
        let f = Fixture::new(fault).await;
        let clock = Arc::new(AutoClock::new(1_000_000));
        let store = f._temp.path().join("access.json");
        let state = RepositoryAccessState::with_clock(clock.clone());
        let _ = state
            .verify_requested(&f.cli, &f.repo, &store, true, |_| {})
            .await;
        let count = network_calls(&f);
        assert!(
            read_store_file(&store)
                .unwrap()
                .automatic_attempts
                .values()
                .all(|a| a.consumed)
        );
        clock.set(9_000_000);
        for _ in 0..2 {
            let state = RepositoryAccessState::with_clock(clock.clone());
            let result = activate(&f, &state, &store).await;
            assert_ne!(result.status, RepositoryAccessStatus::Writable);
            assert!(
                state
                    .require_mutation(&f.cli, &f.repo, &store)
                    .await
                    .is_err()
            );
        }
        assert_eq!(network_calls(&f), count);
        // Restored transport alone is not a retry; explicit manual success renews the cycle.
        let state = RepositoryAccessState::with_clock(clock.clone());
        state.verify(&f.real, &f.repo, &store).await.unwrap();
        assert!(
            read_store_file(&store)
                .unwrap()
                .automatic_attempts
                .values()
                .all(|a| !a.consumed)
        );
        clock.set(10_000_000);
        let result = state
            .verify_requested(&f.real, &f.repo, &store, true, |_| {})
            .await
            .unwrap();
        assert_eq!(result.status, RepositoryAccessStatus::Writable);
        assert_eq!(result.checked_at, Some(10_000_000));
    }
}

#[tokio::test]
async fn automatic_legacy_evidence_and_remote_changes_are_conservative() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let clock = Arc::new(AutoClock::new(1_000_000));
    let state = RepositoryAccessState::with_clock(clock.clone());
    state.verify(&f.real, &f.repo, &store).await.unwrap();
    let baseline = read_store_file(&store).unwrap();
    for status in [
        RepositoryAccessStatus::Writable,
        RepositoryAccessStatus::ReadOnly,
        RepositoryAccessStatus::Unknown,
    ] {
        for expired in [false, true] {
            let mut legacy = baseline.clone();
            legacy.automatic_attempts.clear();
            let value = legacy.evidence.values_mut().next().unwrap();
            value.status = status;
            value.reason = (status == RepositoryAccessStatus::Unknown)
                .then_some(RepositoryAccessReason::AuthRequired);
            value.expires_at = Some(if expired { 999_999 } else { 1_086_400 });
            write_store_file(&store, &legacy).unwrap();
            let state = RepositoryAccessState::with_clock(clock.clone());
            // Local snapshot and write gate never probe, even when eligible.
            state.snapshot(&f.cli, &f.repo, &store).await.unwrap();
            let before = network_calls(&f);
            let _ = state.require_mutation(&f.cli, &f.repo, &store).await;
            assert_eq!(network_calls(&f), before);
            activate(&f, &state, &store).await;
            assert_eq!(
                network_calls(&f) - before,
                if expired && status == RepositoryAccessStatus::Writable {
                    2
                } else {
                    0
                }
            );
        }
    }
    write_store_file(&store, &baseline).unwrap();
    ok(
        &f.real,
        &f.repo,
        &["remote", "set-url", "origin", "changed"],
    )
    .await;
    let before = network_calls(&f);
    let state = RepositoryAccessState::with_clock(clock);
    assert_eq!(
        activate(&f, &state, &store).await.reason,
        Some(RepositoryAccessReason::RemoteChanged)
    );
    assert_eq!(network_calls(&f), before);
}

#[tokio::test]
async fn automatic_reservation_crash_and_persistence_failure_never_retry() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let cli = f.cli.clone();
    let repo = f.repo.clone();
    let crash_store = store.clone();
    // Abort immediately after durable reservation, before the first network call.
    let pending = tokio::spawn(async move {
        RepositoryAccessState::new()
            .verify_requested(&cli, &repo, &crash_store, true, |_| {
                panic!("simulated crash after reservation")
            })
            .await
    });
    assert!(pending.await.unwrap_err().is_panic());
    let before = network_calls(&f);
    assert_eq!(before, 0);
    let restarted = RepositoryAccessState::new();
    assert_eq!(
        activate(&f, &restarted, &store).await.reason,
        Some(RepositoryAccessReason::AmbiguousRejection)
    );
    assert_eq!(network_calls(&f), before);
    restarted.verify(&f.real, &f.repo, &store).await.unwrap();
    assert!(
        !read_store_file(&store)
            .unwrap()
            .automatic_attempts
            .values()
            .next()
            .unwrap()
            .consumed
    );

    let unavailable = f._temp.path().join("not-directory");
    fs::write(&unavailable, "file").unwrap();
    let state = RepositoryAccessState::new();
    assert!(
        state
            .verify_requested(
                &f.cli,
                &f.repo,
                &unavailable.join("access.json"),
                true,
                |_| {}
            )
            .await
            .is_err()
    );
    assert_eq!(network_calls(&f), before);
}

#[tokio::test]
async fn automatic_and_manual_consumers_join_one_checking_probe() {
    let f = Fixture::new("if [ \"$1\" = push ]; then sleep 0.1; fi").await;
    let store = f._temp.path().join("access.json");
    let state = RepositoryAccessState::new();
    let inline = f.repo.join("inline");
    fs::create_dir(&inline).unwrap();
    let (auto, another_window, manual) = tokio::join!(
        state.verify_requested(&f.cli, &f.repo, &store, true, |_| {}),
        state.verify_requested(&f.cli, &inline, &store, true, |_| {}),
        state.verify(&f.cli, &f.repo, &store),
    );
    assert_eq!(auto.unwrap(), another_window.unwrap());
    assert_eq!(manual.unwrap().status, RepositoryAccessStatus::Writable);
    assert_eq!(network_calls(&f), 2);
}

#[tokio::test]
async fn manual_retry_is_not_swallowed_by_an_automatic_noop() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let state = Arc::new(RepositoryAccessState::new());
    let repository = resolve_repository(&f.real, &f.repo).await.unwrap();
    state.snapshot(&f.real, &f.repo, &store).await.unwrap();
    let noop = state.acquire_probe(&repository, true).await.unwrap();
    let pending = {
        let state = state.clone();
        let cli = f.cli.clone();
        let repo = f.repo.clone();
        tokio::spawn(async move { state.verify(&cli, &repo, &store).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(noop);
    assert_eq!(
        pending.await.unwrap().unwrap().status,
        RepositoryAccessStatus::Writable
    );
    assert_eq!(network_calls(&f), 2);
}

#[tokio::test]
async fn local_unsupported_and_unreadable_store_activation_never_probe() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let state = RepositoryAccessState::new();
    for raw in ["broken JSON", r#"{"version":99}"#] {
        fs::write(&store, raw).unwrap();
        assert!(
            state
                .verify_requested(&f.cli, &f.repo, &store, true, |_| {})
                .await
                .is_err()
        );
        assert_eq!(network_calls(&f), 0);
    }
    ok(
        &f.real,
        &f.repo,
        &["config", "--add", "remote.origin.pushurl", "one"],
    )
    .await;
    ok(
        &f.real,
        &f.repo,
        &["config", "--add", "remote.origin.pushurl", "two"],
    )
    .await;
    assert_eq!(
        activate(&f, &state, &store).await.reason,
        Some(RepositoryAccessReason::UnsupportedRemoteConfiguration)
    );
    ok(&f.real, &f.repo, &["remote", "remove", "origin"]).await;
    assert_eq!(
        activate(&f, &state, &store).await.status,
        RepositoryAccessStatus::Local
    );
    assert_eq!(network_calls(&f), 0);
}

#[tokio::test]
async fn failed_manual_probe_cannot_revive_previous_fresh_writable_after_restart() {
    let f = Fixture::new("if [ \"$1\" = hash-object ]; then exit 1; fi").await;
    let store = f._temp.path().join("access.json");
    let state = RepositoryAccessState::new();
    state.verify(&f.real, &f.repo, &store).await.unwrap();
    assert!(state.verify(&f.cli, &f.repo, &store).await.is_err());
    let before = network_calls(&f);
    let restarted = RepositoryAccessState::new();
    let result = activate(&f, &restarted, &store).await;
    assert_eq!(result.status, RepositoryAccessStatus::Unknown);
    assert_eq!(
        result.reason,
        Some(RepositoryAccessReason::AmbiguousRejection)
    );
    assert_eq!(
        result.last_known_status,
        Some(RepositoryAccessStatus::Writable)
    );
    assert!(
        restarted
            .require_mutation(&f.cli, &f.repo, &store)
            .await
            .is_err()
    );
    assert_eq!(network_calls(&f), before);
}

#[tokio::test]
async fn independent_owners_follow_foreign_store_evidence_without_restart_or_network() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let clock = Arc::new(AutoClock::new(1_000_000));
    let desktop = RepositoryAccessState::with_clock(clock.clone());
    let cli = RepositoryAccessState::with_clock(clock.clone());
    let denial = |error: GitError| match error {
        GitError::RepositoryAccessDenied { status, reason, .. } => (status, reason),
        other => panic!("unexpected error: {other}"),
    };

    let initial = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(initial.reason, Some(RepositoryAccessReason::NotChecked));
    assert!(
        desktop
            .require_mutation(&f.cli, &f.repo, &store)
            .await
            .is_err()
    );

    clock.set(1_000_100);
    let verified = cli.verify(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(verified.status, RepositoryAccessStatus::Writable);
    let calls = network_calls(&f);
    let seen = desktop
        .require_mutation(&f.cli, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(seen.checked_at, verified.checked_at);
    assert!(seen.generation > initial.generation);
    // An unchanged result keeps its publication; foreign success makes activation a no-op.
    assert_eq!(
        desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap(),
        seen
    );
    assert_eq!(activate(&f, &desktop, &store).await, seen);
    assert_eq!(network_calls(&f), calls);

    let mut generation = seen.generation;
    for (at, status, reason) in [
        (1_000_200, RepositoryAccessStatus::ReadOnly, None),
        (
            1_000_300,
            RepositoryAccessStatus::Unknown,
            Some(RepositoryAccessReason::AuthRequired),
        ),
    ] {
        let mut persisted = read_store_file(&store).unwrap();
        let evidence = persisted.evidence.get_mut(&seen.repository_id).unwrap();
        evidence.status = status;
        evidence.reason = reason;
        evidence.checked_at = at;
        evidence.expires_at = (status == RepositoryAccessStatus::ReadOnly)
            .then_some(at + ACCESS_EVIDENCE_TTL_SECONDS);
        let attempt = persisted
            .automatic_attempts
            .get_mut(&seen.repository_id)
            .unwrap();
        attempt.checked_at = Some(at);
        attempt.consumed = true;
        write_store_file(&store, &persisted).unwrap();
        clock.set(at + 1);

        let (denied_status, denied_reason) = denial(
            desktop
                .require_mutation(&f.cli, &f.repo, &store)
                .await
                .unwrap_err(),
        );
        assert_eq!(denied_status, status_name(status));
        assert_eq!(denied_reason, reason.map(reason_name).unwrap_or("none"));
        let failed = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
        assert_eq!((failed.status, failed.checked_at), (status, Some(at)));
        assert!(failed.generation > generation);
        generation = failed.generation;
        // A foreign failure leaves manual recovery: activation does not probe.
        assert_eq!(activate(&f, &desktop, &store).await, failed);
        assert_eq!(network_calls(&f), calls);
    }

    clock.set(1_000_400);
    let renewed = cli
        .record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    let writable = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(
        (writable.status, writable.checked_at),
        (RepositoryAccessStatus::Writable, renewed.checked_at)
    );
    assert!(writable.generation > generation);
    clock.set(renewed.expires_at.unwrap());
    assert_eq!(
        denial(
            desktop
                .require_mutation(&f.cli, &f.repo, &store)
                .await
                .unwrap_err()
        ),
        ("unknown".to_string(), "expired".to_string())
    );

    let other = f._temp.path().join("other.git");
    fs::create_dir(&other).unwrap();
    ok(&f.real, &other, &["init", "--bare"]).await;
    ok(
        &f.real,
        &f.repo,
        &["remote", "set-url", "origin", other.to_str().unwrap()],
    )
    .await;
    let changed = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(changed.reason, Some(RepositoryAccessReason::RemoteChanged));
    let moved = cli
        .record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    let followed = desktop
        .require_mutation(&f.cli, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(followed.checked_at, moved.checked_at);
    assert!(followed.generation > changed.generation);

    ok(&f.real, &f.repo, &["remote", "remove", "origin"]).await;
    for owner in [&desktop, &cli] {
        assert_eq!(
            owner
                .require_mutation(&f.cli, &f.repo, &store)
                .await
                .unwrap()
                .status,
            RepositoryAccessStatus::Local
        );
    }
    assert_eq!(network_calls(&f), calls);
}

#[derive(Default)]
struct RecordingObserver(Mutex<Vec<String>>);

impl RecordingObserver {
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl RepositoryAccessObserver for RecordingObserver {
    fn publication_changed(&self, repository_id: &str) {
        self.0.lock().unwrap().push(repository_id.to_string());
    }
}

#[tokio::test]
async fn host_is_notified_once_when_a_read_publishes_foreign_store_changes() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let clock = Arc::new(AutoClock::new(1_000_000));
    let observer = Arc::new(RecordingObserver::default());
    let desktop = RepositoryAccessState::build(clock.clone(), Some(observer.clone()));
    let cli = RepositoryAccessState::with_clock(clock.clone());

    // The first publication and repeated unchanged reads are not changes.
    let initial = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(initial.reason, Some(RepositoryAccessReason::NotChecked));
    assert_eq!(
        desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap(),
        initial
    );
    assert!(
        desktop
            .require_mutation(&f.cli, &f.repo, &store)
            .await
            .is_err()
    );
    assert_eq!(observer.count(), 0);

    // A gate that picks up foreign verification reports it exactly once.
    clock.set(1_000_100);
    cli.verify(&f.cli, &f.repo, &store).await.unwrap();
    let seen = desktop
        .require_mutation(&f.cli, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(seen.status, RepositoryAccessStatus::Writable);
    assert_eq!(
        *observer.0.lock().unwrap(),
        vec![seen.repository_id.clone()]
    );
    assert_eq!(
        desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap(),
        seen
    );
    desktop
        .require_mutation(&f.cli, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(activate(&f, &desktop, &store).await, seen);
    assert_eq!(observer.count(), 1);

    // A foreign failure seen by a read is a change as well.
    let mut persisted = read_store_file(&store).unwrap();
    let evidence = persisted.evidence.get_mut(&seen.repository_id).unwrap();
    evidence.status = RepositoryAccessStatus::ReadOnly;
    evidence.checked_at = 1_000_200;
    evidence.expires_at = Some(1_000_200 + ACCESS_EVIDENCE_TTL_SECONDS);
    write_store_file(&store, &persisted).unwrap();
    clock.set(1_000_201);
    let denied = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(denied.status, RepositoryAccessStatus::ReadOnly);
    assert_eq!(observer.count(), 2);
    assert!(
        desktop
            .require_mutation(&f.cli, &f.repo, &store)
            .await
            .is_err()
    );
    assert_eq!(observer.count(), 2);

    // Own verification is delivered by its host, not reported as a read change.
    clock.set(1_000_300);
    let own = desktop.verify(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(own.status, RepositoryAccessStatus::Writable);
    assert_eq!(
        desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap(),
        own
    );
    assert_eq!(observer.count(), 2);

    // An activation that only reads foreign evidence is delivered by its host too.
    clock.set(1_000_400);
    let renewed = cli
        .record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    let activated = activate(&f, &desktop, &store).await;
    assert_eq!(activated.checked_at, renewed.checked_at);
    assert_eq!(
        desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap(),
        activated
    );
    assert_eq!(observer.count(), 2);

    // Another process's evidence for another fingerprint replaces `remote_changed`.
    let other = f._temp.path().join("other.git");
    fs::create_dir(&other).unwrap();
    ok(&f.real, &other, &["init", "--bare"]).await;
    ok(
        &f.real,
        &f.repo,
        &["remote", "set-url", "origin", other.to_str().unwrap()],
    )
    .await;
    let changed = desktop.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(changed.reason, Some(RepositoryAccessReason::RemoteChanged));
    assert_eq!(observer.count(), 3);
    cli.record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    desktop
        .require_mutation(&f.cli, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(observer.count(), 4);
    assert!(
        observer
            .0
            .lock()
            .unwrap()
            .iter()
            .all(|id| id == &seen.repository_id)
    );
}

#[tokio::test]
async fn own_checking_and_newer_own_result_are_not_replaced_by_store() {
    let f = Fixture::new(
        r#"
if [ "$1" = push ]; then
  touch .git/probe-wait
  while [ ! -f .git/probe-release ]; do sleep 0.01; done
fi
"#,
    )
    .await;
    let store = f._temp.path().join("access.json");
    let clock = Arc::new(AutoClock::new(1_000_000));
    let desktop = Arc::new(RepositoryAccessState::with_clock(clock.clone()));
    let cli = RepositoryAccessState::with_clock(clock.clone());
    let pending = {
        let desktop = desktop.clone();
        let (probe_cli, repo, store) = (f.cli.clone(), f.repo.clone(), store.clone());
        tokio::spawn(async move {
            desktop
                .verify_requested(&probe_cli, &repo, &store, false, |_| {})
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.repo.join(".git/probe-wait").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    clock.set(1_000_100);
    cli.record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    let checking = desktop.snapshot(&f.real, &f.repo, &store).await.unwrap();
    assert_eq!(checking.status, RepositoryAccessStatus::Checking);
    assert!(
        desktop
            .require_mutation(&f.real, &f.repo, &store)
            .await
            .is_err()
    );
    assert_eq!(
        desktop.snapshot(&f.real, &f.repo, &store).await.unwrap(),
        checking
    );

    clock.set(1_000_200);
    fs::write(f.repo.join(".git/probe-release"), "").unwrap();
    let own = pending.await.unwrap().unwrap();
    assert_eq!(
        (own.status, own.checked_at),
        (RepositoryAccessStatus::Writable, Some(1_000_200))
    );
    assert_eq!(
        desktop.snapshot(&f.real, &f.repo, &store).await.unwrap(),
        own
    );

    // An older store result, such as a foreign write racing this process or its
    // own failed persistence, does not roll back the newer own result.
    let mut persisted = read_store_file(&store).unwrap();
    let evidence = persisted.evidence.get_mut(&own.repository_id).unwrap();
    evidence.status = RepositoryAccessStatus::ReadOnly;
    evidence.checked_at = 1_000_150;
    evidence.expires_at = Some(1_000_150 + ACCESS_EVIDENCE_TTL_SECONDS);
    write_store_file(&store, &persisted).unwrap();
    assert_eq!(
        desktop.snapshot(&f.real, &f.repo, &store).await.unwrap(),
        own
    );
    assert!(
        desktop
            .require_mutation(&f.real, &f.repo, &store)
            .await
            .is_ok()
    );
    // The other owner's own result (1_000_100) is older than the store.
    assert_eq!(
        cli.snapshot(&f.real, &f.repo, &store).await.unwrap().status,
        RepositoryAccessStatus::ReadOnly
    );

    // An unreadable store keeps the own result and fails closed without one.
    fs::write(&store, "broken JSON").unwrap();
    assert_eq!(
        desktop.snapshot(&f.real, &f.repo, &store).await.unwrap(),
        own
    );
    assert!(
        RepositoryAccessState::with_clock(clock)
            .require_mutation(&f.real, &f.repo, &store)
            .await
            .is_err()
    );
    assert_eq!(network_calls(&f), 2);
}

const CHILD_ROLE: &str = "SVODE_ACCESS_CHILD_ROLE";
const CHILD_STORE: &str = "SVODE_ACCESS_STORE_PATH";
const CHILD_WRITES: i64 = 10;

fn child_var(name: &str) -> String {
    std::env::var(format!("SVODE_ACCESS_CHILD_{name}")).unwrap()
}

fn spawn_child(role: &str, store: &Path, vars: &[(&str, &str)]) -> std::process::Child {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "git::access::probe_tests::store_child_process",
            "--nocapture",
        ])
        .env(CHILD_ROLE, role)
        .env(CHILD_STORE, store)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (name, value) in vars {
        command.env(format!("SVODE_ACCESS_CHILD_{name}"), value);
    }
    command.spawn().unwrap()
}

fn child_output(child: std::process::Child) -> String {
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(
        output.status.success() && stdout.contains("1 passed;"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
}

fn child_line<'a>(stdout: &'a str, key: &str) -> &'a str {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{key}=")))
        .unwrap()
}

async fn wait_for_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

/// One role of a child process of the multi-process store tests; a regular
/// test run has no role and passes immediately.
#[tokio::test]
async fn store_child_process() {
    let Ok(role) = std::env::var(CHILD_ROLE) else {
        return;
    };
    let store = PathBuf::from(std::env::var(CHILD_STORE).unwrap());
    if let Ok(start) = std::env::var("SVODE_ACCESS_CHILD_START") {
        wait_for_file(Path::new(&start)).await;
    }
    let state = RepositoryAccessState::new();
    match role.as_str() {
        "writer" => {
            let prefix = child_var("PREFIX");
            for index in 0..CHILD_WRITES {
                let repository_id = format!("{prefix}-{index}");
                state
                    .persist_and_publish(
                        Path::new(&format!("/{repository_id}")),
                        "fixture",
                        RepositoryAccessSnapshot {
                            repository_id,
                            generation: 0,
                            status: RepositoryAccessStatus::Writable,
                            reason: None,
                            checked_at: Some(1_000_000 + index),
                            expires_at: Some(1_000_000 + index + ACCESS_EVIDENCE_TTL_SECONDS),
                            last_known_status: None,
                        },
                        &store,
                        None,
                    )
                    .unwrap();
            }
        }
        "installation" => {
            println!(
                "installation={}",
                state.ensure_installation_id(&store).unwrap()
            );
        }
        "hold" => {
            let _lock = state.lock_store(&store).unwrap();
            fs::write(child_var("MARKER"), "").unwrap();
            std::thread::sleep(Duration::from_secs(60));
        }
        "verify" => {
            let cli = GitCli::for_test(PathBuf::from(child_var("GIT")));
            let repo = PathBuf::from(child_var("REPO"));
            let result = state.verify(&cli, &repo, &store).await.unwrap();
            println!("result={}", serde_json::to_string(&result).unwrap());
            // The other process may still be finishing its own verification.
            let mut seen = state.snapshot(&cli, &repo, &store).await.unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            while seen.status != RepositoryAccessStatus::Writable {
                assert!(
                    Instant::now() < deadline,
                    "{seen:?}\n{}",
                    fs::read_to_string(&store).unwrap()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
                seen = state.snapshot(&cli, &repo, &store).await.unwrap();
            }
            println!("seen={}", serde_json::to_string(&seen).unwrap());
            println!(
                "gate={}",
                state.require_mutation(&cli, &repo, &store).await.is_ok()
            );
        }
        other => panic!("unknown child role {other}"),
    }
}

#[tokio::test]
async fn parallel_processes_keep_every_store_change_and_one_installation_id() {
    for round in 0..3 {
        let temp = TempDir::new().unwrap();
        let store = temp.path().join("access.json");
        let start = temp.path().join("start");
        let start_path = start.to_str().unwrap();
        let prefixes: Vec<String> = (0..4).map(|index| format!("r{round}-p{index}")).collect();
        let writers: Vec<_> = prefixes
            .iter()
            .map(|prefix| {
                spawn_child(
                    "writer",
                    &store,
                    &[("PREFIX", prefix.as_str()), ("START", start_path)],
                )
            })
            .collect();
        let installations: Vec<_> = (0..4)
            .map(|_| spawn_child("installation", &store, &[("START", start_path)]))
            .collect();
        fs::write(&start, "").unwrap();
        for writer in writers {
            child_output(writer);
        }
        let ids: Vec<String> = installations
            .into_iter()
            .map(|child| child_line(&child_output(child), "installation").to_owned())
            .collect();

        let persisted = read_store_file(&store).unwrap();
        assert_eq!(
            persisted.evidence.len(),
            prefixes.len() * CHILD_WRITES as usize
        );
        for prefix in &prefixes {
            for index in 0..CHILD_WRITES {
                let id = format!("{prefix}-{index}");
                assert_eq!(persisted.evidence[&id].checked_at, 1_000_000 + index);
                assert!(!persisted.automatic_attempts[&id].consumed);
            }
        }
        assert!(!persisted.installation_id.is_empty());
        assert!(ids.iter().all(|id| *id == persisted.installation_id));
    }
}

#[tokio::test]
async fn store_lock_holder_exit_and_unavailable_lock() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let marker = f._temp.path().join("held");
    let mut holder = spawn_child("hold", &store, &[("MARKER", marker.to_str().unwrap())]);
    wait_for_file(&marker).await;

    // An unavailable lock writes no reservation and starts no probe.
    for automatic in [true, false] {
        let state = RepositoryAccessState::new();
        assert!(
            state
                .verify_requested(&f.cli, &f.repo, &store, automatic, |_| {})
                .await
                .is_err()
        );
        assert!(!store.exists());
        assert_eq!(network_calls(&f), 0);
    }
    // Evidence that cannot be stored stays in this process only.
    let state = RepositoryAccessState::new();
    let renewed = state
        .record_writable_evidence(&f.real, &f.repo, &store)
        .await
        .unwrap();
    assert_eq!(renewed.status, RepositoryAccessStatus::Writable);
    assert!(!store.exists());
    assert!(
        state
            .require_mutation(&f.real, &f.repo, &store)
            .await
            .is_ok()
    );

    // The operating system releases the lock of a holder that exits.
    holder.kill().unwrap();
    holder.wait().unwrap();
    let next = RepositoryAccessState::new();
    let verified = next.verify(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!(verified.status, RepositoryAccessStatus::Writable);
    assert_eq!(
        read_store_file(&store).unwrap().evidence[&verified.repository_id].checked_at,
        verified.checked_at.unwrap()
    );
    assert_eq!(network_calls(&f), 2);
}

#[tokio::test]
async fn concurrent_process_verification_keeps_conclusive_evidence() {
    // Both processes read the missing service ref before either pushes; the
    // second pushes after the first has moved it and loses the lease. With
    // `last`, the winner persists only after the loser stored its conflict.
    let fault = r#"
wait_until() {
  tries=0
  until eval "$1"; do
    tries=$((tries + 1)); [ "$tries" -gt 2000 ] && exit 97
    sleep 0.01
  done
}
if [ "$1" = push ]; then
  touch ".git/push-ready-$PPID"
  wait_until '[ "$(ls .git | grep -c "^push-ready-")" -ge 2 ]'
  if [ "$SVODE_ACCESS_CHILD_PUSH" = second ]; then
    wait_until '[ -n "$(ls ../remote.git/refs/svode/access 2>/dev/null | grep -v "\.lock$")" ]'
  elif [ "$SVODE_ACCESS_CHILD_PERSIST" = last ]; then
    touch ".git/persist-after-$PPID"
  fi
fi
if [ "$1" = config ] && [ -f ".git/persist-after-$PPID" ]; then
  rm ".git/persist-after-$PPID"
  wait_until 'grep -q lease_conflict "$SVODE_ACCESS_STORE_PATH" 2>/dev/null'
fi
"#;
    for winner_persists in ["first", "last"] {
        let f = Fixture::new(fault).await;
        let store = f._temp.path().join("access.json");
        let git = f._temp.path().join("git-fault");
        let (git, repo) = (git.to_str().unwrap(), f.repo.to_str().unwrap());
        let winner = spawn_child(
            "verify",
            &store,
            &[
                ("GIT", git),
                ("REPO", repo),
                ("PUSH", "first"),
                ("PERSIST", winner_persists),
            ],
        );
        let loser = spawn_child(
            "verify",
            &store,
            &[("GIT", git), ("REPO", repo), ("PUSH", "second")],
        );
        let (winner, loser) = (child_output(winner), child_output(loser));
        let parse = |stdout: &str, key: &str| {
            serde_json::from_str::<RepositoryAccessSnapshot>(child_line(stdout, key)).unwrap()
        };

        let won = parse(&winner, "result");
        assert_eq!(won.status, RepositoryAccessStatus::Writable);
        let lost = parse(&loser, "result");
        if winner_persists == "last" {
            assert_eq!(lost.reason, Some(RepositoryAccessReason::LeaseConflict));
        } else {
            assert_eq!(lost.checked_at, won.checked_at);
        }
        for stdout in [&winner, &loser] {
            assert_eq!(parse(stdout, "seen").checked_at, won.checked_at);
            assert_eq!(child_line(stdout, "gate"), "true");
        }
        let persisted = read_store_file(&store).unwrap();
        let evidence = &persisted.evidence[&won.repository_id];
        assert_eq!(
            (evidence.status, Some(evidence.checked_at)),
            (RepositoryAccessStatus::Writable, won.checked_at)
        );
        assert!(!persisted.automatic_attempts[&won.repository_id].consumed);
        // One read and one push per process, no automatic retry.
        assert_eq!(network_calls(&f), 4);
        assert!(
            RepositoryAccessState::new()
                .require_mutation(&f.real, &f.repo, &store)
                .await
                .is_ok()
        );
    }
}

#[tokio::test]
async fn concurrent_results_keep_conclusive_evidence_ordered_by_checked_at() {
    let f = Fixture::new("").await;
    let store = f._temp.path().join("access.json");
    let clock = Arc::new(AutoClock::new(1_000_400));
    let repository = resolve_repository(&f.real, &f.repo).await.unwrap();
    let RemoteInspection::Remote(remote) = inspect_remote(&f.real, &repository).await.unwrap()
    else {
        panic!("fixture has an origin");
    };
    let repository_id = opaque_id("access-repo", &repository.to_string_lossy());
    let stored = || read_store_file(&store).unwrap().evidence[&repository_id].clone();
    let consumed = || read_store_file(&store).unwrap().automatic_attempts[&repository_id].consumed;
    // `base` is the stored evidence an own verification started from; `None`
    // records a positive push outcome.
    let result = |state: &RepositoryAccessState,
                  status: RepositoryAccessStatus,
                  reason: Option<RepositoryAccessReason>,
                  at: i64,
                  base: Option<Option<PersistedEvidence>>| {
        let snapshot = RepositoryAccessSnapshot {
            repository_id: repository_id.clone(),
            generation: 0,
            status,
            reason,
            checked_at: Some(at),
            expires_at: conclusive(status).then_some(at + ACCESS_EVIDENCE_TTL_SECONDS),
            last_known_status: None,
        };
        let verification = base.map(|base| Verification {
            generation: state
                .publish(
                    &repository,
                    Some(remote.fingerprint.clone()),
                    RepositoryAccessSnapshot {
                        status: RepositoryAccessStatus::Checking,
                        reason: None,
                        checked_at: None,
                        expires_at: None,
                        ..snapshot.clone()
                    },
                )
                .unwrap()
                .generation,
            base,
        });
        state
            .persist_and_publish(
                &repository,
                &remote.fingerprint,
                snapshot,
                &store,
                verification.as_ref(),
            )
            .unwrap()
    };
    let lease = Some(RepositoryAccessReason::LeaseConflict);
    let writable = RepositoryAccessStatus::Writable;
    let unknown = RepositoryAccessStatus::Unknown;

    // The loser of a concurrent verification stores its conflict last.
    let (desktop, cli) = (
        RepositoryAccessState::with_clock(clock.clone()),
        RepositoryAccessState::with_clock(clock.clone()),
    );
    assert_eq!(
        result(&desktop, writable, None, 1_000_100, Some(None)).checked_at,
        Some(1_000_100)
    );
    let kept = result(&cli, unknown, lease, 1_000_110, Some(None));
    assert_eq!((kept.status, kept.checked_at), (writable, Some(1_000_100)));
    assert_eq!(stored().checked_at, 1_000_100);
    assert!(!consumed());
    for owner in [&desktop, &cli] {
        assert!(
            owner
                .require_mutation(&f.cli, &f.repo, &store)
                .await
                .is_ok()
        );
    }

    // The loser stores its newer conflict first; the winner still replaces it,
    // and the loser's own newer conflict yields to the saved success.
    fs::remove_file(&store).unwrap();
    let (desktop, cli) = (
        RepositoryAccessState::with_clock(clock.clone()),
        RepositoryAccessState::with_clock(clock.clone()),
    );
    assert_eq!(
        result(&cli, unknown, lease, 1_000_210, Some(None)).reason,
        lease
    );
    result(&desktop, writable, None, 1_000_200, Some(None));
    assert_eq!(
        (stored().status, stored().checked_at),
        (writable, 1_000_200)
    );
    assert!(!consumed());
    let seen = cli.snapshot(&f.cli, &f.repo, &store).await.unwrap();
    assert_eq!((seen.status, seen.checked_at), (writable, Some(1_000_200)));
    assert!(cli.require_mutation(&f.cli, &f.repo, &store).await.is_ok());
    // Foreign success leaves no automatic attempt to spend.
    assert_eq!(activate(&f, &cli, &store).await, seen);

    // A verification started after the success was saved may replace it.
    let offline = result(
        &cli,
        unknown,
        Some(RepositoryAccessReason::OfflineOrTimeout),
        1_000_220,
        Some(Some(stored())),
    );
    assert_eq!(offline.checked_at, Some(1_000_220));
    assert!(consumed());
    for owner in [&desktop, &cli] {
        assert_eq!(
            owner
                .snapshot(&f.cli, &f.repo, &store)
                .await
                .unwrap()
                .reason,
            Some(RepositoryAccessReason::OfflineOrTimeout)
        );
    }

    // Conclusive results are ordered by `checked_at`, whatever the arrival.
    let read_only = RepositoryAccessStatus::ReadOnly;
    result(&desktop, read_only, None, 1_000_300, Some(Some(stored())));
    let older = result(&cli, writable, None, 1_000_250, None);
    assert_eq!(
        (older.status, older.checked_at),
        (read_only, Some(1_000_300))
    );
    assert_eq!(stored().status, read_only);
    assert!(consumed());
    assert!(cli.require_mutation(&f.cli, &f.repo, &store).await.is_err());
    result(&cli, writable, None, 1_000_350, None);
    assert_eq!(
        (stored().status, stored().checked_at),
        (writable, 1_000_350)
    );
    assert!(
        desktop
            .require_mutation(&f.cli, &f.repo, &store)
            .await
            .is_ok()
    );
    assert_eq!(network_calls(&f), 0);
}
