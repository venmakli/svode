use sqlx::SqlitePool;

use svode_core::page::entry::Entry;

/// Enrich a source read using its selected pool and normalized repository-relative path.
/// Missing rows and unavailable indexed dates leave filesystem-derived dates intact.
pub(crate) async fn apply_indexed_dates(pool: &SqlitePool, path: &str, page: &mut Entry) {
    let Ok(Some((created, updated))) = sqlx::query_as::<_, (String, String)>(
        "SELECT created, updated FROM entries WHERE file_path = ?",
    )
    .bind(path)
    .fetch_optional(pool)
    .await
    else {
        return;
    };
    svode_core::page::dates::apply_date_override(
        &mut page.meta.created,
        &mut page.meta.updated,
        Some(&svode_core::page::dates::EntryDateOverride {
            created: Some(created),
            updated: Some(updated),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use svode_core::page::entry;

    #[tokio::test]
    async fn enrichment_preserves_source_facts_and_never_writes_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE entries (file_path TEXT PRIMARY KEY, created TEXT, updated TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let space = tmp.path().to_str().unwrap();
        std::fs::write(
            tmp.path().join("duplicate.md"),
            "---\ntitle: Named\n---\nOther body\n",
        )
        .unwrap();
        for (path, source) in [
            (
                "valid.md",
                "---\ntitle: Named\nid: custom-id\ncreated: custom-created\nupdated: custom-updated\n---\nBody\n",
            ),
            ("missing.md", "Body without frontmatter\n"),
            (
                "malformed.md",
                "---\ntitle: [broken\n---\nKeep everything\n",
            ),
            ("folder/README.md", "---\ntitle: Folder\n---\nNested body\n"),
            ("README.md", "Owner body\n"),
        ] {
            let abs = tmp.path().join(path);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, source).unwrap();
            sqlx::query("INSERT INTO entries VALUES (?, 'indexed-created', 'indexed-updated')")
                .bind(path)
                .execute(&pool)
                .await
                .unwrap();
            let mut page = entry::read(space, path).unwrap();
            if path == "valid.md" {
                assert!(page.name_conflict.is_some());
            }
            let mut expected = serde_json::to_value(&page).unwrap();
            expected["meta"]["created"] = "indexed-created".into();
            expected["meta"]["updated"] = "indexed-updated".into();
            sqlx::query("PRAGMA query_only = ON")
                .execute(&pool)
                .await
                .unwrap();
            apply_indexed_dates(&pool, path, &mut page).await;
            assert_eq!(serde_json::to_value(&page).unwrap(), expected, "{path}");
            assert_eq!(std::fs::read_to_string(abs).unwrap(), source);
            sqlx::query("PRAGMA query_only = OFF")
                .execute(&pool)
                .await
                .unwrap();
        }
        assert!(!tmp.path().join(".svode").exists());
        assert!(!tmp.path().join(".git").exists());
    }

    #[tokio::test]
    async fn unavailable_dates_preserve_filesystem_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("note.md"), "Body").unwrap();
        let mut page = entry::read(tmp.path().to_str().unwrap(), "note.md").unwrap();
        let expected = serde_json::to_value(&page).unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // Missing table, missing row, and closed pool are all best-effort reads.
        apply_indexed_dates(&pool, "note.md", &mut page).await;
        assert_eq!(serde_json::to_value(&page).unwrap(), expected);
        sqlx::query(
            "CREATE TABLE entries (file_path TEXT PRIMARY KEY, created TEXT, updated TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        apply_indexed_dates(&pool, "note.md", &mut page).await;
        assert_eq!(serde_json::to_value(&page).unwrap(), expected);
        pool.close().await;
        apply_indexed_dates(&pool, "note.md", &mut page).await;
        assert_eq!(serde_json::to_value(&page).unwrap(), expected);
    }
}
