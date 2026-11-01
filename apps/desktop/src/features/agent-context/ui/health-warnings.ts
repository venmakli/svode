import type { AgentAdapterDictionary } from "@/features/agent-adapters";
import * as m from "@/paraglide/messages.js";

import type {
  AgentContextSkillRejection,
  AgentContextSourceHealth,
} from "../model/types";
import { agentContextRejectionTexts } from "./skill-rejection-text";

interface HealthItem {
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
  /** Agents that find a skill and do not load it: a problem of the item. */
  rejections: readonly AgentContextSkillRejection[];
}

/** The problems of a degraded item; a normal item has none. */
export function agentContextHealthWarnings(
  agents: AgentAdapterDictionary,
  item: HealthItem,
): readonly string[] {
  if (item.health !== "degraded") return [];
  const warnings = Array.from(
    new Set([
      ...item.healthReasons,
      ...agentContextRejectionTexts(agents, item.rejections),
    ]),
  );
  return warnings.length > 0 ? warnings : [m.agent_context_health_degraded()];
}
