import * as m from "@/paraglide/messages.js";

import { isAgentActorFoundWithoutSignInStatus } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorBinding,
} from "../model/agent-actor-types";

/**
 * The name of a binding: its agent, an agent id this version does not know
 * as it is, or the participant's agent.
 */
export function agentActorBindingLabel(
  binding: AgentActorBinding,
  agents: readonly AgentActorAgentOption[],
) {
  if (binding.kind === "participant") return m.agent_actors_participant_agent();
  return (
    agents.find((agent) => agent.id === binding.agent)?.label ?? binding.agent
  );
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
