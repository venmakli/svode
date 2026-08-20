use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::AppError;

#[allow(dead_code)]
pub mod runtime;

pub const CODEX_ADAPTER_ID: &str = "codex";
pub const CLAUDE_CODE_ADAPTER_ID: &str = "claude-code";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAdapterKind {
    Codex,
    ClaudeCode,
}

impl AgentAdapterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => CODEX_ADAPTER_ID,
            Self::ClaudeCode => CLAUDE_CODE_ADAPTER_ID,
        }
    }

    pub(crate) fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }
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
}

impl SourceRegistryEnvironment {
    #[cfg(test)]
    pub fn for_tests(home_dir: PathBuf) -> Self {
        Self {
            codex_home: home_dir.join(".codex"),
            codex_standard_skills_dir: home_dir.join(".agents/skills"),
            claude_config_dir: home_dir.join(".claude"),
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AgentAdapterRegistry;

impl AgentAdapterRegistry {
    pub fn source_policies(
        &self,
        environment: &SourceRegistryEnvironment,
    ) -> Vec<AgentSourcePolicy> {
        [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode]
            .into_iter()
            .map(|id| self.source_policy(id, environment))
            .collect()
    }

    fn source_policy(
        &self,
        id: AgentAdapterKind,
        environment: &SourceRegistryEnvironment,
    ) -> AgentSourcePolicy {
        let (display_name, policy, personal_root, skill_policy, project_skills, skill_roots) =
            match id {
                AgentAdapterKind::Codex => (
                    "Codex",
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
                    "Claude Code",
                    InstructionDiscoveryPolicy::ClaudeMemory,
                    &environment.claude_config_dir,
                    SkillDiscoveryPolicy::ClaudePersonalShadowsProject,
                    ".claude/skills",
                    vec![AgentSkillRoot {
                        kind: SkillRootKind::StandardPersonal,
                        path: path_string(&environment.claude_config_dir.join("skills")),
                    }],
                ),
            };
        AgentSourcePolicy {
            id,
            display_name: display_name.to_string(),
            personal_root: path_string(personal_root),
            capabilities: AdapterSourceCapabilities {
                instructions: InstructionDiscoveryCapability { policy },
                skills: SkillDiscoveryCapability {
                    policy: skill_policy,
                    project_relative_root: project_skills.to_string(),
                    personal_roots: skill_roots,
                },
            },
        }
    }
}

pub fn system_source_registry_environment() -> Result<SourceRegistryEnvironment, AppError> {
    let home_dir = system_home_dir()
        .ok_or_else(|| AppError::PathNotAccessible("home directory is unavailable".to_string()))?;
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
    })
}

pub(crate) fn system_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(crate) fn resolve_executable_path(
    id: AgentAdapterKind,
    local_override: Option<&Path>,
    home_dir: &Path,
) -> Option<PathBuf> {
    resolve_executable_path_with(id, local_override, home_dir, |name| which::which(name).ok())
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
}
