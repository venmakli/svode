import { FileText, Layers, Sparkles, TriangleAlert } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineCollectionPresentation,
  normalizeCollectionSearchText,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import type { CollectionPropertyDefinition } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AgentContextItem, AgentContextItemKind } from "../model/types";
import { agentContextHealthWarnings } from "./health-property";
import {
  AgentContextItemIcon,
  agentContextItemKindLabel,
  agentContextLocationLabel,
} from "./item-properties";

/** Built-in presets over the one set of items, "All" first. */
export const AGENT_CONTEXT_PRESETS = ["all", "instructions", "skills"] as const;
export type AgentContextPresetId = (typeof AGENT_CONTEXT_PRESETS)[number];

const presetKinds: Readonly<
  Record<Exclude<AgentContextPresetId, "all">, AgentContextItemKind>
> = { instructions: "instruction", skills: "skill" };

export function createAgentContextPresentation({
  id,
  onActivate,
  properties,
  state,
}: {
  id: AgentContextPresetId;
  onActivate?: CollectionPresentationDescriptor<AgentContextItem>["onActivate"];
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
  state: CollectionPresentationState<AgentContextItem>;
}) {
  return defineCollectionPresentation<AgentContextItem>({
    descriptor: {
      getRowId: (item) => item.id,
      id,
      label: presetLabel(id),
      layout:
        id === "all"
          ? {
              density: "compact",
              kind: "table",
              primaryProperty: "name",
              renderLeading: (item) => (
                <AgentContextItemIcon
                  className="size-4 text-muted-foreground"
                  kind={item.kind}
                />
              ),
              visibleProperties: [
                "name",
                "type",
                "providers",
                "health",
                "location",
                "modified",
              ],
            }
          : {
              cardSize: "medium",
              density: "compact",
              ...(id === "skills"
                ? {
                    getDescription: (item: AgentContextItem) => (
                      <span className="line-clamp-3 leading-relaxed">
                        {item.description}
                      </span>
                    ),
                  }
                : {}),
              getTitle: (item) => item.name,
              kind: "gallery",
              renderLeading: (item) => (
                <AgentContextItemIcon
                  className="size-4 text-muted-foreground"
                  kind={item.kind}
                />
              ),
              renderOverlays: (item) => <ItemProblemsMarker item={item} />,
              visibleProperties: ["location", "providers"],
            },
      onActivate,
      properties,
      query: {
        defaultCompare: compareItemsByDefault,
        ...(id === "all"
          ? {}
          : {
              fixedPredicate: (item: AgentContextItem) =>
                item.kind === presetKinds[id],
            }),
        getSearchText: (item) =>
          [
            item.name,
            item.description ?? "",
            agentContextItemKindLabel(item.kind),
            agentContextLocationLabel(item.location),
          ].join(" "),
        getSortTieBreakId: (item) => item.id,
      },
    },
    state,
  });
}

/** The empty set of a preset, named by its type. */
export function AgentContextPresetEmpty({ id }: { id: AgentContextPresetId }) {
  const Icon =
    id === "skills" ? Sparkles : id === "instructions" ? FileText : Layers;
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>
          {id === "skills"
            ? m.agent_context_skills_empty_title()
            : id === "instructions"
              ? m.agent_context_empty_title()
              : m.agent_context_all_empty_title()}
        </EmptyTitle>
        <EmptyDescription>
          {id === "skills"
            ? m.agent_context_skills_empty_description()
            : id === "instructions"
              ? m.agent_context_empty_description()
              : m.agent_context_all_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function compareItemsByDefault(
  left: AgentContextItem,
  right: AgentContextItem,
) {
  return (
    compareText(
      normalizeCollectionSearchText(left.name),
      normalizeCollectionSearchText(right.name),
    ) || compareText(left.path, right.path)
  );
}

function presetLabel(id: AgentContextPresetId) {
  if (id === "instructions") return m.agent_context_instructions();
  if (id === "skills") return m.agent_context_skills();
  return m.agent_context_preset_all();
}

/** "Has problems" on the card of a problem row only. */
function ItemProblemsMarker({ item }: { item: AgentContextItem }) {
  const warnings = agentContextHealthWarnings(item);
  if (warnings.length === 0) return null;
  const reason = warnings.join(" · ");
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex size-6 items-center justify-center rounded-md border border-destructive/30 bg-background/95 text-destructive shadow-sm"
            aria-label={m.agent_context_warning_tooltip({ reason })}
            tabIndex={0}
          >
            <TriangleAlert className="size-3.5" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
