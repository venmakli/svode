import { TriangleAlert } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import type { CollectionPropertyDefinition } from "../model/collection-property";
import { defineCommonCollectionProperty } from "../model/common-property";

/**
 * "Status": the health of the item's source. A normal item shows nothing; an
 * item with problems shows "Has problems" with its reasons on hover of the
 * cell and as a list in the property panel, which shows the property only
 * then. The filter offers "Normal" and "Has problems".
 */
export function defineStateCollectionProperty<Item>({
  getProblems,
}: {
  /** The reasons of the item's problems, as text; none in the normal state. */
  getProblems(item: Item): readonly string[];
}): CollectionPropertyDefinition<Item> {
  return defineCommonCollectionProperty<Item>("state", {
    display: {
      render: (_value, item) => {
        const problems = getProblems(item);
        if (problems.length === 0) return null;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center gap-1 text-destructive"
                data-collection-state-problems
              >
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                {m.property_common_state_has_problems()}
                <span className="sr-only">: {problems.join(" · ")}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm break-words">
              {problems.join(" · ")}
            </TooltipContent>
          </Tooltip>
        );
      },
      renderDetail: (_value, item) => {
        const problems = getProblems(item);
        if (problems.length === 0) return null;
        return (
          <div
            className="flex min-w-0 flex-col gap-1"
            data-collection-state-problems
          >
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {m.property_common_state_has_problems()}
            </span>
            <ul className="flex min-w-0 list-disc flex-col gap-0.5 pl-5 text-xs text-muted-foreground">
              {problems.map((problem) => (
                <li
                  className="break-words select-text [overflow-wrap:anywhere]"
                  key={problem}
                >
                  {problem}
                </li>
              ))}
            </ul>
          </div>
        );
      },
    },
    getApplicability: (item) =>
      getProblems(item).length > 0
        ? { status: "applicable" }
        : { status: "hidden" },
    getValue: (item) =>
      getProblems(item).length > 0
        ? m.property_common_state_has_problems()
        : m.property_common_state_normal(),
    standard: {
      options: [
        { color: "neutral", name: m.property_common_state_normal() },
        { color: "red", name: m.property_common_state_has_problems() },
      ],
      type: "select",
    },
  });
}
