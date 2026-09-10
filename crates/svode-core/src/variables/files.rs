use super::{Error, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

pub const LOCK_FILE: &str = "variables.lock";
pub const PENDING_FILE: &str = "variables.pending.json";

/// All participating config writers lock the containing directory, not the renamed file.
pub fn lock(directory: &Path) -> Result<File> {
    fs::create_dir_all(directory).map_err(|_| Error::Unavailable)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(LOCK_FILE))
        .map_err(|_| Error::Unavailable)?;
    file.lock().map_err(|_| Error::Unavailable)?;
    Ok(file)
}

pub fn check_pending(directory: &Path) -> Result<()> {
    match fs::metadata(directory.join(PENDING_FILE)) {
        Ok(_) => Err(Error::PendingRecovery),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(Error::Unavailable),
    }
}

pub fn read(path: &Path, required: bool) -> Result<Value> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({}));
        }
        Err(_) => return Err(Error::Unavailable),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::InvalidConfig)?;
    if !value.is_object() {
        return Err(Error::InvalidConfig);
    }
    Ok(value)
}

pub fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}

pub fn atomic_write(path: &Path, value: &Value) -> Result<()> {
    let directory = path.parent().ok_or(Error::InvalidOwner)?;
    fs::create_dir_all(directory).map_err(|_| Error::Unavailable)?;
    let mut file = tempfile::Builder::new()
        .prefix("variables.tmp-")
        .tempfile_in(directory)
        .map_err(|_| Error::Unavailable)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| Error::InvalidConfig)?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| Error::Unavailable)?;
    file.persist(path).map_err(|_| Error::Unavailable)?;
    sync(directory)
}

pub fn sync(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| Error::Unavailable)?;
    Ok(())
}

/// A non-Variables writer keeps the current domain section even with a stale DTO.
/// The caller must hold `lock` across its read/modify/write operation.
pub fn write_preserving_variables(path: &Path, candidate: &Value) -> Result<()> {
    check_pending(path.parent().ok_or(Error::InvalidOwner)?)?;
    let current = read(path, false)?;
    let mut next = candidate.clone();
    let object = next.as_object_mut().ok_or(Error::InvalidConfig)?;
    match current.get("variables") {
        Some(variables) => {
            object.insert("variables".into(), variables.clone());
        }
        None => {
            object.remove("variables");
        }
    }
    atomic_write(path, &next)
}
