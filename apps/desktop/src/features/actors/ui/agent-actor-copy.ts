import * as m from "@/paraglide/messages.js";

import { isAgentActorFoundWithoutSignInStatus } from "../model/agent-actor-draft";
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
    case "hermes_default":
      return m.agent_actors_boundary_hermes_default();
    case "hermes_accept_edits":
      return m.agent_actors_boundary_hermes_accept_edits();
  }
}

/** Why a binding of an agent Actors can use is unavailable with `mode`. */
export function agentActorNoModeEquivalent(
  client: string,
  mode: AgentActorDraft["approvalMode"],
) {
  return m.agent_actors_binding_no_mode_equivalent({
    client,
    mode: agentActorApprovalLabel(mode),
  });
}

/**
 * The approval boundary of a binding: its mapping, unavailable without one
 * (with the reason when the agent has no equivalent of the Actor's mode
 * only), or checking while the mapping is not read yet.
 */
export function agentActorBoundarySummary(
  mapping: AgentActorApprovalMapping | null | undefined,
  noEquivalent?: { client: string; mode: AgentActorDraft["approvalMode"] },
) {
  if (mapping === null) {
    return noEquivalent
      ? agentActorNoModeEquivalent(noEquivalent.client, noEquivalent.mode)
      : m.agent_actors_binding_unavailable();
  }
  if (!mapping) return m.agent_actors_binding_checking();
  return `${agentActorApprovalLabel(mapping.requested)}: ${agentActorEffectiveBoundary(mapping.native)}`;
}

export function agentActorSelectorLabel(value: string | null) {
  return value ?? m.agent_actors_client_default();
}

export function agentActorDiagnosticStatus(
  diagnostic: AgentActorAdapterDiagnostic | undefined,
  pending = false,
) {
  if (pending) return m.agent_actors_status_checking();
  if (isAgentActorFoundWithoutSignInStatus(diagnostic)) {
    return m.agent_actors_status_found();
  }
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
  if (isAgentActorFoundWithoutSignInStatus(diagnostic)) return null;
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
  if (issue.code === "unknown_adapter") {
    return m.agent_actors_adapter_unknown();
  }
  if (issue.code === "approval_mapping_missing") {
    return m.agent_actors_adapter_not_bindable();
  }
  return m.agent_actors_binding_invalid();
}
