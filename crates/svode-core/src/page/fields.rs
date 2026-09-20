use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::collections::CollectionError;
use crate::collections::engine::{EntryFieldBatchIntent, prepare_entry_field_batch};
use crate::page::PageError;
use crate::page::dates::GitDateExecutor;
use crate::page::entry;

use super::write::{PageRuntime, PageWrite, PageWriteOutcome};

/// One item-field batch: literal Desktop/MCP values or a Routine batch whose
/// runtime sentinels are resolved while the plan is prepared.
pub struct PageFieldUpdate<'a> {
    pub space: &'a str,
    pub path: &'a str,
    pub project: Option<&'a str>,
    pub values: &'a BTreeMap<String, Value>,
    pub intent: EntryFieldBatchIntent,
}

pub struct PageFieldOutcome {
    pub page: entry::Entry,
    pub changed_paths: Vec<PathBuf>,
}

/// Prepare the Collection field plan and apply it through the Page write
/// owner: one authorization over the full touched-set, one source apply with
/// rollback and one projection publication.
pub async fn update<E, F, Fut, Err>(
    request: PageFieldUpdate<'_>,
    runtime: PageRuntime<'_, E>,
    authorize: F,
) -> Result<PageFieldOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    let PageFieldUpdate {
        space,
        path,
        project,
        values,
        intent,
    } = request;
    if values.is_empty() {
        return Err(Err::from(PageError::from(CollectionError::Schema(
            "property batch cannot be empty".to_string(),
        ))));
    }
    let batch =
        prepare_entry_field_batch(space, project, path, values, intent).map_err(PageError::from)?;
    let has_title = batch.title().is_some();
    let current = entry::read(space, path)?;
    let PageWriteOutcome {
        result,
        changed_paths,
    } = super::write::write(
        PageWrite {
            space,
            path,
            content: &current.body,
            title: None,
            icon: None,
            extra: None,
            metadata: None,
            field_batch: Some(batch),
            skip_rename: !has_title,
            project,
        },
        runtime,
        authorize,
    )
    .await?;
    let current_path = result.new_path.as_deref().unwrap_or(path);
    let mut page = entry::read(space, current_path)?;
    page.warnings = result.warnings;
    Ok(PageFieldOutcome {
        page,
        changed_paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::state::IndexRuntimeState;
    use crate::page::nonce::WriteNonceRegistry;
    use crate::page::test_support::runtime;
    use std::fs;
    use std::path::Path;

    async fn update_fields(
        root: &Path,
        path: &str,
        values: BTreeMap<String, Value>,
        intent: EntryFieldBatchIntent,
    ) -> Result<PageFieldOutcome, PageError> {
        update(
            PageFieldUpdate {
                space: root.to_str().unwrap(),
                path,
                project: None,
                values: &values,
                intent,
            },
            runtime(&IndexRuntimeState::default(), &WriteNonceRegistry::new()),
            |mut paths| async move {
                paths.push(root.to_path_buf());
                Ok(paths)
            },
        )
        .await
    }

    async fn save_fields(
        root: &Path,
        path: &str,
        values: BTreeMap<String, Value>,
    ) -> Result<PageFieldOutcome, PageError> {
        update_fields(root, path, values, EntryFieldBatchIntent::Literal).await
    }

    #[tokio::test]
    async fn field_batch_renames_before_final_relation_projection_and_reports_full_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::create_dir_all(root.join("people")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - name: Person\n    type: relation\n    relation: people\n    limit: one\n    two_way: Tasks\n  - { name: note, type: text }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            root.join("people/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: Person\nviews: []\n",
        )
        .unwrap();
        fs::write(
            root.join("tasks/Old.md"),
            "---\ntitle: Old\nnote: before\nobsolete: remove me\n---\nBody\n",
        )
        .unwrap();
        fs::write(root.join("people/Ada.md"), "---\ntitle: Ada\n---\nPerson\n").unwrap();

        let outcome = save_fields(
            root,
            "tasks/Old.md",
            BTreeMap::from([
                ("Person".into(), Value::String("Ada.md".into())),
                ("note".into(), Value::String("{{date}}".into())),
                ("description".into(), Value::String("  ".into())),
                ("id".into(), Value::String("external-id".into())),
                ("obsolete".into(), Value::Null),
                ("unknown".into(), Value::String("kept".into())),
                ("title".into(), Value::String("New".into())),
            ]),
        )
        .await
        .unwrap();

        assert_eq!(outcome.page.path, "tasks/New.md");
        let item = entry::read(root.to_str().unwrap(), "tasks/New.md").unwrap();
        assert_eq!(
            item.meta
                .extra
                .get("note")
                .and_then(serde_yml::Value::as_str),
            Some("{{date}}")
        );
        assert_eq!(item.meta.description.as_deref(), Some("  "));
        assert_eq!(
            item.meta.extra.get("id").and_then(serde_yml::Value::as_str),
            Some("external-id")
        );
        assert!(!item.meta.extra.contains_key("obsolete"));
        assert_eq!(
            item.meta
                .extra
                .get("unknown")
                .and_then(serde_yml::Value::as_str),
            Some("kept")
        );
        let person = entry::read(root.to_str().unwrap(), "people/Ada.md").unwrap();
        assert_eq!(
            person
                .meta
                .extra
                .get("Tasks")
                .and_then(serde_yml::Value::as_sequence)
                .and_then(|values| values.first())
                .and_then(serde_yml::Value::as_str),
            Some("New.md")
        );
        for expected in [
            root.join("tasks/Old.md"),
            root.join("tasks/New.md"),
            root.join("people/Ada.md"),
        ] {
            assert!(outcome.changed_paths.contains(&expected), "{expected:?}");
        }
    }

    #[tokio::test]
    async fn field_batch_rejects_read_only_fields_before_valid_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - { name: uid, type: unique_id, prefix: TASK, next: 2 }\n  - { name: note, type: text }\nviews: []\n",
        )
        .unwrap();
        let source = "---\ntitle: Old\nuid: TASK-1\nnote: before\n---\nBody\n";
        fs::write(root.join("tasks/Old.md"), source).unwrap();

        for read_only in ["created", "updated", "uid"] {
            let result = save_fields(
                root,
                "tasks/Old.md",
                BTreeMap::from([
                    ("note".into(), Value::String("after".into())),
                    (read_only.into(), Value::Null),
                ]),
            )
            .await;
            assert!(result.is_err(), "{read_only}");
            assert_eq!(
                fs::read_to_string(root.join("tasks/Old.md")).unwrap(),
                source,
                "{read_only}"
            );
        }
    }

    #[tokio::test]
    async fn field_batch_prevalidates_all_values_before_title_or_custom_write() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - { name: count, type: number }\nviews: []\n",
        )
        .unwrap();
        let source = "---\ntitle: Old\ncount: 1\n---\nBody\n";
        fs::write(root.join("tasks/Old.md"), source).unwrap();

        let result = save_fields(
            root,
            "tasks/Old.md",
            BTreeMap::from([
                ("description".into(), Value::String("x".repeat(501))),
                ("count".into(), Value::Number(2.into())),
                ("title".into(), Value::String("New".into())),
            ]),
        )
        .await;
        let error = result.err().expect("invalid batch must fail");

        assert!(error.to_string().contains("description"));
        assert_eq!(
            fs::read_to_string(root.join("tasks/Old.md")).unwrap(),
            source
        );
        assert!(!root.join("tasks/New.md").exists());
    }

    #[tokio::test]
    async fn empty_batch_is_rejected_before_any_plan() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(root.join("tasks/item.md"), "---\ntitle: Item\n---\nBody\n").unwrap();

        let error = save_fields(root, "tasks/item.md", BTreeMap::new())
            .await
            .err()
            .expect("empty batch must fail");

        assert!(
            error.to_string().contains("property batch cannot be empty"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn routine_property_batch_applies_multiple_values_null_and_date_sentinel() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - { name: completed_at, type: date }\n  - { name: note, type: text }\n  - { name: reviewed, type: boolean }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            root.join("tasks/item.md"),
            "---\ntitle: Item\nnote: old\nreviewed: false\n---\nBody\n",
        )
        .unwrap();

        let outcome = update_fields(
            root,
            "tasks/item.md",
            BTreeMap::from([
                ("completed_at".into(), Value::String("{{date}}".into())),
                ("note".into(), Value::Null),
                ("reviewed".into(), Value::Bool(true)),
            ]),
            EntryFieldBatchIntent::Routine,
        )
        .await
        .unwrap();

        let updated = outcome.page;
        let completed_at = updated
            .meta
            .extra
            .get("completed_at")
            .and_then(serde_yml::Value::as_str)
            .unwrap();
        assert_eq!(completed_at.len(), 10);
        assert_eq!(completed_at.as_bytes()[4], b'-');
        assert_eq!(completed_at.as_bytes()[7], b'-');
        assert!(!updated.meta.extra.contains_key("note"));
        assert_eq!(
            updated.meta.extra.get("reviewed"),
            Some(&serde_yml::Value::Bool(true))
        );
        assert_eq!(updated.body, "Body\n");
    }

    #[tokio::test]
    async fn routine_property_batch_rejects_system_fields_and_keeps_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - { name: note, type: text }\nviews: []\n",
        )
        .unwrap();
        let source = "---\ntitle: Item\nnote: old\n---\nBody\n";
        fs::write(root.join("tasks/item.md"), source).unwrap();

        let error = update_fields(
            root,
            "tasks/item.md",
            BTreeMap::from([
                ("note".into(), Value::String("after".into())),
                ("title".into(), Value::String("Renamed".into())),
            ]),
            EntryFieldBatchIntent::Routine,
        )
        .await
        .err()
        .expect("system field must be rejected");

        assert!(
            error.to_string().contains("system field 'title'"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(root.join("tasks/item.md")).unwrap(),
            source
        );
    }

    #[tokio::test]
    async fn routine_property_batch_rolls_back_source_and_reverse_relation_on_late_failure() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::create_dir_all(root.join("people")).unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "columns:\n  - name: A_Link\n    type: relation\n    relation: people\n    limit: one\n    two_way: Tasks\n  - { name: Z_Count, type: number }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            root.join("people/schema.yaml"),
            "columns:\n  - name: Tasks\n    type: relation\n    relation: tasks\n    two_way: A_Link\nviews: []\n",
        )
        .unwrap();
        let source_path = root.join("tasks/item.md");
        let target_path = root.join("people/person.md");
        fs::write(&source_path, "---\ntitle: Item\nZ_Count: 1\n---\nTask\n").unwrap();
        fs::write(&target_path, "---\ntitle: Person\n---\nPerson\n").unwrap();
        let source_before = fs::read(&source_path).unwrap();
        let target_before = fs::read(&target_path).unwrap();

        let error = update_fields(
            root,
            "tasks/item.md",
            BTreeMap::from([
                ("A_Link".into(), Value::String("person.md".into())),
                ("Z_Count".into(), Value::String("not-a-number".into())),
            ]),
            EntryFieldBatchIntent::Routine,
        )
        .await
        .err()
        .expect("invalid value must fail");

        assert!(error.to_string().contains("Z_Count"));
        assert_eq!(fs::read(&source_path).unwrap(), source_before);
        assert_eq!(fs::read(&target_path).unwrap(), target_before);
    }
}
