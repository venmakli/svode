import {
  FileText,
  Layers,
  Puzzle,
  Server,
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
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  defineCollectionPresentation,
  normalizeCollectionSearchText,
  type CollectionPresentationDescriptor,
  type CollectionPresentationLayout,
  type CollectionPresentationState,
} from "@/features/collection";
import type { CollectionPropertyDefinition } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { agentContextMcpCommandText } from "../model/mcp-server";
import type { AgentContextItem, AgentContextItemKind } from "../model/types";
import { agentContextHealthWarnings } from "./health-property";
import {
  AgentContextItemIcon,
  agentContextItemDescription,
  agentContextItemKindLabel,
  agentContextLocationLabel,
} from "./item-properties";

/** Built-in presets over the one set of items, "All" first. */
export const AGENT_CONTEXT_PRESETS = [
  "all",
  "instructions",
  "skills",
  "plugins",
  "mcp_servers",
] as const;
export type AgentContextPresetId = (typeof AGENT_CONTEXT_PRESETS)[number];

const presetKinds: Readonly<
  Record<Exclude<AgentContextPresetId, "all">, AgentContextItemKind>
> = {
  instructions: "instruction",
  mcp_servers: "mcp_server",
  plugins: "plugin",
  skills: "skill",
};

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
      layout: presetLayout(id, expansion),
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
            agentContextItemDescription(item) ?? "",
            agentContextItemKindLabel(item.kind),
            agentContextLocationLabel(item.location),
            agentContextMcpCommandText(item.mcp?.command ?? []),
            item.mcp?.url ?? "",
            ...item.components.map((component) => component.name),
          ].join(" "),
        getSortTieBreakId: (item) => item.id,
      },
    },
    state,
  });
}

/**
 * "All" is a Table whose plugins expand; Instructions, Skills and Plugins
 * are Galleries; MCP servers a List described by their transport.
 */
function presetLayout(
  id: AgentContextPresetId,
  expansion: AgentContextExpansion | undefined,
): CollectionPresentationLayout<AgentContextItem> {
  const renderLeading = (item: AgentContextItem) => (
    <AgentContextItemIcon
      className="size-4 text-muted-foreground"
      item={item}
    />
  );
  if (id === "all") {
    return {
      density: "compact",
      ...(expansion
        ? { hierarchy: agentContextPluginHierarchy(expansion) }
        : {}),
      kind: "table",
      primaryProperty: "name",
      renderLeading,
      visibleProperties: [
        "name",
        "type",
        "providers",
        "health",
        "location",
        "modified",
      ],
    };
  }
  if (id === "mcp_servers") {
    return {
      density: "compact",
      getDescription: (item) => (
        <span className="block min-w-0 truncate">
          {agentContextItemDescription(item)}
        </span>
      ),
      getTitle: (item) => item.name,
      kind: "list",
      renderLeading,
      visibleProperties: ["location", "providers", "health"],
    };
  }
  return {
    cardSize: "medium",
    density: "compact",
    ...(id === "skills" || id === "plugins"
      ? {
          // Without a description the card has no description line.
          getDescription: (item: AgentContextItem) =>
            item.description ? (
              <span className="line-clamp-3 leading-relaxed">
                {item.description}
              </span>
            ) : null,
        }
      : {}),
    getTitle: (item) => item.name,
    kind: "gallery",
    renderLeading,
    renderOverlays: (item) => <ItemProblemsMarker item={item} />,
    visibleProperties: ["location", "providers"],
  };
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
  mcp_servers: {
    description: m.agent_context_mcp_servers_empty_description,
    icon: Server,
    title: m.agent_context_mcp_servers_empty_title,
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
  if (id === "mcp_servers") return m.agent_context_mcp_servers();
  return m.agent_context_preset_all();
}

/** "Has problems" on the card of a problem row only. */
function ItemProblemsMarker({ item }: { item: AgentContextItem }) {
  const agents = useAgentAdapterDictionary();
  const warnings = agentContextHealthWarnings(agents, item);
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
