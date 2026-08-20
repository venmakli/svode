import * as m from "@/paraglide/messages.js";

import type {
  AgentContextInstructionRole,
  AgentContextScope,
  AgentContextSourceResolution,
  AgentContextSourceSupport,
  SupportedAdapterId,
} from "../model/types";

export function instructionAdapterLabel(adapterId: SupportedAdapterId | null) {
  if (adapterId === "codex") return m.agent_context_adapter_codex();
  if (adapterId === "claude-code") return m.agent_context_adapter_claude();
  return m.agent_context_adapter_recognized();
}

export function instructionScopeLabel(scope: AgentContextScope) {
  return scope === "personal"
    ? m.agent_context_scope_personal()
    : m.agent_context_scope_project();
}

export function instructionRoleLabel(role: AgentContextInstructionRole) {
  if (role === "codex_user_precedence") {
    return m.agent_context_role_codex_user();
  }
  if (role === "codex_directory_precedence") {
    return m.agent_context_role_codex_project();
  }
  if (role === "claude_hierarchy") {
    return m.agent_context_role_claude_hierarchy();
  }
  if (role === "claude_import") {
    return m.agent_context_role_claude_import();
  }
  return m.agent_context_role_recognized();
}

export function sourceSupportLabel(support: AgentContextSourceSupport) {
  return support === "client_native"
    ? m.agent_context_support_client_native()
    : m.agent_context_support_recognized();
}

export function sourceResolutionLabel(
  resolution: AgentContextSourceResolution,
) {
  if (resolution === "selected") {
    return m.agent_context_resolution_selected();
  }
  if (resolution === "superseded") {
    return m.agent_context_resolution_superseded();
  }
  return m.agent_context_resolution_included();
}
