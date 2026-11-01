//! Process-free actor resolution for routine launches.
//!
//! Transitional until Routine dispatch takes the executor resolver of
//! `svode_core::agent_actors::executor` directly (Stage 11 slice 3.3): the
//! registry launch path still takes a V1 binding and approval strategy, so
//! the resolved V2 binding is expressed in them here. A value or mode the V1
//! shape cannot carry refuses the launch instead of being dropped, and the
//! participant's agent is not launched by this path.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use svode_agents::registry::{
    AdapterDiagnostic, AdapterRuntimeRegistry, AgentLaunchRequest, PreStartBindingAttempt,
    PreStartSelection,
};
use svode_core::agent_actors::executor::{
    ExecutorResolution, ExecutorSource, ResolvedExecutor, resolve_executor,
};
use svode_core::agent_actors::v1::mode_equivalent;
use svode_core::agent_actors::{AgentAdapter, ApprovalMode};
use svode_core::agent_adapters::AgentAdapterKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentLaunchValidationCode {
    MissingExecutor,
    MissingActorId,
    AmbiguousActorId,
    UnavailableExecutor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchBindingAttempt {
    pub binding_index: usize,
    pub binding: AgentAdapter,
    pub diagnostic: Option<AdapterDiagnostic>,
    pub eligible: bool,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentLaunchResolution {
    MissingExecutor {
        code: AgentLaunchValidationCode,
    },
    MissingActorId {
        code: AgentLaunchValidationCode,
        executor: String,
    },
    AmbiguousActorId {
        code: AgentLaunchValidationCode,
        executor: String,
    },
    UnavailableExecutor {
        code: AgentLaunchValidationCode,
        actor_reference: String,
        actor_owner_path: String,
        launch_space_path: String,
        approval_mode: Option<ApprovalMode>,
        attempts: Vec<AgentLaunchBindingAttempt>,
    },
    Ready {
        request: AgentLaunchRequest,
        selected_binding_index: usize,
        attempts: Vec<AgentLaunchBindingAttempt>,
    },
}

/// Resolve a routine executor against its enclosing Space and optional project
/// root, then check that the one binding is eligible to start. The supplied
/// diagnostics must already have been collected for `launch_space`; this
/// function performs no executable detection, repository access probe, or
/// process/session creation.
pub fn resolve_agent_launch_request(
    launch_space: &Path,
    inherited_root: Option<&Path>,
    executor: Option<&str>,
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
) -> AgentLaunchResolution {
    let launch_space_path = launch_space.to_string_lossy().into_owned();
    let unavailable =
        |reference: String, actor_owner_path: String, attempts: Vec<AgentLaunchBindingAttempt>| {
            AgentLaunchResolution::UnavailableExecutor {
                code: AgentLaunchValidationCode::UnavailableExecutor,
                actor_reference: reference,
                actor_owner_path,
                launch_space_path: launch_space_path.clone(),
                approval_mode: None,
                attempts,
            }
        };
    let executor = match resolve_executor(launch_space, inherited_root, executor, None) {
        ExecutorResolution::MissingExecutor => {
            return AgentLaunchResolution::MissingExecutor {
                code: AgentLaunchValidationCode::MissingExecutor,
            };
        }
        ExecutorResolution::MissingActor { reference } => {
            return AgentLaunchResolution::MissingActorId {
                code: AgentLaunchValidationCode::MissingActorId,
                executor: reference,
            };
        }
        ExecutorResolution::AmbiguousActor { reference } => {
            return AgentLaunchResolution::AmbiguousActorId {
                code: AgentLaunchValidationCode::AmbiguousActorId,
                executor: reference,
            };
        }
        ExecutorResolution::ModeUnavailable {
            reference,
            actor_owner_path,
            ..
        }
        | ExecutorResolution::DefaultAgentNotSet {
            reference,
            actor_owner_path,
        } => return unavailable(reference, actor_owner_path, Vec::new()),
        ExecutorResolution::UnknownAgent {
            reference,
            actor_owner_path,
            agent,
        } => {
            let attempt = AgentLaunchBindingAttempt {
                binding_index: 0,
                binding: AgentAdapter {
                    adapter: agent,
                    model: None,
                    effort: None,
                },
                diagnostic: None,
                eligible: false,
                reason_code: Some("unknown_adapter".into()),
            };
            return unavailable(reference, actor_owner_path, vec![attempt]);
        }
        ExecutorResolution::Resolved(executor) => executor,
    };
    let (binding, approval_mode) = match legacy_launch_shape(&executor) {
        Ok(shape) => shape,
        Err(reason) => {
            let attempt = AgentLaunchBindingAttempt {
                binding_index: 0,
                binding: AgentAdapter {
                    adapter: executor.agent.clone(),
                    model: None,
                    effort: None,
                },
                diagnostic: executor
                    .agent
                    .builtin()
                    .and_then(|agent| diagnostics.get(&agent))
                    .cloned(),
                eligible: false,
                reason_code: Some(reason.into()),
            };
            return unavailable(
                executor.actor_reference,
                executor.actor_owner_path,
                vec![attempt],
            );
        }
    };
    let bindings = [binding];
    let selection = AdapterRuntimeRegistry.select_pre_start(&bindings, approval_mode, diagnostics);
    let attempts = launch_attempts(&bindings, diagnostics, &selection);
    let [binding] = bindings;
    let Some(selected_binding_index) = selection.selected_binding_index else {
        return AgentLaunchResolution::UnavailableExecutor {
            code: AgentLaunchValidationCode::UnavailableExecutor,
            actor_reference: executor.actor_reference,
            actor_owner_path: executor.actor_owner_path,
            launch_space_path,
            approval_mode: Some(approval_mode),
            attempts,
        };
    };
    AgentLaunchResolution::Ready {
        request: AgentLaunchRequest {
            actor_reference: executor.actor_reference,
            actor_owner_path: executor.actor_owner_path,
            launch_space_path,
            binding,
            approval_mode,
        },
        selected_binding_index,
        attempts,
    }
}

/// The resolved V2 binding as the V1 binding and approval strategy the
/// registry launch path takes: `model`, the effort setting of Codex or
/// Claude Code, and the strategy whose equivalent is the device mode (`ask`
/// without one, as a V1 Actor without a local row ran). Anything else the
/// V1 shape cannot carry is a reason the launch is refused.
fn legacy_launch_shape(
    executor: &ResolvedExecutor,
) -> Result<(AgentAdapter, ApprovalMode), &'static str> {
    if executor.source != ExecutorSource::Binding {
        return Err("participant_launch_unsupported");
    }
    let agent = executor.agent.builtin().ok_or("unknown_adapter")?;
    let effort_setting = match agent {
        AgentAdapterKind::Codex => Some("reasoning_effort"),
        AgentAdapterKind::ClaudeCode => Some("effort"),
        _ => None,
    };
    let mut binding = AgentAdapter {
        adapter: executor.agent.clone(),
        model: None,
        effort: None,
    };
    for value in &executor.portable_settings {
        if value.setting == "model" {
            binding.model = Some(value.value.clone());
        } else if Some(value.setting.as_str()) == effort_setting {
            binding.effort = Some(value.value.clone());
        } else {
            return Err("binding_setting_unsupported");
        }
    }
    let approval_mode = match executor.device_settings.as_slice() {
        [] => ApprovalMode::Ask,
        [mode] if mode.setting == "mode" => {
            [ApprovalMode::Ask, ApprovalMode::Auto, ApprovalMode::Full]
                .into_iter()
                .find(|candidate| mode_equivalent(agent, *candidate) == Some(mode.value.as_str()))
                .ok_or("mode_unsupported")?
        }
        _ => return Err("mode_unsupported"),
    };
    Ok((binding, approval_mode))
}

fn launch_attempts(
    bindings: &[AgentAdapter],
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
    selection: &PreStartSelection,
) -> Vec<AgentLaunchBindingAttempt> {
    selection
        .attempts
        .iter()
        .map(|attempt| enrich_attempt(attempt, &bindings[attempt.binding_index], diagnostics))
        .collect()
}

fn enrich_attempt(
    attempt: &PreStartBindingAttempt,
    binding: &AgentAdapter,
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
) -> AgentLaunchBindingAttempt {
    AgentLaunchBindingAttempt {
        binding_index: attempt.binding_index,
        binding: binding.clone(),
        diagnostic: binding_diagnostic(binding, diagnostics),
        eligible: attempt.eligible,
        reason_code: attempt.reason_code.clone(),
    }
}

fn binding_diagnostic(
    binding: &AgentAdapter,
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
) -> Option<AdapterDiagnostic> {
    binding
        .adapter
        .builtin()
        .and_then(|adapter| diagnostics.get(&adapter))
        .cloned()
}

#[cfg(test)]
mod tests {
    use tempfile::{TempDir, tempdir};

    use super::*;
    use crate::agent_actors::{CatalogMutation, mutate_catalog};
    use svode_agents::registry::AdapterDiagnosticStatus;
    use svode_core::agent_actors::local::{ActorMode, store_mode};
    use svode_core::agent_actors::{
        ActorBinding, AgentActor, AgentSettingValue, local_path, read_catalog,
    };

    const ACTOR_ID: &str = "01arz3ndektsv4rrffq69g5fav";

    fn binding(adapter: AgentAdapterKind, settings: &[(&str, &str)]) -> ActorBinding {
        ActorBinding::Agent {
            agent: adapter.id(),
            settings: settings
                .iter()
                .map(|(setting, value)| AgentSettingValue {
                    setting: (*setting).into(),
                    value: (*value).into(),
                })
                .collect(),
        }
    }

    fn add_actor(owner: &TempDir, binding: ActorBinding, mode: Option<&str>) {
        let (_, fingerprint) = read_catalog(owner.path()).unwrap();
        let agent = binding.agent().cloned();
        mutate_catalog(
            owner.path(),
            &fingerprint,
            CatalogMutation::Create(AgentActor {
                id: ACTOR_ID.into(),
                name: "Routine agent".into(),
                description: None,
                binding,
            }),
        )
        .unwrap();
        let mode = mode.zip(agent).map(|(value, agent)| ActorMode {
            agent,
            setting: "mode".into(),
            value: value.into(),
        });
        store_mode(owner.path(), ACTOR_ID, mode.as_ref()).unwrap();
    }

    fn diagnostic(adapter: AgentAdapterKind, status: AdapterDiagnosticStatus) -> AdapterDiagnostic {
        AdapterDiagnostic {
            adapter,
            status,
            executable_path: (status != AdapterDiagnosticStatus::Missing)
                .then(|| format!("/bin/{}", adapter.as_str())),
            version: (status == AdapterDiagnosticStatus::Ready).then(|| "1.0.0".into()),
            authenticated: match status {
                AdapterDiagnosticStatus::Ready => Some(true),
                AdapterDiagnosticStatus::Unauthenticated => Some(false),
                AdapterDiagnosticStatus::Missing | AdapterDiagnosticStatus::Unknown => None,
            },
            code: match status {
                AdapterDiagnosticStatus::Ready => None,
                AdapterDiagnosticStatus::Missing => Some("adapter_missing".into()),
                AdapterDiagnosticStatus::Unauthenticated => Some("adapter_unauthenticated".into()),
                AdapterDiagnosticStatus::Unknown => Some("adapter_unchecked".into()),
            },
            message: None,
        }
    }

    fn ready(adapter: AgentAdapterKind) -> BTreeMap<AgentAdapterKind, AdapterDiagnostic> {
        BTreeMap::from([(adapter, diagnostic(adapter, AdapterDiagnosticStatus::Ready))])
    }

    fn actor_reference() -> String {
        format!("agent:{ACTOR_ID}")
    }

    fn attempt_reason(resolution: AgentLaunchResolution) -> Option<String> {
        let AgentLaunchResolution::UnavailableExecutor { attempts, .. } = resolution else {
            panic!("the launch is unavailable");
        };
        attempts
            .first()
            .and_then(|attempt| attempt.reason_code.clone())
    }

    #[test]
    fn missing_executor_field_and_reference_are_distinct_blocking_states() {
        let space = tempdir().unwrap();
        let diagnostics = BTreeMap::new();

        assert_eq!(
            resolve_agent_launch_request(space.path(), None, None, &diagnostics),
            AgentLaunchResolution::MissingExecutor {
                code: AgentLaunchValidationCode::MissingExecutor,
            }
        );
        assert!(matches!(
            resolve_agent_launch_request(
                space.path(),
                None,
                Some("agent:not-a-canonical-id"),
                &diagnostics
            ),
            AgentLaunchResolution::MissingActorId {
                code: AgentLaunchValidationCode::MissingActorId,
                ..
            }
        ));
        assert!(matches!(
            resolve_agent_launch_request(
                space.path(),
                None,
                Some(&actor_reference()),
                &diagnostics
            ),
            AgentLaunchResolution::MissingActorId { .. }
        ));
    }

    #[test]
    fn own_root_collision_is_ambiguous() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        let codex = binding(AgentAdapterKind::Codex, &[("model", "gpt-5.6")]);
        add_actor(&root, codex.clone(), None);
        add_actor(&child, codex, None);

        assert!(matches!(
            resolve_agent_launch_request(
                child.path(),
                Some(root.path()),
                Some(&actor_reference()),
                &BTreeMap::new()
            ),
            AgentLaunchResolution::AmbiguousActorId {
                code: AgentLaunchValidationCode::AmbiguousActorId,
                ..
            }
        ));
    }

    #[test]
    fn standalone_space_does_not_inherit_an_external_root_actor() {
        let root = tempdir().unwrap();
        let standalone = tempdir().unwrap();
        add_actor(&root, binding(AgentAdapterKind::Codex, &[]), None);

        assert!(matches!(
            resolve_agent_launch_request(
                standalone.path(),
                None,
                Some(&actor_reference()),
                &BTreeMap::new()
            ),
            AgentLaunchResolution::MissingActorId { .. }
        ));
    }

    #[test]
    fn inherited_actor_keeps_root_owner_and_mode_but_launches_in_child() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        add_actor(
            &root,
            binding(
                AgentAdapterKind::Codex,
                &[("model", "gpt-5.6"), ("reasoning_effort", "high")],
            ),
            Some("agent-full-access"),
        );
        let diagnostics = ready(AgentAdapterKind::Codex);

        let AgentLaunchResolution::Ready {
            request,
            selected_binding_index,
            attempts,
        } = resolve_agent_launch_request(
            child.path(),
            Some(root.path()),
            Some(&actor_reference()),
            &diagnostics,
        )
        else {
            panic!("root actor should be ready in the child launch context");
        };

        assert_eq!(request.actor_owner_path, root.path().to_string_lossy());
        assert_eq!(request.launch_space_path, child.path().to_string_lossy());
        assert_eq!(request.approval_mode, ApprovalMode::Full);
        assert_eq!(request.binding.model.as_deref(), Some("gpt-5.6"));
        assert_eq!(request.binding.effort.as_deref(), Some("high"));
        assert_eq!(selected_binding_index, 0);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].diagnostic, diagnostics.values().next().cloned());
    }

    #[test]
    fn an_actor_without_a_mode_launches_as_a_v1_actor_without_a_row() {
        let space = tempdir().unwrap();
        add_actor(&space, binding(AgentAdapterKind::ClaudeCode, &[]), None);
        let AgentLaunchResolution::Ready { request, .. } = resolve_agent_launch_request(
            space.path(),
            None,
            Some(&actor_reference()),
            &ready(AgentAdapterKind::ClaudeCode),
        ) else {
            panic!("a Claude Code actor is ready");
        };
        assert_eq!(request.approval_mode, ApprovalMode::Ask);
    }

    #[test]
    fn values_the_v1_launch_shape_cannot_carry_refuse_the_launch() {
        let setting = tempdir().unwrap();
        add_actor(
            &setting,
            binding(AgentAdapterKind::Codex, &[("collaboration_mode", "plan")]),
            None,
        );
        assert_eq!(
            attempt_reason(resolve_agent_launch_request(
                setting.path(),
                None,
                Some(&actor_reference()),
                &ready(AgentAdapterKind::Codex),
            ))
            .as_deref(),
            Some("binding_setting_unsupported")
        );

        let mode = tempdir().unwrap();
        add_actor(
            &mode,
            binding(AgentAdapterKind::Codex, &[]),
            Some("read-only"),
        );
        assert_eq!(
            attempt_reason(resolve_agent_launch_request(
                mode.path(),
                None,
                Some(&actor_reference()),
                &ready(AgentAdapterKind::Codex),
            ))
            .as_deref(),
            Some("mode_unsupported")
        );
    }

    #[test]
    fn the_participant_and_an_unknown_agent_are_not_launched() {
        let participant = tempdir().unwrap();
        add_actor(&participant, ActorBinding::Participant, None);
        assert!(matches!(
            resolve_agent_launch_request(
                participant.path(),
                None,
                Some(&actor_reference()),
                &ready(AgentAdapterKind::Codex),
            ),
            AgentLaunchResolution::UnavailableExecutor { .. }
        ));

        let unknown = tempdir().unwrap();
        std::fs::create_dir_all(unknown.path().join(".svode")).unwrap();
        std::fs::write(
            svode_core::agent_actors::catalog_path(unknown.path()),
            format!(
                r#"{{"schemaVersion":2,"actors":[{{"id":"{ACTOR_ID}","name":"F","binding":{{"agent":"future-agent","settings":[]}}}}]}}"#
            ),
        )
        .unwrap();
        assert_eq!(
            attempt_reason(resolve_agent_launch_request(
                unknown.path(),
                None,
                Some(&actor_reference()),
                &BTreeMap::new(),
            ))
            .as_deref(),
            Some("unknown_adapter")
        );
    }

    #[test]
    fn an_unchecked_or_missing_agent_blocks_launch_with_its_attempt() {
        let space = tempdir().unwrap();
        add_actor(&space, binding(AgentAdapterKind::Codex, &[]), None);
        let missing = BTreeMap::from([(
            AgentAdapterKind::Codex,
            diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Missing),
        )]);

        let AgentLaunchResolution::UnavailableExecutor {
            code,
            attempts,
            actor_owner_path,
            launch_space_path,
            ..
        } = resolve_agent_launch_request(space.path(), None, Some(&actor_reference()), &missing)
        else {
            panic!("the binding should not be eligible");
        };

        assert_eq!(code, AgentLaunchValidationCode::UnavailableExecutor);
        assert_eq!(actor_owner_path, space.path().to_string_lossy());
        assert_eq!(launch_space_path, space.path().to_string_lossy());
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].reason_code.as_deref(), Some("adapter_missing"));
        assert_eq!(
            attempt_reason(resolve_agent_launch_request(
                space.path(),
                None,
                Some(&actor_reference()),
                &BTreeMap::new(),
            ))
            .as_deref(),
            Some("adapter_unchecked")
        );
    }

    #[test]
    fn an_unreadable_device_mode_blocks_launch() {
        let space = tempdir().unwrap();
        std::fs::create_dir_all(space.path().join(".svode")).unwrap();
        std::fs::write(
            svode_core::agent_actors::catalog_path(space.path()),
            format!(
                r#"{{"schemaVersion":1,"actors":[{{"id":"{ACTOR_ID}","name":"A","adapters":[{{"adapter":"codex"}}]}}]}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            local_path(space.path()),
            format!(r#"{{"agentActors":{{"{ACTOR_ID}":{{"approvalMode":"future-mode"}}}}}}"#),
        )
        .unwrap();

        let AgentLaunchResolution::UnavailableExecutor { approval_mode, .. } =
            resolve_agent_launch_request(
                space.path(),
                None,
                Some(&actor_reference()),
                &ready(AgentAdapterKind::Codex),
            )
        else {
            panic!("an unreadable mode must block launch");
        };
        assert_eq!(approval_mode, None);
    }
}
