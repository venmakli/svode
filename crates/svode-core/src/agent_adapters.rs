use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum SourceRegistryError {
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
}

/// Prefix of the device-local namespace of custom ACP agents. No built-in
/// id starts with it, so a custom agent never shares a built-in agent's
/// sessions, Actor bindings or settings.
pub const CUSTOM_AGENT_ID_PREFIX: &str = "custom-";
const MAX_AGENT_ID_LEN: usize = 64;

/// A built-in agent of this Svode release (Stage 10 `03` A2): the closed
/// portable set whose ids alone may appear in portable data. Matches over it
/// belong to the agent descriptions; every other consumer derives its list
/// of agents from the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAdapterKind {
    Codex,
    ClaudeCode,
    Cursor,
    Opencode,
    Hermes,
    Pi,
    QwenCode,
    KimiCode,
    GrokBuild,
}

impl AgentAdapterKind {
    /// Every built-in agent of the registry, in its stable order.
    pub const ALL: [Self; 9] = [
        Self::Codex,
        Self::ClaudeCode,
        Self::Cursor,
        Self::Opencode,
        Self::Hermes,
        Self::Pi,
        Self::QwenCode,
        Self::KimiCode,
        Self::GrokBuild,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
            Self::Hermes => "hermes",
            Self::Pi => "pi",
            Self::QwenCode => "qwen-code",
            Self::KimiCode => "kimi-code",
            Self::GrokBuild => "grok-build",
        }
    }

    /// The built-in agent with this id, if this release knows it.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|agent| agent.as_str() == id)
    }

    pub fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
            Self::Cursor => "cursor-agent",
            Self::Opencode => "opencode",
            Self::Hermes => "hermes",
            Self::Pi => "pi",
            Self::QwenCode => "qwen",
            Self::KimiCode => "kimi",
            Self::GrokBuild => "grok",
        }
    }

    /// The agent name the user sees wherever the agent is labelled.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
            Self::Opencode => "opencode",
            Self::Hermes => "Hermes",
            Self::Pi => "pi",
            Self::QwenCode => "Qwen Code",
            Self::KimiCode => "Kimi Code",
            Self::GrokBuild => "Grok Build",
        }
    }

    /// Where the vendor explains how to install the agent's CLI; Svode
    /// never installs it.
    pub fn install_hint(self) -> &'static str {
        match self {
            Self::Codex => "https://github.com/openai/codex",
            Self::ClaudeCode => "https://docs.anthropic.com/claude-code",
            Self::Cursor => "https://cursor.com/cli",
            Self::Opencode => "https://opencode.ai",
            Self::Hermes => "https://hermes-agent.nousresearch.com",
            Self::Pi => "https://pi.dev",
            Self::QwenCode => "https://github.com/QwenLM/qwen-code",
            Self::KimiCode => "https://github.com/MoonshotAI/kimi-code",
            Self::GrokBuild => "https://github.com/xai-org/grok-build",
        }
    }

    pub fn id(self) -> AgentId {
        AgentId(self.as_str().to_string())
    }
}

impl std::fmt::Display for AgentAdapterKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid agent id: {0:?}")]
pub struct InvalidAgentId(pub String);

/// The one stable id of an agent in every plan: a built-in id, a custom id
/// of this device, or the id of an agent a newer Svode knows. Lowercase ASCII
/// letters, digits and `-`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentId(String);

impl AgentId {
    pub fn parse(id: &str) -> Result<Self, InvalidAgentId> {
        let valid = !id.is_empty()
            && id.len() <= MAX_AGENT_ID_LEN
            && id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !id.starts_with('-')
            && !id.ends_with('-');
        if valid {
            Ok(Self(id.to_string()))
        } else {
            Err(InvalidAgentId(id.to_string()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The built-in agent of this release with this id.
    pub fn builtin(&self) -> Option<AgentAdapterKind> {
        AgentAdapterKind::from_id(&self.0)
    }

    pub fn is_custom(&self) -> bool {
        self.0.starts_with(CUSTOM_AGENT_ID_PREFIX)
    }
}

impl TryFrom<String> for AgentId {
    type Error = InvalidAgentId;

    fn try_from(id: String) -> Result<Self, Self::Error> {
        Self::parse(&id)
    }
}

impl From<AgentId> for String {
    fn from(id: AgentId) -> Self {
        id.0
    }
}

impl From<AgentAdapterKind> for AgentId {
    fn from(agent: AgentAdapterKind) -> Self {
        agent.id()
    }
}

impl PartialEq<AgentAdapterKind> for AgentId {
    fn eq(&self, agent: &AgentAdapterKind) -> bool {
        self.0 == agent.as_str()
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The device-local id of a custom ACP agent, in its own namespace. It is
/// never written to portable data.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CustomAgentId(AgentId);

impl CustomAgentId {
    pub fn parse(id: &str) -> Result<Self, InvalidAgentId> {
        let id = AgentId::parse(id)?;
        if id.is_custom() && id.as_str().len() > CUSTOM_AGENT_ID_PREFIX.len() {
            Ok(Self(id))
        } else {
            Err(InvalidAgentId(id.0))
        }
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.0
    }
}

impl TryFrom<String> for CustomAgentId {
    type Error = InvalidAgentId;

    fn try_from(id: String) -> Result<Self, Self::Error> {
        Self::parse(&id)
    }
}

impl From<CustomAgentId> for String {
    fn from(id: CustomAgentId) -> Self {
        id.0.0
    }
}

impl From<CustomAgentId> for AgentId {
    fn from(id: CustomAgentId) -> Self {
        id.0
    }
}

/// Identity of a built-in agent as every host labels it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAdapterIdentity {
    pub id: AgentAdapterKind,
    pub display_name: String,
    pub executable: String,
    pub install_hint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDiscoveryPolicy {
    CodexAgents,
    ClaudeMemory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillDiscoveryPolicy {
    CodexDirectoryChain,
    ClaudePersonalShadowsProject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillRootKind {
    StandardPersonal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillRoot {
    pub kind: SkillRootKind,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscoveryCapability {
    pub policy: SkillDiscoveryPolicy,
    pub project_relative_root: String,
    pub personal_roots: Vec<AgentSkillRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiscoveryCapability {
    pub policy: InstructionDiscoveryPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterSourceCapabilities {
    pub instructions: InstructionDiscoveryCapability,
    pub skills: SkillDiscoveryCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourcePolicy {
    pub id: AgentAdapterKind,
    pub display_name: String,
    pub personal_root: String,
    pub capabilities: AdapterSourceCapabilities,
}

#[derive(Debug, Clone)]
pub struct SourceRegistryEnvironment {
    pub codex_home: PathBuf,
    pub codex_standard_skills_dir: PathBuf,
    pub claude_config_dir: PathBuf,
    /// Stable Svode install root. Client skill links point into its payload,
    /// so discovery reads it like a personal root.
    pub svode_home: PathBuf,
}

impl SourceRegistryEnvironment {
    pub fn for_tests(home_dir: PathBuf) -> Self {
        Self {
            codex_home: home_dir.join(".codex"),
            codex_standard_skills_dir: home_dir.join(".agents/skills"),
            claude_config_dir: home_dir.join(".claude"),
            svode_home: home_dir.join(".svode"),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AgentAdapterRegistry;

impl AgentAdapterRegistry {
    pub fn identities(&self) -> Vec<AgentAdapterIdentity> {
        AgentAdapterKind::ALL
            .into_iter()
            .map(|id| AgentAdapterIdentity {
                id,
                display_name: id.display_name().to_string(),
                executable: id.executable().to_string(),
                install_hint: id.install_hint().to_string(),
            })
            .collect()
    }

    /// Source policies of the agents that take part in Agent Context. An
    /// agent without one stays out of it until its sources are decided.
    pub fn source_policies(
        &self,
        environment: &SourceRegistryEnvironment,
    ) -> Vec<AgentSourcePolicy> {
        AgentAdapterKind::ALL
            .into_iter()
            .filter_map(|id| self.source_policy(id, environment))
            .collect()
    }

    fn source_policy(
        &self,
        id: AgentAdapterKind,
        environment: &SourceRegistryEnvironment,
    ) -> Option<AgentSourcePolicy> {
        let (policy, personal_root, skill_policy, project_skills, skill_roots) = match id {
            AgentAdapterKind::Codex => (
                InstructionDiscoveryPolicy::CodexAgents,
                &environment.codex_home,
                SkillDiscoveryPolicy::CodexDirectoryChain,
                ".agents/skills",
                vec![AgentSkillRoot {
                    kind: SkillRootKind::StandardPersonal,
                    path: path_string(&environment.codex_standard_skills_dir),
                }],
            ),
            AgentAdapterKind::ClaudeCode => (
                InstructionDiscoveryPolicy::ClaudeMemory,
                &environment.claude_config_dir,
                SkillDiscoveryPolicy::ClaudePersonalShadowsProject,
                ".claude/skills",
                vec![AgentSkillRoot {
                    kind: SkillRootKind::StandardPersonal,
                    path: path_string(&environment.claude_config_dir.join("skills")),
                }],
            ),
            AgentAdapterKind::Cursor
            | AgentAdapterKind::Opencode
            | AgentAdapterKind::Hermes
            | AgentAdapterKind::Pi
            | AgentAdapterKind::QwenCode
            | AgentAdapterKind::KimiCode
            | AgentAdapterKind::GrokBuild => return None,
        };
        Some(AgentSourcePolicy {
            id,
            display_name: id.display_name().to_string(),
            personal_root: path_string(personal_root),
            capabilities: AdapterSourceCapabilities {
                instructions: InstructionDiscoveryCapability { policy },
                skills: SkillDiscoveryCapability {
                    policy: skill_policy,
                    project_relative_root: project_skills.to_string(),
                    personal_roots: skill_roots,
                },
            },
        })
    }
}

pub fn system_source_registry_environment() -> Result<SourceRegistryEnvironment, SourceRegistryError>
{
    let home_dir = system_home_dir().ok_or_else(|| {
        SourceRegistryError::PathNotAccessible("home directory is unavailable".to_string())
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".codex"));
    let claude_config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".claude"));
    Ok(SourceRegistryEnvironment {
        codex_home,
        codex_standard_skills_dir: home_dir.join(".agents/skills"),
        claude_config_dir,
        svode_home: home_dir.join(".svode"),
    })
}

pub fn system_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolves the adapter executable. `search_path` replaces the process PATH
/// when the host knows a better one, e.g. the login shell PATH of a GUI app
/// that launchd started with only the system directories.
pub fn resolve_executable_path(
    id: AgentAdapterKind,
    local_override: Option<&Path>,
    home_dir: &Path,
    search_path: Option<&OsStr>,
) -> Option<PathBuf> {
    resolve_executable_path_with(id, local_override, home_dir, |name| match search_path {
        Some(paths) => which::which_in(name, Some(paths), home_dir).ok(),
        None => which::which(name).ok(),
    })
}

/// Resolves the adapter executable for a Space: its Space-local override
/// first, then [`resolve_executable_path`].
pub fn resolve_space_executable(
    id: AgentAdapterKind,
    space_dir: &Path,
    home_dir: &Path,
    search_path: Option<&OsStr>,
) -> Option<PathBuf> {
    let local_override = space_executable_override(id, space_dir);
    resolve_executable_path(id, local_override.as_deref(), home_dir, search_path)
}

/// The Space-local executable override, `agent.cliPaths` in the Space
/// `local.json`; a relative path resolves against the Space. An unreadable
/// or malformed file has no override.
pub fn space_executable_override(id: AgentAdapterKind, space_dir: &Path) -> Option<PathBuf> {
    let agent = crate::routines::local::read(space_dir).ok()?.agent?;
    let paths = agent.get("cliPaths")?.as_object()?;
    let keys: &[&str] = match id {
        AgentAdapterKind::ClaudeCode => &["claude-code", "claude"],
        _ => &[id.as_str()],
    };
    keys.iter()
        .find_map(|key| paths.get(*key)?.as_str())
        .map(|path| {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                space_dir.join(path)
            }
        })
}

fn resolve_executable_path_with(
    id: AgentAdapterKind,
    local_override: Option<&Path>,
    home_dir: &Path,
    path_lookup: impl FnOnce(&str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = local_override.filter(|path| is_executable_file(path)) {
        return Some(path.to_path_buf());
    }
    if let Some(path) = path_lookup(id.executable()) {
        return Some(path);
    }
    common_executable_locations(id, home_dir)
        .into_iter()
        .find(|path| is_executable_file(path))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn common_executable_locations(id: AgentAdapterKind, home_dir: &Path) -> Vec<PathBuf> {
    let executable = id.executable();
    let mut candidates = match id {
        AgentAdapterKind::Codex => vec![
            home_dir.join(".bun/bin").join(executable),
            home_dir.join(".local/bin").join(executable),
            home_dir.join(".cargo/bin").join(executable),
        ],
        AgentAdapterKind::ClaudeCode => vec![
            home_dir.join(".local/bin").join(executable),
            home_dir.join(".npm/bin").join(executable),
            home_dir.join(".bun/bin").join(executable),
        ],
        // The vendor installer puts it here and adds it to PATH only in
        // the interactive shell profile.
        AgentAdapterKind::Opencode => vec![
            home_dir.join(".opencode/bin").join(executable),
            home_dir.join(".local/bin").join(executable),
            home_dir.join(".bun/bin").join(executable),
        ],
        _ => vec![
            home_dir.join(".local/bin").join(executable),
            home_dir.join(".bun/bin").join(executable),
            home_dir.join(".npm-global/bin").join(executable),
        ],
    };
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(executable));
    candidates.push(PathBuf::from("/usr/local/bin").join(executable));
    candidates
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, b"test").unwrap();
        let mut permissions = path.metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn registry_keeps_stable_ids_and_phase_capabilities_explicit() {
        let environment = SourceRegistryEnvironment::for_tests(PathBuf::from("/home/test"));
        let snapshots = AgentAdapterRegistry.source_policies(&environment);

        assert_eq!(snapshots[0].id.as_str(), "codex");
        assert_eq!(snapshots[1].id.as_str(), "claude-code");
        assert_eq!(
            snapshots[0].capabilities.skills.project_relative_root,
            ".agents/skills"
        );
        assert_eq!(snapshots[0].capabilities.skills.personal_roots.len(), 1);
        assert_eq!(
            snapshots[1].capabilities.skills.policy,
            SkillDiscoveryPolicy::ClaudePersonalShadowsProject
        );
        assert_eq!(
            serde_json::to_value(snapshots[1].id).unwrap(),
            serde_json::json!("claude-code")
        );
        for snapshot in snapshots {
            assert!(!snapshot.capabilities.skills.personal_roots.is_empty());
        }
    }

    #[test]
    fn identities_label_every_adapter_like_its_source_policy() {
        let environment = SourceRegistryEnvironment::for_tests(PathBuf::from("/home/test"));
        let identities = AgentAdapterRegistry.identities();
        let policies = AgentAdapterRegistry.source_policies(&environment);

        assert_eq!(
            identities
                .iter()
                .map(|identity| identity.id)
                .collect::<Vec<_>>(),
            AgentAdapterKind::ALL
        );
        for policy in &policies {
            let identity = identities.iter().find(|identity| identity.id == policy.id);
            assert_eq!(
                identity.map(|identity| &identity.display_name),
                Some(&policy.display_name)
            );
        }
        assert_eq!(
            serde_json::to_value(&identities[1]).unwrap(),
            serde_json::json!({
                "id": "claude-code",
                "displayName": "Claude Code",
                "executable": "claude",
                "installHint": "https://docs.anthropic.com/claude-code"
            })
        );
    }

    #[test]
    fn a_new_built_in_agent_needs_no_source_policy() {
        let environment = SourceRegistryEnvironment::for_tests(PathBuf::from("/home/test"));
        let policies = AgentAdapterRegistry.source_policies(&environment);

        assert_eq!(
            policies.iter().map(|policy| policy.id).collect::<Vec<_>>(),
            [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode]
        );
        assert!(
            AgentAdapterRegistry
                .identities()
                .iter()
                .any(|identity| identity.id == AgentAdapterKind::QwenCode)
        );
    }

    #[test]
    fn built_in_ids_are_agent_ids_outside_the_custom_namespace() {
        for agent in AgentAdapterKind::ALL {
            let id = AgentId::parse(agent.as_str()).unwrap();
            assert_eq!(id.builtin(), Some(agent));
            assert!(!id.is_custom());
            assert_eq!(id, agent);
            assert_eq!(
                serde_json::to_value(agent).unwrap(),
                serde_json::to_value(&id).unwrap()
            );
        }
    }

    #[test]
    fn agent_ids_keep_unknown_agents_and_reject_malformed_ids() {
        let future: AgentId = serde_json::from_str(r#""future-agent""#).unwrap();
        assert_eq!(future.as_str(), "future-agent");
        assert_eq!(future.builtin(), None);
        // Built-in agents dropped from the list (slice 3.3).
        for dropped in ["gemini-cli", "openclaw"] {
            assert_eq!(AgentId::parse(dropped).unwrap().builtin(), None);
        }
        for malformed in ["", "Codex", "claude code", "-codex", "codex-", "a:b"] {
            assert!(AgentId::parse(malformed).is_err(), "{malformed:?}");
        }
        assert!(serde_json::from_str::<AgentId>(r#""Codex""#).is_err());
    }

    #[test]
    fn custom_ids_live_in_their_own_namespace() {
        let custom = CustomAgentId::parse("custom-my-agent").unwrap();
        let id = AgentId::from(custom.clone());
        assert!(id.is_custom());
        assert_eq!(id.builtin(), None);
        assert!(CustomAgentId::parse("codex").is_err());
        assert!(CustomAgentId::parse("custom").is_err());
        assert_eq!(
            serde_json::to_value(&custom).unwrap(),
            serde_json::json!("custom-my-agent")
        );
    }

    #[cfg(unix)]
    #[test]
    fn executable_resolution_prefers_override_then_path_then_common_location() {
        let directory = tempfile::tempdir().unwrap();
        let override_path = directory.path().join("override-codex");
        let path_result = directory.path().join("path-codex");
        let common = directory.path().join(".bun/bin/codex");
        std::fs::create_dir_all(common.parent().unwrap()).unwrap();
        make_executable(&override_path);
        make_executable(&path_result);
        make_executable(&common);

        assert_eq!(
            resolve_executable_path_with(
                AgentAdapterKind::Codex,
                Some(&override_path),
                directory.path(),
                |_| Some(path_result.clone()),
            ),
            Some(override_path)
        );
        assert_eq!(
            resolve_executable_path_with(AgentAdapterKind::Codex, None, directory.path(), |_| {
                Some(path_result.clone())
            },),
            Some(path_result)
        );
        assert_eq!(
            resolve_executable_path_with(AgentAdapterKind::Codex, None, directory.path(), |_| {
                None
            },),
            Some(common)
        );
    }

    #[cfg(unix)]
    #[test]
    fn opencode_is_found_where_its_installer_puts_it() {
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join(".opencode/bin/opencode");
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        make_executable(&installed);
        assert_eq!(
            resolve_executable_path_with(
                AgentAdapterKind::Opencode,
                None,
                directory.path(),
                |_| { None }
            ),
            Some(installed)
        );
    }

    #[test]
    fn space_override_is_owned_by_space_local_config_and_resolves_relative_paths() {
        let space = tempfile::tempdir().unwrap();
        let local = space.path().join(".svode/local.json");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(
            &local,
            serde_json::json!({
                "agent": {
                    "cliPaths": {
                        "codex": "bin/codex",
                        "claude-code": "/opt/custom/claude"
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            space_executable_override(AgentAdapterKind::Codex, space.path()),
            Some(space.path().join("bin/codex"))
        );
        assert_eq!(
            space_executable_override(AgentAdapterKind::ClaudeCode, space.path()),
            Some(PathBuf::from("/opt/custom/claude"))
        );

        std::fs::write(&local, "{ not json").unwrap();
        assert_eq!(
            space_executable_override(AgentAdapterKind::Codex, space.path()),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn executable_resolution_searches_the_host_path_instead_of_the_process_path() {
        let home = tempfile::tempdir().unwrap();
        let login_bin = tempfile::tempdir().unwrap();
        let codex = login_bin.path().join("codex");
        make_executable(&codex);

        assert_eq!(
            resolve_executable_path(
                AgentAdapterKind::Codex,
                None,
                home.path(),
                Some(login_bin.path().as_os_str()),
            ),
            Some(codex)
        );
    }
}
