use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_context::model::SkillDiscoveryKind;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDiscoveryPolicy {
    CodexAgents,
    ClaudeMemory,
    /// Declared rules that Agent Context applies the same way for every
    /// agent that has them.
    Declared(DeclaredInstructions),
}

/// A walk over the directories of a target (E02 boundaries), in the order the
/// agent registers them. Directories above the repository boundary lie
/// outside it: Agent Context reads them only for enabled agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryWalk {
    Target,
    RepositoryRoot,
    /// From the repository root down to the target.
    RepositoryToTarget,
    /// From the parent of the repository root down to the target: Qwen Code
    /// stops its walk one directory above the git root.
    RepositoryParentToTarget,
    /// From the target up to the repository root.
    TargetToRepository,
    /// From the filesystem root down to the target.
    FilesystemToTarget,
    /// From `~` down to the target when the target lies in it, else from the
    /// repository root.
    HomeOrRepositoryToTarget,
}

/// Which of the files an instruction group finds the agent reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionSelection {
    /// Every readable file.
    All,
    /// The first readable file; the others are shadowed by it.
    First,
}

/// A setting of the agent that replaces the names of a rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionNamesSetting {
    /// `context.fileName` of the Qwen Code settings.
    QwenContextFileName,
}

/// Where the files of an instruction rule are looked up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDirectories {
    Walk(DirectoryWalk),
    /// One directory of the agent's configuration.
    Personal(String),
}

/// Instruction files the agent reads in each directory of `directories`,
/// as one group per directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionRule {
    pub directories: InstructionDirectories,
    /// Paths relative to each directory, in the agent's order.
    pub names: Vec<String>,
    pub names_setting: Option<InstructionNamesSetting>,
    pub selection: InstructionSelection,
    /// The agent skips a file that is empty after trimming.
    pub skip_empty: bool,
}

/// One file of an instruction slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionSlotFile {
    /// Relative to the single directory of a walk such as `Target`.
    Project {
        walk: DirectoryWalk,
        path: String,
    },
    Personal(String),
}

/// One instruction the agent takes from the first readable of its files,
/// such as a project file that replaces a personal one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionSlot {
    pub files: Vec<InstructionSlotFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredInstructions {
    pub rules: Vec<InstructionRule>,
    pub slots: Vec<InstructionSlot>,
}

/// How an agent chooses between skills that share a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPrecedence {
    /// Skills with the same name coexist.
    Coexist,
    /// A personal skill shadows a project skill of the same name.
    ClaudePersonalShadowsProject,
    /// The first registered skill wins.
    FirstWins(SkillKey),
    /// The last registered skill wins.
    LastWins(SkillKey),
}

/// What makes two skills the same for an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillKey {
    Name,
    NameIgnoringCase,
    /// The skill directory name, or the file name of a flat skill without
    /// `.md`.
    PathId,
}

/// Plain `*.md` files the agent itself takes as skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlatSkills {
    None,
    /// Directly in the skills root.
    Root,
    /// In folders below the skills root.
    Nested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLayout {
    /// How deep skill directories lie: 1 is direct children of the root;
    /// deeper levels are folders of skills.
    pub max_depth: usize,
    pub flat: FlatSkills,
    /// The agent also looks for skills inside a skill directory.
    #[serde(default)]
    pub descend_into_skills: bool,
}

impl SkillLayout {
    pub const DIRECT_CHILDREN: Self = Self {
        max_depth: 1,
        flat: FlatSkills::None,
        descend_into_skills: false,
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPlace {
    /// `relative` in each directory of the walk.
    Walk {
        walk: DirectoryWalk,
        relative: String,
    },
    Personal(String),
}

/// A setting of an agent that turns a group of its sources off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceSwitch {
    /// The built-in plugin `opencode.config.compatibility` of opencode,
    /// which reads the skills of Claude Code and of `.agents`.
    OpencodeCompatibility,
}

/// A skills root of an agent, in the agent's registration order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRootRule {
    pub kind: SkillDiscoveryKind,
    pub place: SkillPlace,
    pub layout: SkillLayout,
    /// The root counts only while this setting is on.
    pub switch: Option<SourceSwitch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscoveryCapability {
    pub precedence: SkillPrecedence,
    pub roots: Vec<SkillRootRule>,
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

/// Where the agents keep their configuration on this device: the home
/// directories of the clients as the environment the agents run in sets
/// them (Stage 10 `03` A1).
#[derive(Debug, Clone)]
pub struct SourceRegistryEnvironment {
    /// Agent Context shows locations in it relative to `~`.
    pub home_dir: PathBuf,
    pub codex_home: PathBuf,
    pub codex_standard_skills_dir: PathBuf,
    pub claude_config_dir: PathBuf,
    /// `OPENCODE_CONFIG_DIR`, else `opencode` in `XDG_CONFIG_HOME` or
    /// `~/.config`.
    pub opencode_config_dir: PathBuf,
    /// `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
    pub pi_agent_dir: PathBuf,
    /// `QWEN_HOME`, else `~/.qwen`.
    pub qwen_home: PathBuf,
    /// `KIMI_CODE_HOME`, else `~/.kimi-code`.
    pub kimi_code_home: PathBuf,
    /// Stable Svode install root. Client skill links point into its payload,
    /// so discovery reads it like a personal root.
    pub svode_home: PathBuf,
}

impl SourceRegistryEnvironment {
    /// The client homes from `variable`, a lookup in the environment the
    /// agents run in. An empty variable is unset; a leading `~` is the home
    /// directory.
    pub fn from_variables(home_dir: PathBuf, variable: impl Fn(&str) -> Option<OsString>) -> Self {
        let set = |name: &str| {
            variable(name)
                .filter(|value| !value.is_empty())
                .map(|value| expand_home(&home_dir, PathBuf::from(value)))
        };
        let config_home = set("XDG_CONFIG_HOME").unwrap_or_else(|| home_dir.join(".config"));
        Self {
            codex_home: set("CODEX_HOME").unwrap_or_else(|| home_dir.join(".codex")),
            codex_standard_skills_dir: home_dir.join(".agents/skills"),
            claude_config_dir: set("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home_dir.join(".claude")),
            opencode_config_dir: set("OPENCODE_CONFIG_DIR")
                .unwrap_or_else(|| config_home.join("opencode")),
            pi_agent_dir: set("PI_CODING_AGENT_DIR").unwrap_or_else(|| home_dir.join(".pi/agent")),
            qwen_home: set("QWEN_HOME").unwrap_or_else(|| home_dir.join(".qwen")),
            kimi_code_home: set("KIMI_CODE_HOME").unwrap_or_else(|| home_dir.join(".kimi-code")),
            svode_home: home_dir.join(".svode"),
            home_dir,
        }
    }

    pub fn for_tests(home_dir: PathBuf) -> Self {
        Self::from_variables(home_dir, |_| None)
    }
}

fn expand_home(home_dir: &Path, path: PathBuf) -> PathBuf {
    match path.strip_prefix("~") {
        Ok(rest) => home_dir.join(rest),
        Err(_) => path,
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
        let home = &environment.home_dir;
        let (personal_root, instructions, skills) = match id {
            // Codex 0.159: `.agents/skills` and `.codex/skills` from the
            // project root, `~/.agents/skills` and `$CODEX_HOME/skills`, each
            // walked six folders deep, into skill directories too; skills of
            // one name coexist. Its bundled
            // `$CODEX_HOME/skills/.system` stays out, like other built-ins.
            AgentAdapterKind::Codex => {
                let layout = SkillLayout {
                    max_depth: CODEX_SKILL_DEPTH,
                    flat: FlatSkills::None,
                    descend_into_skills: true,
                };
                let walk = |kind, relative: &str| SkillRootRule {
                    kind,
                    place: SkillPlace::Walk {
                        walk: DirectoryWalk::RepositoryToTarget,
                        relative: relative.to_string(),
                    },
                    layout,
                    switch: None,
                };
                let personal = |kind, path: &Path| SkillRootRule {
                    kind,
                    place: SkillPlace::Personal(path_string(path)),
                    layout,
                    switch: None,
                };
                (
                    &environment.codex_home,
                    InstructionDiscoveryPolicy::CodexAgents,
                    SkillDiscoveryCapability {
                        precedence: SkillPrecedence::Coexist,
                        roots: vec![
                            walk(SkillDiscoveryKind::CodexProject, ".agents/skills"),
                            walk(SkillDiscoveryKind::CodexProjectConfig, ".codex/skills"),
                            personal(
                                SkillDiscoveryKind::CodexStandardPersonal,
                                &environment.codex_standard_skills_dir,
                            ),
                            personal(
                                SkillDiscoveryKind::CodexHome,
                                &environment.codex_home.join("skills"),
                            ),
                        ],
                    },
                )
            }
            AgentAdapterKind::ClaudeCode => (
                &environment.claude_config_dir,
                InstructionDiscoveryPolicy::ClaudeMemory,
                SkillDiscoveryCapability {
                    precedence: SkillPrecedence::ClaudePersonalShadowsProject,
                    roots: vec![
                        walk_skills(
                            SkillDiscoveryKind::ClaudeProject,
                            DirectoryWalk::RepositoryToTarget,
                            ".claude/skills",
                        ),
                        personal_skills(
                            SkillDiscoveryKind::ClaudePersonal,
                            &environment.claude_config_dir.join("skills"),
                        ),
                    ],
                },
            ),
            // opencode 2.0.22: only `AGENTS.md`; skills of Claude Code and
            // `.agents` in every ancestor, flat `*.md` too, the last wins.
            AgentAdapterKind::Opencode => {
                let config = &environment.opencode_config_dir;
                let layout = SkillLayout {
                    max_depth: MAX_SKILL_DEPTH,
                    flat: FlatSkills::Root,
                    descend_into_skills: false,
                };
                let mut roots = Vec::new();
                let compatible = |mut root: SkillRootRule| {
                    root.switch = Some(SourceSwitch::OpencodeCompatibility);
                    root
                };
                for (personal, relative) in [
                    (home.join(".claude/skills"), ".claude/skills"),
                    (home.join(".agents/skills"), ".agents/skills"),
                ] {
                    roots.push(compatible(skill_root(
                        SkillPlace::Personal(path_string(&personal)),
                        layout,
                    )));
                    roots.push(compatible(skill_root(
                        SkillPlace::Walk {
                            walk: DirectoryWalk::FilesystemToTarget,
                            relative: relative.to_string(),
                        },
                        layout,
                    )));
                }
                for name in ["skill", "skills"] {
                    roots.push(skill_root(
                        SkillPlace::Personal(path_string(&config.join(name))),
                        layout,
                    ));
                }
                for relative in [".opencode/skill", ".opencode/skills"] {
                    roots.push(skill_root(
                        SkillPlace::Walk {
                            walk: DirectoryWalk::FilesystemToTarget,
                            relative: relative.to_string(),
                        },
                        layout,
                    ));
                }
                (
                    config,
                    InstructionDiscoveryPolicy::Declared(DeclaredInstructions {
                        rules: vec![
                            rule(
                                InstructionDirectories::Personal(path_string(config)),
                                &["AGENTS.md"],
                                InstructionSelection::All,
                            ),
                            rule(
                                InstructionDirectories::Walk(
                                    DirectoryWalk::HomeOrRepositoryToTarget,
                                ),
                                &["AGENTS.md"],
                                InstructionSelection::All,
                            ),
                        ],
                        slots: Vec::new(),
                    }),
                    SkillDiscoveryCapability {
                        precedence: SkillPrecedence::LastWins(SkillKey::PathId),
                        roots,
                    },
                )
            }
            // pi 1.0.0: one context file per directory from the filesystem
            // root; `SYSTEM.md` and `APPEND_SYSTEM.md` of the project replace
            // the personal ones; the first skill of a name wins.
            AgentAdapterKind::Pi => {
                let agent_dir = &environment.pi_agent_dir;
                let names = [
                    "AGENTS.override.md",
                    "AGENTS.md",
                    "AGENTS.MD",
                    "CLAUDE.md",
                    "CLAUDE.MD",
                ];
                let pi_layout = SkillLayout {
                    max_depth: MAX_SKILL_DEPTH,
                    flat: FlatSkills::Root,
                    descend_into_skills: false,
                };
                let agents_layout = SkillLayout {
                    max_depth: MAX_SKILL_DEPTH,
                    flat: FlatSkills::Nested,
                    descend_into_skills: false,
                };
                (
                    agent_dir,
                    InstructionDiscoveryPolicy::Declared(DeclaredInstructions {
                        rules: vec![
                            rule(
                                InstructionDirectories::Personal(path_string(agent_dir)),
                                &names,
                                InstructionSelection::First,
                            ),
                            rule(
                                InstructionDirectories::Walk(DirectoryWalk::FilesystemToTarget),
                                &names,
                                InstructionSelection::First,
                            ),
                        ],
                        slots: ["SYSTEM.md", "APPEND_SYSTEM.md"]
                            .into_iter()
                            .map(|name| InstructionSlot {
                                files: vec![
                                    InstructionSlotFile::Project {
                                        walk: DirectoryWalk::Target,
                                        path: format!(".pi/{name}"),
                                    },
                                    InstructionSlotFile::Personal(path_string(
                                        &agent_dir.join(name),
                                    )),
                                ],
                            })
                            .collect(),
                    }),
                    SkillDiscoveryCapability {
                        precedence: SkillPrecedence::FirstWins(SkillKey::Name),
                        roots: vec![
                            skill_root(
                                SkillPlace::Walk {
                                    walk: DirectoryWalk::Target,
                                    relative: ".pi/skills".to_string(),
                                },
                                pi_layout,
                            ),
                            skill_root(
                                SkillPlace::Walk {
                                    walk: DirectoryWalk::TargetToRepository,
                                    relative: ".agents/skills".to_string(),
                                },
                                agents_layout,
                            ),
                            skill_root(
                                SkillPlace::Personal(path_string(&agent_dir.join("skills"))),
                                pi_layout,
                            ),
                            skill_root(
                                SkillPlace::Personal(path_string(&home.join(".agents/skills"))),
                                agents_layout,
                            ),
                        ],
                    },
                )
            }
            // Qwen Code 0.24.7: `QWEN.md` and `AGENTS.md` (or
            // `context.fileName`) from the parent of the git root,
            // `QWEN.local.md` in the git root,
            // `output-language.md`; skills only in the target, project first.
            AgentAdapterKind::QwenCode => {
                let qwen_home = &environment.qwen_home;
                let names = ["QWEN.md", "AGENTS.md"];
                let mut personal = rule(
                    InstructionDirectories::Personal(path_string(qwen_home)),
                    &names,
                    InstructionSelection::All,
                );
                personal.names_setting = Some(InstructionNamesSetting::QwenContextFileName);
                let mut chain = rule(
                    InstructionDirectories::Walk(DirectoryWalk::RepositoryParentToTarget),
                    &names,
                    InstructionSelection::All,
                );
                chain.names_setting = Some(InstructionNamesSetting::QwenContextFileName);
                (
                    qwen_home,
                    InstructionDiscoveryPolicy::Declared(DeclaredInstructions {
                        rules: vec![
                            personal,
                            chain,
                            rule(
                                InstructionDirectories::Walk(DirectoryWalk::RepositoryRoot),
                                &[".qwen/QWEN.local.md"],
                                InstructionSelection::All,
                            ),
                        ],
                        slots: vec![InstructionSlot {
                            files: vec![
                                InstructionSlotFile::Project {
                                    walk: DirectoryWalk::Target,
                                    path: ".qwen/output-language.md".to_string(),
                                },
                                InstructionSlotFile::Personal(path_string(
                                    &qwen_home.join("output-language.md"),
                                )),
                            ],
                        }],
                    }),
                    SkillDiscoveryCapability {
                        precedence: SkillPrecedence::FirstWins(SkillKey::Name),
                        roots: vec![
                            walk_skills(
                                SkillDiscoveryKind::ProjectRoot,
                                DirectoryWalk::Target,
                                ".qwen/skills",
                            ),
                            walk_skills(
                                SkillDiscoveryKind::ProjectRoot,
                                DirectoryWalk::Target,
                                ".agents/skills",
                            ),
                            personal_skills(
                                SkillDiscoveryKind::PersonalRoot,
                                &qwen_home.join("skills"),
                            ),
                            personal_skills(
                                SkillDiscoveryKind::PersonalRoot,
                                &home.join(".agents/skills"),
                            ),
                        ],
                    },
                )
            }
            // Kimi Code 2.1.1: `AGENTS.md` of its home and `~/.agents`, from
            // the git root `.kimi-code/AGENTS.md` and `AGENTS.md`, `SYSTEM.md`
            // of its home; skills of the git root before personal ones,
            // flat `*.md` too, the first of a name wins.
            AgentAdapterKind::KimiCode => {
                let kimi_home = &environment.kimi_code_home;
                let layout = SkillLayout {
                    max_depth: MAX_SKILL_DEPTH,
                    flat: FlatSkills::Root,
                    descend_into_skills: false,
                };
                let nonempty = |mut rule: InstructionRule| {
                    rule.skip_empty = true;
                    rule
                };
                (
                    kimi_home,
                    InstructionDiscoveryPolicy::Declared(DeclaredInstructions {
                        rules: vec![
                            nonempty(rule(
                                InstructionDirectories::Personal(path_string(kimi_home)),
                                &["AGENTS.md"],
                                InstructionSelection::All,
                            )),
                            nonempty(rule(
                                InstructionDirectories::Personal(path_string(
                                    &home.join(".agents"),
                                )),
                                &["AGENTS.md", "agents.md"],
                                InstructionSelection::First,
                            )),
                            nonempty(rule(
                                InstructionDirectories::Walk(DirectoryWalk::RepositoryToTarget),
                                &[".kimi-code/AGENTS.md"],
                                InstructionSelection::All,
                            )),
                            nonempty(rule(
                                InstructionDirectories::Walk(DirectoryWalk::RepositoryToTarget),
                                &["AGENTS.md", "agents.md"],
                                InstructionSelection::First,
                            )),
                            nonempty(rule(
                                InstructionDirectories::Personal(path_string(kimi_home)),
                                &["SYSTEM.md"],
                                InstructionSelection::All,
                            )),
                        ],
                        slots: Vec::new(),
                    }),
                    SkillDiscoveryCapability {
                        precedence: SkillPrecedence::FirstWins(SkillKey::NameIgnoringCase),
                        roots: vec![
                            skill_root(
                                SkillPlace::Walk {
                                    walk: DirectoryWalk::RepositoryRoot,
                                    relative: ".kimi-code/skills".to_string(),
                                },
                                layout,
                            ),
                            skill_root(
                                SkillPlace::Walk {
                                    walk: DirectoryWalk::RepositoryRoot,
                                    relative: ".agents/skills".to_string(),
                                },
                                layout,
                            ),
                            skill_root(
                                SkillPlace::Personal(path_string(&kimi_home.join("skills"))),
                                layout,
                            ),
                            skill_root(
                                SkillPlace::Personal(path_string(&home.join(".agents/skills"))),
                                layout,
                            ),
                        ],
                    },
                )
            }
            AgentAdapterKind::Cursor | AgentAdapterKind::Hermes | AgentAdapterKind::GrokBuild => {
                return None;
            }
        };
        Some(AgentSourcePolicy {
            id,
            display_name: id.display_name().to_string(),
            personal_root: path_string(personal_root),
            capabilities: AdapterSourceCapabilities {
                instructions: InstructionDiscoveryCapability {
                    policy: instructions,
                },
                skills,
            },
        })
    }
}

/// How deep the agents that walk folders of skills are followed.
const MAX_SKILL_DEPTH: usize = 8;
/// Codex finds a skill directory at most six levels below its root.
const CODEX_SKILL_DEPTH: usize = 6;

fn rule(
    directories: InstructionDirectories,
    names: &[&str],
    selection: InstructionSelection,
) -> InstructionRule {
    InstructionRule {
        directories,
        names: names.iter().map(|name| (*name).to_string()).collect(),
        names_setting: None,
        selection,
        skip_empty: false,
    }
}

/// A root of an agent without a discovery kind of its own.
fn skill_root(place: SkillPlace, layout: SkillLayout) -> SkillRootRule {
    let kind = match place {
        SkillPlace::Walk { .. } => SkillDiscoveryKind::ProjectRoot,
        SkillPlace::Personal(_) => SkillDiscoveryKind::PersonalRoot,
    };
    SkillRootRule {
        kind,
        place,
        layout,
        switch: None,
    }
}

fn walk_skills(kind: SkillDiscoveryKind, walk: DirectoryWalk, relative: &str) -> SkillRootRule {
    SkillRootRule {
        kind,
        place: SkillPlace::Walk {
            walk,
            relative: relative.to_string(),
        },
        layout: SkillLayout::DIRECT_CHILDREN,
        switch: None,
    }
}

fn personal_skills(kind: SkillDiscoveryKind, path: &Path) -> SkillRootRule {
    SkillRootRule {
        kind,
        place: SkillPlace::Personal(path_string(path)),
        layout: SkillLayout::DIRECT_CHILDREN,
        switch: None,
    }
}

pub fn system_source_registry_environment() -> Result<SourceRegistryEnvironment, SourceRegistryError>
{
    source_registry_environment(|name| std::env::var_os(name))
}

/// The client homes of this device from `variable`, a lookup in the
/// environment the agents run in.
pub fn source_registry_environment(
    variable: impl Fn(&str) -> Option<OsString>,
) -> Result<SourceRegistryEnvironment, SourceRegistryError> {
    let home_dir = system_home_dir().ok_or_else(|| {
        SourceRegistryError::PathNotAccessible("home directory is unavailable".to_string())
    })?;
    Ok(SourceRegistryEnvironment::from_variables(
        home_dir, variable,
    ))
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
        // The vendor installers of opencode and Grok Build put them here
        // and add them to PATH only in the interactive shell profile.
        AgentAdapterKind::Opencode => vec![
            home_dir.join(".opencode/bin").join(executable),
            home_dir.join(".local/bin").join(executable),
            home_dir.join(".bun/bin").join(executable),
        ],
        AgentAdapterKind::GrokBuild => vec![
            home_dir.join(".grok/bin").join(executable),
            home_dir.join(".local/bin").join(executable),
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
            snapshots[0].capabilities.skills.roots[0].place,
            SkillPlace::Walk {
                walk: DirectoryWalk::RepositoryToTarget,
                relative: ".agents/skills".to_string(),
            }
        );
        assert_eq!(
            snapshots[1].capabilities.skills.precedence,
            SkillPrecedence::ClaudePersonalShadowsProject
        );
        assert_eq!(
            serde_json::to_value(snapshots[1].id).unwrap(),
            serde_json::json!("claude-code")
        );
        for snapshot in snapshots {
            assert!(
                snapshot
                    .capabilities
                    .skills
                    .roots
                    .iter()
                    .any(|root| matches!(root.place, SkillPlace::Personal(_)))
            );
        }
    }

    #[test]
    fn client_homes_come_from_the_agents_environment() {
        let home = PathBuf::from("/home/test");
        let environment =
            SourceRegistryEnvironment::from_variables(home.clone(), |name| match name {
                "QWEN_HOME" => Some("~/qwen".into()),
                "PI_CODING_AGENT_DIR" => Some("/srv/pi".into()),
                "KIMI_CODE_HOME" => Some("".into()),
                "XDG_CONFIG_HOME" => Some("/srv/config".into()),
                _ => None,
            });

        assert_eq!(environment.qwen_home, home.join("qwen"));
        assert_eq!(environment.pi_agent_dir, PathBuf::from("/srv/pi"));
        assert_eq!(environment.kimi_code_home, home.join(".kimi-code"));
        assert_eq!(
            environment.opencode_config_dir,
            PathBuf::from("/srv/config/opencode")
        );
        let defaults = SourceRegistryEnvironment::for_tests(home.clone());
        assert_eq!(defaults.opencode_config_dir, home.join(".config/opencode"));
        assert_eq!(defaults.pi_agent_dir, home.join(".pi/agent"));
        let opencode = SourceRegistryEnvironment::from_variables(home.clone(), |name| {
            (name == "OPENCODE_CONFIG_DIR").then(|| "/srv/opencode".into())
        });
        assert_eq!(opencode.opencode_config_dir, PathBuf::from("/srv/opencode"));
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
    fn agents_without_decided_sources_have_no_source_policy() {
        let environment = SourceRegistryEnvironment::for_tests(PathBuf::from("/home/test"));
        let policies = AgentAdapterRegistry.source_policies(&environment);

        assert_eq!(
            policies.iter().map(|policy| policy.id).collect::<Vec<_>>(),
            [
                AgentAdapterKind::Codex,
                AgentAdapterKind::ClaudeCode,
                AgentAdapterKind::Opencode,
                AgentAdapterKind::Pi,
                AgentAdapterKind::QwenCode,
                AgentAdapterKind::KimiCode,
            ]
        );
        assert!(
            AgentAdapterRegistry
                .identities()
                .iter()
                .any(|identity| identity.id == AgentAdapterKind::GrokBuild)
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
    fn opencode_and_grok_build_are_found_where_their_installers_put_them() {
        for (agent, location) in [
            (AgentAdapterKind::Opencode, ".opencode/bin/opencode"),
            (AgentAdapterKind::GrokBuild, ".grok/bin/grok"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let installed = directory.path().join(location);
            std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
            make_executable(&installed);
            assert_eq!(
                resolve_executable_path_with(agent, None, directory.path(), |_| { None }),
                Some(installed)
            );
        }
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
