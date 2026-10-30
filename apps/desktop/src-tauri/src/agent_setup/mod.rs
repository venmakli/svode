//! Desktop host of agent setup: the device-local adapter directory in the
//! app data, and the user's enable choices and custom ACP agents with what
//! they declared in the app config, handed to the library when an agent
//! launches. Rules and installation belong to `svode_agents::adapters` and
//! `svode_agents::custom`.

pub mod commands;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use svode_agents::adapters::{
    AdapterStore, ChatOffer, LaunchContext, LaunchUnavailable, RegistryPackageSource, adapter_pin,
    agent_enabled,
};
use svode_agents::custom::{
    CustomAgent, CustomAgentDefinition, CustomAgentError, custom_draft_launch_plan,
    custom_launch_plan, new_custom_agent_id,
};
use svode_agents::registry::{
    AdapterRuntimeRegistry, AdapterTarget, AgentVerdict, CatalogSource, SystemRuntimeCommandRunner,
};
use svode_agents::{AcpLaunch, AgentCheck, AgentInfo};
use svode_core::agent_adapters::{AgentAdapterKind, CustomAgentId, resolve_executable_path};

use crate::agent_runtime::connections::{KeepFuture, LaunchPlanner, PlanFuture};
use crate::error::AppError;
use crate::process::login_env::LoginEnvironment;
use crate::process::path_env::ProcessPath;

const ENABLEMENT_FILE: &str = "agents.json";
const CUSTOM_AGENTS: &str = "customAgents";
const DECLARED: &str = "declared";
const LAST_CHAT_AGENT: &str = "lastChatAgent";

/// Clones share one store, package source, choices lock and draft checks.
#[derive(Clone)]
pub struct AgentSetupState {
    store: Arc<AdapterStore>,
    source: Arc<RegistryPackageSource>,
    config_dir: PathBuf,
    /// Serializes read-modify-write of `agents.json`.
    choices: Arc<Mutex<()>>,
    /// The last passed check of a form before it was saved, by the custom
    /// agent it edits; `None` adds one.
    draft_checks: Arc<Mutex<HashMap<Option<CustomAgentId>, DraftCheck>>>,
}

struct DraftCheck {
    definition: CustomAgentDefinition,
    declared: AgentInfo,
}

impl AgentSetupState {
    pub fn new(data_dir: &Path, config_dir: PathBuf) -> Self {
        Self {
            store: Arc::new(AdapterStore::new(data_dir.join("agent-adapters"))),
            source: Arc::new(RegistryPackageSource::new()),
            config_dir,
            choices: Arc::new(Mutex::new(())),
            draft_checks: Arc::default(),
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
    /// Svode reads (Stage 10 `07` N1): the enabled ones.
    pub(crate) async fn native_catalog_agents(&self) -> Vec<AgentAdapterKind> {
        self.enabled_agents()
            .await
            .into_iter()
            .filter(|agent| {
                AdapterRuntimeRegistry
                    .catalog_sources(*agent)
                    .iter()
                    .any(|source| matches!(source, CatalogSource::Native(_)))
            })
            .collect()
    }

    /// The built-in agents enabled in Providers (`03` A1): found on the
    /// device and not disabled by the user.
    pub(crate) async fn enabled_agents(&self) -> Vec<AgentAdapterKind> {
        let Ok(target) = commands::target().await else {
            return Vec::new();
        };
        AgentAdapterKind::ALL
            .into_iter()
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
        self.custom_entries()
            .into_iter()
            .map(|(agent, _)| agent)
            .collect()
    }

    /// Each custom agent with what it declared for its launch definition.
    fn custom_entries(&self) -> Vec<(CustomAgent, Option<AgentInfo>)> {
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

    /// Adds the agent with what the form's passed check of this launch
    /// definition declared when the form shows it (`checked`), else with
    /// nothing declared.
    fn add_custom_agent(
        &self,
        definition: CustomAgentDefinition,
        checked: bool,
    ) -> Result<(CustomAgent, Option<AgentInfo>), AppError> {
        let definition = definition.normalized()?;
        let declared = self.take_draft_check(None, &definition, checked);
        let _guard = self.choices.lock().unwrap();
        let agent = CustomAgent {
            id: self.next_custom_id(&definition.name),
            definition,
        };
        let entry = custom_entry(&agent, declared.as_ref())?;
        update_file(&self.config_dir, |root| {
            custom_entries(root)?.push(entry);
            Ok(())
        })?;
        Ok((agent, declared))
    }

    /// Changes everything but the id, so the agent's sessions keep theirs.
    /// What the agent declared is the form's passed check of the new launch
    /// definition when the form shows it (`checked`), what it declared
    /// before when only the name changed, else nothing.
    fn update_custom_agent(
        &self,
        id: CustomAgentId,
        definition: CustomAgentDefinition,
        checked: bool,
    ) -> Result<(CustomAgent, Option<AgentInfo>), AppError> {
        let agent = CustomAgent {
            id,
            definition: definition.normalized()?,
        };
        let checked = self.take_draft_check(Some(&agent.id), &agent.definition, checked);
        let _guard = self.choices.lock().unwrap();
        update_file(&self.config_dir, |root| {
            let entries = custom_entries(root)?;
            let index = entries
                .iter()
                .position(|known| entry_id(known) == Some(agent.id.agent_id().as_str()))
                .ok_or_else(|| CustomAgentError::NotFound {
                    agent: agent.id.agent_id().to_string(),
                })?;
            let declared = checked.or_else(|| {
                let (known, declared) = read_custom_entry(&entries[index])?;
                known
                    .definition
                    .launches_as(&agent.definition)
                    .then_some(declared)
                    .flatten()
            });
            entries[index] = custom_entry(&agent, declared.as_ref())?;
            Ok((agent, declared))
        })
    }

    /// Forgets the agent and its enable choice; its sessions stay with the
    /// agent itself.
    fn remove_custom_agent(&self, id: &CustomAgentId) -> Result<(), AppError> {
        self.draft_checks.lock().unwrap().remove(&Some(id.clone()));
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

    /// The form of `agent` (`None` adds one) checked `definition` before it
    /// was saved; only the last check of a form counts.
    fn remember_draft_check(
        &self,
        agent: Option<CustomAgentId>,
        definition: CustomAgentDefinition,
        check: &AgentCheck,
    ) {
        let mut checks = self.draft_checks.lock().unwrap();
        match check {
            AgentCheck::Ready { agent: declared } => {
                checks.insert(
                    agent,
                    DraftCheck {
                        definition,
                        declared: declared.clone(),
                    },
                );
            }
            _ => {
                checks.remove(&agent);
            }
        }
    }

    /// What the form of `agent` declared in its passed check, when the form
    /// shows it (`checked`) and it checked the launch definition being
    /// saved; a save uses the check up either way, so a cancelled form's
    /// check reaches no later one.
    fn take_draft_check(
        &self,
        agent: Option<&CustomAgentId>,
        definition: &CustomAgentDefinition,
        checked: bool,
    ) -> Option<AgentInfo> {
        let check = self.draft_checks.lock().unwrap().remove(&agent.cloned())?;
        (checked && check.definition.launches_as(definition)).then_some(check.declared)
    }

    /// Keeps what the agent declared unless its launch definition changed
    /// meanwhile; an unchanged declaration is not written again.
    fn keep_custom_declared(
        &self,
        agent: &CustomAgent,
        declared: &AgentInfo,
    ) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        let changed = read_custom_agents(&self.config_dir)?
            .into_iter()
            .any(|(known, kept)| {
                known.id == agent.id
                    && known.definition.launches_as(&agent.definition)
                    && kept.as_ref() != Some(declared)
            });
        if !changed {
            return Ok(());
        }
        let id = agent.id.agent_id().as_str();
        update_file(&self.config_dir, |root| {
            let entry = custom_entries(root)?
                .iter_mut()
                .find(|known| entry_id(known) == Some(id))
                .and_then(serde_json::Value::as_object_mut);
            if let Some(entry) = entry {
                entry.insert(DECLARED.into(), serde_json::to_value(declared)?);
            }
            Ok(())
        })
    }

    async fn custom_context(&self, command: &str) -> Result<LaunchContext, LaunchUnavailable> {
        let target =
            commands::target()
                .await
                .map_err(|_| LaunchUnavailable::ExecutableMissing {
                    executable: command.to_string(),
                })?;
        Ok(LaunchContext {
            target,
            environment: LoginEnvironment::session().get().await,
            env: BTreeMap::new(),
        })
    }

    async fn plan_custom(
        &self,
        agent: &CustomAgent,
        enabled_choice: Option<bool>,
    ) -> Result<AcpLaunch, LaunchUnavailable> {
        let context = self.custom_context(&agent.definition.command).await?;
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

    fn plan_draft(&self, definition: CustomAgentDefinition) -> PlanFuture<'_> {
        Box::pin(async move {
            let context = self.custom_context(&definition.command).await?;
            custom_draft_launch_plan(&definition, &context)
        })
    }

    /// What the custom agents declared for their launch definitions.
    fn declarations(&self) -> Vec<(String, AgentInfo)> {
        self.custom_entries()
            .into_iter()
            .filter_map(|(agent, declared)| {
                Some((agent.id.agent_id().as_str().to_string(), declared?))
            })
            .collect()
    }

    /// A custom agent's declaration is kept with it while `launch` is its
    /// launch plan; an `initialize` of a replaced definition describes
    /// another process.
    fn keep_declared<'a>(&'a self, launch: &'a AcpLaunch, info: &'a AgentInfo) -> KeepFuture<'a> {
        Box::pin(async move {
            let Ok(id) = CustomAgentId::parse(&launch.agent) else {
                return;
            };
            let Ok(agent) = self.custom_agent(&id) else {
                return;
            };
            if self.plan_custom(&agent, None).await.as_ref() != Ok(launch) {
                return;
            }
            if let Err(error) = self.keep_custom_declared(&agent, info) {
                tracing::warn!("what {} declared was not kept: {error}", launch.agent);
            }
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

/// `customAgents`: `[{ "id", "name", "command", "args", "env", "declared"? }]`
/// in the order the user added them; `declared` is what the agent declared
/// in its last `initialize` with this command, arguments and variables.
/// Entries this build cannot read are skipped and kept on write; an entry
/// without a readable `declared` declared nothing known.
fn read_custom_agents(
    config_dir: &Path,
) -> Result<Vec<(CustomAgent, Option<AgentInfo>)>, AppError> {
    let Some(value) = read_file(config_dir)? else {
        return Ok(Vec::new());
    };
    Ok(value
        .get(CUSTOM_AGENTS)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(read_custom_entry)
        .collect())
}

fn read_custom_entry(entry: &serde_json::Value) -> Option<(CustomAgent, Option<AgentInfo>)> {
    let agent = serde_json::from_value(entry.clone()).ok()?;
    let declared = entry
        .get(DECLARED)
        .and_then(|declared| serde_json::from_value(declared.clone()).ok());
    Some((agent, declared))
}

fn custom_entry(
    agent: &CustomAgent,
    declared: Option<&AgentInfo>,
) -> Result<serde_json::Value, AppError> {
    let mut entry = serde_json::to_value(agent)?;
    if let Some(declared) = declared {
        entry[DECLARED] = serde_json::to_value(declared)?;
    }
    Ok(entry)
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

        let (first, _) = setup
            .add_custom_agent(definition(" Hermes "), false)
            .unwrap();
        let (second, _) = setup.add_custom_agent(definition("Hermes"), false).unwrap();
        assert_eq!(first.id.agent_id().as_str(), "custom-hermes");
        assert_eq!(first.definition.name, "Hermes");
        assert_eq!(second.id.agent_id().as_str(), "custom-hermes-2");
        assert!(matches!(
            setup.add_custom_agent(
                CustomAgentDefinition {
                    command: " ".into(),
                    ..definition("Empty")
                },
                false
            ),
            Err(AppError::CustomAgent(CustomAgentError::CommandMissing))
        ));

        let (renamed, _) = setup
            .update_custom_agent(
                first.id.clone(),
                CustomAgentDefinition {
                    name: "Hermes ACP".into(),
                    ..definition("ignored")
                },
                false,
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
            setup.update_custom_agent(first.id.clone(), definition("Gone"), false),
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
        let (on, _) = setup.add_custom_agent(definition("On"), false).unwrap();
        let (off, _) = setup.add_custom_agent(definition("Off"), false).unwrap();
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
                "kimi-code",
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
        let draft_check = connections.check_draft(draft.clone()).await;
        println!("draft check: {draft_check:?} in {:?}", started.elapsed());
        assert!(matches!(draft_check, AgentCheck::Ready { .. }));

        let (agent, _) = setup.add_custom_agent(draft, false).unwrap();
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
        assert!(connections.raise_catalog_agent(&id).await.unwrap());
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

    fn declared(name: &str, list_sessions: bool) -> AgentInfo {
        AgentInfo {
            name: Some(name.into()),
            version: Some("0.0.1".into()),
            capabilities: svode_agents::AgentCapabilities {
                list_sessions,
                ..Default::default()
            },
        }
    }

    fn ready(info: &AgentInfo) -> AgentCheck {
        AgentCheck::Ready {
            agent: info.clone(),
        }
    }

    fn kept(dir: &Path, agent: &CustomAgentId) -> Option<AgentInfo> {
        read_custom_agents(dir)
            .unwrap()
            .into_iter()
            .find(|(known, _)| &known.id == agent)
            .and_then(|(_, declared)| declared)
    }

    #[test]
    fn what_a_custom_agent_declared_follows_its_launch_definition() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(ENABLEMENT_FILE),
            r#"{"customAgents":[{"id":"custom-old","name":"Old","command":"old","args":[],"env":{}}]}"#,
        )
        .unwrap();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        let old = CustomAgentId::parse("custom-old").unwrap();
        assert_eq!(
            kept(dir.path(), &old),
            None,
            "a record without it is unknown"
        );
        let mock = declared("qa-acp-mock", false);

        // The form's passed check goes with the agent it adds.
        setup.remember_draft_check(None, definition("Mock"), &ready(&mock));
        let (agent, added) = setup.add_custom_agent(definition("Mock"), true).unwrap();
        assert_eq!(added, Some(mock.clone()));
        let id = agent.id.clone();
        let restarted = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        assert_eq!(
            restarted.declarations(),
            [(id.agent_id().to_string(), mock.clone())],
            "a new read of agents.json knows it"
        );

        // A new name keeps it; a new command drops it.
        let renamed = CustomAgentDefinition {
            name: "Mock renamed".into(),
            ..definition("ignored")
        };
        assert_eq!(
            setup
                .update_custom_agent(id.clone(), renamed.clone(), false)
                .unwrap()
                .1,
            Some(mock.clone())
        );
        let moved = CustomAgentDefinition {
            command: "qa-missing-agent".into(),
            ..renamed.clone()
        };
        assert_eq!(
            setup
                .update_custom_agent(id.clone(), moved, false)
                .unwrap()
                .1,
            None
        );
        assert_eq!(kept(dir.path(), &id), None);

        // The form's check of the new definition goes with the save.
        setup.remember_draft_check(Some(id.clone()), renamed.clone(), &ready(&mock));
        assert_eq!(
            setup
                .update_custom_agent(id.clone(), renamed.clone(), true)
                .unwrap()
                .1,
            Some(mock.clone())
        );

        // A check of another definition changes nothing until it is saved,
        // and a save of a different definition does not take it.
        let other = declared("other", true);
        let elsewhere = CustomAgentDefinition {
            command: "other-agent".into(),
            ..renamed.clone()
        };
        setup.remember_draft_check(Some(id.clone()), elsewhere.clone(), &ready(&other));
        assert_eq!(kept(dir.path(), &id), Some(mock.clone()));
        assert_eq!(
            setup
                .update_custom_agent(id.clone(), renamed.clone(), false)
                .unwrap()
                .1,
            Some(mock.clone())
        );
        assert_eq!(
            setup
                .update_custom_agent(id.clone(), elsewhere.clone(), true)
                .unwrap()
                .1,
            None,
            "the check was used up by the earlier save"
        );

        // A check of an added agent that was cancelled reaches no later
        // form: neither one without a check of the same definition, nor one
        // whose own check is of another command. Only the last check of a
        // form counts.
        setup.remember_draft_check(None, definition("Mock"), &ready(&mock));
        let (unchecked, unchecked_declared) =
            setup.add_custom_agent(definition("Mock"), false).unwrap();
        assert_eq!(unchecked_declared, None);
        assert_eq!(kept(dir.path(), &unchecked.id), None);
        assert_eq!(
            setup.add_custom_agent(definition("Mock"), true).unwrap().1,
            None,
            "the cancelled check was used up"
        );
        setup.remember_draft_check(None, definition("Mock"), &ready(&mock));
        let (next, next_declared) = setup
            .add_custom_agent(
                CustomAgentDefinition {
                    command: "qa-other".into(),
                    ..definition("Mock")
                },
                true,
            )
            .unwrap();
        assert_eq!(next_declared, None);
        setup.remember_draft_check(None, definition("Third"), &ready(&mock));
        setup.remember_draft_check(
            None,
            definition("Third"),
            &AgentCheck::FailedToStart {
                message: "exited".into(),
            },
        );
        assert_eq!(
            setup.add_custom_agent(definition("Third"), true).unwrap().1,
            None
        );

        // What an agent declares is kept only for its current definition.
        setup.keep_custom_declared(&next, &other).unwrap();
        assert_eq!(kept(dir.path(), &next.id), Some(other.clone()));
        setup.keep_custom_declared(&agent, &other).unwrap();
        assert_eq!(
            kept(dir.path(), &id),
            None,
            "an initialize of a replaced definition describes another process"
        );

        setup.remove_custom_agent(&next.id).unwrap();
        assert!(
            setup
                .declarations()
                .iter()
                .all(|(known, _)| known != next.id.agent_id().as_str())
        );
    }

    /// A `/bin/sh` ACP agent that declares a list unless `$SVODE_LIST` is
    /// `none`, as a custom agent's definition.
    #[cfg(unix)]
    fn scripted_definition(name: &str, list: &str) -> CustomAgentDefinition {
        const SCRIPT: &str = r#"while IFS= read -r line; do
  id=${line#'{"id":'}; id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*) caps='{"sessionCapabilities":{"list":{}}}'; [ "$SVODE_LIST" = none ] && caps='{}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":%s,"agentInfo":{"name":"scripted","version":"1.0.0"}}}\n' "$id" "$caps";;
  esac
done"#;
        CustomAgentDefinition {
            name: name.into(),
            command: "/bin/sh".into(),
            args: vec!["-c".into(), SCRIPT.into()],
            env: BTreeMap::from([("SVODE_LIST".into(), list.into())]),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn what_a_custom_agent_declared_outlives_a_restart_without_starting_it() {
        use svode_agents::AgentRuntime;

        use crate::agent_runtime::connections::AgentConnections;

        let dir = tempfile::tempdir().unwrap();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        let (agent, unknown) = setup
            .add_custom_agent(scripted_definition("Plain", "none"), false)
            .unwrap();
        assert_eq!(unknown, None, "added without a check");
        let id = agent.id.agent_id().as_str().to_string();
        let runtime = AgentRuntime::default();
        let connections = AgentConnections::new(runtime.clone(), setup.clone());

        // A draft check of another definition is no saved agent's.
        let AgentCheck::Ready { agent: lister } = connections
            .check_draft(scripted_definition("Plain", "ok"))
            .await
        else {
            panic!("the draft starts");
        };
        assert!(lister.capabilities.list_sessions);
        assert_eq!(runtime.declared(&id), None);
        assert!(setup.declarations().is_empty());

        // The first connection of the agent, such as a new session draft,
        // keeps what it declared.
        let draft = connections.hold_draft("main", &id, dir.path()).await;
        let AgentCheck::Ready { agent: plain } = draft.check else {
            panic!("the agent starts: {:?}", draft.check);
        };
        assert!(!plain.capabilities.list_sessions);
        assert_eq!(setup.declarations(), [(id.clone(), plain.clone())]);
        connections.release_draft(draft.hold.unwrap());
        runtime.shutdown().await;

        // After a restart the row and the catalogue know it before the
        // agent starts: an open collection does not start it.
        let runtime = AgentRuntime::default();
        let setup = AgentSetupState::new(dir.path(), dir.path().to_path_buf());
        let connections = AgentConnections::new(runtime.clone(), setup.clone());
        assert_eq!(runtime.declared(&id), Some(plain.clone()));
        connections.hold_catalog("main");
        assert!(!connections.held_catalog_agents().contains(&id));

        // The user's check keeps a changed declaration.
        let edited = scripted_definition("Plain", "ok");
        setup
            .update_custom_agent(agent.id.clone(), edited, false)
            .unwrap();
        runtime.restore_declared(&id, None);
        assert!(matches!(
            connections.check(&id).await,
            AgentCheck::Ready { .. }
        ));
        assert_eq!(
            setup
                .declarations()
                .into_iter()
                .map(|(_, info)| info.capabilities.list_sessions)
                .collect::<Vec<_>>(),
            [true]
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
