import * as m from "@/paraglide/messages.js";

import type {
  AgentContextLinkKind,
  AgentContextSourceFamily,
  AgentContextSourceLocation,
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
