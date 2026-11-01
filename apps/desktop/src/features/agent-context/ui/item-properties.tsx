import { FileText, Puzzle, Server, Sparkles } from "lucide-react";

import { cn } from "@/shared/lib/utils";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineAgentsCollectionProperty,
  type AgentAdapterDictionary,
  type AgentsPropertyNotes,
} from "@/features/agent-adapters";
import {
  defineComputedCollectionProperty,
  defineStateCollectionProperty,
  defineTitleCollectionProperty,
  defineUpdatedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import {
  agentContextIdleAgents,
  type AgentContextIdleAgent,
} from "../model/idle-agents";
import { agentContextMcpSummary } from "../model/mcp-server";
import type {
  AgentContextItem,
  AgentContextItemKind,
  AgentContextLocation,
} from "../model/types";
import { agentContextHealthWarnings } from "./health-warnings";
import {
  agentContextMissingFieldsText,
  agentContextRejectionTexts,
} from "./skill-rejection-text";

/**
 * The icon of an item everywhere it is shown: the Svode logo on the Svode
 * integration, the image its source declares, else the fallback of its type.
 */
export function AgentContextItemIcon({
  className,
  item,
}: {
  className?: string;
  item: Pick<AgentContextItem, "icon" | "kind" | "managedBySvode">;
}) {
  const image = item.managedBySvode ? "/logo.png" : item.icon;
  if (image) {
    return (
      <img
        alt=""
        className={cn("size-4 shrink-0 object-contain", className)}
        data-agent-context-icon={item.managedBySvode ? "svode" : "source"}
        src={image}
      />
    );
  }
  const Icon =
    item.kind === "skill"
      ? Sparkles
      : item.kind === "plugin"
        ? Puzzle
        : item.kind === "mcp_server"
          ? Server
          : FileText;
  return <Icon className={className} aria-hidden />;
}

export function agentContextItemKindLabel(kind: AgentContextItemKind) {
  if (kind === "skill") return m.agent_context_type_skill();
  if (kind === "plugin") return m.agent_context_type_plugin();
  if (kind === "mcp_server") return m.agent_context_type_mcp_server();
  return m.agent_context_type_instruction();
}

/**
 * The description of an item: its source's, or for an MCP server outside a
 * plugin what its declaration starts — "Local server · package or command"
 * or "Remote server · domain".
 */
export function agentContextItemDescription(
  item: Pick<AgentContextItem, "description" | "kind" | "mcp">,
): string | null {
  if (item.description || item.kind !== "mcp_server" || !item.mcp) {
    return item.description;
  }
  const summary = agentContextMcpSummary(item.mcp);
  if (!summary) return null;
  return summary.kind === "local"
    ? m.agent_context_mcp_local({ target: summary.target })
    : m.agent_context_mcp_remote({ domain: summary.domain });
}

/** A short path: the Space root by name, home paths from `~`. */
export function agentContextLocationLabel(location: AgentContextLocation) {
  if (location.kind === "target") {
    return location.path || m.agent_context_location_space();
  }
  if (location.kind === "home") {
    return location.path ? `~/${location.path}` : "~";
  }
  return location.path;
}

/** Why "Agents" is empty, in one line. */
export function agentContextUnappliedText(
  agents: AgentAdapterDictionary,
  item: AgentContextItem,
) {
  if (item.unapplied?.kind === "rejected") {
    return agentContextRejectionTexts(agents, item.unapplied.by).join("; ");
  }
  if (item.unapplied?.kind === "disabled") {
    return m.agent_context_unapplied_disabled();
  }
  if (item.unapplied?.kind === "superseded") {
    return item.unapplied.by.length > 0
      ? m.agent_context_unapplied_superseded_by({
          paths: item.unapplied.by.join(", "),
        })
      : m.agent_context_unapplied_superseded();
  }
  return m.agent_context_unapplied_not_found();
}

/**
 * The properties of "Context" in their column order: Name, Type, Agents,
 * Status, Location, Modified.
 */
export function createAgentContextItemProperties({
  agents,
  onOpenProviders,
}: {
  agents: AgentAdapterDictionary;
  onOpenProviders?: () => void;
}): readonly CollectionPropertyDefinition<AgentContextItem>[] {
  return [
    defineTitleCollectionProperty({ getValue: (item) => item.name }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-context",
      getValue: (item) => agentContextItemKindLabel(item.kind),
      key: "type",
      label: m.agent_context_property_type(),
      standard: {
        options: [
          { color: "blue", name: m.agent_context_type_instruction() },
          { color: "purple", name: m.agent_context_type_skill() },
          { color: "orange", name: m.agent_context_type_plugin() },
          { color: "green", name: m.agent_context_type_mcp_server() },
        ],
        type: "select",
      },
    }),
    defineAgentsCollectionProperty({
      agents,
      getAgents: (item) => item.providers,
      getNotes: (item) => agentsNotes(agents, item, onOpenProviders),
    }),
    defineStateCollectionProperty({
      getProblems: (item) => agentContextHealthWarnings(agents, item),
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      display: {
        render: (value) => <LocationCell location={String(value)} />,
        renderDetail: (value, item) =>
          item.location.kind === "target" && !item.location.path ? (
            String(value)
          ) : (
            <code className="block min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-5 select-text">
              {String(value)}
            </code>
          ),
      },
      featureId: "agent-context",
      getValue: (item) => agentContextLocationLabel(item.location),
      key: "location",
      label: m.agent_context_location(),
      standard: { type: "text" },
    }),
    defineUpdatedCollectionProperty({ getValue: (item) => item.modifiedAt }),
  ];
}

/**
 * What "Agents" says around the applying agents: the agents that find the
 * item and do not apply it, why none applies it, the agents whose switch of
 * a plugin is kept outside files, and the way to Providers when enabling an
 * agent off in Svode would apply the item.
 */
function agentsNotes(
  agents: AgentAdapterDictionary,
  item: AgentContextItem,
  onOpenProviders: (() => void) | undefined,
): AgentsPropertyNotes {
  const idle = agentContextIdleAgents(item);
  const unverified = agentNames(agents, unverifiedProviders(item));
  return {
    detailAction:
      onOpenProviders &&
      idle.some((entry) => entry.reason.kind === "off_in_svode")
        ? {
            label: m.agent_context_open_providers(),
            onSelect: onOpenProviders,
          }
        : null,
    detailNote: unverified
      ? m.agent_context_unverified_note({ agents: unverified })
      : null,
    emptyReason:
      item.providers.length === 0 && idle.length === 0
        ? agentContextUnappliedText(agents, item)
        : null,
    idle: idle.map((entry) => ({
      agent: entry.agent,
      reason: idleAgentText(agents, entry),
    })),
  };
}

function LocationCell({ location }: { location: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block min-w-0 truncate">{location}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all">{location}</TooltipContent>
    </Tooltip>
  );
}

function idleAgentText(
  agents: AgentAdapterDictionary,
  { agent, reason }: AgentContextIdleAgent,
): string {
  const name = agents.label(agent);
  if (reason.kind === "rejected") {
    return m.agent_context_idle_rejected({
      agent: name,
      fields: agentContextMissingFieldsText(reason.missing),
    });
  }
  if (reason.kind === "off_in_svode") {
    return m.agent_context_idle_off({ agent: name });
  }
  if (reason.kind === "disabled") {
    return m.agent_context_idle_disabled({ agent: name });
  }
  return reason.by
    ? m.agent_context_idle_superseded({ agent: name, path: reason.by })
    : m.agent_context_idle_superseded_unknown({ agent: name });
}

/** Providers that apply a plugin whose switch they keep outside files. */
function unverifiedProviders(item: AgentContextItem): string[] {
  const unverified = new Set(
    item.sources.flatMap((source) =>
      source.readers
        .filter((reader) => reader.unverified)
        .map((reader) => reader.agent),
    ),
  );
  return item.providers.filter((agent) => unverified.has(agent));
}

function agentNames(
  agents: AgentAdapterDictionary,
  ids: readonly string[],
): string {
  return ids.map((agent) => agents.label(agent)).join(", ");
}
