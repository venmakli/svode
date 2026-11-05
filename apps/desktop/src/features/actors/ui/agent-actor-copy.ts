import type { AgentPropertyValue } from "@/features/agent-adapters";
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorFacts,
  AgentActorReadiness,
} from "../model/agent-actor-facts";
import type {
  AgentActorBinding,
  AgentActorCatalogDiagnostic,
} from "../model/agent-actor-types";

/**
 * The "Agent" of an Agent: the binding's agent with its model, or the
 * participant's agent.
 */
export function agentActorAgentValue(
  binding: AgentActorBinding,
  facts: AgentActorFacts,
): AgentPropertyValue {
  if (binding.kind === "participant") return { kind: "participant" };
  return { agent: binding.agent, detail: facts.model, kind: "agent" };
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

/**
 * The text of a catalog diagnostic of the Agents collection of
 * `launchSpacePath`. A catalog that cannot be read reads by the class of its
 * cause and names an inherited root catalog the project's; its message is
 * not user copy. Any other diagnostic keeps its message.
 */
export function agentActorCatalogDiagnosticText(
  diagnostic: AgentActorCatalogDiagnostic,
  launchSpacePath: string,
): string {
  if (diagnostic.code !== "catalog_unavailable") return diagnostic.message;
  const project = diagnostic.ownerPath !== launchSpacePath;
  switch (diagnostic.reason) {
    case "newer_format":
      return project
        ? m.agent_actors_catalog_newer_format_project()
        : m.agent_actors_catalog_newer_format();
    case "damaged":
      return project
        ? m.agent_actors_catalog_damaged_project()
        : m.agent_actors_catalog_damaged();
    case "unreadable":
      return project
        ? m.agent_actors_catalog_unreadable_project()
        : m.agent_actors_catalog_unreadable();
    default:
      return project
        ? m.agent_actors_catalog_unavailable_project()
        : m.agent_actors_catalog_unavailable();
  }
}
