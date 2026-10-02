//! Runtime plane of the agent adapter registry: model and effort selectors,
//! binding validation, approval mapping, launch plans, pre-start selection,
//! version/auth diagnostics and ACP entrypoint descriptions. The identity
//! plane (adapter ids, source policies, executable resolution) stays in
//! `svode_core::agent_adapters`.

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
use crate::process;
use crate::runtime::{AcpLaunch, SettingValue};
use svode_core::agent_actors::{AgentAdapter, ApprovalMode};
use svode_core::agent_adapters::{AgentAdapterKind, resolve_space_executable, system_home_dir};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DIAGNOSTIC_OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterSelectOption {
    pub value: Option<String>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRuntimeDescriptor {
    pub id: AgentAdapterKind,
    pub label: String,
    pub model_options: Vec<AdapterSelectOption>,
    pub default_model_label: String,
    pub default_effort_label: String,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingValidationStatus {
    Valid,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingValidationIssue {
    pub code: String,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingValidation {
    pub status: BindingValidationStatus,
    pub issues: Vec<BindingValidationIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeApprovalMode {
    CodexUserReview,
    CodexAutoReview,
    CodexFullAccess,
    ClaudeDefault,
    ClaudeAuto,
    ClaudeBypassPermissions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalMapping {
    pub requested: ApprovalMode,
    pub native: NativeApprovalMode,
    pub label: String,
    pub effective_boundary: String,
    pub danger: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptTransport {
    ManagedPtyInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLaunchMetadata {
    pub resume_supported: bool,
    pub cancel_via_managed_pty: bool,
    pub prompt_transport: PromptTransport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedAgentLaunch {
    pub adapter: AgentAdapterKind,
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub approval: ApprovalMapping,
    pub requested_model: Option<String>,
    pub requested_effort: Option<String>,
    pub session: AgentSessionLaunchMetadata,
    pub launch_id: Option<String>,
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualRoutineLaunchInput {
    pub instruction: String,
    pub launch_id: String,
    pub owner_kind: String,
    pub owner_path: String,
    pub event_context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchRequest {
    pub actor_reference: String,
    pub actor_owner_path: String,
    pub launch_space_path: String,
    pub binding: AgentAdapter,
    pub approval_mode: ApprovalMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreStartBindingAttempt {
    pub binding_index: usize,
    pub adapter: AgentAdapterKind,
    pub eligible: bool,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreStartSelection {
    pub selected_binding_index: Option<usize>,
    pub attempts: Vec<PreStartBindingAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedRuntimeProvenance {
    pub actor_reference: String,
    pub actor_owner_path: String,
    pub requested_binding_index: usize,
    pub requested_adapter: AgentAdapterKind,
    pub requested_model: Option<String>,
    pub requested_effort: Option<String>,
    pub requested_approval_mode: ApprovalMode,
    pub actual_adapter: AgentAdapterKind,
    pub actual_model: Option<String>,
    pub actual_effort: Option<String>,
    pub native_approval_mode: NativeApprovalMode,
    pub launch_space_path: String,
    pub cwd: String,
    pub pre_start_fallback_reason: Option<String>,
    pub fallback: FallbackAfterStart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackAfterStart {
    Forbidden,
}

/// The runtime plane of the adapter registry. Stateless; the identity plane
/// is `svode_core::agent_adapters::AgentAdapterRegistry`.
#[derive(Debug, Default, Clone, Copy)]
pub struct AdapterRuntimeRegistry;

impl AdapterRuntimeRegistry {
    pub fn descriptors(&self) -> Vec<AdapterRuntimeDescriptor> {
        [AgentAdapterKind::Codex, AgentAdapterKind::ClaudeCode]
            .into_iter()
            .map(descriptor)
            .collect()
    }

    pub fn effort_options(
        &self,
        adapter: AgentAdapterKind,
        model: Option<&str>,
    ) -> Vec<AdapterSelectOption> {
        effort_options(adapter, model)
    }

    pub fn validate_binding(&self, binding: &AgentAdapter) -> BindingValidation {
        validate_binding(binding)
    }

    pub fn approval_mapping(
        &self,
        adapter: AgentAdapterKind,
        mode: ApprovalMode,
    ) -> ApprovalMapping {
        approval_mapping(adapter, mode)
    }

    pub fn build_launch(
        &self,
        request: &AgentLaunchRequest,
        executable_path: &Path,
    ) -> Result<TypedAgentLaunch, BindingValidation> {
        let validation = validate_binding(&request.binding);
        if validation.status == BindingValidationStatus::Unavailable {
            return Err(validation);
        }
        Ok(build_launch(request, executable_path))
    }

    pub fn build_manual_routine_launch(
        &self,
        request: &AgentLaunchRequest,
        executable_path: &Path,
        input: &ManualRoutineLaunchInput,
    ) -> Result<TypedAgentLaunch, BindingValidation> {
        let mut launch = self.build_launch(request, executable_path)?;
        let prompt = manual_routine_prompt(input);
        match launch.adapter {
            AgentAdapterKind::Codex => launch.argv.push(prompt),
            AgentAdapterKind::ClaudeCode => {
                let source_session_id = new_uuid_v4();
                launch
                    .argv
                    .extend(["--session-id".into(), source_session_id.clone(), prompt]);
                launch.source_session_id = Some(source_session_id);
            }
        }
        launch.launch_id = Some(input.launch_id.clone());
        Ok(launch)
    }

    pub fn select_pre_start(
        &self,
        bindings: &[AgentAdapter],
        diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
    ) -> PreStartSelection {
        select_pre_start(bindings, diagnostics, |_| None)
    }

    /// Pre-start selection for an ACP launch: a binding whose agent has no
    /// equivalent of the Actor's approval mode is skipped like any other
    /// unavailable binding, never downgraded.
    pub fn select_acp_pre_start(
        &self,
        bindings: &[AgentAdapter],
        approval_mode: ApprovalMode,
        diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
    ) -> PreStartSelection {
        select_pre_start(bindings, diagnostics, |adapter| {
            acp_approval(adapter, approval_mode)
                .is_none()
                .then(|| "approval_mapping_missing".to_string())
        })
    }

    /// The session setting value an Actor approval maps to when the agent
    /// runs over ACP. An ACP launch applies it after creating the session
    /// and before the first prompt. `None`: the agent has no equivalent.
    pub fn acp_approval(
        &self,
        adapter: AgentAdapterKind,
        mode: ApprovalMode,
    ) -> Option<SettingValue> {
        acp_approval(adapter, mode)
    }

    pub fn mark_started(
        &self,
        request: &AgentLaunchRequest,
        selected_binding_index: usize,
        actual_model: Option<String>,
        actual_effort: Option<String>,
        pre_start_fallback_reason: Option<String>,
    ) -> StartedRuntimeProvenance {
        let adapter = request.binding.adapter;
        StartedRuntimeProvenance {
            actor_reference: request.actor_reference.clone(),
            actor_owner_path: request.actor_owner_path.clone(),
            requested_binding_index: selected_binding_index,
            requested_adapter: adapter,
            requested_model: request.binding.model.clone(),
            requested_effort: request.binding.effort.clone(),
            requested_approval_mode: request.approval_mode,
            actual_adapter: adapter,
            actual_model,
            actual_effort,
            native_approval_mode: approval_mapping(adapter, request.approval_mode).native,
            launch_space_path: request.launch_space_path.clone(),
            cwd: request.launch_space_path.clone(),
            pre_start_fallback_reason,
            fallback: FallbackAfterStart::Forbidden,
        }
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

    /// The output of the executable's bounded `--version`.
    pub async fn cli_version(
        &self,
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
            output if output.exit_code == Some(0) && !output.stdout.is_empty() => Ok(output.stdout),
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
        let version = match self.cli_version(&path, target, runner).await {
            Ok(version) => version,
            Err(error) => {
                return unknown_diagnostic_with_path(adapter, &path, "version_failed", error);
            }
        };
        let auth_arguments = match adapter {
            AgentAdapterKind::Codex => vec!["login".into(), "status".into()],
            AgentAdapterKind::ClaudeCode => {
                vec!["auth".into(), "status".into(), "--json".into()]
            }
        };
        match runner
            .run(&RuntimeCommandRequest {
                program: path.clone(),
                arguments: auth_arguments,
                cwd: target.cwd.clone(),
                search_path: target.search_path.clone(),
            })
            .await
        {
            Ok(output) if output.exit_code == Some(0) => AdapterDiagnostic {
                adapter,
                status: AdapterDiagnosticStatus::Ready,
                executable_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                authenticated: Some(true),
                code: None,
                message: None,
            },
            Ok(output) => AdapterDiagnostic {
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

/// The official ACP adapter of a registry agent and the variable through
/// which the adapter runs the user's own CLI, so terminal and UI sessions
/// share one auth, configuration and session store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpEntrypoint {
    pub adapter: &'static AdapterPin,
    pub executable_env: &'static str,
}

impl AdapterRuntimeRegistry {
    pub fn acp_entrypoint(&self, adapter: AgentAdapterKind) -> AcpEntrypoint {
        match adapter {
            AgentAdapterKind::Codex => AcpEntrypoint {
                adapter: adapter_pin(adapter).expect("Codex runs through its adapter"),
                executable_env: "CODEX_PATH",
            },
            AgentAdapterKind::ClaudeCode => AcpEntrypoint {
                adapter: adapter_pin(adapter).expect("Claude Code runs through its adapter"),
                executable_env: "CLAUDE_CODE_EXECUTABLE",
            },
        }
    }

    /// Whether the agent's `session/list` is its one declared catalogue
    /// source. E01: the lists of Codex and Claude Code cover the sessions
    /// of the CLI, IDE and the provider's desktop app; records the
    /// transitional scanners also find stay one session per key. Both are
    /// listed without `cwd`: their filter matches the exact directory only,
    /// so it would drop sessions in a Space's subfolders.
    pub fn lists_catalog(&self, adapter: AgentAdapterKind) -> bool {
        match adapter {
            AgentAdapterKind::Codex | AgentAdapterKind::ClaudeCode => true,
        }
    }

    /// Whether the agent's ACP `sessionId` is its native session id. E01:
    /// every listed id of Codex is the rollout `session_meta.id` and every
    /// listed id of Claude Code is the jsonl session UUID.
    pub fn acp_id_is_native(&self, adapter: AgentAdapterKind) -> bool {
        match adapter {
            AgentAdapterKind::Codex | AgentAdapterKind::ClaudeCode => true,
        }
    }

    /// Launch plan of the installed adapter, run by the user's Node.js, for
    /// the user's executable.
    pub fn acp_launch(
        &self,
        adapter: AgentAdapterKind,
        node: &Path,
        installed: &InstalledAdapter,
        executable: &Path,
        cwd: &Path,
    ) -> AcpLaunch {
        let entrypoint = self.acp_entrypoint(adapter);
        AcpLaunch {
            agent: adapter.as_str().to_string(),
            program: node.to_path_buf(),
            args: vec![installed.entry.to_string_lossy().into_owned()],
            environment: None,
            env: BTreeMap::from([(
                entrypoint.executable_env.to_string(),
                executable.to_string_lossy().into_owned(),
            )]),
            cwd: cwd.to_path_buf(),
            acp_id_is_native: self.acp_id_is_native(adapter),
            lists_catalog: self.lists_catalog(adapter),
            // E01: load and close of both agents change their store only
            // in service records, which Svode accepts.
            read_only_open: true,
            writer_refusal: match adapter {
                AgentAdapterKind::Codex => Some("thread_active_writer".into()),
                // Claude loads a session another process writes to.
                AgentAdapterKind::ClaudeCode => None,
            },
        }
    }
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

fn descriptor(id: AgentAdapterKind) -> AdapterRuntimeDescriptor {
    let (label, models) = match id {
        AgentAdapterKind::Codex => (
            "Codex",
            [
                ("gpt-5.6", "GPT-5.6 (recommended alias)"),
                ("gpt-5.6-sol", "GPT-5.6 Sol"),
                ("gpt-5.6-terra", "GPT-5.6 Terra"),
                ("gpt-5.6-luna", "GPT-5.6 Luna"),
            ]
            .as_slice(),
        ),
        AgentAdapterKind::ClaudeCode => (
            "Claude Code",
            [
                ("sonnet", "Sonnet (latest alias)"),
                ("opus", "Opus (latest alias)"),
                ("haiku", "Haiku (latest alias)"),
            ]
            .as_slice(),
        ),
    };
    AdapterRuntimeDescriptor {
        id,
        label: label.into(),
        model_options: std::iter::once(AdapterSelectOption {
            value: None,
            label: "Client default".into(),
        })
        .chain(models.iter().map(|(value, label)| AdapterSelectOption {
            value: Some((*value).into()),
            label: (*label).into(),
        }))
        .collect(),
        default_model_label: "Client default".into(),
        default_effort_label: "Client default".into(),
    }
}

fn effort_options(adapter: AgentAdapterKind, model: Option<&str>) -> Vec<AdapterSelectOption> {
    let values: &[&str] = match adapter {
        AgentAdapterKind::Codex => &["none", "low", "medium", "high", "xhigh", "max"],
        AgentAdapterKind::ClaudeCode if model == Some("haiku") => &[],
        AgentAdapterKind::ClaudeCode => &["low", "medium", "high"],
    };
    std::iter::once(AdapterSelectOption {
        value: None,
        label: "Client default".into(),
    })
    .chain(values.iter().map(|value| AdapterSelectOption {
        value: Some((*value).into()),
        label: title_case(value),
    }))
    .collect()
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn validate_binding(binding: &AgentAdapter) -> BindingValidation {
    let adapter = binding.adapter;
    let descriptor = descriptor(adapter);
    let mut issues = Vec::new();
    if let Some(model) = binding.model.as_deref()
        && !descriptor
            .model_options
            .iter()
            .any(|option| option.value.as_deref() == Some(model))
    {
        issues.push(BindingValidationIssue {
            code: "unknown_model_selector".into(),
            field: "model".into(),
            message: format!("{model} is not a supported {adapter:?} model selector"),
        });
    }
    if let Some(effort) = binding.effort.as_deref()
        && !effort_options(adapter, binding.model.as_deref())
            .iter()
            .any(|option| option.value.as_deref() == Some(effort))
    {
        issues.push(BindingValidationIssue {
            code: "unknown_effort_selector".into(),
            field: "effort".into(),
            message: format!("{effort} is not supported for this adapter/model"),
        });
    }
    BindingValidation {
        status: if issues.is_empty() {
            BindingValidationStatus::Valid
        } else {
            BindingValidationStatus::Unavailable
        },
        issues,
    }
}

fn select_pre_start(
    bindings: &[AgentAdapter],
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
    transport_issue: impl Fn(AgentAdapterKind) -> Option<String>,
) -> PreStartSelection {
    let mut selected = None;
    let attempts = bindings
        .iter()
        .enumerate()
        .map(|(index, binding)| {
            let adapter = binding.adapter;
            let validation = validate_binding(binding);
            let diagnostic = diagnostics.get(&adapter);
            let reason_code = validation
                .issues
                .first()
                .map(|issue| issue.code.clone())
                .or_else(|| transport_issue(adapter))
                .or_else(|| match diagnostic.map(|value| value.status) {
                    Some(AdapterDiagnosticStatus::Ready) => None,
                    Some(AdapterDiagnosticStatus::Missing) => Some("adapter_missing".into()),
                    Some(AdapterDiagnosticStatus::Unauthenticated) => {
                        Some("adapter_unauthenticated".into())
                    }
                    Some(AdapterDiagnosticStatus::Unknown) | None => {
                        Some("adapter_unchecked".into())
                    }
                });
            let eligible = reason_code.is_none();
            if eligible && selected.is_none() {
                selected = Some(index);
            }
            PreStartBindingAttempt {
                binding_index: index,
                adapter,
                eligible,
                reason_code,
            }
        })
        .collect();
    PreStartSelection {
        selected_binding_index: selected,
        attempts,
    }
}

/// Live evidence E01 (2026-10-01): claude-agent-acp 0.84.0 with Claude Code
/// 2.1.286 and codex-acp 2.1.0 with codex-cli 0.159.3 declare these values
/// of the config option `mode` (also as legacy modes). Codex `ask` and
/// `auto` match the terminal argv of `build_launch`; a new Codex session
/// starts in `agent`, so the value is always applied.
fn acp_approval(adapter: AgentAdapterKind, mode: ApprovalMode) -> Option<SettingValue> {
    let value = match (adapter, mode) {
        (AgentAdapterKind::Codex, ApprovalMode::Ask) => "workspace-write",
        (AgentAdapterKind::Codex, ApprovalMode::Auto) => "agent",
        (AgentAdapterKind::Codex, ApprovalMode::Full) => "agent-full-access",
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Ask) => "default",
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Auto) => "auto",
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Full) => "bypassPermissions",
    };
    Some(SettingValue {
        setting: "mode".into(),
        value: value.into(),
    })
}

fn approval_mapping(adapter: AgentAdapterKind, mode: ApprovalMode) -> ApprovalMapping {
    match (adapter, mode) {
        (AgentAdapterKind::Codex, ApprovalMode::Ask) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexUserReview,
            label: "Ask".into(),
            effective_boundary: "Codex uses workspace-write and on-request approvals; ordinary in-workspace edits do not necessarily prompt.".into(),
            danger: false,
        },
        (AgentAdapterKind::Codex, ApprovalMode::Auto) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexAutoReview,
            label: "Auto-review".into(),
            effective_boundary: "Codex stays in workspace-write; its automatic reviewer may approve, deny, or still require native policy handling.".into(),
            danger: false,
        },
        (AgentAdapterKind::Codex, ApprovalMode::Full) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexFullAccess,
            label: "Full access".into(),
            effective_boundary: "Codex bypasses approvals and sandboxing; native first-run warnings remain visible.".into(),
            danger: true,
        },
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Ask) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeDefault,
            label: "Ask".into(),
            effective_boundary: "Claude Code uses its native default permission prompts and policy.".into(),
            danger: false,
        },
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Auto) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeAuto,
            label: "Auto-review".into(),
            effective_boundary: "Claude Code auto mode may allow, deny, or prompt according to its native classifier and policy.".into(),
            danger: false,
        },
        (AgentAdapterKind::ClaudeCode, ApprovalMode::Full) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeBypassPermissions,
            label: "Full access".into(),
            effective_boundary: "Claude Code bypasses permission checks; native first-run warnings remain visible.".into(),
            danger: true,
        },
    }
}

fn build_launch(request: &AgentLaunchRequest, executable_path: &Path) -> TypedAgentLaunch {
    let adapter = request.binding.adapter;
    let approval = approval_mapping(adapter, request.approval_mode);
    let mut argv = match approval.native {
        NativeApprovalMode::CodexUserReview => vec![
            "--sandbox".into(),
            "workspace-write".into(),
            "--ask-for-approval".into(),
            "on-request".into(),
            "--config".into(),
            "approvals_reviewer=\"user\"".into(),
        ],
        NativeApprovalMode::CodexAutoReview => vec![
            "--sandbox".into(),
            "workspace-write".into(),
            "--ask-for-approval".into(),
            "on-request".into(),
            "--config".into(),
            "approvals_reviewer=\"auto_review\"".into(),
        ],
        NativeApprovalMode::CodexFullAccess => {
            vec!["--dangerously-bypass-approvals-and-sandbox".into()]
        }
        NativeApprovalMode::ClaudeDefault => {
            vec!["--permission-mode".into(), "default".into()]
        }
        NativeApprovalMode::ClaudeAuto => vec!["--permission-mode".into(), "auto".into()],
        NativeApprovalMode::ClaudeBypassPermissions => {
            vec!["--permission-mode".into(), "bypassPermissions".into()]
        }
    };
    if let Some(model) = &request.binding.model {
        argv.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &request.binding.effort {
        match adapter {
            AgentAdapterKind::Codex => argv.extend([
                "--config".into(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]),
            AgentAdapterKind::ClaudeCode => argv.extend(["--effort".into(), effort.clone()]),
        }
    }
    TypedAgentLaunch {
        adapter,
        program: executable_path.to_string_lossy().into_owned(),
        argv,
        cwd: request.launch_space_path.clone(),
        approval,
        requested_model: request.binding.model.clone(),
        requested_effort: request.binding.effort.clone(),
        session: AgentSessionLaunchMetadata {
            resume_supported: true,
            cancel_via_managed_pty: true,
            prompt_transport: PromptTransport::ManagedPtyInput,
        },
        launch_id: None,
        source_session_id: None,
    }
}

fn manual_routine_prompt(input: &ManualRoutineLaunchInput) -> String {
    let mut prompt = input.instruction.trim().to_string();
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str(&format!(
        "<!-- svode-owner:{}:{} -->\n<!-- svode-launch:{} -->",
        input.owner_kind, input.owner_path, input.launch_id
    ));
    if let Some(context) = input.event_context.as_deref() {
        prompt.push_str("\n<svode-event-context>");
        prompt.push_str(context);
        prompt.push_str("</svode-event-context>");
    }
    prompt
}

fn new_uuid_v4() -> String {
    let mut bytes = ulid::Ulid::new().to_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn binding(
        adapter: AgentAdapterKind,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> AgentAdapter {
        AgentAdapter {
            adapter,
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
        }
    }

    fn request(binding: AgentAdapter, approval_mode: ApprovalMode) -> AgentLaunchRequest {
        AgentLaunchRequest {
            actor_reference: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            actor_owner_path: "/project".into(),
            launch_space_path: "/project/child".into(),
            binding,
            approval_mode,
        }
    }

    #[test]
    fn descriptors_and_unknown_selectors_are_fail_closed_without_mutation() {
        let registry = AdapterRuntimeRegistry;
        let descriptors = registry.descriptors();
        assert_eq!(descriptors.len(), 2);
        assert_eq!(descriptors[0].model_options[0].value, None);
        assert_eq!(
            descriptors[0].model_options[1].value.as_deref(),
            Some("gpt-5.6")
        );
        assert_eq!(
            descriptors[1].model_options[1].value.as_deref(),
            Some("sonnet")
        );

        let unknown = binding(
            AgentAdapterKind::Codex,
            Some("future-model"),
            Some("future-effort"),
        );
        let preserved = unknown.clone();
        let validation = registry.validate_binding(&unknown);
        assert_eq!(validation.status, BindingValidationStatus::Unavailable);
        assert_eq!(validation.issues.len(), 2);
        assert_eq!(unknown, preserved);
    }

    #[test]
    fn launch_argv_snapshots_are_typed_and_prompt_free() {
        let registry = AdapterRuntimeRegistry;
        let codex = registry
            .build_launch(
                &request(
                    binding(
                        AgentAdapterKind::Codex,
                        Some("gpt-5.6-terra"),
                        Some("medium"),
                    ),
                    ApprovalMode::Auto,
                ),
                Path::new("/bin/codex"),
            )
            .unwrap();
        assert_eq!(
            codex.argv,
            vec![
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--config",
                "approvals_reviewer=\"auto_review\"",
                "--model",
                "gpt-5.6-terra",
                "--config",
                "model_reasoning_effort=\"medium\"",
            ]
        );
        assert_eq!(
            codex.session.prompt_transport,
            PromptTransport::ManagedPtyInput
        );

        let claude = registry
            .build_launch(
                &request(
                    binding(AgentAdapterKind::ClaudeCode, Some("sonnet"), Some("high")),
                    ApprovalMode::Ask,
                ),
                Path::new("/bin/claude"),
            )
            .unwrap();
        assert_eq!(
            claude.argv,
            vec![
                "--permission-mode",
                "default",
                "--model",
                "sonnet",
                "--effort",
                "high"
            ]
        );
    }

    #[test]
    fn manual_routine_launch_is_adapter_owned_and_carries_launch_marker() {
        let registry = AdapterRuntimeRegistry;
        let input = ManualRoutineLaunchInput {
            instruction: "Review backlog".into(),
            launch_id: "launch-one".into(),
            owner_kind: "space".into(),
            owner_path: ".".into(),
            event_context: None,
        };
        let codex = registry
            .build_manual_routine_launch(
                &request(
                    binding(AgentAdapterKind::Codex, None, None),
                    ApprovalMode::Ask,
                ),
                Path::new("/bin/codex"),
                &input,
            )
            .unwrap();
        assert_eq!(codex.launch_id.as_deref(), Some("launch-one"));
        assert_eq!(codex.source_session_id, None);
        assert!(
            codex
                .argv
                .last()
                .expect("prompt")
                .contains("<!-- svode-launch:launch-one -->")
        );

        let claude = registry
            .build_manual_routine_launch(
                &request(
                    binding(AgentAdapterKind::ClaudeCode, None, None),
                    ApprovalMode::Ask,
                ),
                Path::new("/bin/claude"),
                &input,
            )
            .unwrap();
        let session_index = claude
            .argv
            .iter()
            .position(|argument| argument == "--session-id")
            .expect("session id argument");
        let session_id = &claude.argv[session_index + 1];
        assert_eq!(
            claude.source_session_id.as_deref(),
            Some(session_id.as_str())
        );
        assert_eq!(session_id.len(), 36);
        assert_eq!(session_id.as_bytes()[14], b'4');
        assert!(matches!(
            session_id.as_bytes()[19],
            b'8' | b'9' | b'a' | b'b'
        ));
    }

    #[test]
    fn event_routine_prompt_carries_typed_context_after_the_instruction() {
        let prompt = manual_routine_prompt(&ManualRoutineLaunchInput {
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
        assert!(prompt.contains("<!-- svode-launch:launch-event -->"));
        assert!(prompt.contains("<svode-event-context>{"));
        assert!(prompt.contains("\"entryPath\":\"tasks/item.md\""));
        assert!(prompt.ends_with("</svode-event-context>"));
    }

    #[test]
    fn full_access_mapping_is_explicit_for_each_adapter() {
        let registry = AdapterRuntimeRegistry;
        let codex = registry.approval_mapping(AgentAdapterKind::Codex, ApprovalMode::Full);
        let claude = registry.approval_mapping(AgentAdapterKind::ClaudeCode, ApprovalMode::Full);
        assert_eq!(codex.native, NativeApprovalMode::CodexFullAccess);
        assert_eq!(claude.native, NativeApprovalMode::ClaudeBypassPermissions);
        assert!(codex.danger && claude.danger);
    }

    #[test]
    fn acp_approval_maps_each_mode_to_the_agent_mode_without_downgrade() {
        let registry = AdapterRuntimeRegistry;
        for (adapter, mode, value) in [
            (
                AgentAdapterKind::Codex,
                ApprovalMode::Ask,
                "workspace-write",
            ),
            (AgentAdapterKind::Codex, ApprovalMode::Auto, "agent"),
            (
                AgentAdapterKind::Codex,
                ApprovalMode::Full,
                "agent-full-access",
            ),
            (AgentAdapterKind::ClaudeCode, ApprovalMode::Ask, "default"),
            (AgentAdapterKind::ClaudeCode, ApprovalMode::Auto, "auto"),
            (
                AgentAdapterKind::ClaudeCode,
                ApprovalMode::Full,
                "bypassPermissions",
            ),
        ] {
            assert_eq!(
                registry.acp_approval(adapter, mode),
                Some(SettingValue {
                    setting: "mode".into(),
                    value: value.into(),
                }),
                "{adapter:?} {mode:?}"
            );
        }
    }

    #[test]
    fn acp_selection_skips_a_binding_without_approval_mapping() {
        let ready = |adapter| AdapterDiagnostic {
            adapter,
            status: AdapterDiagnosticStatus::Ready,
            executable_path: Some("/bin/agent".into()),
            version: Some("1".into()),
            authenticated: Some(true),
            code: None,
            message: None,
        };
        let diagnostics = BTreeMap::from([
            (AgentAdapterKind::Codex, ready(AgentAdapterKind::Codex)),
            (
                AgentAdapterKind::ClaudeCode,
                ready(AgentAdapterKind::ClaudeCode),
            ),
        ]);
        let bindings = vec![
            binding(AgentAdapterKind::Codex, None, None),
            binding(AgentAdapterKind::ClaudeCode, None, None),
        ];
        let mapped = AdapterRuntimeRegistry.select_acp_pre_start(
            &bindings,
            ApprovalMode::Full,
            &diagnostics,
        );
        assert_eq!(mapped.selected_binding_index, Some(0));

        // An agent without an equivalent of the Actor's mode is skipped, the
        // next binding is selected; nothing is downgraded.
        let selection = select_pre_start(&bindings, &diagnostics, |adapter| {
            (adapter == AgentAdapterKind::Codex).then(|| "approval_mapping_missing".to_string())
        });
        assert_eq!(selection.selected_binding_index, Some(1));
        assert!(!selection.attempts[0].eligible);
        assert_eq!(
            selection.attempts[0].reason_code.as_deref(),
            Some("approval_mapping_missing")
        );
    }

    #[test]
    fn approval_mode_argv_snapshots_do_not_silently_downgrade() {
        let registry = AdapterRuntimeRegistry;
        let cases = [
            (
                AgentAdapterKind::Codex,
                ApprovalMode::Ask,
                vec![
                    "--sandbox",
                    "workspace-write",
                    "--ask-for-approval",
                    "on-request",
                    "--config",
                    "approvals_reviewer=\"user\"",
                ],
            ),
            (
                AgentAdapterKind::Codex,
                ApprovalMode::Auto,
                vec![
                    "--sandbox",
                    "workspace-write",
                    "--ask-for-approval",
                    "on-request",
                    "--config",
                    "approvals_reviewer=\"auto_review\"",
                ],
            ),
            (
                AgentAdapterKind::Codex,
                ApprovalMode::Full,
                vec!["--dangerously-bypass-approvals-and-sandbox"],
            ),
            (
                AgentAdapterKind::ClaudeCode,
                ApprovalMode::Ask,
                vec!["--permission-mode", "default"],
            ),
            (
                AgentAdapterKind::ClaudeCode,
                ApprovalMode::Auto,
                vec!["--permission-mode", "auto"],
            ),
            (
                AgentAdapterKind::ClaudeCode,
                ApprovalMode::Full,
                vec!["--permission-mode", "bypassPermissions"],
            ),
        ];
        for (adapter, mode, expected) in cases {
            let launch = registry
                .build_launch(
                    &request(binding(adapter, None, None), mode),
                    Path::new("/bin/client"),
                )
                .unwrap();
            assert_eq!(launch.argv, expected);
        }
    }

    #[test]
    fn selection_falls_back_only_before_runtime_start() {
        let registry = AdapterRuntimeRegistry;
        let bindings = vec![
            binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None),
            binding(AgentAdapterKind::ClaudeCode, Some("sonnet"), None),
        ];
        let diagnostics = BTreeMap::from([
            (
                AgentAdapterKind::Codex,
                AdapterDiagnostic {
                    adapter: AgentAdapterKind::Codex,
                    status: AdapterDiagnosticStatus::Unauthenticated,
                    executable_path: Some("/bin/codex".into()),
                    version: Some("1".into()),
                    authenticated: Some(false),
                    code: Some("adapter_unauthenticated".into()),
                    message: None,
                },
            ),
            (
                AgentAdapterKind::ClaudeCode,
                AdapterDiagnostic {
                    adapter: AgentAdapterKind::ClaudeCode,
                    status: AdapterDiagnosticStatus::Ready,
                    executable_path: Some("/bin/claude".into()),
                    version: Some("2".into()),
                    authenticated: Some(true),
                    code: None,
                    message: None,
                },
            ),
        ]);
        let selection = registry.select_pre_start(&bindings, &diagnostics);
        assert_eq!(selection.selected_binding_index, Some(1));
        let started_request = request(bindings[1].clone(), ApprovalMode::Ask);
        let provenance = registry.mark_started(
            &started_request,
            1,
            Some("claude-sonnet-effective".into()),
            Some("high".into()),
            Some("adapter_unauthenticated".into()),
        );
        assert_eq!(provenance.fallback, FallbackAfterStart::Forbidden);
        assert_eq!(provenance.requested_adapter, AgentAdapterKind::ClaudeCode);
        assert_eq!(provenance.requested_model.as_deref(), Some("sonnet"));
        assert_eq!(provenance.requested_effort, None);
        assert_eq!(provenance.requested_approval_mode, ApprovalMode::Ask);
        assert_eq!(provenance.actual_adapter, AgentAdapterKind::ClaudeCode);
        assert_eq!(
            provenance.actual_model.as_deref(),
            Some("claude-sonnet-effective")
        );
        assert_eq!(provenance.actual_effort.as_deref(), Some("high"));
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
        let launch = AdapterRuntimeRegistry.acp_launch(
            AgentAdapterKind::ClaudeCode,
            Path::new("/bin/node"),
            &installed("claude-agent-acp"),
            Path::new("/bin/claude"),
            Path::new("/project"),
        );
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
        assert_eq!(launch.writer_refusal, None);

        let codex = AdapterRuntimeRegistry.acp_launch(
            AgentAdapterKind::Codex,
            Path::new("/bin/node"),
            &installed("codex-acp"),
            Path::new("/bin/codex"),
            Path::new("/project"),
        );
        assert!(codex.acp_id_is_native);
        assert!(codex.lists_catalog);
        assert!(codex.read_only_open);
        assert_eq!(
            codex.writer_refusal.as_deref(),
            Some("thread_active_writer")
        );
    }

    #[test]
    fn serde_contract_uses_stable_adapter_and_mode_values() {
        let mapping = approval_mapping(AgentAdapterKind::ClaudeCode, ApprovalMode::Auto);
        assert_eq!(
            serde_json::to_value(mapping).unwrap()["native"],
            serde_json::json!("claude_auto")
        );
        assert_eq!(
            serde_json::to_value(AgentAdapterKind::ClaudeCode).unwrap(),
            serde_json::json!("claude-code")
        );
    }
}
