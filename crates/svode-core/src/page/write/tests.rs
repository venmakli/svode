use super::*;
use crate::index::IndexKey;
use crate::index::state::IndexRuntimeState as IndexState;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::nonce::WriteNonceRegistry;
use crate::page::test_support::{runtime, scaffold_space};

async fn save(
    root: &Path,
    path: &str,
    body: &str,
    title: Option<&str>,
    state: &IndexState,
    nonces: &WriteNonceRegistry,
) -> Result<PageWriteOutcome, PageError> {
    write(
        PageWrite {
            space: root.to_str().unwrap(),
            path,
            content: body,
            title,
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: title.is_none(),
            project: Some(root.to_str().unwrap()),
            source_version: None,
        },
        runtime(state, nonces),
        |mut paths| async move {
            paths.push(root.to_path_buf());
            Ok(paths)
        },
    )
    .await
}

#[tokio::test]
async fn body_only_preserves_raw_frontmatter_and_noop_does_not_publish() {
    for source in [
        "---\r\ntitle: Old\r\ncustom: 'x'\r\n---\r\n\r\nBody",
        "---\ntitle: [broken\n---\nBody",
        "Body",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("Old.md"), source).unwrap();
        let state = IndexState::default();
        let nonces = WriteNonceRegistry::new();
        let current = entry::read(root.to_str().unwrap(), "Old.md").unwrap();
        let result = save(root, "Old.md", &current.body, None, &state, &nonces)
            .await
            .unwrap();
        assert!(result.changed_paths.is_empty());
        assert_eq!(fs::read_to_string(root.join("Old.md")).unwrap(), source);
        assert!(nonces.take_metadata(&root.join("Old.md")).is_none());
        let result = save(root, "Old.md", "Replacement", None, &state, &nonces)
            .await
            .unwrap();
        assert_eq!(result.changed_paths, vec![root.join("Old.md")]);
        assert!(result.result.new_path.is_none());
        if source.contains("custom:") {
            assert!(
                fs::read_to_string(root.join("Old.md"))
                    .unwrap()
                    .starts_with("---\r\ntitle: Old\r\ncustom: 'x'\r\n---\r\n")
            );
        }
    }
}

#[tokio::test]
async fn combined_failure_restores_all_source_bytes_paths_and_prior_edits() {
    for stage in ["body", "rename", "links", "relations", "routing", "order"] {
        for directory in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            fs::create_dir_all(root.join(".git")).unwrap();
            let path = if directory { "Old/README.md" } else { "Old.md" };
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::create_dir_all(root.join(".svode")).unwrap();
            let original = "---\ntitle: Old\n---\nPrior completed edit\n";
            fs::write(root.join(path), original).unwrap();
            let source = format!("[Old]({path})\n");
            fs::write(root.join("Link.md"), &source).unwrap();
            fs::write(
                root.join(".svode/order.json"),
                "{\".\":[\"Old.md\",\"Old\",\"Link.md\"]}",
            )
            .unwrap();
            fs::write(root.join(".gitignore"), "unrelated-pattern\n").unwrap();
            let attributes = "*.custom merge=ours\n# svode:assets-lfs-paths:start\n# svode:path \"Old/asset.bin\"\nOld/asset.bin filter=lfs diff=lfs merge=lfs -text\n# svode:assets-lfs-paths:end\n";
            fs::write(root.join(".gitattributes"), attributes).unwrap();
            if directory {
                fs::write(root.join("Old/Child.md"), "[external](../Link.md)\n").unwrap();
                fs::write(root.join("Old/asset.bin"), [0, 1, 2, 255]).unwrap();
            }
            let state = IndexState::default();
            let pool = state
                .get_or_create(&IndexKey::Root(root.to_path_buf()))
                .await
                .unwrap();
            crate::index::reindex::full_reindex(None::<&SystemGitDateExecutor>, &pool, root, &[])
                .await
                .unwrap();
            let before: Vec<(String, String)> =
                sqlx::query_as("SELECT file_path, title FROM entries ORDER BY file_path")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let nonces = WriteNonceRegistry::new();
            FAILURE.with(|failure| *failure.borrow_mut() = Some(stage));
            let result = save(root, path, "New body", Some("New"), &state, &nonces).await;
            FAILURE.with(|failure| *failure.borrow_mut() = None);
            let error = result.err().expect("injected failure");
            assert!(
                error
                    .to_string()
                    .contains(&format!("injected {stage} failure")),
                "{error}"
            );
            assert_eq!(
                fs::read_to_string(root.join(path)).unwrap(),
                original,
                "{stage}"
            );
            assert_eq!(
                fs::read_to_string(root.join("Link.md")).unwrap(),
                source,
                "{stage}"
            );
            assert!(!root.join(if directory { "New" } else { "New.md" }).exists());
            assert_eq!(
                fs::read_to_string(root.join(".svode/order.json")).unwrap(),
                "{\".\":[\"Old.md\",\"Old\",\"Link.md\"]}"
            );
            assert_eq!(
                fs::read_to_string(root.join(".gitignore")).unwrap(),
                "unrelated-pattern\n"
            );
            if directory {
                assert_eq!(
                    fs::read_to_string(root.join("Old/Child.md")).unwrap(),
                    "[external](../Link.md)\n"
                );
                assert_eq!(
                    fs::read(root.join("Old/asset.bin")).unwrap(),
                    [0, 1, 2, 255]
                );
            }
            assert!(nonces.take_metadata(&root.join(path)).is_none());
            assert!(nonces.take_metadata(&root.join("New.md")).is_none());
            let after: Vec<(String, String)> =
                sqlx::query_as("SELECT file_path, title FROM entries ORDER BY file_path")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(before, after, "no intermediate projection at {stage}");
            assert_eq!(
                fs::read_to_string(root.join(".gitattributes")).unwrap(),
                attributes
            );
        }
    }
}

#[tokio::test]
async fn projection_failure_is_applied_and_authorization_denial_is_not() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("Old.md"), "---\ntitle: Old\n---\nOld").unwrap();
    let state = IndexState::default();
    let nonces = WriteNonceRegistry::new();
    FAILURE.with(|failure| *failure.borrow_mut() = Some("projection"));
    let result = save(root, "Old.md", "New body", Some("New"), &state, &nonces)
        .await
        .unwrap();
    FAILURE.with(|failure| *failure.borrow_mut() = None);
    assert_eq!(result.result.new_path.as_deref(), Some("New.md"));
    assert!(
        result
            .result
            .warnings
            .iter()
            .any(|warning| warning.kind == "projection_update_failed")
    );
    assert!(
        fs::read_to_string(root.join("New.md"))
            .unwrap()
            .contains("New body")
    );
    let before = fs::read(root.join("New.md")).unwrap();
    let result = write(
        PageWrite {
            space: root.to_str().unwrap(),
            path: "New.md",
            content: "Denied",
            title: Some("Denied"),
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: false,
            project: None,
            source_version: None,
        },
        runtime(&state, &nonces),
        |_| async { Err(PageError::General("denied".into())) },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(fs::read(root.join("New.md")).unwrap(), before);
}

#[test]
fn rollback_failure_reports_original_cause_and_unrestored_paths() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("Page.md");
    fs::write(&path, "Original").unwrap();
    let snapshot = SourceSnapshot::capture(std::slice::from_ref(&path), None).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let error = snapshot.rollback(PageError::General("source write failed".into()));
    match error {
        PageError::Recovery { cause, paths } => {
            assert_eq!(cause, "source write failed");
            assert_eq!(paths, [path.display().to_string()]);
        }
        error => panic!("unexpected recovery result: {error}"),
    }
}

#[tokio::test]
async fn root_owner_title_and_filename_collision_keep_canonical_path() {
    for path in ["README.md", "Old.md"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(path), "---\ntitle: Old\n---\nOld body").unwrap();
        fs::write(
            root.join("New.md"),
            "---\ntitle: Other display name\n---\nUntouched",
        )
        .unwrap();
        let state = IndexState::default();
        let nonces = WriteNonceRegistry::new();
        let result = save(root, path, "New body", Some("New"), &state, &nonces)
            .await
            .unwrap();
        assert!(result.result.new_path.is_none());
        assert_eq!(
            entry::read(root.to_str().unwrap(), path)
                .unwrap()
                .meta
                .title,
            "New"
        );
        if path == "Old.md" {
            assert!(
                result
                    .result
                    .warnings
                    .iter()
                    .any(|warning| warning.kind == "filename_rename_collision")
            );
        }
        assert!(
            fs::read_to_string(root.join("New.md"))
                .unwrap()
                .contains("Untouched")
        );
    }
}

#[tokio::test]
async fn late_failure_restores_collection_schema_and_reverse_relation_values() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    scaffold_space(root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("Tasks")).unwrap();
    fs::create_dir_all(root.join("Decisions")).unwrap();
    let sources = [
        ("Tasks/schema.yaml", "columns: []\n"),
        ("Tasks/README.md", "---\ntitle: Tasks\n---\nBefore"),
        ("Tasks/Item.md", "---\ntitle: Item\n---\nItem"),
        (
            "Decisions/schema.yaml",
            "columns:\n  - name: Task\n    type: relation\n    relation: Tasks\n",
        ),
        (
            "Decisions/Decision.md",
            "---\ntitle: Decision\nTask: [Item.md]\n---\nBefore",
        ),
    ];
    for (path, content) in sources {
        fs::write(root.join(path), content).unwrap();
    }
    let state = IndexState::default();
    let nonces = WriteNonceRegistry::new();
    FAILURE.with(|failure| *failure.borrow_mut() = Some("routing"));
    let result = save(
        root,
        "Tasks/README.md",
        "After",
        Some("New tasks"),
        &state,
        &nonces,
    )
    .await;
    FAILURE.with(|failure| *failure.borrow_mut() = None);
    let error = result.err().unwrap();
    assert!(
        error.to_string().contains("injected routing failure"),
        "{error}"
    );
    for (path, content) in sources {
        assert_eq!(
            fs::read_to_string(root.join(path)).unwrap(),
            content,
            "{path}"
        );
    }
    assert!(!root.join("New tasks").exists());
}

#[tokio::test]
async fn deferred_filename_still_rejects_duplicate_display_name() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    scaffold_space(root, "Test");
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("Tasks")).unwrap();
    fs::write(root.join("Tasks/schema.yaml"), "columns: [").unwrap();
    let original = "---\ntitle: Original\n---\nBefore";
    fs::write(root.join("Tasks/Original.md"), original).unwrap();
    fs::write(root.join("Tasks/peer.md"), "---\ntitle: Taken\n---\nPeer").unwrap();
    let state = IndexState::default();
    let result = save(
        root,
        "Tasks/Original.md",
        "After",
        Some("Taken"),
        &state,
        &WriteNonceRegistry::new(),
    )
    .await;
    assert!(matches!(result, Err(PageError::DocumentNameConflict(_))));
    assert_eq!(
        fs::read_to_string(root.join("Tasks/Original.md")).unwrap(),
        original
    );
    assert!(!root.join("Tasks/Taken.md").exists());
}

#[tokio::test]
async fn combined_write_keeps_git_head_and_unrelated_staged_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    git(&["init", "-q"]);
    fs::write(root.join("Old.md"), "---\ntitle: Old\n---\nOriginal").unwrap();
    fs::write(root.join("Other.txt"), "Original").unwrap();
    git(&["add", "Old.md", "Other.txt"]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Fixture",
    ]);
    fs::write(root.join("Other.txt"), "Staged unrelated edit").unwrap();
    git(&["add", "Other.txt"]);
    fs::write(root.join("Other.txt"), "Unstaged unrelated edit").unwrap();
    let head = git(&["rev-parse", "HEAD"]);
    let staged = git(&["show", ":Other.txt"]);
    let index = fs::read(root.join(".git/index")).unwrap();
    let outcome = save(
        root,
        "Old.md",
        "New body",
        Some("New"),
        &IndexState::default(),
        &WriteNonceRegistry::new(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.result.new_path.as_deref(), Some("New.md"));
    assert_eq!(git(&["rev-parse", "HEAD"]), head);
    assert_eq!(git(&["show", ":Other.txt"]), staged);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(root.join("Other.txt")).unwrap(),
        "Unstaged unrelated edit"
    );
}

async fn save_from(
    root: &Path,
    path: &str,
    body: &str,
    version: &SourceVersion,
    state: &IndexState,
    nonces: &WriteNonceRegistry,
) -> Result<PageWriteOutcome, PageError> {
    write(
        PageWrite {
            space: root.to_str().unwrap(),
            path,
            content: body,
            title: None,
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: true,
            project: None,
            source_version: Some(version),
        },
        runtime(state, nonces),
        |mut paths| async move {
            paths.push(root.to_path_buf());
            Ok(paths)
        },
    )
    .await
}

#[tokio::test]
async fn a_write_from_the_current_version_returns_the_version_of_its_result() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("Page.md"), "---\ntitle: Page\n---\nOld\n").unwrap();
    let (state, nonces) = (IndexState::default(), WriteNonceRegistry::new());
    let read = entry::read(root.to_str().unwrap(), "Page.md").unwrap();

    let written = save_from(
        root,
        "Page.md",
        "New\n",
        read.source_version.as_ref().unwrap(),
        &state,
        &nonces,
    )
    .await
    .unwrap();

    let after = entry::read(root.to_str().unwrap(), "Page.md").unwrap();
    assert_eq!(after.body, "New\n");
    assert_eq!(
        written.result.source_version.as_deref(),
        Some(after.source_version.as_ref().unwrap().as_str())
    );
    // The returned version chains the next write without another read.
    let chained = SourceVersion::from_token(written.result.source_version.unwrap());
    save_from(root, "Page.md", "Next\n", &chained, &state, &nonces)
        .await
        .unwrap();
    assert!(
        fs::read_to_string(root.join("Page.md"))
            .unwrap()
            .ends_with("Next\n")
    );
    // No staged copy is left next to the source.
    let names = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect::<Vec<_>>();
    assert!(names.is_empty(), "{names:?}");
}

#[tokio::test]
async fn a_write_from_an_outdated_version_is_stale_without_effects() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("Page.md"), "---\ntitle: Page\n---\nOld\n").unwrap();
    let (state, nonces) = (IndexState::default(), WriteNonceRegistry::new());
    let read = entry::read(root.to_str().unwrap(), "Page.md").unwrap();
    let external = "---\ntitle: Page\n---\nExternal\n";
    fs::write(root.join("Page.md"), external).unwrap();

    let error = save_from(
        root,
        "Page.md",
        "Mine\n",
        read.source_version.as_ref().unwrap(),
        &state,
        &nonces,
    )
    .await
    .map(|_| ())
    .unwrap_err();

    assert!(matches!(error, PageError::SourceStale { ref path } if path == "Page.md"));
    assert_eq!(fs::read_to_string(root.join("Page.md")).unwrap(), external);
    assert!(nonces.take_metadata(&root.join("Page.md")).is_none());
}

#[tokio::test]
async fn a_write_to_a_repository_held_by_another_writer_is_busy_without_effects() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("Page.md"), "Old\n").unwrap();
    let (state, nonces) = (IndexState::default(), WriteNonceRegistry::new());
    let read = entry::read(root.to_str().unwrap(), "Page.md").unwrap();
    let held =
        crate::git::write_guard::acquire(&std::collections::BTreeSet::from([root.clone()]), &[])
            .await
            .unwrap();

    let writer = tokio::spawn({
        let root = root.clone();
        let version = read.source_version.clone().unwrap();
        async move {
            let (state, nonces) = (IndexState::default(), WriteNonceRegistry::new());
            save_from(&root, "Page.md", "Mine\n", &version, &state, &nonces)
                .await
                .map(|_| ())
        }
    });
    let error = writer.await.unwrap().unwrap_err();
    assert!(matches!(error, PageError::SourceBusy { ref path } if path == "Page.md"));
    assert_eq!(fs::read_to_string(root.join("Page.md")).unwrap(), "Old\n");

    // After the other writer releases the guard, the same intent applies.
    drop(held);
    save_from(
        &root,
        "Page.md",
        "Mine\n",
        read.source_version.as_ref().unwrap(),
        &state,
        &nonces,
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(root.join("Page.md")).unwrap(), "Mine\n");
}

#[tokio::test]
async fn a_reader_sees_the_old_or_the_new_bytes_of_a_write() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join(".git")).unwrap();
    let old = format!("---\ntitle: Page\n---\n{}", "a".repeat(4 << 20));
    let new_body = "b".repeat(4 << 20);
    fs::write(root.join("Page.md"), &old).unwrap();
    let (state, nonces) = (IndexState::default(), WriteNonceRegistry::new());
    let read = entry::read(root.to_str().unwrap(), "Page.md").unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = std::thread::spawn({
        let path = root.join("Page.md");
        let stop = stop.clone();
        move || {
            let mut observed = std::collections::BTreeSet::new();
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let bytes = fs::read(&path).unwrap();
                observed.insert(bytes.len());
            }
            observed
        }
    });

    save_from(
        root,
        "Page.md",
        &new_body,
        read.source_version.as_ref().unwrap(),
        &state,
        &nonces,
    )
    .await
    .unwrap();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let observed = reader.join().unwrap();
    let new_len = fs::metadata(root.join("Page.md")).unwrap().len() as usize;
    assert!(
        observed
            .iter()
            .all(|len| *len == old.len() || *len == new_len),
        "{observed:?}"
    );
}

/// Access refusal of the rename-deferral tests: it locates every denied
/// repository like the hosts do. These writes never fail otherwise.
#[derive(Debug)]
struct Refused(Vec<RepositoryAccessBlocker>);

impl From<PageError> for Refused {
    fn from(error: PageError) -> Self {
        panic!("unexpected Page error: {error}")
    }
}

impl RepositoryAccessRefusal for Refused {
    fn access_blockers(&self) -> Option<&[RepositoryAccessBlocker]> {
        Some(&self.0)
    }
}

/// Project with a root Space and independent child Spaces `spaces/<id>`,
/// each linking to `target` of the root Space from `Link.md`.
async fn linked_project(root: &Path, target: &str, spaces: &[&str]) -> IndexState {
    fs::create_dir_all(root.join(".git")).unwrap();
    let references = spaces
        .iter()
        .map(|id| format!("{{\"id\":\"{id}\",\"path\":\"spaces/{id}\"}}"))
        .collect::<Vec<_>>()
        .join(",");
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        format!("{{\"name\":\"Root\",\"spaces\":[{references}]}}"),
    )
    .unwrap();
    fs::create_dir_all(root.join(target).parent().unwrap()).unwrap();
    fs::write(root.join(target), "---\ntitle: Old\n---\nBody\n").unwrap();
    let state = IndexState::default();
    for id in spaces {
        let space = root.join("spaces").join(id);
        scaffold_space(&space, id);
        fs::create_dir_all(space.join(".git")).unwrap();
        fs::write(space.join("Link.md"), format!("[Old](../../{target})\n")).unwrap();
        state
            .upsert_space(
                root,
                id,
                &format!("spaces/{id}"),
                crate::index::resolver::SpaceStatus::Ready,
                None,
            )
            .await;
    }
    state
}

/// Title write of `path` in `space` that refuses every repository of
/// `denied` and records each authorized touched-set.
async fn save_denied(
    space: &Path,
    project: &Path,
    path: &str,
    title: &str,
    state: &IndexState,
    denied: &[PathBuf],
    requests: &std::sync::Mutex<Vec<Vec<PathBuf>>>,
) -> Result<PageWriteOutcome, Refused> {
    let content = entry::read(space.to_str().unwrap(), path).unwrap().body;
    write(
        PageWrite {
            space: space.to_str().unwrap(),
            path,
            content: &content,
            title: Some(title),
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: false,
            project: Some(project.to_str().unwrap()),
            source_version: None,
        },
        runtime(state, &WriteNonceRegistry::new()),
        |mut paths| {
            requests.lock().unwrap().push(paths.clone());
            let mut blockers: Vec<RepositoryAccessBlocker> = Vec::new();
            for path in &paths {
                let repository = crate::git::access::local_repository_root(path).unwrap();
                if denied.contains(&repository)
                    && !blockers
                        .iter()
                        .any(|blocker| blocker.repository_path == repository.display().to_string())
                {
                    blockers.push(RepositoryAccessBlocker {
                        repository_id: format!("id-{}", blockers.len()),
                        repository_path: repository.display().to_string(),
                        status: "read_only".into(),
                        reason: "none".into(),
                    });
                }
            }
            paths.push(space.to_path_buf());
            async move {
                if blockers.is_empty() {
                    Ok(paths)
                } else {
                    Err(Refused(blockers))
                }
            }
        },
    )
    .await
}

fn repository(path: &Path) -> PathBuf {
    crate::git::access::local_repository_root(path).unwrap()
}

#[tokio::test]
async fn a_refusing_linking_repository_defers_the_filename_and_the_same_title_renames_later() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let state = linked_project(root, "Tasks/Page.md", &["a"]).await;
    let link = root.join("spaces/a/Link.md");
    let link_before = fs::read(&link).unwrap();
    let requests = std::sync::Mutex::new(Vec::new());

    let deferred = save_denied(
        root,
        root,
        "Tasks/Page.md",
        "Новое имя",
        &state,
        &[repository(&root.join("spaces/a"))],
        &requests,
    )
    .await
    .unwrap();

    assert!(deferred.result.new_path.is_none());
    let page = entry::read(root.to_str().unwrap(), "Tasks/Page.md").unwrap();
    assert_eq!(page.meta.title, "Новое имя");
    assert_eq!(page.body, "Body\n");
    assert!(!root.join("Tasks/Новое имя.md").exists());
    assert_eq!(fs::read(&link).unwrap(), link_before);
    let warning = &deferred.result.warnings[0];
    assert_eq!(warning.kind, "filename_rename_deferred");
    assert_eq!(warning.path.as_deref(), Some("Tasks/Page.md"));
    assert_eq!(
        warning.reason.as_deref(),
        Some(entry::REPOSITORY_ACCESS_DENIED_REASON)
    );
    assert_eq!(
        warning
            .blockers
            .iter()
            .map(|blocker| blocker.repository_path.clone())
            .collect::<Vec<_>>(),
        [repository(&root.join("spaces/a")).display().to_string()]
    );
    let requests_made = requests.lock().unwrap().clone();
    assert_eq!(requests_made.len(), 2, "rename plan, then the title alone");
    assert!(requests_made[0].contains(&link));
    assert!(
        requests_made[1]
            .iter()
            .all(|path| repository(path) == repository(root)),
        "the title needs only the Page repository"
    );

    let renamed = save_denied(
        root,
        root,
        "Tasks/Page.md",
        "Новое имя",
        &state,
        &[],
        &requests,
    )
    .await
    .unwrap();
    assert_eq!(
        renamed.result.new_path.as_deref(),
        Some("Tasks/Новое имя.md")
    );
    assert!(renamed.result.warnings.is_empty());
    assert!(!root.join("Tasks/Page.md").exists());
    let rewritten = fs::read_to_string(&link).unwrap();
    assert!(
        rewritten.contains("Новое") && !rewritten.contains("Tasks/Page.md"),
        "{rewritten}"
    );
}

#[tokio::test]
async fn two_refusing_repositories_are_named_and_a_folder_page_keeps_its_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let state = linked_project(root, "protsessy/README.md", &["a", "b"]).await;
    fs::write(root.join("protsessy/Child.md"), "---\ntitle: Child\n---\n").unwrap();
    let links = ["a", "b"].map(|id| {
        let path = root.join("spaces").join(id).join("Link.md");
        let bytes = fs::read(&path).unwrap();
        (path, bytes)
    });
    let denied = [
        repository(&root.join("spaces/a")),
        repository(&root.join("spaces/b")),
    ];

    let deferred = save_denied(
        root,
        root,
        "protsessy/README.md",
        "Процессы",
        &state,
        &denied,
        &std::sync::Mutex::new(Vec::new()),
    )
    .await
    .unwrap();

    assert!(deferred.result.new_path.is_none());
    assert_eq!(
        entry::read(root.to_str().unwrap(), "protsessy/README.md")
            .unwrap()
            .meta
            .title,
        "Процессы"
    );
    assert!(root.join("protsessy/Child.md").is_file());
    assert!(!root.join("Процессы").exists());
    for (path, bytes) in &links {
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
    let mut named = deferred.result.warnings[0]
        .blockers
        .iter()
        .map(|blocker| PathBuf::from(&blocker.repository_path))
        .collect::<Vec<_>>();
    named.sort();
    assert_eq!(named, denied.to_vec());
}

#[tokio::test]
async fn a_refusing_page_repository_writes_nothing_and_names_every_blocker() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let state = linked_project(root, "Tasks/Page.md", &["a"]).await;
    let page_before = fs::read(root.join("Tasks/Page.md")).unwrap();
    let link_before = fs::read(root.join("spaces/a/Link.md")).unwrap();

    let error = save_denied(
        root,
        root,
        "Tasks/Page.md",
        "Новое имя",
        &state,
        &[repository(root), repository(&root.join("spaces/a"))],
        &std::sync::Mutex::new(Vec::new()),
    )
    .await
    .err()
    .expect("the Page repository refuses");

    assert_eq!(error.0.len(), 2, "the refusal of the full rename plan");
    assert_eq!(fs::read(root.join("Tasks/Page.md")).unwrap(), page_before);
    assert_eq!(
        fs::read(root.join("spaces/a/Link.md")).unwrap(),
        link_before
    );
}

#[tokio::test]
async fn a_submodule_rename_needs_the_parent_gitlink_repository() {
    let Some(cli) = crate::git::state::detected_cli() else {
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    cli.exec(root, &["init", "-q"]).await.unwrap();
    fs::write(
        root.join(".gitmodules"),
        "[submodule \"spaces/a\"]\n\tpath = spaces/a\n\turl = https://example.invalid/a.git\n",
    )
    .unwrap();
    let state = linked_project(root, "Root.md", &["a"]).await;
    let space = root.join("spaces/a");
    fs::write(space.join("Page.md"), "---\ntitle: Old\n---\nBody\n").unwrap();
    let requests = std::sync::Mutex::new(Vec::new());

    let deferred = save_denied(
        &space,
        root,
        "Page.md",
        "New",
        &state,
        &[repository(root)],
        &requests,
    )
    .await
    .unwrap();

    assert!(requests.lock().unwrap()[0].contains(&root.to_path_buf()));
    assert!(deferred.result.new_path.is_none());
    assert_eq!(
        deferred.result.warnings[0].blockers[0].repository_path,
        repository(root).display().to_string()
    );
    assert!(space.join("Page.md").is_file());

    let renamed = save_denied(&space, root, "Page.md", "New", &state, &[], &requests)
        .await
        .unwrap();
    assert_eq!(renamed.result.new_path.as_deref(), Some("New.md"));
}
