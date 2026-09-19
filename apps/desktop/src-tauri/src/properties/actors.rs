use std::path::Path;

use crate::error::AppError;
use crate::git::cli::GitCli;

pub use crate::actors::{ActorCandidate, ActorCatalogState};

pub async fn list_actors(
    cache: &ActorCatalogState,
    cli: &GitCli,
    space_path: &Path,
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(cache.snapshot(cli.core(), space_path).await?.candidates())
}

pub async fn refresh_actors(
    cache: &ActorCatalogState,
    cli: &GitCli,
    space_path: &Path,
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(cache.refresh(cli.core(), space_path).await?.candidates())
}
