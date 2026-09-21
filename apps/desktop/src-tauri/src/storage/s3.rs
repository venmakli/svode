//! S3 target helpers, agent binary discovery and connection checks through OpenDAL.
//!
//! The split between this module and `strategy.rs` keeps strategy.rs focused
//! on git/.gitattributes wiring while all S3-specific concerns live here.

use std::path::{Path, PathBuf};

use opendal::{Operator, services::S3};

use crate::error::AppError;
use crate::process;

pub const AGENT_CONFIG_REL: &str = svode_core::storage::s3::CONFIG_REL;

fn slug_source(source: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;

    for ch in source.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_separator && !out.is_empty() {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
            pending_separator = false;
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/' | '\\' | ':' | '+' | '&')
        {
            pending_separator = !out.is_empty();
        }
    }

    out.trim_matches('-').to_string()
}

pub fn normalize_prefix_part(source: &str, fallback: &str) -> String {
    let normalized = slug_source(source);
    if !normalized.is_empty() {
        return normalized;
    }

    let fallback = slug_source(fallback);
    if fallback.is_empty() {
        "project".to_string()
    } else {
        fallback
    }
}

fn project_prefix(project: &Path, project_name: Option<&str>) -> String {
    let path_name = project
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let from_path = slug_source(path_name);
    if !from_path.is_empty() {
        return from_path;
    }

    project_name
        .map(|name| normalize_prefix_part(name, "project"))
        .unwrap_or_else(|| "project".to_string())
}

pub fn default_root_prefix(project: &Path, project_name: Option<&str>) -> String {
    format!("{}/root", project_prefix(project, project_name))
}

pub fn default_repo_space_prefix(
    project: &Path,
    project_name: Option<&str>,
    space_dir: &Path,
) -> String {
    let raw_space = space_dir
        .strip_prefix(project)
        .ok()
        .and_then(|path| path.to_str())
        .or_else(|| space_dir.file_name().and_then(|name| name.to_str()))
        .unwrap_or("");
    let space_prefix = normalize_prefix_part(raw_space, "space");
    format!("{}/{}", project_prefix(project, project_name), space_prefix)
}

pub fn normalize_prefix_path(prefix: &str, fallback: &str) -> String {
    let segments = prefix
        .trim()
        .trim_matches('/')
        .split(['/', '\\'])
        .map(slug_source)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.is_empty() {
        fallback.trim_matches('/').to_string()
    } else {
        segments.join("/")
    }
}

/// Delete the agent config file. Missing file is fine.
pub fn delete_agent_config(space_dir: &Path) -> Result<(), AppError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Resolve the bundled `svode-lfs` sidecar binary on disk. Looks first next
/// to the host executable (production / `tauri build`), then falls back to
/// the `src-tauri/binaries/svode-lfs-<triple>` artifact written by
/// `scripts/build-svode-lfs.mjs` (dev mode), and finally to the cargo target
/// shared Cargo workspace output. Returns an absolute path so git's
/// `lfs.customtransfer.svode-lfs.path` config never relies on cwd.
pub fn resolve_agent_binary() -> Result<PathBuf, AppError> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();

    // 1. Bundled sidecar — Tauri places externalBin next to the host binary
    //    after stripping the target-triple suffix, so a plain `svode-lfs[.exe]`
    //    in the same directory wins for production builds.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for name in svode_lfs_plain_names() {
                candidates.push(parent.join(name));
            }
        }
    }

    // 2. Dev mode — the build script copies a triple-suffixed artifact to
    //    `src-tauri/binaries/`. cwd at runtime is `src-tauri/`, so a
    //    relative lookup is enough.
    let triple = std::env::var("TARGET").ok().or_else(rustc_host_triple);
    if let Some(triple) = triple.as_deref() {
        for name in svode_lfs_suffixed_names(triple) {
            candidates.push(manifest_dir.join("binaries").join(name));
        }
    }

    // 3. Last-ditch dev fallback for direct Cargo builds in the shared workspace.
    let workspace_dir = manifest_dir.join("../../..");
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .filter(|value| PathBuf::from(value).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_dir.join("target"));
    for profile in ["lfs-release", "release", "debug"] {
        for name in svode_lfs_plain_names() {
            candidates.push(target_dir.join(profile).join(&name));
            if let Some(triple) = triple.as_deref() {
                candidates.push(target_dir.join(triple).join(profile).join(&name));
            }
        }
    }

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        let absolute = candidate.canonicalize().map_err(|e| {
            AppError::Storage(format!(
                "svode-lfs binary path could not be canonicalized ({}): {e}",
                candidate.display()
            ))
        })?;
        validate_agent_binary(&absolute)?;
        return Ok(absolute);
    }

    Err(AppError::Storage(
        "svode-lfs binary not found — run `bun run build:svode-lfs` or rebuild the app bundle"
            .into(),
    ))
}

fn svode_lfs_plain_names() -> Vec<String> {
    svode_lfs_plain_names_for(cfg!(windows))
}

fn svode_lfs_plain_names_for(windows: bool) -> Vec<String> {
    if windows {
        vec!["svode-lfs.exe".to_string(), "svode-lfs".to_string()]
    } else {
        vec!["svode-lfs".to_string()]
    }
}

fn svode_lfs_suffixed_names(triple: &str) -> Vec<String> {
    svode_lfs_suffixed_names_for(triple, cfg!(windows))
}

fn svode_lfs_suffixed_names_for(triple: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![
            format!("svode-lfs-{triple}.exe"),
            format!("svode-lfs-{triple}"),
        ]
    } else {
        vec![format!("svode-lfs-{triple}")]
    }
}

fn validate_agent_binary(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(AppError::Storage(format!(
            "svode-lfs binary path must be absolute: {}",
            path.display()
        )));
    }
    if !path.is_file() {
        return Err(AppError::Storage(format!(
            "svode-lfs binary is not a file: {}",
            path.display()
        )));
    }
    validate_agent_binary_executable(path)
}

#[cfg(target_os = "linux")]
fn validate_agent_binary_executable(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = std::fs::metadata(path)?.permissions().mode();
    if mode & 0o111 == 0 {
        return Err(AppError::Storage(format!(
            "svode-lfs binary is not executable: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_agent_binary_executable(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

/// Cheap shell-out to ask rustc for the host triple. Cached lazily would be
/// nice but resolve_agent_binary is only called for managed readiness/setup,
/// so we just spawn the process each time.
fn rustc_host_triple() -> Option<String> {
    let mut cmd = std::process::Command::new("rustc");
    process::hide_window(&mut cmd);
    let out = cmd.arg("-vV").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    s.lines()
        .find_map(|l| l.strip_prefix("host:").map(|v| v.trim().to_string()))
}

/// Build an OpenDAL operator from backend-resolved credentials, without the
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
    Operator::new(builder).map_err(|e| AppError::Storage(format!("opendal build: {e}")))
}

/// Real S3 connection check. Round-trips a 0-byte probe object — write,
/// stat, delete — under a `.svode-probe/` prefix. We deliberately don't
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
        ".svode-probe/{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S%f")
    );

    op.write(&probe_key, b"svode-probe".to_vec())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_part_normalization_builds_path_safe_slugs() {
        assert_eq!(normalize_prefix_part(" Big Quest ", "project"), "big-quest");
        assert_eq!(
            normalize_prefix_part("Marketing Docs/2026", "space"),
            "marketing-docs-2026"
        );
        assert_eq!(normalize_prefix_part("!!!", "space"), "space");
    }

    #[test]
    fn default_prefixes_use_project_root_and_repo_space_layout() {
        let project = Path::new("/tmp/Big Quest");
        assert_eq!(
            default_root_prefix(project, Some("Ignored")),
            "big-quest/root"
        );
        assert_eq!(
            default_repo_space_prefix(
                project,
                Some("Ignored"),
                Path::new("/tmp/Big Quest/Marketing")
            ),
            "big-quest/marketing"
        );
    }

    #[test]
    fn prefix_path_normalization_preserves_safe_segments() {
        assert_eq!(
            normalize_prefix_path(" / Big Quest // Marketing Docs / ", "fallback/root"),
            "big-quest/marketing-docs"
        );
        assert_eq!(
            normalize_prefix_path("///", "fallback/root"),
            "fallback/root"
        );
    }

    #[test]
    fn svode_lfs_names_include_windows_exe_fallbacks() {
        assert_eq!(
            svode_lfs_plain_names_for(true),
            vec!["svode-lfs.exe".to_string(), "svode-lfs".to_string()]
        );
        assert_eq!(
            svode_lfs_suffixed_names_for("x86_64-pc-windows-msvc", true),
            vec![
                "svode-lfs-x86_64-pc-windows-msvc.exe".to_string(),
                "svode-lfs-x86_64-pc-windows-msvc".to_string(),
            ]
        );
    }

    #[test]
    fn svode_lfs_names_use_plain_unix_binary_names() {
        assert_eq!(
            svode_lfs_plain_names_for(false),
            vec!["svode-lfs".to_string()]
        );
        assert_eq!(
            svode_lfs_suffixed_names_for("aarch64-apple-darwin", false),
            vec!["svode-lfs-aarch64-apple-darwin".to_string()]
        );
    }
}
