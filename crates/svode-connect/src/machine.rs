//! Where the manager reads and writes on one machine: the client configs
//! under the home directory, the stable location and the client policies.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::ConnectError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    ClaudeCode,
    Codex,
}

impl Client {
    pub const ALL: [Client; 2] = [Client::ClaudeCode, Client::Codex];

    pub fn parse(value: &str) -> Result<Self, ConnectError> {
        match value {
            "claude-code" | "claude" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            _ => Err(ConnectError::new(
                "UNSUPPORTED_CLIENT",
                format!("unsupported agent client: {value}; expected claude-code or codex"),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    pub(crate) fn command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
        }
    }

    /// Whether the client reads the skill shared by every agent of the
    /// machine from `~/.agents/skills` rather than a skill of its own.
    pub(crate) fn uses_shared_skill(self) -> bool {
        matches!(self, Self::Codex)
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
        }
    }

    /// Also checks the project and local client entries of `project`.
    pub fn with_project(mut self, project: Option<&Path>) -> Self {
        self.project = project.map(Path::to_path_buf);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_policies(mut self, claude: Vec<PathBuf>, codex: PathBuf) -> Self {
        self.claude_policies = claude;
        self.codex_requirements = codex;
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
        match client {
            Client::ClaudeCode => self.claude_dir().join("skills").join("svode"),
            Client::Codex => self.home.join(".agents").join("skills").join("svode"),
        }
    }

    pub(crate) fn skill_target(stable: &Stable, client: Client) -> PathBuf {
        match client {
            Client::ClaudeCode => stable.payload.clone(),
            Client::Codex => stable.payload.join("skills").join("svode"),
        }
    }

    /// The user config that holds the MCP entry of `client`.
    pub(crate) fn mcp_config(&self, client: Client) -> PathBuf {
        match client {
            Client::ClaudeCode => self.claude_config(),
            Client::Codex => self.codex_config(),
        }
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
