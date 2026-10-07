//! A native status source whose store keeps one log per session, possibly
//! with files read together with it, such as the session's process file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{
    NativeLogFile, NativeLogRead, NativeStatusSource, SourceReads, StoreRead, TurnEvidence,
};

/// A session id missing from the log index rebuilds it at most this often:
/// a new session's log appears after the agent lists it.
const INDEX_REBUILD_AFTER: Duration = Duration::from_secs(5);

/// Where an agent keeps its session logs and how one is read.
pub(crate) trait SessionLogLayout: Send + Sync {
    /// The agent's session logs by session id.
    fn index(&self) -> HashMap<String, PathBuf>;

    /// Files read together with the session's log; a change of any of them,
    /// or one appearing or going, reads the session again.
    fn companions(&self, _log: &Path) -> Vec<PathBuf> {
        Vec::new()
    }

    /// The session's status from its log and companions. An error is a
    /// problem of the whole source, such as an unknown format version (N5).
    fn read(&self, log: &Path) -> Result<StoreRead, String>;

    fn turn_evidence(&self) -> TurnEvidence {
        TurnEvidence::ProcessSignal
    }
}

/// Reads of the agent's session logs, kept per session and repeated only
/// for a session whose files changed, with the index of its logs by session
/// id.
pub(crate) struct SessionLogs<L> {
    layout: L,
    state: Mutex<LogsState>,
}

#[derive(Default)]
struct LogsState {
    reads: HashMap<String, NativeLogRead>,
    index: Option<LogIndex>,
}

struct LogIndex {
    files: HashMap<String, PathBuf>,
    built: Instant,
}

impl<L: SessionLogLayout> SessionLogs<L> {
    pub(crate) fn new(layout: L) -> Self {
        Self {
            layout,
            state: Mutex::new(LogsState::default()),
        }
    }

    fn companions(&self, log: &Path) -> Vec<NativeLogFile> {
        self.layout
            .companions(log)
            .iter()
            .filter_map(|path| NativeLogFile::stat(path))
            .collect()
    }
}

impl<L: SessionLogLayout> NativeStatusSource for SessionLogs<L> {
    fn read(&self, ids: &[&str]) -> Result<SourceReads, String> {
        let mut targets = Vec::new();
        let mut missing = Vec::new();
        let rebuild_index = {
            let state = self.state.lock().unwrap();
            let index = state.index.as_ref();
            for id in ids {
                if let Some((known, file)) = state
                    .reads
                    .get(*id)
                    .and_then(|known| Some((known, known.file.as_ref()?)))
                {
                    targets.push((*id, file.path.clone(), Some(known.clone())));
                } else if let Some(path) = index.and_then(|index| index.files.get(*id)) {
                    targets.push((*id, path.clone(), None));
                } else {
                    missing.push(*id);
                }
            }
            !missing.is_empty()
                && index.is_none_or(|index| index.built.elapsed() >= INDEX_REBUILD_AFTER)
        };
        if rebuild_index {
            let files = self.layout.index();
            for id in missing {
                if let Some(path) = files.get(id) {
                    targets.push((id, path.clone(), None));
                }
            }
            self.state.lock().unwrap().index = Some(LogIndex {
                files,
                built: Instant::now(),
            });
        }

        let mut reads = SourceReads::default();
        let mut gone = Vec::new();
        let mut problem = None;
        for (id, path, known) in targets {
            // Stat before reading: a log that grows meanwhile is read again.
            let Some(file) = NativeLogFile::stat(&path) else {
                gone.push(id);
                continue;
            };
            let companions = self.companions(&path);
            if let Some(known) = known.filter(|known| {
                known.file.as_ref() == Some(&file) && known.companions == companions
            }) {
                reads.sessions.insert(id.to_string(), known);
                continue;
            }
            let read = match self.layout.read(&path) {
                Ok(read) => read,
                Err(error) => {
                    problem.get_or_insert(error);
                    continue;
                }
            };
            reads.reparsed += 1;
            reads.sessions.insert(
                id.to_string(),
                NativeLogRead {
                    file: Some(file),
                    companions,
                    status: read.status,
                    launch_id: read.launch_id,
                    process: read.process,
                },
            );
        }

        let mut state = self.state.lock().unwrap();
        for id in gone {
            // A moved log is found again by the next index rebuild.
            state.reads.remove(id);
            if let Some(index) = state.index.as_mut() {
                index.files.remove(id);
            }
        }
        for (id, read) in &reads.sessions {
            state.reads.insert(id.clone(), read.clone());
        }
        match problem {
            Some(problem) => Err(problem),
            None => Ok(reads),
        }
    }

    /// A read saved before the app started; a newer read is kept.
    fn seed(&self, id: &str, read: NativeLogRead) {
        if read.file.is_some() {
            self.state
                .lock()
                .unwrap()
                .reads
                .entry(id.to_string())
                .or_insert(read);
        }
    }

    fn turn_evidence(&self) -> TurnEvidence {
        self.layout.turn_evidence()
    }
}
