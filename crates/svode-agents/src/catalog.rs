//! ACP list source of the session catalogue (Stage 10 `02` C3): the
//! sessions an agent reports through `session/list`, bounded and free of
//! transcript. The list carries no status; a host scopes the entries to its
//! projects and merges them with its other sources by `SessionKey`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::acp::normalize::bounded;
use crate::identity::SessionKey;
use crate::runtime::ConnectionId;
use crate::status::SessionStatus;

/// A session id longer than this is not an id Svode keeps.
const SESSION_ID_BYTES: usize = 512;
const UPDATED_AT_BYTES: usize = 64;
const CATALOG_NOTICES: usize = 64;

/// Bounds of one list read; tunables, not part of the contract.
#[derive(Debug, Clone, Copy)]
pub struct ListBounds {
    /// Whole read, all pages together.
    pub timeout: Duration,
    /// Sessions kept; beyond it the list is truncated.
    pub sessions: usize,
    /// Pages requested; beyond it the list is truncated.
    pub pages: usize,
    pub title_bytes: usize,
    /// An entry with a longer working directory is skipped.
    pub cwd_bytes: usize,
}

impl Default for ListBounds {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            sessions: 10_000,
            pages: 1_000,
            title_bytes: 256,
            cwd_bytes: 4 * 1024,
        }
    }
}

/// One session the agent knows. Equal cwd, title or time never prove that
/// two entries are one session; only equal keys do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSession {
    pub key: SessionKey,
    /// Absolute working directory as the agent reports it.
    pub cwd: PathBuf,
    pub title: Option<String>,
    /// Last activity as the agent reports it (ISO 8601), unparsed.
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionList {
    pub sessions: Vec<ListedSession>,
    /// A bound ended the read before the agent's last page.
    pub truncated: bool,
    /// Entries dropped as malformed, out of bounds or repeated.
    pub skipped: usize,
}

/// A session this runtime drives, by runtime evidence (Stage 10 `02` C3):
/// a created one once its first prompt was accepted, an opened one from its
/// opening. It lives in the runtime process only; a host merges it with
/// its declared source by `key` and never writes it to a disk cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSession {
    pub key: SessionKey,
    /// The working directory the session was created or opened in.
    pub cwd: PathBuf,
    /// The agent's title, else the bounded first line of the first prompt.
    pub title: Option<String>,
    pub status: SessionStatus,
    /// When this runtime created or opened the session.
    pub started_at: SystemTime,
    pub updated_at: SystemTime,
}

/// The bounded first line of a prompt, the title of a runtime session until
/// the agent names it.
pub(crate) fn prompt_title(prompt: &str, bounds: &ListBounds) -> Option<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(bounded(line, bounds.title_bytes).trim().to_string())
}

/// The open connection whose `session/list` is the declared catalogue
/// source of its agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogConnection {
    pub connection: ConnectionId,
    pub agent: String,
}

/// The agent's list may have changed because of the runtime's own work: it
/// created a session or finished a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogChanged {
    pub agent: String,
}

/// An entry as the agent sent it, before bounds and identity.
pub(crate) struct ListEntry {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

pub(crate) struct ListPage {
    pub entries: Vec<ListEntry>,
    /// Entries that did not parse.
    pub malformed: usize,
    pub next_cursor: Option<String>,
}

/// The bounded session of `entry`, or `None` for an entry Svode does not
/// keep: an empty or oversized id, a relative or oversized cwd.
pub(crate) fn listed(
    entry: ListEntry,
    agent: &str,
    acp_id_is_native: bool,
    bounds: &ListBounds,
) -> Option<ListedSession> {
    let session_id = entry.session_id.trim();
    if session_id.is_empty() || session_id.len() > SESSION_ID_BYTES {
        return None;
    }
    if entry.cwd.len() > bounds.cwd_bytes || !Path::new(&entry.cwd).is_absolute() {
        return None;
    }
    let title = entry
        .title
        .map(|title| bounded(title.trim(), bounds.title_bytes).trim().to_string())
        .filter(|title| !title.is_empty());
    let updated_at = entry
        .updated_at
        .filter(|value| value.len() <= UPDATED_AT_BYTES);
    Some(ListedSession {
        key: SessionKey::from_acp(agent, session_id, acp_id_is_native),
        cwd: PathBuf::from(entry.cwd),
        title,
        updated_at,
    })
}

/// Announces catalogue changes to the hosts that follow them.
pub(crate) struct CatalogNotices(broadcast::Sender<CatalogChanged>);

impl Default for CatalogNotices {
    fn default() -> Self {
        Self(broadcast::channel(CATALOG_NOTICES).0)
    }
}

impl CatalogNotices {
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<CatalogChanged> {
        self.0.subscribe()
    }

    pub(crate) fn changed(&self, agent: &str) {
        // Nobody following is not an error.
        let _ = self.0.send(CatalogChanged {
            agent: agent.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::IdentityNamespace;

    fn entry(id: &str, cwd: &str, title: Option<&str>) -> ListEntry {
        ListEntry {
            session_id: id.into(),
            cwd: cwd.into(),
            title: title.map(Into::into),
            updated_at: Some("2026-09-30T10:00:00Z".into()),
        }
    }

    #[test]
    fn an_entry_keeps_bounded_metadata_and_its_identity_namespace() {
        let bounds = ListBounds {
            title_bytes: 8,
            ..ListBounds::default()
        };
        let session = listed(
            entry("s1", "/work/app", Some("  Fix the build now  ")),
            "hermes",
            false,
            &bounds,
        )
        .unwrap();
        assert_eq!(session.title.as_deref(), Some("Fix the"));
        assert_eq!(session.key.namespace, IdentityNamespace::Acp);
        assert_eq!(session.cwd, PathBuf::from("/work/app"));

        let native = listed(entry("s1", "/work/app", None), "hermes", true, &bounds).unwrap();
        assert_eq!(native.key.namespace, IdentityNamespace::Native);
        assert_eq!(native.title, None);
    }

    #[test]
    fn entries_without_a_usable_id_or_absolute_cwd_are_dropped() {
        let bounds = ListBounds {
            cwd_bytes: 12,
            ..ListBounds::default()
        };
        assert!(listed(entry(" ", "/work", None), "a", false, &bounds).is_none());
        assert!(listed(entry("s1", "work", None), "a", false, &bounds).is_none());
        assert!(listed(entry("s1", "/a/very/long/cwd", None), "a", false, &bounds).is_none());
        let long_id = "x".repeat(SESSION_ID_BYTES + 1);
        assert!(listed(entry(&long_id, "/work", None), "a", false, &bounds).is_none());
    }
}
