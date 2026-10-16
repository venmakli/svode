import type { AgentContextItem, AgentId } from "./types";

/** Why an agent that finds an item does not apply it. */
export type AgentContextIdleReason =
  /** Another file shadows it; `by` is empty when not known. */
  | { kind: "superseded"; by: string }
  /** The agent has it off in its config. */
  | { kind: "disabled" }
  /** The agent is off in Svode. */
  | { kind: "off_in_svode" };

export interface AgentContextIdleAgent {
  agent: AgentId;
  reason: AgentContextIdleReason;
}

/**
 * The agents that find an item but do not apply it, after its providers:
 * enabled agents by the first path that finds it, then the agents off in
 * Svode that read it by their policy.
 */
export function agentContextIdleAgents(
  item: Pick<AgentContextItem, "idleReaders" | "providers" | "sources">,
): AgentContextIdleAgent[] {
  const seen = new Set<AgentId>(item.providers);
  const idle: AgentContextIdleAgent[] = [];
  for (const source of item.sources) {
    for (const reader of source.readers) {
      if (seen.has(reader.agent)) continue;
      if (reader.disabled) {
        idle.push({ agent: reader.agent, reason: { kind: "disabled" } });
      } else if (reader.supersededBy !== null) {
        idle.push({
          agent: reader.agent,
          reason: { by: reader.supersededBy, kind: "superseded" },
        });
      } else {
        continue;
      }
      seen.add(reader.agent);
    }
  }
  for (const agent of item.idleReaders) {
    if (seen.has(agent)) continue;
    seen.add(agent);
    idle.push({ agent, reason: { kind: "off_in_svode" } });
  }
  return idle;
}
