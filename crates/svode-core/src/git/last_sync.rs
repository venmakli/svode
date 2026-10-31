//! When each repository last synced successfully on this device (Stage 11
//! 1.E, «Видимость»). The time is device state: the host keeps it in a file
//! of its own, outside the project, so it survives a restart and never
//! reaches project files or history.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The file name hosts give the store in their own data directory.
pub const LAST_SYNC_FILE: &str = "git-last-sync.json";

/// Serializes the read-modify-write of the store within the process.
static WRITE: Mutex<()> = Mutex::new(());

/// Repository path → milliseconds since the Unix epoch.
type Times = BTreeMap<String, u64>;

fn key(repository: &Path) -> String {
    std::fs::canonicalize(repository)
        .unwrap_or_else(|_| repository.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn load(store: &Path) -> Times {
    std::fs::read(store)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The last successful sync of `repository`, in milliseconds since the Unix
/// epoch; `None` before the first one.
pub fn read(store: &Path, repository: &Path) -> Option<u64> {
    load(store).get(&key(repository)).copied()
}

/// Records a successful sync of `repository` at `at` and returns its time in
/// milliseconds since the Unix epoch.
pub fn record(store: &Path, repository: &Path, at: SystemTime) -> std::io::Result<u64> {
    let millis = at
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    let _guard = WRITE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut times = load(store);
    times.insert(key(repository), millis);
    let directory = store
        .parent()
        .ok_or_else(|| std::io::Error::other("the store has no directory"))?;
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::Builder::new()
        .prefix("git-last-sync.tmp-")
        .tempfile_in(directory)?;
    file.write_all(&serde_json::to_vec_pretty(&times).map_err(std::io::Error::other)?)?;
    file.as_file().sync_all()?;
    file.persist(store).map_err(|error| error.error)?;
    Ok(millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_time_survives_a_restart_and_stays_out_of_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("project");
        std::fs::create_dir_all(&repository).unwrap();
        let other = temp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let store = temp.path().join("app-config").join(LAST_SYNC_FILE);

        assert_eq!(read(&store, &repository), None, "not synced yet");
        let at = UNIX_EPOCH + Duration::from_millis(1_761_900_000_123);
        assert_eq!(record(&store, &repository, at).unwrap(), 1_761_900_000_123);
        record(&store, &other, at + Duration::from_secs(60)).unwrap();

        // A new process reads the same file.
        assert_eq!(read(&store, &repository), Some(1_761_900_000_123));
        assert_eq!(read(&store, &other), Some(1_761_900_060_123));
        // The same repository through another spelling of its path.
        assert_eq!(
            read(&store, &repository.join("..").join("project")),
            Some(1_761_900_000_123)
        );
        assert_eq!(
            std::fs::read_dir(&repository).unwrap().count(),
            0,
            "nothing is written into the project"
        );
    }
}
