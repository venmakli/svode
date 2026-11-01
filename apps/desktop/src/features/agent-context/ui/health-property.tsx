import { TriangleAlert } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentAdapterDictionary } from "@/features/agent-adapters";
import {
  defineComputedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
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

/**
 * "Status": a select that is empty for a normal item and "Has problems" with
 * its reasons for a degraded one.
 */
export function agentContextHealthProperty<Item extends HealthItem>({
  agents,
}: {
  agents: AgentAdapterDictionary;
}): CollectionPropertyDefinition<Item> {
  return defineComputedCollectionProperty<Item>({
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    display: {
      render: (_value, item) => {
        const warnings = agentContextHealthWarnings(agents, item);
        if (warnings.length === 0) return null;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-destructive">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                {m.agent_context_health_has_problems()}
              </span>
            </TooltipTrigger>
            <TooltipContent>{warnings.join(" · ")}</TooltipContent>
          </Tooltip>
        );
      },
      renderDetail: (_value, item) => {
        const warnings = agentContextHealthWarnings(agents, item);
        if (warnings.length === 0) return null;
        return (
          <div
            className="flex min-w-0 flex-col gap-1"
            data-agent-context-health
          >
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {m.agent_context_health_has_problems()}
            </span>
            <ul className="flex min-w-0 list-disc flex-col gap-0.5 pl-5 text-xs text-muted-foreground">
              {warnings.map((warning) => (
                <li
                  className="break-words select-text [overflow-wrap:anywhere]"
                  key={warning}
                >
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        );
      },
    },
    featureId: "agent-context",
    getValue: (item) =>
      agentContextHealthWarnings(agents, item).length > 0
        ? m.agent_context_health_has_problems()
        : null,
    key: "health",
    label: m.agent_context_property_health(),
    standard: {
      options: [{ color: "red", name: m.agent_context_health_has_problems() }],
      type: "select",
    },
  });
}
