use std::collections::BTreeMap;
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableEvidence {
    pub executable: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub diagnostic: Option<String>,
}

impl ExecutableEvidence {
    pub(crate) fn missing(executable: &str, diagnostic: String) -> Self {
        Self {
            executable: executable.to_string(),
            path: None,
            version: None,
            diagnostic: Some(diagnostic),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAvailability {
    Available,
    Unavailable,
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
    CompatibilityPersonal,
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
    pub availability: CapabilityAvailability,
    pub policy: SkillDiscoveryPolicy,
    pub project_relative_root: String,
    pub personal_roots: Vec<AgentSkillRoot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiscoveryCapability {
    pub availability: CapabilityAvailability,
    pub policy: InstructionDiscoveryPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableCapability {
    pub availability: CapabilityAvailability,
    pub reason: String,
}

impl UnavailableCapability {
    fn phase_5_1() -> Self {
        Self {
            availability: CapabilityAvailability::Unavailable,
            reason: "not available in Agent Context phase 5.1".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub instructions: InstructionDiscoveryCapability,
    pub skills: SkillDiscoveryCapability,
    pub model_selection: UnavailableCapability,
    pub permission_modes: UnavailableCapability,
    pub launch: UnavailableCapability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDefaultTarget {
    pub cwd: String,
    pub projected_context: bool,
    pub additional_roots: bool,
    pub hidden_launcher_config: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAdapterSnapshot {
    pub id: AgentAdapterKind,
    pub display_name: String,
    pub executable: ExecutableEvidence,
    pub personal_root: String,
    pub native_default: NativeDefaultTarget,
    pub capabilities: AdapterCapabilities,
}

#[derive(Debug, Clone)]
pub struct RegistryEnvironment {
    pub codex_home: PathBuf,
    pub codex_standard_skills_dir: PathBuf,
    pub claude_config_dir: PathBuf,
    executables: BTreeMap<AgentAdapterKind, ExecutableEvidence>,
}

impl RegistryEnvironment {
    #[cfg(test)]
    pub fn for_tests(home_dir: PathBuf) -> Self {
        let executables = BTreeMap::from([
            (
                AgentAdapterKind::Codex,
                test_executable("codex", "codex 1.0.0"),
            ),
            (
                AgentAdapterKind::ClaudeCode,
                test_executable("claude", "2.1.179"),
            ),
        ]);
        Self {
            codex_home: home_dir.join(".codex"),
            codex_standard_skills_dir: home_dir.join(".agents/skills"),
            claude_config_dir: home_dir.join(".claude"),
            executables,
        }
    }

    pub fn executable(&self, id: AgentAdapterKind) -> ExecutableEvidence {
        self.executables.get(&id).cloned().unwrap_or_else(|| {
            ExecutableEvidence::missing(
                id.executable(),
                format!("{} executable evidence is unavailable", id.executable()),
            )
        })
    }
}

#[cfg(test)]
fn test_executable(executable: &str, version: &str) -> ExecutableEvidence {
    ExecutableEvidence {
        executable: executable.to_string(),
        path: Some(format!("/test/bin/{executable}")),
        version: Some(version.to_string()),
        diagnostic: None,
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AgentAdapterRegistry;

impl AgentAdapterRegistry {
    pub fn snapshots(&self, environment: &RegistryEnvironment) -> Vec<AgentAdapterSnapshot> {
        [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode]
            .into_iter()
            .map(|id| self.snapshot(id, environment))
            .collect()
    }

    fn snapshot(
        &self,
        id: AgentAdapterKind,
        environment: &RegistryEnvironment,
    ) -> AgentAdapterSnapshot {
        let (display_name, policy, personal_root, skill_policy, project_skills, skill_roots) =
            match id {
                AgentAdapterKind::Codex => (
                    "Codex",
                    InstructionDiscoveryPolicy::CodexAgents,
                    &environment.codex_home,
                    SkillDiscoveryPolicy::CodexDirectoryChain,
                    ".agents/skills",
                    vec![
                        AgentSkillRoot {
                            kind: SkillRootKind::StandardPersonal,
                            path: path_string(&environment.codex_standard_skills_dir),
                        },
                        AgentSkillRoot {
                            kind: SkillRootKind::CompatibilityPersonal,
                            path: path_string(&environment.codex_home.join("skills")),
                        },
                    ],
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
        AgentAdapterSnapshot {
            id,
            display_name: display_name.to_string(),
            executable: environment.executable(id),
            personal_root: path_string(personal_root),
            native_default: NativeDefaultTarget {
                cwd: "target_space_root".to_string(),
                projected_context: false,
                additional_roots: false,
                hidden_launcher_config: false,
            },
            capabilities: AdapterCapabilities {
                instructions: InstructionDiscoveryCapability {
                    availability: CapabilityAvailability::Available,
                    policy,
                },
                skills: SkillDiscoveryCapability {
                    availability: CapabilityAvailability::Available,
                    policy: skill_policy,
                    project_relative_root: project_skills.to_string(),
                    personal_roots: skill_roots,
                },
                model_selection: UnavailableCapability::phase_5_1(),
                permission_modes: UnavailableCapability::phase_5_1(),
                launch: UnavailableCapability::phase_5_1(),
            },
        }
    }
}

pub async fn system_registry_environment() -> Result<RegistryEnvironment, AppError> {
    let home_dir = system_home_dir()
        .ok_or_else(|| AppError::PathNotAccessible("home directory is unavailable".to_string()))?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".codex"));
    let claude_config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.join(".claude"));
    let mut executables = BTreeMap::new();
    for id in [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode] {
        executables.insert(id, detect_executable(id, None, &home_dir).await);
    }
    Ok(RegistryEnvironment {
        codex_home,
        codex_standard_skills_dir: home_dir.join(".agents/skills"),
        claude_config_dir,
        executables,
    })
}

pub(crate) fn system_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

async fn detect_executable(
    id: AgentAdapterKind,
    local_override: Option<&Path>,
    home_dir: &Path,
) -> ExecutableEvidence {
    let executable = id.executable();
    let path = match resolve_executable_path(id, local_override, home_dir) {
        Some(path) => path,
        None => {
            return ExecutableEvidence::missing(
                executable,
                format!("{executable} executable was not found"),
            );
        }
    };
    let runner = runtime::SystemRuntimeCommandRunner;
    let request = runtime::RuntimeCommandRequest {
        program: path.clone(),
        arguments: vec!["--version".into()],
        cwd: home_dir.to_path_buf(),
    };
    match runtime::RuntimeCommandRunner::run(&runner, &request).await {
        Ok(output) if output.exit_code == Some(0) => {
            let version = output.stdout;
            ExecutableEvidence {
                executable: executable.to_string(),
                path: Some(path_string(&path)),
                version: (!version.is_empty()).then_some(version),
                diagnostic: None,
            }
        }
        Ok(output) => ExecutableEvidence {
            executable: executable.to_string(),
            path: Some(path_string(&path)),
            version: None,
            diagnostic: Some(format!(
                "{executable} --version exited with {:?}: {}",
                output.exit_code, output.stderr
            )),
        },
        Err(error) => ExecutableEvidence {
            executable: executable.to_string(),
            path: Some(path_string(&path)),
            version: None,
            diagnostic: Some(error),
        },
    }
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
        let environment = RegistryEnvironment::for_tests(PathBuf::from("/home/test"));
        let snapshots = AgentAdapterRegistry.snapshots(&environment);

        assert_eq!(snapshots[0].id.as_str(), "codex");
        assert_eq!(snapshots[1].id.as_str(), "claude-code");
        assert_eq!(
            snapshots[0].capabilities.skills.project_relative_root,
            ".agents/skills"
        );
        assert_eq!(snapshots[0].capabilities.skills.personal_roots.len(), 2);
        assert_eq!(
            snapshots[1].capabilities.skills.policy,
            SkillDiscoveryPolicy::ClaudePersonalShadowsProject
        );
        assert_eq!(
            serde_json::to_value(snapshots[1].id).unwrap(),
            serde_json::json!("claude-code")
        );
        for snapshot in snapshots {
            assert_eq!(
                snapshot.capabilities.instructions.availability,
                CapabilityAvailability::Available
            );
            assert_eq!(
                snapshot.capabilities.skills.availability,
                CapabilityAvailability::Available
            );
            assert!(!snapshot.capabilities.skills.personal_roots.is_empty());
            assert_eq!(
                snapshot.capabilities.launch.availability,
                CapabilityAvailability::Unavailable
            );
            assert_eq!(
                snapshot.capabilities.model_selection.availability,
                CapabilityAvailability::Unavailable
            );
            assert_eq!(
                snapshot.capabilities.permission_modes.availability,
                CapabilityAvailability::Unavailable
            );
            assert!(!snapshot.native_default.projected_context);
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
