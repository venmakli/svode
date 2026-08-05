use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use super::{
    SupportedAdapterId, SupportedAdapterRegistry, resolve_executable_path, system_home_dir,
};
use crate::agent::types::load_space_agent_config;
use crate::agent_actors::{AgentAdapter, AgentAdapterKind, ApprovalMode};
use crate::process;

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
    pub id: SupportedAdapterId,
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
    pub adapter: SupportedAdapterId,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCommandRequest {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
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
            command
                .args(&request.arguments)
                .current_dir(&request.cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            process::hide_tokio_window(&mut command);
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
                    stdout: bounded_text(&stdout_bytes),
                    stderr: bounded_text(&stderr_bytes),
                })
            })
            .await
            .map_err(|_| "adapter diagnostic timed out".to_string())??;
            Ok(output)
        })
    }
}

fn bounded_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DIAGNOSTIC_OUTPUT_BYTES)])
        .trim()
        .to_string()
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
    pub adapter: SupportedAdapterId,
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub approval: ApprovalMapping,
    pub requested_model: Option<String>,
    pub requested_effort: Option<String>,
    pub session: AgentSessionLaunchMetadata,
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
    pub adapter: SupportedAdapterId,
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
    pub requested_adapter: SupportedAdapterId,
    pub requested_model: Option<String>,
    pub requested_effort: Option<String>,
    pub requested_approval_mode: ApprovalMode,
    pub actual_adapter: SupportedAdapterId,
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

impl SupportedAdapterRegistry {
    pub fn descriptors(&self) -> Vec<AdapterRuntimeDescriptor> {
        [SupportedAdapterId::Codex, SupportedAdapterId::ClaudeCode]
            .into_iter()
            .map(descriptor)
            .collect()
    }

    pub fn effort_options(
        &self,
        adapter: SupportedAdapterId,
        model: Option<&str>,
    ) -> Vec<AdapterSelectOption> {
        effort_options(adapter, model)
    }

    pub fn validate_binding(&self, binding: &AgentAdapter) -> BindingValidation {
        validate_binding(binding)
    }

    pub fn approval_mapping(
        &self,
        adapter: SupportedAdapterId,
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

    pub fn select_pre_start(
        &self,
        bindings: &[AgentAdapter],
        diagnostics: &BTreeMap<SupportedAdapterId, AdapterDiagnostic>,
    ) -> PreStartSelection {
        let mut selected = None;
        let attempts = bindings
            .iter()
            .enumerate()
            .map(|(index, binding)| {
                let adapter = supported_id(binding.adapter);
                let validation = validate_binding(binding);
                let diagnostic = diagnostics.get(&adapter);
                let reason_code = validation
                    .issues
                    .first()
                    .map(|issue| issue.code.clone())
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

    pub fn mark_started(
        &self,
        request: &AgentLaunchRequest,
        selected_binding_index: usize,
        actual_model: Option<String>,
        actual_effort: Option<String>,
        pre_start_fallback_reason: Option<String>,
    ) -> StartedRuntimeProvenance {
        let adapter = supported_id(request.binding.adapter);
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
        adapter: SupportedAdapterId,
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
        let executable_override = target_executable_override(adapter, &target.cwd);
        let Some(path) =
            resolve_executable_path(adapter, executable_override.as_deref(), &home_dir)
        else {
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

    async fn diagnose_resolved(
        &self,
        adapter: SupportedAdapterId,
        target: &AdapterTarget,
        path: PathBuf,
        runner: &dyn RuntimeCommandRunner,
    ) -> AdapterDiagnostic {
        let version = runner
            .run(&RuntimeCommandRequest {
                program: path.clone(),
                arguments: vec!["--version".into()],
                cwd: target.cwd.clone(),
            })
            .await;
        let version = match version {
            Ok(output) if output.exit_code == Some(0) && !output.stdout.is_empty() => output.stdout,
            Ok(output) => {
                return unknown_diagnostic_with_path(
                    adapter,
                    &path,
                    "version_failed",
                    nonempty(output.stderr, "version check failed"),
                );
            }
            Err(error) => {
                return unknown_diagnostic_with_path(adapter, &path, "version_failed", error);
            }
        };
        let auth_arguments = match adapter {
            SupportedAdapterId::Codex => vec!["login".into(), "status".into()],
            SupportedAdapterId::ClaudeCode => {
                vec!["auth".into(), "status".into(), "--json".into()]
            }
        };
        match runner
            .run(&RuntimeCommandRequest {
                program: path.clone(),
                arguments: auth_arguments,
                cwd: target.cwd.clone(),
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

fn target_executable_override(adapter: SupportedAdapterId, target_space: &Path) -> Option<PathBuf> {
    let config = load_space_agent_config(target_space);
    let keys: &[&str] = match adapter {
        SupportedAdapterId::Codex => &["codex"],
        SupportedAdapterId::ClaudeCode => &["claude-code", "claude"],
    };
    keys.iter().find_map(|key| {
        config.cli_paths.get(*key).map(|path| {
            if path.is_absolute() {
                path.clone()
            } else {
                target_space.join(path)
            }
        })
    })
}

fn nonempty(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn unknown_diagnostic(adapter: SupportedAdapterId, code: &str, message: &str) -> AdapterDiagnostic {
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
    adapter: SupportedAdapterId,
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

fn descriptor(id: SupportedAdapterId) -> AdapterRuntimeDescriptor {
    let (label, models) = match id {
        SupportedAdapterId::Codex => (
            "Codex",
            [
                ("gpt-5.6", "GPT-5.6 (recommended alias)"),
                ("gpt-5.6-sol", "GPT-5.6 Sol"),
                ("gpt-5.6-terra", "GPT-5.6 Terra"),
                ("gpt-5.6-luna", "GPT-5.6 Luna"),
            ]
            .as_slice(),
        ),
        SupportedAdapterId::ClaudeCode => (
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

fn effort_options(adapter: SupportedAdapterId, model: Option<&str>) -> Vec<AdapterSelectOption> {
    let values: &[&str] = match adapter {
        SupportedAdapterId::Codex => &["none", "low", "medium", "high", "xhigh", "max"],
        SupportedAdapterId::ClaudeCode if model == Some("haiku") => &[],
        SupportedAdapterId::ClaudeCode => &["low", "medium", "high"],
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
    let adapter = supported_id(binding.adapter);
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

fn approval_mapping(adapter: SupportedAdapterId, mode: ApprovalMode) -> ApprovalMapping {
    match (adapter, mode) {
        (SupportedAdapterId::Codex, ApprovalMode::Ask) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexUserReview,
            label: "Ask".into(),
            effective_boundary: "Codex uses workspace-write and on-request approvals; ordinary in-workspace edits do not necessarily prompt.".into(),
            danger: false,
        },
        (SupportedAdapterId::Codex, ApprovalMode::Auto) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexAutoReview,
            label: "Auto-review".into(),
            effective_boundary: "Codex stays in workspace-write; its automatic reviewer may approve, deny, or still require native policy handling.".into(),
            danger: false,
        },
        (SupportedAdapterId::Codex, ApprovalMode::Full) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::CodexFullAccess,
            label: "Full access".into(),
            effective_boundary: "Codex bypasses approvals and sandboxing; native first-run warnings remain visible.".into(),
            danger: true,
        },
        (SupportedAdapterId::ClaudeCode, ApprovalMode::Ask) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeDefault,
            label: "Ask".into(),
            effective_boundary: "Claude Code uses its native default permission prompts and policy.".into(),
            danger: false,
        },
        (SupportedAdapterId::ClaudeCode, ApprovalMode::Auto) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeAuto,
            label: "Auto-review".into(),
            effective_boundary: "Claude Code auto mode may allow, deny, or prompt according to its native classifier and policy.".into(),
            danger: false,
        },
        (SupportedAdapterId::ClaudeCode, ApprovalMode::Full) => ApprovalMapping {
            requested: mode,
            native: NativeApprovalMode::ClaudeBypassPermissions,
            label: "Full access".into(),
            effective_boundary: "Claude Code bypasses permission checks; native first-run warnings remain visible.".into(),
            danger: true,
        },
    }
}

fn build_launch(request: &AgentLaunchRequest, executable_path: &Path) -> TypedAgentLaunch {
    let adapter = supported_id(request.binding.adapter);
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
            SupportedAdapterId::Codex => argv.extend([
                "--config".into(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]),
            SupportedAdapterId::ClaudeCode => argv.extend(["--effort".into(), effort.clone()]),
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
    }
}

fn supported_id(kind: AgentAdapterKind) -> SupportedAdapterId {
    match kind {
        AgentAdapterKind::Codex => SupportedAdapterId::Codex,
        AgentAdapterKind::ClaudeCode => SupportedAdapterId::ClaudeCode,
    }
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
        let registry = SupportedAdapterRegistry;
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
        let registry = SupportedAdapterRegistry;
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
    fn full_access_mapping_is_explicit_for_each_adapter() {
        let registry = SupportedAdapterRegistry;
        let codex = registry.approval_mapping(SupportedAdapterId::Codex, ApprovalMode::Full);
        let claude = registry.approval_mapping(SupportedAdapterId::ClaudeCode, ApprovalMode::Full);
        assert_eq!(codex.native, NativeApprovalMode::CodexFullAccess);
        assert_eq!(claude.native, NativeApprovalMode::ClaudeBypassPermissions);
        assert!(codex.danger && claude.danger);
    }

    #[test]
    fn approval_mode_argv_snapshots_do_not_silently_downgrade() {
        let registry = SupportedAdapterRegistry;
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
        let registry = SupportedAdapterRegistry;
        let bindings = vec![
            binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None),
            binding(AgentAdapterKind::ClaudeCode, Some("sonnet"), None),
        ];
        let diagnostics = BTreeMap::from([
            (
                SupportedAdapterId::Codex,
                AdapterDiagnostic {
                    adapter: SupportedAdapterId::Codex,
                    status: AdapterDiagnosticStatus::Unauthenticated,
                    executable_path: Some("/bin/codex".into()),
                    version: Some("1".into()),
                    authenticated: Some(false),
                    code: Some("adapter_unauthenticated".into()),
                    message: None,
                },
            ),
            (
                SupportedAdapterId::ClaudeCode,
                AdapterDiagnostic {
                    adapter: SupportedAdapterId::ClaudeCode,
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
        assert_eq!(provenance.requested_adapter, SupportedAdapterId::ClaudeCode);
        assert_eq!(provenance.requested_model.as_deref(), Some("sonnet"));
        assert_eq!(provenance.requested_effort, None);
        assert_eq!(provenance.requested_approval_mode, ApprovalMode::Ask);
        assert_eq!(provenance.actual_adapter, SupportedAdapterId::ClaudeCode);
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
        let registry = SupportedAdapterRegistry;
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
        };
        let diagnostic = registry
            .diagnose_resolved(
                SupportedAdapterId::ClaudeCode,
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
        let registry = SupportedAdapterRegistry;
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
                SupportedAdapterId::Codex,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
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
        let registry = SupportedAdapterRegistry;
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
                SupportedAdapterId::Codex,
                &AdapterTarget {
                    cwd: PathBuf::from("/project"),
                },
                PathBuf::from("/bin/codex"),
                &runner,
            )
            .await;
        assert_eq!(diagnostic.status, AdapterDiagnosticStatus::Unknown);
        assert_eq!(diagnostic.authenticated, None);
    }

    #[test]
    fn serde_contract_uses_stable_adapter_and_mode_values() {
        let mapping = approval_mapping(SupportedAdapterId::ClaudeCode, ApprovalMode::Auto);
        assert_eq!(
            serde_json::to_value(mapping).unwrap()["native"],
            serde_json::json!("claude_auto")
        );
        assert_eq!(
            serde_json::to_value(SupportedAdapterId::ClaudeCode).unwrap(),
            serde_json::json!("claude-code")
        );
    }

    #[test]
    fn target_override_is_owned_by_space_local_config_and_resolves_relative_paths() {
        let target = tempfile::tempdir().unwrap();
        let local = target.path().join(".svode/local.json");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(
            local,
            serde_json::json!({
                "agent": {
                    "cliPaths": {
                        "codex": "bin/codex",
                        "claude-code": "/opt/custom/claude"
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            target_executable_override(SupportedAdapterId::Codex, target.path()),
            Some(target.path().join("bin/codex"))
        );
        assert_eq!(
            target_executable_override(SupportedAdapterId::ClaudeCode, target.path()),
            Some(PathBuf::from("/opt/custom/claude"))
        );
    }
}
