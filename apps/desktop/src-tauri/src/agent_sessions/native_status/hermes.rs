//! The Hermes store (Stage 10 `07` N7): `state.db` of the root profile and
//! of every profile under `profiles/`, read only with the SQLite bundled in
//! Svode. One conversation is the compression chain from its root R to its
//! tip T: the catalogue lists it under R, the agent continues it at T. Its
//! status is the turn lease of R and the last message of T. Only the fields
//! of the row and of the status are read (N3): no message text, tool
//! arguments or free text of the agent.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, TimeZone, Utc};
use sqlx::SqliteConnection;
use svode_agents::status::{SessionState, StopReason};

use super::process::{ProcessRecord, ProcessSignal, process_signals};
use super::sqlite::{read_only, table_columns};
use super::{NativeLogRead, NativeStatusEvidence, NativeStatusSource, SourceReads};
use crate::agent_sessions::StoreRoot;

/// The profile of the root store.
pub(crate) const ROOT_PROFILE: &str = "default";
/// The lowest `schema_version` whose format the reader knows.
const MIN_SCHEMA_VERSION: i64 = 31;
/// A turn lease lives this long after its last renewal.
const LEASE_TTL_SECS: f64 = 300.0;
/// Links of a chain the reader follows, as Hermes does.
const MAX_CHAIN_DEPTH: i64 = 32;
const TITLE_CHARS: i64 = 256;

const SESSION_COLUMNS: &[&str] = &[
    "id",
    "source",
    "parent_session_id",
    "started_at",
    "ended_at",
    "end_reason",
    "message_count",
    "cwd",
    "title",
    "model_config",
    "archived",
    "hidden",
    "last_activity_at",
];
const LEASE_COLUMNS: &[&str] = &["conversation_id", "holder", "acquired_at", "expires_at"];
const MESSAGE_COLUMNS: &[&str] = &["session_id", "role", "finish_reason", "tool_calls"];

/// The Hermes home: `HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows
/// and `~/.hermes` elsewhere.
pub(crate) fn store_root(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    store_root_on(home, var, cfg!(windows))
}

fn store_root_on(home: &Path, var: impl Fn(&str) -> Option<OsString>, windows: bool) -> PathBuf {
    if let Some(root) = var("HERMES_HOME").filter(|root| !root.is_empty()) {
        return PathBuf::from(root);
    }
    if windows && let Some(local) = var("LOCALAPPDATA").filter(|local| !local.is_empty()) {
        return PathBuf::from(local).join("hermes");
    }
    home.join(".hermes")
}

/// The store of every profile, the root profile first; none is an error.
fn profile_stores(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut stores = Vec::new();
    let base = root.join("state.db");
    if base.is_file() {
        stores.push((ROOT_PROFILE.to_string(), base));
    }
    let mut profiles = std::fs::read_dir(root.join("profiles"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let db = entry.path().join("state.db");
            let name = entry.file_name().into_string().ok()?;
            db.is_file().then_some((name, db))
        })
        .collect::<Vec<_>>();
    profiles.sort();
    stores.extend(profiles);
    if stores.is_empty() {
        return Err(format!("no state.db in {}", root.display()));
    }
    Ok(stores)
}

/// One conversation of a profile: its compression chain from root to tip.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Conversation {
    pub profile: String,
    pub root: String,
    pub tip: String,
    /// Every link from the root to the tip.
    pub links: Vec<String>,
    /// The tip's folder, else the root's.
    pub cwd: Option<String>,
    /// The tip's title, else the root's.
    pub title: Option<String>,
    /// The latest activity of the chain.
    pub updated_at: Option<DateTime<Utc>>,
    /// The conversation started in Hermes' ACP entrypoint, which loads it.
    pub acp: bool,
    /// The tip holds messages.
    pub has_messages: bool,
}

/// Every conversation of every profile the catalogue lists (N2): a root
/// that is no delegate, tool, kanban or one-shot run and that Hermes
/// neither hides nor archives. A conversation found in an earlier profile
/// is kept.
pub(crate) fn conversations(root: &Path) -> Result<Vec<Conversation>, String> {
    let mut seen = HashMap::new();
    let mut out = Vec::new();
    for (profile, db) in profile_stores(root)? {
        for conversation in read_store(&db, |connection, auto_archived| {
            Box::pin(async move {
                let roots = catalogue_roots(auto_archived);
                chains(connection, &roots, None).await
            })
        })? {
            let conversation = Conversation {
                profile: profile.clone(),
                ..conversation
            };
            if seen.insert(conversation.root.clone(), ()).is_none() {
                out.push(conversation);
            }
        }
    }
    Ok(out)
}

/// A read of one profile's store after its format check (N5).
fn read_store<T: 'static>(
    db: &Path,
    read: impl for<'c> FnOnce(&'c mut SqliteConnection, bool) -> super::sqlite::StoreQuery<'c, T>
    + 'static,
) -> Result<T, String> {
    let result = read_only(db, |connection| {
        Box::pin(async move {
            let format = check_format(&mut *connection).await?;
            match format {
                Ok(auto_archived) => Ok(Ok(read(connection, auto_archived).await?)),
                Err(problem) => Ok(Err(problem)),
            }
        })
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(problem)) => Err(format!("{}: {problem}", db.display())),
        Err(error) => Err(format!("{}: {error}", db.display())),
    }
}

/// The columns the reader needs and a schema version it knows (N5, N7):
/// columns change without a new `schema_version`, so they are the marker.
/// Tells whether the store has `auto_archived`.
async fn check_format(
    connection: &mut SqliteConnection,
) -> Result<Result<bool, String>, sqlx::Error> {
    if table_columns(connection, "schema_version")
        .await?
        .is_empty()
    {
        return Ok(Err("unknown format: no schema_version".to_string()));
    }
    let version = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM schema_version")
        .fetch_one(&mut *connection)
        .await?
        .unwrap_or(0);
    if version < MIN_SCHEMA_VERSION {
        return Ok(Err(format!("unsupported schema version {version}")));
    }
    let sessions = table_columns(connection, "sessions").await?;
    for (table, columns, needed) in [
        ("sessions", sessions.clone(), SESSION_COLUMNS),
        (
            "session_turn_leases",
            table_columns(connection, "session_turn_leases").await?,
            LEASE_COLUMNS,
        ),
        (
            "messages",
            table_columns(connection, "messages").await?,
            MESSAGE_COLUMNS,
        ),
    ] {
        if let Some(missing) = needed.iter().find(|column| !columns.contains(**column)) {
            return Ok(Err(format!("unknown format: {table} has no {missing}")));
        }
    }
    Ok(Ok(sessions.contains("auto_archived")))
}

/// Child `n` continues the conversation of parent `p` after compression;
/// a branch, delegate, reset or tool child is a conversation of its own.
/// Their markers count only when they name the parent.
const CONTINUES: &str = "p.end_reason = 'compression'
    AND COALESCE(n.source, '') <> 'tool'
    AND NOT CASE WHEN json_valid(n.model_config) THEN COALESCE(n.parent_session_id IN (
        json_extract(n.model_config, '$._branched_from'),
        json_extract(n.model_config, '$._delegate_from'),
        json_extract(n.model_config, '$._reset_from')), 0) ELSE 0 END";

/// The roots the catalogue lists.
fn catalogue_roots(auto_archived: bool) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM sessions p, sessions n
            WHERE n.id = r.id AND p.id = n.parent_session_id AND {CONTINUES})
        AND COALESCE(r.source, '') NOT IN ('kanban', 'tool', 'oneshot')
        AND NOT CASE WHEN json_valid(r.model_config)
            THEN json_extract(r.model_config, '$._delegate_from') IS NOT NULL ELSE 0 END
        AND COALESCE(r.hidden, 0) = 0 AND COALESCE(r.archived, 0) = 0{}",
        if auto_archived {
            " AND COALESCE(r.auto_archived, 0) = 0"
        } else {
            ""
        }
    )
}

type LinkRow = (
    String,
    String,
    i64,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    Option<f64>,
);

/// The chains of the roots `roots` selects as `r`, or of the roots with
/// these ids; the tip is the first compression child at every link, as
/// Hermes follows it. From a row only the fields of the catalogue are read;
/// from `model_config` only the folder of an ACP session whose `cwd`
/// column is empty, as Hermes' own ACP list reads it (N7).
async fn chains(
    connection: &mut SqliteConnection,
    roots: &str,
    ids: Option<&[String]>,
) -> Result<Vec<Conversation>, sqlx::Error> {
    let roots = match ids {
        Some(_) => "r.id IN (SELECT value FROM json_each(?1))".to_string(),
        None => roots.to_string(),
    };
    let sql = format!(
        "WITH RECURSIVE chain(root, id, depth) AS (
            SELECT r.id, r.id, 0 FROM sessions r WHERE {roots}
            UNION ALL
            SELECT chain.root, c.id, chain.depth + 1 FROM chain
            JOIN sessions c ON c.id = (
                SELECT n.id FROM sessions n JOIN sessions p ON p.id = n.parent_session_id
                WHERE n.parent_session_id = chain.id AND {CONTINUES}
                ORDER BY n.started_at ASC, n.id ASC LIMIT 1)
            WHERE chain.depth < {MAX_CHAIN_DEPTH}
        )
        SELECT CAST(chain.root AS TEXT), CAST(chain.id AS TEXT), chain.depth,
            CAST(s.source AS TEXT),
            COALESCE(s.message_count, 0) > 0,
            CAST(CASE WHEN s.source = 'acp' AND COALESCE(s.cwd, '') = ''
                THEN CASE WHEN json_valid(s.model_config)
                    THEN json_extract(s.model_config, '$.cwd') END
                ELSE s.cwd END AS TEXT),
            CAST(substr(s.title, 1, {TITLE_CHARS}) AS TEXT),
            CAST(COALESCE(s.last_activity_at, s.ended_at, s.started_at) AS REAL)
        FROM chain JOIN sessions s ON s.id = chain.id
        ORDER BY chain.root, chain.depth"
    );
    let ids = ids.map(|ids| serde_json::to_string(ids).unwrap_or_default());
    let mut query = sqlx::query_as::<_, LinkRow>(&sql);
    if let Some(ids) = &ids {
        query = query.bind(ids);
    }
    let rows = query.fetch_all(&mut *connection).await?;

    let mut conversations: Vec<Conversation> = Vec::new();
    let mut root_link: Option<LinkRow> = None;
    for row in rows {
        let (root, id, depth, source, has_messages, cwd, title, activity) = row.clone();
        let cwd = cwd.filter(|cwd| !cwd.trim().is_empty());
        let title = title.filter(|title| !title.trim().is_empty());
        let updated_at = activity.and_then(epoch);
        if depth == 0 {
            root_link = Some(row);
            conversations.push(Conversation {
                profile: String::new(),
                root: root.clone(),
                tip: id.clone(),
                links: vec![id],
                cwd,
                title,
                updated_at,
                acp: source.as_deref() == Some("acp"),
                has_messages,
            });
            continue;
        }
        let Some(conversation) = conversations.last_mut().filter(|last| last.root == root) else {
            continue;
        };
        let root_row = root_link.as_ref().expect("the root comes first");
        conversation.tip = id.clone();
        conversation.links.push(id);
        conversation.cwd = cwd.or_else(|| root_row.5.clone().filter(|cwd| !cwd.trim().is_empty()));
        conversation.title =
            title.or_else(|| root_row.6.clone().filter(|title| !title.trim().is_empty()));
        conversation.updated_at = conversation.updated_at.max(updated_at);
        conversation.has_messages = has_messages;
    }
    Ok(conversations)
}

fn epoch(seconds: f64) -> Option<DateTime<Utc>> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Utc.timestamp_millis_opt((seconds * 1000.0).round() as i64)
        .single()
}

/// The turn lease of a conversation (N7).
#[derive(Debug, Clone, PartialEq)]
struct Lease {
    pid: Option<u32>,
    acquired_at: f64,
    expires_at: f64,
}

/// The last message of a conversation with a role the reader knows.
#[derive(Debug, Clone, PartialEq)]
struct LastMessage {
    role: String,
    finish_reason: Option<String>,
    tool_calls: bool,
}

type StatusRows = (
    Vec<Conversation>,
    Vec<(String, Lease)>,
    Vec<(String, LastMessage)>,
);

/// The leases of the chains of these roots and the last messages of their
/// tips. Only the holder's pid is taken from the lease; of a message only
/// its role, finish reason and whether it calls tools (N3).
async fn status_rows(
    connection: &mut SqliteConnection,
    ids: &[String],
) -> Result<StatusRows, sqlx::Error> {
    let conversations = chains(connection, "", Some(ids)).await?;
    let roots = serde_json::to_string(
        &conversations
            .iter()
            .map(|conversation| conversation.root.as_str())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    let leases = sqlx::query_as::<_, (String, String, f64, f64)>(
        "SELECT CAST(conversation_id AS TEXT), CAST(holder AS TEXT),
            CAST(acquired_at AS REAL), CAST(expires_at AS REAL)
        FROM session_turn_leases WHERE conversation_id IN (SELECT value FROM json_each(?1))",
    )
    .bind(&roots)
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .map(|(conversation, holder, acquired_at, expires_at)| {
        (
            conversation,
            Lease {
                pid: holder_pid(&holder),
                acquired_at,
                expires_at,
            },
        )
    })
    .collect();
    let tips = serde_json::to_string(
        &conversations
            .iter()
            .map(|conversation| conversation.tip.as_str())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    let messages = sqlx::query_as::<_, (String, String, Option<String>, bool)>(
        "SELECT CAST(t.value AS TEXT), CAST(m.role AS TEXT), CAST(m.finish_reason AS TEXT),
            COALESCE(m.tool_calls IS NOT NULL AND m.tool_calls NOT IN ('', '[]', 'null'), 0)
        FROM json_each(?1) t
        JOIN messages m ON m.rowid = (
            SELECT x.rowid FROM messages x
            WHERE x.session_id = t.value AND x.role IN ('user', 'assistant', 'tool')
            ORDER BY x.rowid DESC LIMIT 1)",
    )
    .bind(&tips)
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .map(|(tip, role, finish_reason, tool_calls)| {
        (
            tip,
            LastMessage {
                role,
                finish_reason,
                tool_calls,
            },
        )
    })
    .collect();
    Ok((conversations, leases, messages))
}

/// The pid of a holder `pid=<pid>…:turn=…:platform=…`.
fn holder_pid(holder: &str) -> Option<u32> {
    let digits = holder.strip_prefix("pid=")?;
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse().ok().filter(|pid| *pid > 0)
}

/// The status of a conversation without an open turn: `idle` with the
/// reason its last message tells (N7). A user or tool message last, or an
/// answer that calls tools, is a turn that never ended.
fn idle_reason(message: Option<&LastMessage>) -> (Option<StopReason>, String) {
    let Some(message) = message else {
        return (None, "hermes conversation without a turn lease".to_string());
    };
    let reason = match message.finish_reason.as_deref() {
        Some("length") => StopReason::MaxTokens,
        Some("content_filter") => StopReason::Refusal,
        Some("error") => StopReason::Error,
        _ if message.role != "assistant" || message.tool_calls => StopReason::Interrupted,
        _ => StopReason::EndTurn,
    };
    (
        Some(reason),
        format!(
            "hermes conversation without a turn lease, last {} message",
            message.role
        ),
    )
}

/// What a lease or the last message tells of a conversation at `now`. An
/// open turn carries the process of its lease; an expired lease is judged
/// here by its process: dead — `interrupted`, alive or unknown — `unknown`.
fn status_of(
    lease: Option<&Lease>,
    message: Option<&LastMessage>,
    now: DateTime<Utc>,
    expired_signal: Option<ProcessSignal>,
) -> NativeLogRead {
    let (status, process) = match lease {
        Some(lease) => {
            let renewed = epoch(lease.expires_at - LEASE_TTL_SECS);
            if epoch(lease.expires_at).is_some_and(|expires| expires > now) {
                (
                    NativeStatusEvidence {
                        state: SessionState::Running,
                        reason: "hermes turn lease is held".to_string(),
                        observed_at: renewed,
                        waiting_since: None,
                    },
                    lease.pid.and_then(|pid| {
                        Some(ProcessRecord {
                            pid,
                            host: None,
                            started_by: epoch(lease.acquired_at)? + Duration::seconds(1),
                        })
                    }),
                )
            } else if expired_signal == Some(ProcessSignal::Dead) {
                (
                    NativeStatusEvidence {
                        state: SessionState::Idle {
                            stop_reason: Some(StopReason::Interrupted),
                        },
                        reason: "the process of the expired hermes turn lease exited".to_string(),
                        observed_at: renewed,
                        waiting_since: None,
                    },
                    None,
                )
            } else {
                (
                    NativeStatusEvidence {
                        state: SessionState::Unknown,
                        reason: "hermes turn lease expired".to_string(),
                        observed_at: renewed,
                        waiting_since: None,
                    },
                    None,
                )
            }
        }
        None => {
            let (stop_reason, reason) = idle_reason(message);
            (
                NativeStatusEvidence {
                    state: SessionState::Idle { stop_reason },
                    reason,
                    observed_at: None,
                    waiting_since: None,
                },
                None,
            )
        }
    };
    NativeLogRead {
        file: None,
        companions: Vec::new(),
        status: Some(status),
        launch_id: None,
        process,
    }
}

/// The Hermes status source (N4, N7): reads the conversations with these
/// root ids from every profile's store on each call, since a lease expires
/// without the store changing. The Hermes home is found at each read.
pub(crate) struct HermesStates {
    root: StoreRoot,
}

impl HermesStates {
    pub(crate) fn new(root: StoreRoot) -> Self {
        Self { root }
    }
}

impl NativeStatusSource for HermesStates {
    fn read(&self, ids: &[&str]) -> Result<SourceReads, String> {
        let now = Utc::now();
        let mut found: BTreeMap<String, (Option<Lease>, Option<LastMessage>)> = BTreeMap::new();
        for (_, db) in profile_stores(&(self.root)())? {
            let wanted = ids
                .iter()
                .filter(|id| !found.contains_key(**id))
                .map(|id| id.to_string())
                .collect::<Vec<_>>();
            if wanted.is_empty() {
                break;
            }
            let (conversations, leases, messages) = read_store(&db, |connection, _| {
                Box::pin(async move { status_rows(connection, &wanted).await })
            })?;
            let mut leases = leases.into_iter().collect::<HashMap<_, _>>();
            let mut messages = messages.into_iter().collect::<HashMap<_, _>>();
            for conversation in conversations {
                let lease = leases.remove(&conversation.root);
                let message = messages.remove(&conversation.tip);
                found.insert(conversation.root, (lease, message));
            }
        }
        let expired = found
            .values()
            .map(|(lease, _)| {
                lease
                    .as_ref()
                    .filter(|lease| epoch(lease.expires_at).is_none_or(|expires| expires <= now))
                    .and_then(|lease| {
                        Some(ProcessRecord {
                            pid: lease.pid?,
                            host: None,
                            started_by: epoch(lease.acquired_at)? + Duration::seconds(1),
                        })
                    })
            })
            .collect::<Vec<_>>();
        let signals = process_signals(&expired.iter().map(Option::as_ref).collect::<Vec<_>>());
        let sessions = found
            .into_iter()
            .zip(signals)
            .map(|((root, (lease, message)), signal)| {
                (
                    root,
                    status_of(lease.as_ref(), message.as_ref(), now, Some(signal)),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(SourceReads {
            reparsed: sessions.len(),
            sessions,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sqlx::Connection;
    use sqlx::sqlite::SqliteConnectOptions;

    /// The tables of a Hermes store of schema 31 with the columns the reader
    /// reads; no conversation content.
    pub(crate) const SCHEMA: &str = "
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (31);
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, model_config TEXT,
            parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
            end_reason TEXT, message_count INTEGER DEFAULT 0, cwd TEXT, title TEXT,
            last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0,
            auto_archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT, tool_calls TEXT, timestamp REAL NOT NULL, finish_reason TEXT);
        CREATE TABLE session_turn_leases (
            conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
            acquired_at REAL NOT NULL, expires_at REAL NOT NULL);";

    /// A synthetic store: `sql` runs after the schema.
    pub(crate) fn store(db: &Path, sql: &str) {
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(db)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
            sqlx::raw_sql(&format!("{SCHEMA}{sql}"))
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
        });
    }

    /// A session row; `extra` sets further columns as `column = value`.
    pub(crate) fn session(id: &str, source: &str, cwd: Option<&str>, extra: &str) -> String {
        let cwd = cwd.map_or("NULL".to_string(), |cwd| format!("'{cwd}'"));
        let mut sql = format!(
            "INSERT INTO sessions (id, source, cwd, started_at, last_activity_at, message_count, title)
             VALUES ('{id}', '{source}', {cwd}, 1800000000, 1800000100, 2, 'Title {id}');"
        );
        if !extra.is_empty() {
            sql.push_str(&format!("UPDATE sessions SET {extra} WHERE id = '{id}';"));
        }
        sql
    }

    fn by_root(conversations: &[Conversation]) -> HashMap<&str, &Conversation> {
        conversations
            .iter()
            .map(|conversation| (conversation.root.as_str(), conversation))
            .collect()
    }

    #[test]
    fn the_store_is_the_hermes_home_of_the_device() {
        let home = Path::new("/home/me");
        let none = |_: &str| None;
        assert_eq!(store_root_on(home, none, false), home.join(".hermes"));
        let local = |name: &str| {
            (name == "LOCALAPPDATA").then(|| OsString::from("C:\\Users\\Me\\AppData\\Local"))
        };
        assert_eq!(
            store_root_on(home, local, true),
            PathBuf::from("C:\\Users\\Me\\AppData\\Local").join("hermes")
        );
        assert_eq!(store_root_on(home, local, false), home.join(".hermes"));
        let custom = |name: &str| (name == "HERMES_HOME").then(|| OsString::from("/srv/hermes"));
        assert_eq!(
            store_root_on(home, custom, true),
            PathBuf::from("/srv/hermes")
        );
    }

    #[test]
    fn the_catalogue_lists_the_conversations_hermes_shows() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        let sql = [
            session("cli", "cli", Some("/w"), ""),
            session("hidden", "cli", Some("/w"), "hidden = 1"),
            session("archived", "cli", Some("/w"), "archived = 1"),
            session("auto-archived", "cli", Some("/w"), "auto_archived = 1"),
            session("tool", "tool", Some("/w"), ""),
            session("oneshot", "oneshot", Some("/w"), ""),
            session("kanban", "kanban", Some("/w"), ""),
            session(
                "delegate",
                "cli",
                Some("/w"),
                "parent_session_id = 'cli', model_config = '{\"_delegate_from\":\"cli\"}'",
            ),
            session(
                "branch",
                "cli",
                Some("/w"),
                "parent_session_id = 'cli', model_config = '{\"_branched_from\":\"cli\"}'",
            ),
            session(
                "acp-config",
                "acp",
                None,
                "model_config = '{\"cwd\":\"/w/space\"}'",
            ),
            session(
                "cli-no-cwd",
                "cli",
                None,
                "model_config = '{\"cwd\":\"/w\"}'",
            ),
            session("silent", "cli", Some("/w"), "message_count = 0"),
            session(
                "broken-config",
                "cli",
                Some("/w"),
                "model_config = 'not json'",
            ),
        ]
        .concat();
        store(&root.join("state.db"), &sql);

        let conversations = conversations(&root).unwrap();
        let roots = by_root(&conversations);
        let mut ids = roots.keys().copied().collect::<Vec<_>>();
        ids.sort();
        assert_eq!(
            ids,
            [
                "acp-config",
                "branch",
                "broken-config",
                "cli",
                "cli-no-cwd",
                "silent"
            ],
            "the read keeps rows without cwd or messages for the catalogue to skip"
        );
        assert_eq!(roots["acp-config"].cwd.as_deref(), Some("/w/space"));
        assert!(roots["acp-config"].acp);
        assert_eq!(
            roots["cli-no-cwd"].cwd, None,
            "only ACP rows read model_config"
        );
        assert!(!roots["silent"].has_messages);
        assert_eq!(roots["cli"].profile, ROOT_PROFILE);
        assert_eq!(roots["cli"].title.as_deref(), Some("Title cli"));
        assert_eq!(
            roots["cli"].updated_at,
            Some(Utc.timestamp_opt(1_800_000_100, 0).unwrap())
        );
    }

    #[test]
    fn a_compression_chain_is_one_conversation_under_its_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        let sql = [
            session(
                "r",
                "acp",
                Some("/w"),
                "end_reason = 'compression', archived = 0",
            ),
            // The continuation copies the root's config, delegate marker
            // of another parent included, and carries no title.
            session(
                "t1",
                "acp",
                None,
                "parent_session_id = 'r', end_reason = 'compression', started_at = 1800000200, \
                 last_activity_at = 1800000300, title = NULL, \
                 model_config = '{\"_delegate_from\":\"elsewhere\"}'",
            ),
            session(
                "t2",
                "acp",
                Some("/w/space"),
                "parent_session_id = 't1', started_at = 1800000400, last_activity_at = 1800000500, \
                 title = NULL",
            ),
            // A later reset of the compressed link is its own conversation.
            session(
                "reset",
                "cli",
                Some("/w"),
                "parent_session_id = 't1', started_at = 1800000450, \
                 model_config = '{\"_reset_from\":\"t1\"}'",
            ),
        ]
        .concat();
        store(&root.join("state.db"), &sql);

        let conversations = conversations(&root).unwrap();
        let roots = by_root(&conversations);
        assert_eq!(roots.len(), 2, "{conversations:?}");
        let chain = roots["r"];
        assert_eq!(chain.tip, "t2");
        assert_eq!(chain.links, ["r", "t1", "t2"]);
        assert_eq!(chain.cwd.as_deref(), Some("/w/space"));
        assert_eq!(chain.title.as_deref(), Some("Title r"));
        assert_eq!(
            chain.updated_at,
            Some(Utc.timestamp_opt(1_800_000_500, 0).unwrap())
        );
        assert!(roots.contains_key("reset"));
    }

    #[test]
    fn every_profile_is_read_and_the_first_keeps_a_repeated_id() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        store(
            &root.join("state.db"),
            &session("shared", "cli", Some("/w"), ""),
        );
        store(
            &root.join("profiles/work/state.db"),
            &[
                session("work-only", "cli", Some("/w"), ""),
                session("shared", "cli", Some("/elsewhere"), ""),
            ]
            .concat(),
        );
        let conversations = conversations(&root).unwrap();
        let roots = by_root(&conversations);
        assert_eq!(roots["shared"].profile, ROOT_PROFILE);
        assert_eq!(roots["shared"].cwd.as_deref(), Some("/w"));
        assert_eq!(roots["work-only"].profile, "work");
    }

    #[test]
    fn a_store_of_an_unknown_format_is_an_error() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            conversations(&temp.path().join(".hermes")).is_err(),
            "no store"
        );

        let root = temp.path().join("old");
        store(
            &root.join("state.db"),
            "UPDATE schema_version SET version = 30;",
        );
        assert!(
            conversations(&root)
                .unwrap_err()
                .contains("schema version 30"),
            "an older schema"
        );

        let root = temp.path().join("newer");
        store(
            &root.join("state.db"),
            "UPDATE schema_version SET version = 32;",
        );
        assert!(
            conversations(&root).is_ok(),
            "a newer schema with the columns"
        );

        let root = temp.path().join("missing");
        store(
            &root.join("state.db"),
            "ALTER TABLE session_turn_leases DROP COLUMN holder;",
        );
        let problem = conversations(&root).unwrap_err();
        assert!(
            problem.contains("session_turn_leases has no holder"),
            "{problem}"
        );
    }

    fn lease(id: &str, pid: u32, acquired_at: f64, expires_at: f64) -> String {
        format!(
            "INSERT INTO session_turn_leases VALUES ('{id}', 'pid={pid}:turn=t:platform=cli', \
             {acquired_at}, {expires_at});"
        )
    }

    fn message(
        id: &str,
        role: &str,
        finish_reason: Option<&str>,
        tool_calls: Option<&str>,
    ) -> String {
        let quoted = |value: Option<&str>| value.map_or("NULL".to_string(), |v| format!("'{v}'"));
        format!(
            "INSERT INTO messages (session_id, role, content, tool_calls, timestamp, finish_reason) \
             VALUES ('{id}', '{role}', 'not read', {}, 1800000000, {});",
            quoted(tool_calls),
            quoted(finish_reason)
        )
    }

    fn state_of(read: &NativeLogRead) -> SessionState {
        read.status.as_ref().unwrap().state
    }

    #[test]
    fn a_lease_and_the_last_message_tell_the_status() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".hermes");
        let now = Utc::now().timestamp() as f64;
        let mut child = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["-n", "60", "127.0.0.1"]
            } else {
                vec!["60"]
            })
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut exited = std::process::Command::new(if cfg!(windows) { "ping" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["-n", "60", "127.0.0.1"]
            } else {
                vec!["60"]
            })
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let dead = exited.id();
        exited.kill().unwrap();
        exited.wait().unwrap();
        let alive = child.id();
        let sql = [
            session("held-alive", "cli", Some("/w"), ""),
            lease("held-alive", alive, now + 5.0, now + 240.0),
            session("held-dead", "cli", Some("/w"), ""),
            lease("held-dead", dead, now - 10.0, now + 240.0),
            session("expired-alive", "cli", Some("/w"), ""),
            // The lease expired without its process exiting: the child
            // started before the lease was taken.
            lease("expired-alive", alive, now + 5.0, now - 1.0),
            session("expired-dead", "cli", Some("/w"), ""),
            lease("expired-dead", dead, now - 900.0, now - 600.0),
            session("end", "cli", Some("/w"), ""),
            message("end", "user", None, None),
            message("end", "assistant", Some("stop"), None),
            message("end", "system", None, None),
            session("length", "cli", Some("/w"), ""),
            message("length", "assistant", Some("length"), None),
            session("filtered", "cli", Some("/w"), ""),
            message("filtered", "assistant", Some("content_filter"), None),
            session("failed", "cli", Some("/w"), ""),
            message("failed", "assistant", Some("error"), None),
            session("asked", "cli", Some("/w"), ""),
            message("asked", "user", None, None),
            session("tool-result", "cli", Some("/w"), ""),
            message("tool-result", "tool", None, None),
            session("calls", "cli", Some("/w"), ""),
            message(
                "calls",
                "assistant",
                Some("tool_calls"),
                Some("[{\"id\":\"c\"}]"),
            ),
            session("no-calls", "cli", Some("/w"), ""),
            message("no-calls", "assistant", None, Some("[]")),
            session("r", "cli", Some("/w"), "end_reason = 'compression'"),
            message("r", "user", None, None),
            session(
                "t",
                "cli",
                Some("/w"),
                "parent_session_id = 'r', started_at = 1800000200",
            ),
            message("t", "assistant", Some("stop"), None),
        ]
        .concat();
        store(&root.join("state.db"), &sql);
        let ids = [
            "held-alive",
            "held-dead",
            "expired-alive",
            "expired-dead",
            "end",
            "length",
            "filtered",
            "failed",
            "asked",
            "tool-result",
            "calls",
            "no-calls",
            "r",
            "not-in-store",
        ];
        let reads = HermesStates::new(std::sync::Arc::new(move || root.clone()))
            .read(&ids)
            .unwrap();
        child.kill().ok();
        child.wait().ok();
        let reads = reads.sessions;

        assert!(!reads.contains_key("not-in-store"));
        // An open turn names its process; the reader judges it (8.0).
        assert_eq!(state_of(&reads["held-alive"]), SessionState::Running);
        assert_eq!(reads["held-alive"].process.as_ref().unwrap().pid, alive);
        assert_eq!(
            reads["held-alive"].status.as_ref().unwrap().observed_at,
            epoch(now - 60.0),
            "the evidence is the last renewal"
        );
        assert_eq!(reads["held-dead"].process.as_ref().unwrap().pid, dead);
        assert_eq!(state_of(&reads["expired-alive"]), SessionState::Unknown);
        assert_eq!(
            state_of(&reads["expired-dead"]),
            SessionState::Idle {
                stop_reason: Some(StopReason::Interrupted)
            }
        );
        for (id, reason) in [
            ("end", StopReason::EndTurn),
            ("length", StopReason::MaxTokens),
            ("filtered", StopReason::Refusal),
            ("failed", StopReason::Error),
            ("asked", StopReason::Interrupted),
            ("tool-result", StopReason::Interrupted),
            ("calls", StopReason::Interrupted),
            ("no-calls", StopReason::EndTurn),
            ("r", StopReason::EndTurn),
        ] {
            assert_eq!(
                state_of(&reads[id]),
                SessionState::Idle {
                    stop_reason: Some(reason)
                },
                "{id}"
            );
            assert!(reads[id].process.is_none(), "{id}");
        }
    }

    #[test]
    fn the_holder_names_the_pid_of_its_process() {
        assert_eq!(holder_pid("pid=4242:turn=t:platform=cli"), Some(4242));
        assert_eq!(holder_pid("pid=4242@ns-1:turn=t"), Some(4242));
        assert_eq!(holder_pid("pid=:turn=t"), None);
        assert_eq!(holder_pid("turn=t"), None);
    }
}
