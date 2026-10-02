use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{AdapterError, parse_version};
use crate::registry::{RuntimeCommandRequest, RuntimeCommandRunner};

/// The Node.js an adapter runs on: the one on the user's PATH, never a
/// runtime shipped by Svode, Bun or Deno.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum NodeStatus {
    Ready { path: String, version: String },
    Missing,
    Unsupported { path: String, version: String },
    Unknown { path: String, message: String },
}

impl NodeStatus {
    /// The runtime an install or launch may use, or the outcome that stops
    /// it before anything starts.
    pub fn require(&self, required: u64) -> Result<PathBuf, AdapterError> {
        match self {
            Self::Ready { path, .. } => Ok(PathBuf::from(path)),
            Self::Missing => Err(AdapterError::NodeMissing { required }),
            Self::Unsupported { version, .. } => Err(AdapterError::NodeUnsupported {
                version: version.clone(),
                required,
            }),
            Self::Unknown { message, .. } => Err(AdapterError::NodeUnknown {
                message: message.clone(),
            }),
        }
    }
}

/// Finds `node` on `search_path` (the login shell PATH when the host knows
/// it) and checks its major version against `required`.
pub async fn detect_node(
    required: u64,
    cwd: &Path,
    search_path: Option<&OsStr>,
    runner: &dyn RuntimeCommandRunner,
) -> NodeStatus {
    let found = match search_path {
        Some(paths) => which::which_in("node", Some(paths), cwd),
        None => which::which("node"),
    };
    let Ok(path) = found else {
        return NodeStatus::Missing;
    };
    let display = path.to_string_lossy().into_owned();
    let output = runner
        .run(&RuntimeCommandRequest {
            program: path,
            arguments: vec!["--version".into()],
            cwd: cwd.to_path_buf(),
            search_path: search_path.map(ToOwned::to_owned),
        })
        .await;
    let version = match output {
        Ok(output) if output.exit_code == Some(0) => output.stdout.trim().to_string(),
        Ok(output) => {
            return NodeStatus::Unknown {
                path: display,
                message: if output.stderr.is_empty() {
                    "node --version failed".into()
                } else {
                    output.stderr
                },
            };
        }
        Err(message) => {
            return NodeStatus::Unknown {
                path: display,
                message,
            };
        }
    };
    match parse_version(&version) {
        Some((major, _, _)) if major >= required => NodeStatus::Ready {
            path: display,
            version,
        },
        Some(_) => NodeStatus::Unsupported {
            path: display,
            version,
        },
        None => NodeStatus::Unknown {
            path: display,
            message: format!("unrecognized version {version}"),
        },
    }
}
