use std::path::Path;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;
use crate::properties::{self, Column, PropertyType};

/// Per-pool query row carrier. Crosses module boundaries internally; the
/// wire-shape returned to the frontend is `SearchItem` (built by
/// `index::commands` after fan-out merge).
///
/// `updated_at` is captured for cross-pool tie-break (FTS round-robin) and
/// is not serialized.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub snippet: Option<String>,
    pub table_name: Option<String>,
    #[serde(skip)]
    pub updated_at: Option<String>,
}

/// Escape `%` and `_` in a LIKE pattern so user input is treated literally.
/// The escape character is `\`, which must be declared via `ESCAPE '\'`.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Build a safe FTS5 MATCH expression from user input.
///
/// Approach: strip double quotes, split on whitespace, quote each token as a
/// phrase, and append `*` to the last token for prefix matching. This avoids
/// accidental use of FTS5 operators (`AND`, `OR`, `NEAR`, `^`, etc.) at the
/// cost of not supporting them explicitly. Good enough for v1 — we can expose
/// a raw mode later if needed.
fn build_fts_query(query: &str) -> String {
    let cleaned: Vec<String> = query
        .replace('"', "")
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    if cleaned.is_empty() {
        return String::new();
    }

    let last = cleaned.len() - 1;
    cleaned
        .iter()
        .enumerate()
        .map(|(i, tok)| {
            if i == last {
                format!("\"{tok}\"*")
            } else {
                format!("\"{tok}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Search entries by title substring (case-insensitive LIKE).
/// Results where the title starts with the query come first, then by
/// `updated_at DESC`.
pub async fn search_by_title(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, AppError> {
    let escaped = escape_like(query);
    let contains_pat = format!("%{escaped}%");
    let prefix_pat = format!("{escaped}%");

    let rows = sqlx::query(
        r#"
        SELECT
            file_path AS id,
            file_path AS path,
            COALESCE(title, '') AS title,
            'page' AS type,
            NULL AS table_name,
            updated AS updated_at
        FROM entries
        WHERE title LIKE ? ESCAPE '\' OR file_path LIKE ? ESCAPE '\'
        ORDER BY
            CASE
                WHEN title LIKE ? ESCAPE '\' THEN 0
                WHEN file_path LIKE ? ESCAPE '\' THEN 1
                ELSE 2
            END,
            updated DESC
        LIMIT ?
        "#,
    )
    .bind(&contains_pat)
    .bind(&contains_pat)
    .bind(&prefix_pat)
    .bind(&prefix_pat)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Index(format!("search_by_title query={query:?} failed: {e}")))?;

    Ok(rows
        .into_iter()
        .map(|r| SearchResult {
            id: r.get::<String, _>("id"),
            path: r.get::<String, _>("path"),
            title: r.get::<String, _>("title"),
            entry_type: r.get::<String, _>("type"),
            snippet: None,
            table_name: r.get::<Option<String>, _>("table_name"),
            updated_at: r.get::<Option<String>, _>("updated_at"),
        })
        .collect())
}

/// Exact lookup for collection `unique_id` display values such as `ISSUE-24`.
///
/// The SQLite index has entry fields, but not schema column config. The command
/// layer passes the source space path so this lookup can read each collection
/// schema and interpret prefix/number semantics correctly.
pub async fn search_unique_id_exact(
    pool: &SqlitePool,
    space_path: &Path,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, AppError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let collections = sqlx::query(
        r#"
        SELECT DISTINCT collection_root_path
        FROM entries
        WHERE in_collection = 1 AND collection_root_path IS NOT NULL
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Index(format!("unique_id collections lookup failed: {e}")))?;

    let mut results = Vec::new();
    for row in collections {
        if results.len() >= limit as usize {
            break;
        }
        let collection_path = row.get::<String, _>("collection_root_path");
        let Ok(schema) =
            properties::read_collection_schema(&space_path.to_string_lossy(), &collection_path)
        else {
            continue;
        };
        let Some(column) = schema
            .columns
            .iter()
            .find(|column| column.type_ == PropertyType::UniqueId)
        else {
            continue;
        };
        let Some(number) = unique_id_query_number(column, trimmed) else {
            continue;
        };
        let remaining = limit - results.len() as i64;
        results
            .extend(unique_id_rows(pool, &collection_path, &column.name, number, remaining).await?);
    }

    Ok(results)
}

fn unique_id_query_number(column: &Column, query: &str) -> Option<u64> {
    if let Some(prefix) = column.prefix.as_deref().filter(|prefix| !prefix.is_empty()) {
        return query
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('-'))
            .and_then(|number| number.parse::<u64>().ok())
            .filter(|number| *number >= 1);
    }
    query.parse::<u64>().ok().filter(|number| *number >= 1)
}

async fn unique_id_rows(
    pool: &SqlitePool,
    collection_path: &str,
    field: &str,
    number: u64,
    limit: i64,
) -> Result<Vec<SearchResult>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT
            file_path AS id,
            file_path AS path,
            COALESCE(title, '') AS title,
            'page' AS type,
            collection_root_path AS table_name,
            updated AS updated_at
        FROM entries
        WHERE in_collection = 1
          AND collection_root_path = ?
          AND CAST(json_extract(fields, ?) AS INTEGER) = ?
        ORDER BY updated DESC
        LIMIT ?
        "#,
    )
    .bind(collection_path)
    .bind(json_path(field))
    .bind(number as i64)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Index(format!("unique_id lookup failed: {e}")))?;

    Ok(rows
        .into_iter()
        .map(|r| SearchResult {
            id: r.get::<String, _>("id"),
            path: r.get::<String, _>("path"),
            title: r.get::<String, _>("title"),
            entry_type: r.get::<String, _>("type"),
            snippet: None,
            table_name: r.get::<Option<String>, _>("table_name"),
            updated_at: r.get::<Option<String>, _>("updated_at"),
        })
        .collect())
}

fn json_path(field: &str) -> String {
    format!("$.\"{}\"", field.replace('"', "\\\""))
}

/// Full-text search via FTS5, with optional filters on `type` and
/// `table_name`. Results are sorted by BM25 relevance.
pub async fn search_fts(
    pool: &SqlitePool,
    query: &str,
    entry_type_filter: Option<&str>,
    table_name_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchResult>, AppError> {
    if entry_type_filter.is_some_and(|t| t != "page") || table_name_filter.is_some() {
        return Ok(Vec::new());
    }

    let fts_query = build_fts_query(query);
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    // We build the WHERE clause dynamically so optional filters can be
    // omitted without padding with NULLs.
    let mut sql = String::from(
        r#"
        SELECT
            e.file_path AS id,
            e.file_path AS path,
            COALESCE(e.title, '') AS title,
            'page' AS type,
            NULL AS table_name,
            e.updated AS updated_at,
            snippet(entries_fts, 2, '<mark>', '</mark>', '...', 32) AS snippet
        FROM entries_fts
        JOIN entries e ON e.rowid = entries_fts.rowid
        WHERE entries_fts MATCH ?
        "#,
    );
    sql.push_str(" ORDER BY bm25(entries_fts) ASC LIMIT ?");

    let mut q = sqlx::query(&sql).bind(fts_query);
    q = q.bind(limit);

    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| {
            AppError::Index(format!(
                "search_fts query={query:?} type={entry_type_filter:?} table={table_name_filter:?} failed: {e}"
            ))
        })?;

    Ok(rows
        .into_iter()
        .map(|r| SearchResult {
            id: r.get::<String, _>("id"),
            path: r.get::<String, _>("path"),
            title: r.get::<String, _>("title"),
            entry_type: r.get::<String, _>("type"),
            snippet: r.get::<Option<String>, _>("snippet"),
            table_name: r.get::<Option<String>, _>("table_name"),
            updated_at: r.get::<Option<String>, _>("updated_at"),
        })
        .collect())
}

/// Recently updated entries.
pub async fn recent(pool: &SqlitePool, limit: i64) -> Result<Vec<SearchResult>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT
            file_path AS id,
            file_path AS path,
            COALESCE(title, '') AS title,
            'page' AS type,
            NULL AS table_name,
            updated AS updated_at
        FROM entries
        ORDER BY updated DESC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Index(format!("recent limit={limit} failed: {e}")))?;

    Ok(rows
        .into_iter()
        .map(|r| SearchResult {
            id: r.get::<String, _>("id"),
            path: r.get::<String, _>("path"),
            title: r.get::<String, _>("title"),
            entry_type: r.get::<String, _>("type"),
            snippet: None,
            table_name: r.get::<Option<String>, _>("table_name"),
            updated_at: r.get::<Option<String>, _>("updated_at"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn unique_id_exact_search_resolves_prefixed_display_value() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        std::fs::create_dir_all(space.join("tasks")).unwrap();
        std::fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: ISSUE, next: 25 }\nviews: []\n",
        )
        .unwrap();

        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO entries (
                file_path, title, updated, collection_root_path, in_collection, fields
            ) VALUES ('tasks/a.md', 'A', '2026-01-01', 'tasks', 1, '{"Key":24}')
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = search_unique_id_exact(&pool, space, "ISSUE-24", 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "tasks/a.md");
    }

    #[tokio::test]
    async fn global_search_does_not_match_collection_field_values() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                body_preview TEXT,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                fields TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                title,
                description,
                body_preview,
                content='entries',
                content_rowid='rowid'
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO entries (
                rowid, file_path, title, description, body_preview,
                updated, collection_root_path, in_collection, fields
            ) VALUES (
                1, 'contacts/ivan.md', 'Customer record', '',
                'Regular note body', '2026-01-01', 'contacts', 1,
                '{"Phone":"+15550001234","Email":"actor@example.com"}'
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO entries_fts(rowid, title, description, body_preview)
            SELECT rowid, title, description, body_preview FROM entries
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let title_rows = search_by_title(&pool, "15550001234", 10).await.unwrap();
        let fts_rows = search_fts(&pool, "15550001234", None, None, 10)
            .await
            .unwrap();

        assert!(title_rows.is_empty());
        assert!(fts_rows.is_empty());
    }
}
