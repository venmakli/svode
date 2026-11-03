//! `next` of the `unique_id` column in a Collection `schema.yaml`, merged by
//! the rule of Collections (DF-237 R2) in each caller of the rule set.

use super::*;
use crate::git::merge_preflight::{self, Preflight};

const SCHEMA: &str = "tasks/schema.yaml";

/// The schema Svode writes: a text column, the `unique_id` column with
/// `prefix` and `next`, no views.
fn schema(note: &str, prefix: &str, next: u64) -> String {
    format!(
        "columns:\n- name: {note}\n  type: text\n- name: Key\n  type: unique_id\n  prefix: {prefix}\n  next: {next}\nviews: []\n"
    )
}

fn item(title: &str, key: u64) -> String {
    format!("---\ntitle: {title}\nKey: {key}\n---\n")
}

impl Fixture {
    /// Both clones hold the Collection `tasks` with `schema` and the items
    /// `T-1` and `T-2`.
    fn with_tasks(self, schema: &str) -> Self {
        self.commit(
            &self.local,
            &[
                (SCHEMA, schema),
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
}

#[tokio::test]
async fn next_raised_differently_by_both_sides_merges_to_the_larger_one() {
    let f = Fixture::new().with_tasks(&schema("Заметка", "T", 3));
    // The colleague created two items, this device one with the same first number.
    let incoming = f.incoming(&[
        (SCHEMA, &schema("Заметка", "T", 5)),
        ("tasks/from-other-a.md", &item("From other A", 3)),
        ("tasks/from-other-b.md", &item("From other B", 4)),
    ]);
    // This device also renamed the text column: a place only it changed.
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema("Заметки", "T", 4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );
    f.git(&f.local, &["fetch", "-q"]);
    // The in-memory preflight needs the release of Git (2.38 or newer).
    assert!(f.cli.refresh_version().await.is_some());
    let checked = merge_preflight::check(&f.cli, &f.local, &incoming)
        .await
        .unwrap();
    assert_eq!(checked.outcome, Preflight::ServiceOnly);

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[SCHEMA]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, SCHEMA), schema("Заметки", "T", 5));
    assert_eq!(f.git(&f.local, &["status", "--porcelain"]), "");
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}

#[tokio::test]
async fn next_raised_equally_by_both_sides_merges_without_a_conflict() {
    let f = Fixture::new().with_tasks(&schema("Заметка", "T", 3));
    f.incoming(&[
        (SCHEMA, &schema("Заметка", "T", 4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &schema("Заметка", "T", 4)),
            ("tasks/from-local.md", &item("From local", 3)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert!(merged.is_empty(), "{merged:?}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, SCHEMA), schema("Заметка", "T", 4));
}

#[tokio::test]
async fn next_below_the_largest_number_of_the_result_rises_above_it() {
    let flow = |next: u64| {
        format!(
            "columns:\n  - {{ name: Key, type: unique_id, prefix: T, next: {next} }}\nviews: []\n"
        )
    };
    let f = Fixture::new().with_tasks(&flow(3));
    // A number written in the terminal is above the counter of its side.
    f.incoming(&[
        (SCHEMA, &flow(5)),
        ("tasks/from-other-a.md", &item("From other A", 3)),
        ("tasks/from-other-b.md", &item("From other B", 9)),
    ]);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &flow(4)),
            ("tasks/from-local.md", &item("From local", 3)),
            // An item of a nested Collection holds its own numbers.
            (
                "tasks/sub/schema.yaml",
                "columns:\n- name: Key\n  type: unique_id\n  next: 21\nviews: []\n",
            ),
            ("tasks/sub/nested.md", &item("Nested", 20)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[SCHEMA]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, SCHEMA), flow(10));
}

#[tokio::test]
async fn a_schema_with_another_disputed_place_stays_with_the_person() {
    let f = Fixture::new().with_tasks(&schema("Заметка", "T", 3));
    f.incoming(&[
        (SCHEMA, &schema("Заметка", "O", 4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    let local = schema("Заметка", "L", 5);
    f.commit(
        &f.local,
        &[
            (SCHEMA, &local),
            ("tasks/from-local-a.md", &item("From local A", 3)),
            ("tasks/from-local-b.md", &item("From local B", 4)),
        ],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            merged,
            service,
            ..
        } => {
            assert_eq!(files, &[SCHEMA]);
            assert!(merged.is_empty() && service.is_empty(), "{result:?}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.unmerged(&f.local), [SCHEMA]);
    assert!(f.read(&f.local, SCHEMA).contains("<<<<<<<"));

    // The in-memory preflight leaves it to the person as well.
    f.git(&f.local, &["merge", "--abort"]);
    let incoming = f.git(&f.local, &["rev-parse", "origin/main"]);
    assert!(f.cli.refresh_version().await.is_some());
    match merge_preflight::check(&f.cli, &f.local, &incoming)
        .await
        .unwrap()
        .outcome
    {
        Preflight::Conflicts { files, service } => {
            assert_eq!(files.len(), 1);
            assert!(service.is_empty(), "{service:?}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, SCHEMA), local);
}

#[tokio::test]
async fn a_column_removed_by_one_side_stays_with_the_person() {
    let f = Fixture::new().with_tasks(&schema("Заметка", "T", 3));
    f.incoming(&[
        (SCHEMA, &schema("Заметка", "T", 4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    f.commit(
        &f.local,
        &[(
            SCHEMA,
            "columns:\n- name: Заметка\n  type: text\nviews: []\n",
        )],
    );

    let result = sync(&f.cli, &f.local).await.unwrap();

    match &result {
        SyncResult::Conflict {
            files,
            merged,
            service,
            ..
        } => {
            assert_eq!(files, &[SCHEMA]);
            assert!(merged.is_empty() && service.is_empty(), "{result:?}");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_action_for_a_merge_started_outside_svode_merges_next_by_the_same_rule() {
    let f = Fixture::new().with_tasks(&schema("Заметка", "T", 3));
    f.incoming(&[
        (SCHEMA, &schema("Заметка", "T", 4)),
        ("tasks/from-other.md", &item("From other", 3)),
    ]);
    let local = f.commit(
        &f.local,
        &[
            (SCHEMA, &schema("Заметка", "T", 5)),
            ("tasks/from-local-a.md", &item("From local A", 3)),
            ("tasks/from-local-b.md", &item("From local B", 4)),
        ],
    );
    f.git(&f.local, &["fetch", "-q"]);
    // The terminal merges.
    assert!(!f.run(&f.local, &["merge", "origin/main"]).status.success());
    let index = f.git(&f.local, &["ls-files", "--stage"]);

    let stop = preflight(&f.cli, &f.local).await.unwrap();

    match &stop {
        Some(SyncResult::Conflict { files, service, .. }) => {
            assert_eq!(files, &[SCHEMA]);
            assert_eq!(
                service,
                &[ServiceFile {
                    path: SCHEMA.into(),
                    state: ServiceFileState::Mergeable,
                }]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        f.git(&f.local, &["ls-files", "--stage"]),
        index,
        "Svode does not change the index itself"
    );

    let result = merge_service_files(&f.cli, &f.local, None).await.unwrap();

    match &result {
        SyncResult::Success { merged, .. } => assert_eq!(merged, &[SCHEMA]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.git(&f.local, &["rev-parse", "HEAD^1"]), local);
    assert_eq!(f.read(&f.local, SCHEMA), schema("Заметка", "T", 5));
    assert_eq!(f.git(&f.remote, &["rev-parse", "main"]), f.head(&f.local));
}
