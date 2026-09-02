use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::AppError;

use super::types::{GitUserPolicy, LocalConfig, SpaceConfig};

/// Read space config from {space_path}/.svode/config.json.
pub fn read_space_config(path: &Path) -> Result<SpaceConfig, AppError> {
    let config_path = path.join(".svode").join("config.json");
    if !config_path.exists() {
        return Err(AppError::FileNotFound(
            config_path.to_string_lossy().to_string(),
        ));
    }
    let data = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write space config to {space_path}/.svode/config.json.
pub fn write_space_config(path: &Path, config: &SpaceConfig) -> Result<(), AppError> {
    let dir = path.join(".svode");
    std::fs::create_dir_all(&dir)?;
    let mut shared_config = config.clone();
    // Personal Git automation policy is local-only. Older versions stored it in
    // shared config; every shared config write now drops those legacy fields.
    shared_config.git = None;
    let data = serde_json::to_string_pretty(&shared_config)?;
    std::fs::write(dir.join("config.json"), data)?;
    Ok(())
}

/// Read local config from {space_path}/.svode/local.json.
pub fn read_local_config(path: &Path) -> Result<LocalConfig, AppError> {
    let config_path = path.join(".svode").join("local.json");
    if !config_path.exists() {
        return Ok(LocalConfig::default());
    }
    let data = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write local config to {space_path}/.svode/local.json.
#[cfg(test)]
pub fn write_local_config(path: &Path, local: &LocalConfig) -> Result<(), AppError> {
    with_local_config_lock(path, || write_local_config_locked(path, local))
}

pub fn mutate_local_config<T>(
    path: &Path,
    mutate: impl FnOnce(&mut LocalConfig) -> Result<T, AppError>,
) -> Result<T, AppError> {
    with_local_config_lock(path, || {
        let mut local = read_local_config(path)?;
        let result = mutate(&mut local)?;
        write_local_config_locked(path, &local)?;
        Ok(result)
    })
}

fn write_local_config_locked(path: &Path, local: &LocalConfig) -> Result<(), AppError> {
    let dir = path.join(".svode");
    fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(local)?;
    let target = dir.join("local.json");
    let temp = dir.join(format!("local.json.tmp-{}", ulid::Ulid::new()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, &target)?;
        #[cfg(unix)]
        if let Err(error) = File::open(&dir).and_then(|directory| directory.sync_all()) {
            tracing::warn!(
                "failed to sync local config directory {}: {error}",
                dir.display()
            );
        }
        Ok::<_, AppError>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn with_local_config_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let config_path = path.join(".svode").join("local.json");
    let lock = {
        let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .map_err(|_| AppError::General("local config lock registry poisoned".into()))?;
        locks
            .entry(config_path)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock
        .lock()
        .map_err(|_| AppError::General("local config mutation lock poisoned".into()))?;
    operation()
}

/// Effective per-user Git policy from local-only config.
pub fn read_git_user_policy(path: &Path) -> Result<GitUserPolicy, AppError> {
    Ok(read_local_config(path)?.git.unwrap_or_default())
}

/// Safe policy read for background side-effect gates. Invalid or missing local
/// config disables automation rather than enabling background commits/sync.
pub fn effective_git_user_policy(path: &Path) -> GitUserPolicy {
    read_git_user_policy(path).unwrap_or_default()
}

pub fn write_git_user_policy(path: &Path, policy: &GitUserPolicy) -> Result<(), AppError> {
    mutate_local_config(path, |local| {
        local.git = Some(policy.clone());
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::types::{
        AgentSessionsLocalConfig, BINARY_ROUTING_VERSION, GitSpaceConfig, RoutinesLocalConfig,
    };

    fn config_with_git() -> SpaceConfig {
        SpaceConfig {
            name: "Docs".to_string(),
            description: String::new(),
            icon: "folder".to_string(),
            spaces: None,
            agent: None,
            defaults: None,
            git: Some(GitSpaceConfig {
                auto_sync: Some(true),
                auto_commit_structural: Some(true),
                auto_commit_system: Some(true),
            }),
            assets: None,
            tree: None,
        }
    }

    #[test]
    fn write_space_config_drops_legacy_personal_git_policy() {
        let temp = tempfile::tempdir().expect("temp dir");

        write_space_config(temp.path(), &config_with_git()).expect("write config");

        let data =
            std::fs::read_to_string(temp.path().join(".svode/config.json")).expect("read config");
        assert!(!data.contains("autoSync"));
        assert!(!data.contains("autoCommitStructural"));
        assert!(!data.contains("autoCommitSystem"));

        let read_back = read_space_config(temp.path()).expect("read config");
        assert!(read_back.git.is_none());
    }

    #[test]
    fn missing_binary_routing_stays_absent_on_read_and_write() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join(".svode");
        std::fs::create_dir_all(&dir).expect("svode dir");
        std::fs::write(
            dir.join("config.json"),
            r#"{"name":"Legacy","assets":{"strategy":"lfs-remote"}}"#,
        )
        .expect("legacy config");

        let config = read_space_config(temp.path()).expect("read config");
        assert!(
            config
                .assets
                .as_ref()
                .is_some_and(|assets| assets.binary_routing.is_none())
        );
        write_space_config(temp.path(), &config).expect("write config");
        let raw = std::fs::read_to_string(dir.join("config.json")).expect("config");
        assert!(!raw.contains("binaryRouting"));
    }

    #[test]
    fn future_binary_routing_fields_survive_config_round_trip() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join(".svode");
        std::fs::create_dir_all(&dir).expect("svode dir");
        std::fs::write(
            dir.join("config.json"),
            r#"{
                "name":"Future",
                "assets":{
                    "strategy":"lfs-remote",
                    "binaryRouting":{
                        "version":2,
                        "lfsExtensions":["psd"],
                        "futureMode":"content-aware"
                    }
                }
            }"#,
        )
        .expect("future config");

        let config = read_space_config(temp.path()).expect("read config");
        let routing = config
            .assets
            .as_ref()
            .and_then(|assets| assets.binary_routing.as_ref())
            .expect("routing");
        assert_ne!(routing.version, BINARY_ROUTING_VERSION);
        write_space_config(temp.path(), &config).expect("write config");
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config.json")).expect("config"),
        )
        .expect("json");
        assert_eq!(
            value["assets"]["binaryRouting"]["futureMode"],
            "content-aware"
        );
    }

    #[test]
    fn git_user_policy_defaults_false_and_round_trips_through_local_config() {
        let temp = tempfile::tempdir().expect("temp dir");

        assert_eq!(
            read_git_user_policy(temp.path()).expect("read missing local config"),
            GitUserPolicy::default()
        );

        let policy = GitUserPolicy {
            auto_sync: true,
            auto_commit_structural: false,
            auto_commit_system: true,
        };
        write_git_user_policy(temp.path(), &policy).expect("write policy");

        assert_eq!(
            read_git_user_policy(temp.path()).expect("read policy"),
            policy
        );
        assert!(
            std::fs::read_to_string(temp.path().join(".svode/local.json"))
                .expect("read local")
                .contains("autoSync")
        );
    }

    #[test]
    fn agent_sessions_local_overlay_round_trips_through_local_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let local = LocalConfig {
            agent_sessions: Some(AgentSessionsLocalConfig {
                pinned_session_ids: vec!["codex:one".to_string(), "claude-code:two".to_string()],
            }),
            ..LocalConfig::default()
        };

        write_local_config(temp.path(), &local).expect("write local config");
        let read_back = read_local_config(temp.path()).expect("read local config");

        assert_eq!(read_back.agent_sessions, local.agent_sessions);
        assert!(
            std::fs::read_to_string(temp.path().join(".svode/local.json"))
                .expect("read local")
                .contains("pinnedSessionIds")
        );
    }

    #[test]
    fn local_config_writes_preserve_agent_actor_overlay() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join(".svode");
        std::fs::create_dir_all(&dir).expect("create local config dir");
        std::fs::write(
            dir.join("local.json"),
            r#"{
                "agentActors": {
                    "01arz3ndektsv4rrffq69g5fav": { "approvalMode": "full" }
                }
            }"#,
        )
        .expect("write local config");

        write_git_user_policy(
            temp.path(),
            &GitUserPolicy {
                auto_sync: false,
                auto_commit_structural: false,
                auto_commit_system: true,
            },
        )
        .expect("update local policy");

        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("local.json")).expect("read local config"),
        )
        .expect("parse local config");
        assert_eq!(
            value["agentActors"]["01arz3ndektsv4rrffq69g5fav"]["approvalMode"],
            "full"
        );
    }

    #[test]
    fn concurrent_owner_mutations_do_not_lose_unrelated_fields() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = Arc::new(temp.path().to_path_buf());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut writers = Vec::new();

        for owner in ["git", "sessions", "routines"] {
            let path = path.clone();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || {
                barrier.wait();
                mutate_local_config(&path, |local| {
                    match owner {
                        "git" => {
                            local.git = Some(GitUserPolicy {
                                auto_sync: true,
                                auto_commit_structural: false,
                                auto_commit_system: true,
                            });
                        }
                        "sessions" => {
                            local.agent_sessions = Some(AgentSessionsLocalConfig {
                                pinned_session_ids: vec!["codex:one".into()],
                            });
                        }
                        "routines" => {
                            let mut routines = RoutinesLocalConfig::default();
                            routines.automatic_authority.insert("owner".into(), true);
                            local.routines = Some(routines);
                        }
                        _ => unreachable!(),
                    }
                    Ok(())
                })
                .unwrap();
            }));
        }
        for writer in writers {
            writer.join().unwrap();
        }

        let local = read_local_config(&path).unwrap();
        assert!(local.git.unwrap().auto_sync);
        assert_eq!(
            local.agent_sessions.unwrap().pinned_session_ids,
            vec!["codex:one"]
        );
        assert_eq!(
            local.routines.unwrap().automatic_authority.get("owner"),
            Some(&true)
        );
    }
}
