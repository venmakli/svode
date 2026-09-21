//! Explicit user save over the shared runtime: scope selection, pending
//! structural companions, unrelated staged bytes and the parent pointer step.

use std::path::Path;
use std::sync::Arc;

use super::GitError;
use super::pending::StructuralOp;
use super::save::save;
use super::staging_tests::{TestHost, cli, git, repo, submodule_project, write};
use super::state::GitRuntime;

fn runtime() -> Arc<GitRuntime> {
    Arc::new(GitRuntime::new())
}

async fn head(repo_path: &Path) -> String {
    git(&cli(), repo_path, &["rev-parse", "HEAD"]).await
}

#[tokio::test]
async fn scoped_save_commits_only_its_paths_and_keeps_unrelated_staged_bytes() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let space = tmp.path();
    write(space, "selected.md", "selected\n");
    write(space, "unrelated.md", "staged\n");
    git(&cli, space, &["add", "unrelated.md"]).await;
    write(space, "unrelated.md", "working\n");
    let staged_before = git(&cli, space, &["ls-files", "--stage", "-z", "unrelated.md"]).await;

    let runtime = runtime();
    let host = TestHost::default();
    let report = save(
        &runtime,
        &host,
        None,
        space,
        Some(vec!["selected.md".to_string()]),
    )
    .await
    .expect("scoped save");

    assert!(report.parent.is_none());
    assert_eq!(
        git(&cli, space, &["show", "HEAD:selected.md"]).await,
        "selected\n"
    );
    assert_eq!(
        git(&cli, space, &["ls-files", "--stage", "-z", "unrelated.md"]).await,
        staged_before
    );
    assert_eq!(
        std::fs::read_to_string(space.join("unrelated.md")).unwrap(),
        "working\n"
    );
}

#[tokio::test]
async fn save_drains_the_related_pending_batch_and_keeps_the_rest() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let space = tmp.path();
    write(space, "renamed.md", "renamed\n");
    write(space, "backlink.md", "link\n");
    write(space, "other.md", "other\n");

    let runtime = runtime();
    let host = TestHost::default();
    let pending = runtime.pending();
    pending.record(
        space,
        Some(StructuralOp::Rename {
            old: "old.md".to_string(),
            new: "renamed.md".to_string(),
        }),
        vec![space.join("renamed.md"), space.join("backlink.md")],
    );
    pending.record(space, None, vec![space.join("other.md")]);

    save(
        &runtime,
        &host,
        None,
        space,
        Some(vec!["renamed.md".to_string()]),
    )
    .await
    .expect("scoped save");

    let committed = git(&cli, space, &["show", "--name-only", "--format=", "HEAD"]).await;
    assert!(committed.contains("renamed.md"));
    assert!(committed.contains("backlink.md"));
    assert!(!committed.contains("other.md"));
    assert_eq!(
        pending.begin_save(space, None).paths(),
        vec![space.join("other.md")]
    );
}

#[tokio::test]
async fn denied_repository_leaves_the_commit_and_the_pending_batch_untouched() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let space = tmp.path();
    write(space, "selected.md", "selected\n");
    let before = head(space).await;

    let runtime = runtime();
    let host = TestHost::denied(GitError::RepositoryAccessDenied {
        repository_id: "repo-denied".to_string(),
        status: "unknown".to_string(),
        reason: "mutation_plan_changed".to_string(),
    });
    let pending = runtime.pending();
    pending.record(space, None, vec![space.join("selected.md")]);

    let error = save(
        &runtime,
        &host,
        None,
        space,
        Some(vec!["selected.md".to_string()]),
    )
    .await
    .expect_err("denied save");

    assert!(matches!(
        error,
        GitError::RepositoryAccessDenied { ref reason, .. } if reason == "mutation_plan_changed"
    ));
    assert_eq!(head(space).await, before);
    assert_eq!(
        pending.begin_save(space, None).paths(),
        vec![space.join("selected.md")]
    );
    assert!(host.commits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn save_without_a_scope_excludes_device_local_files() {
    let cli = cli();
    let tmp = repo(&cli, true).await;
    let space = tmp.path();
    write(space, "portable.md", "portable\n");
    write(space, ".svode/local.json", "{}\n");

    let runtime = runtime();
    let host = TestHost::default();
    save(&runtime, &host, None, space, None)
        .await
        .expect("full save");

    let committed = git(&cli, space, &["show", "--name-only", "--format=", "HEAD"]).await;
    assert!(committed.contains("portable.md"));
    assert!(!committed.contains("local.json"));
}

#[tokio::test]
async fn project_root_with_submodule_spaces_saves_file_paths_and_all() {
    let cli = cli();
    let (tmp, _) = submodule_project(&cli).await;
    let root = tmp.path();
    let runtime = runtime();
    let host = TestHost::default();

    for (requested, expected) in [
        (Some(vec!["tseli/schema.yaml"]), vec!["tseli/schema.yaml"]),
        (
            Some(vec!["tseli/schema.yaml", ".lfsconfig"]),
            vec![".lfsconfig", "tseli/schema.yaml"],
        ),
        (
            None,
            vec![".gitignore", ".lfsconfig", "other.md", "tseli/schema.yaml"],
        ),
    ] {
        write(root, "tseli/schema.yaml", &format!("{requested:?}\n"));
        write(root, ".lfsconfig", &format!("{requested:?}\n"));
        write(root, "other.md", &format!("{requested:?}\n"));
        let before = head(root).await;

        let report = save(
            &runtime,
            &host,
            Some(root),
            root,
            requested.map(|paths| paths.into_iter().map(str::to_string).collect()),
        )
        .await
        .expect("root save");

        assert!(report.parent.is_none());
        assert_ne!(head(root).await, before);
        let committed = git(&cli, root, &["show", "--name-only", "--format=", "HEAD"]).await;
        let mut committed = committed.lines().collect::<Vec<_>>();
        committed.sort_unstable();
        assert_eq!(committed, expected);
    }
}

#[tokio::test]
async fn submodule_space_save_keeps_its_parent_pointer_step() {
    let cli = cli();
    let (tmp, child) = submodule_project(&cli).await;
    let root = tmp.path();
    write(&child, "note.md", "note\n");
    let root_before = head(root).await;

    let runtime = runtime();
    let host = TestHost::default();
    let report = save(
        &runtime,
        &host,
        Some(root),
        &child,
        Some(vec!["note.md".to_string()]),
    )
    .await
    .expect("child save");

    assert_eq!(git(&cli, &child, &["show", "HEAD:note.md"]).await, "note\n");
    assert!(report.parent.is_some());
    assert_ne!(head(root).await, root_before);
    assert_eq!(
        git(&cli, root, &["rev-parse", "HEAD:Исследования"]).await,
        head(&child).await
    );
}
