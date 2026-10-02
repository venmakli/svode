//! Desktop host of agent setup: the device-local adapter directory in the
//! app data and the user's enable choices in the app config, handed to the
//! library when an agent launches. Rules and installation belong to
//! `svode_agents::adapters`.

pub mod commands;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use svode_agents::adapters::{
    AdapterStore, LaunchContext, LaunchUnavailable, RegistryPackageSource,
};
use svode_agents::registry::{AdapterRuntimeRegistry, SystemRuntimeCommandRunner};
use svode_core::agent_adapters::AgentAdapterKind;

use crate::agent_runtime::connections::{LaunchPlanner, PlanFuture};
use crate::error::AppError;
use crate::process::login_env::LoginEnvironment;

const ENABLEMENT_FILE: &str = "agents.json";

/// Clones share one store, package source and choices lock.
#[derive(Clone)]
pub struct AgentSetupState {
    store: Arc<AdapterStore>,
    source: Arc<RegistryPackageSource>,
    config_dir: PathBuf,
    /// Serializes read-modify-write of the enable choices.
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

    fn choice(&self, agent: AgentAdapterKind) -> Option<bool> {
        read_choices(&self.config_dir)
            .unwrap_or_else(|error| {
                tracing::warn!("agent enable choices are unreadable: {error}");
                BTreeMap::new()
            })
            .get(agent.as_str())
            .copied()
    }

    fn set_choice(&self, agent: AgentAdapterKind, enabled: bool) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        write_choice(&self.config_dir, agent.as_str(), enabled)
    }
}

/// Launches in the home directory with the login shell environment, the
/// login shell PATH and the user's enable choice.
impl LaunchPlanner for AgentSetupState {
    fn catalog_agents(&self) -> Vec<String> {
        AgentAdapterKind::ALL
            .into_iter()
            .filter(|agent| AdapterRuntimeRegistry.lists_catalog(*agent))
            .map(|agent| agent.as_str().to_string())
            .collect()
    }

    fn plan<'a>(&'a self, agent: &'a str) -> PlanFuture<'a> {
        Box::pin(async move {
            let Some(kind) = AgentAdapterKind::ALL
                .into_iter()
                .find(|kind| kind.as_str() == agent)
            else {
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
                    self.choice(kind),
                    &context,
                    &SystemRuntimeCommandRunner,
                )
                .await
        })
    }
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
    let mut value = read_file(config_dir)?.unwrap_or_else(|| serde_json::json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| AppError::General(format!("{ENABLEMENT_FILE} must be an object")))?;
    let agents = root
        .entry("agents")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| AppError::General(format!("{ENABLEMENT_FILE} agents must be an object")))?;
    let entry = agents.entry(agent).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry["enabled"] = serde_json::Value::Bool(enabled);
    std::fs::create_dir_all(config_dir)?;
    let staged = tempfile::NamedTempFile::new_in(config_dir)?;
    serde_json::to_writer_pretty(staged.as_file(), &value)?;
    staged.as_file().sync_all()?;
    staged
        .persist(config_dir.join(ENABLEMENT_FILE))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn read_file(config_dir: &Path) -> Result<Option<serde_json::Value>, AppError> {
    match std::fs::read(config_dir.join(ENABLEMENT_FILE)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
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
    #[ignore = "live: downloads the pinned adapters from npm and starts the user's Codex and Claude Code"]
    async fn live_check_starts_initializes_and_closes_the_users_agents() {
        use std::time::Instant;

        use svode_agents::{AgentCheck, AgentRuntime};

        use crate::agent_runtime::connections::AgentConnections;

        let dir = tempfile::tempdir().unwrap();
        let setup = AgentSetupState::new(&dir.path().join("data"), dir.path().join("config"));
        for agent in AgentAdapterKind::ALL {
            let started = Instant::now();
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
            setup.set_choice(agent, true).unwrap();
            println!("{agent:?}: adapter installed in {:?}", started.elapsed());
        }
        let runtime = AgentRuntime::default();
        let connections = AgentConnections::new(runtime.clone(), setup.clone());
        for agent in AgentAdapterKind::ALL {
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
