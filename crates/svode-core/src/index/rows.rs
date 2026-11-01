use sqlx::{Executor, Sqlite};

use super::IndexError;
use super::model::IndexedPage;

pub async fn upsert_page<'e, E>(executor: E, page: &IndexedPage) -> Result<(), IndexError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO pages (
            file_path, parent_path, title, icon, description, cover, created, updated,
            collection_root_path, in_collection, is_item_head, fields, folded_text,
            body_preview, is_discoverable
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            is_item_head = excluded.is_item_head,
            fields = excluded.fields,
            folded_text = excluded.folded_text,
            body_preview = excluded.body_preview,
            is_discoverable = excluded.is_discoverable
        "#,
    )
    .bind(&page.rel_path)
    .bind(&page.parent_path)
    .bind(&page.title)
    .bind(&page.icon)
    .bind(&page.description)
    .bind(&page.cover_json)
    .bind(&page.created)
    .bind(&page.updated)
    .bind(&page.collection_root_path)
    .bind(if page.in_collection { 1_i64 } else { 0_i64 })
    .bind(if page.is_item_head { 1_i64 } else { 0_i64 })
    .bind(&page.fields_json)
    .bind(&page.folded_text_json)
    .bind(&page.body_preview)
    .bind(if page.is_discoverable { 1_i64 } else { 0_i64 })
    .execute(executor)
    .await?;
    Ok(())
}
