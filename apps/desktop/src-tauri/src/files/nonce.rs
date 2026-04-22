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
    entries: Mutex<HashMap<PathBuf, (String, Instant)>>,
}

impl WriteNonceRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Register a nonce for the given absolute path; overwrites any previous entry.
    pub fn register(&self, abs_path: PathBuf, nonce: String) {
        let mut map = self.entries.lock().unwrap();
        self.sweep(&mut map);
        map.insert(abs_path, (nonce, Instant::now()));
    }

    /// Look up and consume the nonce for `abs_path` if still within TTL.
    pub fn take(&self, abs_path: &std::path::Path) -> Option<String> {
        let mut map = self.entries.lock().unwrap();
        self.sweep(&mut map);
        let (nonce, _) = map.remove(abs_path)?;
        Some(nonce)
    }

    fn sweep(&self, map: &mut HashMap<PathBuf, (String, Instant)>) {
        let now = Instant::now();
        map.retain(|_, (_, t)| now.duration_since(*t) <= TTL);
    }
}

impl Default for WriteNonceRegistry {
    fn default() -> Self {
        Self::new()
    }
}
