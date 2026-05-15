use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

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
            id,
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
            e.id,
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
            id,
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
