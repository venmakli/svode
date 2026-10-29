import type { AgentAdapterDictionary } from "@/features/agent-adapters";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import type {
  AgentContextSkillField,
  AgentContextSkillRejection,
} from "../model/types";

/** What a skill file lacks, by its field names: "name and description". */
export function agentContextMissingFieldsText(
  missing: readonly AgentContextSkillField[],
): string {
  return new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(
    missing,
  );
}

/**
 * Why agents do not load a skill: a line per set of missing fields, naming
 * the agents that lack it.
 */
export function agentContextRejectionTexts(
  agents: AgentAdapterDictionary,
  rejections: readonly AgentContextSkillRejection[],
): string[] {
  const groups = new Map<
    string,
    { agents: string[]; missing: readonly AgentContextSkillField[] }
  >();
  for (const { agent, missing } of rejections) {
    const key = missing.join();
    const group = groups.get(key) ?? { agents: [], missing };
    group.agents.push(agents.label(agent));
    groups.set(key, group);
  }
  return Array.from(groups.values(), (group) => {
    const fields = agentContextMissingFieldsText(group.missing);
    return group.agents.length === 1
      ? m.agent_context_rejected_by_one({ agent: group.agents[0], fields })
      : m.agent_context_rejected_by_many({
          agents: group.agents.join(", "),
          fields,
        });
  });
}
