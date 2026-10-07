//! Native catalogue sources of the Sessions read-model (Stage 10 `07` N1,
//! N2): the origins of an agent whose description declares a reader of its
//! store instead of its ACP list. A source is read at the list triggers of
//! C3, open project and periodic poll among them, since it starts no agent
//! process; off the list response path, under a bounded time, and only for
//! an available agent (`03` A1). Its last good read stays, a failed or slow
//! read marks only its own source `stale`. The read-model merges these
//! entries with the ACP lists by key, as one more source of the catalogue.

pub(crate) mod cursor_chats;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use svode_agents::catalog::{ListBounds, ListedSession};
use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_agents::registry::{AdapterRuntimeRegistry, CatalogSource, NativeCatalogStore};
use svode_core::agent_adapters::{AgentAdapterKind, AgentId};
use tauri::async_runtime::JoinHandle;

use super::StoreRoot;
use super::native_status::hermes;
use super::types::{
    AgentSessionDiagnosticSeverity, AgentSessionSourceReport, AgentSessionSourceStatus,
};

/// A read of a store that takes longer marks its source `stale`.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// What a native catalogue source knows of a session besides its list
/// fields (Stage 10 `07` N2, N6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeListing {
    /// The native id the agent continues the session under, in the chat and
    /// in its terminal: the tip of a Hermes chain.
    pub resume_id: String,
    /// The agent profile whose store holds the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// The agent loads the session's origin over ACP, so it opens in the
    /// chat; any other origin continues in the terminal.
    pub opens_in_chat: bool,
    /// The agent's terminal continues the session by `resume_id`: not a
    /// Cursor terminal chat its CLI would no longer find from its folder,
    /// nor an origin without a terminal command.
    #[serde(default = "continues_unless_told")]
    pub continues_in_terminal: bool,
    /// Native ids of the session's other links; a key saved with one of
    /// them addresses this session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// A listing saved before slice 8.4 continues in the terminal.
fn continues_unless_told() -> bool {
    true
}

/// One session of a catalogue source: its list fields and, from a native
/// source, what it knows besides.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CatalogEntry {
    pub listed: ListedSession,
    pub listing: Option<NativeListing>,
}

impl CatalogEntry {
    pub(crate) fn listed(listed: ListedSession) -> Self {
        Self {
            listed,
            listing: None,
        }
    }
}

/// A source's sessions as one read found them.
#[derive(Debug, Default)]
pub(crate) struct NativeList {
    pub sessions: Vec<CatalogEntry>,
    /// The store had more sessions than the read keeps.
    pub truncated: bool,
    /// Records of the store the read could not use (N5, N7).
    pub skipped: usize,
}

type SourceKey = (AgentId, NativeCatalogStore);

/// Where each native catalogue store lives (`07` N7), found when it is
/// read.
#[derive(Clone)]
pub(crate) struct CatalogRoots {
    /// The Hermes home.
    pub hermes_home: StoreRoot,
    /// The Cursor CLI config directory.
    pub cursor_config: StoreRoot,
}

impl CatalogRoots {
    fn root(&self, store: NativeCatalogStore) -> PathBuf {
        match store {
            NativeCatalogStore::HermesStates => (self.hermes_home)(),
            NativeCatalogStore::CursorChats => (self.cursor_config)(),
        }
    }
}

pub(crate) struct NativeCatalogSources {
    roots: CatalogRoots,
    sources: Mutex<BTreeMap<SourceKey, SourceList>>,
}

struct SourceList {
    last_good: Option<LastGood>,
    /// Why the last good read may be out of date.
    problem: Option<String>,
    reading: bool,
    /// The agent was available at the last refresh; a source of an agent
    /// the user disabled keeps its last good read and is not read (N1).
    available: bool,
}

struct LastGood {
    list: NativeList,
    read_at: DateTime<Utc>,
    duration_ms: u128,
}

/// One native source's catalogue as the read-model merges it.
pub(crate) struct NativeCatalogRead {
    pub source: AgentId,
    pub store: NativeCatalogStore,
    pub sessions: Vec<CatalogEntry>,
    pub report: AgentSessionSourceReport,
    /// When the last good read was made; `None` before any good read.
    pub read_at: Option<DateTime<Utc>>,
}

impl NativeCatalogSources {
    pub(crate) fn new(roots: CatalogRoots) -> Self {
        Self {
            roots,
            sources: Mutex::new(BTreeMap::new()),
        }
    }

    /// Starts a read of every native source of these available agents that
    /// is not being read already and returns at once; the sources of the
    /// other agents stay as they are and are no longer read.
    pub(crate) fn refresh(self: &Arc<Self>, available: &[AgentAdapterKind]) -> Vec<JoinHandle<()>> {
        let available = available.iter().copied().collect::<HashSet<_>>();
        let mut sources = self.sources.lock().unwrap();
        let mut reads = Vec::new();
        for agent in AgentAdapterKind::ALL {
            for store in native_stores(agent) {
                let key = (agent.id(), store);
                let source = sources.entry(key.clone()).or_insert(SourceList {
                    last_good: None,
                    problem: None,
                    reading: false,
                    available: false,
                });
                source.available = available.contains(&agent);
                if !source.available || source.reading {
                    continue;
                }
                source.reading = true;
                let this = self.clone();
                reads.push(tauri::async_runtime::spawn(async move {
                    let started = Instant::now();
                    let roots = this.roots.clone();
                    let mut read = tauri::async_runtime::spawn_blocking(move || {
                        read_store(store, &roots.root(store))
                    });
                    let result = match tokio::time::timeout(READ_TIMEOUT, &mut read).await {
                        Ok(joined) => joined,
                        Err(_) => {
                            this.slow(&key);
                            read.await
                        }
                    };
                    let result = result
                        .map_err(|error| error.to_string())
                        .and_then(|read| read);
                    this.apply(&key, result, started.elapsed().as_millis());
                }));
            }
        }
        reads
    }

    fn slow(&self, key: &SourceKey) {
        if let Some(source) = self.sources.lock().unwrap().get_mut(key) {
            source.problem = Some(format!(
                "reading the store takes longer than {} s",
                READ_TIMEOUT.as_secs()
            ));
        }
    }

    pub(super) fn apply(
        &self,
        key: &SourceKey,
        result: Result<NativeList, String>,
        duration_ms: u128,
    ) {
        let mut sources = self.sources.lock().unwrap();
        let source = sources.entry(key.clone()).or_insert(SourceList {
            last_good: None,
            problem: None,
            reading: false,
            available: true,
        });
        source.reading = false;
        match result {
            Ok(list) => {
                source.last_good = Some(LastGood {
                    list,
                    read_at: Utc::now(),
                    duration_ms,
                });
                source.problem = None;
            }
            Err(problem) => source.problem = Some(problem),
        }
    }

    /// Whether the agent's store may be read: not when the user disabled
    /// an agent with a native catalogue (N1).
    pub(crate) fn reads_store(&self, agent: &AgentId) -> bool {
        !self
            .sources
            .lock()
            .unwrap()
            .iter()
            .any(|((source, _), list)| source == agent && !list.available)
    }

    /// The last good read of every native source read so far, with its
    /// report.
    pub(crate) fn reads(&self) -> Vec<NativeCatalogRead> {
        self.sources
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, list)| list.last_good.is_some() || list.problem.is_some())
            .map(|((agent, store), list)| read_of(agent.clone(), *store, list))
            .collect()
    }
}

/// The native catalogue stores the agent's description declares.
fn native_stores(agent: AgentAdapterKind) -> impl Iterator<Item = NativeCatalogStore> {
    AdapterRuntimeRegistry
        .catalog_sources(agent)
        .iter()
        .filter_map(|source| match source {
            CatalogSource::Native(store) => Some(*store),
            CatalogSource::AcpList => None,
        })
}

fn read_store(store: NativeCatalogStore, root: &Path) -> Result<NativeList, String> {
    let bounds = ListBounds::default();
    match store {
        NativeCatalogStore::HermesStates => hermes_list(root, &bounds),
        NativeCatalogStore::CursorChats => cursor_chats::list(root, &bounds),
    }
}

/// The Hermes conversations the catalogue lists (N2, N7): with a folder and
/// messages at the tip, keyed by the root, continued at the tip in the
/// profile whose store holds them; the newest first within the bounds.
fn hermes_list(root: &Path, bounds: &ListBounds) -> Result<NativeList, String> {
    let agent = AgentAdapterKind::Hermes.as_str();
    let mut conversations = hermes::conversations(root)?
        .into_iter()
        .filter(|conversation| conversation.has_messages)
        .filter_map(|conversation| {
            let cwd = conversation
                .cwd
                .clone()
                .filter(|cwd| cwd.len() <= bounds.cwd_bytes && Path::new(cwd).is_absolute())?;
            let updated_at = conversation.updated_at?;
            Some((updated_at, cwd, conversation))
        })
        .collect::<Vec<_>>();
    conversations.sort_by_key(|(updated_at, _, _)| std::cmp::Reverse(*updated_at));
    let truncated = conversations.len() > bounds.sessions;
    conversations.truncate(bounds.sessions);
    let sessions = conversations
        .into_iter()
        .map(|(updated_at, cwd, conversation)| CatalogEntry {
            listed: ListedSession {
                key: SessionKey {
                    agent: agent.to_string(),
                    namespace: IdentityNamespace::Native,
                    session_id: conversation.root.clone(),
                },
                cwd: PathBuf::from(cwd),
                title: conversation
                    .title
                    .map(|title| bounded(title.trim(), bounds.title_bytes).to_string()),
                updated_at: Some(updated_at.to_rfc3339_opts(SecondsFormat::Secs, true)),
            },
            listing: Some(NativeListing {
                resume_id: conversation.tip.clone(),
                profile: Some(conversation.profile),
                opens_in_chat: conversation.acp,
                continues_in_terminal: true,
                aliases: conversation
                    .links
                    .into_iter()
                    .filter(|link| *link != conversation.root)
                    .collect(),
            }),
        })
        .collect();
    Ok(NativeList {
        sessions,
        truncated,
        skipped: 0,
    })
}

/// The longest prefix of `text` within `bytes`, on a character boundary.
fn bounded(text: &str, bytes: usize) -> &str {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn read_of(source: AgentId, store: NativeCatalogStore, list: &SourceList) -> NativeCatalogRead {
    let mut report = AgentSessionSourceReport::new(source.clone());
    let agent = source
        .builtin()
        .map_or(source.as_str(), |agent| agent.display_name())
        .to_string();
    let mut sessions = Vec::new();
    if let Some(last_good) = &list.last_good {
        report.read_at = Some(last_good.read_at.to_rfc3339_opts(SecondsFormat::Secs, true));
        report.duration_ms = Some(last_good.duration_ms);
        report.counts.records_read = last_good.list.sessions.len();
        report.counts.candidates = last_good.list.sessions.len();
        if last_good.list.skipped > 0 {
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Info,
                "native-catalog-skipped",
                format!(
                    "{} sessions in the store of {agent} were not shown: their records cannot be read",
                    last_good.list.skipped
                ),
            );
        }
        if last_good.list.truncated {
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Warning,
                "native-catalog-truncated",
                format!("{agent} has more sessions than Svode reads; older sessions are not shown"),
            );
        }
        sessions = last_good.list.sessions.clone();
    }
    if let Some(problem) = &list.problem {
        report.status = AgentSessionSourceStatus::Stale;
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            "native-catalog-stale",
            if list.last_good.is_some() {
                format!("Showing the last sessions read from the store of {agent}: {problem}")
            } else {
                format!("The sessions of {agent} cannot be read from its store: {problem}")
            },
        );
    }
    NativeCatalogRead {
        source,
        store,
        sessions,
        report,
        read_at: list.last_good.as_ref().map(|last_good| last_good.read_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::native_status::hermes::tests::{session, store};

    fn at(root: PathBuf) -> CatalogRoots {
        let hermes_home: StoreRoot = Arc::new(move || root.clone());
        CatalogRoots {
            hermes_home,
            cursor_config: Arc::new(|| PathBuf::from("/nonexistent")),
        }
    }

    fn hermes_key() -> SourceKey {
        (
            AgentAdapterKind::Hermes.id(),
            NativeCatalogStore::HermesStates,
        )
    }

    #[test]
    fn a_hermes_conversation_is_listed_under_its_root_and_continued_at_its_tip() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        store(
            &root.join("state.db"),
            &[
                session(
                    "r",
                    "acp",
                    None,
                    "end_reason = 'compression', model_config = '{\"cwd\":\"/w\"}'",
                ),
                session(
                    "t",
                    "acp",
                    None,
                    "parent_session_id = 'r', started_at = 1800000200, \
                     model_config = '{\"cwd\":\"/w\"}'",
                ),
                session("cli", "cli", Some("/w"), ""),
                session("no-cwd", "cli", None, ""),
                session("relative", "cli", Some("w"), ""),
                session("silent", "cli", Some("/w"), "message_count = 0"),
            ]
            .concat(),
        );
        store(
            &root.join("profiles/work/state.db"),
            &session("work", "tui", Some("/w"), ""),
        );

        let list = hermes_list(&root, &ListBounds::default()).unwrap();
        let by_id = |id: &str| {
            list.sessions
                .iter()
                .find(|entry| entry.listed.key.session_id == id)
                .unwrap_or_else(|| panic!("no {id}"))
        };
        assert_eq!(list.sessions.len(), 3);
        let chain = by_id("r");
        assert_eq!(chain.listed.key.namespace, IdentityNamespace::Native);
        assert_eq!(chain.listed.cwd, PathBuf::from("/w"));
        let listing = chain.listing.as_ref().unwrap();
        assert_eq!(listing.resume_id, "t");
        assert_eq!(listing.aliases, ["t"]);
        assert!(listing.opens_in_chat);
        assert_eq!(listing.profile.as_deref(), Some("default"));
        let cli = by_id("cli").listing.as_ref().unwrap();
        assert!(!cli.opens_in_chat);
        assert_eq!(cli.resume_id, "cli");
        assert_eq!(
            by_id("work").listing.as_ref().unwrap().profile.as_deref(),
            Some("work")
        );

        let bounded = hermes_list(
            &root,
            &ListBounds {
                sessions: 1,
                ..ListBounds::default()
            },
        )
        .unwrap();
        assert!(bounded.truncated);
        assert_eq!(bounded.sessions.len(), 1);
    }

    #[test]
    fn a_failed_read_keeps_the_last_good_sessions_and_marks_its_source_stale() {
        let sources = NativeCatalogSources::new(at(PathBuf::from("/nonexistent")));
        let entry = CatalogEntry::listed(ListedSession {
            key: SessionKey {
                agent: "hermes".into(),
                namespace: IdentityNamespace::Native,
                session_id: "h1".into(),
            },
            cwd: PathBuf::from("/w"),
            title: None,
            updated_at: Some("2026-10-07T10:00:00Z".into()),
        });
        sources.apply(
            &hermes_key(),
            Ok(NativeList {
                sessions: vec![entry],
                truncated: false,
                skipped: 0,
            }),
            2,
        );
        sources.apply(&hermes_key(), Err("database is locked".into()), 3);

        let reads = sources.reads();
        assert_eq!(reads.len(), 1);
        assert_eq!(reads[0].sessions.len(), 1, "the last good read stays");
        assert_eq!(reads[0].report.status, AgentSessionSourceStatus::Stale);
        let diagnostic = &reads[0].report.diagnostics[0];
        assert_eq!(diagnostic.code, "native-catalog-stale");
        assert!(
            diagnostic.message.contains("Hermes"),
            "{}",
            diagnostic.message
        );
        assert!(diagnostic.message.contains("database is locked"));
    }

    #[test]
    fn records_a_read_skipped_are_a_diagnostic_of_its_source() {
        let sources = NativeCatalogSources::new(at(PathBuf::from("/nonexistent")));
        sources.apply(
            &hermes_key(),
            Ok(NativeList {
                skipped: 2,
                ..NativeList::default()
            }),
            1,
        );
        let report = &sources.reads()[0].report;
        assert_eq!(report.status, AgentSessionSourceStatus::Ok);
        assert_eq!(report.diagnostics[0].code, "native-catalog-skipped");
        assert!(report.diagnostics[0].message.starts_with("2 sessions"));
    }

    fn settle(reads: Vec<JoinHandle<()>>) {
        tauri::async_runtime::block_on(async {
            for read in reads {
                read.await.unwrap();
            }
        });
    }

    #[test]
    fn only_an_available_agent_has_its_store_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        store(
            &root.join("state.db"),
            &session("cli", "cli", Some("/w"), ""),
        );
        let sources = Arc::new(NativeCatalogSources::new(at(root)));
        let hermes = AgentAdapterKind::Hermes.id();

        assert!(
            sources.refresh(&[]).is_empty(),
            "a disabled agent is not read"
        );
        assert!(sources.reads().is_empty());
        assert!(!sources.reads_store(&hermes));

        settle(sources.refresh(&[AgentAdapterKind::Hermes]));
        assert!(sources.reads_store(&hermes));
        let reads = sources.reads();
        assert_eq!(reads[0].source, hermes);
        assert_eq!(reads[0].report.status, AgentSessionSourceStatus::Ok);
        assert_eq!(reads[0].sessions.len(), 1);

        assert!(sources.refresh(&[]).is_empty());
        assert_eq!(
            sources.reads()[0].sessions.len(),
            1,
            "a disabled agent keeps its last good sessions"
        );
        assert!(!sources.reads_store(&hermes));
    }

    #[test]
    fn a_missing_store_of_an_available_agent_is_its_diagnostic() {
        let temp = tempfile::tempdir().unwrap();
        let sources = Arc::new(NativeCatalogSources::new(at(temp.path().join(".hermes"))));
        settle(sources.refresh(&[AgentAdapterKind::Hermes]));
        let reads = sources.reads();
        assert_eq!(reads[0].report.status, AgentSessionSourceStatus::Stale);
        assert!(reads[0].sessions.is_empty());
        assert!(
            reads[0].report.diagnostics[0]
                .message
                .contains("cannot be read from its store")
        );
    }
}
