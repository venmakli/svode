use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use svode_core::agent_adapters::{AgentAdapterKind, resolve_space_executable, system_home_dir};

use super::{
    AdapterError, AdapterInstallState, AdapterPin, AdapterStore, CliVersionStatus,
    InstalledAdapter, cli_version_range, detect_node, evaluate_cli_version,
};
use crate::registry::{AcpEntrypoint, AdapterRuntimeRegistry, AdapterTarget, RuntimeCommandRunner};
use crate::runtime::{AcpLaunch, LaunchEnvironment};

/// Why an agent cannot start now (Stage 10 `03` A1). Each is a recoverable
/// outcome of its own; one agent's outcome never changes another's. Sign-in
/// and start failures appear only once the agent runs.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchUnavailable {
    #[error("the agent is disabled")]
    Disabled,
    #[error("{executable} executable was not found")]
    ExecutableMissing { executable: String },
    #[error("the agent is not supported yet")]
    NotSupported,
    #[error("Node.js {required} or newer was not found")]
    NodeMissing { required: u64 },
    #[error("Node.js {version} is older than the required {required}")]
    NodeUnsupported { version: String, required: u64 },
    #[error("Node.js version could not be read: {message}")]
    NodeUnknown { message: String },
    #[error("the adapter is not installed")]
    AdapterNotInstalled,
    #[error("the installed adapter {installed_version} needs an update")]
    AdapterNeedsUpdate { installed_version: String },
    #[error("CLI {version} is older than the supported {minimum}")]
    CliUnsupported { version: String, minimum: String },
}

/// Where and with what a host starts an agent.
#[derive(Debug, Clone)]
pub struct LaunchContext {
    /// `cwd` is the Space whose local override of the executable applies,
    /// otherwise the home directory; `search_path` is the login shell PATH
    /// when the host knows it.
    pub target: AdapterTarget,
    /// Base environment of the agent process; `None` inherits the host's.
    pub environment: Option<LaunchEnvironment>,
    /// Variables of the launch provenance, such as a Routine caller token.
    pub env: BTreeMap<String, String>,
}

impl AdapterStore {
    /// The launch plan of an available agent, or the first reason it is
    /// not available, in the order of A1. `enabled_choice` is the user's
    /// last enable or disable choice, which the host stores. Only bounded
    /// `--version` probes run; nothing is installed and no ACP process
    /// starts.
    pub async fn launch_plan(
        &self,
        agent: AgentAdapterKind,
        enabled_choice: Option<bool>,
        context: &LaunchContext,
        runner: &dyn RuntimeCommandRunner,
    ) -> Result<AcpLaunch, LaunchUnavailable> {
        if enabled_choice == Some(false) {
            return Err(LaunchUnavailable::Disabled);
        }
        let target = &context.target;
        let home = system_home_dir().unwrap_or_else(|| target.cwd.clone());
        let executable =
            resolve_space_executable(agent, &target.cwd, &home, target.search_path.as_deref())
                .ok_or_else(|| LaunchUnavailable::ExecutableMissing {
                    executable: agent.executable().to_string(),
                })?;
        let entrypoint = AdapterRuntimeRegistry
            .acp_entrypoint(agent)
            .ok_or(LaunchUnavailable::NotSupported)?;
        let adapter_run = match entrypoint {
            AcpEntrypoint::Command { .. } => None,
            AcpEntrypoint::Adapter { adapter: pin, .. } => {
                Some(self.adapter_run(pin, target, runner).await?)
            }
        };
        let version = AdapterRuntimeRegistry
            .cli_version(&executable, target, runner)
            .await
            .ok();
        if let Some(range) = cli_version_range(agent)
            && let CliVersionStatus::Unsupported { minimum } =
                evaluate_cli_version(version.as_deref(), range)
        {
            return Err(LaunchUnavailable::CliUnsupported {
                version: version.unwrap_or_default().trim().to_string(),
                minimum,
            });
        }
        let mut launch = AdapterRuntimeRegistry
            .acp_launch(
                agent,
                &executable,
                adapter_run
                    .as_ref()
                    .map(|(node, installed)| (node.as_path(), installed)),
                &home,
            )
            .ok_or(LaunchUnavailable::NotSupported)?;
        launch.environment = context.environment.clone();
        // The description's variables win over the provenance's.
        let mut env = context.env.clone();
        env.append(&mut launch.env);
        launch.env = env;
        Ok(launch)
    }

    /// Node.js of the version the adapter requires and the installed
    /// adapter of the current pin.
    async fn adapter_run(
        &self,
        pin: &AdapterPin,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
    ) -> Result<(PathBuf, InstalledAdapter), LaunchUnavailable> {
        let node = detect_node(
            pin.node_major,
            &target.cwd,
            target.search_path.as_deref(),
            runner,
        )
        .await
        .require(pin.node_major)
        .map_err(|error| match error {
            AdapterError::NodeUnsupported { version, required } => {
                LaunchUnavailable::NodeUnsupported { version, required }
            }
            AdapterError::NodeUnknown { message } => LaunchUnavailable::NodeUnknown { message },
            _ => LaunchUnavailable::NodeMissing {
                required: pin.node_major,
            },
        })?;
        let installed = match self.state(pin) {
            AdapterInstallState::NeedsUpdate { installed_version } => {
                return Err(LaunchUnavailable::AdapterNeedsUpdate { installed_version });
            }
            AdapterInstallState::NotInstalled | AdapterInstallState::Installed { .. } => self
                .installed(pin)
                .ok_or(LaunchUnavailable::AdapterNotInstalled)?,
        };
        Ok((node, installed))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::future::Future;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::pin::Pin;

    use super::*;
    use crate::adapters::adapter_pin;
    use crate::registry::{RuntimeCommandOutput, RuntimeCommandRequest};

    /// Answers `--version` of `node` and of the agent's CLI.
    struct Versions {
        node: &'static str,
        cli: &'static str,
    }

    impl RuntimeCommandRunner for Versions {
        fn run<'a>(
            &'a self,
            request: &'a RuntimeCommandRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RuntimeCommandOutput, String>> + Send + 'a>>
        {
            let stdout = if request.program.ends_with("node") {
                self.node
            } else {
                self.cli
            };
            Box::pin(async move {
                Ok(RuntimeCommandOutput {
                    exit_code: Some(0),
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                })
            })
        }
    }

    fn executable(dir: &Path, name: &str) {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn install(root: &Path, version: &str) {
        let pin = adapter_pin(AgentAdapterKind::Codex).unwrap();
        let dir = root.join("codex").join(version);
        let entry = dir.join("node_modules").join(pin.package).join(pin.entry);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, "").unwrap();
        fs::write(
            dir.join("svode-adapter.json"),
            format!(r#"{{"package":"{}","version":"{version}"}}"#, pin.package),
        )
        .unwrap();
    }

    fn context(bin: &Path) -> LaunchContext {
        LaunchContext {
            target: AdapterTarget {
                cwd: bin.to_path_buf(),
                search_path: Some(OsString::from(bin)),
            },
            environment: Some(LaunchEnvironment::new([(
                OsString::from("XAI_API_KEY"),
                OsString::from("from-profile"),
            )])),
            env: BTreeMap::from([
                ("SVODE_MCP_ROUTINE_CALLER_TOKEN".into(), "token".into()),
                ("CODEX_PATH".into(), "/provenance/codex".into()),
            ]),
        }
    }

    const READY: Versions = Versions {
        node: "v22.0.0",
        cli: "codex-cli 0.159.2",
    };

    #[tokio::test]
    async fn an_available_agent_runs_its_adapter_on_node_with_the_users_cli() {
        let root = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        executable(bin.path(), "codex");
        executable(bin.path(), "node");
        let pin = adapter_pin(AgentAdapterKind::Codex).unwrap();
        install(root.path(), pin.version);
        let store = AdapterStore::new(root.path().to_path_buf());

        let launch = store
            .launch_plan(AgentAdapterKind::Codex, None, &context(bin.path()), &READY)
            .await
            .unwrap();
        assert_eq!(launch.agent, "codex");
        assert_eq!(launch.program, bin.path().join("node"));
        assert!(launch.args[0].ends_with(pin.entry));
        assert_eq!(
            launch.env.get("CODEX_PATH"),
            Some(&bin.path().join("codex").to_string_lossy().into_owned())
        );
        assert_eq!(
            launch
                .env
                .get("SVODE_MCP_ROUTINE_CALLER_TOKEN")
                .map(String::as_str),
            Some("token")
        );
        assert_eq!(
            launch
                .environment
                .as_ref()
                .and_then(|environment| environment.get("XAI_API_KEY")),
            Some(std::ffi::OsStr::new("from-profile"))
        );
        // A newer CLI than the tested one starts with a warning elsewhere.
        let newer = Versions {
            node: "v22.0.0",
            cli: "codex-cli 0.170.0",
        };
        assert!(
            store
                .launch_plan(
                    AgentAdapterKind::Codex,
                    Some(true),
                    &context(bin.path()),
                    &newer
                )
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn each_missing_prerequisite_is_its_own_outcome_and_starts_nothing() {
        let root = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        executable(bin.path(), "codex");
        let store = AdapterStore::new(root.path().to_path_buf());
        let plan = |choice, runner| {
            let store = &store;
            let context = context(bin.path());
            async move {
                store
                    .launch_plan(AgentAdapterKind::Codex, choice, &context, runner)
                    .await
                    .unwrap_err()
            }
        };

        assert_eq!(plan(Some(false), &READY).await, LaunchUnavailable::Disabled);
        assert_eq!(
            plan(None, &READY).await,
            LaunchUnavailable::NodeMissing { required: 20 }
        );
        executable(bin.path(), "node");
        let old_node = Versions {
            node: "v18.0.0",
            cli: "codex-cli 0.159.2",
        };
        assert_eq!(
            plan(None, &old_node).await,
            LaunchUnavailable::NodeUnsupported {
                version: "v18.0.0".into(),
                required: 20
            }
        );
        assert_eq!(
            plan(None, &READY).await,
            LaunchUnavailable::AdapterNotInstalled
        );
        install(root.path(), "0.0.1");
        assert_eq!(
            plan(None, &READY).await,
            LaunchUnavailable::AdapterNeedsUpdate {
                installed_version: "0.0.1".into()
            }
        );
        install(
            root.path(),
            adapter_pin(AgentAdapterKind::Codex).unwrap().version,
        );
        fs::remove_dir_all(root.path().join("codex/0.0.1")).unwrap();
        let old_cli = Versions {
            node: "v22.0.0",
            cli: "codex-cli 0.150.0\n",
        };
        assert_eq!(
            plan(None, &old_cli).await,
            LaunchUnavailable::CliUnsupported {
                version: "codex-cli 0.150.0".into(),
                minimum: "0.159.1".into()
            }
        );
        assert_eq!(
            serde_json::to_value(LaunchUnavailable::AdapterNeedsUpdate {
                installed_version: "0.0.1".into()
            })
            .unwrap(),
            serde_json::json!({ "code": "adapter_needs_update", "installedVersion": "0.0.1" })
        );
    }

    #[tokio::test]
    async fn an_agent_with_its_own_command_needs_no_node_or_adapter() {
        let root = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        executable(bin.path(), "opencode");
        let store = AdapterStore::new(root.path().to_path_buf());
        let opencode = |cli| Versions { node: "", cli };

        let launch = store
            .launch_plan(
                AgentAdapterKind::Opencode,
                None,
                &context(bin.path()),
                &opencode("2.0.22"),
            )
            .await
            .unwrap();
        assert_eq!(launch.agent, "opencode");
        assert_eq!(launch.program, bin.path().join("opencode"));
        assert_eq!(launch.args, ["acp"]);
        // Only the provenance variables are added.
        assert_eq!(
            launch.env.keys().collect::<Vec<_>>(),
            ["CODEX_PATH", "SVODE_MCP_ROUTINE_CALLER_TOKEN"]
        );
        assert_eq!(
            store
                .launch_plan(
                    AgentAdapterKind::Opencode,
                    None,
                    &context(bin.path()),
                    &opencode("1.18.31"),
                )
                .await
                .unwrap_err(),
            LaunchUnavailable::CliUnsupported {
                version: "1.18.31".into(),
                minimum: "2.0.22".into()
            }
        );
        // A described agent that is not found stays missing, an undescribed
        // one is not supported.
        executable(bin.path(), "hermes");
        assert_eq!(
            store
                .launch_plan(
                    AgentAdapterKind::Hermes,
                    None,
                    &context(bin.path()),
                    &opencode("0.18.2"),
                )
                .await
                .unwrap_err(),
            LaunchUnavailable::NotSupported
        );
    }
}
