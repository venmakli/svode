use std::path::Path;

use crate::error::AppError;

use super::types::{LocalConfig, SpaceConfig};

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
    let _guard = svode_core::variables::files::lock(&dir).map_err(variables_error)?;
    let mut shared_config = config.clone();
    // Personal Git automation policy is local-only. Older versions stored it in
    // shared config; every shared config write now drops those legacy fields.
    shared_config.git = None;
    svode_core::variables::files::write_preserving_variables(
        &dir.join("config.json"),
        &serde_json::to_value(&shared_config)?,
    )
    .map_err(variables_error)
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

fn variables_error(error: svode_core::variables::Error) -> AppError {
    AppError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::types::{GitSpaceConfig, GitUserPolicy};
    use std::sync::Arc;
    use svode_core::routines::local::RoutinesLocalConfig;
    use svode_core::storage::config::BINARY_ROUTING_VERSION;

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
    fn agent_section_survives_config_round_trip() {
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join(".svode");
        std::fs::create_dir_all(&dir).expect("svode dir");
        let agent = serde_json::json!({
            "clis": ["claude"],
            "defaultModel": "sonnet",
            "systemPrompt": "Be brief.",
            "maxTurns": 12,
            "maxTimeout": 300
        });
        std::fs::write(
            dir.join("config.json"),
            serde_json::json!({ "name": "Legacy", "agent": agent }).to_string(),
        )
        .expect("legacy config");

        let config = read_space_config(temp.path()).expect("read config");
        write_space_config(temp.path(), &config).expect("write config");
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config.json")).expect("config"),
        )
        .expect("json");
        assert_eq!(value["agent"], agent);
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

    #[test]
    fn sibling_writers_preserve_latest_variables_and_reject_pending_transition() {
        let temp = tempfile::tempdir().unwrap();
        write_space_config(temp.path(), &config_with_git()).unwrap();
        let stale = read_space_config(temp.path()).unwrap();
        let context =
            svode_core::variables::Context::new(temp.path(), None, &temp.path().join("library"))
                .unwrap();
        let owner = svode_core::variables::Owner::in_context(
            &context,
            &svode_core::variables::SourceOwner::Project,
        )
        .unwrap();
        struct NoSecrets;
        impl svode_core::variables::SecretStore for NoSecrets {
            fn get(&self, _: &str) -> svode_core::variables::Result<Option<String>> {
                panic!("ordinary fixture")
            }
            fn set(&self, _: &str, _: &str) -> svode_core::variables::Result<()> {
                panic!("ordinary fixture")
            }
            fn remove(&self, _: &str) -> svode_core::variables::Result<()> {
                panic!("ordinary fixture")
            }
        }
        let service = svode_core::variables::Service::new(&NoSecrets);
        for (name, mode) in [
            ("PORTABLE", svode_core::variables::Mode::Git),
            ("LOCAL", svode_core::variables::Mode::Local),
        ] {
            service
                .save(
                    &owner,
                    svode_core::variables::Save {
                        name: name.into(),
                        mode,
                        kind: svode_core::variables::Kind::Variable,
                        value: Some(name.into()),
                        revision: service.catalog(&owner).unwrap().revision,
                        operation: svode_core::variables::SaveOperation::Create,
                        keep: None,
                    },
                )
                .unwrap();
        }
        let before = service.catalog(&owner).unwrap();
        write_space_config(temp.path(), &stale).unwrap();
        svode_core::git::policy::write_user_policy(temp.path(), &GitUserPolicy::default()).unwrap();
        super::super::scaffold::scaffold_space(temp.path(), "Renamed", "", "").unwrap();
        let after = service.catalog(&owner).unwrap();
        assert_eq!(
            serde_json::to_value(before.entries).unwrap(),
            serde_json::to_value(after.entries).unwrap()
        );
        std::fs::write(temp.path().join(".svode/variables.pending.json"), "{}").unwrap();
        assert!(write_space_config(temp.path(), &stale).is_err());
        assert!(
            svode_core::git::policy::write_user_policy(temp.path(), &GitUserPolicy::default())
                .is_err()
        );
    }
}
