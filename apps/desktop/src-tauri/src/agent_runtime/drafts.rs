//! Desktop keeping of what the agent runtime leaves to its host for
//! announcements without a started session (Stage 11 `03`): the agents'
//! last declarations per model and the draft sessions still to delete, in
//! the app data of the device, outside projects and Git. The rules belong
//! to `svode_agents::drafts` and the runtime.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use svode_agents::drafts::{AgentDeclaration, DraftHost, PendingDeletion};

const DRAFTS_FILE: &str = "agent-drafts.json";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeptDrafts {
    #[serde(default)]
    pub declarations: Vec<AgentDeclaration>,
    #[serde(default)]
    pub pending_deletions: Vec<PendingDeletion>,
}

/// The file of the device that keeps them; each change rewrites it whole.
pub(crate) struct DraftStore {
    path: PathBuf,
    kept: Mutex<KeptDrafts>,
}

impl DraftStore {
    /// The store in `data_dir` with what it kept before; an unreadable file
    /// starts empty, since its content is derived or retried state.
    pub(crate) fn load(data_dir: &Path) -> (Self, KeptDrafts) {
        let path = data_dir.join(DRAFTS_FILE);
        let kept = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!("{DRAFTS_FILE} is unreadable: {error}");
                KeptDrafts::default()
            }),
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("{DRAFTS_FILE} is unreadable: {error}");
                }
                KeptDrafts::default()
            }
        };
        let store = Self {
            path,
            kept: Mutex::new(kept.clone()),
        };
        (store, kept)
    }

    fn write(&self, change: impl FnOnce(&mut KeptDrafts)) {
        let mut kept = self.kept.lock().unwrap();
        change(&mut kept);
        if let Err(error) = write_atomic(&self.path, &kept) {
            tracing::warn!("{DRAFTS_FILE} was not written: {error}");
        }
    }
}

impl DraftHost for DraftStore {
    fn declarations_changed(&self, declarations: &[AgentDeclaration]) {
        self.write(|kept| kept.declarations = declarations.to_vec());
    }

    fn pending_deletions_changed(&self, pending: &[PendingDeletion]) {
        self.write(|kept| kept.pending_deletions = pending.to_vec());
    }
}

fn write_atomic(path: &Path, kept: &KeptDrafts) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let staged = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(staged.as_file(), kept)?;
    staged.as_file().sync_all()?;
    staged.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_drafts_survive_a_restart_and_an_unreadable_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let (store, kept) = DraftStore::load(dir.path());
        assert!(kept.declarations.is_empty() && kept.pending_deletions.is_empty());
        let pending = PendingDeletion {
            agent: "opencode".into(),
            session_id: "ses_1".into(),
        };
        store.pending_deletions_changed(std::slice::from_ref(&pending));
        let declaration = AgentDeclaration {
            agent: "grok-build".into(),
            model: Some("grok-5".into()),
            settings: Vec::new(),
            declared_at: 1,
            agent_version: Some("1.0.70".into()),
        };
        store.declarations_changed(std::slice::from_ref(&declaration));

        let (_, kept) = DraftStore::load(dir.path());
        assert_eq!(kept.pending_deletions, [pending]);
        assert_eq!(kept.declarations, [declaration]);

        std::fs::write(dir.path().join(DRAFTS_FILE), b"{").unwrap();
        let (_, kept) = DraftStore::load(dir.path());
        assert!(kept.declarations.is_empty() && kept.pending_deletions.is_empty());
    }
}
