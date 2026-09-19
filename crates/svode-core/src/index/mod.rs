pub mod backlinks;
pub mod db;
pub mod entry_projection;
pub mod inventory;
pub mod knowledge_artifact;
pub mod knowledge_rows;
pub mod lifecycle;
pub mod manifest;
pub mod model;
pub mod reconcile;
pub mod reindex;
pub mod resolver;
pub mod retention;
pub mod retention_wal;
pub mod rows;
pub mod state;
pub mod update;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IndexKey {
    Root(std::path::PathBuf),
    Space {
        project: std::path::PathBuf,
        space_id: String,
    },
}

impl IndexKey {
    pub fn project(&self) -> &std::path::Path {
        match self {
            Self::Root(project) | Self::Space { project, .. } => project,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Git path error: {0}")]
    Git(#[from] crate::git::GitError),
    #[error("Agent Context error: {0}")]
    AgentContext(#[from] crate::agent_context::AgentContextError),
    #[error("Space not found: {0}")]
    SpaceNotFound(String),
    #[error("Index error: {0}")]
    Index(String),
}

pub async fn open_prepared_pool(db_path: &std::path::Path) -> Result<sqlx::SqlitePool, IndexError> {
    let (reason, found) = match db::create_pool(db_path).await {
        Ok(pool) => match db::schema_status(&pool).await {
            Ok(db::SchemaStatus::Current) => return Ok(pool),
            Ok(db::SchemaStatus::Uninitialized) => {
                if let Err(error) = db::ensure_schema(&pool).await {
                    db::close_pool(&pool).await;
                    return Err(error);
                }
                return Ok(pool);
            }
            Ok(db::SchemaStatus::Incompatible(found)) => {
                db::close_pool(&pool).await;
                (db::QuarantineReason::Incompatible, found)
            }
            Err(error) => {
                db::close_pool(&pool).await;
                if !db::is_corrupt_database_error(&error) {
                    return Err(error);
                }
                (db::QuarantineReason::Corrupt, None)
            }
        },
        Err(error) if db::is_corrupt_database_error(&error) => {
            (db::QuarantineReason::Corrupt, None)
        }
        Err(error) => return Err(error),
    };
    tracing::warn!(
        store = "index",
        owner = %db_path.display(),
        ?reason,
        ?found,
        expected = db::SCHEMA_VERSION,
        "quarantining index database family; source rebuild required"
    );
    db::quarantine_database_family(db_path, reason)?;
    let replacement = db::create_pool(db_path).await?;
    if let Err(error) = db::ensure_schema(&replacement).await {
        db::close_pool(&replacement).await;
        return Err(error);
    }
    tracing::info!(
        store = "index",
        owner = %db_path.display(),
        expected = db::SCHEMA_VERSION,
        "replacement index schema ready; source reconciliation pending"
    );
    Ok(replacement)
}
