import type { VariantProps } from "class-variance-authority";

import { badgeVariants } from "@/components/ui/badge";
import * as m from "@/paraglide/messages.js";

import type {
  AgentContextAvailability,
  AgentContextInstructionRole,
  AgentContextScope,
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

export function availabilityLabel(availability: AgentContextAvailability) {
  if (availability === "available") {
    return m.agent_context_availability_available();
  }
  if (availability === "shadowed") {
    return m.agent_context_availability_shadowed();
  }
  if (availability === "recognized_only") {
    return m.agent_context_availability_recognized_only();
  }
  return m.agent_context_availability_compatibility_unknown();
}

export function availabilityVariant(
  availability: AgentContextAvailability,
): VariantProps<typeof badgeVariants>["variant"] {
  if (availability === "available") return "secondary";
  if (availability === "compatibility_unknown") return "destructive";
  return "outline";
}
