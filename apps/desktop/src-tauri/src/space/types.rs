use serde::{Deserialize, Serialize};

use svode_core::storage::lfs::LfsState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub appearance: AppearanceSettings,
    pub window: WindowSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<AppAgentSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub theme: String,
    pub language: String,
    pub theme_needs_recovery: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAgentSettings {
    #[serde(default)]
    pub detected: Vec<DetectedCli>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCli {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auth_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceSettings {
    pub theme: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSettings {
    pub width: u32,
    pub height: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: AppearanceSettings {
                theme: "system".to_string(),
                language: "en".to_string(),
            },
            window: WindowSettings {
                width: 1200,
                height: 800,
            },
            agents: None,
        }
    }
}

// --- Space Registry (spaces.json) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRegistry {
    pub spaces: Vec<RegistryEntry>,
    pub last_active: Option<String>,
    /// The view of the window the user was in last; the launch opens it.
    /// Earlier Svode versions ignore it and launch into `last_active`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_view: Option<LastView>,
}

impl Default for SpaceRegistry {
    fn default() -> Self {
        Self {
            spaces: Vec::new(),
            last_active: None,
            last_view: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LastView {
    Home,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
    /// A view written by a later Svode version; the launch treats it as an
    /// absent view.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub last_opened: Option<String>,
    pub path: String,
}

// --- Space Config (.svode/config.json) ---

// The portable config model and its write rule are owned by `svode-core`.
pub use svode_core::space_config::{AgentConfig, SpaceConfig, SpaceDefaults, SpaceRef, Unreadable};

// Assets configuration is owned by the storage policy in `svode-core`; the
// Space config only embeds it.
pub use svode_core::storage::config::{
    AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig,
};

// --- Local Config (.svode/local.json) ---

pub use svode_core::routines::local::{GitUserPolicy, LocalConfig};

// --- Git type & status ---

pub use svode_core::storage::config::SpaceGitType;

pub use svode_core::index::resolver::SpaceStatus;

// --- Frontend view type ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub path: String,
    pub has_spaces: bool,
    #[serde(default)]
    pub has_schema: bool,
    #[serde(default)]
    pub has_app: bool,
    pub last_opened: Option<String>,
    pub status: SpaceStatus,
    #[serde(default)]
    pub lfs_state: LfsState,
    /// Why the project or space config exists but cannot be read; it is then
    /// shown under its folder name, without its spaces and settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_unreadable: Option<Unreadable>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_config_accepts_git_user_policy() {
        let config: LocalConfig = serde_json::from_str(
            r#"{
                "git": {
                    "autoSync": true,
                    "autoCommitStructural": true,
                    "autoCommitSystem": false
                }
            }"#,
        )
        .expect("deserialize local config");

        assert_eq!(
            config.git,
            Some(GitUserPolicy {
                auto_sync: true,
                auto_commit_structural: true,
                auto_commit_system: false,
            })
        );
    }

    #[test]
    fn space_info_serializes_has_schema_in_camel_case() {
        let info = SpaceInfo {
            id: "space-id".to_string(),
            name: "Space".to_string(),
            icon: String::new(),
            description: String::new(),
            path: "/tmp/space".to_string(),
            has_spaces: false,
            has_schema: true,
            has_app: true,
            last_opened: None,
            status: SpaceStatus::Ready,
            lfs_state: LfsState::NotApplicable,
            config_unreadable: Some(Unreadable::Field {
                field: "name".to_string(),
            }),
        };

        let json = serde_json::to_value(info).expect("serialize SpaceInfo");

        assert_eq!(json.get("hasSchema"), Some(&serde_json::Value::Bool(true)));
        assert!(json.get("has_schema").is_none());
        assert_eq!(json.get("hasApp"), Some(&serde_json::Value::Bool(true)));
        assert!(json.get("has_app").is_none());
        assert_eq!(
            json.get("configUnreadable"),
            Some(&serde_json::json!({ "kind": "field", "field": "name" }))
        );
    }
}
