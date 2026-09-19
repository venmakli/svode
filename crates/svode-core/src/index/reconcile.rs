use crate::index::entry_projection::build_entry_with_dates;
use crate::index::manifest::{
    SourceManifestRecord, advance_generation, read_generation, read_source_manifest,
    reconcile_source_manifest,
};
use crate::index::rows::upsert_entry;
use crate::index::state::IndexRuntimeState;
use crate::index::{IndexError, IndexKey};
use crate::page::dates::{GitDateExecutor, derive_date_overrides};
use std::collections::{BTreeMap, HashMap};

pub use crate::index::inventory::MAX_INDEXED_MARKDOWN_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileOutcome {
    Applied,
    Retry,
    Rebuild,
}

pub async fn reconcile_pool<E: GitDateExecutor>(
    executor: Option<&E>,
    state: &IndexRuntimeState,
    key: &IndexKey,
) -> Result<ReconcileOutcome, IndexError> {
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
        crate::index::inventory::collect_reindex_inventory(&inventory_dir, &skip)
    })
    .await
    .map_err(|error| IndexError::Index(format!("source inventory task failed: {error}")))??;

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

    let markdown_projections = inventory
        .markdown_sources
        .iter()
        .filter_map(|source| {
            crate::git::path::repo_relative_from_base(
                &dir,
                &source.path,
                crate::git::path::RootMode::Reject,
            )
            .ok()
            .map(|path| (path, source.projection))
        })
        .collect::<HashMap<_, _>>();
    let projected =
        crate::agent_context::projection::target_knowledge_projection(key.project(), &dir).await?;
    let agent_artifacts = projected
        .iter()
        .filter(|artifact| artifact.owner_scope == "current")
        .map(crate::index::knowledge_artifact::build_agent_artifact)
        .collect::<Vec<_>>();
    let applicability = projected
        .iter()
        .filter(|artifact| artifact.is_effectively_applicable())
        .map(crate::index::knowledge_artifact::build_agent_applicability)
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
    let date_overrides = match executor {
        Some(executor) => derive_date_overrides(executor, &dir, &changed_paths).await,
        None => Default::default(),
    };
    let mut built_entries = HashMap::new();
    for record in &mut changed_records {
        tokio::task::yield_now().await;
        if record.diagnostic_code.is_some() {
            continue;
        }
        let path = dir.join(&record.source_path);
        let Some(projection) = markdown_projections.get(&record.source_path).copied() else {
            tracing::warn!(
                "reconciliation projection missing for {}",
                record.source_path
            );
            record.diagnostic_code = Some("projection_unavailable".to_string());
            continue;
        };
        match build_entry_with_dates(
            &dir,
            &path,
            date_overrides.get(&record.source_path),
            projection,
        ) {
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
        knowledge_changed |= crate::index::knowledge_rows::delete_artifact(&mut tx, path).await?;
    }
    for record in &changed_records {
        let Some(entry) = built_entries.get(&record.source_path) else {
            sqlx::query("DELETE FROM entries WHERE file_path = ?")
                .bind(&record.source_path)
                .execute(&mut *tx)
                .await?;
            knowledge_changed |=
                crate::index::knowledge_rows::delete_artifact(&mut tx, &record.source_path).await?;
            continue;
        };
        upsert_entry(&mut *tx, entry).await?;
        if let Some(artifact) = entry.knowledge.as_ref() {
            knowledge_changed |=
                crate::index::knowledge_rows::upsert_artifact(&mut tx, artifact).await?;
        } else if let Some(artifact) =
            crate::index::knowledge_artifact::folded_collection_artifact(&dir, &record.source_path)
        {
            knowledge_changed |=
                crate::index::knowledge_rows::delete_artifact(&mut tx, &record.source_path).await?;
            knowledge_changed |=
                crate::index::knowledge_rows::upsert_artifact(&mut tx, &artifact).await?;
        } else {
            knowledge_changed |=
                crate::index::knowledge_rows::delete_artifact(&mut tx, &record.source_path).await?;
        }
    }
    knowledge_changed |= crate::index::knowledge_rows::replace_agent_context(
        &mut tx,
        &agent_artifacts,
        &applicability,
    )
    .await?;
    let source_manifest_changed = reconcile_source_manifest(&mut tx, &previous, &current).await?;
    let previous_failure_count: i64 =
        sqlx::query_scalar("SELECT failure_count FROM knowledge_manifest WHERE singleton = 1")
            .fetch_one(&mut *tx)
            .await?;
    if knowledge_changed || source_manifest_changed || previous_failure_count != 0 {
        crate::index::knowledge_rows::refresh_manifest_preserving_diagnostics(&mut tx).await?;
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
    state.cleanup_reconciled_index(key, &pool).await;
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

pub fn records_changed_for_kind(
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
