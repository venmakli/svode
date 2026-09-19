use sqlx::{Executor, Sqlite};

use super::IndexError;
use super::model::IndexedEntry;

pub async fn upsert_entry<'e, E>(executor: E, entry: &IndexedEntry) -> Result<(), IndexError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO entries (
            file_path, parent_path, title, icon, description, cover, created, updated,
            collection_root_path, in_collection, is_entry_head, fields, body_preview,
            is_discoverable
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
            parent_path = excluded.parent_path,
            title = excluded.title,
            icon = excluded.icon,
            description = excluded.description,
            cover = excluded.cover,
            created = excluded.created,
            updated = excluded.updated,
            collection_root_path = excluded.collection_root_path,
            in_collection = excluded.in_collection,
            is_entry_head = excluded.is_entry_head,
            fields = excluded.fields,
            body_preview = excluded.body_preview,
            is_discoverable = excluded.is_discoverable
        "#,
    )
    .bind(&entry.rel_path)
    .bind(&entry.parent_path)
    .bind(&entry.title)
    .bind(&entry.icon)
    .bind(&entry.description)
    .bind(&entry.cover_json)
    .bind(&entry.created)
    .bind(&entry.updated)
    .bind(&entry.collection_root_path)
    .bind(if entry.in_collection { 1_i64 } else { 0_i64 })
    .bind(if entry.is_entry_head { 1_i64 } else { 0_i64 })
    .bind(&entry.fields_json)
    .bind(&entry.body_preview)
    .bind(if entry.is_discoverable { 1_i64 } else { 0_i64 })
    .execute(executor)
    .await?;
    Ok(())
}
