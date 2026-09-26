import type { AgentActorCandidate } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import {
  resolveAgentActorReference,
  type AgentActorOptionsState,
  type AgentActorReference,
} from "../model/agent-actor-reference";

export function agentActorReferenceLabel(reference: AgentActorReference) {
  switch (reference.status) {
    case "resolved":
      return reference.option.label;
    case "loading":
      return m.agent_actors_reference_loading();
    case "missing":
      return m.agent_actors_reference_missing();
    case "ambiguous":
      return m.agent_actors_reference_ambiguous();
    case "error":
      return m.agent_actors_reference_error();
  }
}

export function agentActorCandidate(
  reference: AgentActorReference,
): AgentActorCandidate {
  const candidate: AgentActorCandidate = {
    kind: "agent",
    name: agentActorReferenceLabel(reference),
    reference: reference.reference,
  };
  return reference.status === "resolved"
    ? candidate
    : { ...candidate, state: reference.status };
}

/**
 * Candidates of an agent `actor` property: every selectable agent plus the
 * given references the catalog cannot resolve.
 */
export function agentActorCandidates(
  state: AgentActorOptionsState,
  references: Iterable<string>,
): AgentActorCandidate[] {
  const candidates = new Map<string, AgentActorCandidate>(
    state.options.map((option) => [
      option.value,
      { kind: "agent", name: option.label, reference: option.value },
    ]),
  );
  for (const reference of references) {
    if (!candidates.has(reference)) {
      candidates.set(
        reference,
        agentActorCandidate(resolveAgentActorReference(state, reference)),
      );
    }
  }
  return [...candidates.values()];
}
