//! Custom ACP agents the user adds on this device (Stage 10 `03` A2, A5): a
//! name, a command with its arguments and variables, and an id in the
//! custom namespace. Svode knows only what the agent declares in
//! `initialize`; it has no native readers, no Actor binding and no Svode
//! tools. The host stores the definitions; nothing here starts a process.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use svode_core::agent_adapters::{CUSTOM_AGENT_ID_PREFIX, CustomAgentId, system_home_dir};

use crate::adapters::{LaunchContext, LaunchUnavailable};
use crate::registry::AdapterTarget;
use crate::runtime::{AcpLaunch, AgentCapabilities, AgentInfo};

/// What the user enters for a custom agent. Variable values are not meant
/// for secrets: keys come from the login shell environment or the agent's
/// own configuration (A5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentDefinition {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: CustomAgentId,
    #[serde(flatten)]
    pub definition: CustomAgentDefinition,
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CustomAgentError {
    #[error("the agent needs a name")]
    NameMissing,
    #[error("the agent needs a command")]
    CommandMissing,
    #[error("{name} is not a valid environment variable name")]
    InvalidVariable { name: String },
    #[error("custom agent {agent} was not found")]
    NotFound { agent: String },
}

/// The one thing a custom agent can lack that the user should know: its
/// sessions outside Svode and their history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomAgentRestriction {
    /// Without `session/list` or `loadSession` Svode starts new sessions
    /// only: it neither lists nor reopens the agent's sessions.
    NewSessionOnly,
}

pub fn restriction(capabilities: &AgentCapabilities) -> Option<CustomAgentRestriction> {
    (!capabilities.list_sessions || !capabilities.load_session)
        .then_some(CustomAgentRestriction::NewSessionOnly)
}

impl CustomAgentDefinition {
    /// The definition as stored: name and command trimmed and required,
    /// variable names those of a process environment.
    pub fn normalized(mut self) -> Result<Self, CustomAgentError> {
        self.name = self.name.trim().to_string();
        self.command = self.command.trim().to_string();
        if self.name.is_empty() {
            return Err(CustomAgentError::NameMissing);
        }
        if self.command.is_empty() {
            return Err(CustomAgentError::CommandMissing);
        }
        if let Some(name) = self.env.keys().find(|name| !is_variable_name(name)) {
            return Err(CustomAgentError::InvalidVariable { name: name.clone() });
        }
        Ok(self)
    }
}

fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// A readable id from the agent's name, unique among `taken`. It never
/// changes when the agent is edited, so its sessions keep their namespace.
pub fn new_custom_agent_id(name: &str, taken: impl Fn(&CustomAgentId) -> bool) -> CustomAgentId {
    const SLUG_LIMIT: usize = 40;
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= SLUG_LIMIT {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "agent" } else { slug };
    (1..)
        .map(|n| match n {
            1 => format!("{CUSTOM_AGENT_ID_PREFIX}{slug}"),
            n => format!("{CUSTOM_AGENT_ID_PREFIX}{slug}-{n}"),
        })
        .map(|id| CustomAgentId::parse(&id).expect("a slug is a valid id"))
        .find(|id| !taken(id))
        .expect("some suffix is free")
}

/// The custom command as an executable: `~/` is the home directory, a path
/// is taken as is, a bare name is looked up in the login shell PATH.
pub fn resolve_custom_command(
    command: &str,
    home: &Path,
    search_path: Option<&OsStr>,
) -> Option<PathBuf> {
    let command = match command.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(command),
    };
    match search_path {
        Some(paths) => which::which_in(&command, Some(paths), home).ok(),
        None => which::which(&command).ok(),
    }
}

/// What a host shows about a custom agent without starting it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentSetup {
    pub agent: CustomAgentId,
    #[serde(flatten)]
    pub definition: CustomAgentDefinition,
    pub enabled: bool,
    /// `None` when the command is not found.
    pub executable_path: Option<PathBuf>,
    /// What the agent declared in its last `initialize` in this app
    /// process; `None` before its first check or session.
    pub declared: Option<AgentInfo>,
    pub restriction: Option<CustomAgentRestriction>,
}

/// A custom agent is enabled unless the user disabled it (A1).
pub fn custom_agent_setup(
    agent: &CustomAgent,
    enabled_choice: Option<bool>,
    target: &AdapterTarget,
    declared: Option<AgentInfo>,
) -> CustomAgentSetup {
    let home = system_home_dir().unwrap_or_else(|| target.cwd.clone());
    CustomAgentSetup {
        agent: agent.id.clone(),
        definition: agent.definition.clone(),
        enabled: enabled_choice.unwrap_or(true),
        executable_path: resolve_custom_command(
            &agent.definition.command,
            &home,
            target.search_path.as_deref(),
        ),
        restriction: declared
            .as_ref()
            .and_then(|info| restriction(&info.capabilities)),
        declared,
    }
}

/// The launch plan of a custom agent: its command in the home directory with
/// the login shell environment, the provenance variables and its own
/// variables on top. Its sessions live in its own namespace, its list is
/// its catalogue once it declares one, and its history is never read
/// without becoming the session's writer, as nothing records that its
/// `session/load` adds no turns.
pub fn custom_launch_plan(
    agent: &CustomAgent,
    enabled_choice: Option<bool>,
    context: &LaunchContext,
) -> Result<AcpLaunch, LaunchUnavailable> {
    if enabled_choice == Some(false) {
        return Err(LaunchUnavailable::Disabled);
    }
    let target = &context.target;
    let home = system_home_dir().unwrap_or_else(|| target.cwd.clone());
    let program = resolve_custom_command(
        &agent.definition.command,
        &home,
        target.search_path.as_deref(),
    )
    .ok_or_else(|| LaunchUnavailable::ExecutableMissing {
        executable: agent.definition.command.clone(),
    })?;
    let mut env = context.env.clone();
    env.extend(agent.definition.env.clone());
    Ok(AcpLaunch {
        agent: agent.id.agent_id().as_str().to_string(),
        program,
        args: agent.definition.args.clone(),
        environment: context.environment.clone(),
        env,
        cwd: target.cwd.clone(),
        acp_id_is_native: false,
        lists_catalog: true,
        read_only_open: false,
        writer_refusal: None,
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;
    use crate::runtime::LaunchEnvironment;

    fn definition(name: &str, command: &str) -> CustomAgentDefinition {
        CustomAgentDefinition {
            name: name.into(),
            command: command.into(),
            args: vec!["acp".into()],
            env: BTreeMap::from([("MODE".into(), "acp".into())]),
        }
    }

    #[test]
    fn a_definition_needs_a_name_a_command_and_valid_variable_names() {
        let normalized = definition("  My agent ", " agent ").normalized().unwrap();
        assert_eq!(normalized.name, "My agent");
        assert_eq!(normalized.command, "agent");
        assert_eq!(
            definition(" ", "agent").normalized(),
            Err(CustomAgentError::NameMissing)
        );
        assert_eq!(
            definition("Agent", "").normalized(),
            Err(CustomAgentError::CommandMissing)
        );
        let mut bad = definition("Agent", "agent");
        bad.env.insert("1KEY".into(), "x".into());
        assert_eq!(
            bad.normalized(),
            Err(CustomAgentError::InvalidVariable {
                name: "1KEY".into()
            })
        );
        assert_eq!(
            serde_json::to_value(CustomAgentError::InvalidVariable { name: "A B".into() }).unwrap(),
            serde_json::json!({ "code": "invalid_variable", "name": "A B" })
        );
    }

    #[test]
    fn ids_come_from_the_name_in_the_custom_namespace_and_stay_unique() {
        let none = |_: &CustomAgentId| false;
        assert_eq!(
            new_custom_agent_id("My ACP Agent!", none)
                .agent_id()
                .as_str(),
            "custom-my-acp-agent"
        );
        assert_eq!(
            new_custom_agent_id("Агент", none).agent_id().as_str(),
            "custom-agent"
        );
        let taken = |id: &CustomAgentId| {
            ["custom-hermes", "custom-hermes-2"].contains(&id.agent_id().as_str())
        };
        assert_eq!(
            new_custom_agent_id("Hermes", taken).agent_id().as_str(),
            "custom-hermes-3"
        );
        let long = new_custom_agent_id(&"a ".repeat(100), none);
        assert!(long.agent_id().as_str().len() <= 64);
        assert!(long.agent_id().is_custom());
        assert!(long.agent_id().builtin().is_none());
    }

    #[test]
    fn an_agent_without_list_or_load_is_new_session_only() {
        let all = AgentCapabilities {
            load_session: true,
            list_sessions: true,
            resume_session: true,
            close_session: false,
        };
        assert_eq!(restriction(&all), None);
        for capabilities in [
            AgentCapabilities {
                list_sessions: false,
                ..all
            },
            AgentCapabilities {
                load_session: false,
                ..all
            },
        ] {
            assert_eq!(
                restriction(&capabilities),
                Some(CustomAgentRestriction::NewSessionOnly)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_custom_agent_launches_its_command_with_its_variables_on_top() {
        use std::os::unix::fs::PermissionsExt;

        let bin = tempfile::tempdir().unwrap();
        let program = bin.path().join("agent");
        std::fs::write(&program, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let agent = CustomAgent {
            id: CustomAgentId::parse("custom-agent").unwrap(),
            definition: definition("Agent", "agent"),
        };
        let context = LaunchContext {
            target: AdapterTarget {
                cwd: bin.path().to_path_buf(),
                search_path: Some(OsString::from(bin.path())),
            },
            environment: Some(LaunchEnvironment::new([(
                OsString::from("API_KEY"),
                OsString::from("from-profile"),
            )])),
            env: BTreeMap::from([("MODE".into(), "provenance".into())]),
        };

        let launch = custom_launch_plan(&agent, None, &context).unwrap();
        assert_eq!(launch.agent, "custom-agent");
        assert_eq!(launch.program, program);
        assert_eq!(launch.args, ["acp"]);
        assert_eq!(launch.env.get("MODE").map(String::as_str), Some("acp"));
        assert_eq!(
            launch
                .environment
                .as_ref()
                .and_then(|env| env.get("API_KEY")),
            Some(OsStr::new("from-profile"))
        );
        assert!(!launch.acp_id_is_native);
        assert!(launch.lists_catalog);
        assert!(!launch.read_only_open);

        assert_eq!(
            custom_launch_plan(&agent, Some(false), &context).unwrap_err(),
            LaunchUnavailable::Disabled
        );
        let missing = CustomAgent {
            definition: definition("Agent", "no-such-agent"),
            ..agent.clone()
        };
        assert_eq!(
            custom_launch_plan(&missing, None, &context).unwrap_err(),
            LaunchUnavailable::ExecutableMissing {
                executable: "no-such-agent".into()
            }
        );
        // A path is taken as is.
        let by_path = CustomAgent {
            definition: definition("Agent", &program.to_string_lossy()),
            ..agent
        };
        assert_eq!(
            custom_launch_plan(&by_path, None, &context)
                .unwrap()
                .program,
            program
        );
    }

    #[test]
    fn a_setup_shows_the_restriction_of_what_the_agent_declared() {
        let agent = CustomAgent {
            id: CustomAgentId::parse("custom-agent").unwrap(),
            definition: definition("Agent", "no-such-agent"),
        };
        let target = AdapterTarget {
            cwd: std::env::temp_dir(),
            search_path: Some(OsString::new()),
        };
        let unknown = custom_agent_setup(&agent, None, &target, None);
        assert!(unknown.enabled);
        assert_eq!(unknown.executable_path, None);
        assert_eq!(unknown.restriction, None);
        let declared = AgentInfo {
            name: Some("agent".into()),
            version: None,
            capabilities: AgentCapabilities::default(),
        };
        let checked = custom_agent_setup(&agent, Some(false), &target, Some(declared));
        assert!(!checked.enabled);
        assert_eq!(
            checked.restriction,
            Some(CustomAgentRestriction::NewSessionOnly)
        );
        let value = serde_json::to_value(&checked).unwrap();
        assert_eq!(value["agent"], "custom-agent");
        assert_eq!(value["name"], "Agent");
        assert_eq!(value["args"], serde_json::json!(["acp"]));
        assert_eq!(value["restriction"], "new_session_only");
    }
}
