import { TriangleAlert } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineComputedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AgentContextSourceHealth } from "../model/types";

interface HealthRow {
  health: AgentContextSourceHealth;
  healthReasons: readonly string[];
}

/** The problems of a degraded row; a normal row has none. */
export function agentContextHealthWarnings(row: HealthRow): readonly string[] {
  if (row.health !== "degraded") return [];
  return row.healthReasons.length > 0
    ? Array.from(new Set(row.healthReasons))
    : [m.agent_context_health_degraded()];
}

/**
 * "Status": a select that is empty for a normal row and "Has problems" with
 * its reasons for a degraded one.
 */
export function agentContextHealthProperty<
  Row extends HealthRow,
>(): CollectionPropertyDefinition<Row> {
  return defineComputedCollectionProperty<Row>({
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    display: {
      render: (_value, row) => {
        const warnings = agentContextHealthWarnings(row);
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
      renderDetail: (_value, row) => {
        const warnings = agentContextHealthWarnings(row);
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
    getValue: (row) =>
      agentContextHealthWarnings(row).length > 0
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
