use serde::Serialize;
use svode_core::agent_adapters::AgentAdapterKind;

use super::{
    AdapterError, AdapterInstallState, AdapterStore, CliVersionRange, CliVersionStatus,
    InstalledAdapter, NodeStatus, PackageSource, adapter_pin, cli_version_range, detect_node,
    evaluate_cli_version,
};
use crate::registry::{
    AdapterDiagnostic, AdapterRuntimeRegistry, AdapterTarget, AgentVerdict, RuntimeCommandRunner,
};

/// What a host shows about an agent without starting it: executable, CLI
/// version against its verified range, sign-in, adapter and its runtime,
/// and whether the agent is enabled. Each fact is a separate outcome; one
/// agent's facts never change another's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetup {
    pub agent: AgentAdapterKind,
    pub enabled: bool,
    pub verdict: AgentVerdict,
    /// Where the vendor explains how to install the CLI; Svode never
    /// installs it.
    pub install_hint: &'static str,
    /// The agent has its own sign-in command a terminal can run (A5).
    pub can_sign_in: bool,
    /// Executable, version and sign-in from the bounded `--version` and
    /// sign-in status commands.
    pub cli: AdapterDiagnostic,
    /// `None` until the agent's range is verified; its version then stays
    /// unknown.
    pub cli_range: Option<CliVersionRange>,
    pub cli_version: CliVersionStatus,
    /// `None` when the agent's ACP entrypoint is its own command.
    pub adapter: Option<AdapterSetup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterSetup {
    pub package: String,
    pub pinned_version: String,
    pub install: AdapterInstallState,
    pub required_node_major: u64,
    pub node: NodeStatus,
}

/// An agent is enabled unless the user disabled it; an agent with an
/// adapter stays disabled while no adapter is installed, since enabling it
/// is installing the adapter.
pub fn agent_enabled(choice: Option<bool>, adapter: Option<&AdapterInstallState>) -> bool {
    choice.unwrap_or(true) && !matches!(adapter, Some(AdapterInstallState::NotInstalled))
}

impl AdapterStore {
    /// `enabled_choice` is the user's last enable or disable choice, which
    /// the host stores.
    pub async fn agent_setup(
        &self,
        agent: AgentAdapterKind,
        enabled_choice: Option<bool>,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
    ) -> AgentSetup {
        let cli = AdapterRuntimeRegistry.diagnose(agent, target, runner).await;
        let cli_range = cli_version_range(agent);
        let cli_version = match cli_range {
            Some(range) => evaluate_cli_version(cli.version.as_deref(), range),
            None => CliVersionStatus::Unknown,
        };
        let adapter = match adapter_pin(agent) {
            Some(pin) => Some(AdapterSetup {
                package: pin.package.to_string(),
                pinned_version: pin.version.to_string(),
                install: self.state(pin),
                required_node_major: pin.node_major,
                node: detect_node(
                    pin.node_major,
                    &target.cwd,
                    target.search_path.as_deref(),
                    runner,
                )
                .await,
            }),
            None => None,
        };
        AgentSetup {
            agent,
            verdict: AdapterRuntimeRegistry.verdict(agent),
            install_hint: agent.install_hint(),
            can_sign_in: AdapterRuntimeRegistry.sign_in_arguments(agent).is_some(),
            enabled: agent_enabled(
                enabled_choice,
                adapter.as_ref().map(|adapter| &adapter.install),
            ),
            cli,
            cli_range,
            cli_version,
            adapter,
        }
    }

    /// Installs or updates the agent's adapter to the current pin. Without
    /// Node.js of the required version nothing is downloaded or written.
    pub async fn install_adapter(
        &self,
        agent: AgentAdapterKind,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
        source: &dyn PackageSource,
    ) -> Result<InstalledAdapter, AdapterError> {
        let pin = adapter_pin(agent).ok_or(AdapterError::NoAdapter)?;
        detect_node(
            pin.node_major,
            &target.cwd,
            target.search_path.as_deref(),
            runner,
        )
        .await
        .require(pin.node_major)?;
        self.install(pin, source).await
    }

    /// What enabling an agent needs before the host records the choice:
    /// for an agent with an adapter and none installed, the install. An
    /// installed other version stays until the explicit update.
    pub async fn prepare_enable(
        &self,
        agent: AgentAdapterKind,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
        source: &dyn PackageSource,
    ) -> Result<(), AdapterError> {
        if let Some(pin) = adapter_pin(agent)
            && self.state(pin) == AdapterInstallState::NotInstalled
        {
            self.install_adapter(agent, target, runner, source).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_agents_stay_disabled_until_their_adapter_is_installed() {
        let installed = AdapterInstallState::Installed {
            version: "1.0.0".into(),
        };
        let stale = AdapterInstallState::NeedsUpdate {
            installed_version: "0.9.0".into(),
        };
        assert!(!agent_enabled(
            None,
            Some(&AdapterInstallState::NotInstalled)
        ));
        assert!(!agent_enabled(
            Some(true),
            Some(&AdapterInstallState::NotInstalled)
        ));
        assert!(agent_enabled(None, Some(&installed)));
        assert!(agent_enabled(Some(true), Some(&stale)));
        assert!(!agent_enabled(Some(false), Some(&installed)));
        // An agent without an adapter is enabled by default.
        assert!(agent_enabled(None, None));
        assert!(!agent_enabled(Some(false), None));
    }
}
