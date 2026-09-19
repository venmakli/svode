use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

use super::IndexError;

const SIDECARS: [&str; 4] = ["", "-wal", "-shm", "-journal"];

#[derive(Debug, PartialEq, Eq)]
struct Identity {
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64),
}

fn identity(metadata: Metadata) -> std::io::Result<Identity> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("not a regular quarantine file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(std::io::Error::other("linked quarantine evidence"));
        }
    }
    Ok(Identity {
        len: metadata.len(),
        modified: metadata.modified()?,
        created: metadata.created().ok(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        },
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    identity: Identity,
    digest: Vec<u8>,
}

fn copy_verified(path: &Path, mut output: impl Write) -> std::io::Result<Fingerprint> {
    let before = identity(fs::symlink_metadata(path)?)?;
    let mut input = File::open(path)?;
    if identity(input.metadata()?)? != before {
        return Err(std::io::Error::other("quarantine identity changed"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    if identity(input.metadata()?)? != before || identity(fs::symlink_metadata(path)?)? != before {
        return Err(std::io::Error::other(
            "quarantine changed during inspection",
        ));
    }
    Ok(Fingerprint {
        identity: before,
        digest: hash.finalize().to_vec(),
    })
}

fn paths(directory: &Path, generation: &str) -> [PathBuf; 4] {
    SIDECARS.map(|suffix| directory.join(format!("index.db{suffix}.incompatible-{generation}")))
}

fn present(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[derive(PartialEq, Eq)]
struct DirectoryIdentity {
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64),
}

fn directory_identity(path: &Path) -> std::io::Result<DirectoryIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || path.canonicalize()? != path {
        return Err(std::io::Error::other("quarantine directory changed"));
    }
    Ok(DirectoryIdentity {
        created: metadata.created().ok(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        },
    })
}

struct Snapshot {
    directory: PathBuf,
    directory_identity: DirectoryIdentity,
    temp: tempfile::TempDir,
    files: [PathBuf; 4],
    fingerprints: [Option<Fingerprint>; 4],
}

impl Snapshot {
    fn capture(directory: &Path, generation: &str) -> Result<Self, IndexError> {
        let directory_identity = directory_identity(directory)?;
        let files = paths(directory, generation);
        let temp = tempfile::tempdir()?;
        let mut fingerprints = [None, None, None, None];
        for (i, path) in files.iter().enumerate() {
            if present(path)? {
                fingerprints[i] = Some(copy_verified(
                    path,
                    File::create(temp.path().join(format!("index.db{}", SIDECARS[i])))?,
                )?);
            }
        }
        let snapshot = Self {
            directory: directory.to_path_buf(),
            directory_identity,
            temp,
            files,
            fingerprints,
        };
        snapshot.verify()?;
        Ok(snapshot)
    }

    fn verify(&self) -> Result<(), IndexError> {
        if directory_identity(&self.directory)? != self.directory_identity {
            return Err(IndexError::Index(
                "quarantine directory replaced; cleanup skipped".into(),
            ));
        }
        for (path, expected) in self.files.iter().zip(&self.fingerprints) {
            let current = if present(path)? {
                Some(copy_verified(path, std::io::sink())?)
            } else {
                None
            };
            if &current != expected {
                return Err(IndexError::Index(
                    "quarantine family changed; cleanup skipped".into(),
                ));
            }
        }
        Ok(())
    }

    fn delete(self) -> Result<(), IndexError> {
        self.delete_with(|path| fs::remove_file(path))
    }

    fn delete_with(
        mut self,
        mut remove: impl FnMut(&Path) -> std::io::Result<()>,
    ) -> Result<(), IndexError> {
        self.verify()?;
        // Main is removed last. Any partial failure leaves recognizable recovery
        // material, which must pass classification again on the next successful scan.
        for i in [2, 3, 1, 0] {
            if self.fingerprints[i].is_some() {
                self.verify()?;
                remove(&self.files[i])?;
                self.fingerprints[i] = None;
            }
        }
        Ok(())
    }
}

// Fingerprints of complete sqlite_master definitions from the shipped schemas:
// 14: 68edf6b; 15: d7653f1; 16: 5d7c1f4; 17: 65c0607.
// Include tables, columns, constraints, FTS shadows, indexes, views and triggers.
fn known_schema(version: i64) -> Option<&'static str> {
    match version {
        14 => Some("a6ae1f41bce86ebdbbb6c617fa23aa4733d0d49470913f90e6712dcbe712eedc"),
        15 | 16 => Some("f4d6d0171937d6834a6dd827294e53ac15f9f321a9fc9d9edbabf60d0731f723"),
        17 => Some("ff16232afdc78ca4e0728fdee24e1b312e08550d694344d45d5403db8f974a34"),
        _ => None,
    }
}

async fn derived(snapshot: &Snapshot) -> Result<bool, IndexError> {
    if snapshot.fingerprints[0].is_none()
        || snapshot.fingerprints[3].is_some()
        || (snapshot.fingerprints[2].is_some() && snapshot.fingerprints[1].is_none())
    {
        return Ok(false);
    }
    if snapshot.fingerprints[1].is_some()
        && !super::retention_wal::valid(
            &snapshot.temp.path().join("index.db"),
            &snapshot.temp.path().join("index.db-wal"),
        )?
    {
        return Ok(false);
    }
    // SQLite may recover/checkpoint the disposable copy, never the originals.
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(snapshot.temp.path().join("index.db")),
    )
    .await?;
    let result = inspect_schema(&mut connection).await;
    connection.close().await?;
    result
}

async fn inspect_schema(connection: &mut SqliteConnection) -> Result<bool, IndexError> {
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *connection)
        .await?;
    if integrity != ["ok"] {
        return Ok(false);
    }
    let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM schema_version")
        .fetch_all(&mut *connection)
        .await?;
    let [version] = versions.as_slice() else {
        return Ok(false);
    };
    let Some(expected) = known_schema(*version) else {
        return Ok(false);
    };
    let definitions: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
            .fetch_all(&mut *connection)
            .await?;
    let mut hash = Sha256::new();
    for (kind, name, table, sql) in definitions {
        for value in [kind, name, table, sql.unwrap_or_default()] {
            hash.update(
                value
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .as_bytes(),
            );
            hash.update([0]);
        }
    }
    Ok(format!("{:x}", hash.finalize()) == expected)
}

#[cfg(test)]
async fn cleanup(directory: &Path) -> Result<(), IndexError> {
    cleanup_with_owner(directory, None).await
}

pub async fn cleanup_with_owner(
    directory: &Path,
    owner: Option<&super::lifecycle::CleanupOwner>,
) -> Result<(), IndexError> {
    // The lifecycle owner supplies the canonical directory. Never traverse a
    // replacement symlink or discover candidates recursively in sibling owners.
    if fs::symlink_metadata(directory)?.file_type().is_symlink()
        || directory.canonicalize()? != directory
    {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        if owner.is_some_and(|owner| owner.is_closed()) {
            return Ok(());
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(generation) = name
            .to_str()
            .and_then(|name| name.strip_prefix("index.db.incompatible-"))
        else {
            continue;
        };
        if generation.is_empty()
            || !generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'-')
        {
            continue;
        }
        let result = async {
            let source_directory = directory.to_path_buf();
            let stamp = generation.to_string();
            let snapshot =
                tokio::task::spawn_blocking(move || Snapshot::capture(&source_directory, &stamp))
                    .await
                    .map_err(|_| {
                        IndexError::Index("quarantine inspection worker failed".into())
                    })??;
            if derived(&snapshot).await? {
                let deletion = match owner {
                    Some(owner) => match owner.authorize_deletion().await {
                        Some(guard) => Some(guard),
                        None => return Ok(()),
                    },
                    None => None,
                };
                tokio::task::spawn_blocking(move || {
                    // Retain authorization if the async awaiter is cancelled.
                    let _deletion = deletion;
                    snapshot.delete()
                })
                .await
                .map_err(|_| IndexError::Index("quarantine removal worker failed".into()))??;
                tracing::info!(
                    store = "index",
                    generation,
                    "removed derived incompatible family after source reconciliation"
                );
            } else {
                tracing::debug!(
                    store = "index",
                    generation,
                    "preserved protected or unknown quarantine family"
                );
            }
            Ok::<_, IndexError>(())
        }
        .await;
        if let Err(error) = result {
            // SQLite errors may contain schema text; never log their message.
            tracing::warn!(store = "index", generation, error_kind = ?std::mem::discriminant(&error), "quarantine cleanup incomplete; preserved remainder for retry");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::db;

    async fn fixture(directory: &Path, generation: &str, version: i64, extra: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = paths(directory, generation)[0].clone();
        let sql = match version {
            14 => include_str!("fixtures/index-v14.sql"),
            15 | 16 => include_str!("fixtures/index-v15.sql"),
            _ => include_str!("fixtures/index-v17.sql"),
        };
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(sql).execute(&mut connection).await.unwrap();
        sqlx::query("UPDATE schema_version SET version = ?")
            .bind(version)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(extra).execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        path
    }

    #[tokio::test]
    async fn all_known_schemas_and_current_ddl_match_frozen_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        for version in 14..=17 {
            fixture(&directory, &version.to_string(), version, "").await;
            let snapshot = Snapshot::capture(&directory, &version.to_string()).unwrap();
            assert!(derived(&snapshot).await.unwrap(), "version {version}");
            snapshot.verify().unwrap();
        }
        let canonical = directory.join("index.db");
        let pool = db::create_pool(&canonical).await.unwrap();
        db::ensure_schema(&pool).await.unwrap();
        db::close_pool(&pool).await;
        let quarantined =
            db::quarantine_database_family(&canonical, db::QuarantineReason::Incompatible).unwrap();
        let name = quarantined[0].file_name().unwrap().to_str().unwrap();
        let generation = name.strip_prefix("index.db.incompatible-").unwrap();
        assert!(
            derived(&Snapshot::capture(&directory, generation).unwrap())
                .await
                .unwrap()
        );
        cleanup(&directory).await.unwrap();
        assert_eq!(fs::read_dir(directory).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn protected_classes_and_sibling_active_stores_keep_their_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        fixture(
            &directory,
            "1",
            13,
            "CREATE TABLE routine_runs (id TEXT); INSERT INTO routine_runs VALUES ('keep');",
        )
        .await;
        fixture(&directory, "2", 18, "").await;
        fixture(
            &directory,
            "3",
            17,
            "CREATE TABLE unexpected (value TEXT); INSERT INTO unexpected VALUES ('keep');",
        )
        .await;
        fixture(
            &directory,
            "4",
            17,
            "ALTER TABLE entries ADD COLUMN operational_state TEXT;",
        )
        .await;
        fixture(&directory, "5", 17, "DROP TABLE schema_version;").await;
        fixture(
            &directory,
            "6",
            17,
            "INSERT INTO schema_version VALUES (17);",
        )
        .await;
        fixture(&directory, "7", 17, "").await;
        fs::write(paths(&directory, "7")[3].clone(), "journal evidence").unwrap();
        fs::write(paths(&directory, "8")[0].clone(), "corrupt main").unwrap();
        fs::write(paths(&directory, "9")[1].clone(), "orphan wal").unwrap();
        for name in [
            "index.db",
            "index.db-wal",
            "routines.db",
            "routines.db.incompatible-1",
            "agent-sessions.db",
            "index.db.corrupt-1",
        ] {
            fs::write(directory.join(name), format!("protected {name}")).unwrap();
        }
        let sibling = directory.join("sibling/.svode");
        fixture(&sibling, "1", 15, "").await;
        let before = files(&directory);
        cleanup(&directory).await.unwrap();
        assert_eq!(files(&directory), before);
        assert!(paths(&sibling, "1")[0].exists());
    }

    fn files(directory: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut result = fs::read_dir(directory)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().unwrap().is_file())
            .map(|entry| (entry.path(), fs::read(entry.path()).unwrap()))
            .collect::<Vec<_>>();
        result.sort();
        result
    }

    #[tokio::test]
    async fn wal_schema_is_inspected_on_copy_and_invalid_tail_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let live = directory.join("live.db");
        let pool = db::create_pool(&live).await.unwrap();
        sqlx::raw_sql(include_str!("fixtures/index-v15.sql"))
            .execute(&pool)
            .await
            .unwrap();
        for generation in ["1", "2", "3", "4"] {
            for suffix in ["", "-wal", "-shm"] {
                fs::copy(
                    directory.join(format!("live.db{suffix}")),
                    directory.join(format!("index.db{suffix}.incompatible-{generation}")),
                )
                .unwrap();
            }
        }
        let original = files(&directory);
        let snapshot = Snapshot::capture(&directory, "1").unwrap();
        assert!(derived(&snapshot).await.unwrap());
        assert_eq!(files(&directory), original);
        let invalid = paths(&directory, "2")[1].clone();
        fs::OpenOptions::new()
            .append(true)
            .open(&invalid)
            .unwrap()
            .write_all(b"broken tail")
            .unwrap();
        let corrupt = paths(&directory, "3")[1].clone();
        let mut bytes = fs::read(&corrupt).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        fs::write(&corrupt, bytes).unwrap();
        let mismatched = paths(&directory, "4")[0].clone();
        let mut main_bytes = fs::read(&mismatched).unwrap();
        main_bytes[18..20].copy_from_slice(&[1, 1]);
        fs::write(&mismatched, main_bytes).unwrap();
        cleanup(&directory).await.unwrap();
        assert!(!paths(&directory, "1")[0].exists());
        assert!(paths(&directory, "2")[0].exists());
        assert!(paths(&directory, "3")[0].exists());
        assert!(paths(&directory, "4")[0].exists());
        assert!(live.exists());
        db::close_pool(&pool).await;
    }

    #[tokio::test]
    async fn partial_cleanup_failure_is_retryable_without_schema_reset() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        fixture(&directory, "1", 15, "").await;
        fs::write(&paths(&directory, "1")[1], []).unwrap();
        fs::write(&paths(&directory, "1")[2], []).unwrap();
        let snapshot = Snapshot::capture(&directory, "1").unwrap();
        assert!(derived(&snapshot).await.unwrap());
        let mut calls = 0;
        assert!(
            snapshot
                .delete_with(|path| {
                    calls += 1;
                    if calls == 2 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "injected removal failure",
                        ));
                    }
                    fs::remove_file(path)
                })
                .is_err()
        );
        assert!(paths(&directory, "1")[0].exists());
        assert!(!paths(&directory, "1")[2].exists());
        cleanup(&directory).await.unwrap();
        cleanup(&directory).await.unwrap();
        assert!(!paths(&directory, "1")[0].exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_hardlinks_and_changed_family_are_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let original = fixture(&directory, "1", 15, "").await;
        std::os::unix::fs::symlink(&original, &paths(&directory, "2")[0]).unwrap();
        let snapshot = Snapshot::capture(&directory, "1").unwrap();
        fs::write(&original, "replacement evidence").unwrap();
        assert!(snapshot.delete().is_err());
        assert_eq!(fs::read(&original).unwrap(), b"replacement evidence");
        fixture(&directory, "3", 15, "").await;
        std::os::unix::fs::symlink(&original, &paths(&directory, "3")[1]).unwrap();
        let hardlink = fixture(&directory, "4", 15, "").await;
        fs::hard_link(&hardlink, directory.join("index.db")).unwrap();
        cleanup(&directory).await.unwrap();
        assert!(paths(&directory, "2")[0].is_symlink());
        assert!(paths(&directory, "3")[0].exists());
        assert!(hardlink.exists());
    }
}
