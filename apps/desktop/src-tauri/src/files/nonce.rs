use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(3);

/// Short-TTL registry of (canonical_abs_path → nonce) pairs populated by
/// `write_entry` and consumed by the file watcher. Lets the watcher attach a
/// `writeNonce` to `file:changed` payloads so the editor can filter its own
/// echoes after an auto-save write.
pub struct WriteNonceRegistry {
    entries: Mutex<HashMap<PathBuf, (WriteOriginMetadata, Instant)>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WriteOriginMetadata {
    pub nonce: String,
    pub routine_run_id: Option<String>,
    pub origin: String,
}

impl WriteNonceRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Register a nonce for the given absolute path; overwrites any previous entry.
    pub fn register(&self, abs_path: PathBuf, nonce: String) {
        self.register_with_origin(abs_path, nonce, None, "managed");
    }

    pub(crate) fn register_with_origin(
        &self,
        abs_path: PathBuf,
        nonce: String,
        routine_run_id: Option<String>,
        origin: impl Into<String>,
    ) {
        let mut map = self.entries.lock().unwrap();
        self.sweep(&mut map);
        map.insert(
            abs_path,
            (
                WriteOriginMetadata {
                    nonce,
                    routine_run_id,
                    origin: origin.into(),
                },
                Instant::now(),
            ),
        );
    }

    pub(crate) fn take_metadata(&self, abs_path: &std::path::Path) -> Option<WriteOriginMetadata> {
        let mut map = self.entries.lock().unwrap();
        self.sweep(&mut map);
        let (metadata, _) = map.remove(abs_path)?;
        Some(metadata)
    }

    fn sweep(&self, map: &mut HashMap<PathBuf, (WriteOriginMetadata, Instant)>) {
        let now = Instant::now();
        map.retain(|_, (_, t)| now.duration_since(*t) <= TTL);
    }
}

impl Default for WriteNonceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_metadata_preserves_frontend_nonce_and_routine_lineage() {
        let registry = WriteNonceRegistry::new();
        let path = PathBuf::from("/tmp/svode-routine-origin.md");
        registry.register_with_origin(
            path.clone(),
            "nonce-1".to_string(),
            Some("routine-run-1".to_string()),
            "routine_update_properties",
        );

        assert_eq!(
            registry.take_metadata(&path),
            Some(WriteOriginMetadata {
                nonce: "nonce-1".to_string(),
                routine_run_id: Some("routine-run-1".to_string()),
                origin: "routine_update_properties".to_string(),
            })
        );
        assert!(registry.take_metadata(&path).is_none());
    }

    #[test]
    fn legacy_registration_maps_to_managed_origin() {
        let registry = WriteNonceRegistry::new();
        let path = PathBuf::from("/tmp/svode-managed-origin.md");
        registry.register(path.clone(), "nonce-2".to_string());

        assert_eq!(
            registry.take_metadata(&path),
            Some(WriteOriginMetadata {
                nonce: "nonce-2".to_string(),
                routine_run_id: None,
                origin: "managed".to_string(),
            })
        );
    }
}
