use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::pending::PendingPaths;

#[derive(Default)]
pub struct GitRepositoryState {
    pending: Arc<PendingPaths>,
    locks: tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitRepositoryState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| {
            path.parent()
                .and_then(|parent| std::fs::canonicalize(parent).ok())
                .zip(path.file_name())
                .map(|(parent, name)| parent.join(name))
                .unwrap_or_else(|| path.to_path_buf())
        });
        let mut locks = self.locks.lock().await;
        locks
            .entry(canonical)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn pending(&self) -> Arc<PendingPaths> {
        self.pending.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn canonical_repository_aliases_share_one_lock() {
        let state = GitRepositoryState::new();
        let repository = tempfile::tempdir().unwrap();
        let direct = state.get_lock(repository.path()).await;
        let aliased = state.get_lock(&repository.path().join(".")).await;
        assert!(Arc::ptr_eq(&direct, &aliased));
    }
}
