import * as m from "@/paraglide/messages.js";

import type {
  AgentActorFacts,
  AgentActorReadiness,
} from "../model/agent-actor-facts";
import type { AgentActorBinding } from "../model/agent-actor-types";

/**
 * The "Agent" of an Agent: the binding's agent with its model, an agent id
 * this version does not know as it is, or the participant's agent.
 */
export function agentActorAgentLabel(
  binding: AgentActorBinding,
  facts: AgentActorFacts,
  agentName: (agent: string) => string,
) {
  if (binding.kind === "participant") return m.agent_actors_participant_agent();
  const agent = facts.bindable ? agentName(binding.agent) : binding.agent;
  return facts.model
    ? m.agent_actors_agent_with_model({ agent, model: facts.model })
    : agent;
}

/** The "Approval mode" of an Agent: empty without the agent's modes. */
export function agentActorModeLabel(facts: AgentActorFacts): string | null {
  if (!facts.mode) return null;
  return facts.mode.kind === "value"
    ? facts.mode.name
    : m.agent_actors_mode_agent_default();
}

export function agentActorReadinessLabel(readiness: AgentActorReadiness) {
  switch (readiness) {
    case "ready":
      return m.agent_actors_status_ready();
    case "sign_in_required":
      return m.agent_actors_readiness_sign_in();
    case "not_installed":
      return m.agent_actors_readiness_not_installed();
    case "unavailable":
      return m.agent_actors_readiness_unavailable();
    case "default_agent_missing":
      return m.agent_actors_readiness_default_missing();
    case "value_not_declared":
      return m.agent_actors_readiness_value_stale();
  }
}

export const AGENT_ACTOR_READINESS: readonly AgentActorReadiness[] = [
  "ready",
  "sign_in_required",
  "not_installed",
  "unavailable",
  "default_agent_missing",
  "value_not_declared",
];
