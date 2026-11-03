//! The renumbering of repeated `unique_id` numbers after the integration of
//! the observed revision (DF-237 R3, R5): the published item keeps its
//! number, the local one gets a new number in the merge commit or in the
//! working copy, and the sync result names it.

use super::*;
use crate::collections::unique_id_duplicates::UniqueIdNumbers;
use crate::collections::unique_id_renumber::RenumberedItem;
use crate::git::sync::{SyncMode, sync_with};

const SCHEMA: &str = "tasks/schema.yaml";

/// The schema Svode writes: the `unique_id` column with `prefix` and `next`.
fn schema(next: u64) -> String {
    format!("columns:\n- name: Key\n  type: unique_id\n  prefix: T\n  next: {next}\nviews: []\n")
}

fn item(title: &str, key: u64) -> String {
    format!("---\ntitle: {title}\nKey: {key}\n---\n")
}

fn renumbered(path: &str, title: &str, from: u64, to: u64) -> RenumberedItem {
    RenumberedItem {
        path: path.into(),
        title: title.into(),
        collection: "Tasks".into(),
        from: format!("T-{from}"),
        to: format!("T-{to}"),
    }
}

impl Fixture {
    /// Both clones hold the Collection `tasks` with the items `T-1` and
    /// `T-2` and `next: 3`.
    fn tasks(self) -> Self {
        self.commit(
            &self.local,
            &[
                (SCHEMA, &schema(3)),
                ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
                ("tasks/one.md", &item("One", 1)),
                ("tasks/two.md", &item("Two", 2)),
            ],
        );
        self.git(&self.local, &["push", "-q", "origin", "main"]);
        self.git(
            &self.other,
            &["pull", "-q", "--no-rebase", "origin", "main"],
        );
        self
    }

    fn sync_result(result: &SyncResult) -> (&[String], &[RenumberedItem]) {
        match result {
            SyncResult::Success {
                merged, renumbered, ..
            } => (merged, renumbered),
            other => panic!("{other:?}"),
        }
    }

    /// The pairs of a repeated number in `tasks` of `repo` (DF-237 R4).
    fn repeats(&self, repo: &Path) -> Vec<(u64, Vec<String>)> {
        UniqueIdNumbers::read(repo.to_str().unwrap(), "tasks")
            .unwrap()
            .unwrap()
            .duplicate_groups()
            .into_iter()
            .map(|(number, holders)| {
                let paths = holders.iter().map(|holder| holder.path.clone()).collect();
                (number, paths)
            })
            .collect()
    }
}

#[tokio::test]
async fn equal_counts_merge_silently_and_the_local_item_is_renumbered_in_the_merge_commit() {
    let f = Fixture::new().tasks();
    // Both devices created one item from `next: 3`: Git merges the equal
    // `next` and both items hold 3.
    let incoming = f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    let local = f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    let (merged, items) = Fixture::sync_result(&result);
    assert!(merged.is_empty(), "{merged:?}");
    assert_eq!(
        items,
        [renumbered("tasks/from-local.md", "From local", 3, 4)]
    );
    // The published item keeps its number, the local one takes the next.
    assert_eq!(
        f.read(&f.local, "tasks/from-other.md"),
        item("From other", 3)
    );
    assert_eq!(
        f.read(&f.local, "tasks/from-local.md"),
        item("From local", 4)
    );
    assert_eq!(f.read(&f.local, SCHEMA), schema(5));
    assert!(f.repeats(&f.local).is_empty());
    // One merge commit holds the renumbering, and it is what was published.
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(f.git(&f.local, &["rev-parse", "HEAD^1"]), local);
    assert_eq!(f.git(&f.local, &["rev-parse", "HEAD^2"]), incoming);
    assert_eq!(
        f.git(&f.local, &["show", "HEAD:tasks/from-local.md"]),
        item("From local", 4).trim_end()
    );
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}

#[tokio::test]
async fn different_counts_merge_the_schema_and_renumber_the_local_item() {
    let f = Fixture::new().tasks();
    // The colleague created two items, this device one: `next` conflicts and
    // the first numbers repeat.
    f.incoming(&[
        (SCHEMA, &schema(5)),
        ("tasks/from-other-a.md", &item("From other A", 3)),
        ("tasks/from-other-b.md", &item("From other B", 4)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    let (merged, items) = Fixture::sync_result(&result);
    assert_eq!(merged, [SCHEMA]);
    assert_eq!(
        items,
        [renumbered("tasks/from-local.md", "From local", 3, 5)]
    );
    assert_eq!(
        f.read(&f.local, "tasks/from-other-a.md"),
        item("From other A", 3)
    );
    assert_eq!(f.read(&f.local, SCHEMA), schema(6));
    assert!(f.repeats(&f.local).is_empty());
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(
        f.git(&f.remote, &["show", "main:tasks/from-local.md"]),
        item("From local", 5).trim_end()
    );
}

#[tokio::test]
async fn background_sync_renumbers_in_the_merge_commit() {
    let f = Fixture::new().tasks();
    f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );
    // The in-memory preflight needs the release of Git (2.38 or newer).
    assert!(f.cli.refresh_version().await.is_some());

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    let (_, items) = Fixture::sync_result(&result);
    assert_eq!(
        items,
        [renumbered("tasks/from-local.md", "From local", 3, 4)]
    );
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(
        f.git(&f.remote, &["show", "main:tasks/from-local.md"]),
        item("From local", 4).trim_end()
    );
    assert_eq!(
        f.git(&f.remote, &["show", "main:tasks/schema.yaml"]),
        schema(5).trim_end()
    );
}

#[tokio::test]
async fn a_fast_forward_renumbers_an_uncommitted_item_in_the_working_copy() {
    let f = Fixture::new().tasks();
    let incoming = f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    // This device created an item without committing it.
    f.write(&f.local, SCHEMA, &schema(4));
    f.write(&f.local, "tasks/from-local.md", &item("From local", 3));

    let result = sync(&f.cli, &f.local).await.unwrap();

    let (_, items) = Fixture::sync_result(&result);
    assert_eq!(
        items,
        [renumbered("tasks/from-local.md", "From local", 3, 4)]
    );
    assert_eq!(f.head(&f.local), incoming);
    assert_eq!(
        f.read(&f.local, "tasks/from-local.md"),
        item("From local", 4)
    );
    assert_eq!(f.read(&f.local, SCHEMA), schema(5));
    // The renumbering waits in the working copy for a commit of content.
    assert_eq!(
        f.git(&f.local, &["status", "--porcelain"]),
        " M tasks/schema.yaml\n?? tasks/from-local.md"
    );
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), incoming);
}

#[tokio::test]
async fn a_committed_item_with_other_edits_is_renumbered_in_the_merge_commit_only_by_its_number() {
    let f = Fixture::new().tasks();
    f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );
    // An edit of the body that is not committed yet.
    let edited = |key: u64| format!("{}Draft\n", item("From local", key));
    f.write(&f.local, "tasks/from-local.md", &edited(3));

    let result = sync(&f.cli, &f.local).await.unwrap();

    let (_, items) = Fixture::sync_result(&result);
    assert_eq!(
        items,
        [renumbered("tasks/from-local.md", "From local", 3, 4)]
    );
    assert_eq!(
        f.git(&f.remote, &["show", "main:tasks/from-local.md"]),
        item("From local", 4).trim_end()
    );
    assert_eq!(f.read(&f.local, "tasks/from-local.md"), edited(4));
    assert_eq!(
        f.git(&f.local, &["status", "--porcelain"]),
        " M tasks/from-local.md"
    );
}

#[tokio::test]
async fn a_merge_stopped_for_the_person_is_renumbered_before_it_is_handed_over() {
    let f = Fixture::new().tasks();
    // The colleague created an item and edited the text of `two.md`.
    f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other.md", &item("From other", 3)),
        ("tasks/two.md", &format!("{}Theirs\n", item("Two", 2))),
        ("page.md", "theirs\n"),
    ]);
    // This device created an item, edited the same text and, in the
    // terminal, gave `two.md` the number 3 too.
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
            ("tasks/two.md", &format!("{}Mine\n", item("Two", 3))),
            ("page.md", "mine\n"),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            renumbered: items,
            ..
        } => {
            assert_eq!(files, &["page.md", "tasks/two.md"]);
            assert_eq!(
                items,
                &[renumbered("tasks/from-local.md", "From local", 3, 4)]
            );
        }
        other => panic!("{other:?}"),
    }
    // The renumbering is staged for the merge commit; the item in conflict
    // keeps its number and shows as a repeat.
    assert_eq!(
        f.git(&f.local, &["show", ":tasks/from-local.md"]),
        item("From local", 4).trim_end()
    );
    assert_eq!(
        f.git(&f.local, &["show", ":tasks/schema.yaml"]),
        schema(5).trim_end()
    );
    assert_eq!(f.unmerged(&f.local), ["page.md", "tasks/two.md"]);
    assert_eq!(
        f.repeats(&f.local),
        [(
            3,
            vec!["tasks/from-other.md".to_owned(), "tasks/two.md".to_owned()]
        )]
    );
}

#[tokio::test]
async fn a_number_published_at_two_items_stays_as_it_is() {
    let f = Fixture::new().tasks();
    // The upstream already holds 3 twice.
    f.incoming(&[
        (SCHEMA, &schema(4)),
        ("tasks/from-other-a.md", &item("From other A", 3)),
        ("tasks/from-other-b.md", &item("From other B", 3)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema(4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    let (_, items) = Fixture::sync_result(&result);
    assert!(items.is_empty(), "{items:?}");
    assert_eq!(
        f.read(&f.local, "tasks/from-local.md"),
        item("From local", 3)
    );
    assert_eq!(f.read(&f.local, SCHEMA), schema(4));
    assert_eq!(f.repeats(&f.local).len(), 1);
}

#[test]
fn the_sync_result_names_the_renumbered_items_for_the_desktop() {
    let result = SyncResult::Success {
        published_head: "abc".into(),
        merged: Vec::new(),
        renumbered: vec![renumbered("tasks/from-local.md", "From local", 3, 4)],
    };

    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        serde_json::json!({
            "type": "success",
            "publishedHead": "abc",
            "renumbered": [{
                "path": "tasks/from-local.md",
                "title": "From local",
                "collection": "Tasks",
                "from": "T-3",
                "to": "T-4",
            }],
        })
    );
}
