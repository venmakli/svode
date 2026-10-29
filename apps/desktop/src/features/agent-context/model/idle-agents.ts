import type {
  AgentContextItem,
  AgentContextSkillField,
  AgentId,
} from "./types";

/** Why an agent that finds an item does not apply it. */
export type AgentContextIdleReason =
  /** The skill file lacks what the agent requires; enabling the agent would not apply it. */
  | { kind: "rejected"; missing: readonly AgentContextSkillField[] }
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
 * Svode that read it by their policy. An agent that does not load a skill
 * says so, even when it is off in Svode.
 */
export function agentContextIdleAgents(
  item: Pick<
    AgentContextItem,
    "idleReaders" | "providers" | "rejections" | "sources"
  >,
): AgentContextIdleAgent[] {
  const seen = new Set<AgentId>(item.providers);
  const missing = new Map(
    item.rejections.map((rejection) => [rejection.agent, rejection.missing]),
  );
  const idle: AgentContextIdleAgent[] = [];
  for (const source of item.sources) {
    for (const reader of source.readers) {
      if (seen.has(reader.agent)) continue;
      const rejected = missing.get(reader.agent);
      if (rejected) {
        idle.push({
          agent: reader.agent,
          reason: { kind: "rejected", missing: rejected },
        });
      } else if (reader.disabled) {
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
    const rejected = missing.get(agent);
    idle.push({
      agent,
      reason: rejected
        ? { kind: "rejected", missing: rejected }
        : { kind: "off_in_svode" },
    });
  }
  return idle;
}
