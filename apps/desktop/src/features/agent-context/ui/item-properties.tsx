import { FileText, Puzzle, Server, Sparkles } from "lucide-react";

import { cn } from "@/shared/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AgentIcon,
  type AgentAdapterDictionary,
} from "@/features/agent-adapters";
import {
  defineComputedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { agentContextMcpSummary } from "../model/mcp-server";
import type {
  AgentContextItem,
  AgentContextItemKind,
  AgentContextLocation,
} from "../model/types";
import { agentContextHealthProperty } from "./health-property";

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

/** Why "Providers" is empty, in one line. */
export function agentContextUnappliedText(item: AgentContextItem) {
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
 * The properties of "Context" in their column order: Name, Type, Providers,
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
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-context",
      getValue: (item) => item.name,
      key: "name",
      label: m.agent_context_property_name(),
      standard: { type: "text" },
    }),
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
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      display: {
        render: (_value, item) => <ProvidersCell agents={agents} item={item} />,
        renderDetail: (_value, item) => (
          <ProvidersDetail
            agents={agents}
            item={item}
            onOpenProviders={onOpenProviders}
          />
        ),
      },
      featureId: "agent-context",
      getValue: (item) => item.providers.map((agent) => agents.label(agent)),
      key: "providers",
      label: m.agent_context_property_providers(),
      standard: { options: agents.options(), type: "multi_select" },
    }),
    agentContextHealthProperty<AgentContextItem>(),
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
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-context",
      getValue: (item) => item.modifiedAt,
      key: "modified",
      label: m.agent_context_property_modified(),
      standard: { display: "medium", type: "date" },
    }),
  ];
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

/** Agent icons with their names on hover; empty with the reason on hover. */
function ProvidersCell({
  agents,
  item,
}: {
  agents: AgentAdapterDictionary;
  item: AgentContextItem;
}) {
  if (item.providers.length === 0) {
    const reason = agentContextUnappliedText(item);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="block h-5 w-full min-w-6"
            data-agent-context-providers-empty
          >
            <span className="sr-only">{reason}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm break-words">
          {reason}
        </TooltipContent>
      </Tooltip>
    );
  }
  const names = agentNames(agents, item.providers);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1"
          role="img"
          aria-label={names}
          data-agent-context-providers
        >
          {item.providers.map((agent) => (
            <AgentIcon key={agent} agent={agent} />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{names}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The agents with their names; an empty value explains itself below, and
 * when no enabled agent finds the item, names the agents that read it by
 * their policy with the way to Providers.
 */
function ProvidersDetail({
  agents,
  item,
  onOpenProviders,
}: {
  agents: AgentAdapterDictionary;
  item: AgentContextItem;
  onOpenProviders?: () => void;
}) {
  const readers = agentNames(
    agents,
    item.unapplied?.kind === "not_found" ? item.unapplied.readers : [],
  );
  if (item.providers.length > 0) {
    const unverified = agentNames(agents, unverifiedProviders(item));
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
          {item.providers.map((agent) => (
            <span key={agent} className="inline-flex items-center gap-1.5">
              <AgentIcon agent={agent} />
              {agents.label(agent)}
            </span>
          ))}
        </div>
        {unverified ? (
          <span
            className="text-xs text-muted-foreground"
            data-agent-context-providers-unverified
          >
            {m.agent_context_unverified_note({ agents: unverified })}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-agent-context-providers-reason
    >
      <span className="text-muted-foreground">-</span>
      {item.unapplied?.kind === "disabled" ? (
        <span className="text-xs text-muted-foreground">
          {m.agent_context_unapplied_disabled()}
        </span>
      ) : item.unapplied?.kind === "superseded" ? (
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
          <span>{m.agent_context_unapplied_superseded()}</span>
          {item.unapplied.by.map((path) => (
            <code
              key={path}
              className="block min-w-0 whitespace-pre-wrap break-all font-mono leading-5 select-text"
            >
              {path}
            </code>
          ))}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col items-start gap-0.5 text-xs text-muted-foreground">
          <span>{m.agent_context_unapplied_not_found()}</span>
          {readers ? (
            <span>
              {m.agent_context_unapplied_readers({ agents: readers })}
            </span>
          ) : null}
          {onOpenProviders ? (
            <Button
              className="h-auto p-0 text-xs"
              type="button"
              variant="link"
              onClick={onOpenProviders}
            >
              {m.agent_context_open_providers()}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
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
