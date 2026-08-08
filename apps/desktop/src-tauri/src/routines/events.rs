use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, Sqlite, Transaction};

use super::model::{
    CollectionEvent, CollectionEventOrigin, EventMatch, RoutineRow, RoutineTrigger,
};
use crate::error::AppError;
use crate::index::reindex::IndexedEntry;
use crate::properties::CollectionSchema;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexedEntrySnapshot {
    pub repository_path: String,
    pub collection_path: String,
    pub entry_path: String,
    pub title: String,
    pub fields: BTreeMap<String, Value>,
    pub created: String,
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionEventPayload {
    pub repository_path: String,
    pub collection_path: String,
    pub entry_path: String,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_entry: Option<IndexedEntrySnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_entry: Option<IndexedEntrySnapshot>,
    pub observed_at: String,
    pub source_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routine_run_id: Option<String>,
    #[serde(default)]
    pub lineage_depth: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_run_id: Option<String>,
}

pub(crate) async fn read_indexed_snapshot(
    transaction: &mut Transaction<'_, Sqlite>,
    repository_path: &Path,
    entry_path: &str,
) -> Result<Option<IndexedEntrySnapshot>, AppError> {
    let row = sqlx::query(
        "SELECT file_path, title, collection_root_path, fields, created, updated \
         FROM entries WHERE file_path = ? AND in_collection = 1 AND is_entry_head = 1",
    )
    .bind(entry_path)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|row| snapshot_from_row(row, repository_path))
        .transpose()
}

pub(crate) fn snapshot_from_entry(
    repository_path: &Path,
    entry: &IndexedEntry,
) -> Result<Option<IndexedEntrySnapshot>, AppError> {
    let Some(collection_path) = entry.collection_root_path.as_deref() else {
        return Ok(None);
    };
    Ok(Some(IndexedEntrySnapshot {
        repository_path: repository_path.to_string_lossy().to_string(),
        collection_path: collection_path.to_string(),
        entry_path: entry.rel_path.clone(),
        title: entry.title.clone(),
        fields: parse_fields(&entry.fields_json)?,
        created: entry.created.clone(),
        updated: entry.updated.clone(),
    }))
}

fn snapshot_from_row(
    row: sqlx::sqlite::SqliteRow,
    repository_path: &Path,
) -> Result<IndexedEntrySnapshot, AppError> {
    let fields_json: String = row.try_get("fields")?;
    Ok(IndexedEntrySnapshot {
        repository_path: repository_path.to_string_lossy().to_string(),
        collection_path: row.try_get("collection_root_path")?,
        entry_path: row.try_get("file_path")?,
        title: row.try_get("title")?,
        fields: parse_fields(&fields_json)?,
        created: row.try_get("created")?,
        updated: row.try_get("updated")?,
    })
}

fn parse_fields(raw: &str) -> Result<BTreeMap<String, Value>, AppError> {
    serde_json::from_str(raw).map_err(AppError::from)
}

pub(crate) async fn queue_collection_events(
    transaction: &mut Transaction<'_, Sqlite>,
    space_dir: &Path,
    previous: Option<&IndexedEntrySnapshot>,
    current: Option<&IndexedEntrySnapshot>,
    current_frontmatter_diff_safe: bool,
    origin: &CollectionEventOrigin,
) -> Result<usize, AppError> {
    let collection_path = current
        .map(|entry| entry.collection_path.as_str())
        .or_else(|| previous.map(|entry| entry.collection_path.as_str()));
    let Some(collection_path) = collection_path else {
        return Ok(0);
    };
    if previous.is_some_and(|entry| entry.collection_path != collection_path)
        || current.is_some_and(|entry| entry.collection_path != collection_path)
    {
        return Ok(0);
    }

    let schema_path = if collection_path == "." {
        space_dir.join("schema.yaml")
    } else {
        space_dir.join(collection_path).join("schema.yaml")
    };
    let schema_raw = match fs::read_to_string(&schema_path) {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!(
                "collection event skipped; cannot read {}: {error}",
                schema_path.display()
            );
            return Ok(0);
        }
    };
    let schema: CollectionSchema = match serde_yml::from_str(&schema_raw) {
        Ok(schema) => schema,
        Err(error) => {
            tracing::warn!(
                "collection event skipped; malformed schema {}: {error}",
                schema_path.display()
            );
            return Ok(0);
        }
    };

    let changes = derive_changes(previous, current, current_frontmatter_diff_safe, &schema);
    if changes.is_empty() {
        return Ok(0);
    }

    let routines = event_routines(transaction, collection_path).await?;
    let parent = parent_execution(transaction, origin.routine_run_id.as_deref()).await?;
    if parent.as_ref().is_some_and(|(_, depth)| *depth >= 3) {
        return Ok(0);
    }
    let lineage_depth = parent.as_ref().map_or(0, |(_, depth)| depth + 1);
    let observed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut inserted = 0;
    for change in &changes {
        for routine in &routines {
            if !routine.diagnostics.is_empty() {
                continue;
            }
            let Some(definition) = routine.definition.as_ref() else {
                continue;
            };
            let RoutineTrigger::Event { event, match_ } = &definition.trigger else {
                continue;
            };
            if definition.enabled != Some(true) || !change.matches(*event, match_.as_ref()) {
                continue;
            }
            let entry = current.or(previous).expect("change always has an entry");
            if !lineage_allows(parent.as_ref(), &routine.routine_id) {
                continue;
            }
            let already_active: bool = sqlx::query_scalar(
                r#"SELECT EXISTS(
                     SELECT 1 FROM routine_event_queue queued
                     WHERE queued.owner_path = ? AND queued.routine_id = ?
                       AND queued.entry_path = ? AND queued.state = 'active'
                     UNION ALL
                     SELECT 1
                     FROM routine_runs run
                     JOIN routine_event_queue source
                       ON json_extract(source.payload_json, '$.executionRunId') = run.routine_run_id
                     WHERE run.owner_path = ? AND run.routine_id = ?
                       AND source.entry_path = ? AND run.trigger_type = 'event'
                       AND run.pty_id IS NOT NULL
                       AND run.terminal_status IS NULL
                       AND (run.session_status IS NULL OR run.session_status IN ('active', 'unknown'))
                   )"#,
            )
            .bind(collection_path)
            .bind(&routine.routine_id)
            .bind(&entry.entry_path)
            .bind(collection_path)
            .bind(&routine.routine_id)
            .bind(&entry.entry_path)
            .fetch_one(&mut **transaction)
            .await?;
            if already_active {
                continue;
            }
            let event_key = stable_key(&change.key_material(previous, current));
            let queue_key = stable_key(&format!(
                "event-queue\0{}\0{}\0{}\0{}",
                collection_path, routine.routine_id, routine.fingerprint, event_key
            ));
            let payload = CollectionEventPayload {
                repository_path: entry.repository_path.clone(),
                collection_path: collection_path.to_string(),
                entry_path: entry.entry_path.clone(),
                event_type: change.event.as_str().to_string(),
                property_key: change.property_key.clone(),
                old_value: change.old_value.clone(),
                new_value: change.new_value.clone(),
                old_entry: previous.cloned(),
                new_entry: current.cloned(),
                observed_at: observed_at.clone(),
                source_kind: origin.source_kind.as_str().to_string(),
                origin: origin.origin.clone(),
                routine_run_id: origin.routine_run_id.clone(),
                lineage_depth,
                execution_run_id: None,
            };
            let result = sqlx::query(
                r#"INSERT OR IGNORE INTO routine_event_queue (
                    queue_key, event_key, owner_path, routine_id, definition_fingerprint,
                    event_type, entry_path, property_key, payload_json, observed_at, state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')"#,
            )
            .bind(&queue_key)
            .bind(&event_key)
            .bind(collection_path)
            .bind(&routine.routine_id)
            .bind(&routine.fingerprint)
            .bind(change.event.as_str())
            .bind(&entry.entry_path)
            .bind(change.property_key.as_deref())
            .bind(serde_json::to_string(&payload)?)
            .bind(&observed_at)
            .execute(&mut **transaction)
            .await?;
            inserted += result.rows_affected() as usize;
        }
    }
    Ok(inserted)
}

fn lineage_allows(parent: Option<&(String, u8)>, routine_id: &str) -> bool {
    parent.is_none_or(|(parent_routine_id, depth)| parent_routine_id != routine_id && *depth < 3)
}

async fn parent_execution(
    transaction: &mut Transaction<'_, Sqlite>,
    routine_run_id: Option<&str>,
) -> Result<Option<(String, u8)>, AppError> {
    let Some(routine_run_id) = routine_run_id else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT routine_id, payload_json FROM routine_event_queue WHERE json_extract(payload_json, '$.executionRunId') = ? ORDER BY observed_at DESC LIMIT 1",
    )
    .bind(routine_run_id)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|row| {
        let payload: CollectionEventPayload =
            serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?;
        Ok((row.try_get("routine_id")?, payload.lineage_depth))
    })
    .transpose()
}

async fn event_routines(
    transaction: &mut Transaction<'_, Sqlite>,
    owner_path: &str,
) -> Result<Vec<RoutineRow>, AppError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT row_json FROM routine_definitions WHERE owner_path = ? ORDER BY routine_id",
    )
    .bind(owner_path)
    .fetch_all(&mut **transaction)
    .await?;
    rows.into_iter()
        .filter_map(|raw| match serde_json::from_str(&raw) {
            Ok(row) => Some(Ok(row)),
            Err(error) => {
                tracing::warn!("invalid cached routine row for {owner_path}: {error}");
                None
            }
        })
        .collect()
}

#[derive(Debug)]
struct EntryChange {
    event: CollectionEvent,
    property_key: Option<String>,
    old_value: Option<Value>,
    new_value: Option<Value>,
}

impl EntryChange {
    fn matches(&self, event: CollectionEvent, matcher: Option<&EventMatch>) -> bool {
        if self.event != event {
            return false;
        }
        match event {
            CollectionEvent::FieldChanged => matcher.is_some_and(|matcher| {
                self.property_key.as_deref() == Some(matcher.field.as_str())
                    && matcher
                        .from
                        .as_ref()
                        .is_none_or(|value| self.old_value.as_ref() == Some(value))
                    && matcher
                        .to
                        .as_ref()
                        .is_none_or(|value| self.new_value.as_ref() == Some(value))
            }),
            _ => matcher.is_none(),
        }
    }

    fn key_material(
        &self,
        previous: Option<&IndexedEntrySnapshot>,
        current: Option<&IndexedEntrySnapshot>,
    ) -> String {
        let entry = current.or(previous).expect("change always has an entry");
        let material = match self.event {
            CollectionEvent::FieldChanged => serde_json::json!({
                "eventType": self.event.as_str(),
                "collectionPath": entry.collection_path,
                "entryPath": entry.entry_path,
                "propertyKey": self.property_key,
                "oldValue": self.old_value,
                "newValue": self.new_value,
            }),
            CollectionEvent::EntryCreated => serde_json::json!({
                "eventType": self.event.as_str(),
                "entry": current.map(portable_snapshot_key),
            }),
            CollectionEvent::EntryDeleted => serde_json::json!({
                "eventType": self.event.as_str(),
                "entry": previous.map(portable_snapshot_key),
            }),
        };
        serde_json::to_string(&material).expect("event key material is serializable")
    }
}

fn portable_snapshot_key(entry: &IndexedEntrySnapshot) -> Value {
    serde_json::json!({
        "collectionPath": entry.collection_path,
        "entryPath": entry.entry_path,
        "title": entry.title,
        "fields": entry.fields,
    })
}

fn derive_changes(
    previous: Option<&IndexedEntrySnapshot>,
    current: Option<&IndexedEntrySnapshot>,
    current_frontmatter_diff_safe: bool,
    schema: &CollectionSchema,
) -> Vec<EntryChange> {
    match (previous, current) {
        (None, Some(_)) if current_frontmatter_diff_safe => vec![EntryChange {
            event: CollectionEvent::EntryCreated,
            property_key: None,
            old_value: None,
            new_value: None,
        }],
        (Some(_), None) => vec![EntryChange {
            event: CollectionEvent::EntryDeleted,
            property_key: None,
            old_value: None,
            new_value: None,
        }],
        (Some(old), Some(new)) if current_frontmatter_diff_safe => {
            let keys = schema
                .columns
                .iter()
                .map(|column| column.name.clone())
                .collect::<BTreeSet<String>>();
            keys.into_iter()
                .filter_map(|key| {
                    let old_value = old.fields.get(&key).cloned().unwrap_or(Value::Null);
                    let new_value = new.fields.get(&key).cloned().unwrap_or(Value::Null);
                    (old_value != new_value).then(|| EntryChange {
                        event: CollectionEvent::FieldChanged,
                        property_key: Some(key),
                        old_value: Some(old_value),
                        new_value: Some(new_value),
                    })
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

fn stable_key(material: &str) -> String {
    fn fnv(bytes: &[u8], seed: u64) -> u64 {
        bytes.iter().fold(seed, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
    }
    format!(
        "{:016x}{:016x}",
        fnv(material.as_bytes(), 0xcbf29ce484222325),
        fnv(material.as_bytes(), 0x84222325cbf29ce4)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(repository_path: &str) -> IndexedEntrySnapshot {
        IndexedEntrySnapshot {
            repository_path: repository_path.to_string(),
            collection_path: "tasks".to_string(),
            entry_path: "tasks/item.md".to_string(),
            title: "Item".to_string(),
            fields: BTreeMap::from([("Status".to_string(), Value::String("Done".to_string()))]),
            created: "2026-08-08T00:00:00Z".to_string(),
            updated: "2026-08-08T00:01:00Z".to_string(),
        }
    }

    #[test]
    fn event_key_material_is_portable_between_clones() {
        let change = EntryChange {
            event: CollectionEvent::FieldChanged,
            property_key: Some("Status".to_string()),
            old_value: Some(Value::String("Open".to_string())),
            new_value: Some(Value::String("Done".to_string())),
        };
        let mut first = snapshot("/clone-one");
        first.fields.insert("Priority".to_string(), Value::from(1));
        let mut second = snapshot("/clone-two");
        second.created = "2026-09-01T00:00:00Z".to_string();
        second.updated = "2026-09-01T00:01:00Z".to_string();
        second.fields.insert("Priority".to_string(), Value::from(2));
        assert_eq!(
            change.key_material(Some(&first), None),
            change.key_material(Some(&second), None)
        );
    }

    #[test]
    fn lineage_suppresses_self_and_stops_after_depth_three() {
        assert!(!lineage_allows(Some(&("routine-a".into(), 0)), "routine-a"));
        assert!(lineage_allows(Some(&("routine-a".into(), 2)), "routine-b"));
        assert!(!lineage_allows(Some(&("routine-a".into(), 3)), "routine-b"));
        assert!(lineage_allows(None, "routine-a"));
    }
}
