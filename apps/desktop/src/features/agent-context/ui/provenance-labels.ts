import * as m from "@/paraglide/messages.js";

import type {
  AgentContextLinkKind,
  AgentContextInstructionRole,
  AgentContextSourceFamily,
  AgentContextSourceLocation,
  AgentContextSourceResolution,
  AgentContextSourceSupport,
} from "../model/types";

export function sourceFamilyLabel(sourceFamily: AgentContextSourceFamily) {
  return sourceFamily === "agents"
    ? m.agent_context_source_agents()
    : m.agent_context_source_claude();
}

export function sourceLocationLabel(location: AgentContextSourceLocation) {
  return location === "global"
    ? m.agent_context_location_global()
    : m.agent_context_location_space();
}

export function sourceLinkKindLabel(linkKind: AgentContextLinkKind) {
  if (linkKind === "symbolic_link") {
    return m.agent_context_link_kind_symbolic();
  }
  if (linkKind === "directory_alias") {
    return m.agent_context_link_kind_directory();
  }
  return m.agent_context_link_kind_direct();
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
