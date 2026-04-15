use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub user: UserSettings,
    pub appearance: AppearanceSettings,
    pub window: WindowSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<AppAgentSettings>,
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
pub struct UserSettings {
    pub name: String,
    pub avatar: String,
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
            user: UserSettings {
                name: String::new(),
                avatar: "#3B82F6".to_string(),
            },
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
}

impl Default for SpaceRegistry {
    fn default() -> Self {
        Self {
            spaces: Vec::new(),
            last_active: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub last_opened: Option<String>,
    pub path: String,
}

// --- Space Config (.combai/config.json) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spaces: Option<Vec<SpaceRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<SpaceDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitSpaceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<AssetsSpaceConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AssetsStrategy {
    #[default]
    Local,
    InGit,
    LfsRemote,
    LfsS3,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsSpaceConfig {
    #[serde(default)]
    pub strategy: AssetsStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<AssetsS3Config>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsS3Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    // NOTE: access/secret keys intentionally NOT stored here — they belong in
    // OS keychain (deferred to Phase 4.3).
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSpaceConfig {
    /// Whether ⌘S/⌘⇧S should auto-sync after committing. Default: true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_sync: Option<bool>,
}

fn default_icon() -> String {
    "\u{1F4C1}".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceRef {
    pub id: String,
    pub path: String,
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clis: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_timeout: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,
}

// --- Local Config (.combai/local.json) ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    #[serde(default)]
    pub agent: Option<serde_json::Value>,
    #[serde(default)]
    pub expanded_paths: Vec<String>,
}

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
    pub last_opened: Option<String>,
}
