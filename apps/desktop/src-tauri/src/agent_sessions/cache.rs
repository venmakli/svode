use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use super::AgentSessionsState;
use super::sources::{PersistedAgentSessionCandidate, SourceScan, claude_code, codex};
use super::types::{AgentSessionSource, AgentSessionSourceReport};
use crate::error::AppError;

#[derive(Debug, Default)]
pub(crate) struct AgentSessionsReadCache {
    sources: HashMap<AgentSessionSource, CachedSourceScan>,
}

#[derive(Debug, Clone)]
pub(super) struct CachedSourceScan {
    pub(super) fingerprint: String,
    pub(super) candidates: Vec<PersistedAgentSessionCandidate>,
    pub(super) report: AgentSessionSourceReport,
}

#[derive(Debug)]
pub(super) struct SourceRead {
    pub(super) candidates: Vec<PersistedAgentSessionCandidate>,
    pub(super) report: AgentSessionSourceReport,
    pub(super) cache_hit: bool,
}

pub(super) fn source_root(home: &Path, source: AgentSessionSource) -> PathBuf {
    match source {
        AgentSessionSource::Codex => home.join(".codex"),
        AgentSessionSource::ClaudeCode => home.join(".claude"),
    }
}

pub(super) fn candidates_for_session_ids(
    state: &AgentSessionsState,
    session_ids: &HashSet<String>,
) -> Result<Vec<PersistedAgentSessionCandidate>, AppError> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }

    let cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    let mut candidates = Vec::new();
    for cached in cache.sources.values() {
        for candidate in &cached.candidates {
            if session_ids.contains(&candidate_session_id(candidate)) {
                candidates.push(candidate.clone());
            }
        }
    }
    Ok(candidates)
}

pub(super) fn update_candidate(
    state: &AgentSessionsState,
    candidate: PersistedAgentSessionCandidate,
) -> Result<Option<CachedSourceScan>, AppError> {
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    let Some(cached) = cache.sources.get_mut(&candidate.source) else {
        return Ok(None);
    };

    if let Some(existing) = cached
        .candidates
        .iter_mut()
        .find(|item| item.source_session_id == candidate.source_session_id)
    {
        *existing = candidate;
    } else {
        cached.candidates.push(candidate);
        cached
            .candidates
            .sort_by(|a, b| a.source_session_id.cmp(&b.source_session_id));
    }
    Ok(Some(cached.clone()))
}

fn candidate_session_id(candidate: &PersistedAgentSessionCandidate) -> String {
    format!(
        "{}:{}",
        candidate.source.as_str(),
        candidate.source_session_id
    )
}

pub(super) fn memory_is_empty(state: &AgentSessionsState) -> Result<bool, AppError> {
    let cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    Ok(cache.sources.is_empty())
}

pub(super) fn disk_snapshot_reads(
    state: &AgentSessionsState,
    project: &Path,
    started: Instant,
) -> Result<Option<Vec<SourceRead>>, AppError> {
    let db_path = cache_db_path(project);
    if !db_path.is_file() {
        return Ok(None);
    }

    let mut rows = Vec::new();
    for source in [AgentSessionSource::Codex, AgentSessionSource::ClaudeCode] {
        match read_disk_source_cache_row(&db_path, source) {
            Ok(Some(row)) => rows.push((source, row)),
            Ok(None) => return Ok(None),
            Err(error) => {
                tracing::warn!(
                    "agent sessions stale snapshot read failed for {}: {error}",
                    db_path.display()
                );
                return Ok(None);
            }
        }
    }

    let mut reads = Vec::new();
    for (source, row) in rows {
        let mut report = row.report;
        report.cache_hit = true;
        report.fingerprint = Some(row.fingerprint.clone());
        report.duration_ms = Some(started.elapsed().as_millis());

        let read = SourceRead {
            candidates: row.candidates,
            report,
            cache_hit: true,
        };
        cache_source_read(state, source, row.fingerprint, &read)?;
        reads.push(read);
    }

    Ok(Some(reads))
}

pub(super) fn read_source(
    state: &AgentSessionsState,
    project: &Path,
    source: AgentSessionSource,
    force_refresh: bool,
) -> Result<SourceRead, AppError> {
    let started = Instant::now();
    let root = source_root(&state.home_dir, source);
    let (fingerprint, report) = match source {
        AgentSessionSource::Codex => codex::collect_fingerprint(&root),
        AgentSessionSource::ClaudeCode => claude_code::collect_fingerprint(&root),
    };

    if !force_refresh {
        if let Some(read) = cached_source_read(state, source, &fingerprint.value, started)? {
            return Ok(read);
        }
        if let Some(read) =
            disk_cached_source_read(state, project, source, &fingerprint.value, started)?
        {
            return Ok(read);
        }
    }

    let scan = match source {
        AgentSessionSource::Codex => codex::scan(&root, fingerprint, report),
        AgentSessionSource::ClaudeCode => claude_code::scan(&root, fingerprint, report),
    };
    let mut scan = scan;
    scan.report.cache_hit = false;
    scan.report.duration_ms = Some(started.elapsed().as_millis());
    cache_source_scan(state, source, &scan)?;
    cache_source_scan_on_disk(project, source, &scan);
    Ok(source_read_from_scan(scan))
}

pub(super) fn write_snapshot(
    project: &Path,
    source: AgentSessionSource,
    fingerprint: &str,
    candidates: &[PersistedAgentSessionCandidate],
    report: &AgentSessionSourceReport,
) {
    let db_path = cache_db_path(project);
    let candidates_json = match serde_json::to_string(candidates) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("agent sessions disk cache serialization failed: {error}");
            return;
        }
    };
    let report_json = match serde_json::to_string(report) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("agent sessions disk cache report serialization failed: {error}");
            return;
        }
    };
    let source_key = source.as_str().to_string();
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    let write = tauri::async_runtime::block_on(async {
        let pool = open_cache_pool(&db_path, true).await?;
        ensure_cache_schema(&pool).await?;
        sqlx::query(
            r#"
            INSERT INTO source_cache (
                source,
                fingerprint,
                candidates_json,
                report_json,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
                fingerprint = excluded.fingerprint,
                candidates_json = excluded.candidates_json,
                report_json = excluded.report_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(source_key)
        .bind(fingerprint)
        .bind(candidates_json)
        .bind(report_json)
        .bind(updated_at)
        .execute(&pool)
        .await?;
        pool.close().await;
        Ok::<_, AppError>(())
    });

    if let Err(error) = write {
        tracing::warn!(
            "agent sessions disk cache write failed for {}: {error}",
            db_path.display()
        );
    }
}

struct DiskSourceCacheRow {
    fingerprint: String,
    candidates: Vec<PersistedAgentSessionCandidate>,
    report: AgentSessionSourceReport,
}

fn disk_cached_source_read(
    state: &AgentSessionsState,
    project: &Path,
    source: AgentSessionSource,
    fingerprint: &str,
    started: Instant,
) -> Result<Option<SourceRead>, AppError> {
    let db_path = cache_db_path(project);
    if !db_path.is_file() {
        return Ok(None);
    }

    match read_disk_source_cache_row(&db_path, source) {
        Ok(Some(row)) if row.fingerprint == fingerprint => {
            let mut report = row.report;
            report.cache_hit = true;
            report.fingerprint = Some(row.fingerprint);
            report.duration_ms = Some(started.elapsed().as_millis());
            let read = SourceRead {
                candidates: row.candidates,
                report,
                cache_hit: true,
            };
            cache_source_read(state, source, fingerprint.to_string(), &read)?;
            Ok(Some(read))
        }
        Ok(Some(_)) | Ok(None) => Ok(None),
        Err(error) => {
            tracing::warn!(
                "agent sessions disk cache read failed for {}: {error}",
                db_path.display()
            );
            Ok(None)
        }
    }
}

fn read_disk_source_cache_row(
    db_path: &Path,
    source: AgentSessionSource,
) -> Result<Option<DiskSourceCacheRow>, AppError> {
    tauri::async_runtime::block_on(async {
        let pool = open_cache_pool(db_path, false).await?;
        ensure_cache_schema(&pool).await?;
        let row = sqlx::query_as::<_, (String, String, String)>(
            "SELECT fingerprint, candidates_json, report_json FROM source_cache WHERE source = ?",
        )
        .bind(source.as_str())
        .fetch_optional(&pool)
        .await?;
        pool.close().await;

        let Some((fingerprint, candidates_json, report_json)) = row else {
            return Ok(None);
        };
        let candidates =
            serde_json::from_str::<Vec<PersistedAgentSessionCandidate>>(&candidates_json)?;
        let report = serde_json::from_str::<AgentSessionSourceReport>(&report_json)?;

        Ok::<_, AppError>(Some(DiskSourceCacheRow {
            fingerprint,
            candidates,
            report,
        }))
    })
}

fn cache_source_scan_on_disk(project: &Path, source: AgentSessionSource, scan: &SourceScan) {
    write_snapshot(
        project,
        source,
        &scan.fingerprint,
        &scan.candidates,
        &scan.report,
    );
}

fn cache_source_read(
    state: &AgentSessionsState,
    source: AgentSessionSource,
    fingerprint: String,
    read: &SourceRead,
) -> Result<(), AppError> {
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    cache.sources.insert(
        source,
        CachedSourceScan {
            fingerprint,
            candidates: read.candidates.clone(),
            report: read.report.clone(),
        },
    );
    Ok(())
}

fn cache_db_path(project: &Path) -> PathBuf {
    project.join(".svode").join("agent-sessions.db")
}

async fn open_cache_pool(
    db_path: &Path,
    create_if_missing: bool,
) -> Result<sqlx::SqlitePool, AppError> {
    if create_if_missing && let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(create_if_missing)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

async fn ensure_cache_schema(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS source_cache (
            source TEXT PRIMARY KEY NOT NULL,
            fingerprint TEXT NOT NULL,
            candidates_json TEXT NOT NULL,
            report_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn cached_source_read(
    state: &AgentSessionsState,
    source: AgentSessionSource,
    fingerprint: &str,
    started: Instant,
) -> Result<Option<SourceRead>, AppError> {
    let cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    let Some(cached) = cache.sources.get(&source) else {
        return Ok(None);
    };
    if cached.fingerprint != fingerprint {
        return Ok(None);
    }

    let mut report = cached.report.clone();
    report.cache_hit = true;
    report.fingerprint = Some(cached.fingerprint.clone());
    report.duration_ms = Some(started.elapsed().as_millis());
    Ok(Some(SourceRead {
        candidates: cached.candidates.clone(),
        report,
        cache_hit: true,
    }))
}

fn cache_source_scan(
    state: &AgentSessionsState,
    source: AgentSessionSource,
    scan: &SourceScan,
) -> Result<(), AppError> {
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    cache.sources.insert(
        source,
        CachedSourceScan {
            fingerprint: scan.fingerprint.clone(),
            candidates: scan.candidates.clone(),
            report: scan.report.clone(),
        },
    );
    Ok(())
}

fn source_read_from_scan(scan: SourceScan) -> SourceRead {
    SourceRead {
        candidates: scan.candidates,
        report: scan.report,
        cache_hit: false,
    }
}
