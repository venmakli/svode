//! Groups of creation over real Page and structure operations (DF-284): a
//! created Page, folder or Collection with its renames, moves and edits
//! before the first commit is one version owned by the object at its final
//! path; it closes like an edit in the editor, while an imported attachment
//! and an operation on a committed object close right after the operation.

use std::path::Path;
use std::time::{Duration, SystemTime};

use super::MessageLanguage;
use super::auto::{AutoVersions, Closing, close};
use crate::git::pending::{StructuralChange, StructuralOp};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::save_chain_tests::{Fixture, page, records, without_order};
use crate::git::staging_tests::{TestHost, cli, git, write};
use crate::page::dates::SystemGitDateExecutor;
use crate::structure::{
    self, CollectionCreate, abs_entry_path, entry_commit_name, entry_entity, entry_paths_with_order,
};

const PAUSE: Duration = Duration::from_secs(60);

/// A project Space with a committed folder and Page, content commits on.
async fn fixture() -> Fixture {
    let fixture = Fixture::new(&[
        ("Docs/README.md", "---\ntitle: Docs\n---\n"),
        ("Kept.md", "---\ntitle: Kept\n---\nKept\n"),
    ])
    .await;
    write_user_policy(
        fixture.root(),
        &GitUserPolicy {
            auto_commit_content: true,
            ..GitUserPolicy::default()
        },
    )
    .unwrap();
    fixture
}

/// Create a Page with the default title and register it the way the
/// Desktop `create_entry` command does: `Create` with the order file first.
async fn create_page(fixture: &Fixture) -> String {
    let space = fixture.space();
    let created = crate::page::create::create(
        crate::page::create::PageCreate {
            space: space.to_string(),
            parent_path: None,
            title: "Untitled".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            properties: None,
            contextual_defaults: true,
            allocate_unique_title: true,
            as_readme: false,
            project: Some(space.to_string()),
            publish_projection: true,
        },
        fixture.structure().index,
        fixture.structure().updates,
        None::<&SystemGitDateExecutor>,
        |paths| async move { Ok::<_, crate::page::PageError>(paths) },
    )
    .await
    .unwrap()
    .page;
    let paths = entry_paths_with_order(space, [abs_entry_path(space, &created.path)]);
    assert!(paths[0].ends_with(".svode/order.json"));
    fixture.git.pending().record(
        Path::new(space),
        Some(
            StructuralChange::new(StructuralOp::Create(entry_commit_name(
                space,
                &created.path,
            )))
            .creating(entry_entity(space, &created.path)),
        ),
        paths,
    );
    created.path
}

async fn closing(fixture: &Fixture, closing: Closing) -> AutoVersions {
    close(
        &fixture.git,
        &TestHost::default(),
        fixture.root(),
        &closing,
        MessageLanguage::En,
    )
    .await
    .expect("close")
}

/// The check a managed operation plans right after it: the group stays open
/// until its pause.
async fn stays_open(fixture: &Fixture) {
    let AutoVersions::Done { commits, next } = closing(fixture, Closing::paused(PAUSE)).await
    else {
        panic!("versions expected");
    };
    assert_eq!(commits, 0);
    assert!(
        next.is_some_and(|next| next > Duration::from_secs(50)),
        "{next:?}"
    );
}

async fn commits(fixture: &Fixture, closing_now: Closing) -> usize {
    match closing(fixture, closing_now).await {
        AutoVersions::Done { commits, .. } => commits,
        other => panic!("versions expected, got {other:?}"),
    }
}

async fn subject(fixture: &Fixture) -> String {
    git(&cli(), fixture.root(), &["log", "-1", "--format=%s"])
        .await
        .trim()
        .to_string()
}

/// Every path any commit of the repository ever touched.
async fn history(fixture: &Fixture) -> String {
    git(
        &cli(),
        fixture.root(),
        &["log", "--all", "--no-renames", "--name-only", "--format="],
    )
    .await
}

fn changed_ago(root: &Path, path: &str, ago: Duration) {
    std::fs::File::options()
        .write(true)
        .open(root.join(path))
        .unwrap()
        .set_modified(SystemTime::now() - ago)
        .unwrap();
}

#[tokio::test]
async fn a_page_created_and_renamed_before_its_group_closes_is_one_version_without_the_draft() {
    let fixture = fixture().await;
    let before = fixture.head().await;
    let created = create_page(&fixture).await;
    assert_eq!(created, "Untitled.md");
    stays_open(&fixture).await;

    let renamed = fixture.rename(&created, "Release notes").await;
    assert_eq!(renamed, "Release notes.md");
    stays_open(&fixture).await;

    // Leaving the window or a sync closes the group.
    assert_eq!(commits(&fixture, Closing::all(PAUSE)).await, 1);
    assert_eq!(
        fixture.commits_since(&before).await,
        [records(&["A\tRelease notes.md"])]
    );
    assert_eq!(subject(&fixture).await, "Create “Release notes”");
    assert!(!history(&fixture).await.contains("Untitled"));
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_created_page_moved_and_edited_closes_when_the_user_leaves_it() {
    let fixture = fixture().await;
    let root = fixture.space();
    let before = fixture.head().await;
    let created = create_page(&fixture).await;
    fixture
        .write(&created, Some("First notes\n"), None)
        .await
        .unwrap();
    let moved = structure::move_entry(root, &created, "Docs", Some(root), fixture.structure())
        .await
        .unwrap();
    assert_eq!(moved, "Docs/Untitled.md");
    stays_open(&fixture).await;

    let left = Closing {
        left: vec![moved.clone()],
        ..Closing::paused(PAUSE)
    };
    assert_eq!(commits(&fixture, left).await, 1);
    let landed = fixture.commits_since(&before).await;
    assert_eq!(landed.len(), 1, "{landed:?}");
    assert!(
        landed[0].contains(&"A\tDocs/Untitled.md".to_string()),
        "{landed:?}"
    );
    assert!(
        !history(&fixture)
            .await
            .lines()
            .any(|path| path == "Untitled.md")
    );
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_created_page_with_edits_waits_for_the_pause_and_commit_all_takes_a_renamed_one() {
    let fixture = fixture().await;
    let before = fixture.head().await;
    let created = create_page(&fixture).await;
    fixture
        .write(&created, Some("Draft text\n"), None)
        .await
        .unwrap();
    stays_open(&fixture).await;
    for path in [created.as_str(), ".svode/order.json"] {
        changed_ago(fixture.root(), path, PAUSE + Duration::from_secs(1));
    }
    assert_eq!(commits(&fixture, Closing::paused(PAUSE)).await, 1);
    assert_eq!(
        fixture.commits_since(&before).await,
        [records(&["A\tUntitled.md"])]
    );

    // “Commit all” closes an open creation as one version too.
    let before = fixture.head().await;
    let second = create_page(&fixture).await;
    let renamed = fixture.rename(&second, "Agenda").await;
    fixture.save(None).await.expect("commit all");
    assert_eq!(
        fixture.commits_since(&before).await,
        [records(&[&format!("A\t{renamed}")])]
    );
    assert_eq!(subject(&fixture).await, "Create “Agenda”");
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_folder_created_and_renamed_is_one_version() {
    let fixture = fixture().await;
    let root = fixture.space();
    let before = fixture.head().await;
    let sink = fixture.structure().commits;
    let folder = structure::create_folder(root, None, "Untitled", Some(root), sink).unwrap();
    stays_open(&fixture).await;
    structure::rename(root, &folder, "Projects", Some(root), fixture.structure())
        .await
        .unwrap();
    stays_open(&fixture).await;

    assert_eq!(commits(&fixture, Closing::all(PAUSE)).await, 1);
    assert_eq!(
        fixture.commits_since(&before).await,
        [records(&["A\tProjects/.gitkeep"])]
    );
    assert!(!history(&fixture).await.contains("Untitled"));
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_collection_created_and_renamed_is_one_version() {
    let fixture = fixture().await;
    let root = fixture.space();
    let before = fixture.head().await;
    let created = structure::create_collection(
        CollectionCreate {
            space: root.to_string(),
            parent_path: None,
            title: "Untitled".into(),
            body: None,
            icon: None,
            description: None,
            cover: None,
            schema: crate::collections::engine::default_collection_schema(),
            allocate_unique_title: false,
            project: Some(root.to_string()),
        },
        fixture.structure(),
        |paths| async move { Ok::<_, crate::page::PageError>(paths) },
    )
    .await
    .unwrap();
    assert_eq!(created.collection_path, "Untitled");
    stays_open(&fixture).await;
    let renamed = fixture.rename("Untitled/README.md", "Tasks").await;
    assert_eq!(renamed, "Tasks/README.md");
    stays_open(&fixture).await;

    assert_eq!(commits(&fixture, Closing::all(PAUSE)).await, 1);
    let landed = fixture.commits_since(&before).await;
    assert_eq!(landed.len(), 1, "{landed:?}");
    assert!(
        landed[0].contains(&"A\tTasks/README.md".to_string()),
        "{landed:?}"
    );
    assert!(
        landed[0].contains(&"A\tTasks/schema.yaml".to_string()),
        "{landed:?}"
    );
    assert_eq!(subject(&fixture).await, "Create “Tasks”");
    assert!(!history(&fixture).await.contains("Untitled"));
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn converting_an_uncommitted_page_to_a_folder_stays_in_its_creation() {
    let fixture = fixture().await;
    let root = fixture.space();
    let before = fixture.head().await;
    let created = create_page(&fixture).await;
    let converted = structure::convert_to_folder(root, &created, Some(root), fixture.structure())
        .await
        .unwrap();
    assert_eq!(converted.path, "Untitled/README.md");
    stays_open(&fixture).await;
    let renamed = fixture.rename(&converted.path, "Plan").await;
    assert_eq!(renamed, "Plan/README.md");
    stays_open(&fixture).await;

    assert_eq!(commits(&fixture, Closing::all(PAUSE)).await, 1);
    assert_eq!(
        without_order(fixture.commits_since(&before).await.remove(0)),
        records(&["A\tPlan/README.md"])
    );
    assert!(!history(&fixture).await.contains("Untitled"));
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn an_imported_attachment_and_an_operation_on_a_committed_page_close_at_once() {
    let fixture = fixture().await;
    let root = fixture.root();
    // Registered as the managed import does: a creation without a content
    // object.
    write(root, "Docs/photo.png", "png");
    fixture.git.pending().record(
        root,
        Some(StructuralChange::new(StructuralOp::Create(
            "photo.png".into(),
        ))),
        vec![root.join("Docs/photo.png")],
    );
    assert_eq!(commits(&fixture, Closing::paused(PAUSE)).await, 1);
    assert_eq!(
        without_order(
            git(
                &cli(),
                root,
                &["show", "--name-status", "--format=", "HEAD"]
            )
            .await
            .lines()
            .map(str::to_string)
            .collect()
        ),
        ["A\tDocs/photo.png"]
    );

    assert_eq!(fixture.rename("Kept.md", "Archived").await, "Archived.md");
    assert_eq!(commits(&fixture, Closing::paused(PAUSE)).await, 1);
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_page_created_without_a_registration_is_a_page_group_closed_by_the_pause() {
    let fixture = fixture().await;
    // MCP and CLI create Pages without registering an operation.
    write(fixture.root(), "Brief.md", &page("Brief", "Body"));
    stays_open(&fixture).await;
    changed_ago(fixture.root(), "Brief.md", PAUSE + Duration::from_secs(1));
    assert_eq!(commits(&fixture, Closing::paused(PAUSE)).await, 1);
    assert_eq!(subject(&fixture).await, "Create “Brief”");
}
