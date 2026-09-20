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
