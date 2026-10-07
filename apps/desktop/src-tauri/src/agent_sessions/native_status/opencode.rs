//! opencode's native status source (Stage 10 `07` N7): one `opencode.db` of
//! all sessions, read for the turn claim and the outcome of the last turn of
//! each listed session. Nothing else of a session is read: no title, no
//! messages, no parts.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, TimeZone, Utc};
use svode_agents::status::{SessionState, StopReason};

use super::sqlite::{read_only, table_columns};
use super::{NativeLogFile, NativeLogRead, NativeStatusEvidence, NativeStatusSource, SourceReads};

/// The migrations that made the status columns of `session_v2` as read
/// here (N5): later ones do not stop the read.
const MIGRATIONS: [&str; 3] = [
    "20260804233008_loose_psylocke",
    "20260811161259_execution_claim_attempts",
    "20260819222447_session_viewed_state",
];

/// The columns of `session_v2` the read needs.
const COLUMNS: [&str; 4] = ["id", "time_suspended", "time_idle", "idle_outcome"];

/// Where opencode keeps its database (N7): `$OPENCODE_DB`, absolute or
/// relative to the data directory, else `opencode.db` in the data directory
/// `($XDG_DATA_HOME | ~/.local/share)/opencode`, alike on macOS, Windows and
/// Linux. `var` reads the environment opencode runs in.
pub(super) fn database_path(
    home: &Path,
    var: impl Fn(&str) -> Option<OsString>,
) -> Result<PathBuf, String> {
    let set = |name| var(name).filter(|value: &OsString| !value.is_empty());
    let data = set("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("opencode");
    match set("OPENCODE_DB") {
        Some(name) if name == ":memory:" => {
            Err("opencode keeps its sessions in memory (OPENCODE_DB)".to_string())
        }
        Some(name) => Ok(data.join(name)),
        None => Ok(data.join("opencode.db")),
    }
}

/// The reads of `opencode.db`, repeated only after the database or its WAL
/// changed.
pub(crate) struct Database<P> {
    locate: P,
    reads: Mutex<Reads>,
}

#[derive(Default)]
struct Reads {
    /// The database and its WAL as they were before the kept reads.
    stamp: Vec<NativeLogFile>,
    /// Each session read under the stamp; `None` when the database has none.
    sessions: HashMap<String, Option<NativeLogRead>>,
}

impl<P> Database<P>
where
    P: Fn() -> Result<PathBuf, String> + Send + Sync,
{
    pub(crate) fn new(locate: P) -> Self {
        Self {
            locate,
            reads: Mutex::new(Reads::default()),
        }
    }
}

impl<P> NativeStatusSource for Database<P>
where
    P: Fn() -> Result<PathBuf, String> + Send + Sync,
{
    fn read(&self, ids: &[&str]) -> Result<SourceReads, String> {
        let db = (self.locate)()?;
        // Stat before reading: a database written meanwhile is read again.
        // An empty WAL, which a read may create, holds no change.
        let stamp = [db.clone(), wal_of(&db)]
            .iter()
            .filter_map(|path| NativeLogFile::stat(path))
            .filter(|file| file.path == db || file.size > 0)
            .collect::<Vec<_>>();
        let mut reads = self.reads.lock().unwrap();
        if reads.stamp != stamp {
            *reads = Reads {
                stamp,
                sessions: HashMap::new(),
            };
        }
        let unread = ids
            .iter()
            .copied()
            .filter(|id| !reads.sessions.contains_key(*id))
            .collect::<HashSet<_>>();
        let mut reparsed = 0;
        if !unread.is_empty() {
            let rows = read_rows(&db, &unread)?;
            reparsed = rows.len();
            for id in unread {
                let read = rows.get(id).map(|row| NativeLogRead {
                    file: None,
                    companions: Vec::new(),
                    status: Some(row.status()),
                    launch_id: None,
                    process: None,
                });
                reads.sessions.insert(id.to_string(), read);
            }
        }
        Ok(SourceReads {
            sessions: ids
                .iter()
                .filter_map(|id| Some((id.to_string(), reads.sessions.get(*id)?.clone()?)))
                .collect(),
            reparsed,
        })
    }
}

fn wal_of(db: &Path) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

/// The status columns of a session.
#[derive(Debug)]
struct Row {
    time_suspended: Option<i64>,
    time_idle: Option<i64>,
    idle_outcome: Option<String>,
}

impl Row {
    /// N7: a claim is a turn in flight since the claim, approximately
    /// `running` (opencode writes no wait for a permission and no process);
    /// without one, the outcome of the last turn ended; neither — no turn.
    fn status(&self) -> NativeStatusEvidence {
        if let Some(claimed) = self.time_suspended {
            return NativeStatusEvidence {
                state: SessionState::Running,
                reason: "opencode turn claimed".to_string(),
                observed_at: millis(claimed),
                waiting_since: None,
            };
        }
        let Some(idle) = self.time_idle else {
            return NativeStatusEvidence {
                state: SessionState::Idle { stop_reason: None },
                reason: "opencode session without a turn".to_string(),
                observed_at: None,
                waiting_since: None,
            };
        };
        let (state, reason) = match self.idle_outcome.as_deref() {
            Some("succeeded") => (idle_with(StopReason::EndTurn), "opencode turn succeeded"),
            Some("failed") => (idle_with(StopReason::Error), "opencode turn failed"),
            Some("interrupted") => (
                idle_with(StopReason::Cancelled),
                "opencode turn interrupted",
            ),
            None => (
                SessionState::Idle { stop_reason: None },
                "opencode turn ended",
            ),
            Some(_) => (
                SessionState::Unknown,
                "opencode turn ended with an unknown outcome",
            ),
        };
        NativeStatusEvidence {
            state,
            reason: reason.to_string(),
            observed_at: millis(idle),
            waiting_since: None,
        }
    }
}

fn idle_with(stop_reason: StopReason) -> SessionState {
    SessionState::Idle {
        stop_reason: Some(stop_reason),
    }
}

fn millis(value: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_millis_opt(value).single()
}

/// The status columns of these sessions in one read-only read, after the
/// format check (N5): the database lacking a migration or column the read
/// needs fails the source.
fn read_rows(db: &Path, ids: &HashSet<&str>) -> Result<HashMap<String, Row>, String> {
    let ids = serde_json::to_string(ids).map_err(|error| error.to_string())?;
    let read = read_only(db, move |connection| {
        Box::pin(async move {
            let problem = format_problem(connection).await?;
            if let Some(problem) = problem {
                return Ok(Err(problem));
            }
            let rows = sqlx::query_as::<_, (String, Option<i64>, Option<i64>, Option<String>)>(
                "SELECT id, time_suspended, time_idle, idle_outcome FROM session_v2 \
                 WHERE id IN (SELECT value FROM json_each(?))",
            )
            .bind(ids)
            .fetch_all(&mut *connection)
            .await?;
            Ok(Ok(rows))
        })
    })
    .map_err(|error| format!("{}: {error}", db.display()))??;
    Ok(read
        .into_iter()
        .map(|(id, time_suspended, time_idle, idle_outcome)| {
            (
                id,
                Row {
                    time_suspended,
                    time_idle,
                    idle_outcome,
                },
            )
        })
        .collect())
}

async fn format_problem(
    connection: &mut sqlx::SqliteConnection,
) -> Result<Option<String>, sqlx::Error> {
    if !table_columns(&mut *connection, "migration")
        .await?
        .contains("id")
    {
        return Ok(Some("opencode.db has no migration table".to_string()));
    }
    let applied = sqlx::query_scalar::<_, String>("SELECT id FROM migration")
        .fetch_all(&mut *connection)
        .await?
        .into_iter()
        .collect::<HashSet<_>>();
    if let Some(missing) = MIGRATIONS
        .iter()
        .find(|migration| !applied.contains(**migration))
    {
        return Ok(Some(format!("opencode.db lacks the migration {missing}")));
    }
    let columns = table_columns(&mut *connection, "session_v2").await?;
    if let Some(missing) = COLUMNS.iter().find(|column| !columns.contains(**column)) {
        return Ok(Some(format!(
            "opencode.db session_v2 lacks the column {missing}"
        )));
    }
    Ok(None)
}

/// Synthetic `opencode.db` stores: the schema of the status columns with
/// placeholder sessions, no conversation.
#[cfg(test)]
pub(crate) mod fixture {
    use std::path::Path;

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    /// One session's status columns: claim, idle time and outcome.
    pub(crate) type Session<'a> = (&'a str, Option<i64>, Option<i64>, Option<&'a str>);

    /// A WAL store as opencode v2.0.22 leaves it, with a title and a message
    /// the reader must not read, after these extra statements.
    pub(crate) fn write(db: &Path, sessions: &[Session], extra: &[&str]) {
        let mut statements = vec![
            "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)"
                .to_string(),
            "CREATE TABLE session_v2 (id text PRIMARY KEY, title text, directory text NOT NULL, \
             time_idle integer, idle_outcome text, time_suspended integer, \
             resume_attempts integer DEFAULT 0 NOT NULL)"
                .to_string(),
            "CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, \
             data text NOT NULL)"
                .to_string(),
        ];
        for migration in super::MIGRATIONS {
            statements.push(format!(
                "INSERT INTO migration VALUES ('{migration}', 1786000000000)"
            ));
        }
        for (id, suspended, idle, outcome) in sessions {
            let value = |value: Option<i64>| value.map_or("NULL".to_string(), |v| v.to_string());
            let outcome = outcome.map_or("NULL".to_string(), |o| format!("'{o}'"));
            statements.push(format!(
                "INSERT INTO session_v2 (id, title, directory, time_suspended, time_idle, \
                 idle_outcome) VALUES ('{id}', 'Private title', '/project', {}, {}, {outcome})",
                value(*suspended),
                value(*idle),
            ));
            statements.push(format!(
                "INSERT INTO session_message VALUES ('m-{id}', '{id}', 'Private message')"
            ));
        }
        statements.extend(extra.iter().map(|statement| statement.to_string()));
        execute(db, &statements);
    }

    /// Runs these statements on the store as its writer.
    pub(crate) fn execute(db: &Path, statements: &[String]) {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    SqliteConnectOptions::new()
                        .filename(db)
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal),
                )
                .await
                .expect("open the writer");
            for statement in statements {
                sqlx::query(statement)
                    .execute(&pool)
                    .await
                    .unwrap_or_else(|error| panic!("{statement}: {error}"));
            }
            pool.close().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variables(set: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let set = set
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect::<HashMap<_, _>>();
        move |name| set.get(name).cloned()
    }

    #[test]
    fn the_database_is_found_where_opencode_keeps_it_on_every_os() {
        let home = std::env::temp_dir().join("home");
        let data = home.join(".local").join("share").join("opencode");
        assert_eq!(
            database_path(&home, variables(&[])),
            Ok(data.join("opencode.db"))
        );
        assert_eq!(
            database_path(
                &home,
                variables(&[("XDG_DATA_HOME", ""), ("OPENCODE_DB", "")])
            ),
            Ok(data.join("opencode.db")),
            "an empty variable is unset"
        );
        let xdg = std::env::temp_dir().join("xdg");
        assert_eq!(
            database_path(
                &home,
                variables(&[("XDG_DATA_HOME", xdg.to_str().unwrap())])
            ),
            Ok(xdg.join("opencode").join("opencode.db"))
        );
        assert_eq!(
            database_path(&home, variables(&[("OPENCODE_DB", "other.db")])),
            Ok(data.join("other.db")),
            "a relative OPENCODE_DB is in the data directory"
        );
        let own = std::env::temp_dir().join("own.db");
        assert_eq!(
            database_path(&home, variables(&[("OPENCODE_DB", own.to_str().unwrap())])),
            Ok(own)
        );
        assert!(database_path(&home, variables(&[("OPENCODE_DB", ":memory:")])).is_err());
    }

    fn now_ms() -> i64 {
        Utc::now().timestamp_millis()
    }

    fn source(db: &Path) -> Database<impl Fn() -> Result<PathBuf, String> + Send + Sync> {
        let db = db.to_path_buf();
        Database::new(move || Ok(db.clone()))
    }

    fn state(reads: &SourceReads, id: &str) -> SessionState {
        reads.sessions[id].status.as_ref().unwrap().state.clone()
    }

    #[test]
    fn a_claim_is_a_running_turn_and_an_outcome_its_end() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("opencode.db");
        let claimed = now_ms() - 60_000;
        let ended = now_ms() - 30_000;
        fixture::write(
            &db,
            &[
                ("claim", Some(claimed), Some(ended), Some("succeeded")),
                ("succeeded", None, Some(ended), Some("succeeded")),
                ("failed", None, Some(ended), Some("failed")),
                ("interrupted", None, Some(ended), Some("interrupted")),
                ("no-outcome", None, Some(ended), None),
                ("new-outcome", None, Some(ended), Some("paused")),
                ("no-turn", None, None, None),
            ],
            &[],
        );
        let ids = [
            "claim",
            "succeeded",
            "failed",
            "interrupted",
            "no-outcome",
            "new-outcome",
            "no-turn",
            "not-in-store",
        ];

        let reads = source(&db).read(&ids).unwrap();

        let claim = reads.sessions["claim"].status.clone().unwrap();
        assert_eq!(
            claim.state,
            SessionState::Running,
            "a turn started after an earlier one ended"
        );
        assert_eq!(
            claim.observed_at,
            millis(claimed),
            "evidence since the claim"
        );
        assert_eq!(claim.waiting_since, None);
        assert_eq!(reads.sessions["claim"].process, None, "no process signal");
        assert_eq!(state(&reads, "succeeded"), idle_with(StopReason::EndTurn));
        assert_eq!(state(&reads, "failed"), idle_with(StopReason::Error));
        assert_eq!(
            state(&reads, "interrupted"),
            idle_with(StopReason::Cancelled)
        );
        assert_eq!(
            reads.sessions["succeeded"]
                .status
                .as_ref()
                .unwrap()
                .observed_at,
            millis(ended)
        );
        assert_eq!(
            state(&reads, "no-outcome"),
            SessionState::Idle { stop_reason: None }
        );
        assert_eq!(state(&reads, "new-outcome"), SessionState::Unknown);
        let no_turn = reads.sessions["no-turn"].status.clone().unwrap();
        assert_eq!(no_turn.state, SessionState::Idle { stop_reason: None });
        assert_eq!(no_turn.observed_at, None);
        assert!(!reads.sessions.contains_key("not-in-store"));
        assert_eq!(reads.reparsed, 7);
    }

    #[test]
    fn the_database_is_read_again_only_after_it_changed() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("opencode.db");
        fixture::write(&db, &[("s1", Some(now_ms()), None, None)], &[]);
        let source = source(&db);

        assert_eq!(source.read(&["s1"]).unwrap().reparsed, 1);
        let unchanged = source.read(&["s1", "s2"]).unwrap();
        assert_eq!(
            unchanged.reparsed, 0,
            "s2 is not in the store, which did not change"
        );
        assert_eq!(state(&unchanged, "s1"), SessionState::Running);

        fixture::execute(
            &db,
            &[format!(
                "UPDATE session_v2 SET time_suspended = NULL, time_idle = {}, \
                 idle_outcome = 'succeeded' WHERE id = 's1'",
                now_ms()
            )],
        );
        let changed = source.read(&["s1"]).unwrap();
        assert_eq!(changed.reparsed, 1);
        assert_eq!(state(&changed, "s1"), idle_with(StopReason::EndTurn));
    }

    #[test]
    fn a_later_migration_or_column_does_not_stop_the_read() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("opencode.db");
        fixture::write(
            &db,
            &[("s1", None, Some(now_ms()), Some("failed"))],
            &[
                "INSERT INTO migration VALUES ('20261001000000_future', 1786000000000)",
                "ALTER TABLE session_v2 ADD time_future integer",
            ],
        );

        let reads = source(&db).read(&["s1"]).unwrap();
        assert_eq!(state(&reads, "s1"), idle_with(StopReason::Error));
    }

    #[test]
    fn a_store_without_a_needed_migration_or_column_fails_the_source() {
        for (extra, problem) in [
            (
                "DELETE FROM migration WHERE id = '20260819222447_session_viewed_state'",
                "lacks the migration 20260819222447_session_viewed_state",
            ),
            (
                "ALTER TABLE session_v2 DROP COLUMN idle_outcome",
                "lacks the column idle_outcome",
            ),
            ("DROP TABLE migration", "has no migration table"),
            ("DROP TABLE session_v2", "lacks the column id"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let db = temp.path().join("opencode.db");
            fixture::write(&db, &[], &[extra]);
            let error = source(&db).read(&["s1"]).unwrap_err();
            assert!(error.contains(problem), "{extra}: {error}");
        }

        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("opencode.db");
        assert!(source(&missing).read(&["s1"]).is_err());
        assert!(!missing.exists(), "nothing is created");
    }

    #[test]
    fn titles_and_messages_stay_unread() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("opencode.db");
        fixture::write(&db, &[("s1", None, Some(now_ms()), Some("succeeded"))], &[]);

        let reads = source(&db).read(&["s1"]).unwrap();
        let kept = serde_json::to_string(&reads.sessions["s1"]).unwrap();
        assert!(!kept.contains("Private"), "{kept}");

        // The read needs no table or column beyond the status ones.
        let bare = temp.path().join("bare.db");
        fixture::execute(
            &bare,
            &[
                "CREATE TABLE migration (id TEXT PRIMARY KEY)".to_string(),
                format!(
                    "INSERT INTO migration VALUES ('{}'), ('{}'), ('{}')",
                    MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2]
                ),
                "CREATE TABLE session_v2 (id text, time_suspended integer, time_idle integer, \
                 idle_outcome text)"
                    .to_string(),
                "INSERT INTO session_v2 VALUES ('s1', NULL, 1786000000000, 'succeeded')"
                    .to_string(),
            ],
        );
        let reads = source(&bare).read(&["s1"]).unwrap();
        assert_eq!(state(&reads, "s1"), idle_with(StopReason::EndTurn));
    }
}
