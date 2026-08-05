//! Process-free actor resolution and adapter selection for routine launches.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent_adapters::runtime::{
    AdapterDiagnostic, PreStartBindingAttempt, PreStartSelection,
};
use crate::agent_adapters::{AgentAdapterKind, AgentAdapterRegistry};

pub use crate::agent_adapters::runtime::AgentLaunchRequest;

use super::{
    AgentAdapter, ApprovalMode, CanonicalActorResolution, ResolvedAgentActor, read_local_approval,
    resolve_canonical_reference,
};

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
/// root, then choose the first binding eligible to start. The supplied
/// diagnostics must already have been collected for `launch_space`; this
/// function performs no executable detection, repository access probe, or
/// process/session creation.
pub fn resolve_agent_launch_request(
    launch_space: &Path,
    inherited_root: Option<&Path>,
    executor: Option<&str>,
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
) -> AgentLaunchResolution {
    let Some(reference) = executor else {
        return AgentLaunchResolution::MissingExecutor {
            code: AgentLaunchValidationCode::MissingExecutor,
        };
    };

    let resolved = match resolve_canonical_reference(launch_space, inherited_root, reference) {
        CanonicalActorResolution::Resolved { actor } => actor,
        CanonicalActorResolution::Missing { .. } => {
            return AgentLaunchResolution::MissingActorId {
                code: AgentLaunchValidationCode::MissingActorId,
                executor: reference.to_string(),
            };
        }
        CanonicalActorResolution::Ambiguous { .. } => {
            return AgentLaunchResolution::AmbiguousActorId {
                code: AgentLaunchValidationCode::AmbiguousActorId,
                executor: reference.to_string(),
            };
        }
    };

    select_resolved_actor(launch_space, reference, resolved, diagnostics)
}

fn select_resolved_actor(
    launch_space: &Path,
    reference: &str,
    resolved: ResolvedAgentActor,
    diagnostics: &BTreeMap<AgentAdapterKind, AdapterDiagnostic>,
) -> AgentLaunchResolution {
    let registry = AgentAdapterRegistry;
    let selection = registry.select_pre_start(&resolved.actor.adapters, diagnostics);
    let mut attempts = launch_attempts(&resolved.actor.adapters, diagnostics, &selection);
    let launch_space_path = launch_space.to_string_lossy().into_owned();
    let approval_mode =
        match read_local_approval(Path::new(&resolved.owner_path), resolved.actor.id.as_str()) {
            Ok(mode) => mode,
            Err(_) => {
                for attempt in &mut attempts {
                    attempt.eligible = false;
                    attempt.reason_code = Some("approval_mode_unavailable".into());
                }
                return AgentLaunchResolution::UnavailableExecutor {
                    code: AgentLaunchValidationCode::UnavailableExecutor,
                    actor_reference: reference.to_string(),
                    actor_owner_path: resolved.owner_path,
                    launch_space_path,
                    approval_mode: None,
                    attempts,
                };
            }
        };

    let Some(selected_binding_index) = selection.selected_binding_index else {
        return AgentLaunchResolution::UnavailableExecutor {
            code: AgentLaunchValidationCode::UnavailableExecutor,
            actor_reference: reference.to_string(),
            actor_owner_path: resolved.owner_path,
            launch_space_path,
            approval_mode: Some(approval_mode),
            attempts,
        };
    };
    let binding = resolved.actor.adapters[selected_binding_index].clone();

    AgentLaunchResolution::Ready {
        request: AgentLaunchRequest {
            actor_reference: reference.to_string(),
            actor_owner_path: resolved.owner_path,
            launch_space_path,
            binding,
            approval_mode,
        },
        selected_binding_index,
        attempts,
    }
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
        diagnostic: diagnostics.get(&attempt.adapter).cloned(),
        eligible: attempt.eligible,
        reason_code: attempt.reason_code.clone(),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::{TempDir, tempdir};

    use super::*;
    use crate::agent_actors::{
        AgentActor, CatalogMutation, local_path, mutate_catalog, read_catalog, write_local_approval,
    };
    use crate::agent_adapters::runtime::AdapterDiagnosticStatus;

    const ACTOR_ID: &str = "01arz3ndektsv4rrffq69g5fav";

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

    fn add_actor(owner: &TempDir, adapters: Vec<AgentAdapter>, approval_mode: ApprovalMode) {
        let (_, fingerprint) = read_catalog(owner.path()).unwrap();
        mutate_catalog(
            owner.path(),
            &fingerprint,
            CatalogMutation::Create(AgentActor {
                id: ACTOR_ID.into(),
                name: "Routine agent".into(),
                description: None,
                adapters,
            }),
        )
        .unwrap();
        write_local_approval(owner.path(), ACTOR_ID.into(), approval_mode).unwrap();
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

    fn actor_reference() -> String {
        format!("agent:{ACTOR_ID}")
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
        let adapter = binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None);
        add_actor(&root, vec![adapter.clone()], ApprovalMode::Ask);
        add_actor(&child, vec![adapter], ApprovalMode::Full);

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
        add_actor(
            &root,
            vec![binding(AgentAdapterKind::Codex, None, None)],
            ApprovalMode::Ask,
        );

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
    fn inherited_actor_keeps_root_owner_and_approval_but_launches_in_child() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        add_actor(
            &root,
            vec![binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None)],
            ApprovalMode::Full,
        );
        let diagnostics = BTreeMap::from([(
            AgentAdapterKind::Codex,
            diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Ready),
        )]);

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
        assert_eq!(selected_binding_index, 0);
        assert_eq!(attempts[0].diagnostic, diagnostics.values().next().cloned());
    }

    #[test]
    fn unavailable_primary_falls_back_in_declared_binding_order() {
        let space = tempdir().unwrap();
        add_actor(
            &space,
            vec![
                binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None),
                binding(AgentAdapterKind::ClaudeCode, Some("sonnet"), None),
            ],
            ApprovalMode::Auto,
        );
        let diagnostics = BTreeMap::from([
            (
                AgentAdapterKind::Codex,
                diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Missing),
            ),
            (
                AgentAdapterKind::ClaudeCode,
                diagnostic(AgentAdapterKind::ClaudeCode, AdapterDiagnosticStatus::Ready),
            ),
        ]);

        let AgentLaunchResolution::Ready {
            request,
            selected_binding_index,
            attempts,
        } = resolve_agent_launch_request(
            space.path(),
            None,
            Some(&actor_reference()),
            &diagnostics,
        )
        else {
            panic!("fallback binding should be ready");
        };

        assert_eq!(selected_binding_index, 1);
        assert_eq!(request.binding.adapter, AgentAdapterKind::ClaudeCode);
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].reason_code.as_deref(), Some("adapter_missing"));
        assert!(attempts[0].diagnostic.is_some());
        assert!(attempts[1].eligible);
    }

    #[test]
    fn all_unavailable_or_unchecked_bindings_block_launch_with_full_attempts() {
        let space = tempdir().unwrap();
        add_actor(
            &space,
            vec![
                binding(AgentAdapterKind::Codex, None, None),
                binding(AgentAdapterKind::ClaudeCode, None, None),
            ],
            ApprovalMode::Ask,
        );
        let diagnostics = BTreeMap::from([(
            AgentAdapterKind::Codex,
            diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Missing),
        )]);

        let AgentLaunchResolution::UnavailableExecutor {
            code,
            attempts,
            actor_owner_path,
            launch_space_path,
            ..
        } = resolve_agent_launch_request(
            space.path(),
            None,
            Some(&actor_reference()),
            &diagnostics,
        )
        else {
            panic!("no binding should be eligible");
        };

        assert_eq!(code, AgentLaunchValidationCode::UnavailableExecutor);
        assert_eq!(actor_owner_path, space.path().to_string_lossy());
        assert_eq!(launch_space_path, space.path().to_string_lossy());
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].reason_code.as_deref(), Some("adapter_missing"));
        assert_eq!(
            attempts[1].reason_code.as_deref(),
            Some("adapter_unchecked")
        );
        assert!(attempts[1].diagnostic.is_none());
    }

    #[test]
    fn invalid_selector_is_unavailable_even_when_adapter_diagnostic_is_ready() {
        let space = tempdir().unwrap();
        add_actor(
            &space,
            vec![binding(AgentAdapterKind::Codex, Some("future-model"), None)],
            ApprovalMode::Ask,
        );
        let diagnostics = BTreeMap::from([(
            AgentAdapterKind::Codex,
            diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Ready),
        )]);

        let AgentLaunchResolution::UnavailableExecutor { attempts, .. } =
            resolve_agent_launch_request(
                space.path(),
                None,
                Some(&actor_reference()),
                &diagnostics,
            )
        else {
            panic!("invalid binding selector must block launch");
        };

        assert_eq!(attempts.len(), 1);
        assert_eq!(
            attempts[0].reason_code.as_deref(),
            Some("unknown_model_selector")
        );
        assert_eq!(
            attempts[0].diagnostic.as_ref().map(|value| value.status),
            Some(AdapterDiagnosticStatus::Ready)
        );
    }

    #[test]
    fn unsupported_owner_local_approval_blocks_every_otherwise_ready_binding() {
        let space = tempdir().unwrap();
        add_actor(
            &space,
            vec![binding(AgentAdapterKind::Codex, Some("gpt-5.6"), None)],
            ApprovalMode::Ask,
        );
        std::fs::write(
            local_path(space.path()),
            format!(r#"{{"agentActors":{{"{ACTOR_ID}":{{"approvalMode":"future-mode"}}}}}}"#),
        )
        .unwrap();
        let diagnostics = BTreeMap::from([(
            AgentAdapterKind::Codex,
            diagnostic(AgentAdapterKind::Codex, AdapterDiagnosticStatus::Ready),
        )]);

        let AgentLaunchResolution::UnavailableExecutor {
            approval_mode,
            attempts,
            ..
        } = resolve_agent_launch_request(
            space.path(),
            None,
            Some(&actor_reference()),
            &diagnostics,
        )
        else {
            panic!("unsupported approval mode must block launch");
        };

        assert_eq!(approval_mode, None);
        assert_eq!(attempts.len(), 1);
        assert!(!attempts[0].eligible);
        assert_eq!(
            attempts[0].reason_code.as_deref(),
            Some("approval_mode_unavailable")
        );
    }
}
