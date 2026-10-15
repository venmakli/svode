import {
  FileText,
  Layers,
  Puzzle,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

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
  type CollectionPresentationLayout,
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
export const AGENT_CONTEXT_PRESETS = [
  "all",
  "instructions",
  "skills",
  "plugins",
] as const;
export type AgentContextPresetId = (typeof AGENT_CONTEXT_PRESETS)[number];

const presetKinds: Readonly<
  Record<Exclude<AgentContextPresetId, "all">, AgentContextItemKind>
> = { instructions: "instruction", plugins: "plugin", skills: "skill" };

/** Which plugins of "All" show their components. */
export interface AgentContextExpansion {
  expanded: ReadonlySet<string>;
  onToggle(itemId: string): void;
}

export function createAgentContextPresentation({
  expansion,
  id,
  onActivate,
  properties,
  state,
}: {
  expansion?: AgentContextExpansion;
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
              ...(expansion
                ? { hierarchy: agentContextPluginHierarchy(expansion) }
                : {}),
              kind: "table",
              primaryProperty: "name",
              renderLeading: (item) => (
                <AgentContextItemIcon
                  className="size-4 text-muted-foreground"
                  item={item}
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
              ...(id === "skills" || id === "plugins"
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
                  item={item}
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
        // A plugin is found by the names of its components too.
        getSearchText: (item) =>
          [
            item.name,
            item.description ?? "",
            agentContextItemKindLabel(item.kind),
            agentContextLocationLabel(item.location),
            ...item.components.map((component) => component.name),
          ].join(" "),
        getSortTieBreakId: (item) => item.id,
      },
    },
    state,
  });
}

/**
 * A plugin with declared components expands in the Table like a folder of
 * "Attachments"; its components are not top-level rows.
 */
function agentContextPluginHierarchy({
  expanded,
  onToggle,
}: AgentContextExpansion): Extract<
  CollectionPresentationLayout<AgentContextItem>,
  { kind: "table" }
>["hierarchy"] {
  return {
    getBranch: (item) =>
      item.components.length > 0
        ? { expanded: expanded.has(item.id), rows: item.components }
        : null,
    getLabel: (item) => item.name,
    onToggle: (item) => onToggle(item.id),
  };
}

const presetEmpty: Readonly<
  Record<
    AgentContextPresetId,
    { icon: typeof Layers; title(): string; description(): string }
  >
> = {
  all: {
    description: m.agent_context_all_empty_description,
    icon: Layers,
    title: m.agent_context_all_empty_title,
  },
  instructions: {
    description: m.agent_context_empty_description,
    icon: FileText,
    title: m.agent_context_empty_title,
  },
  plugins: {
    description: m.agent_context_plugins_empty_description,
    icon: Puzzle,
    title: m.agent_context_plugins_empty_title,
  },
  skills: {
    description: m.agent_context_skills_empty_description,
    icon: Sparkles,
    title: m.agent_context_skills_empty_title,
  },
};

/** The empty set of a preset, named by its type. */
export function AgentContextPresetEmpty({ id }: { id: AgentContextPresetId }) {
  const empty = presetEmpty[id];
  const Icon = empty.icon;
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{empty.title()}</EmptyTitle>
        <EmptyDescription>{empty.description()}</EmptyDescription>
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
  if (id === "plugins") return m.agent_context_plugins();
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
