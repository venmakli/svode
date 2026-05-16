//! S3-side helpers for the LFS S3 strategy: credential storage in the OS
//! keychain, agent-config file management, and a real `check_s3_connection`
//! that round-trips through OpenDAL.
//!
//! The split between this module and `strategy.rs` keeps strategy.rs focused
//! on git/.gitattributes wiring while all S3-specific concerns live here.

use std::path::{Path, PathBuf};

use opendal::{Operator, services::S3};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::space::types::AssetsS3Config;

/// Keychain service identifier — must match the constant in `lfs-dal`.
pub const KEYCHAIN_SERVICE: &str = "app.combai.desktop.lfs-s3";

/// Path of the agent config file (relative to the space root). The
/// external lfs-dal binary reads this on init to learn the bucket and the
/// keychain account name to query. Listed in `.gitignore` so secrets-by-
/// proxy never leak to the remote.
pub const AGENT_CONFIG_REL: &str = ".combai/lfs-s3-agent.json";

/// Managed `.gitignore` block that hides the agent config file. Kept tiny on
/// purpose so it can sit alongside the existing `# combai:assets-ignore`
/// block without confusion.
const AGENT_IGNORE_START: &str = "# combai:lfs-s3-agent:start";
const AGENT_IGNORE_END: &str = "# combai:lfs-s3-agent:end";
const AGENT_IGNORE_BODY: &str = ".combai/lfs-s3-agent.json";

/// Persisted shape of the agent config file. Mirrors the struct in
/// `crates/lfs-dal/src/main.rs::AgentConfig`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigFile {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub keychain_account: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// Secret blob stored in the keychain. JSON-serialized so we can extend
/// without rotating the key (e.g. session token, expiry).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecrets {
    pub access_key: String,
    pub secret_key: String,
}

/// Build a stable keychain account identifier for a given S3 target. We use
/// `<bucket>@<endpoint-host>` so re-pointing a space at a different
/// bucket creates a fresh entry instead of overwriting the previous one.
pub fn keychain_account(cfg: &AssetsS3Config) -> String {
    let host = cfg
        .endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    format!("{}@{}", cfg.bucket, host)
}

/// Save credentials to the OS keychain. Runs on a blocking thread because
/// `keyring` is sync.
pub async fn save_credentials(account: String, secrets: AgentSecrets) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account)
            .map_err(|e| AppError::Storage(format!("keychain open: {e}")))?;
        let payload = serde_json::to_string(&secrets)?;
        entry
            .set_password(&payload)
            .map_err(|e| AppError::Storage(format!("keychain write: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Storage(format!("keychain task: {e}")))?
}

/// Delete credentials from the keychain. Missing entries are not an error —
/// the desired post-state is "no credentials", which is already true.
pub async fn clear_credentials(account: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account)
            .map_err(|e| AppError::Storage(format!("keychain open: {e}")))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Storage(format!("keychain delete: {e}"))),
        }
    })
    .await
    .map_err(|e| AppError::Storage(format!("keychain task: {e}")))?
}

/// Write the agent config file to disk. Parent directory is created if
/// missing.
pub fn write_agent_config(space_dir: &Path, cfg: &AgentConfigFile) -> Result<(), AppError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Read the agent config file. Returns `None` when the file does not exist.
#[allow(dead_code)]
pub fn read_agent_config(space_dir: &Path) -> Result<Option<AgentConfigFile>, AppError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    let cfg: AgentConfigFile = serde_json::from_slice(&bytes)?;
    Ok(Some(cfg))
}

/// Delete the agent config file. Missing file is fine.
pub fn delete_agent_config(space_dir: &Path) -> Result<(), AppError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Ensure the managed `# combai:lfs-s3-agent` block is present in
/// `.gitignore` so the agent config file (with its keychain account name) is
/// never committed. Idempotent.
pub fn ensure_agent_gitignore(space_dir: &Path) -> Result<(), AppError> {
    let path = space_dir.join(".gitignore");
    let current = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if current.contains(AGENT_IGNORE_START) {
        return Ok(());
    }
    let mut next = current.trim_end_matches('\n').to_string();
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(AGENT_IGNORE_START);
    next.push('\n');
    next.push_str(AGENT_IGNORE_BODY);
    next.push('\n');
    next.push_str(AGENT_IGNORE_END);
    next.push('\n');
    std::fs::write(&path, next)?;
    Ok(())
}

/// Resolve the bundled `lfs-dal` sidecar binary on disk. Looks first next
/// to the host executable (production / `tauri build`), then falls back to
/// the `src-tauri/binaries/lfs-dal-<triple>` artifact written by
/// `scripts/build-lfs-dal.mjs` (dev mode), and finally to the cargo target
/// dir of the standalone crate. Returns an absolute path so git's
/// `lfs.customtransfer.lfs-dal.path` config never relies on cwd.
pub fn resolve_agent_binary(_app_handle: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let exe_name = if cfg!(windows) {
        "lfs-dal.exe"
    } else {
        "lfs-dal"
    };

    // 1. Bundled sidecar — Tauri places externalBin next to the host binary
    //    after stripping the target-triple suffix, so a plain `lfs-dal[.exe]`
    //    in the same directory wins for production builds.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(exe_name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 2. Dev mode — the build script copies a triple-suffixed artifact to
    //    `src-tauri/binaries/`. cwd at runtime is `src-tauri/`, so a
    //    relative lookup is enough.
    let triple = std::env::var("TARGET").ok().or_else(rustc_host_triple);
    if let Some(triple) = triple.as_deref() {
        let suffixed = if cfg!(windows) {
            format!("lfs-dal-{triple}.exe")
        } else {
            format!("lfs-dal-{triple}")
        };
        let candidate = PathBuf::from("binaries").join(&suffixed);
        if candidate.exists() {
            return Ok(candidate.canonicalize().unwrap_or(candidate));
        }
    }

    // 3. Last-ditch dev fallback — the crate's own cargo target dir, in case
    //    someone ran `cargo build` by hand without going through the script.
    for rel in [
        "../../crates/lfs-dal/target/release/lfs-dal",
        "../../crates/lfs-dal/target/debug/lfs-dal",
    ] {
        let p = PathBuf::from(rel);
        if p.exists() {
            return Ok(p.canonicalize().unwrap_or(p));
        }
    }

    Err(AppError::Storage(
        "lfs-dal binary not found — run `bun run build:lfs-dal` or rebuild the app bundle".into(),
    ))
}

/// Cheap shell-out to ask rustc for the host triple. Cached lazily would be
/// nice but resolve_agent_binary is rarely called (only on strategy switch),
/// so we just spawn the process each time.
fn rustc_host_triple() -> Option<String> {
    let out = std::process::Command::new("rustc")
        .arg("-vV")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    s.lines()
        .find_map(|l| l.strip_prefix("host:").map(|v| v.trim().to_string()))
}

/// Build an OpenDAL operator from frontend-supplied credentials. Used by
/// `check_s3_connection` so we can validate without going through the
/// keychain round-trip.
pub fn operator_for(
    endpoint: &str,
    bucket: &str,
    region: &str,
    access_key: &str,
    secret_key: &str,
) -> Result<Operator, AppError> {
    let builder = S3::default()
        .bucket(bucket)
        .region(region)
        .endpoint(endpoint)
        .access_key_id(access_key)
        .secret_access_key(secret_key);
    Operator::new(builder)
        .map_err(|e| AppError::Storage(format!("opendal build: {e}")))
        .map(|b| b.finish())
}

/// Real S3 connection check. Round-trips a 0-byte probe object — write,
/// stat, delete — under a `.combai-probe/` prefix. We deliberately don't
/// rely on `op.check()` (which calls `stat ""` and trips on buckets that
/// disallow listing).
pub async fn check_connection(
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
) -> Result<bool, AppError> {
    let op = operator_for(&endpoint, &bucket, &region, &access_key, &secret_key)?;

    let probe_key = format!(
        ".combai-probe/{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S%f")
    );

    op.write(&probe_key, b"combai-probe".to_vec())
        .await
        .map_err(|e| AppError::Storage(format!("S3 probe write failed: {e}")))?;

    let stat_ok = op.stat(&probe_key).await.is_ok();

    // Best-effort cleanup — if delete fails the probe object is harmless and
    // the bucket lifecycle (if any) will eventually GC it.
    let _ = op.delete(&probe_key).await;

    if !stat_ok {
        return Err(AppError::Storage(
            "S3 probe object missing after write — bucket likely misconfigured".into(),
        ));
    }
    Ok(true)
}
