use std::path::Path;

use crate::AppError;

pub use svode_core::git::path::RootMode;

pub fn normalize_repo_relative(path: &str, root_policy: RootMode) -> Result<String, AppError> {
    Ok(svode_core::git::path::normalize_repo_relative(
        path,
        root_policy,
    )?)
}

pub fn repo_relative_from_path(path: &Path, root_policy: RootMode) -> Result<String, AppError> {
    Ok(svode_core::git::path::repo_relative_from_path(
        path,
        root_policy,
    )?)
}

pub fn repo_relative_from_base(
    base: &Path,
    path: &Path,
    root_policy: RootMode,
) -> Result<String, AppError> {
    Ok(svode_core::git::path::repo_relative_from_base(
        base,
        path,
        root_policy,
    )?)
}
