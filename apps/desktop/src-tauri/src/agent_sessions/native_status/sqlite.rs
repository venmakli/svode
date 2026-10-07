//! Read-only reads of an agent's SQLite store (Stage 10 `07` N3, N7) with
//! the SQLite bundled in Svode.

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

/// How long a read waits for a lock of the store.
const BUSY_TIMEOUT: Duration = Duration::from_secs(1);

/// The queries of one read over its connection.
pub(crate) type StoreQuery<'c, T> = Pin<Box<dyn Future<Output = Result<T, sqlx::Error>> + 'c>>;

/// One read of the store on a connection of its own: opened read-only (the
/// `mode=ro` open flag) and never `immutable`, which gives a stale state
/// while the writer's WAL holds data, with `query_only`; one short
/// transaction under a bounded wait for a lock; the connection is closed
/// after the read, since an agent may take a process that keeps its store
/// open for another holder. The read sees committed data only and never
/// blocks the writer. Like any SQLite reader it may create the `-wal` and
/// `-shm` files or update the WAL index; it changes no data. A store it
/// cannot open — missing, or a WAL store without `-shm` in a folder it may
/// not write — is an error, which the agent's source reports as its
/// diagnostic (N5).
pub(crate) fn read_only<T>(
    db: &Path,
    read: impl for<'c> FnOnce(&'c mut SqliteConnection) -> StoreQuery<'c, T>,
) -> Result<T, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(db)
        .read_only(true)
        .immutable(false)
        .create_if_missing(false)
        .busy_timeout(BUSY_TIMEOUT)
        .pragma("query_only", "ON");
    tauri::async_runtime::block_on(async move {
        let mut connection = SqliteConnection::connect_with(&options).await?;
        let result = async {
            let mut transaction = connection.begin().await?;
            let value = read(&mut transaction).await?;
            transaction.rollback().await?;
            Ok(value)
        }
        .await;
        connection.close().await.ok();
        result
    })
}

/// The columns of a table; none when the store has no such table. Readers
/// whose format marker is the set of columns they need check it with this
/// (N5, N7).
pub(crate) async fn table_columns(
    connection: &mut SqliteConnection,
    table: &str,
) -> Result<HashSet<String>, sqlx::Error> {
    let columns = sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info(?)")
        .bind(table)
        .fetch_all(connection)
        .await?;
    Ok(columns.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteJournalMode, SqlitePool, SqlitePoolOptions};

    use super::*;

    async fn writer(db: &Path) -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(db)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .expect("open the writer")
    }

    fn names(db: &Path) -> Result<Vec<String>, sqlx::Error> {
        read_only(db, |connection| {
            Box::pin(async move {
                sqlx::query_scalar::<_, String>("SELECT name FROM sessions ORDER BY name")
                    .fetch_all(&mut *connection)
                    .await
            })
        })
    }

    /// A WAL store with one committed session, closed by its writer, whose
    /// `-wal` and `-shm` files are gone as after the agent exits.
    fn closed_store(db: &Path) {
        tauri::async_runtime::block_on(async {
            let pool = writer(db).await;
            sqlx::query("CREATE TABLE sessions (name TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions VALUES ('committed')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });
        // The last connection removes both files as it closes, which can come
        // after `close` returns; Windows does not delete a file still open.
        for suffix in ["-wal", "-shm"] {
            let side = db.with_file_name(format!("state.db{suffix}"));
            for _ in 0..200 {
                if !side.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(!side.exists(), "the writer left {}", side.display());
        }
    }

    #[test]
    fn a_read_sees_the_committed_state_and_does_not_block_a_live_writer() {
        let temp = tempfile::tempdir().expect("temp dir");
        let db = temp.path().join("state.db");
        tauri::async_runtime::block_on(async {
            let pool = writer(&db).await;
            sqlx::query("CREATE TABLE sessions (name TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions VALUES ('committed')")
                .execute(&pool)
                .await
                .unwrap();
            let mut connection = pool.acquire().await.unwrap();
            sqlx::query("BEGIN IMMEDIATE")
                .execute(&mut *connection)
                .await
                .unwrap();
            sqlx::query("INSERT INTO sessions VALUES ('uncommitted')")
                .execute(&mut *connection)
                .await
                .unwrap();

            let db = db.clone();
            let read = std::thread::spawn(move || names(&db))
                .join()
                .expect("reader thread");
            assert_eq!(read.expect("read"), vec!["committed".to_string()]);

            sqlx::query("INSERT INTO sessions VALUES ('after the read')")
                .execute(&mut *connection)
                .await
                .unwrap();
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .expect("the writer commits after the read");
            drop(connection);
            pool.close().await;
        });
        assert_eq!(names(&db).expect("read").len(), 3);
    }

    #[test]
    fn a_store_whose_writer_exited_opens_with_the_bundled_sqlite() {
        let temp = tempfile::tempdir().expect("temp dir");
        let db = temp.path().join("state.db");
        closed_store(&db);
        assert!(!db.with_file_name("state.db-shm").exists());

        assert_eq!(names(&db).expect("read"), vec!["committed".to_string()]);
    }

    #[test]
    fn the_columns_of_a_table_tell_its_format() {
        let temp = tempfile::tempdir().expect("temp dir");
        let db = temp.path().join("state.db");
        closed_store(&db);

        let (sessions, missing) = read_only(&db, |connection| {
            Box::pin(async move {
                let sessions = table_columns(&mut *connection, "sessions").await?;
                let missing = table_columns(&mut *connection, "leases").await?;
                Ok((sessions, missing))
            })
        })
        .expect("read");
        assert_eq!(sessions, HashSet::from(["name".to_string()]));
        assert!(missing.is_empty());
    }

    #[test]
    fn a_missing_store_is_an_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        assert!(names(&temp.path().join("state.db")).is_err());
        assert!(!temp.path().join("state.db").exists(), "nothing is created");
    }

    /// Unix alone: Windows keeps no write bit on a folder, and a store the
    /// reader cannot open there is the missing store above.
    #[cfg(unix)]
    #[test]
    fn a_wal_store_without_shm_in_a_folder_it_may_not_write_cannot_be_read() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let folder = temp.path().join("store");
        std::fs::create_dir(&folder).unwrap();
        let db = folder.join("state.db");
        closed_store(&db);
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();

        let read = names(&db);
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read.is_err(), "{read:?}");
    }
}
