use serde::{Deserialize, Serialize};

use crate::storage::lfs::LfsState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
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

// --- Space Config (.svode/config.json) ---

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeSpaceConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeSpaceConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default)]
    pub show_ignored_placeholders: bool,
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
    #[serde(default)]
    pub prefix: String,
    // NOTE: access/secret keys intentionally NOT stored here — they belong in
    // OS keychain (deferred to Phase 4.3).
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSpaceConfig {
    /// Legacy per-user policy fields. Kept for backward-compatible parsing of
    /// older shared `.svode/config.json` files, but ignored as effective policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_sync: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_commit_structural: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_commit_system: Option<bool>,
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

// --- Local Config (.svode/local.json) ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    #[serde(default)]
    pub agent: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitUserPolicy>,
    #[serde(default)]
    pub expanded_paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitUserPolicy {
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub auto_commit_structural: bool,
    #[serde(default)]
    pub auto_commit_system: bool,
}

// --- Git type & status ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpaceGitType {
    Inline,
    Independent,
    Submodule,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpaceStatus {
    Ready,
    Missing,
    Broken,
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
    pub status: SpaceStatus,
    #[serde(default)]
    pub lfs_state: LfsState,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_config_accepts_optional_tree_config_shape() {
        let config: SpaceConfig = serde_json::from_str(
            r#"{
                "name": "Docs",
                "tree": {
                    "exclude": ["node_modules", "src/generated"],
                    "include": ["docs/**/*.md"],
                    "showIgnoredPlaceholders": true
                }
            }"#,
        )
        .expect("deserialize config");

        let tree = config.tree.expect("tree config");
        assert_eq!(tree.exclude, vec!["node_modules", "src/generated"]);
        assert_eq!(tree.include, vec!["docs/**/*.md"]);
        assert!(tree.show_ignored_placeholders);
    }

    #[test]
    fn space_config_deserializes_without_tree_config() {
        let config: SpaceConfig =
            serde_json::from_str(r#"{"name":"Docs"}"#).expect("deserialize config");

        assert!(config.tree.is_none());
    }

    #[test]
    fn git_config_accepts_legacy_personal_policy_fields() {
        let config: SpaceConfig = serde_json::from_str(
            r#"{
                "name": "Docs",
                "git": {
                    "autoSync": true,
                    "autoCommitStructural": true,
                    "autoCommitSystem": false
                }
            }"#,
        )
        .expect("deserialize config");

        let git = config.git.expect("git config");
        assert_eq!(git.auto_sync, Some(true));
        assert_eq!(git.auto_commit_structural, Some(true));
        assert_eq!(git.auto_commit_system, Some(false));
    }

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
}
