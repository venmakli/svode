//! Where the manager reads and writes on one machine: the client configs
//! under the home directory, the stable location and the client policies.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use svode_core::agent_adapters::{AgentAdapterKind, resolve_executable_path};

use crate::agent_mcp::AgentMcp;
use crate::error::ConnectError;

/// An agent the manager connects, under its id from the agent registry, and
/// how it is connected (Stage 10 `03` A9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Client {
    agent: AgentAdapterKind,
    pub(crate) kit: Kit,
}

/// The Svode integration kit of a client: its own part, which is the
/// agent's consent, and the shared part of the machine it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kit {
    /// Own part: the skill link of the Claude Code plugin, which also brings
    /// MCP. No shared part.
    ClaudePlugin,
    /// Own part: a managed MCP entry. Shared part: the skill every agent of
    /// the machine reads from `~/.agents/skills`.
    CodexMcp,
    /// Own part: a managed MCP entry in the agent's JSON config, written by
    /// its own command where it has one. Shared part: the shared skill.
    AgentMcp(AgentMcp),
    /// Own part: a marked entry of the skill directories in the Hermes
    /// config that lists the shared skill directory. Shared part: the
    /// shared skill. No MCP entry, for a reason its limitation names.
    HermesSkills,
    /// No own part: the agent reads the shared skill and gets no MCP entry,
    /// for a reason its limitation names.
    SharedSkillOnly,
}

impl Client {
    /// The client of an agent: every agent of the registry gets the Svode
    /// tools by its kit.
    pub fn of(agent: AgentAdapterKind) -> Self {
        let kit = match agent {
            AgentAdapterKind::ClaudeCode => Kit::ClaudePlugin,
            AgentAdapterKind::Codex => Kit::CodexMcp,
            AgentAdapterKind::Opencode => Kit::AgentMcp(AgentMcp::Opencode),
            AgentAdapterKind::QwenCode => Kit::AgentMcp(AgentMcp::QwenCode),
            AgentAdapterKind::Pi => Kit::AgentMcp(AgentMcp::Pi),
            AgentAdapterKind::KimiCode => Kit::AgentMcp(AgentMcp::KimiCode),
            AgentAdapterKind::Hermes => Kit::HermesSkills,
            AgentAdapterKind::GrokBuild | AgentAdapterKind::Cursor => Kit::SharedSkillOnly,
        };
        Self { agent, kit }
    }

    /// Every client, in the order of the agent registry.
    pub fn all() -> Vec<Self> {
        AgentAdapterKind::ALL.into_iter().map(Self::of).collect()
    }

    /// A client by agent id; `claude`, the command of Claude Code, also
    /// names it.
    pub fn parse(value: &str) -> Result<Self, ConnectError> {
        let id = if value == "claude" {
            AgentAdapterKind::ClaudeCode.as_str()
        } else {
            value
        };
        AgentAdapterKind::from_id(id).map(Self::of).ok_or_else(|| {
            let expected = Self::all()
                .into_iter()
                .map(Self::as_str)
                .collect::<Vec<_>>()
                .join(" or ");
            ConnectError::new(
                "UNSUPPORTED_CLIENT",
                format!("unsupported agent client: {value}; expected {expected}"),
            )
        })
    }

    pub fn agent(self) -> AgentAdapterKind {
        self.agent
    }

    pub fn as_str(self) -> &'static str {
        self.agent.as_str()
    }

    pub fn name(self) -> &'static str {
        self.agent.display_name()
    }

    /// Whether the kit of the client uses the skill shared by the agents of
    /// the machine in `~/.agents/skills` rather than a skill of its own.
    pub(crate) fn uses_shared_skill(self) -> bool {
        self.kit != Kit::ClaudePlugin
    }

    /// Whether the manager can give the agent a part of its own, whose
    /// marker is the agent's consent. An agent without one is only a reader
    /// of the shared skill.
    pub fn has_own_part(self) -> bool {
        self.kit != Kit::SharedSkillOnly
    }

    /// What the kit of the agent lacks compared to the others, with its
    /// evidence; `None` for a complete kit.
    pub(crate) fn limitation(self) -> Option<&'static str> {
        match self.agent {
            // E03, Grok Build 1.0.46: in an ACP session it starts MCP
            // servers in its own process directory, the home directory in
            // the chat of Svode, not in the session directory.
            AgentAdapterKind::GrokBuild => Some(
                "Grok Build starts MCP servers in its own directory rather than the session's, so Svode MCP could not tell the project in the chat of Svode; it gets the shared skill and svode only",
            ),
            // E03, Hermes 2026.9.24: the same in an ACP session; it reads
            // the shared skill through `skills.external_dirs` instead of
            // `~/.agents/skills`.
            AgentAdapterKind::Hermes => Some(
                "Hermes starts MCP servers in its own directory rather than the session's, so Svode MCP could not tell the project in the chat of Svode; it gets the shared skill and svode only",
            ),
            // E03, Cursor 2026.10.01: turns were refused by the plan, so
            // where it starts MCP servers in a session is not verified, and
            // it starts a configured server only once it is approved.
            AgentAdapterKind::Cursor => Some(
                "Where Cursor starts MCP servers in a session is not verified yet, and it starts one only after it is approved, so Svode adds no MCP entry; it gets the shared skill and svode only",
            ),
            _ => None,
        }
    }
}

/// The runtime the launchers of the stable location run now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRuntime {
    /// `desktop` or `standalone`.
    pub kind: String,
    pub version: String,
    /// The `svode-mcp` binary of that runtime.
    pub mcp_binary: PathBuf,
}

/// The stable location `~/.svode` as client configs refer to it.
#[derive(Debug, Clone)]
pub(crate) struct Stable {
    pub launcher_mcp: PathBuf,
    pub launcher_cli: PathBuf,
    /// Stable address of the plugin payload of the active runtime.
    pub payload: PathBuf,
    pub runtime: Option<ActiveRuntime>,
}

impl Stable {
    /// Launchers and payload exist, so every artifact a client refers to
    /// resolves, even when the runtime behind them is gone.
    pub fn installed(&self) -> bool {
        self.launcher_mcp.is_file()
            && self.launcher_cli.is_file()
            && self.payload.join(".claude-plugin/plugin.json").is_file()
    }

    /// Version the payload manifest declares.
    pub fn payload_version(&self) -> Option<String> {
        let manifest = std::fs::read(self.payload.join(".claude-plugin/plugin.json")).ok()?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest).ok()?;
        manifest["version"].as_str().map(str::to_string)
    }

    #[cfg(unix)]
    fn of(home: &Path) -> Self {
        let layout = svode_install::Layout::at(home.join(".svode"));
        let runtime = [layout.active(), layout.standalone()]
            .into_iter()
            .flatten()
            .find(|runtime| runtime.runs("svode-mcp"))
            .map(|runtime| ActiveRuntime {
                kind: match runtime.record.kind {
                    svode_install::RuntimeKind::Desktop => "desktop",
                    svode_install::RuntimeKind::Standalone => "standalone",
                }
                .to_string(),
                version: runtime.record.version.clone(),
                mcp_binary: runtime.binary("svode-mcp"),
            });
        Self {
            launcher_mcp: layout.launcher("svode-mcp"),
            launcher_cli: layout.launcher("svode"),
            payload: layout.payload(),
            runtime,
        }
    }
}

/// One user of one machine as the manager sees it.
#[derive(Debug, Clone)]
pub struct Machine {
    pub(crate) home: PathBuf,
    pub(crate) stable: Option<Stable>,
    /// Project whose project and local client entries override user scope.
    pub(crate) project: Option<PathBuf>,
    pub(crate) claude_policies: Vec<PathBuf>,
    pub(crate) codex_requirements: PathBuf,
    /// System settings of Qwen Code for every user of the machine.
    pub(crate) qwen_system_settings: PathBuf,
    /// PATH the agent executables are searched in instead of the process
    /// PATH, e.g. the login shell PATH of a GUI app.
    pub(crate) search_path: Option<OsString>,
}

impl Machine {
    /// The user running the process.
    pub fn user() -> Result<Self, ConnectError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .ok_or_else(|| {
                ConnectError::new("HOME_UNAVAILABLE", "HOME is not set to an absolute path")
            })?;
        Ok(Self::at(home))
    }

    /// The user whose home directory is `home`.
    pub fn at(home: PathBuf) -> Self {
        #[cfg(unix)]
        let stable = Some(Stable::of(&home));
        #[cfg(not(unix))]
        let stable = None;
        Self {
            home,
            stable,
            project: None,
            claude_policies: system_claude_policies(),
            codex_requirements: PathBuf::from("/etc/codex/requirements.toml"),
            qwen_system_settings: system_qwen_settings(),
            search_path: None,
        }
    }

    /// Searches agent executables in `path` instead of the process PATH.
    pub fn with_search_path(mut self, path: Option<&OsStr>) -> Self {
        self.search_path = path.map(OsStr::to_os_string);
        self
    }

    /// The executable of `agent` by the one resolver of the agent registry
    /// (Stage 10 `03` A1); found agents are the readers of the shared skill.
    pub(crate) fn find(&self, agent: AgentAdapterKind) -> Option<PathBuf> {
        resolve_executable_path(agent, None, &self.home, self.search_path.as_deref())
    }

    /// Also checks the project and local client entries of `project`.
    pub fn with_project(mut self, project: Option<&Path>) -> Self {
        self.project = project.map(Path::to_path_buf);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_policies(
        mut self,
        claude: Vec<PathBuf>,
        codex: PathBuf,
        qwen: PathBuf,
    ) -> Self {
        self.claude_policies = claude;
        self.codex_requirements = codex;
        self.qwen_system_settings = qwen;
        self
    }

    /// Stable launcher `svode-mcp` that client configs start.
    pub fn launcher_mcp(&self) -> Option<&Path> {
        self.stable
            .as_ref()
            .map(|stable| stable.launcher_mcp.as_path())
    }

    pub(crate) fn claude_config(&self) -> PathBuf {
        self.home.join(".claude.json")
    }

    pub(crate) fn claude_dir(&self) -> PathBuf {
        self.home.join(".claude")
    }

    pub(crate) fn codex_config(&self) -> PathBuf {
        self.home.join(".codex").join("config.toml")
    }

    /// Where the client finds the Svode skill (and for Claude Code the
    /// whole plugin), and what that link points to.
    pub(crate) fn skill_link(&self, client: Client) -> PathBuf {
        match client.kit {
            Kit::ClaudePlugin => self.claude_dir().join("skills").join("svode"),
            _ => self.shared_skill_link(),
        }
    }

    pub(crate) fn skill_target(stable: &Stable, client: Client) -> PathBuf {
        match client.kit {
            Kit::ClaudePlugin => stable.payload.clone(),
            _ => Self::shared_skill_target(stable),
        }
    }

    /// The skill shared by the agents of the machine that read
    /// `~/.agents/skills`.
    pub(crate) fn shared_skill_link(&self) -> PathBuf {
        self.home.join(".agents").join("skills").join("svode")
    }

    pub(crate) fn shared_skill_target(stable: &Stable) -> PathBuf {
        stable.payload.join("skills").join("svode")
    }

    pub(crate) fn hermes_config(&self) -> PathBuf {
        self.home.join(".hermes").join("config.yaml")
    }

    /// The user config that holds the entry of `client` — its MCP entry or
    /// the skill directory entry of Hermes — if it has one.
    pub(crate) fn entry_config(&self, client: Client) -> Option<PathBuf> {
        match client.kit {
            Kit::ClaudePlugin => Some(self.claude_config()),
            Kit::CodexMcp => Some(self.codex_config()),
            Kit::AgentMcp(kind) => Some(kind.config(self)),
            Kit::HermesSkills => Some(self.hermes_config()),
            Kit::SharedSkillOnly => None,
        }
    }
}

/// System settings of Qwen Code for every user of the machine.
fn system_qwen_settings() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/QwenCode/settings.json")
    } else {
        PathBuf::from("/etc/qwen-code/settings.json")
    }
}

/// Managed settings files of Claude Code for every user of the machine.
fn system_claude_policies() -> Vec<PathBuf> {
    let root = if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    };
    let mut files = vec![root.join("managed-settings.json")];
    if let Ok(entries) = std::fs::read_dir(root.join("managed-settings.d")) {
        let mut drop_ins = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect::<Vec<_>>();
        drop_ins.sort();
        files.extend(drop_ins);
    }
    files
}
