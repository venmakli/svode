use std::collections::{BTreeMap, HashMap};

use chrono::{SecondsFormat, Utc};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::AppError;
use crate::git::dates::derive_date_overrides;
use crate::index::reindex::{build_entry_with_dates, upsert_entry};
use crate::index::{IndexKey, IndexState};

pub(crate) const MAX_INDEXED_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceManifestRecord {
    pub source_path: String,
    pub source_kind: String,
    pub fingerprint: String,
    pub size_bytes: i64,
    pub modified_ns: i64,
    pub checked_at: String,
    pub diagnostic_code: Option<String>,
}

impl SourceManifestRecord {
    pub(crate) fn agent_context(
        source_path: String,
        fingerprint: String,
        size_bytes: usize,
    ) -> Self {
        Self {
            source_path,
            source_kind: "agent_context".to_string(),
            fingerprint,
            size_bytes: size_bytes.min(i64::MAX as usize) as i64,
            modified_ns: 0,
            checked_at: now(),
            diagnostic_code: None,
        }
    }

    fn identity(&self) -> (&str, &str) {
        (&self.source_path, &self.source_kind)
    }

    pub(crate) fn equivalent(&self, other: &Self) -> bool {
        self.source_path == other.source_path
            && self.source_kind == other.source_kind
            && self.fingerprint == other.fingerprint
            && self.size_bytes == other.size_bytes
            && self.modified_ns == other.modified_ns
            && self.diagnostic_code == other.diagnostic_code
    }
}

pub(crate) async fn reconcile_source_record(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
    source_kind: &str,
    current: Option<&SourceManifestRecord>,
) -> Result<bool, AppError> {
    let previous: Option<(String, String, String, i64, i64, String, Option<String>)> =
        sqlx::query_as(
            "SELECT source_path,source_kind,fingerprint,size_bytes,modified_ns,checked_at,diagnostic_code \
             FROM knowledge_source_manifest WHERE source_path = ? AND source_kind = ?",
        )
        .bind(source_path)
        .bind(source_kind)
        .fetch_optional(&mut **tx)
        .await?;
    let previous = previous.map(|row| SourceManifestRecord {
        source_path: row.0,
        source_kind: row.1,
        fingerprint: row.2,
        size_bytes: row.3,
        modified_ns: row.4,
        checked_at: row.5,
        diagnostic_code: row.6,
    });
    if previous
        .as_ref()
        .zip(current)
        .is_some_and(|(previous, current)| previous.equivalent(current))
        || previous.is_none() && current.is_none()
    {
        return Ok(false);
    }
    sqlx::query("DELETE FROM knowledge_source_manifest WHERE source_path = ? AND source_kind = ?")
        .bind(source_path)
        .bind(source_kind)
        .execute(&mut **tx)
        .await?;
    if let Some(current) = current {
        insert_source_manifest(tx, current).await?;
    }
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileOutcome {
    Applied,
    Retry,
    Rebuild,
}

pub(crate) async fn reconcile_pool(
    state: &IndexState,
    key: &IndexKey,
) -> Result<ReconcileOutcome, AppError> {
    let Some(pool) = state.existing_pool(key).await else {
        return Ok(ReconcileOutcome::Rebuild);
    };
    let Some(start_generation) = read_generation(&pool).await? else {
        return Ok(ReconcileOutcome::Rebuild);
    };
    let previous = read_source_manifest(&pool).await?;
    let dir = state.dir_for_key(key).await?;
    let skip = state.skip_folders_for(key).await;
    let inventory_dir = dir.clone();
    let inventory = tokio::task::spawn_blocking(move || {
        crate::index::reindex::collect_reindex_inventory(&inventory_dir, &skip)
    })
    .await
    .map_err(|error| AppError::Index(format!("source inventory task failed: {error}")))??;

    if inventory.scan_failure_count > 0 {
        let lock = state.reindex_lock(key).await;
        let _guard = lock.lock().await;
        if read_generation(&pool).await? != Some(start_generation) {
            return Ok(ReconcileOutcome::Retry);
        }
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE knowledge_manifest SET failure_count = ? WHERE singleton = 1")
            .bind(inventory.scan_failure_count as i64)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(ReconcileOutcome::Applied);
    }

    if records_changed_for_kind(&previous, &inventory.source_manifest, "collection_schema") {
        return Ok(ReconcileOutcome::Rebuild);
    }

    let projected =
        crate::agent_context::projection::target_knowledge_projection(key.project(), &dir).await?;
    let agent_artifacts = projected
        .iter()
        .filter(|artifact| artifact.owner_scope == "current")
        .map(crate::index::knowledge::build_agent_artifact)
        .collect::<Vec<_>>();
    let applicability = projected
        .iter()
        .filter(|artifact| artifact.is_effectively_applicable())
        .map(crate::index::knowledge::build_agent_applicability)
        .collect::<Vec<_>>();
    let mut current = inventory.source_manifest;
    current.extend(agent_artifacts.iter().map(|artifact| {
        SourceManifestRecord::agent_context(
            artifact.source_path.clone(),
            artifact.content_hash.clone(),
            artifact
                .fragments
                .iter()
                .map(|fragment| fragment.text.len())
                .sum(),
        )
    }));
    current.sort_by(|left, right| {
        left.source_kind
            .cmp(&right.source_kind)
            .then_with(|| left.source_path.cmp(&right.source_path))
    });

    let previous_markdown = by_path(&previous, "markdown");
    let current_markdown = by_path(&current, "markdown");
    let deleted_paths = previous_markdown
        .keys()
        .filter(|path| !current_markdown.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    let mut changed_records = current_markdown
        .iter()
        .filter(|(path, record)| {
            !previous_markdown
                .get(*path)
                .is_some_and(|previous| previous.equivalent(record))
        })
        .map(|(_, record)| (*record).clone())
        .collect::<Vec<_>>();

    let lock = state.reindex_lock(key).await;
    let _guard = lock.lock().await;
    if read_generation(&pool).await? != Some(start_generation) {
        return Ok(ReconcileOutcome::Retry);
    }

    let changed_paths = changed_records
        .iter()
        .filter(|record| record.diagnostic_code.is_none())
        .map(|record| record.source_path.clone())
        .collect::<Vec<_>>();
    let date_overrides = derive_date_overrides(&dir, &changed_paths).await;
    let mut built_entries = HashMap::new();
    for record in &mut changed_records {
        tokio::task::yield_now().await;
        if record.diagnostic_code.is_some() {
            continue;
        }
        let path = dir.join(&record.source_path);
        match build_entry_with_dates(&dir, &path, date_overrides.get(&record.source_path)) {
            Ok(entry) => {
                record.diagnostic_code = entry.source_diagnostic.clone();
                built_entries.insert(record.source_path.clone(), entry);
            }
            Err(error) => {
                tracing::warn!(
                    "reconciliation could not parse {}: {error}",
                    record.source_path
                );
                record.diagnostic_code = Some("unreadable_source".to_string());
            }
        }
    }
    let changed_diagnostics = changed_records
        .iter()
        .map(|record| (record.source_path.as_str(), record.diagnostic_code.clone()))
        .collect::<HashMap<_, _>>();
    for record in &mut current {
        if record.source_kind == "markdown" {
            if let Some(diagnostic) = changed_diagnostics.get(record.source_path.as_str()) {
                record.diagnostic_code = diagnostic.clone();
            }
        }
    }

    let mut tx = pool.begin().await?;
    let mut knowledge_changed = false;
    for path in &deleted_paths {
        sqlx::query("DELETE FROM entries WHERE file_path = ?")
            .bind(path)
            .execute(&mut *tx)
            .await?;
        knowledge_changed |= crate::index::knowledge::delete_artifact(&mut tx, path).await?;
    }
    for record in &changed_records {
        let Some(entry) = built_entries.get(&record.source_path) else {
            sqlx::query("DELETE FROM entries WHERE file_path = ?")
                .bind(&record.source_path)
                .execute(&mut *tx)
                .await?;
            knowledge_changed |=
                crate::index::knowledge::delete_artifact(&mut tx, &record.source_path).await?;
            continue;
        };
        upsert_entry(&mut *tx, entry).await?;
        if let Some(artifact) = entry.knowledge.as_ref() {
            knowledge_changed |=
                crate::index::knowledge::upsert_artifact(&mut tx, artifact).await?;
        } else if let Some(artifact) =
            crate::index::update::folded_collection_artifact(&dir, &record.source_path)
        {
            knowledge_changed |=
                crate::index::knowledge::delete_artifact(&mut tx, &record.source_path).await?;
            knowledge_changed |=
                crate::index::knowledge::upsert_artifact(&mut tx, &artifact).await?;
        } else {
            knowledge_changed |=
                crate::index::knowledge::delete_artifact(&mut tx, &record.source_path).await?;
        }
    }
    knowledge_changed |=
        crate::index::knowledge::replace_agent_context(&mut tx, &agent_artifacts, &applicability)
            .await?;
    let source_manifest_changed = reconcile_source_manifest(&mut tx, &previous, &current).await?;
    let previous_failure_count: i64 =
        sqlx::query_scalar("SELECT failure_count FROM knowledge_manifest WHERE singleton = 1")
            .fetch_one(&mut *tx)
            .await?;
    if knowledge_changed || source_manifest_changed || previous_failure_count != 0 {
        crate::index::knowledge::refresh_manifest_preserving_diagnostics(&mut tx).await?;
        let skipped_count = current
            .iter()
            .filter(|record| record.diagnostic_code.is_some())
            .count() as i64;
        sqlx::query(
            "UPDATE knowledge_manifest SET skipped_count = ?, failure_count = 0 WHERE singleton = 1",
        )
        .bind(skipped_count)
        .execute(&mut *tx)
        .await?;
    }
    advance_generation(
        &mut tx,
        knowledge_changed,
        source_manifest_changed || knowledge_changed,
    )
    .await?;
    tx.commit().await?;
    Ok(ReconcileOutcome::Applied)
}

fn by_path<'a>(
    records: &'a [SourceManifestRecord],
    source_kind: &str,
) -> BTreeMap<String, &'a SourceManifestRecord> {
    records
        .iter()
        .filter(|record| record.source_kind == source_kind)
        .map(|record| (record.source_path.clone(), record))
        .collect()
}

fn records_changed_for_kind(
    previous: &[SourceManifestRecord],
    current: &[SourceManifestRecord],
    source_kind: &str,
) -> bool {
    let previous = by_path(previous, source_kind);
    let current = by_path(current, source_kind);
    previous.len() != current.len()
        || current.iter().any(|(path, record)| {
            !previous
                .get(path)
                .is_some_and(|previous| previous.equivalent(record))
        })
}

pub(crate) async fn read_generation(pool: &SqlitePool) -> Result<Option<i64>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT generation FROM knowledge_manifest WHERE singleton = 1")
            .fetch_optional(pool)
            .await?,
    )
}

#[cfg(test)]
pub(crate) async fn read_revision(pool: &SqlitePool) -> Result<Option<i64>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT revision FROM knowledge_manifest WHERE singleton = 1")
            .fetch_optional(pool)
            .await?,
    )
}

pub(crate) async fn read_source_manifest(
    pool: &SqlitePool,
) -> Result<Vec<SourceManifestRecord>, AppError> {
    let rows: Vec<(String, String, String, i64, i64, String, Option<String>)> =
        sqlx::query_as(
            "SELECT source_path,source_kind,fingerprint,size_bytes,modified_ns,checked_at,diagnostic_code \
             FROM knowledge_source_manifest ORDER BY source_kind,source_path",
        )
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| SourceManifestRecord {
            source_path: row.0,
            source_kind: row.1,
            fingerprint: row.2,
            size_bytes: row.3,
            modified_ns: row.4,
            checked_at: row.5,
            diagnostic_code: row.6,
        })
        .collect())
}

pub(crate) async fn replace_source_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    records: &[SourceManifestRecord],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM knowledge_source_manifest")
        .execute(&mut **tx)
        .await?;
    for record in records {
        insert_source_manifest(tx, record).await?;
    }
    Ok(())
}

pub(crate) async fn reconcile_source_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    previous: &[SourceManifestRecord],
    current: &[SourceManifestRecord],
) -> Result<bool, AppError> {
    let previous = previous
        .iter()
        .map(|record| (record.identity(), record))
        .collect::<BTreeMap<_, _>>();
    let current = current
        .iter()
        .map(|record| (record.identity(), record))
        .collect::<BTreeMap<_, _>>();
    let mut changed = false;

    for identity in previous.keys() {
        if !current.contains_key(identity) {
            sqlx::query(
                "DELETE FROM knowledge_source_manifest WHERE source_path = ? AND source_kind = ?",
            )
            .bind(identity.0)
            .bind(identity.1)
            .execute(&mut **tx)
            .await?;
            changed = true;
        }
    }
    for (identity, record) in &current {
        if previous
            .get(identity)
            .is_some_and(|previous| previous.equivalent(record))
        {
            continue;
        }
        sqlx::query(
            "DELETE FROM knowledge_source_manifest WHERE source_path = ? AND source_kind = ?",
        )
        .bind(identity.0)
        .bind(identity.1)
        .execute(&mut **tx)
        .await?;
        insert_source_manifest(tx, record).await?;
        changed = true;
    }
    Ok(changed)
}

async fn insert_source_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    record: &SourceManifestRecord,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO knowledge_source_manifest \
         (source_path,source_kind,fingerprint,size_bytes,modified_ns,checked_at,diagnostic_code) \
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&record.source_path)
    .bind(&record.source_kind)
    .bind(&record.fingerprint)
    .bind(record.size_bytes)
    .bind(record.modified_ns)
    .bind(&record.checked_at)
    .bind(&record.diagnostic_code)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) async fn advance_generation(
    tx: &mut Transaction<'_, Sqlite>,
    revision_changed: bool,
    generation_changed: bool,
) -> Result<(), AppError> {
    if !revision_changed && !generation_changed {
        return Ok(());
    }
    sqlx::query(
        "UPDATE knowledge_manifest SET revision = revision + ?, generation = generation + ? \
         WHERE singleton = 1",
    )
    .bind(i64::from(revision_changed))
    .bind(i64::from(generation_changed || revision_changed))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn pool() -> SqlitePool {
        let temp = TempDir::new().unwrap();
        let path = temp.keep().join("index.db");
        let pool = crate::index::db::create_pool(&path).await.unwrap();
        crate::index::db::ensure_schema(&pool).await.unwrap();
        pool
    }

    fn record(path: &str, fingerprint: &str) -> SourceManifestRecord {
        SourceManifestRecord {
            source_path: path.to_string(),
            source_kind: "markdown".to_string(),
            fingerprint: fingerprint.to_string(),
            size_bytes: 1,
            modified_ns: 1,
            checked_at: "checked".to_string(),
            diagnostic_code: None,
        }
    }

    #[tokio::test]
    async fn source_manifest_noop_does_not_rewrite_checked_at() {
        let pool = pool().await;
        let mut tx = pool.begin().await.unwrap();
        replace_source_manifest(&mut tx, &[record("note.md", "one")])
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let previous = read_source_manifest(&pool).await.unwrap();
        let mut current = previous.clone();
        current[0].checked_at = "new-check".to_string();
        let mut tx = pool.begin().await.unwrap();
        assert!(
            !reconcile_source_manifest(&mut tx, &previous, &current)
                .await
                .unwrap()
        );
        tx.commit().await.unwrap();
        assert_eq!(
            read_source_manifest(&pool).await.unwrap()[0].checked_at,
            "checked"
        );
    }

    #[tokio::test]
    async fn revision_and_generation_have_distinct_noop_semantics() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO knowledge_manifest \
             (singleton,checked_at,document_count,link_count,skipped_count,failure_count) \
             VALUES (1,'now',0,0,0,0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, false, false).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(0));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(0));

        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, false, true).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(0));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(1));

        let mut tx = pool.begin().await.unwrap();
        advance_generation(&mut tx, true, true).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(read_revision(&pool).await.unwrap(), Some(1));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(2));
    }

    #[tokio::test]
    async fn reconciliation_is_write_free_on_noop_and_targets_change_and_delete() {
        let temp = TempDir::new().unwrap();
        let space = temp.path();
        let note = space.join("note.md");
        std::fs::write(&note, "alpha body").unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(&pool, space, space, &[])
            .await
            .unwrap();

        let baseline = (
            read_revision(&pool).await.unwrap().unwrap(),
            read_generation(&pool).await.unwrap().unwrap(),
        );
        sqlx::query("UPDATE knowledge_manifest SET checked_at = 'sentinel' WHERE singleton = 1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE knowledge_source_manifest SET checked_at = 'sentinel' \
             WHERE source_path = 'note.md' AND source_kind = 'markdown'",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            (
                read_revision(&pool).await.unwrap().unwrap(),
                read_generation(&pool).await.unwrap().unwrap(),
            ),
            baseline
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT checked_at FROM knowledge_manifest WHERE singleton = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "sentinel"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT checked_at FROM knowledge_source_manifest \
                 WHERE source_path = 'note.md' AND source_kind = 'markdown'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "sentinel"
        );

        std::fs::write(&note, "beta body with a different size").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT body_preview FROM entries WHERE file_path = 'note.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "beta body with a different size"
        );
        assert_eq!(read_revision(&pool).await.unwrap(), Some(baseline.0 + 1));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(baseline.1 + 1));

        std::fs::remove_file(&note).unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Applied
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM entries")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(read_revision(&pool).await.unwrap(), Some(baseline.0 + 2));
        assert_eq!(read_generation(&pool).await.unwrap(), Some(baseline.1 + 2));
    }

    #[tokio::test]
    async fn reconciliation_falls_back_for_schema_diffs_and_bounds_unsafe_sources() {
        let temp = TempDir::new().unwrap();
        let space = temp.path();
        std::fs::write(space.join("visible.md"), "visible").unwrap();
        std::fs::write(space.join("secrets.md"), "do not index").unwrap();
        std::fs::write(
            space.join("large.md"),
            vec![b'x'; MAX_INDEXED_MARKDOWN_BYTES as usize + 1],
        )
        .unwrap();
        std::fs::write(space.join("invalid.md"), [0xff, 0xfe]).unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        crate::index::reindex::full_reindex_for_target(&pool, space, space, &[])
            .await
            .unwrap();

        let paths =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["visible.md"]);
        let diagnostics: Vec<(String, String)> = sqlx::query_as(
            "SELECT source_path,diagnostic_code FROM knowledge_source_manifest \
             WHERE diagnostic_code IS NOT NULL ORDER BY source_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            diagnostics,
            vec![
                ("invalid.md".to_string(), "unreadable_source".to_string()),
                ("large.md".to_string(), "oversized_source".to_string()),
                ("secrets.md".to_string(), "excluded_secret_like".to_string()),
            ]
        );

        std::fs::create_dir_all(space.join("tasks")).unwrap();
        std::fs::write(space.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        assert_eq!(
            reconcile_pool(&state, &key).await.unwrap(),
            ReconcileOutcome::Rebuild
        );
    }
}
