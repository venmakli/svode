use std::collections::BTreeMap;

use chrono::{SecondsFormat, Utc};
use sqlx::{Sqlite, SqlitePool, Transaction};

use super::IndexError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceManifestRecord {
    pub source_path: String,
    pub source_kind: String,
    pub fingerprint: String,
    pub size_bytes: i64,
    pub modified_ns: i64,
    pub checked_at: String,
    pub diagnostic_code: Option<String>,
}

impl SourceManifestRecord {
    pub fn agent_context(source_path: String, fingerprint: String, size_bytes: usize) -> Self {
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

    pub fn equivalent(&self, other: &Self) -> bool {
        self.source_path == other.source_path
            && self.source_kind == other.source_kind
            && self.fingerprint == other.fingerprint
            && self.size_bytes == other.size_bytes
            && self.modified_ns == other.modified_ns
            && self.diagnostic_code == other.diagnostic_code
    }
}

pub async fn reconcile_source_record(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
    source_kind: &str,
    current: Option<&SourceManifestRecord>,
) -> Result<bool, IndexError> {
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

pub async fn read_generation(pool: &SqlitePool) -> Result<Option<i64>, IndexError> {
    Ok(
        sqlx::query_scalar("SELECT generation FROM knowledge_manifest WHERE singleton = 1")
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn read_revision(pool: &SqlitePool) -> Result<Option<i64>, IndexError> {
    Ok(
        sqlx::query_scalar("SELECT revision FROM knowledge_manifest WHERE singleton = 1")
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn read_source_manifest(
    pool: &SqlitePool,
) -> Result<Vec<SourceManifestRecord>, IndexError> {
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

pub async fn replace_source_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    records: &[SourceManifestRecord],
) -> Result<(), IndexError> {
    sqlx::query("DELETE FROM knowledge_source_manifest")
        .execute(&mut **tx)
        .await?;
    for record in records {
        insert_source_manifest(tx, record).await?;
    }
    Ok(())
}

pub async fn reconcile_source_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    previous: &[SourceManifestRecord],
    current: &[SourceManifestRecord],
) -> Result<bool, IndexError> {
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
) -> Result<(), IndexError> {
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

pub async fn advance_generation(
    tx: &mut Transaction<'_, Sqlite>,
    revision_changed: bool,
    generation_changed: bool,
) -> Result<(), IndexError> {
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

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}
