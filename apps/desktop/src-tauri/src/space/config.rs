use std::path::Path;

use crate::error::AppError;

use super::types::{LocalConfig, SpaceConfig};

/// Read space config from {space_path}/.svode/config.json.
pub fn read_space_config(path: &Path) -> Result<SpaceConfig, AppError> {
    Ok(svode_core::space_config::read(path)?)
}

/// Write space config to {space_path}/.svode/config.json, keeping the keys
/// this version does not know as they are in the file.
pub fn write_space_config(path: &Path, config: &SpaceConfig) -> Result<(), AppError> {
    Ok(svode_core::space_config::write(path, config)?)
}

/// Read local config from {space_path}/.svode/local.json.
pub fn read_local_config(path: &Path) -> Result<LocalConfig, AppError> {
    Ok(svode_core::routines::local::read(path)?)
}

pub fn mutate_local_config<T>(
    path: &Path,
    mutate: impl FnOnce(&mut LocalConfig) -> Result<T, AppError>,
) -> Result<T, AppError> {
    svode_core::routines::local::mutate_with(path, mutate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::types::GitUserPolicy;
    use std::sync::Arc;
    use svode_core::routines::local::RoutinesLocalConfig;

    #[test]
    fn saved_settings_config_without_unknown_keys_keeps_them_in_the_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join(".svode");
        std::fs::create_dir_all(&dir).expect("svode dir");
        std::fs::write(
            dir.join("config.json"),
            r#"{"name":"Docs","futureRoot":1,"tree":{"exclude":["tmp"],"futureTree":2}}"#,
        )
        .expect("config");
        let dto: SpaceConfig = serde_json::from_value(serde_json::json!({
            "name": "Renamed",
            "description": "",
            "icon": "folder",
            "tree": { "exclude": ["tmp"] }
        }))
        .expect("settings DTO");

        write_space_config(temp.path(), &dto).expect("save config");

        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config.json")).expect("config"),
        )
        .expect("json");
        assert_eq!(value["name"], "Renamed");
        assert_eq!(value["futureRoot"], 1);
        assert_eq!(value["tree"]["futureTree"], 2);
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

        svode_core::git::policy::write_user_policy(
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

        for owner in ["git", "agent", "routines"] {
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
                        "agent" => {
                            local.agent = Some(serde_json::json!({ "cliPaths": {} }));
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
        assert_eq!(local.agent, Some(serde_json::json!({ "cliPaths": {} })));
        assert_eq!(
            local.routines.unwrap().automatic_authority.get("owner"),
            Some(&true)
        );
    }
}
