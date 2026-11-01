//! Runtime plane of the agent adapter registry: version/auth diagnostics,
//! ACP entrypoint descriptions with their recorded evidence, and the first
//! prompt of a Routine launch. Model, reasoning, mode and the other values
//! of an agent come from what it declares in its session, not from lists
//! here (Stage 11 `03`). The identity plane (adapter ids, source policies,
//! executable resolution) stays in `svode_core::agent_adapters`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::adapters::{AdapterPin, InstalledAdapter, adapter_pin};
use crate::drafts::{DraftSession, DraftSessionEvidence};
use crate::process;
use crate::runtime::AcpLaunch;
use svode_core::agent_adapters::{AgentAdapterKind, resolve_space_executable, system_home_dir};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DIAGNOSTIC_OUTPUT_BYTES: usize = 16 * 1024;
/// Diagnostic code of an agent found without a sign-in status command.
const AUTH_STATUS_UNAVAILABLE: &str = "auth_status_unavailable";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterDiagnosticStatus {
    Ready,
    Missing,
    Unauthenticated,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDiagnostic {
    pub adapter: AgentAdapterKind,
    pub status: AdapterDiagnosticStatus,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub authenticated: Option<bool>,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterTarget {
    pub cwd: PathBuf,
    /// PATH for executable lookup and diagnostic commands when the host knows
    /// a better one than the process PATH (a GUI app's login shell PATH).
    pub search_path: Option<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCommandRequest {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
    pub search_path: Option<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCommandOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub trait RuntimeCommandRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        request: &'a RuntimeCommandRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RuntimeCommandOutput, String>> + Send + 'a>>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRuntimeCommandRunner;

impl RuntimeCommandRunner for SystemRuntimeCommandRunner {
    fn run<'a>(
        &'a self,
        request: &'a RuntimeCommandRequest,
    ) -> Pin<Box<dyn Future<Output = Result<RuntimeCommandOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&request.program);
            // npm/bun/volta installs are `#!/usr/bin/env node` scripts.
            if let Some(path) = &request.search_path {
                command.env("PATH", path);
            }
            command
                .args(&request.arguments)
                .current_dir(&request.cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            process::hide_window(&mut command);
            let output = tokio::time::timeout(DIAGNOSTIC_TIMEOUT, async move {
                let mut child = command
                    .spawn()
                    .map_err(|error| format!("adapter diagnostic failed: {error}"))?;
                let mut stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| "adapter diagnostic stdout is unavailable".to_string())?
                    .take((MAX_DIAGNOSTIC_OUTPUT_BYTES + 1) as u64);
                let mut stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| "adapter diagnostic stderr is unavailable".to_string())?
                    .take((MAX_DIAGNOSTIC_OUTPUT_BYTES + 1) as u64);
                let mut stdout_bytes = Vec::new();
                let mut stderr_bytes = Vec::new();
                let (status, stdout_result, stderr_result) = tokio::join!(
                    child.wait(),
                    stdout.read_to_end(&mut stdout_bytes),
                    stderr.read_to_end(&mut stderr_bytes)
                );
                let status =
                    status.map_err(|error| format!("adapter diagnostic failed: {error}"))?;
                stdout_result
                    .map_err(|error| format!("adapter diagnostic stdout failed: {error}"))?;
                stderr_result
                    .map_err(|error| format!("adapter diagnostic stderr failed: {error}"))?;
                Ok::<RuntimeCommandOutput, String>(RuntimeCommandOutput {
                    exit_code: status.code(),
                    stdout: process::bounded_text(&stdout_bytes, MAX_DIAGNOSTIC_OUTPUT_BYTES),
                    stderr: process::bounded_text(&stderr_bytes, MAX_DIAGNOSTIC_OUTPUT_BYTES),
                })
            })
            .await
            .map_err(|_| "adapter diagnostic timed out".to_string())??;
            Ok(output)
        })
    }
}

/// What the first prompt of a Routine launch carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualRoutineLaunchInput {
    pub instruction: String,
    pub launch_id: String,
    pub owner_kind: String,
    pub owner_path: String,
    pub event_context: Option<String>,
}

/// The runtime plane of the adapter registry. Stateless; the identity plane
/// is `svode_core::agent_adapters::AgentAdapterRegistry`.
#[derive(Debug, Default, Clone, Copy)]
pub struct AdapterRuntimeRegistry;

impl AdapterRuntimeRegistry {
    /// The first prompt of a Routine launch over ACP: the instruction, the
    /// owner marker and the event context. It has no launch marker, which
    /// terminal launches of earlier versions carried: creating the session
    /// already returns its canonical id.
    pub fn acp_routine_prompt(&self, input: &ManualRoutineLaunchInput) -> String {
        routine_prompt(input)
    }

    pub async fn diagnose(
        &self,
        adapter: AgentAdapterKind,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
    ) -> AdapterDiagnostic {
        let Some(home_dir) = system_home_dir() else {
            return unknown_diagnostic(
                adapter,
                "home_unavailable",
                "home directory is unavailable",
            );
        };
        let Some(path) = resolve_space_executable(
            adapter,
            &target.cwd,
            &home_dir,
            target.search_path.as_deref(),
        ) else {
            return AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Missing,
                executable_path: None,
                version: None,
                authenticated: None,
                code: Some("adapter_missing".into()),
                message: Some(format!("{} executable was not found", adapter.executable())),
            };
        };
        self.diagnose_resolved(adapter, target, path, runner).await
    }

    /// The CLI version from the executable's bounded `--version` output.
    pub async fn cli_version(
        &self,
        adapter: AgentAdapterKind,
        path: &Path,
        target: &AdapterTarget,
        runner: &dyn RuntimeCommandRunner,
    ) -> Result<String, String> {
        match runner
            .run(&RuntimeCommandRequest {
                program: path.to_path_buf(),
                arguments: vec!["--version".into()],
                cwd: target.cwd.clone(),
                search_path: target.search_path.clone(),
            })
            .await?
        {
            output if output.exit_code == Some(0) && !output.stdout.is_empty() => {
                Ok(cli_version_text(adapter, output.stdout))
            }
            output => Err(nonempty(output.stderr, "version check failed")),
        }
    }

    async fn diagnose_resolved(
        &self,
        adapter: AgentAdapterKind,
        target: &AdapterTarget,
        path: PathBuf,
        runner: &dyn RuntimeCommandRunner,
    ) -> AdapterDiagnostic {
        let version = match self.cli_version(adapter, &path, target, runner).await {
            Ok(version) => version,
            Err(error) => {
                return unknown_diagnostic_with_path(adapter, &path, "version_failed", error);
            }
        };
        let Some(auth) = auth_status_command(adapter) else {
            // Without a sign-in status command, sign-in is unknown until the
            // agent runs (Stage 10 `03` A5).
            return AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Unknown,
                executable_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                authenticated: None,
                code: Some(AUTH_STATUS_UNAVAILABLE.into()),
                message: None,
            };
        };
        match runner
            .run(&RuntimeCommandRequest {
                program: path.clone(),
                arguments: auth.arguments.iter().map(|arg| arg.to_string()).collect(),
                cwd: target.cwd.clone(),
                search_path: target.search_path.clone(),
            })
            .await
            .and_then(|output| match auth.signal.signed_in(&output) {
                Some(signed_in) => Ok((signed_in, output)),
                None => Err("sign-in status output is not recognised".to_string()),
            }) {
            Ok((true, _)) => AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Ready,
                executable_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                authenticated: Some(true),
                code: None,
                message: None,
            },
            Ok((false, output)) => AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Unauthenticated,
                executable_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                authenticated: Some(false),
                code: Some("adapter_unauthenticated".into()),
                message: Some(nonempty(output.stderr, "client is not authenticated")),
            },
            Err(error) => AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Unknown,
                executable_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                authenticated: None,
                code: Some("auth_check_failed".into()),
                message: Some(error),
            },
        }
    }
}

/// How the ACP entrypoint of a registry agent starts. Either way it runs
/// the user's own CLI, so terminal and UI sessions share one auth,
/// configuration and session store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpEntrypoint {
    /// The user's executable with the agent's own ACP arguments.
    Command { args: &'static [&'static str] },
    /// An npm adapter that Node.js runs; the adapter runs the user's
    /// executable named by `executable_env`.
    Adapter {
        adapter: &'static AdapterPin,
        executable_env: &'static str,
    },
}

impl AdapterRuntimeRegistry {
    /// `None` until the agent's ACP entrypoint is described.
    pub fn acp_entrypoint(&self, adapter: AgentAdapterKind) -> Option<AcpEntrypoint> {
        let executable_env = match adapter {
            AgentAdapterKind::Codex => "CODEX_PATH",
            AgentAdapterKind::ClaudeCode => "CLAUDE_CODE_EXECUTABLE",
            AgentAdapterKind::Pi => "PI_ACP_PI_COMMAND",
            AgentAdapterKind::Opencode
            | AgentAdapterKind::Cursor
            | AgentAdapterKind::Hermes
            | AgentAdapterKind::KimiCode => {
                return Some(AcpEntrypoint::Command { args: &["acp"] });
            }
            AgentAdapterKind::GrokBuild => {
                return Some(AcpEntrypoint::Command {
                    args: &["agent", "stdio"],
                });
            }
            AgentAdapterKind::QwenCode => {
                return Some(AcpEntrypoint::Command { args: &["--acp"] });
            }
        };
        Some(AcpEntrypoint::Adapter {
            adapter: adapter_pin(adapter)?,
            executable_env,
        })
    }

    /// The declared catalogue sources of the agent's local origins (Stage
    /// 10 `02` C3, `07` N2); origins of different sources never overlap.
    /// E01: the lists of Codex and Claude Code cover the sessions of the
    /// CLI, IDE and the provider's desktop app. Both are listed without
    /// `cwd`: their filter matches the exact directory only, so it would
    /// drop sessions in a Space's subfolders. Slice 3.2: the lists of
    /// opencode and pi cover their terminal sessions; the list of Cursor
    /// has only the sessions its ACP entrypoint created. Slice 3.5: the
    /// lists of Grok Build, Qwen Code and Kimi Code cover their terminal
    /// sessions; Kimi Code lists every directory without `cwd`. Slice 8.1:
    /// the `state.db` of every Hermes profile is the one source of all its
    /// origins, ACP among them, so its list is no longer read.
    /// Slice 8.4: the chat folders of the Cursor CLI are the source of its
    /// terminal chats beside the list of its ACP sessions. Slice 8.5: the
    /// chat headers of the Cursor IDE are the source of its IDE chats.
    pub fn catalog_sources(&self, adapter: AgentAdapterKind) -> &'static [CatalogSource] {
        match adapter {
            AgentAdapterKind::Codex
            | AgentAdapterKind::ClaudeCode
            | AgentAdapterKind::Opencode
            | AgentAdapterKind::Pi
            | AgentAdapterKind::GrokBuild
            | AgentAdapterKind::QwenCode
            | AgentAdapterKind::KimiCode => &[CatalogSource::AcpList],
            AgentAdapterKind::Cursor => &[
                CatalogSource::AcpList,
                CatalogSource::Native(NativeCatalogStore::CursorChats),
                CatalogSource::Native(NativeCatalogStore::CursorIde),
            ],
            AgentAdapterKind::Hermes => &[CatalogSource::Native(NativeCatalogStore::HermesStates)],
        }
    }

    /// Whether the agent's `session/list` is a declared catalogue source.
    pub fn lists_catalog(&self, adapter: AgentAdapterKind) -> bool {
        self.catalog_sources(adapter)
            .contains(&CatalogSource::AcpList)
    }

    /// Whether the agent's `session/list` covers one directory per request:
    /// the `cwd` it is given, else the directory its process runs in. Slice
    /// 3.5: Qwen Code keeps its sessions by exact directory, so its
    /// catalogue is read per project and Space folder.
    pub fn lists_by_folder(&self, adapter: AgentAdapterKind) -> bool {
        adapter == AgentAdapterKind::QwenCode
    }

    /// Whether the agent's ACP `sessionId` is its native session id. E01:
    /// every listed id of Codex is the rollout `session_meta.id` and every
    /// listed id of Claude Code is the jsonl session UUID. Slice 3.2: the
    /// ids of opencode and pi are those of their terminal sessions both
    /// ways; Cursor keeps ACP sessions apart from its terminal chats.
    /// Slice 3.3: an ACP session of Hermes is its `state.db` session, which
    /// `hermes --resume` continues. Slice 3.5: an ACP session of Grok Build
    /// is its session under `~/.grok/sessions`, which `grok --resume`
    /// continues, and its terminal sessions are listed by their ids. So is
    /// a session of Qwen Code under `~/.qwen/projects`, which `qwen
    /// --resume` continues, and of Kimi Code under `~/.kimi-code/sessions`,
    /// which `kimi --session` continues.
    pub fn acp_id_is_native(&self, adapter: AgentAdapterKind) -> bool {
        matches!(
            adapter,
            AgentAdapterKind::Codex
                | AgentAdapterKind::ClaudeCode
                | AgentAdapterKind::Opencode
                | AgentAdapterKind::Hermes
                | AgentAdapterKind::Pi
                | AgentAdapterKind::GrokBuild
                | AgentAdapterKind::QwenCode
                | AgentAdapterKind::KimiCode
        )
    }

    /// Whether loading and closing a session while another process may run
    /// a turn in it leave that turn and the agent's store alone (DF-177
    /// R1). E01: Claude Code loads such a session and its jsonl stays
    /// whole after `close`; Codex refuses it with `thread_active_writer`
    /// and keeps its store. Acceptance 8.7: Qwen Code writes nothing to its
    /// chat log. Grok Build ends the open turn with `turn_ended`
    /// `interrupted`, and Hermes replaces the active messages of the
    /// conversation; the other agents were not measured.
    pub fn reads_during_external_turn(&self, adapter: AgentAdapterKind) -> bool {
        matches!(
            adapter,
            AgentAdapterKind::ClaudeCode | AgentAdapterKind::Codex | AgentAdapterKind::QwenCode
        )
    }

    /// Whether the agent keeps a session it created, opened or read in the
    /// memory of its process and serves or writes that copy on the next
    /// load there (DF-177 R3). Design 2026-10-16, probe on Hermes source
    /// `c8301ea`: Hermes declares no `close`, and a second `session/load`
    /// in one process replaces the active messages of the conversation
    /// with the one it loaded first, dropping what another process wrote in
    /// between; a new process reads the conversation from its store.
    pub fn keeps_loaded_sessions(&self, adapter: AgentAdapterKind) -> bool {
        adapter == AgentAdapterKind::Hermes
    }

    /// What the recorded evidence allows for a session the agent creates
    /// without a prompt, with the evidence and the agent version it was
    /// observed on (Stage 11 `03`, E6 2026-10-31, live in the real HOME). An
    /// agent without evidence gets no draft session.
    pub fn draft_session(&self, adapter: AgentAdapterKind) -> DraftSessionEvidence {
        let (session, evidence) = match adapter {
            AgentAdapterKind::Codex => (
                DraftSession::Traceless,
                "E6: not in the list or store; codex-acp 2.1.1, codex-cli 0.163.0",
            ),
            AgentAdapterKind::ClaudeCode => (
                DraftSession::Traceless,
                "E6: not in the list or store, an empty project memory directory; \
                 claude-agent-acp 0.85.0, Claude Code 2.1.316",
            ),
            AgentAdapterKind::Hermes => (
                DraftSession::Traceless,
                "E6: ephemeral, value changes not kept either; Hermes 2026.9.24",
            ),
            AgentAdapterKind::QwenCode => (
                DraftSession::FixedValues,
                "E6: not in the list until set_config_option or set_mode, which \
                 lists it, and no ACP deletion; Qwen Code 0.24.7",
            ),
            AgentAdapterKind::Pi => (
                DraftSession::Deleted,
                "E6: a session-map.json record, removed by session/delete; \
                 pi-acp 0.0.34, pi 1.0.0",
            ),
            AgentAdapterKind::KimiCode => (
                DraftSession::Deleted,
                "E6: listed at once, removed by session/delete; Kimi Code 2.2.0",
            ),
            AgentAdapterKind::Opencode => (
                DraftSession::Deleted,
                "E6: listed at once, removed by session/delete; opencode 2.0.22",
            ),
            AgentAdapterKind::GrokBuild => (
                DraftSession::Unsupported,
                "E6: in `grok sessions list`, deleted only by its CLI; Grok Build 1.0.70",
            ),
            AgentAdapterKind::Cursor => (
                DraftSession::Unsupported,
                "E6: listed at once with a detached worker, no deletion; Cursor 2026.10.01",
            ),
        };
        DraftSessionEvidence { session, evidence }
    }

    /// Launch plan of the agent's ACP entrypoint for the user's executable:
    /// its own command, or the installed adapter run by the user's Node.js
    /// (`adapter_run`). `None` for an agent without an entrypoint, or for an
    /// adapter entrypoint without its Node.js and installation.
    pub fn acp_launch(
        &self,
        adapter: AgentAdapterKind,
        executable: &Path,
        adapter_run: Option<(&Path, &InstalledAdapter)>,
        cwd: &Path,
    ) -> Option<AcpLaunch> {
        let (program, args, env) = match self.acp_entrypoint(adapter)? {
            AcpEntrypoint::Command { args } => (
                executable.to_path_buf(),
                args.iter().map(|arg| arg.to_string()).collect(),
                BTreeMap::new(),
            ),
            AcpEntrypoint::Adapter { executable_env, .. } => {
                let (node, installed) = adapter_run?;
                (
                    node.to_path_buf(),
                    vec![installed.entry.to_string_lossy().into_owned()],
                    BTreeMap::from([(
                        executable_env.to_string(),
                        executable.to_string_lossy().into_owned(),
                    )]),
                )
            }
        };
        Some(AcpLaunch {
            agent: adapter.as_str().to_string(),
            program,
            args,
            environment: None,
            env,
            cwd: cwd.to_path_buf(),
            acp_id_is_native: self.acp_id_is_native(adapter),
            lists_catalog: self.lists_catalog(adapter),
            // E01, slices 3.2, 3.3 and 3.5: load and close of these agents
            // change their store at most in service records, which Svode
            // accepts; Qwen Code leaves it unchanged, and Kimi Code adds a
            // runtime binding record without moving `updatedAt`.
            read_only_open: true,
            reads_during_external_turn: self.reads_during_external_turn(adapter),
            writer_refusal: match adapter {
                AgentAdapterKind::Codex => Some("thread_active_writer".into()),
                // Claude loads a session another process writes to.
                _ => None,
            },
            // Slice 3.2: `pi-acp` keeps one live pi per connection, closes
            // the other sessions when one is loaded, and lists only the
            // last session's directory once a session ran.
            session_per_connection: adapter == AgentAdapterKind::Pi,
            keeps_loaded_sessions: self.keeps_loaded_sessions(adapter),
            draft_session: self.draft_session(adapter).session,
        })
    }

    /// Arguments that continue the agent's session in its terminal by native
    /// id, when the agent documents such a command. Slice 3.2: `opencode
    /// --session` and `pi --session` continue the same session. Slice 3.3:
    /// `hermes --resume`. Slice 3.5: `grok --resume`, `qwen --resume` and
    /// `kimi --session`.
    /// Slice 8.4: `cursor-agent --resume` continues a terminal chat, the
    /// one origin of Cursor with a native id; its ACP sessions keep their
    /// own namespace, since its `--resume` with such an id starts an empty
    /// chat. A native catalogue source tells when a session of its origin
    /// does not continue so (Stage 10 `07` N6).
    pub fn terminal_resume_args(
        &self,
        adapter: AgentAdapterKind,
        native_session_id: &str,
    ) -> Option<Vec<String>> {
        let flag = match adapter {
            AgentAdapterKind::Codex => "resume",
            AgentAdapterKind::ClaudeCode
            | AgentAdapterKind::Cursor
            | AgentAdapterKind::Hermes
            | AgentAdapterKind::GrokBuild
            | AgentAdapterKind::QwenCode => "--resume",
            AgentAdapterKind::Opencode | AgentAdapterKind::Pi | AgentAdapterKind::KimiCode => {
                "--session"
            }
        };
        Some(vec![flag.to_string(), native_session_id.to_string()])
    }

    /// Arguments that select the agent profile whose store holds a session,
    /// put before its resume arguments (Stage 10 `07` N6). Slice 8.1:
    /// `hermes -p <profile>`; the root store of Hermes is its profile
    /// `default`.
    pub fn terminal_profile_args(
        &self,
        adapter: AgentAdapterKind,
        profile: &str,
    ) -> Option<Vec<String>> {
        match adapter {
            AgentAdapterKind::Hermes => Some(vec!["-p".to_string(), profile.to_string()]),
            _ => None,
        }
    }

    /// The agent's native store the Sessions status reader reads the status
    /// of a listed session from (Stage 10 `02` C10, `07` N1): ACP gives no
    /// status of a session another process drives. Slice 8.2: `opencode.db`
    /// gives the status of opencode's sessions; its ACP list stays its
    /// catalogue.
    /// Slice 8.3a: Qwen Code keeps a chat log per session and, for a
    /// terminal session, the process that holds it (`07` N7).
    pub fn native_status_store(&self, adapter: AgentAdapterKind) -> Option<NativeStatusStore> {
        match adapter {
            AgentAdapterKind::Codex => Some(NativeStatusStore::CodexRollouts),
            AgentAdapterKind::ClaudeCode => Some(NativeStatusStore::ClaudeProjects),
            AgentAdapterKind::Hermes => Some(NativeStatusStore::HermesStates),
            AgentAdapterKind::Opencode => Some(NativeStatusStore::OpencodeDb),
            AgentAdapterKind::Pi => Some(NativeStatusStore::PiSessions),
            AgentAdapterKind::QwenCode => Some(NativeStatusStore::QwenChats),
            AgentAdapterKind::GrokBuild => Some(NativeStatusStore::GrokSessionEvents),
            _ => None,
        }
    }
}

/// Whether Svode offers the agent for chat in this version (Stage 10 `03`
/// A8). Supported and limited are given only by live evidence; until then an
/// agent stays deferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentVerdict {
    Supported,
    /// Offered for chat; the first restriction is the main one.
    Limited {
        restrictions: &'static [AgentRestriction],
    },
    Deferred,
}

/// What a limited agent lacks, recorded with live evidence (A8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRestriction {
    /// Sessions started in Svode cannot be continued in the agent's
    /// terminal.
    NoTerminalContinuation,
    /// The agent runs its tools without asking for permission.
    NoPermissionRequests,
    /// A turn the provider fails ends without its error.
    TurnErrorsHidden,
}

impl AdapterRuntimeRegistry {
    /// Codex and Claude Code: start, prompt, stop, permissions, history,
    /// continuation and their external sessions live (E01, slice 2.5b).
    /// opencode: the same with opencode 2.0.22 (slice 3.2). Cursor
    /// 2026.10.01 and pi 1.0.0 with `pi-acp` 0.0.34: limited (slice 3.2).
    /// Grok Build 1.0.46, Qwen Code 0.24.7 and Kimi Code 2.1.1: supported
    /// (slice 3.5).
    /// Hermes 2026.9.24: supported once its sessions of every origin come
    /// from its own store (slice 8.1, live in acceptance 8.7). Cursor lists
    /// its terminal and IDE chats from its stores (slices 8.4 and 8.5), and
    /// its ACP sessions still cannot be continued in its terminal.
    pub fn verdict(&self, adapter: AgentAdapterKind) -> AgentVerdict {
        match adapter {
            AgentAdapterKind::Codex
            | AgentAdapterKind::ClaudeCode
            | AgentAdapterKind::Opencode
            | AgentAdapterKind::GrokBuild
            | AgentAdapterKind::QwenCode
            | AgentAdapterKind::KimiCode
            | AgentAdapterKind::Hermes => AgentVerdict::Supported,
            AgentAdapterKind::Cursor => AgentVerdict::Limited {
                restrictions: &[AgentRestriction::NoTerminalContinuation],
            },
            AgentAdapterKind::Pi => AgentVerdict::Limited {
                restrictions: &[
                    AgentRestriction::NoPermissionRequests,
                    AgentRestriction::TurnErrorsHidden,
                ],
            },
        }
    }

    /// Arguments of the agent's own sign-in command, which the user runs in a
    /// Svode terminal (A5). Live 2026-10-02: `codex login` and
    /// `claude auth login` of the installed CLIs. Slice 3.2: `opencode auth
    /// login` and `agent login`, as their ACP auth methods name them; pi
    /// signs in from its own terminal UI (`/login`), as its `pi-acp` terminal
    /// auth method does. Slice 3.3: `hermes acp --setup`, the Hermes
    /// terminal auth method `hermes-setup`. Slice 3.5: `grok login`; Grok
    /// Build declares no terminal auth method. `qwen --auth-type=openai`,
    /// the Qwen Code terminal auth method `openai`, opens its provider
    /// dialog. `kimi acp --login`, the Kimi Code terminal auth method
    /// `login`, runs its device-code sign-in.
    pub fn sign_in_arguments(&self, adapter: AgentAdapterKind) -> Option<Vec<String>> {
        match adapter {
            AgentAdapterKind::Codex | AgentAdapterKind::Cursor | AgentAdapterKind::GrokBuild => {
                Some(vec!["login".into()])
            }
            AgentAdapterKind::ClaudeCode | AgentAdapterKind::Opencode => {
                Some(vec!["auth".into(), "login".into()])
            }
            AgentAdapterKind::Pi => Some(Vec::new()),
            AgentAdapterKind::Hermes => Some(vec!["acp".into(), "--setup".into()]),
            AgentAdapterKind::QwenCode => Some(vec!["--auth-type=openai".into()]),
            AgentAdapterKind::KimiCode => Some(vec!["acp".into(), "--login".into()]),
        }
    }
}

/// Which native store the Sessions status reader reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeStatusStore {
    /// `rollout-*.jsonl` under the Codex home.
    CodexRollouts,
    /// `projects/**/*.jsonl` under the Claude config directory.
    ClaudeProjects,
    /// The turn leases and last messages in the `state.db` of every Hermes
    /// profile (Stage 10 `07` N7).
    HermesStates,
    /// `opencode.db` under the opencode data directory: the turn claim and
    /// the outcome of the last turn of each session (`07` N7).
    OpencodeDb,
    /// `sessions/**/*.jsonl` under the pi agent directory (`07` N7).
    PiSessions,
    /// `projects/<key>/chats/<id>.jsonl` with the process marker
    /// `<id>.runtime.json` under the Qwen homes (`07` N7).
    QwenChats,
    /// `sessions/*/<id>/events.jsonl` under the Grok home, with the TUI's
    /// `active_sessions.json` as the process signal (`07` N7).
    GrokSessionEvents,
}

/// A declared catalogue source of some of an agent's origins (Stage 10 `02`
/// C3, `07` N2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CatalogSource {
    /// The agent's ACP `session/list`, read over a live connection.
    AcpList,
    /// A native reader of the agent's store (`07`); it starts no agent
    /// process.
    Native(NativeCatalogStore),
}

/// A native catalogue store and the origins it covers (Stage 10 `07` N7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NativeCatalogStore {
    /// `state.db` of every Hermes profile: its CLI, TUI, desktop app and
    /// ACP sessions.
    HermesStates,
    /// `chats/<md5(cwd)>/<chatId>/meta.json` under the Cursor CLI config
    /// directory: its terminal chats.
    CursorChats,
    /// The chat headers in `User/globalStorage/state.vscdb` under the
    /// Cursor app data: the chats of its IDE.
    CursorIde,
}

impl NativeCatalogStore {
    /// Stable name of the store, for keys of what is saved of it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HermesStates => "hermes-states",
            Self::CursorChats => "cursor-chats",
            Self::CursorIde => "cursor-ide",
        }
    }
}

/// The agent's read-only sign-in status command (A5) and how its output
/// tells that the user is signed in.
struct AuthStatusCommand {
    arguments: &'static [&'static str],
    signal: AuthSignal,
}

enum AuthSignal {
    /// Exit code 0.
    ExitCode,
    /// Exit code 0 and this boolean field of the JSON output. Slice 3.2:
    /// `agent status` exits with 0 signed out too.
    JsonFlag(&'static str),
}

fn auth_status_command(adapter: AgentAdapterKind) -> Option<AuthStatusCommand> {
    let (arguments, signal): (&'static [&'static str], _) = match adapter {
        AgentAdapterKind::Codex => (&["login", "status"], AuthSignal::ExitCode),
        AgentAdapterKind::ClaudeCode => (&["auth", "status", "--json"], AuthSignal::ExitCode),
        AgentAdapterKind::Cursor => (
            &["status", "--format", "json"],
            AuthSignal::JsonFlag("isAuthenticated"),
        ),
        _ => return None,
    };
    Some(AuthStatusCommand { arguments, signal })
}

impl AuthSignal {
    /// `None`: the output does not say.
    fn signed_in(&self, output: &RuntimeCommandOutput) -> Option<bool> {
        match self {
            Self::ExitCode => Some(output.exit_code == Some(0)),
            Self::JsonFlag(field) if output.exit_code == Some(0) => {
                serde_json::from_str::<serde_json::Value>(&output.stdout)
                    .ok()?
                    .get(field)?
                    .as_bool()
            }
            Self::JsonFlag(_) => Some(false),
        }
    }
}

/// The version in the agent's `--version` output. Slice 3.3: Hermes prints
/// `Hermes Agent v<release> (<release date>)` from a release and
/// `Hermes Agent vgit.<commit> (<release date>)` from a checkout without
/// tags, so its version is the release date both print.
fn cli_version_text(adapter: AgentAdapterKind, output: String) -> String {
    let release_date = match adapter {
        AgentAdapterKind::Hermes => output
            .split_once('(')
            .and_then(|(_, rest)| rest.split_once(')'))
            .map(|(date, _)| date.trim().to_string())
            .filter(|date| !date.is_empty()),
        _ => None,
    };
    release_date.unwrap_or(output)
}

fn nonempty(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn unknown_diagnostic(adapter: AgentAdapterKind, code: &str, message: &str) -> AdapterDiagnostic {
    AdapterDiagnostic {
        adapter,
        status: AdapterDiagnosticStatus::Unknown,
        executable_path: None,
        version: None,
        authenticated: None,
        code: Some(code.into()),
        message: Some(message.into()),
    }
}

fn unknown_diagnostic_with_path(
    adapter: AgentAdapterKind,
    path: &Path,
    code: &str,
    message: impl Into<String>,
) -> AdapterDiagnostic {
    AdapterDiagnostic {
        adapter,
        status: AdapterDiagnosticStatus::Unknown,
        executable_path: Some(path.to_string_lossy().into_owned()),
        version: None,
        authenticated: None,
        code: Some(code.into()),
        message: Some(message.into()),
    }
}

const OWNER_MARKER: &str = "<!-- svode-owner:";
const LAUNCH_MARKER: &str = "<!-- svode-launch:";
const MARKER_END: &str = " -->";
const EVENT_CONTEXT_OPEN: &str = "<svode-event-context>";
const EVENT_CONTEXT_CLOSE: &str = "</svode-event-context>";

fn routine_prompt(input: &ManualRoutineLaunchInput) -> String {
    let mut prompt = input.instruction.trim().to_string();
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str(&format!(
        "{OWNER_MARKER}{}:{}{MARKER_END}",
        input.owner_kind, input.owner_path
    ));
    if let Some(context) = input.event_context.as_deref() {
        prompt.push('\n');
        prompt.push_str(EVENT_CONTEXT_OPEN);
        prompt.push_str(context);
        prompt.push_str(EVENT_CONTEXT_CLOSE);
    }
    prompt
}

/// The end of a text [`strip_routine_block`] takes for a Routine block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutineBlockEnd {
    /// Only a whole block.
    Whole,
    /// A whole block or its start, cut short where the text ends.
    Cut,
}

/// `text` without the block a Routine launch appends to its instruction
/// ([`AdapterRuntimeRegistry::acp_routine_prompt`] and the terminal launch
/// prompt) — the owner marker, then the optional launch marker and event
/// context — and the whitespace before it. Text that does not end with such
/// a block, whole or cut short as `end` takes it, is returned as it is
/// (DF-224).
pub fn strip_routine_block(text: &str, end: RoutineBlockEnd) -> &str {
    let block = |found: RoutineBlockEnd| {
        block_starts(text, end == RoutineBlockEnd::Cut)
            .find(|&start| routine_block(&text[start..]) == Some(found))
    };
    // A whole block is the end of the text even after a lookalike.
    block(RoutineBlockEnd::Whole)
        .or_else(|| (end == RoutineBlockEnd::Cut).then(|| block(end)).flatten())
        .map_or(text, |start| text[..start].trim_end())
}

/// The leftmost place in `text` where a Routine block starts that more text
/// may still complete or that is whole, with the scan of it (DF-224).
pub(crate) fn routine_block_start(text: &str) -> Option<(usize, RoutineBlockScan)> {
    block_starts(text, true)
        .find_map(|start| RoutineBlockScan::start(&text[start..]).map(|scan| (start, scan)))
}

/// Where a Routine block may start in `text`: an owner marker at its start
/// or after whitespace, and with `cut` that marker cut short at its end.
fn block_starts(text: &str, cut: bool) -> impl Iterator<Item = usize> + '_ {
    let cut_marker = cut
        .then(|| {
            (1..OWNER_MARKER.len())
                .rev()
                .find(|&len| text.ends_with(&OWNER_MARKER[..len]))
                .map(|len| text.len() - len)
        })
        .flatten();
    text.match_indices(OWNER_MARKER)
        .map(|(start, _)| start)
        .chain(cut_marker)
        .filter(|&start| {
            text[..start]
                .chars()
                .next_back()
                .is_none_or(char::is_whitespace)
        })
}

/// What `text` is to its end, its parts separated by whitespace: a whole
/// Routine block, one cut short, or neither.
fn routine_block(text: &str) -> Option<RoutineBlockEnd> {
    match block_markers(text) {
        Ok(context) => {
            let mut scan = ContextScan::default();
            scan.push(&text[context..]);
            scan.end()
        }
        Err(end) => end,
    }
}

/// Longest part of a Routine block before its event context: owner and
/// launch markers whose values are paths and ids within any system's bound.
const MARKERS_LIMIT: usize = 16 * 1024;

/// Where the event context of the block `text` starts once it opened;
/// otherwise what `text` is: a whole block without one, one cut short, or
/// neither.
fn block_markers(text: &str) -> Result<usize, Option<RoutineBlockEnd>> {
    use RoutineBlockEnd::{Cut, Whole};
    let owner = |value: &str| {
        value
            .split_once(':')
            .is_some_and(|(kind, path)| !kind.is_empty() && !path.is_empty())
    };
    let within = |end| {
        if text.len() <= MARKERS_LIMIT {
            end
        } else {
            None
        }
    };
    let rest = match routine_marker(text, OWNER_MARKER, owner) {
        Some(Some(rest)) => rest.trim_start(),
        Some(None) => return Err(within(Some(Cut))),
        None => return Err(None),
    };
    let rest = match routine_marker(rest, LAUNCH_MARKER, |id| !id.is_empty()) {
        Some(Some(rest)) => rest.trim_start(),
        Some(None) => return Err(within(Some(Cut))),
        None => rest,
    };
    if rest.trim_end().is_empty() {
        return Err(within(Some(Whole)));
    }
    match rest.strip_prefix(EVENT_CONTEXT_OPEN) {
        Some(context) if text.len() - context.len() <= MARKERS_LIMIT => {
            Ok(text.len() - context.len())
        }
        Some(_) => Err(None),
        None => Err(within(
            EVENT_CONTEXT_OPEN
                .starts_with(rest.trim_end())
                .then_some(Cut),
        )),
    }
}

/// The one-line marker `prefix<value> -->` that `text` starts with: the
/// text after it when `valid` accepts its value, `None` inside when `text`
/// ends before the marker does, and outside when there is no such marker.
fn routine_marker<'a>(
    text: &'a str,
    prefix: &str,
    valid: impl Fn(&str) -> bool,
) -> Option<Option<&'a str>> {
    if text.len() < prefix.len() {
        return (!text.is_empty() && prefix.starts_with(text)).then_some(None);
    }
    let value = text.strip_prefix(prefix)?;
    match value.split_once(MARKER_END) {
        Some((value, rest)) => (!value.contains('\n') && valid(value)).then_some(Some(rest)),
        None => (!value.contains('\n')).then_some(None),
    }
}

/// A Routine block read piece by piece as it streams in, keeping only what
/// tells what it is: the part before its event context and what that
/// context holds so far, not the context itself (DF-224).
pub(crate) struct RoutineBlockScan {
    len: usize,
    markers: String,
    context: Option<ContextScan>,
}

impl RoutineBlockScan {
    /// The scan of `text` from a block start, while more text may still
    /// complete it or it is whole.
    pub(crate) fn start(text: &str) -> Option<Self> {
        let mut scan = Self {
            len: 0,
            markers: String::new(),
            context: None,
        };
        scan.push(text);
        scan.alive().then_some(scan)
    }

    pub(crate) fn push(&mut self, more: &str) {
        self.len += more.len();
        match &mut self.context {
            Some(context) => context.push(more),
            None => {
                self.markers.push_str(more);
                if let Ok(start) = block_markers(&self.markers) {
                    let mut context = ContextScan::default();
                    context.push(&self.markers.split_off(start));
                    self.context = Some(context);
                }
            }
        }
    }

    /// Whether more text may still complete the block or it is whole.
    pub(crate) fn alive(&self) -> bool {
        match &self.context {
            Some(context) => context.alive(),
            None => block_markers(&self.markers) != Err(None),
        }
    }

    pub(crate) fn end(&self) -> Option<RoutineBlockEnd> {
        match &self.context {
            Some(context) => context.end(),
            None => block_markers(&self.markers).err().flatten(),
        }
    }

    /// Bytes of the block read so far.
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// Bytes the scan holds.
    pub(crate) fn size(&self) -> usize {
        self.markers.len()
            + self
                .context
                .as_ref()
                .map_or(0, |context| context.carry.len())
    }
}

/// The event context of a block read piece by piece: whether it holds an
/// opening tag or an owner marker, its closing tags and any text after the
/// last one, and its last bytes, where a tag may continue.
#[derive(Default)]
struct ContextScan {
    open: bool,
    owner: bool,
    closes: u8,
    after_close: bool,
    carry: String,
}

impl ContextScan {
    const CARRY: usize = EVENT_CONTEXT_CLOSE.len() - 1;

    fn push(&mut self, more: &str) {
        let carried = self.carry.len();
        let text = format!("{}{more}", self.carry);
        // Only tags that end in `more`: those within the carry are counted.
        let found = |tag: &'static str| -> Vec<usize> {
            text.match_indices(tag)
                .map(|(start, tag)| start + tag.len())
                .filter(|&end| end > carried)
                .collect()
        };
        self.open |= !found(EVENT_CONTEXT_OPEN).is_empty();
        self.owner |= !found(OWNER_MARKER).is_empty();
        let closes = found(EVENT_CONTEXT_CLOSE);
        if let Some(&last) = closes.last() {
            self.closes = self.closes.saturating_add(closes.len().min(2) as u8);
            self.after_close = !text[last..].trim().is_empty();
        } else if self.closes > 0 && !more.trim().is_empty() {
            self.after_close = true;
        }
        let mut carry = text.len().saturating_sub(Self::CARRY);
        while !text.is_char_boundary(carry) {
            carry -= 1;
        }
        self.carry = text[carry..].to_string();
    }

    fn alive(&self) -> bool {
        !self.open && (self.closes == 0 || (self.closes == 1 && !self.after_close))
    }

    /// Whole when it ends with its one closing tag; cut short without one
    /// and without the next block in it.
    fn end(&self) -> Option<RoutineBlockEnd> {
        match self.closes {
            _ if !self.alive() => None,
            0 => (!self.owner).then_some(RoutineBlockEnd::Cut),
            _ => Some(RoutineBlockEnd::Whole),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// The first prompt a terminal launch of an earlier version sent: the
    /// ACP prompt with the launch marker after the owner marker. Sessions
    /// started so still carry it.
    fn terminal_routine_prompt(input: &ManualRoutineLaunchInput) -> String {
        let mut prompt = input.instruction.trim().to_string();
        if !prompt.is_empty() {
            prompt.push_str("\n\n");
        }
        prompt.push_str(&format!(
            "{OWNER_MARKER}{}:{}{MARKER_END}\n{LAUNCH_MARKER}{}{MARKER_END}",
            input.owner_kind, input.owner_path, input.launch_id
        ));
        if let Some(context) = input.event_context.as_deref() {
            prompt.push_str(&format!(
                "\n{EVENT_CONTEXT_OPEN}{context}{EVENT_CONTEXT_CLOSE}"
            ));
        }
        prompt
    }

    #[test]
    fn acp_routine_prompt_carries_instruction_and_event_context_without_launch_marker() {
        let prompt = AdapterRuntimeRegistry.acp_routine_prompt(&ManualRoutineLaunchInput {
            instruction: "Review backlog".into(),
            launch_id: "launch-one".into(),
            owner_kind: "space".into(),
            owner_path: ".".into(),
            event_context: Some("{\"eventType\":\"collection.entry_created\"}".into()),
        });
        assert!(prompt.starts_with("Review backlog\n\n<!-- svode-owner:space:. -->"));
        assert!(prompt.ends_with(
            "<svode-event-context>{\"eventType\":\"collection.entry_created\"}</svode-event-context>"
        ));
        assert!(!prompt.contains("svode-launch"));
    }

    #[test]
    fn event_routine_prompt_carries_typed_context_after_the_instruction() {
        let prompt = AdapterRuntimeRegistry.acp_routine_prompt(&ManualRoutineLaunchInput {
            instruction: "Review changed entry".into(),
            launch_id: "launch-event".into(),
            owner_kind: "collection".into(),
            owner_path: "tasks".into(),
            event_context: Some(
                serde_json::json!({
                    "entryPath": "tasks/item.md",
                    "eventType": "collection.field_changed",
                    "oldValue": "Open",
                    "newValue": "Done"
                })
                .to_string(),
            ),
        });

        assert!(prompt.starts_with("Review changed entry\n\n"));
        assert!(prompt.contains("<svode-event-context>{"));
        assert!(prompt.contains("\"entryPath\":\"tasks/item.md\""));
        assert!(prompt.ends_with("</svode-event-context>"));
    }

    #[test]
    fn stripping_the_routine_block_from_a_routine_prompt_gives_the_trimmed_instruction() {
        let instructions = [
            "",
            "  Review backlog  ",
            "Review backlog\n\n- open items\n- stale items\n",
            "Explain <!-- svode-owner:space:. --> and <!-- svode-launch:x --> markers",
            "Ends with a marker\n<!-- svode-owner:project:notes -->",
            "Ends with a block\n\n<!-- svode-owner:space:. -->\n<!-- svode-launch:old -->",
            "Ends with <svode-event-context>{}</svode-event-context>",
            "<!-- svode-owner:space:. --> <svode-event-context>",
        ];
        let contexts = [
            None,
            Some(r#"{"eventType":"collection.entry_created","entryPath":"tasks/a.md"}"#),
            Some(r#"{"text":"line\n<!-- svode-owner:space:. -->"}"#),
        ];
        for instruction in instructions {
            for (owner_kind, owner_path) in [("project", "."), ("collection", "tasks/sub dir")] {
                for context in contexts {
                    let input = ManualRoutineLaunchInput {
                        instruction: instruction.into(),
                        launch_id: "01jz-launch".into(),
                        owner_kind: owner_kind.into(),
                        owner_path: owner_path.into(),
                        event_context: context.map(str::to_string),
                    };
                    for prompt in [
                        terminal_routine_prompt(&input),
                        AdapterRuntimeRegistry.acp_routine_prompt(&input),
                    ] {
                        for end in [RoutineBlockEnd::Whole, RoutineBlockEnd::Cut] {
                            assert_eq!(
                                strip_routine_block(&prompt, end),
                                instruction.trim(),
                                "{end:?} {prompt:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn text_without_a_whole_routine_block_at_its_end_is_unchanged() {
        for text in [
            "",
            "Review backlog",
            "Review <!-- svode-owner:space:. --> later",
            "Review backlog\n\n<!-- svode-owner:space:. -->\nmore",
            "Review backlog\n\n<!-- svode-owner:space:. -->\n<!-- svode-launch:a",
            "Review backlog\n\n<!-- svode-owner:space:. -->\n<svode-event-context>{}",
            "Review backlog\n\n<!-- svode-owner:proj",
            "Review backlog\n\n<!-- svode-owner:space -->",
            "Review backlog\n\n<!-- svode-launch:a -->",
            "Review backlog<!-- svode-owner:space:. -->",
        ] {
            assert_eq!(strip_routine_block(text, RoutineBlockEnd::Whole), text);
        }
        // The block an agent's replay ends with a line break is still whole.
        assert_eq!(
            strip_routine_block(
                "Review backlog\r\n\r\n<!-- svode-owner:space:. -->\r\n",
                RoutineBlockEnd::Whole
            ),
            "Review backlog"
        );
    }

    #[test]
    fn a_routine_block_read_piece_by_piece_is_what_its_whole_text_is() {
        let context = format!(r#"{{"entry":"{}"}}"#, "x".repeat(300));
        let blocks = [
            "<!-- svode-owner:project:. -->".to_string(),
            "<!-- svode-owner:space:. -->\n<!-- svode-launch:a -->\n".to_string(),
            format!(
                "<!-- svode-owner:space:. -->\n<svode-event-context>{context}</svode-event-context>"
            ),
            format!(
                "<!-- svode-owner:space:. -->\n<!-- svode-launch:a -->\n<svode-event-context>{{\"text\":\" <!-- svode-owner:a:b -->\"}}</svode-event-context>"
            ),
            "<!-- svode-owner:space:. -->\n<svode-event-context>a</svode-event-context> more"
                .to_string(),
            "<!-- svode-owner:space:. --> <svode-event-context>\n\n<!-- svode-owner:p:q -->"
                .to_string(),
            "<!-- svode-owner:space:. -->\nmore".to_string(),
        ];
        for block in &blocks {
            for piece in [1, 2, 5, 21, 22, 64] {
                let mut scan: Option<RoutineBlockScan> = None;
                let mut read = 0;
                while read < block.len() {
                    let mut end = (read + piece).min(block.len());
                    while !block.is_char_boundary(end) {
                        end += 1;
                    }
                    match &mut scan {
                        Some(scan) => scan.push(&block[read..end]),
                        None => scan = RoutineBlockScan::start(&block[..end]),
                    }
                    read = end;
                    let whole = routine_block(&block[..read]);
                    match &scan {
                        Some(scan) if scan.alive() => {
                            assert_eq!(scan.end(), whole, "{piece} {:?}", &block[..read]);
                            assert_eq!(scan.len(), read);
                        }
                        // Once no block, never one again.
                        _ => {
                            assert_eq!(whole, None, "{piece} {:?}", &block[..read]);
                            break;
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_routine_block_cut_short_anywhere_is_stripped_only_as_cut() {
        let prompt = terminal_routine_prompt(&ManualRoutineLaunchInput {
            instruction: "Review backlog".into(),
            launch_id: "launch-one".into(),
            owner_kind: "space".into(),
            owner_path: ".".into(),
            event_context: Some(r#"{"eventType":"collection.entry_created"}"#.into()),
        });
        let block = prompt.find(OWNER_MARKER).unwrap();
        for end in block + 1..prompt.len() {
            let cut = &prompt[..end];
            assert_eq!(
                strip_routine_block(cut, RoutineBlockEnd::Cut),
                "Review backlog",
                "{cut:?}"
            );
            assert_eq!(
                strip_routine_block(cut, RoutineBlockEnd::Whole),
                // Whole up to the owner or launch marker, cut after it.
                if routine_block(&cut[block..]) == Some(RoutineBlockEnd::Whole) {
                    "Review backlog"
                } else {
                    cut
                },
                "{cut:?}"
            );
        }
        for text in [
            "Review backlog <",
            "Review backlog\n<!-- svode-launch:a",
            "Review backlog\n\n<!-- svode-owner:space:. -->\nmore",
            "Review backlog\n\n<!-- svode-owner:space\n",
            "Review backlog<!-- svode-owner:sp",
        ] {
            let expected = if text.ends_with(" <") {
                "Review backlog"
            } else {
                text
            };
            assert_eq!(strip_routine_block(text, RoutineBlockEnd::Cut), expected);
        }
    }

    #[test]
    fn grok_build_declares_its_session_events_as_its_native_status_store() {
        assert_eq!(
            AdapterRuntimeRegistry.native_status_store(AgentAdapterKind::GrokBuild),
            Some(NativeStatusStore::GrokSessionEvents)
        );
    }

    #[test]
    fn a_supported_agent_has_an_entrypoint_and_its_own_sign_in() {
        let registry = AdapterRuntimeRegistry;
        for agent in AgentAdapterKind::ALL {
            if registry.verdict(agent) == AgentVerdict::Supported {
                assert!(registry.acp_entrypoint(agent).is_some(), "{agent:?}");
            }
        }
        assert_eq!(
            registry.sign_in_arguments(AgentAdapterKind::ClaudeCode),
            Some(vec!["auth".to_string(), "login".to_string()])
        );
        assert_eq!(
            registry.sign_in_arguments(AgentAdapterKind::Codex),
            Some(vec!["login".to_string()])
        );
        assert_eq!(
            serde_json::to_value(AgentVerdict::Deferred).unwrap(),
            serde_json::json!({ "state": "deferred" })
        );
    }

    struct FakeRunner {
        outputs: Mutex<Vec<Result<RuntimeCommandOutput, String>>>,
        requests: Mutex<Vec<RuntimeCommandRequest>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<Result<RuntimeCommandOutput, String>>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().rev().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl RuntimeCommandRunner for FakeRunner {
        fn run<'a>(
            &'a self,
            request: &'a RuntimeCommandRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RuntimeCommandOutput, String>> + Send + 'a>>
        {
            self.requests.lock().unwrap().push(request.clone());
            let output = self.outputs.lock().unwrap().pop().unwrap();
            Box::pin(async move { output })
        }
    }

    #[tokio::test]
    async fn auth_diagnostics_use_read_only_native_commands() {
        let registry = AdapterRuntimeRegistry;
        let runner = FakeRunner::new(vec![
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: "2.1.179".into(),
                stderr: String::new(),
            }),
            Ok(RuntimeCommandOutput {
                exit_code: Some(1),
                stdout: String::new(),
                stderr: "not logged in".into(),
            }),
        ]);
        let target = AdapterTarget {
            cwd: PathBuf::from("/project"),
            search_path: None,
        };
        let diagnostic = registry
            .diagnose_resolved(
                AgentAdapterKind::ClaudeCode,
                &target,
                PathBuf::from("/bin/claude"),
                &runner,
            )
            .await;
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unauthenticated);
        let requests = runner.requests.lock().unwrap();
        assert_eq!(requests[0].arguments, vec!["--version"]);
        assert_eq!(requests[1].arguments, vec!["auth", "status", "--json"]);
    }

    #[tokio::test]
    async fn codex_auth_diagnostic_uses_login_status_without_prompt() {
        let registry = AdapterRuntimeRegistry;
        let runner = FakeRunner::new(vec![
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: "codex-cli 0.146.0".into(),
                stderr: String::new(),
            }),
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: "Logged in".into(),
                stderr: String::new(),
            }),
        ]);
        let diagnostic = registry
            .diagnose_resolved(
                AgentAdapterKind::Codex,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
                    search_path: None,
                },
                PathBuf::from("/bin/codex"),
                &runner,
            )
            .await;
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Ready);
        let requests = runner.requests.lock().unwrap();
        assert_eq!(requests[1].arguments, vec!["login", "status"]);
        assert!(
            requests
                .iter()
                .all(|request| !request.arguments.iter().any(|arg| arg == "exec"))
        );
    }

    #[tokio::test]
    async fn diagnostic_runner_failures_are_unknown_not_authenticated() {
        let registry = AdapterRuntimeRegistry;
        let runner = FakeRunner::new(vec![
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: "codex-cli 1".into(),
                stderr: String::new(),
            }),
            Err("adapter diagnostic timed out".into()),
        ]);
        let diagnostic = registry
            .diagnose_resolved(
                AgentAdapterKind::Codex,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
                    search_path: None,
                },
                PathBuf::from("/bin/codex"),
                &runner,
            )
            .await;
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unknown);
        assert_eq!(diagnostic.authenticated, None);
    }

    #[test]
    fn acp_launch_runs_the_users_cli_through_the_official_adapter() {
        let installed = |name: &str| InstalledAdapter {
            version: "1.0.0".into(),
            dir: PathBuf::from("/adapters").join(name),
            entry: PathBuf::from("/adapters").join(name).join("index.js"),
        };
        let launch = AdapterRuntimeRegistry
            .acp_launch(
                AgentAdapterKind::ClaudeCode,
                Path::new("/bin/claude"),
                Some((Path::new("/bin/node"), &installed("claude-agent-acp"))),
                Path::new("/project"),
            )
            .unwrap();
        assert_eq!(launch.agent, "claude-code");
        assert_eq!(launch.program, PathBuf::from("/bin/node"));
        assert_eq!(launch.args, ["/adapters/claude-agent-acp/index.js"]);
        assert_eq!(
            launch.env.get("CLAUDE_CODE_EXECUTABLE").map(String::as_str),
            Some("/bin/claude")
        );
        assert!(launch.acp_id_is_native);
        assert!(launch.lists_catalog);
        assert!(launch.read_only_open);
        assert!(launch.reads_during_external_turn);
        assert_eq!(launch.writer_refusal, None);
        assert_eq!(launch.draft_session, DraftSession::Traceless);

        let codex = AdapterRuntimeRegistry
            .acp_launch(
                AgentAdapterKind::Codex,
                Path::new("/bin/codex"),
                Some((Path::new("/bin/node"), &installed("codex-acp"))),
                Path::new("/project"),
            )
            .unwrap();
        assert!(codex.acp_id_is_native);
        assert!(codex.lists_catalog);
        assert!(codex.read_only_open);
        assert!(codex.reads_during_external_turn);
        assert_eq!(codex.draft_session, DraftSession::Traceless);
        assert_eq!(
            codex.writer_refusal.as_deref(),
            Some("thread_active_writer")
        );
        assert!(!codex.session_per_connection);

        let pi = AdapterRuntimeRegistry
            .acp_launch(
                AgentAdapterKind::Pi,
                Path::new("/bin/pi"),
                Some((Path::new("/bin/node"), &installed("pi-acp"))),
                Path::new("/project"),
            )
            .unwrap();
        assert_eq!(pi.program, PathBuf::from("/bin/node"));
        assert_eq!(
            pi.env.get("PI_ACP_PI_COMMAND").map(String::as_str),
            Some("/bin/pi")
        );
        assert!(pi.acp_id_is_native);
        assert!(pi.lists_catalog);
        assert!(pi.session_per_connection);
        // E6: pi's draft session is deleted on release.
        assert_eq!(pi.draft_session, DraftSession::Deleted);
        // An adapter entrypoint does not start without its Node.js.
        assert_eq!(
            AdapterRuntimeRegistry.acp_launch(
                AgentAdapterKind::Pi,
                Path::new("/bin/pi"),
                None,
                Path::new("/project"),
            ),
            None
        );
    }

    #[test]
    fn opencode_cursor_and_hermes_run_their_own_acp_command() {
        for (agent, executable, native) in [
            (AgentAdapterKind::Opencode, "/bin/opencode", true),
            (AgentAdapterKind::Cursor, "/bin/cursor-agent", false),
            (AgentAdapterKind::Hermes, "/bin/hermes", true),
        ] {
            assert_eq!(
                AdapterRuntimeRegistry.acp_entrypoint(agent),
                Some(AcpEntrypoint::Command { args: &["acp"] })
            );
            let launch = AdapterRuntimeRegistry
                .acp_launch(agent, Path::new(executable), None, Path::new("/home"))
                .unwrap();
            assert_eq!(launch.program, PathBuf::from(executable));
            assert_eq!(launch.args, ["acp"]);
            assert!(launch.env.is_empty());
            // Hermes lists its sessions from its own store (slice 8.1).
            assert_eq!(
                launch.lists_catalog,
                agent != AgentAdapterKind::Hermes,
                "{agent:?}"
            );
            assert_eq!(launch.acp_id_is_native, native, "{agent:?}");
            assert!(launch.read_only_open);
            assert_eq!(launch.writer_refusal, None);
            assert!(!launch.session_per_connection);
            assert_eq!(
                launch.draft_session,
                AdapterRuntimeRegistry.draft_session(agent).session,
                "{agent:?}"
            );
        }
        // A native id of Cursor is a terminal chat; its ACP sessions have
        // none (slice 8.4).
        assert_eq!(
            AdapterRuntimeRegistry.terminal_resume_args(AgentAdapterKind::Cursor, "s1"),
            Some(vec!["--resume".to_string(), "s1".to_string()])
        );
        for agent in [AgentAdapterKind::Opencode, AgentAdapterKind::Pi] {
            assert_eq!(
                AdapterRuntimeRegistry.terminal_resume_args(agent, "s1"),
                Some(vec!["--session".to_string(), "s1".to_string()])
            );
        }
        assert_eq!(
            AdapterRuntimeRegistry.terminal_resume_args(AgentAdapterKind::Hermes, "s1"),
            Some(vec!["--resume".to_string(), "s1".to_string()])
        );
    }

    #[test]
    fn hermes_lists_every_origin_from_its_profiles_and_resumes_in_one() {
        let registry = AdapterRuntimeRegistry;
        assert_eq!(
            registry.catalog_sources(AgentAdapterKind::Hermes),
            [CatalogSource::Native(NativeCatalogStore::HermesStates)]
        );
        assert!(!registry.lists_catalog(AgentAdapterKind::Hermes));
        assert_eq!(
            registry.native_status_store(AgentAdapterKind::Hermes),
            Some(NativeStatusStore::HermesStates)
        );
        assert_eq!(
            registry.terminal_profile_args(AgentAdapterKind::Hermes, "work"),
            Some(vec!["-p".to_string(), "work".to_string()])
        );
        assert_eq!(
            registry.terminal_profile_args(AgentAdapterKind::Codex, "work"),
            None
        );
        for agent in AgentAdapterKind::ALL {
            let sources = registry.catalog_sources(agent);
            assert_eq!(
                registry.lists_catalog(agent),
                sources.contains(&CatalogSource::AcpList),
                "{agent:?}"
            );
        }
    }

    #[test]
    fn cursor_lists_its_acp_sessions_its_terminal_chats_and_its_ide_chats_apart() {
        let registry = AdapterRuntimeRegistry;
        assert_eq!(
            registry.catalog_sources(AgentAdapterKind::Cursor),
            [
                CatalogSource::AcpList,
                CatalogSource::Native(NativeCatalogStore::CursorChats),
                CatalogSource::Native(NativeCatalogStore::CursorIde)
            ]
        );
        assert!(registry.lists_catalog(AgentAdapterKind::Cursor));
        assert!(!registry.acp_id_is_native(AgentAdapterKind::Cursor));
        // The store tells no turn of a chat (Stage 10 `07` N7).
        assert_eq!(registry.native_status_store(AgentAdapterKind::Cursor), None);
    }

    #[test]
    fn opencode_declares_its_database_as_the_status_store_beside_its_acp_list() {
        let agent = AgentAdapterKind::Opencode;
        assert_eq!(
            AdapterRuntimeRegistry.native_status_store(agent),
            Some(NativeStatusStore::OpencodeDb)
        );
        assert!(AdapterRuntimeRegistry.lists_catalog(agent));
        assert!(AdapterRuntimeRegistry.acp_id_is_native(agent));
    }

    #[test]
    fn only_claude_code_codex_and_qwen_code_read_a_session_during_an_external_turn() {
        for agent in AgentAdapterKind::ALL {
            assert_eq!(
                AdapterRuntimeRegistry.reads_during_external_turn(agent),
                matches!(
                    agent,
                    AgentAdapterKind::ClaudeCode
                        | AgentAdapterKind::Codex
                        | AgentAdapterKind::QwenCode
                ),
                "{agent:?}"
            );
        }
        for (agent, executable) in [
            (AgentAdapterKind::Hermes, "/bin/hermes"),
            (AgentAdapterKind::GrokBuild, "/bin/grok"),
            (AgentAdapterKind::QwenCode, "/bin/qwen"),
        ] {
            let launch = AdapterRuntimeRegistry
                .acp_launch(agent, Path::new(executable), None, Path::new("/home"))
                .unwrap();
            assert_eq!(
                launch.reads_during_external_turn,
                agent == AgentAdapterKind::QwenCode,
                "{agent:?}"
            );
        }
    }

    #[test]
    fn only_hermes_keeps_a_loaded_session_in_its_process() {
        for agent in AgentAdapterKind::ALL {
            assert_eq!(
                AdapterRuntimeRegistry.keeps_loaded_sessions(agent),
                agent == AgentAdapterKind::Hermes,
                "{agent:?}"
            );
        }
        for (agent, executable) in [
            (AgentAdapterKind::Hermes, "/bin/hermes"),
            (AgentAdapterKind::Opencode, "/bin/opencode"),
            (AgentAdapterKind::GrokBuild, "/bin/grok"),
        ] {
            let launch = AdapterRuntimeRegistry
                .acp_launch(agent, Path::new(executable), None, Path::new("/home"))
                .unwrap();
            assert_eq!(
                launch.keeps_loaded_sessions,
                agent == AgentAdapterKind::Hermes,
                "{agent:?}"
            );
        }
    }

    #[test]
    fn grok_build_runs_its_agent_over_stdio_with_native_ids() {
        let agent = AgentAdapterKind::GrokBuild;
        assert_eq!(
            AdapterRuntimeRegistry.acp_entrypoint(agent),
            Some(AcpEntrypoint::Command {
                args: &["agent", "stdio"]
            })
        );
        let launch = AdapterRuntimeRegistry
            .acp_launch(agent, Path::new("/bin/grok"), None, Path::new("/home"))
            .unwrap();
        assert_eq!(launch.program, PathBuf::from("/bin/grok"));
        assert_eq!(launch.args, ["agent", "stdio"]);
        assert!(launch.env.is_empty());
        assert!(launch.lists_catalog);
        assert!(launch.acp_id_is_native);
        assert!(launch.read_only_open);
        assert_eq!(launch.writer_refusal, None);
        assert!(!launch.session_per_connection);
        assert_eq!(
            AdapterRuntimeRegistry.terminal_resume_args(agent, "s1"),
            Some(vec!["--resume".to_string(), "s1".to_string()])
        );
        assert_eq!(
            AdapterRuntimeRegistry.verdict(agent),
            AgentVerdict::Supported
        );
        assert_eq!(
            AdapterRuntimeRegistry.sign_in_arguments(agent),
            Some(vec!["login".to_string()])
        );
    }

    #[test]
    fn draft_sessions_follow_the_recorded_evidence_of_each_agent() {
        use AgentAdapterKind::*;
        for (agent, expected) in [
            (Codex, DraftSession::Traceless),
            (ClaudeCode, DraftSession::Traceless),
            (Hermes, DraftSession::Traceless),
            (QwenCode, DraftSession::FixedValues),
            (Pi, DraftSession::Deleted),
            (KimiCode, DraftSession::Deleted),
            (Opencode, DraftSession::Deleted),
            (GrokBuild, DraftSession::Unsupported),
            (Cursor, DraftSession::Unsupported),
        ] {
            let evidence = AdapterRuntimeRegistry.draft_session(agent);
            assert_eq!(evidence.session, expected, "{agent:?}");
            // Each record names the evidence and the version it was seen on.
            assert!(evidence.evidence.starts_with("E6:"), "{agent:?}");
        }
        assert!(DraftSession::Traceless.changes_values());
        assert!(DraftSession::Deleted.changes_values() && DraftSession::Deleted.deletes());
        assert!(!DraftSession::FixedValues.changes_values());
        assert!(DraftSession::FixedValues.opens());
        assert!(!DraftSession::Unsupported.opens());
    }

    #[test]
    fn qwen_code_runs_its_acp_flag_with_native_ids_listed_by_folder() {
        let agent = AgentAdapterKind::QwenCode;
        let launch = AdapterRuntimeRegistry
            .acp_launch(agent, Path::new("/bin/qwen"), None, Path::new("/home"))
            .unwrap();
        assert_eq!(launch.program, PathBuf::from("/bin/qwen"));
        assert_eq!(launch.args, ["--acp"]);
        assert!(launch.env.is_empty());
        assert!(launch.lists_catalog);
        assert!(AdapterRuntimeRegistry.lists_by_folder(agent));
        assert!(!AdapterRuntimeRegistry.lists_by_folder(AgentAdapterKind::GrokBuild));
        assert!(launch.acp_id_is_native);
        assert!(launch.read_only_open);
        assert_eq!(launch.writer_refusal, None);
        assert!(!launch.session_per_connection);
        assert_eq!(launch.draft_session, DraftSession::FixedValues);
        assert_eq!(
            AdapterRuntimeRegistry.terminal_resume_args(agent, "s1"),
            Some(vec!["--resume".to_string(), "s1".to_string()])
        );
        assert_eq!(
            AdapterRuntimeRegistry.verdict(agent),
            AgentVerdict::Supported
        );
        assert_eq!(
            AdapterRuntimeRegistry.sign_in_arguments(agent),
            Some(vec!["--auth-type=openai".to_string()])
        );
    }

    #[test]
    fn kimi_code_runs_its_acp_command_with_native_ids_listed_across_folders() {
        let agent = AgentAdapterKind::KimiCode;
        let launch = AdapterRuntimeRegistry
            .acp_launch(agent, Path::new("/bin/kimi"), None, Path::new("/home"))
            .unwrap();
        assert_eq!(launch.program, PathBuf::from("/bin/kimi"));
        assert_eq!(launch.args, ["acp"]);
        assert!(launch.env.is_empty());
        assert!(launch.lists_catalog);
        assert!(!AdapterRuntimeRegistry.lists_by_folder(agent));
        assert!(launch.acp_id_is_native);
        assert!(launch.read_only_open);
        assert!(!launch.reads_during_external_turn);
        assert_eq!(launch.writer_refusal, None);
        assert!(!launch.session_per_connection);
        assert_eq!(launch.draft_session, DraftSession::Deleted);
        assert_eq!(AdapterRuntimeRegistry.native_status_store(agent), None);
        assert_eq!(
            AdapterRuntimeRegistry.terminal_resume_args(agent, "s1"),
            Some(vec!["--session".to_string(), "s1".to_string()])
        );
        assert_eq!(
            AdapterRuntimeRegistry.verdict(agent),
            AgentVerdict::Supported
        );
        assert_eq!(
            AdapterRuntimeRegistry.sign_in_arguments(agent),
            Some(vec!["acp".to_string(), "--login".to_string()])
        );
    }

    #[tokio::test]
    async fn grok_build_reads_its_version_and_has_unknown_sign_in() {
        let runner = FakeRunner::new(vec![Ok(RuntimeCommandOutput {
            exit_code: Some(0),
            stdout: "grok 1.0.46 (2765805b9442) [stable]\n".into(),
            stderr: String::new(),
        })]);
        let diagnostic = AdapterRuntimeRegistry
            .diagnose_resolved(
                AgentAdapterKind::GrokBuild,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
                    search_path: None,
                },
                PathBuf::from("/bin/grok"),
                &runner,
            )
            .await;
        assert_eq!(
            crate::adapters::parse_version(diagnostic.version.as_deref().unwrap()),
            Some((1, 0, 46))
        );
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unknown);
        assert_eq!(diagnostic.authenticated, None);
        assert_eq!(runner.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_limited_agent_names_its_restrictions_main_first() {
        let registry = AdapterRuntimeRegistry;
        assert_eq!(
            registry.verdict(AgentAdapterKind::Opencode),
            AgentVerdict::Supported
        );
        assert_eq!(
            serde_json::to_value(registry.verdict(AgentAdapterKind::Cursor)).unwrap(),
            serde_json::json!({
                "state": "limited",
                "restrictions": ["no_terminal_continuation"]
            })
        );
        assert_eq!(
            serde_json::to_value(registry.verdict(AgentAdapterKind::Pi)).unwrap(),
            serde_json::json!({
                "state": "limited",
                "restrictions": ["no_permission_requests", "turn_errors_hidden"]
            })
        );
        assert_eq!(
            registry.verdict(AgentAdapterKind::Hermes),
            AgentVerdict::Supported
        );
        for agent in [
            AgentAdapterKind::Opencode,
            AgentAdapterKind::Cursor,
            AgentAdapterKind::Pi,
        ] {
            assert!(registry.sign_in_arguments(agent).is_some(), "{agent:?}");
        }
        assert_eq!(
            registry.sign_in_arguments(AgentAdapterKind::Hermes),
            Some(vec!["acp".to_string(), "--setup".to_string()])
        );
    }

    #[tokio::test]
    async fn hermes_version_is_the_release_date_it_prints() {
        for (output, version) in [
            (
                "Hermes Agent vgit.7cd77b4 (2026.9.24) · upstream 330d9d6d\nInstall method: git\n",
                "2026.9.24",
            ),
            ("Hermes Agent v0.18.2+3 (2026.9.24)\n", "2026.9.24"),
        ] {
            let runner = FakeRunner::new(vec![Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: output.into(),
                stderr: String::new(),
            })]);
            let diagnostic = AdapterRuntimeRegistry
                .diagnose_resolved(
                    AgentAdapterKind::Hermes,
                    &AdapterTarget {
                        cwd: PathBuf::from("/project"),
                        search_path: None,
                    },
                    PathBuf::from("/bin/hermes"),
                    &runner,
                )
                .await;
            assert_eq!(diagnostic.version.as_deref(), Some(version));
            assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unknown);
        }
    }

    #[tokio::test]
    async fn cursor_sign_in_is_read_from_its_status_json_not_its_exit_code() {
        let status = |stdout: &str| {
            Ok(RuntimeCommandOutput {
                exit_code: Some(0),
                stdout: stdout.into(),
                stderr: String::new(),
            })
        };
        let version = || status("2026.10.01-e373342");
        for (output, expected) in [
            (
                status(r#"{"status":"authenticated","isAuthenticated":true}"#),
                AdapterDiagnosticStatus::Ready,
            ),
            (
                status(r#"{"status":"unauthenticated","isAuthenticated":false}"#),
                AdapterDiagnosticStatus::Unauthenticated,
            ),
            (status("Not logged in"), AdapterDiagnosticStatus::Unknown),
        ] {
            let runner = FakeRunner::new(vec![version(), output]);
            let diagnostic = AdapterRuntimeRegistry
                .diagnose_resolved(
                    AgentAdapterKind::Cursor,
                    &AdapterTarget {
                        cwd: PathBuf::from("/project"),
                        search_path: None,
                    },
                    PathBuf::from("/bin/cursor-agent"),
                    &runner,
                )
                .await;
            assert_eq!(diagnostic.status, expected);
            assert_eq!(
                runner.requests.lock().unwrap()[1].arguments,
                ["status", "--format", "json"]
            );
        }
    }

    #[tokio::test]
    async fn an_agent_without_a_sign_in_command_has_unknown_sign_in() {
        let runner = FakeRunner::new(vec![Ok(RuntimeCommandOutput {
            exit_code: Some(0),
            stdout: "1.18.31".into(),
            stderr: String::new(),
        })]);
        let diagnostic = AdapterRuntimeRegistry
            .diagnose_resolved(
                AgentAdapterKind::Opencode,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
                    search_path: None,
                },
                PathBuf::from("/bin/opencode"),
                &runner,
            )
            .await;
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unknown);
        assert_eq!(diagnostic.authenticated, None);
        assert_eq!(diagnostic.version.as_deref(), Some("1.18.31"));
        assert_eq!(runner.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn serde_contract_uses_stable_adapter_values() {
        assert_eq!(
            serde_json::to_value(AgentAdapterKind::ClaudeCode).unwrap(),
            serde_json::json!("claude-code")
        );
    }
}
