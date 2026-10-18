use std::path::Path;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::collections::model::{Column, PropertyType};
use crate::collections::schema::{normalize_rel_path, read_schema_at};
use crate::index::IndexError as AppError;
use crate::page::naming::display_name_key;

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

/// Match level of a Page against a title query, compared in the Page name key
/// form (`display_name_key`: NFKC + case fold) so letters of any script match
/// regardless of case. Lower levels are more exact: exact title, title prefix,
/// title substring, path substring.
pub(crate) struct TitleQuery {
    key: String,
}

impl TitleQuery {
    pub(crate) fn new(query: &str) -> Self {
        Self {
            key: display_name_key(query),
        }
    }

    /// `None` when neither the title nor the path matches. An empty query
    /// matches every Page at one level.
    pub(crate) fn level(&self, title: &str, path: &str) -> Option<u8> {
        if self.key.is_empty() {
            return Some(0);
        }
        let title = display_name_key(title);
        if title == self.key {
            Some(0)
        } else if title.starts_with(&self.key) {
            Some(1)
        } else if title.contains(&self.key) {
            Some(2)
        } else if display_name_key(path).contains(&self.key) {
            Some(3)
        } else {
            None
        }
    }
}

/// Search entries by title or path, ranked by `TitleQuery` level, then by
/// `updated_at DESC`, before the limit is applied. Matching happens in Rust
/// because SQLite `LIKE` folds only ASCII case.
pub async fn search_by_title(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, AppError> {
    let title_query = TitleQuery::new(query);
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
        WHERE is_discoverable = 1
          AND NOT (
              LOWER(file_path) = 'readme.md'
              OR (
                  in_collection = 1
                  AND collection_root_path IS NOT NULL
                  AND LOWER(file_path) = LOWER(
                      CASE
                          WHEN collection_root_path = '.' THEN 'readme.md'
                          ELSE collection_root_path || '/readme.md'
                      END
                  )
              )
          )
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Index(format!("search_by_title query={query:?} failed: {e}")))?;

    let mut ranked = rows
        .into_iter()
        .filter_map(|r| {
            let hit = SearchResult {
                id: r.get::<String, _>("id"),
                path: r.get::<String, _>("path"),
                title: r.get::<String, _>("title"),
                entry_type: r.get::<String, _>("type"),
                snippet: None,
                table_name: r.get::<Option<String>, _>("table_name"),
                updated_at: r.get::<Option<String>, _>("updated_at"),
            };
            Some((title_query.level(&hit.title, &hit.path)?, hit))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
    });
    ranked.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    Ok(ranked.into_iter().map(|(_, hit)| hit).collect())
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
        WHERE is_discoverable = 1
          AND in_collection = 1 AND collection_root_path IS NOT NULL
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
        let Ok(schema) = read_schema_at(
            &space_path
                .join(normalize_rel_path(&collection_path))
                .join("schema.yaml"),
        ) else {
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
        WHERE is_discoverable = 1
          AND in_collection = 1
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
          AND e.is_discoverable = 1
          AND NOT (
              LOWER(e.file_path) = 'readme.md'
              OR (
                  e.in_collection = 1
                  AND e.collection_root_path IS NOT NULL
                  AND LOWER(e.file_path) = LOWER(
                      CASE
                          WHEN e.collection_root_path = '.' THEN 'readme.md'
                          ELSE e.collection_root_path || '/readme.md'
                      END
                  )
              )
          )
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
        WHERE is_discoverable = 1
          AND NOT (
            LOWER(file_path) = 'readme.md'
            OR (
                in_collection = 1
                AND collection_root_path IS NOT NULL
                AND LOWER(file_path) = LOWER(
                    CASE
                        WHEN collection_root_path = '.' THEN 'readme.md'
                        ELSE collection_root_path || '/readme.md'
                    END
                )
            )
        )
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

    async fn title_pool(rows: &[(&str, &str, &str, i64)]) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE entries (
                file_path TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                updated TEXT NOT NULL,
                collection_root_path TEXT,
                in_collection INTEGER NOT NULL,
                is_discoverable INTEGER NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        for (path, title, updated, discoverable) in rows {
            sqlx::query(
                "INSERT INTO entries (file_path,title,updated,collection_root_path,in_collection,is_discoverable) VALUES (?,?,?,NULL,0,?)",
            )
            .bind(path)
            .bind(title)
            .bind(updated)
            .bind(discoverable)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    async fn titles(pool: &SqlitePool, query: &str, limit: i64) -> Vec<String> {
        search_by_title(pool, query, limit)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.title)
            .collect()
    }

    #[tokio::test]
    async fn title_search_ranks_levels_before_limit() {
        let pool = title_pool(&[
            ("Plan.md", "Plan", "2026-01-01", 1),
            ("Plan A.md", "Plan A", "2026-01-02", 1),
            ("Plan B.md", "Plan B", "2026-01-03", 1),
            ("Plan C.md", "Plan C", "2026-01-04", 1),
            ("My Plan.md", "My Plan", "2026-01-05", 1),
            ("plans/other.md", "Other", "2026-01-06", 1),
            ("hidden.md", "Plan", "2026-01-07", 0),
            ("README.md", "Plan", "2026-01-08", 1),
            ("unrelated.md", "Unrelated", "2026-01-09", 1),
        ])
        .await;

        assert_eq!(titles(&pool, "Plan", 2).await, vec!["Plan", "Plan C"]);
        assert_eq!(
            titles(&pool, "plan", 10).await,
            vec!["Plan", "Plan C", "Plan B", "Plan A", "My Plan", "Other"]
        );
        assert_eq!(titles(&pool, "", 2).await, vec!["Unrelated", "Other"]);
    }

    #[tokio::test]
    async fn title_search_folds_case_and_unicode_forms_of_any_script() {
        let pool = title_pool(&[
            ("План.md", "План", "2026-01-01", 1),
            ("План работ.md", "План работ", "2026-01-02", 1),
            ("Мой план.md", "Мой план", "2026-01-03", 1),
            ("Йод.md", "Йод", "2026-01-04", 1),
            ("Plan.md", "Plan", "2026-01-05", 1),
        ])
        .await;

        for query in ["план", "ПЛАН", "План"] {
            assert_eq!(
                titles(&pool, query, 10).await,
                vec!["План", "План работ", "Мой план"],
                "query {query:?}"
            );
        }
        assert_eq!(titles(&pool, "\u{0438}\u{0306}од", 10).await, vec!["Йод"]);
        assert_eq!(titles(&pool, "ＰＬＡＮ", 10).await, vec!["Plan"]);
    }

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
                is_discoverable INTEGER NOT NULL,
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
                file_path, title, updated, collection_root_path, in_collection,
                is_discoverable, fields
            ) VALUES ('tasks/a.md', 'A', '2026-01-01', 'tasks', 1, 1, '{"Key":24}')
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
                is_discoverable INTEGER NOT NULL,
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
                updated, collection_root_path, in_collection, is_discoverable, fields
            ) VALUES (
                1, 'contacts/ivan.md', 'Customer record', '',
                'Regular note body', '2026-01-01', 'contacts', 1, 1,
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

    #[tokio::test]
    async fn page_search_excludes_space_and_collection_owner_readmes() {
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
                is_discoverable INTEGER NOT NULL,
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
        for (path, title, collection_root, in_collection, updated) in [
            ("README.md", "Needle space home", None, 0, "2026-01-04"),
            (
                "tasks/README.md",
                "Needle collection home",
                Some("tasks"),
                1,
                "2026-01-03",
            ),
            ("notes/idea.md", "Needle page", None, 0, "2026-01-02"),
            (
                "tasks/item.md",
                "Needle item page",
                Some("tasks"),
                1,
                "2026-01-01",
            ),
        ] {
            sqlx::query(
                "INSERT INTO entries (file_path,title,description,body_preview,updated,collection_root_path,in_collection,is_discoverable,fields) VALUES (?,?,NULL,'Needle body',?,?,?,1,'{}')",
            )
            .bind(path)
            .bind(title)
            .bind(updated)
            .bind(collection_root)
            .bind(in_collection)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO entries_fts(rowid,title,description,body_preview) SELECT rowid,title,description,body_preview FROM entries",
        )
        .execute(&pool)
        .await
        .unwrap();

        for rows in [
            search_by_title(&pool, "Needle", 10).await.unwrap(),
            search_fts(&pool, "Needle", None, None, 10).await.unwrap(),
            recent(&pool, 10).await.unwrap(),
        ] {
            let mut paths = rows.into_iter().map(|row| row.path).collect::<Vec<_>>();
            paths.sort();
            assert_eq!(
                paths,
                vec!["notes/idea.md".to_string(), "tasks/item.md".to_string()]
            );
        }
    }
}
