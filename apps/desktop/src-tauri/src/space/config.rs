use std::path::Path;

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
pub fn write_local_config(path: &Path, local: &LocalConfig) -> Result<(), AppError> {
    let dir = path.join(".svode");
    std::fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(local)?;
    std::fs::write(dir.join("local.json"), data)?;
    Ok(())
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
    let mut local = read_local_config(path)?;
    local.git = Some(policy.clone());
    write_local_config(path, &local)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::types::GitSpaceConfig;

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
}
