use sqlx::{Sqlite, SqlitePool, Transaction};

use super::IndexError;
use super::model::{KnowledgeAgentApplicability, KnowledgeArtifact};

pub async fn replace_all(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
    applicability: &[KnowledgeAgentApplicability],
    skipped_count: usize,
    failure_count: usize,
) -> Result<(), IndexError> {
    sqlx::query("DELETE FROM knowledge_links")
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_fragments")
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_documents")
        .execute(&mut **tx)
        .await?;
    replace_applicability(tx, applicability).await?;
    for artifact in artifacts {
        insert_artifact(tx, artifact).await?;
    }
    refresh_manifest(tx, skipped_count, failure_count).await
}

pub async fn replace_agent_context(
    tx: &mut Transaction<'_, Sqlite>,
    artifacts: &[KnowledgeArtifact],
    applicability: &[KnowledgeAgentApplicability],
) -> Result<bool, IndexError> {
    let existing: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_path, content_hash FROM knowledge_documents \
         WHERE node_kind IN ('agent_instruction', 'skill') ORDER BY source_path",
    )
    .fetch_all(&mut **tx)
    .await?;
    let next = artifacts
        .iter()
        .map(|artifact| (artifact.source_path.clone(), artifact.content_hash.clone()))
        .collect::<Vec<_>>();
    let existing_applicability = read_agent_applicability_tx(tx).await?;
    if existing == next && existing_applicability == applicability {
        return Ok(false);
    }
    sqlx::query(
        "DELETE FROM knowledge_links WHERE source_path IN \
         (SELECT source_path FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill'))",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "DELETE FROM knowledge_fragments WHERE source_path IN \
         (SELECT source_path FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill'))",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "DELETE FROM knowledge_documents WHERE node_kind IN ('agent_instruction', 'skill')",
    )
    .execute(&mut **tx)
    .await?;
    for artifact in artifacts {
        delete_rows(tx, &artifact.source_path).await?;
        if let Ok(provenance) = serde_json::from_str::<serde_json::Value>(&artifact.provenance_json)
        {
            for alias in provenance
                .get("aliases")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
            {
                delete_rows(tx, alias).await?;
            }
        }
        insert_artifact(tx, artifact).await?;
    }
    replace_applicability(tx, applicability).await?;
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
}

async fn replace_applicability(
    tx: &mut Transaction<'_, Sqlite>,
    applicability: &[KnowledgeAgentApplicability],
) -> Result<(), IndexError> {
    sqlx::query("DELETE FROM knowledge_agent_applicability")
        .execute(&mut **tx)
        .await?;
    for row in applicability {
        sqlx::query(
            "INSERT INTO knowledge_agent_applicability \
             (source_scope,source_path,node_kind,provenance_json) VALUES (?,?,?,?)",
        )
        .bind(&row.source_scope)
        .bind(&row.source_path)
        .bind(&row.node_kind)
        .bind(serde_json::to_string(&row.provenance).unwrap_or_else(|_| "{}".to_string()))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn read_agent_applicability_tx(
    tx: &mut Transaction<'_, Sqlite>,
) -> Result<Vec<KnowledgeAgentApplicability>, IndexError> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT source_scope,source_path,node_kind,provenance_json \
         FROM knowledge_agent_applicability ORDER BY source_scope,node_kind,source_path",
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(applicability_rows(rows))
}

pub async fn read_agent_applicability(
    pool: &SqlitePool,
) -> Result<Vec<KnowledgeAgentApplicability>, IndexError> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT source_scope,source_path,node_kind,provenance_json \
         FROM knowledge_agent_applicability ORDER BY source_scope,node_kind,source_path",
    )
    .fetch_all(pool)
    .await?;
    Ok(applicability_rows(rows))
}

fn applicability_rows(
    rows: Vec<(String, String, String, String)>,
) -> Vec<KnowledgeAgentApplicability> {
    rows.into_iter()
        .map(|row| KnowledgeAgentApplicability {
            source_scope: row.0,
            source_path: row.1,
            node_kind: row.2,
            provenance: serde_json::from_str(&row.3).unwrap_or_else(|_| serde_json::json!({})),
        })
        .collect()
}

pub async fn upsert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<bool, IndexError> {
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT node_kind, content_hash FROM knowledge_documents WHERE source_path = ?",
    )
    .bind(&artifact.source_path)
    .fetch_optional(&mut **tx)
    .await?;
    if existing
        .as_ref()
        .is_some_and(|(kind, hash)| kind == &artifact.kind && hash == &artifact.content_hash)
    {
        return Ok(false);
    }
    delete_rows(tx, &artifact.source_path).await?;
    insert_artifact(tx, artifact).await?;
    refresh_manifest_preserving_diagnostics(tx).await?;
    Ok(true)
}

pub async fn delete_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
) -> Result<bool, IndexError> {
    let deleted = delete_rows(tx, source_path).await?;
    if deleted {
        refresh_manifest_preserving_diagnostics(tx).await?;
    }
    Ok(deleted)
}

async fn delete_rows(
    tx: &mut Transaction<'_, Sqlite>,
    source_path: &str,
) -> Result<bool, IndexError> {
    sqlx::query("DELETE FROM knowledge_links WHERE source_path = ?")
        .bind(source_path)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM knowledge_fragments WHERE source_path = ?")
        .bind(source_path)
        .execute(&mut **tx)
        .await?;
    Ok(
        sqlx::query("DELETE FROM knowledge_documents WHERE source_path = ?")
            .bind(source_path)
            .execute(&mut **tx)
            .await?
            .rows_affected()
            > 0,
    )
}

async fn insert_artifact(
    tx: &mut Transaction<'_, Sqlite>,
    artifact: &KnowledgeArtifact,
) -> Result<(), IndexError> {
    sqlx::query(
        "INSERT INTO knowledge_documents \
         (source_path, node_kind, title, content_hash, source_updated_at, checked_at, canonical_source_path, provenance_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&artifact.source_path)
    .bind(&artifact.kind)
    .bind(&artifact.title)
    .bind(&artifact.content_hash)
    .bind(&artifact.source_updated_at)
    .bind(&artifact.checked_at)
    .bind(&artifact.canonical_source_path)
    .bind(&artifact.provenance_json)
    .execute(&mut **tx)
    .await?;
    for (ordinal, fragment) in artifact.fragments.iter().enumerate() {
        sqlx::query(
            "INSERT INTO knowledge_fragments \
             (source_path, ordinal, text, content_hash, location_path, line_start, line_end, byte_start, byte_end) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&artifact.source_path)
        .bind(ordinal as i64)
        .bind(&fragment.text)
        .bind(&artifact.content_hash)
        .bind(&fragment.location_path)
        .bind(fragment.line_start)
        .bind(fragment.line_end)
        .bind(fragment.byte_start)
        .bind(fragment.byte_end)
        .execute(&mut **tx)
        .await?;
    }
    for edge in &artifact.edges {
        sqlx::query(
            "INSERT OR IGNORE INTO knowledge_links \
             (source_path, edge_kind, target_url, target_scope, target_path, target_kind, field_name, location_path, byte_start, byte_end, origin) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'explicit')",
        )
        .bind(&artifact.source_path)
        .bind(&edge.kind)
        .bind(&edge.target_url)
        .bind(&edge.target_scope)
        .bind(&edge.target_path)
        .bind(&edge.target_kind)
        .bind(&edge.field_name)
        .bind(&edge.location_path)
        .bind(edge.byte_start)
        .bind(edge.byte_end)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn refresh_manifest_preserving_diagnostics(
    tx: &mut Transaction<'_, Sqlite>,
) -> Result<(), IndexError> {
    let diagnostics: Option<(i64, i64)> = sqlx::query_as(
        "SELECT skipped_count, failure_count FROM knowledge_manifest WHERE singleton = 1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let (skipped, failures) = diagnostics.unwrap_or((0, 0));
    refresh_manifest(tx, skipped as usize, failures as usize).await
}

async fn refresh_manifest(
    tx: &mut Transaction<'_, Sqlite>,
    skipped_count: usize,
    failure_count: usize,
) -> Result<(), IndexError> {
    let node_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_documents")
        .fetch_one(&mut **tx)
        .await?;
    let edge_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_links")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO knowledge_manifest \
         (singleton, checked_at, document_count, link_count, skipped_count, failure_count) \
         VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET \
         checked_at=excluded.checked_at, document_count=excluded.document_count, \
         link_count=excluded.link_count, skipped_count=excluded.skipped_count, failure_count=excluded.failure_count",
    )
    .bind(super::manifest::now())
    .bind(node_count)
    .bind(edge_count)
    .bind(skipped_count as i64)
    .bind(failure_count as i64)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
