import * as m from "@/paraglide/messages.js";

import type {
  AgentActorAdapterDiagnostic,
  AgentActorApprovalMapping,
  AgentActorBindingValidation,
  AgentActorDraft,
} from "../model/agent-actor-types";

export function agentActorApprovalLabel(mode: AgentActorDraft["approvalMode"]) {
  if (mode === "auto") return m.agent_actors_approval_auto();
  if (mode === "full") return m.agent_actors_approval_full();
  return m.agent_actors_approval_ask();
}

export function agentActorApprovalDescription(
  mode: AgentActorDraft["approvalMode"],
) {
  if (mode === "auto") return m.agent_actors_approval_auto_hint();
  if (mode === "full") return m.agent_actors_approval_full_hint();
  return m.agent_actors_approval_ask_hint();
}

export function agentActorEffectiveBoundary(
  native: AgentActorApprovalMapping["native"],
) {
  switch (native) {
    case "codex_user_review":
      return m.agent_actors_boundary_codex_user_review();
    case "codex_auto_review":
      return m.agent_actors_boundary_codex_auto_review();
    case "codex_full_access":
      return m.agent_actors_boundary_codex_full_access();
    case "claude_default":
      return m.agent_actors_boundary_claude_default();
    case "claude_auto":
      return m.agent_actors_boundary_claude_auto();
    case "claude_bypass_permissions":
      return m.agent_actors_boundary_claude_bypass_permissions();
  }
}

export function agentActorSelectorLabel(value: string | null) {
  return value ?? m.agent_actors_client_default();
}

export function agentActorDiagnosticStatus(
  diagnostic: AgentActorAdapterDiagnostic | undefined,
  pending = false,
) {
  if (pending) return m.agent_actors_status_checking();
  if (!diagnostic || diagnostic.status === "unknown") {
    return diagnostic
      ? m.agent_actors_status_attention()
      : m.agent_actors_status_unchecked();
  }
  if (diagnostic.status === "ready") return m.agent_actors_status_ready();
  return m.agent_actors_status_attention();
}

export function agentActorDiagnosticSummary(
  diagnostic: AgentActorAdapterDiagnostic | undefined,
) {
  if (!diagnostic || diagnostic.status === "ready") return null;
  if (diagnostic.status === "missing") {
    return m.agent_actors_diagnostic_missing();
  }
  if (diagnostic.status === "unauthenticated") {
    return m.agent_actors_diagnostic_unauthenticated();
  }
  return m.agent_actors_diagnostic_failed();
}

export function agentActorValidationIssueLabel(
  issue: AgentActorBindingValidation["issues"][number],
) {
  if (issue.code === "unknown_model_selector") {
    return m.agent_actors_model_selector_unknown();
  }
  if (issue.code === "unknown_effort_selector") {
    return m.agent_actors_effort_selector_unknown();
  }
  return m.agent_actors_binding_invalid();
}
