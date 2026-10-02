//! Adapters of agents whose ACP entrypoint is an npm package: the pin a
//! Svode release fixes with its whole dependency tree, the Node.js runtime
//! that executes it, installation into a host-chosen device-local
//! directory, the verified CLI version range and the setup facts a host
//! shows for an agent, and the launch plan of an available agent. Nothing
//! here starts an ACP process.

mod install;
mod launch;
mod node;
mod setup;
mod source;

use serde::Serialize;
use svode_core::agent_adapters::AgentAdapterKind;

pub use install::{AdapterInstallState, AdapterStore, InstalledAdapter};
pub use launch::{LaunchContext, LaunchUnavailable};
pub use node::{NodeStatus, detect_node};
pub use setup::{AdapterSetup, AgentSetup, agent_enabled};
pub use source::{PackageSource, RegistryPackageSource};

/// An adapter version fixed by the Svode release. `manifest` is the full
/// resolved tree from the package's npm lockfile (`npm install
/// --package-lock-only --ignore-scripts`): every package with its tarball
/// URL and sha512 integrity; optional packages are the agents' platform
/// binaries and are never installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdapterPin {
    pub agent: AgentAdapterKind,
    pub package: &'static str,
    pub version: &'static str,
    /// The adapter's bin script, relative to its package directory.
    pub entry: &'static str,
    /// Lowest Node.js major the adapter supports.
    pub node_major: u64,
    pub manifest: &'static str,
}

const CLAUDE_AGENT_ACP: AdapterPin = AdapterPin {
    agent: AgentAdapterKind::ClaudeCode,
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.85.0",
    entry: "dist/index.js",
    node_major: 22,
    manifest: include_str!("pins/claude-agent-acp.json"),
};

const CODEX_ACP: AdapterPin = AdapterPin {
    agent: AgentAdapterKind::Codex,
    package: "@agentclientprotocol/codex-acp",
    version: "2.1.1",
    entry: "dist/index.js",
    node_major: 20,
    manifest: include_str!("pins/codex-acp.json"),
};

/// The adapter pin of an agent, or `None` when its ACP entrypoint is its
/// own command.
pub fn adapter_pin(agent: AgentAdapterKind) -> Option<&'static AdapterPin> {
    match agent {
        AgentAdapterKind::ClaudeCode => Some(&CLAUDE_AGENT_ACP),
        AgentAdapterKind::Codex => Some(&CODEX_ACP),
    }
}

/// CLI versions verified with the agent's ACP entrypoint: the lowest one it
/// supports and the newest one checked live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliVersionRange {
    pub minimum: &'static str,
    pub tested_up_to: &'static str,
}

/// Claude Code: the CLI the pinned Claude Agent SDK bundles, newer CLIs
/// being the verified direction. Codex: the `@openai/codex` range the
/// pinned `codex-acp` declares.
pub fn cli_version_range(agent: AgentAdapterKind) -> CliVersionRange {
    match agent {
        AgentAdapterKind::ClaudeCode => CliVersionRange {
            minimum: "2.1.286",
            tested_up_to: "2.1.287",
        },
        AgentAdapterKind::Codex => CliVersionRange {
            minimum: "0.159.1",
            tested_up_to: "0.159.3",
        },
    }
}

/// Where a CLI version stands against its verified range. Terminal work
/// never depends on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CliVersionStatus {
    Supported,
    /// Chat and ACP launch are unavailable until the CLI is updated.
    Unsupported {
        minimum: String,
    },
    /// Launch is allowed with a one-line warning.
    Untested {
        tested_up_to: String,
    },
    /// The version could not be read; launch is allowed with a warning.
    Unknown,
}

pub fn evaluate_cli_version(version: Option<&str>, range: CliVersionRange) -> CliVersionStatus {
    let Some(version) = version.and_then(parse_version) else {
        return CliVersionStatus::Unknown;
    };
    let minimum = parse_version(range.minimum).expect("minimum is a version");
    let tested = parse_version(range.tested_up_to).expect("tested version is a version");
    if version < minimum {
        CliVersionStatus::Unsupported {
            minimum: range.minimum.to_string(),
        }
    } else if version > tested {
        CliVersionStatus::Untested {
            tested_up_to: range.tested_up_to.to_string(),
        }
    } else {
        CliVersionStatus::Supported
    }
}

/// The first `major.minor.patch` in a version output such as
/// `2.1.287 (Claude Code)`, `codex-cli 0.159.3` or `v22.23.1`.
pub(crate) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|token| {
            let mut parts = token.split('.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let patch = parts.next()?.parse().ok()?;
            Some((major, minor, patch))
        })
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AdapterError {
    /// The agent's ACP entrypoint is its own command.
    #[error("the agent has no adapter to install")]
    NoAdapter,
    #[error("Node.js {required} or newer was not found")]
    NodeMissing { required: u64 },
    #[error("Node.js {version} is older than the required {required}")]
    NodeUnsupported { version: String, required: u64 },
    #[error("Node.js version could not be read: {message}")]
    NodeUnknown { message: String },
    #[error("downloading {package} failed: {message}")]
    Download { package: String, message: String },
    #[error("{package} does not match its pinned integrity")]
    Integrity { package: String },
    #[error("{package} could not be unpacked: {message}")]
    Package { package: String, message: String },
    #[error("adapter files could not be written: {message}")]
    Io { message: String },
}

impl From<std::io::Error> for AdapterError {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_from_cli_outputs() {
        assert_eq!(parse_version("2.1.287 (Claude Code)"), Some((2, 1, 287)));
        assert_eq!(parse_version("codex-cli 0.159.3\n"), Some((0, 159, 3)));
        assert_eq!(parse_version("v22.23.1"), Some((22, 23, 1)));
        assert_eq!(parse_version("unknown"), None);
    }

    #[test]
    fn cli_below_minimum_is_unsupported_and_newer_than_tested_warns() {
        let range = CliVersionRange {
            minimum: "0.159.1",
            tested_up_to: "0.159.3",
        };
        assert_eq!(
            evaluate_cli_version(Some("codex-cli 0.158.9"), range),
            CliVersionStatus::Unsupported {
                minimum: "0.159.1".into()
            }
        );
        assert_eq!(
            evaluate_cli_version(Some("codex-cli 0.159.1"), range),
            CliVersionStatus::Supported
        );
        assert_eq!(
            evaluate_cli_version(Some("codex-cli 0.159.3"), range),
            CliVersionStatus::Supported
        );
        assert_eq!(
            evaluate_cli_version(Some("codex-cli 0.160.0"), range),
            CliVersionStatus::Untested {
                tested_up_to: "0.159.3".into()
            }
        );
        assert_eq!(
            evaluate_cli_version(Some("dev build"), range),
            CliVersionStatus::Unknown
        );
        assert_eq!(evaluate_cli_version(None, range), CliVersionStatus::Unknown);
    }

    #[test]
    fn setup_values_serialize_in_the_platform_shape() {
        assert_eq!(
            serde_json::to_value(CliVersionStatus::Untested {
                tested_up_to: "0.159.3".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "untested", "testedUpTo": "0.159.3" })
        );
        assert_eq!(
            serde_json::to_value(AdapterInstallState::NeedsUpdate {
                installed_version: "2.1.0".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "needs_update", "installedVersion": "2.1.0" })
        );
        assert_eq!(
            serde_json::to_value(AdapterError::Integrity {
                package: "zod".into()
            })
            .unwrap(),
            serde_json::json!({ "code": "integrity", "package": "zod" })
        );
    }

    #[test]
    fn every_agent_range_is_ordered() {
        for agent in AgentAdapterKind::ALL {
            let range = cli_version_range(agent);
            assert!(parse_version(range.minimum) <= parse_version(range.tested_up_to));
        }
    }
}
