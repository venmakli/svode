use super::*;
use crate::git::access::create_service_commit;

const SERVICE_NAME: &str = "Svode Access Probe";
const SERVICE_EMAIL: &str = "access@svode.invalid";
const TIME: i64 = 1_700_000_000;

async fn git(cli: &GitCli, repo: &Path, args: &[&str]) -> String {
    let output = cli.exec(repo, args).await.unwrap();
    assert_eq!(output.exit_code, 0, "{args:?}: {}", output.stderr);
    output.stdout.trim().to_string()
}

async fn fixture() -> (tempfile::TempDir, GitCli) {
    let repo = tempfile::tempdir().unwrap();
    let cli = GitCli::detect().unwrap();
    git(&cli, repo.path(), &["init", "-b", "main"]).await;
    git(&cli, repo.path(), &["config", "user.name", "Human"]).await;
    git(
        &cli,
        repo.path(),
        &["config", "user.email", "human@example.test"],
    )
    .await;
    let output = cli
        .exec_with_env(
            repo.path(),
            &["commit", "--allow-empty", "-m", "human"],
            &[
                ("GIT_AUTHOR_DATE", "1700000000 +0000"),
                ("GIT_COMMITTER_DATE", "1700000000 +0000"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    (repo, cli)
}

async fn probe(cli: &GitCli, repo: &Path, installation: &str, time: i64) -> String {
    create_service_commit(cli, repo, installation, time)
        .await
        .unwrap()
}

async fn activity(
    state: &ActorCatalogState,
    cli: &GitCli,
    repo: &Path,
    email: &str,
) -> ActorActivity {
    state
        .activity(cli, repo, email, Some(2023), None, None)
        .await
        .unwrap()
}

#[tokio::test]
async fn producer_probes_are_excluded_for_every_reachable_ref_and_head() {
    let (repo, cli) = fixture().await;
    let main = git(&cli, repo.path(), &["rev-parse", "HEAD"]).await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME).await;
    for reference in [
        "refs/svode/access/0123456789abcdef",
        "refs/remotes/origin/remapped-probe",
        "refs/tags/probe",
        "refs/heads/probe",
    ] {
        git(&cli, repo.path(), &["update-ref", reference, &oid]).await;
        // The unfiltered reader reproduces the reported defect using the real producer.
        assert!(
            git(&cli, repo.path(), &["log", "--all", "--format=%ae"])
                .await
                .contains(SERVICE_EMAIL)
        );
        for packed in [false, true] {
            if packed {
                git(&cli, repo.path(), &["pack-refs", "--all", "--prune"]).await;
            }
            let state = ActorCatalogState::new();
            let snapshot = state.snapshot(&cli, repo.path()).await.unwrap();
            assert_eq!(snapshot.candidates().len(), 1);
            assert_eq!(snapshot.candidates()[0].commit_count, 1);
            assert_eq!(
                activity(&state, &cli, repo.path(), "human@example.test")
                    .await
                    .commit_count,
                1
            );
            assert!(
                !load_actor_history(&cli, repo.path())
                    .await
                    .unwrap()
                    .contains(&oid)
            );
        }
        git(&cli, repo.path(), &["update-ref", "-d", reference]).await;
    }
    git(&cli, repo.path(), &["checkout", "--detach", &oid]).await;
    let state = ActorCatalogState::new();
    assert_eq!(
        state
            .snapshot(&cli, repo.path())
            .await
            .unwrap()
            .candidates()
            .len(),
        1
    );
    assert!(
        !load_actor_history(&cli, repo.path())
            .await
            .unwrap()
            .contains(&oid)
    );
    git(&cli, repo.path(), &["checkout", "main"]).await;
    assert_eq!(git(&cli, repo.path(), &["rev-parse", "HEAD"]).await, main);
}

async fn raw_commit(cli: &GitCli, repo: &Path, contents: &str) -> String {
    let output = cli
        .exec_sensitive_with_stdin(
            repo,
            &["hash-object", "-w", "-t", "commit", "--stdin"],
            &[],
            Some(contents),
            std::time::Duration::from_secs(10),
        )
        .await
        .unwrap();
    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    output.stdout.trim().to_string()
}

#[tokio::test]
async fn lookalikes_remain_in_catalog_and_paginated_activity() {
    let (repo, cli) = fixture().await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME).await;
    let raw = git(&cli, repo.path(), &["cat-file", "commit", &oid]).await + "\n";
    let main = git(&cli, repo.path(), &["rev-parse", "HEAD"]).await;
    fs::write(repo.path().join("file"), "contents").unwrap();
    git(&cli, repo.path(), &["add", "file"]).await;
    let nonempty_tree = git(&cli, repo.path(), &["write-tree"]).await;
    let empty_tree = raw.lines().next().unwrap().strip_prefix("tree ").unwrap();
    let variants = [
        raw.replace("version=1", "version=2"),
        raw.replace("version=1", "ordinary user message"),
        raw.lines()
            .filter(|line| !line.starts_with("nonce="))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
        raw.replace(
            "installation=0123456789abcdef",
            "installation=0123456789abcdeF",
        ),
        raw.replace("nonce=", "nonce=Z"),
        raw.replace("checked-at=1700000000", "checked-at=tomorrow"),
        raw.replace("author ", &format!("parent {main}\nauthor ")),
        raw.replace(empty_tree, &nonempty_tree),
        raw.replace(
            "committer Svode Access Probe <access@svode.invalid>",
            "committer Human <human@example.test>",
        ),
        raw.clone() + "extra=unknown\n",
    ];
    let mut expected = Vec::new();
    for (index, contents) in variants.iter().enumerate() {
        let candidate = raw_commit(&cli, repo.path(), contents).await;
        git(
            &cli,
            repo.path(),
            &[
                "update-ref",
                &format!("refs/heads/negative-{index}"),
                &candidate,
            ],
        )
        .await;
        expected.push(candidate);
    }
    git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
    let state = ActorCatalogState::new();
    let snapshot = state.snapshot(&cli, repo.path()).await.unwrap();
    let row = snapshot
        .catalog()
        .rows
        .into_iter()
        .find(|row| row.canonical_email == SERVICE_EMAIL)
        .unwrap();
    assert_eq!(row.commit_count, expected.len() as u64);
    assert_eq!(row.available_years, vec![2023]);
    assert_eq!(row.last_commit_at, Some(TIME));
    let mut page = activity(&state, &cli, repo.path(), SERVICE_EMAIL).await;
    assert_eq!(page.commit_count, expected.len() as u64);
    assert_eq!(
        page.days.iter().map(|day| day.commit_count).sum::<u64>(),
        expected.len() as u64
    );
    let continuation = page.timeline.next_cursor.clone().unwrap();
    let generation = page.generation;
    let mut actual = Vec::new();
    loop {
        actual.extend(
            page.timeline
                .months
                .iter()
                .flat_map(|month| &month.commits)
                .map(|commit| commit.short_sha.clone()),
        );
        let Some(cursor) = page.timeline.next_cursor else {
            break;
        };
        page = state
            .activity(
                &cli,
                repo.path(),
                SERVICE_EMAIL,
                Some(2023),
                None,
                Some(&cursor),
            )
            .await
            .unwrap();
    }
    assert_eq!(actual.len(), expected.len());
    for candidate in expected {
        assert!(actual.iter().any(|short| candidate.starts_with(short)));
    }
    assert!(!actual.iter().any(|short| oid.starts_with(short)));
    let replacement = probe(&cli, repo.path(), "fedcba9876543210", TIME + 1).await;
    git(
        &cli,
        repo.path(),
        &["update-ref", "refs/heads/probe", &replacement],
    )
    .await;
    assert_eq!(
        state
            .activity(
                &cli,
                repo.path(),
                SERVICE_EMAIL,
                Some(2023),
                None,
                Some(&continuation)
            )
            .await
            .unwrap()
            .generation,
        generation
    );
    git(
        &cli,
        repo.path(),
        &["commit", "--allow-empty", "-m", "real change"],
    )
    .await;
    assert!(
        state
            .activity(
                &cli,
                repo.path(),
                SERVICE_EMAIL,
                Some(2023),
                None,
                Some(&continuation)
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mailmap_current_identity_and_zero_commit_activity_survive_probe_filter() {
    let (repo, cli) = fixture().await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME + 86400).await;
    git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
    fs::write(
        repo.path().join(".mailmap"),
        "Human <human@example.test> Svode Access Probe <access@svode.invalid>\n",
    )
    .unwrap();
    let state = ActorCatalogState::new();
    let snapshot = state.snapshot(&cli, repo.path()).await.unwrap();
    assert_eq!(snapshot.candidates().len(), 1);
    assert_eq!(snapshot.candidates()[0].commit_count, 1);
    assert_eq!(snapshot.candidates()[0].last_commit_at, Some(TIME));
    assert_eq!(
        activity(&state, &cli, repo.path(), "human@example.test")
            .await
            .commit_count,
        1
    );
    fs::write(
        repo.path().join(".mailmap"),
        "Svode Access Probe <access@svode.invalid>\n",
    )
    .unwrap();
    let declared = state.snapshot(&cli, repo.path()).await.unwrap();
    let row = declared
        .catalog()
        .rows
        .into_iter()
        .find(|row| row.canonical_email == SERVICE_EMAIL)
        .unwrap();
    assert_eq!(row.commit_count, 0);
    assert!(row.available_years.is_empty());
    assert_eq!(row.last_commit_at, None);
    assert!(
        row.sources
            .iter()
            .all(|source| source.kind != ActorCatalogSourceKind::History)
    );
    let empty = activity(&state, &cli, repo.path(), SERVICE_EMAIL).await;
    assert_eq!(empty.commit_count, 0);
    assert!(empty.timeline.months.is_empty());
    assert!(empty.timeline.next_cursor.is_none());
    fs::remove_file(repo.path().join(".mailmap")).unwrap();
    git(&cli, repo.path(), &["config", "user.name", SERVICE_NAME]).await;
    git(&cli, repo.path(), &["config", "user.email", SERVICE_EMAIL]).await;
    let current = state.snapshot(&cli, repo.path()).await.unwrap();
    assert_eq!(current.current_email(), Some(SERVICE_EMAIL));
    assert_eq!(
        current
            .candidates()
            .iter()
            .find(|row| row.email == SERVICE_EMAIL)
            .unwrap()
            .commit_count,
        0
    );
    git(
        &cli,
        repo.path(),
        &["commit", "--allow-empty", "-m", "legitimate user commit"],
    )
    .await;
    let real = state.snapshot(&cli, repo.path()).await.unwrap();
    assert_eq!(
        real.candidates()
            .iter()
            .find(|row| row.email == SERVICE_EMAIL)
            .unwrap()
            .commit_count,
        1
    );
}

#[tokio::test]
async fn probe_only_refresh_is_equivalent_and_corrects_polluted_snapshot() {
    let (repo, cli) = fixture().await;
    let state = ActorCatalogState::new();
    let clean = state.snapshot(&cli, repo.path()).await.unwrap();
    for (installation, time) in [("0123456789abcdef", TIME), ("fedcba9876543210", 946684800)] {
        let oid = probe(&cli, repo.path(), installation, time).await;
        git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
        assert!(Arc::ptr_eq(
            &clean,
            &state.snapshot(&cli, repo.path()).await.unwrap()
        ));
    }
    // Model the already-published pre-fix row without persisting or rewriting Git data.
    let repository = fs::canonicalize(repo.path()).unwrap();
    let mut polluted = (*clean).clone();
    let identity = Identity {
        name: SERVICE_NAME.into(),
        email: SERVICE_EMAIL.into(),
    };
    let mut row = ActorRowBuilder::new(&identity);
    row.add_history(&identity, SERVICE_NAME, SERVICE_EMAIL, Some(TIME));
    polluted.rows.push(row.finish(None, &polluted.mailmap));
    state
        .snapshots
        .lock()
        .unwrap()
        .insert(repository, Arc::new(polluted));
    let repaired = state.refresh(&cli, repo.path()).await.unwrap();
    assert_eq!(repaired.candidates(), clean.candidates());
    assert_eq!(repaired.generation(), clean.generation() + 1);
    git(
        &cli,
        repo.path(),
        &["commit", "--allow-empty", "-m", "after verification"],
    )
    .await;
    let changed = state.snapshot(&cli, repo.path()).await.unwrap();
    assert_eq!(changed.generation(), repaired.generation() + 1);
    assert_eq!(changed.candidates()[0].commit_count, 2);
}

#[cfg(unix)]
fn wrapper(cli: &GitCli, directory: &Path, body: &str) -> GitCli {
    use std::os::unix::fs::PermissionsExt;
    let script = directory.join("git-wrapper");
    let real = cli.git_path().to_string_lossy().replace('\'', "'\\''");
    fs::write(
        &script,
        format!("#!/bin/sh\n{body}\nexec '{real}' \"$@\"\n"),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    GitCli::for_test(script)
}

#[cfg(unix)]
#[tokio::test]
async fn candidate_read_failure_preserves_snapshot_and_activity_retry() {
    let (repo, cli) = fixture().await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME).await;
    git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
    let helper = tempfile::tempdir().unwrap();
    for command in ["cat-file", "ls-tree"] {
        let broken = wrapper(
            &cli,
            helper.path(),
            &format!("for arg in \"$@\"; do if [ \"$arg\" = {command} ]; then exit 23; fi; done"),
        );
        let state = ActorCatalogState::new();
        assert!(state.snapshot(&broken, repo.path()).await.is_err());
        let initial = state.snapshot(&cli, repo.path()).await.unwrap();
        assert!(
            state
                .activity(
                    &broken,
                    repo.path(),
                    "human@example.test",
                    Some(2023),
                    None,
                    None
                )
                .await
                .is_err()
        );
        assert_eq!(
            activity(&state, &cli, repo.path(), "human@example.test")
                .await
                .commit_count,
            1
        );
        assert!(state.refresh(&broken, repo.path()).await.is_err());
        let repository = fs::canonicalize(repo.path()).unwrap();
        assert!(Arc::ptr_eq(
            &initial,
            &state.cached(&repository).unwrap().unwrap()
        ));
        assert!(state.cached_current(&repository).unwrap().is_none());
        assert!(Arc::ptr_eq(
            &initial,
            &state.snapshot(&cli, repo.path()).await.unwrap()
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn source_change_during_candidate_read_never_mixes_activity_generations() {
    let (repo, cli) = fixture().await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME).await;
    git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
    let state = ActorCatalogState::new();
    let initial = state.snapshot(&cli, repo.path()).await.unwrap();
    let helper = tempfile::tempdir().unwrap();
    let marker = helper.path().join("changed");
    let body = format!(
        r#"for arg in "$@"; do
  if [ "$arg" = cat-file ] && [ ! -e '{marker}' ]; then
    '{git}' "$@"
    touch '{marker}'
    '{git}' commit --quiet --allow-empty -m concurrent
    exit 0
  fi
done"#,
        marker = marker.display(),
        git = cli.git_path().display()
    );
    let racing = wrapper(&cli, helper.path(), &body);
    assert!(
        state
            .activity(
                &racing,
                repo.path(),
                "human@example.test",
                Some(2023),
                None,
                None
            )
            .await
            .is_err()
    );
    let updated = state.snapshot(&cli, repo.path()).await.unwrap();
    assert_eq!(updated.generation(), initial.generation() + 1);
    assert_eq!(updated.candidates()[0].commit_count, 2);
    assert_eq!(
        activity(&state, &cli, repo.path(), "human@example.test")
            .await
            .generation,
        updated.generation()
    );
    fs::remove_file(marker).unwrap();
    let refreshed = state.refresh(&racing, repo.path()).await.unwrap();
    assert_eq!(refreshed.generation(), updated.generation() + 1);
    assert_eq!(refreshed.candidates()[0].commit_count, 3);
}

fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, path: &Path, output: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, output);
            } else {
                output.insert(
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output);
    output
}

#[cfg(unix)]
#[tokio::test]
async fn actor_reads_preserve_all_repository_bytes_and_use_only_local_read_commands() {
    let (repo, cli) = fixture().await;
    let oid = probe(&cli, repo.path(), "0123456789abcdef", TIME).await;
    git(&cli, repo.path(), &["update-ref", "refs/heads/probe", &oid]).await;
    fs::write(repo.path().join("staged"), "staged").unwrap();
    git(&cli, repo.path(), &["add", "staged"]).await;
    fs::write(repo.path().join("staged"), "unstaged").unwrap();
    fs::write(repo.path().join("untracked"), "untracked").unwrap();
    let helper = tempfile::tempdir().unwrap();
    let audited = wrapper(
        &cli,
        helper.path(),
        r#"for arg in "$@"; do
case "$arg" in
  log|cat-file|ls-tree)
    [ "$GIT_NO_LAZY_FETCH" = 1 ] || exit 24
    break;;
  rev-parse|config) break;;
  -c|core.quotepath=false|core.quotePath=false|core.askPass=|color.ui=false) ;;
  *) exit 25;;
esac
done"#,
    );
    let before = files(repo.path());
    let state = ActorCatalogState::new();
    state.snapshot(&audited, repo.path()).await.unwrap();
    state.refresh(&audited, repo.path()).await.unwrap();
    assert_eq!(
        activity(&state, &audited, repo.path(), "human@example.test")
            .await
            .commit_count,
        1
    );
    assert_eq!(files(repo.path()), before);
}
