//! Manual save after chains of managed relocations: real Page and structure
//! operations register their history through a sink backed by the runtime's
//! pending owner, then a real Git save commits the chain.

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use tempfile::TempDir;

use super::GitError;
use super::pending::{PendingPaths, StructuralChange};
use super::save::save;
use super::staging_tests::{TestHost, cli, git, write};
use super::state::GitRuntime;
use crate::index::IndexKey;
use crate::index::state::IndexRuntimeState;
use crate::page::dates::SystemGitDateExecutor;
use crate::page::entry;
use crate::page::nonce::WriteNonceRegistry;
use crate::page::test_support::{runtime as page_runtime, scaffold_space, update_state};
use crate::page::write::{PageWrite, write as write_page};
use crate::structure::{self, StructuralCommitSink, StructureRuntime};

/// The Desktop sink with background commits off: every registration waits in
/// the pending owner for the next manual save.
struct PendingSink(Arc<PendingPaths>);

impl StructuralCommitSink for PendingSink {
    fn schedule(&self, _: &Path, space: &Path, change: StructuralChange, paths: Vec<PathBuf>) {
        self.0.record(space, Some(change), paths);
    }

    fn commit_now<'a>(
        &'a self,
        _: &'a Path,
        space: &'a Path,
        paths: Vec<PathBuf>,
        _: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        self.0.record(space, None, paths);
        Box::pin(async {})
    }
}

struct Fixture {
    tmp: TempDir,
    git: Arc<GitRuntime>,
    sink: PendingSink,
    index: IndexRuntimeState,
    nonces: WriteNonceRegistry,
}

impl Fixture {
    /// Inline project Space with `files` committed as its baseline.
    async fn new(files: &[(&str, &str)]) -> Self {
        let cli = cli();
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        git(&cli, root, &["init"]).await;
        git(&cli, root, &["config", "user.name", "Test"]).await;
        git(&cli, root, &["config", "user.email", "test@example.test"]).await;
        git(&cli, root, &["config", "commit.gpgsign", "false"]).await;
        scaffold_space(root, "Test");
        super::ops::ensure_svode_gitignore(root).unwrap();
        super::ops::ensure_inline_gitignore(root).unwrap();
        for (path, content) in files {
            write(root, path, content);
        }
        git(&cli, root, &["add", "."]).await;
        git(&cli, root, &["commit", "-m", "Baseline"]).await;
        let git_runtime = Arc::new(GitRuntime::new());
        let fixture = Self {
            sink: PendingSink(git_runtime.pending()),
            git: git_runtime,
            tmp,
            index: IndexRuntimeState::default(),
            nonces: WriteNonceRegistry::new(),
        };
        fixture.reindex().await;
        fixture
    }

    fn root(&self) -> &Path {
        self.tmp.path()
    }

    fn space(&self) -> &str {
        self.root().to_str().unwrap()
    }

    async fn reindex(&self) {
        let pool = self
            .index
            .get_or_create(&IndexKey::Root(self.root().to_path_buf()))
            .await
            .unwrap();
        crate::index::reindex::full_reindex(
            None::<&SystemGitDateExecutor>,
            &pool,
            self.root(),
            &[],
        )
        .await
        .unwrap();
    }

    fn structure(&self) -> StructureRuntime<'_, SystemGitDateExecutor> {
        StructureRuntime {
            index: &self.index,
            updates: update_state(),
            git_dates: None,
            commits: Some(&self.sink),
        }
    }

    /// Page write with an optional title change; a rename is scheduled the
    /// way the Desktop Page adapter does it.
    async fn write(
        &self,
        path: &str,
        body: Option<&str>,
        title: Option<&str>,
    ) -> Result<String, String> {
        let current = entry::read(self.space(), path).map_err(|error| error.to_string())?;
        let outcome = write_page(
            PageWrite {
                space: self.space(),
                path,
                content: body.unwrap_or(&current.body),
                title,
                icon: None,
                extra: None,
                metadata: None,
                field_batch: None,
                skip_rename: title.is_none(),
                project: Some(self.space()),
                source_version: None,
            },
            page_runtime(&self.index, &self.nonces),
            |paths| async move { Ok(paths) },
        )
        .await
        .map_err(|error: crate::page::PageError| error.to_string())?;
        let new_path = outcome
            .result
            .new_path
            .clone()
            .unwrap_or_else(|| path.to_string());
        if new_path != path {
            structure::schedule_rename(
                Some(&self.sink),
                Some(self.space()),
                self.space(),
                path,
                &new_path,
                &outcome.changed_paths,
            );
        }
        Ok(new_path)
    }

    async fn rename(&self, path: &str, title: &str) -> String {
        self.write(path, None, Some(title)).await.unwrap()
    }

    async fn save(&self, requested: Option<&[&str]>) -> Result<(), GitError> {
        save(
            &self.git,
            &TestHost::default(),
            Some(self.root()),
            self.root(),
            requested.map(|paths| paths.iter().map(|path| path.to_string()).collect()),
        )
        .await
        .map(|_| ())
    }

    async fn head(&self) -> String {
        git(&cli(), self.root(), &["rev-parse", "HEAD"]).await
    }

    /// `<status>\t<path>` records of the HEAD commit, sorted.
    async fn committed(&self) -> Vec<String> {
        let out = git(
            &cli(),
            self.root(),
            &["show", "--no-renames", "--name-status", "--format=", "HEAD"],
        )
        .await;
        let mut records = out.lines().map(str::to_string).collect::<Vec<_>>();
        records.sort();
        records
    }

    async fn show(&self, path: &str) -> String {
        git(&cli(), self.root(), &["show", &format!("HEAD:{path}")]).await
    }

    fn pending(&self) -> Vec<PathBuf> {
        let save = self.git.pending().begin_save(self.root(), None);
        let paths = save.paths();
        drop(save);
        paths
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root().join(path)).unwrap()
    }
}

fn page(title: &str, body: &str) -> String {
    format!("---\ntitle: {title}\n---\n{body}\n")
}

fn records(expected: &[&str]) -> Vec<String> {
    let mut records = expected
        .iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>();
    records.sort();
    records
}

/// Committed records without the sidebar order file some operations rewrite.
fn without_order(records: Vec<String>) -> Vec<String> {
    records
        .into_iter()
        .filter(|record| !record.ends_with(".svode/order.json"))
        .collect()
}

async fn title_chain(fixture: &Fixture) -> String {
    fixture
        .write("Page.md", Some("Edited body\n"), None)
        .await
        .unwrap();
    let renamed = fixture.rename("Page.md", "Renamed").await;
    assert!(
        fixture.write(&renamed, None, Some("Taken")).await.is_err(),
        "an occupied name is refused"
    );
    let final_path = fixture.rename(&renamed, "Final").await;
    let accepted = fixture.rename(&final_path, "Accepted").await;
    assert_eq!(accepted, "Accepted.md");
    accepted
}

const CHAIN_FILES: &[(&str, &str)] = &[
    ("Page.md", "---\ntitle: Page\n---\nBody\n"),
    ("notes/Link.md", "See [Page](../Page.md).\n"),
    ("Taken.md", "---\ntitle: Taken\n---\nTaken\n"),
    ("Unrelated.md", "unrelated\n"),
    ("Staged.md", "staged baseline\n"),
];

#[tokio::test]
async fn scoped_save_after_a_title_rename_chain_commits_the_whole_chain() {
    let fixture = Fixture::new(CHAIN_FILES).await;
    let accepted = title_chain(&fixture).await;
    let cli = cli();
    write(fixture.root(), "Unrelated.md", "unrelated dirty\n");
    write(fixture.root(), "Staged.md", "staged version\n");
    git(&cli, fixture.root(), &["add", "Staged.md"]).await;
    write(fixture.root(), "Staged.md", "working version\n");
    let staged = git(&cli, fixture.root(), &["ls-files", "--stage", "Staged.md"]).await;

    fixture.save(Some(&[&accepted])).await.expect("chain save");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tAccepted.md", "D\tPage.md", "M\tnotes/Link.md"])
    );
    assert!(fixture.show("Accepted.md").await.contains("Edited body"));
    assert_eq!(
        fixture.show("notes/Link.md").await,
        fixture.read("notes/Link.md")
    );
    assert!(fixture.read("notes/Link.md").contains("Accepted.md"));
    assert!(fixture.pending().is_empty());
    assert_eq!(
        git(&cli, fixture.root(), &["ls-files", "--stage", "Staged.md"]).await,
        staged
    );
    assert_eq!(fixture.read("Staged.md"), "working version\n");
    assert_eq!(fixture.read("Unrelated.md"), "unrelated dirty\n");
}

#[tokio::test]
async fn save_all_after_a_title_rename_chain_commits_it_with_other_dirty_files() {
    let fixture = Fixture::new(CHAIN_FILES).await;
    title_chain(&fixture).await;
    write(fixture.root(), "Unrelated.md", "unrelated dirty\n");

    fixture.save(None).await.expect("save all");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&[
            "A\tAccepted.md",
            "D\tPage.md",
            "M\tUnrelated.md",
            "M\tnotes/Link.md",
        ])
    );
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn rename_move_and_folder_relocations_commit_from_the_final_folder() {
    let fixture = Fixture::new(&[
        ("Page.md", "---\ntitle: Page\n---\nBody\n"),
        ("Area/README.md", "---\ntitle: Area\n---\n"),
        ("Link.md", "See [Page](Page.md).\n"),
    ])
    .await;
    let root = fixture.space();
    structure::rename(root, "Page.md", "Plan.md", Some(root), fixture.structure())
        .await
        .unwrap();
    let moved = structure::move_entry(root, "Plan.md", "Area", Some(root), fixture.structure())
        .await
        .unwrap();
    assert_eq!(moved, "Area/Plan.md");
    let converted = structure::convert_to_folder(root, &moved, Some(root), fixture.structure())
        .await
        .unwrap();
    assert_eq!(converted.path, "Area/Plan/README.md");
    structure::rename(
        root,
        "Area/Plan",
        "Area/Goal",
        Some(root),
        fixture.structure(),
    )
    .await
    .unwrap();
    write(
        fixture.root(),
        "Area/Goal/README.md",
        &page("Goal", "Edited"),
    );

    fixture
        .save(Some(&["Area/Goal/README.md"]))
        .await
        .expect("folder chain save");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tArea/Goal/README.md", "D\tPage.md", "M\tLink.md"])
    );
    assert!(
        fixture
            .show("Link.md")
            .await
            .contains("Area/Goal/README.md")
    );
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn a_collection_item_title_chain_commits_its_origin_and_final_item() {
    let fixture = Fixture::new(&[
        ("Tasks/schema.yaml", "columns: []\n"),
        ("Tasks/README.md", "---\ntitle: Tasks\n---\n"),
        ("Tasks/Item.md", "---\ntitle: Item\n---\nItem\n"),
        ("Tasks/Other.md", "---\ntitle: Other\n---\nOther\n"),
    ])
    .await;
    let second = fixture.rename("Tasks/Item.md", "Second").await;
    let third = fixture.rename(&second, "Third").await;
    assert_eq!(third, "Tasks/Third.md");
    fixture.rename("Tasks/Other.md", "Kept").await;

    fixture.save(Some(&[&third])).await.expect("item save");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tTasks/Third.md", "D\tTasks/Item.md"])
    );
    let remaining = fixture.pending();
    for path in ["Tasks/Other.md", "Tasks/Kept.md"] {
        assert!(remaining.contains(&fixture.root().join(path)), "{path}");
    }
    assert!(!remaining.contains(&fixture.root().join(&third)));
}

#[tokio::test]
async fn returning_to_the_original_name_commits_only_real_changes() {
    for edit in [false, true] {
        let fixture = Fixture::new(&[
            ("Page.md", "---\ntitle: Page\n---\nBody\n"),
            ("Link.md", "See [Page](Page.md).\n"),
        ])
        .await;
        let before = fixture.head().await;
        if edit {
            fixture
                .write("Page.md", Some("Edited body\n"), None)
                .await
                .unwrap();
        }
        let other = fixture.rename("Page.md", "Other").await;
        assert_eq!(fixture.rename(&other, "Page").await, "Page.md");

        fixture.save(Some(&["Page.md"])).await.expect("round trip");

        if edit {
            assert_eq!(fixture.committed().await, records(&["M\tPage.md"]));
        } else {
            assert_eq!(fixture.head().await, before);
        }
        assert!(fixture.pending().is_empty(), "edit {edit}");
    }
}

#[tokio::test]
async fn an_untracked_page_renamed_several_times_commits_only_its_final_file() {
    let fixture = Fixture::new(&[("Link.md", "base\n")]).await;
    write(fixture.root(), "Draft.md", &page("Draft", "Draft"));
    fixture.reindex().await;
    let idea = fixture.rename("Draft.md", "Idea").await;
    let plan = fixture.rename(&idea, "Plan").await;

    fixture.save(Some(&[&plan])).await.expect("untracked chain");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tPlan.md"])
    );
    assert!(fixture.pending().is_empty());
}

#[tokio::test]
async fn operations_with_equal_labels_or_shared_companions_stay_separate() {
    let fixture = Fixture::new(&[
        ("a/Note.md", "---\ntitle: Note\n---\nA\n"),
        ("b/Note.md", "---\ntitle: Note\n---\nB\n"),
        ("Hub.md", "[A](a/Note.md) and [B](b/Note.md)\n"),
        (
            "People/schema.yaml",
            "columns:\n  - { name: Email, type: email }\n",
        ),
        ("People/README.md", "---\ntitle: People\n---\n"),
        ("People/Ann.md", "---\ntitle: Ann\n---\nAnn\n"),
        ("People/Bob.md", "---\ntitle: Bob\n---\nBob\n"),
        ("Staged.md", "staged baseline\n"),
    ])
    .await;
    let root = fixture.space();
    for folder in ["a", "b"] {
        structure::rename(
            root,
            &format!("{folder}/Note.md"),
            &format!("{folder}/Plan.md"),
            Some(root),
            fixture.structure(),
        )
        .await
        .unwrap();
    }
    let ann = fixture.rename("People/Ann.md", "Anna").await;
    fixture.rename("People/Bob.md", "Robert").await;
    let cli = cli();
    write(fixture.root(), "Staged.md", "staged version\n");
    git(&cli, fixture.root(), &["add", "Staged.md"]).await;
    write(fixture.root(), "Staged.md", "working version\n");
    write(fixture.root(), "Dirty.md", "dirty\n");
    let staged = git(&cli, fixture.root(), &["ls-files", "--stage", "Staged.md"]).await;

    fixture.save(Some(&["a/Plan.md"])).await.expect("a save");
    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\ta/Plan.md", "D\ta/Note.md", "M\tHub.md"])
    );

    fixture.save(Some(&[&ann])).await.expect("sensitive save");
    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tPeople/Anna.md", "D\tPeople/Ann.md"])
    );

    let remaining = fixture.pending();
    for path in [
        "b/Note.md",
        "b/Plan.md",
        "People/Bob.md",
        "People/Robert.md",
    ] {
        assert!(remaining.contains(&fixture.root().join(path)), "{path}");
    }
    assert!(fixture.root().join("b/Plan.md").exists());
    assert_eq!(
        git(&cli, fixture.root(), &["ls-files", "--stage", "Staged.md"]).await,
        staged
    );
    assert_eq!(fixture.read("Staged.md"), "working version\n");
    assert_eq!(fixture.read("Dirty.md"), "dirty\n");
}

#[tokio::test]
async fn an_explicitly_requested_missing_path_is_still_unavailable() {
    let fixture = Fixture::new(CHAIN_FILES).await;
    let accepted = title_chain(&fixture).await;
    let before = fixture.head().await;

    let error = fixture
        .save(Some(&[&accepted, "Final.md"]))
        .await
        .expect_err("missing target");

    assert!(
        matches!(error, GitError::SaveFailed { reason, .. } if reason == "target_unavailable"),
        "{error:?}"
    );
    assert_eq!(fixture.head().await, before);
    assert!(fixture.pending().contains(&fixture.root().join("Final.md")));
}

#[tokio::test]
async fn a_refused_commit_returns_the_chain_and_a_retry_commits_it() {
    let fixture = Fixture::new(CHAIN_FILES).await;
    let accepted = title_chain(&fixture).await;
    let before = fixture.head().await;
    let hook = fixture.root().join(".git/hooks/pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    #[cfg(unix)]
    svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(not(unix))]
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    let pending_before = fixture.pending();

    let error = fixture
        .save(Some(&[&accepted]))
        .await
        .expect_err("hook refusal");

    assert!(
        matches!(error, GitError::SaveFailed { stage, .. } if stage == "commit"),
        "{error:?}"
    );
    assert_eq!(fixture.head().await, before);
    assert!(fixture.read("Accepted.md").contains("Edited body"));
    assert_eq!(fixture.pending(), pending_before);

    fs::remove_file(&hook).unwrap();
    fixture.git.pending().record(
        fixture.root(),
        None,
        vec![fixture.root().join("Unrelated.md")],
    );
    fixture.save(Some(&[&accepted])).await.expect("retry");

    assert_eq!(
        without_order(fixture.committed().await),
        records(&["A\tAccepted.md", "D\tPage.md", "M\tnotes/Link.md"])
    );
    assert_eq!(fixture.pending(), vec![fixture.root().join("Unrelated.md")]);
}
