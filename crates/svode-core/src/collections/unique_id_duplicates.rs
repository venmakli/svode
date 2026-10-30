//! A `unique_id` number held by more than one item of a Collection. One rule
//! for the integrity check, the Desktop marks and renumbering after sync.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use super::CollectionError;
use super::model::{CollectionSchema, PropertyType};
use super::query::{collection_root_for_sql, json_path};
use super::schema::{normalize_rel_path, resolve_collection_schema_result};
use super::schema_support::unique_id_value;
use super::traversal::collection_markdown_files;
use crate::page::entry::Entry;
use crate::page::frontmatter::{self, EntryMeta};

/// The other item of the Collection that holds the same number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UniqueIdDuplicate {
    pub path: String,
    pub title: String,
}

/// An item of the Collection with a valid number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniqueIdHolder {
    pub path: String,
    pub title: String,
    pub number: u64,
}

/// The valid `unique_id` numbers of the items of one Collection.
#[derive(Debug, Clone)]
pub struct UniqueIdNumbers {
    field: String,
    holders: Vec<UniqueIdHolder>,
}

impl UniqueIdNumbers {
    /// Numbers read from the item sources; `None` when the Collection has no
    /// `unique_id` column. Items with malformed frontmatter hold no number.
    pub fn read(space: &str, collection_path: &str) -> Result<Option<Self>, CollectionError> {
        let Some(field) = unique_id_field_of(space, collection_path)? else {
            return Ok(None);
        };
        let mut holders = Vec::new();
        for file in collection_markdown_files(space, collection_path)? {
            let Ok(Some((meta, _))) = frontmatter::try_parse(&fs::read_to_string(&file)?) else {
                continue;
            };
            if let Some(number) = number_of(&meta, &field) {
                holders.push(UniqueIdHolder {
                    path: rel_path(space, &file),
                    title: meta.title,
                    number,
                });
            }
        }
        Ok(Some(Self::new(field, holders)))
    }

    /// Numbers of the indexed items; `None` when the Collection has no
    /// `unique_id` column.
    pub async fn indexed(
        pool: &SqlitePool,
        space: &str,
        collection_path: &str,
    ) -> Result<Option<Self>, CollectionError> {
        let Some(field) = unique_id_field_of(space, collection_path)? else {
            return Ok(None);
        };
        let path = json_path(&field);
        let rows = sqlx::query(
            "SELECT file_path, title, json_extract(fields, ?1) AS number FROM entries \
             WHERE collection_root_path = ?2 AND in_collection = 1 AND is_entry_head = 1 \
             AND json_type(fields, ?1) = 'integer'",
        )
        .bind(&path)
        .bind(collection_root_for_sql(collection_path))
        .fetch_all(pool)
        .await
        .map_err(|e| CollectionError::Index(format!("unique_id query failed: {e}")))?;
        let holders = rows
            .into_iter()
            .filter_map(|row| {
                let number = u64::try_from(row.get::<i64, _>("number")).ok()?;
                (number >= 1).then(|| UniqueIdHolder {
                    path: row.get("file_path"),
                    title: row.get("title"),
                    number,
                })
            })
            .collect();
        Ok(Some(Self::new(field, holders)))
    }

    fn new(field: String, mut holders: Vec<UniqueIdHolder>) -> Self {
        holders.sort_by(|left, right| left.path.cmp(&right.path));
        Self { field, holders }
    }

    pub fn field(&self) -> &str {
        &self.field
    }

    /// The first other item, by path, that holds the number of the item at
    /// `path` with `meta`. Only a valid number repeats.
    pub fn duplicate_of(&self, path: &str, meta: &EntryMeta) -> Option<UniqueIdDuplicate> {
        let number = number_of(meta, &self.field)?;
        let path = normalize_rel_path(path);
        self.holders
            .iter()
            .find(|holder| holder.number == number && holder.path != path)
            .map(|holder| UniqueIdDuplicate {
                path: holder.path.clone(),
                title: holder.title.clone(),
            })
    }

    /// Items holding the same number, two or more per group: groups by
    /// number, items by path.
    pub fn duplicate_groups(&self) -> Vec<(u64, Vec<&UniqueIdHolder>)> {
        let mut groups = BTreeMap::<u64, Vec<&UniqueIdHolder>>::new();
        for holder in &self.holders {
            groups.entry(holder.number).or_default().push(holder);
        }
        groups
            .into_iter()
            .filter(|(_, holders)| holders.len() > 1)
            .collect()
    }
}

/// Duplicate marks of Collection items read from their sources, against the
/// indexed numbers of the other items.
pub async fn unique_id_duplicates_of_entries(
    pool: &SqlitePool,
    space: &str,
    collection_path: &str,
    entries: &[Entry],
) -> Result<Vec<Option<UniqueIdDuplicate>>, CollectionError> {
    let Some(numbers) = UniqueIdNumbers::indexed(pool, space, collection_path).await? else {
        return Ok(vec![None; entries.len()]);
    };
    Ok(entries
        .iter()
        .map(|entry| numbers.duplicate_of(&entry.path, &entry.meta))
        .collect())
}

/// Duplicate mark of the Collection item at `file_path`: its source number
/// against the indexed numbers of the other items.
pub async fn unique_id_duplicate_of_item(
    pool: &SqlitePool,
    space: &str,
    file_path: &str,
) -> Result<Option<UniqueIdDuplicate>, CollectionError> {
    let Some((schema, root)) = resolve_collection_schema_result(Path::new(space), file_path)?
    else {
        return Ok(None);
    };
    if unique_id_field(&schema).is_none() {
        return Ok(None);
    }
    let raw = fs::read_to_string(Path::new(space).join(normalize_rel_path(file_path)))?;
    let Ok(Some((meta, _))) = frontmatter::try_parse(&raw) else {
        return Ok(None);
    };
    let collection_path = root.to_string_lossy().replace('\\', "/");
    let Some(numbers) = UniqueIdNumbers::indexed(pool, space, &collection_path).await? else {
        return Ok(None);
    };
    Ok(numbers.duplicate_of(file_path, &meta))
}

fn unique_id_field(schema: &CollectionSchema) -> Option<&str> {
    schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .map(|column| column.name.as_str())
}

fn unique_id_field_of(
    space: &str,
    collection_path: &str,
) -> Result<Option<String>, CollectionError> {
    let schema = super::engine::read_collection_schema(space, collection_path)?;
    Ok(unique_id_field(&schema).map(str::to_string))
}

fn number_of(meta: &EntryMeta, field: &str) -> Option<u64> {
    meta.extra.get(field).and_then(unique_id_value)
}

fn rel_path(space: &str, file: &Path) -> String {
    file.strip_prefix(space)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collections::engine::{
        CollectionIntegrityIssue, assign_unique_id, validate_collection_integrity_with_project,
    };
    use crate::collections::entries::entries_from_rows;
    use crate::collections::query::query_entry_rows;
    use crate::index::db;
    use crate::index::reindex::full_reindex;
    use crate::page::entry;
    use crate::page::test_support::scaffold_space;
    use tempfile::TempDir;

    /// Collection `tasks` where `a.md` and `c/README.md` hold 3, `b.md` holds
    /// 4, `d.md` has a broken number "3" and `e.md` none; `notes` has no
    /// `unique_id` column and two equal values of its number column.
    fn fixture() -> TempDir {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        scaffold_space(root, "Test");
        for (path, content) in [
            (
                "tasks/schema.yaml",
                "columns:\n  - { name: Key, type: unique_id, prefix: T, next: 5 }\nviews: []\n",
            ),
            ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
            ("tasks/a.md", "---\ntitle: From A\nKey: 3\n---\n"),
            ("tasks/b.md", "---\ntitle: From B\nKey: 4\n---\n"),
            ("tasks/c/README.md", "---\ntitle: From C\nKey: 3\n---\n"),
            ("tasks/d.md", "---\ntitle: From D\nKey: \"3\"\n---\n"),
            ("tasks/e.md", "---\ntitle: From E\n---\n"),
            (
                "notes/schema.yaml",
                "columns:\n  - { name: Key, type: number }\nviews: []\n",
            ),
            ("notes/x.md", "---\ntitle: X\nKey: 1\n---\n"),
            ("notes/y.md", "---\ntitle: Y\nKey: 1\n---\n"),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        temp
    }

    async fn index_pool(root: &Path) -> SqlitePool {
        let pool = db::create_pool(&root.join(".svode/index.db"))
            .await
            .unwrap();
        db::ensure_schema(&pool).await.unwrap();
        full_reindex::<crate::git::cli::GitCli>(None, &pool, root, &[])
            .await
            .unwrap();
        pool
    }

    fn duplicate_issues(space: &str) -> Vec<CollectionIntegrityIssue> {
        validate_collection_integrity_with_project(space, None, None)
            .unwrap()
            .errors
            .into_iter()
            .filter(|issue| issue.code == "UNIQUE_ID_DUPLICATE")
            .collect()
    }

    fn other(path: &str, title: &str) -> Option<UniqueIdDuplicate> {
        Some(UniqueIdDuplicate {
            path: path.to_string(),
            title: title.to_string(),
        })
    }

    #[test]
    fn integrity_reports_each_item_of_a_repeated_number_with_the_other_one() {
        let temp = fixture();
        let space = temp.path().to_str().unwrap();

        let issues = duplicate_issues(space);

        let found = issues
            .iter()
            .map(|issue| {
                (
                    issue.path.as_str(),
                    issue.related_path.as_deref(),
                    issue.collection_path.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            [
                ("tasks/a.md", Some("tasks/c/README.md"), Some("tasks")),
                ("tasks/c/README.md", Some("tasks/a.md"), Some("tasks")),
            ]
        );
        assert!(issues[0].message.contains("'Key'"), "{}", issues[0].message);
        let collection = validate_collection_integrity_with_project(space, Some("tasks"), None)
            .unwrap()
            .errors;
        assert_eq!(collection.len(), 2);
    }

    #[test]
    fn a_unique_number_gives_no_issue_and_assigning_a_new_key_clears_the_repeat() {
        let temp = fixture();
        let space = temp.path().to_str().unwrap();
        fs::write(
            temp.path().join("tasks/c/README.md"),
            "---\ntitle: From C\nKey: 7\n---\n",
        )
        .unwrap();
        assert!(duplicate_issues(space).is_empty());

        fs::write(
            temp.path().join("tasks/c/README.md"),
            "---\ntitle: From C\nKey: 3\n---\n",
        )
        .unwrap();
        assert_eq!(duplicate_issues(space).len(), 2);
        assign_unique_id(space, "tasks/c/README.md").unwrap();

        assert!(duplicate_issues(space).is_empty());
        let meta = entry::read(space, "tasks/c/README.md").unwrap().meta;
        assert_eq!(meta.extra.get("Key").and_then(unique_id_value), Some(5));
    }

    #[test]
    fn groups_hold_only_valid_numbers_of_the_collection_items() {
        let temp = fixture();
        let space = temp.path().to_str().unwrap();
        fs::write(
            temp.path().join("tasks/b.md"),
            "---\ntitle: From B\nKey: 3\n---\n",
        )
        .unwrap();

        let numbers = UniqueIdNumbers::read(space, "tasks").unwrap().unwrap();
        let groups = numbers
            .duplicate_groups()
            .into_iter()
            .map(|(number, holders)| {
                let paths = holders.iter().map(|holder| holder.path.as_str()).collect();
                (number, paths)
            })
            .collect::<Vec<(u64, Vec<&str>)>>();
        assert_eq!(
            groups,
            [(3, vec!["tasks/a.md", "tasks/b.md", "tasks/c/README.md"])]
        );
        assert!(UniqueIdNumbers::read(space, "notes").unwrap().is_none());
    }

    #[tokio::test]
    async fn read_items_are_marked_against_the_indexed_numbers_of_the_others() {
        let temp = fixture();
        let space = temp.path().to_str().unwrap();
        let pool = index_pool(temp.path()).await;
        let schema = crate::collections::engine::read_collection_schema(space, "tasks").unwrap();
        let rows = query_entry_rows(&pool, &schema, "tasks", &[], &[], None, None)
            .await
            .unwrap();
        let entries = entries_from_rows(space, "tasks", rows, true, false).unwrap();

        let marks = unique_id_duplicates_of_entries(&pool, space, "tasks", &entries)
            .await
            .unwrap();

        let marked = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .zip(marks)
            .collect::<BTreeMap<_, _>>();
        assert_eq!(marked["tasks/a.md"], other("tasks/c/README.md", "From C"));
        assert_eq!(marked["tasks/c/README.md"], other("tasks/a.md", "From A"));
        for path in ["tasks/b.md", "tasks/d.md", "tasks/e.md"] {
            assert_eq!(marked[path], None, "{path}");
        }
        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "tasks/a.md")
                .await
                .unwrap(),
            other("tasks/c/README.md", "From C")
        );
        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "tasks/b.md")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "notes/x.md")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "README.md")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_new_key_clears_the_mark_of_its_item_before_the_index_catches_up() {
        let temp = fixture();
        let space = temp.path().to_str().unwrap();
        let pool = index_pool(temp.path()).await;

        assign_unique_id(space, "tasks/c/README.md").unwrap();

        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "tasks/c/README.md")
                .await
                .unwrap(),
            None
        );
        full_reindex::<crate::git::cli::GitCli>(None, &pool, temp.path(), &[])
            .await
            .unwrap();
        assert_eq!(
            unique_id_duplicate_of_item(&pool, space, "tasks/a.md")
                .await
                .unwrap(),
            None
        );
    }
}
