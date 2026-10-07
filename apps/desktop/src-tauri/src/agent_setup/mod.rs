//! Desktop host of agent setup: the device-local adapter directory in the
//! app data, and the user's enable choices and custom ACP agents in the app
//! config, handed to the library when an agent launches. Rules and
//! installation belong to `svode_agents::adapters` and
//! `svode_agents::custom`.

pub mod commands;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use svode_agents::adapters::{
    AdapterStore, ChatOffer, LaunchContext, LaunchUnavailable, RegistryPackageSource, adapter_pin,
    agent_enabled,
};
use svode_agents::custom::{
    CustomAgent, CustomAgentDefinition, CustomAgentError, custom_launch_plan, new_custom_agent_id,
};
use svode_agents::registry::{
    AdapterRuntimeRegistry, AdapterTarget, AgentVerdict, CatalogSource, SystemRuntimeCommandRunner,
};
use svode_core::agent_adapters::{AgentAdapterKind, CustomAgentId, resolve_executable_path};

use crate::agent_runtime::connections::{LaunchPlanner, PlanFuture};
use crate::error::AppError;
use crate::process::login_env::LoginEnvironment;
use crate::process::path_env::ProcessPath;

const ENABLEMENT_FILE: &str = "agents.json";
const CUSTOM_AGENTS: &str = "customAgents";
const LAST_CHAT_AGENT: &str = "lastChatAgent";

/// Clones share one store, package source and choices lock.
#[derive(Clone)]
pub struct AgentSetupState {
    store: Arc<AdapterStore>,
    source: Arc<RegistryPackageSource>,
    config_dir: PathBuf,
    /// Serializes read-modify-write of `agents.json`.
    choices: Arc<Mutex<()>>,
}

impl AgentSetupState {
    pub fn new(data_dir: &Path, config_dir: PathBuf) -> Self {
        Self {
            store: Arc::new(AdapterStore::new(data_dir.join("agent-adapters"))),
            source: Arc::new(RegistryPackageSource::new()),
            config_dir,
            choices: Arc::new(Mutex::new(())),
        }
    }

    fn choice(&self, agent: &str) -> Option<bool> {
        read_choices(&self.config_dir)
            .unwrap_or_else(|error| {
                tracing::warn!("agent enable choices are unreadable: {error}");
                BTreeMap::new()
            })
            .get(agent)
            .copied()
    }

    fn set_choice(&self, agent: &str, enabled: bool) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        write_choice(&self.config_dir, agent, enabled)
    }

    /// The agent of the last session created in the chat on this device.
    pub(crate) fn last_chat_agent(&self) -> Option<String> {
        read_file(&self.config_dir)
            .ok()
            .flatten()?
            .get(LAST_CHAT_AGENT)?
            .as_str()
            .map(str::to_string)
    }

    pub(crate) fn set_last_chat_agent(&self, agent: &str) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        update_file(&self.config_dir, |root| {
            root.insert(LAST_CHAT_AGENT.into(), agent.into());
            Ok(())
        })
    }

    /// How a new session offers `agent` for chat (Stage 10 `04`, chat and
    /// terminal; `03` A1/A5/A8): the one rule of whether the chat is
    /// available to an agent, for a new session draft and for a Routine
    /// launch. Resolves the launch plan and runs the agent's bounded sign-in
    /// check in `target`; starts no ACP process.
    pub(crate) async fn chat_offer(
        &self,
        agent: &str,
        target: &AdapterTarget,
    ) -> Option<ChatOffer> {
        let builtin = AgentAdapterKind::from_id(agent);
        let deferred = builtin.is_some_and(deferred);
        let plan = self.plan(agent).await;
        let authenticated = match (&plan, builtin) {
            (Ok(_), Some(kind)) if !deferred => {
                AdapterRuntimeRegistry
                    .diagnose(kind, target, &SystemRuntimeCommandRunner)
                    .await
                    .authenticated
            }
            _ => None,
        };
        svode_agents::adapters::chat_offer(deferred, &plan, authenticated)
    }

    /// The ACP launch plan of a Routine or Agent Actor launch of `agent` in
    /// `space`, whose Space-local executable override applies, with the
    /// launch provenance `env`, and the chat offer of `chat_offer` for it;
    /// `authenticated` is the sign-in check the launch already ran. Starts
    /// no ACP process.
    pub(crate) async fn launch_offer(
        &self,
        agent: AgentAdapterKind,
        space: &Path,
        env: BTreeMap<String, String>,
        authenticated: Option<bool>,
    ) -> (
        Result<svode_agents::AcpLaunch, LaunchUnavailable>,
        Option<ChatOffer>,
    ) {
        let context = LaunchContext {
            target: AdapterTarget {
                cwd: space.to_path_buf(),
                search_path: ProcessPath::session().get().await.map(ToOwned::to_owned),
            },
            environment: LoginEnvironment::session().get().await,
            env,
        };
        let plan = self
            .store
            .launch_plan(
                agent,
                self.choice(agent.as_str()),
                &context,
                &SystemRuntimeCommandRunner,
            )
            .await;
        let offer = svode_agents::adapters::chat_offer(deferred(agent), &plan, authenticated);
        (plan, offer)
    }

    /// The built-in agents with a native catalogue source whose store
    /// Svode reads (Stage 10 `07` N1): the available ones (`03` A1), found
    /// on the device and not disabled by the user.
    pub(crate) async fn native_catalog_agents(&self) -> Vec<AgentAdapterKind> {
        let Ok(target) = commands::target().await else {
            return Vec::new();
        };
        AgentAdapterKind::ALL
            .into_iter()
            .filter(|agent| {
                AdapterRuntimeRegistry
                    .catalog_sources(*agent)
                    .iter()
                    .any(|source| matches!(source, CatalogSource::Native(_)))
            })
            .filter(|agent| {
                let install = adapter_pin(*agent).map(|pin| self.store.state(pin));
                agent_enabled(self.choice(agent.as_str()), install.as_ref())
            })
            .filter(|agent| {
                resolve_executable_path(*agent, None, &target.cwd, target.search_path.as_deref())
                    .is_some()
            })
            .collect()
    }

    /// The custom ACP agents in the order the user added them.
    pub(crate) fn custom_agents(&self) -> Vec<CustomAgent> {
        read_custom_agents(&self.config_dir).unwrap_or_else(|error| {
            tracing::warn!("custom agents are unreadable: {error}");
            Vec::new()
        })
    }

    fn custom_agent(&self, agent: &CustomAgentId) -> Result<CustomAgent, AppError> {
        self.custom_agents()
            .into_iter()
            .find(|custom| &custom.id == agent)
            .ok_or_else(|| {
                CustomAgentError::NotFound {
                    agent: agent.agent_id().to_string(),
                }
                .into()
            })
    }

    /// The id a new custom agent with this name gets.
    fn next_custom_id(&self, name: &str) -> CustomAgentId {
        let existing = self.custom_agents();
        new_custom_agent_id(name, |id| existing.iter().any(|custom| &custom.id == id))
    }

    fn add_custom_agent(&self, definition: CustomAgentDefinition) -> Result<CustomAgent, AppError> {
        let definition = definition.normalized()?;
        let _guard = self.choices.lock().unwrap();
        let agent = CustomAgent {
            id: self.next_custom_id(&definition.name),
            definition,
        };
        let entry = serde_json::to_value(&agent)?;
        update_file(&self.config_dir, |root| {
            custom_entries(root)?.push(entry);
            Ok(())
        })?;
        Ok(agent)
    }

    /// Changes everything but the id, so the agent's sessions keep theirs.
    fn update_custom_agent(
        &self,
        id: CustomAgentId,
        definition: CustomAgentDefinition,
    ) -> Result<CustomAgent, AppError> {
        let agent = CustomAgent {
            id,
            definition: definition.normalized()?,
        };
        let _guard = self.choices.lock().unwrap();
        let entry = serde_json::to_value(&agent)?;
        update_file(&self.config_dir, |root| {
            let entries = custom_entries(root)?;
            let index = entries
                .iter()
                .position(|known| entry_id(known) == Some(agent.id.agent_id().as_str()))
                .ok_or_else(|| CustomAgentError::NotFound {
                    agent: agent.id.agent_id().to_string(),
                })?;
            entries[index] = entry;
            Ok(())
        })?;
        Ok(agent)
    }

    /// Forgets the agent and its enable choice; its sessions stay with the
    /// agent itself.
    fn remove_custom_agent(&self, id: &CustomAgentId) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        let id = id.agent_id().as_str();
        update_file(&self.config_dir, |root| {
            custom_entries(root)?.retain(|known| entry_id(known) != Some(id));
            if let Some(agents) = root
                .get_mut("agents")
                .and_then(serde_json::Value::as_object_mut)
            {
                agents.remove(id);
            }
            Ok(())
        })
    }

    async fn plan_custom(
        &self,
        agent: &CustomAgent,
        enabled_choice: Option<bool>,
    ) -> Result<svode_agents::AcpLaunch, LaunchUnavailable> {
        let target =
            commands::target()
                .await
                .map_err(|_| LaunchUnavailable::ExecutableMissing {
                    executable: agent.definition.command.clone(),
                })?;
        let context = LaunchContext {
            target,
            environment: LoginEnvironment::session().get().await,
            env: BTreeMap::new(),
        };
        custom_launch_plan(agent, enabled_choice, &context)
    }
}

/// Launches in the home directory with the login shell environment, the
/// login shell PATH and the user's enable choice.
impl LaunchPlanner for AgentSetupState {
    /// Built-in agents whose list is their declared catalogue and enabled
    /// custom agents, whose list is their catalogue once they declare one.
    fn catalog_agents(&self) -> Vec<String> {
        let custom = self
            .custom_agents()
            .into_iter()
            .map(|custom| custom.id.agent_id().as_str().to_string())
            .filter(|agent| self.choice(agent) != Some(false));
        AgentAdapterKind::ALL
            .into_iter()
            .filter(|agent| AdapterRuntimeRegistry.lists_catalog(*agent))
            .map(|agent| agent.as_str().to_string())
            .chain(custom)
            .collect()
    }

    fn plan<'a>(&'a self, agent: &'a str) -> PlanFuture<'a> {
        Box::pin(async move {
            if let Ok(id) = CustomAgentId::parse(agent) {
                let custom = self
                    .custom_agent(&id)
                    .map_err(|_| LaunchUnavailable::NotSupported)?;
                return self.plan_custom(&custom, self.choice(agent)).await;
            }
            let Some(kind) = AgentAdapterKind::from_id(agent) else {
                return Err(LaunchUnavailable::NotSupported);
            };
            // Without a home directory no executable resolves.
            let target =
                commands::target()
                    .await
                    .map_err(|_| LaunchUnavailable::ExecutableMissing {
                        executable: kind.executable().to_string(),
                    })?;
            let context = LaunchContext {
                target,
                environment: LoginEnvironment::session().get().await,
                env: BTreeMap::new(),
            };
            self.store
                .launch_plan(
                    kind,
                    self.choice(agent),
                    &context,
                    &SystemRuntimeCommandRunner,
                )
                .await
        })
    }

    fn plan_draft<'a>(
        &'a self,
        agent: Option<&'a str>,
        definition: CustomAgentDefinition,
    ) -> PlanFuture<'a> {
        Box::pin(async move {
            let id = match agent.map(CustomAgentId::parse) {
                Some(Ok(id)) => id,
                Some(Err(_)) => return Err(LaunchUnavailable::NotSupported),
                None => self.next_custom_id(&definition.name),
            };
            let agent = CustomAgent { id, definition };
            self.plan_custom(&agent, None).await
        })
    }
}

/// An agent whose verdict defers it is offered to nobody (`03` A8).
fn deferred(agent: AgentAdapterKind) -> bool {
    AdapterRuntimeRegistry.verdict(agent) == AgentVerdict::Deferred
}

/// `agents.json`: `{ "agents": { "<agent id>": { "enabled": bool } } }`.
/// Entries of ids this build does not know are kept.
fn read_choices(config_dir: &Path) -> Result<BTreeMap<String, bool>, AppError> {
    let Some(value) = read_file(config_dir)? else {
        return Ok(BTreeMap::new());
    };
    Ok(value
        .get("agents")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, agent)| Some((id.clone(), agent.get("enabled")?.as_bool()?)))
        .collect())
}

fn write_choice(config_dir: &Path, agent: &str, enabled: bool) -> Result<(), AppError> {
    update_file(config_dir, |root| {
        let agents = root
            .entry("agents")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| {
                AppError::General(format!("{ENABLEMENT_FILE} agents must be an object"))
            })?;
        let entry = agents.entry(agent).or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        entry["enabled"] = serde_json::Value::Bool(enabled);
        Ok(())
    })
}

/// `customAgents`: `[{ "id", "name", "command", "args", "env" }]` in the
/// order the user added them. Entries this build cannot read are skipped
/// and kept on write.
fn read_custom_agents(config_dir: &Path) -> Result<Vec<CustomAgent>, AppError> {
    let Some(value) = read_file(config_dir)? else {
        return Ok(Vec::new());
    };
    Ok(value
        .get(CUSTOM_AGENTS)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
        .collect())
}

fn custom_entries(
    root: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<&mut Vec<serde_json::Value>, AppError> {
    root.entry(CUSTOM_AGENTS)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| {
            AppError::General(format!("{ENABLEMENT_FILE} {CUSTOM_AGENTS} must be a list"))
        })
}

fn entry_id(entry: &serde_json::Value) -> Option<&str> {
    entry.get("id").and_then(serde_json::Value::as_str)
}

/// Reads `agents.json`, applies `change` and replaces the file atomically;
/// a malformed file is never overwritten.
fn update_file<T>(
    config_dir: &Path,
    change: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut value = read_file(config_dir)?.unwrap_or_else(|| serde_json::json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| AppError::General(format!("{ENABLEMENT_FILE} must be an object")))?;
    let changed = change(root)?;
    std::fs::create_dir_all(config_dir)?;
    let staged = tempfile::NamedTempFile::new_in(config_dir)?;
    serde_json::to_writer_pretty(staged.as_file(), &value)?;
    staged.as_file().sync_all()?;
    staged
        .persist(config_dir.join(ENABLEMENT_FILE))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(changed)
}

fn read_file(config_dir: &Path) -> Result<Option<serde_json::Value>, AppError> {
    match std::fs::read(config_dir.join(ENABLEMENT_FILE)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The agents that run through a pinned adapter.
#[cfg(test)]
fn adapter_agents() -> impl Iterator<Item = AgentAdapterKind> {
    AgentAdapterKind::ALL
        .into_iter()
        .filter(|agent| svode_agents::adapters::adapter_pin(*agent).is_some())
}

/// Agent setup of live tests in `root`: the pinned adapters of every agent
/// installed from npm and every agent enabled.
#[cfg(test)]
pub(crate) async fn live_setup_with_pinned_adapters(root: &std::path::Path) -> AgentSetupState {
    let setup = AgentSetupState::new(&root.join("data"), root.join("config"));
    for agent in adapter_agents() {
        let started = std::time::Instant::now();
        setup
            .store
            .prepare_enable(
                agent,
                &commands::target().await.unwrap(),
                &SystemRuntimeCommandRunner,
                &*setup.source,
            )
            .await
            .unwrap();
        setup.set_choice(agent.as_str(), true).unwrap();
        println!("{agent:?}: adapter installed in {:?}", started.elapsed());
    }
    setup
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_choices_round_trip_and_keep_unknown_agents() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_choices(dir.path()).unwrap().is_empty());
        std::fs::write(
            dir.path().join(ENABLEMENT_FILE),
            r#"{"agents":{"future-agent":{"enabled":false,"extra":1}},"other":true}"#,
        )
        .unwrap();

        write_choice(dir.path(), "codex", true).unwrap();
        write_choice(dir.path(), "claude-code", false).unwrap();
        write_choice(dir.path(), "codex", false).unwrap();

        let choices = read_choices(dir.path()).unwrap();
        assert_eq!(choices.get("codex"), Some(&false));
        assert_eq!(choices.get("claude-code"), Some(&false));
        assert_eq!(choices.get("future-agent"), Some(&false));
        let value = read_file(dir.path()).unwrap().unwrap();
        assert_eq!(value["agents"]["future-agent"]["extra"], 1);
        assert_eq!(value["other"], true);
    }

    /// Live acceptance of the explicit check with the user's CLIs: installs
    /// the pinned adapters into a temporary app data directory, then checks
    /// each agent through the Desktop planner (login shell environment and
    /// PATH) and shows that no adapter process is left.
    #[tokio::test]
    #[ignore = "live: downloads the pinned adapters from npm and starts the user's described agents"]
    async fn live_check_starts_initializes_and_closes_the_users_agents() {
        use std::time::Instant;

        use svode_agents::{AgentCheck, AgentRuntime};

        use crate::agent_runtime::connections::AgentConnections;

        let dir = tempfile::tempdir().unwrap();
        let setup = live_setup_with_pinned_adapters(dir.path()).await;
        let runtime = AgentRuntime::default();
        let connections = AgentConnections::new(runtime.clone(), setup.clone());
        let described = AgentAdapterKind::ALL
            .into_iter()
            .filter(|agent| AdapterRuntimeRegistry.acp_entrypoint(*agent).is_some());
        for agent in described {
            let started = Instant::now();
            let check = connections.check(agent.as_str()).await;
            println!("{agent:?}: {check:?} in {:?}", started.elapsed());
            assert!(matches!(check, AgentCheck::Ready { .. }), "{check:?}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let left = std::process::Command::new("pgrep")
            .args(["-f", &dir.path().to_string_lossy()])
            .output()
            .unwrap();
        assert!(
            left.stdout.is_empty(),
            "adapter processes left: {}",
            String::from_utf8_lossy(&left.stdout)
        );
    }

    fn definition(name: &str) -> CustomAgentDefinition {
        CustomAgentDefinition {
            name: name.into(),
            command: "hermes".into(),
            args: vec!["acp".into()],
            env: BTreeMap::from([("HERMES_MODE".into(), "acp".into())]),
        }
    }

    #[test]
    fn custom_agents_keep_their_order_and_id_and_unreadable_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(ENABLEMENT_FILE),
            r#"{"agents":{"codex":{"enabled":false}},"customAgents":[{"id":"not a custom id"}]}"#,
        )
        .unwrap();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());

        let first = setup.add_custom_agent(definition(" Hermes ")).unwrap();
        let second = setup.add_custom_agent(definition("Hermes")).unwrap();
        assert_eq!(first.id.agent_id().as_str(), "custom-hermes");
        assert_eq!(first.definition.name, "Hermes");
        assert_eq!(second.id.agent_id().as_str(), "custom-hermes-2");
        assert!(matches!(
            setup.add_custom_agent(CustomAgentDefinition {
                command: " ".into(),
                ..definition("Empty")
            }),
            Err(AppError::CustomAgent(CustomAgentError::CommandMissing))
        ));

        let renamed = setup
            .update_custom_agent(
                first.id.clone(),
                CustomAgentDefinition {
                    name: "Hermes ACP".into(),
                    ..definition("ignored")
                },
            )
            .unwrap();
        assert_eq!(renamed.id, first.id, "editing keeps the id");
        let names: Vec<_> = setup
            .custom_agents()
            .into_iter()
            .map(|agent| agent.definition.name)
            .collect();
        assert_eq!(names, ["Hermes ACP", "Hermes"]);

        setup.set_choice("custom-hermes", false).unwrap();
        setup.remove_custom_agent(&first.id).unwrap();
        assert!(matches!(
            setup.update_custom_agent(first.id.clone(), definition("Gone")),
            Err(AppError::CustomAgent(CustomAgentError::NotFound { .. }))
        ));
        let value = read_file(dir.path()).unwrap().unwrap();
        assert_eq!(value["customAgents"].as_array().unwrap().len(), 2);
        assert_eq!(value["customAgents"][0]["id"], "not a custom id");
        assert_eq!(value["customAgents"][1]["id"], "custom-hermes-2");
        assert_eq!(value["customAgents"][1]["env"]["HERMES_MODE"], "acp");
        assert_eq!(
            value["agents"],
            serde_json::json!({ "codex": { "enabled": false } }),
            "the removed agent's choice goes with it"
        );
    }

    #[tokio::test]
    async fn enabled_custom_agents_are_catalogue_agents_and_a_disabled_one_never_starts() {
        let dir = tempfile::tempdir().unwrap();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        let on = setup.add_custom_agent(definition("On")).unwrap();
        let off = setup.add_custom_agent(definition("Off")).unwrap();
        setup.set_choice(off.id.agent_id().as_str(), false).unwrap();

        assert_eq!(
            setup.catalog_agents(),
            [
                "codex",
                "claude-code",
                "cursor",
                "opencode",
                "pi",
                "qwen-code",
                "grok-build",
                on.id.agent_id().as_str()
            ]
        );
        assert_eq!(
            setup.plan(off.id.agent_id().as_str()).await,
            Err(LaunchUnavailable::Disabled)
        );
        assert_eq!(
            setup.plan("custom-removed").await,
            Err(LaunchUnavailable::NotSupported)
        );
    }

    /// Live acceptance of slice 3.4 with the user's `hermes acp` as a custom
    /// agent: added, checked through the Desktop planner (login shell
    /// environment and PATH), its declaration and restriction read, its list
    /// offered to an open collection, then removed. No session is created.
    #[tokio::test]
    #[ignore = "live: starts the user's hermes acp"]
    async fn live_hermes_acp_as_a_custom_agent() {
        use std::time::Instant;

        use svode_agents::custom::custom_agent_setup;
        use svode_agents::{AgentCheck, AgentRuntime};

        use crate::agent_runtime::connections::AgentConnections;

        let dir = tempfile::tempdir().unwrap();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        let draft = CustomAgentDefinition {
            name: "Hermes ACP".into(),
            command: "hermes".into(),
            args: vec!["acp".into()],
            env: BTreeMap::new(),
        };
        let runtime = AgentRuntime::default();
        let connections = AgentConnections::new(runtime.clone(), setup.clone());

        let started = Instant::now();
        let draft_check = connections.check_draft(None, draft.clone()).await;
        println!("draft check: {draft_check:?} in {:?}", started.elapsed());
        assert!(matches!(draft_check, AgentCheck::Ready { .. }));

        let agent = setup.add_custom_agent(draft).unwrap();
        let id = agent.id.agent_id().as_str().to_string();
        assert_eq!(id, "custom-hermes-acp");
        let started = Instant::now();
        let check = connections.check(&id).await;
        println!("check: {check:?} in {:?}", started.elapsed());
        let AgentCheck::Ready { agent: info } = check else {
            panic!("hermes acp starts");
        };
        let facts = custom_agent_setup(
            &agent,
            setup.choice(&id),
            &commands::target().await.unwrap(),
            runtime.declared(&id),
        );
        println!(
            "setup: executable {:?}, restriction {:?}, declared {:?}",
            facts.executable_path, facts.restriction, facts.declared
        );
        assert!(facts.executable_path.is_some());
        assert_eq!(facts.declared, Some(info));

        connections.hold_catalog("main");
        assert_eq!(
            connections.held_catalog_agents(),
            ["codex", "claude-code", id.as_str()]
        );
        assert!(connections.raise_catalog_agent(&id).await);
        let listing = runtime.catalog_connections();
        let connection = listing.iter().find(|c| c.agent == id).unwrap().connection;
        let list = runtime.list_sessions(connection).await.unwrap();
        println!("session/list: {} sessions", list.sessions.len());

        setup.remove_custom_agent(&agent.id).unwrap();
        connections.forget_agent(&id);
        assert!(setup.custom_agents().is_empty());
        assert_eq!(
            connections.check(&id).await,
            AgentCheck::Unavailable {
                reason: LaunchUnavailable::NotSupported
            }
        );
        runtime.shutdown().await;
    }

    #[test]
    fn a_malformed_file_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ENABLEMENT_FILE), "{not json").unwrap();
        assert!(write_choice(dir.path(), "codex", true).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ENABLEMENT_FILE)).unwrap(),
            "{not json"
        );
    }
}
