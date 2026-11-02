import { UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineCommonCollectionProperty,
  type CollectionPropertyDefinition,
  type CollectionPropertyEdit,
  type PropertyOption,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AgentAdapterDictionary } from "../model/dictionary";
import { AgentIcon } from "./agent-icon";

/**
 * A value of "Agent": an agent of the dictionary, with a detail such as the
 * model of an Agent Actor's binding, or the participant's agent of a binding
 * (Stage 11 `03`).
 */
export type AgentPropertyValue =
  | { kind: "agent"; agent: string; detail?: string | null }
  | { kind: "participant" };

/** What "Agent" says for a value: its name in the agent dictionary. */
export function agentPropertyLabel(
  agents: AgentAdapterDictionary,
  value: AgentPropertyValue,
): string {
  return value.kind === "participant"
    ? m.agent_actors_participant_agent()
    : agents.label(value.agent);
}

/**
 * "Agent": one agent of the dictionary, drawn by its icon and name; options,
 * filter and sort follow the dictionary. The participant's agent is an
 * option where an item has it. An owner that keeps the agent of its items
 * may declare its editing, as Agent Actors edit their binding.
 */
export function defineAgentCollectionProperty<Item>({
  agents,
  edit,
  getAgent,
  items,
}: {
  agents: AgentAdapterDictionary;
  edit?: CollectionPropertyEdit<Item>;
  getAgent(item: Item): AgentPropertyValue | null;
  items: readonly Item[];
}): CollectionPropertyDefinition<Item> {
  const values = items.flatMap((item) => getAgent(item) ?? []);
  const options: PropertyOption[] = agents.options(
    values.flatMap((value) => (value.kind === "agent" ? [value.agent] : [])),
  );
  if (values.some((value) => value.kind === "participant")) {
    options.push({
      color: "neutral",
      name: m.agent_actors_participant_agent(),
    });
  }
  const property = defineCommonCollectionProperty<Item>("agent", {
    display: {
      render: (_value, item) => {
        const value = getAgent(item);
        return value ? <AgentValue agents={agents} value={value} /> : null;
      },
    },
    getValue: (item) => {
      const value = getAgent(item);
      return value ? agentPropertyLabel(agents, value) : null;
    },
    standard: { options, type: "select" },
  });
  return edit
    ? {
        ...property,
        capabilities: { ...property.capabilities, edit },
        origin: "owner_defined",
      }
    : property;
}

function AgentValue({
  agents,
  value,
}: {
  agents: AgentAdapterDictionary;
  value: AgentPropertyValue;
}) {
  const detail = value.kind === "agent" ? value.detail : null;
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1.5"
      data-agent-property={value.kind === "agent" ? value.agent : "participant"}
    >
      {value.kind === "agent" ? (
        <AgentIcon agent={value.agent} />
      ) : (
        <UsersRound
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
      <span className="truncate">{agentPropertyLabel(agents, value)}</span>
      {detail ? (
        <span className="truncate text-muted-foreground">{detail}</span>
      ) : null}
    </span>
  );
}

/** An agent that finds the item and does not act on it, with the reason. */
export interface IdleAgentNote {
  agent: string;
  reason: string;
}

/** What a Collection says around the value of "Agents" for its item. */
export interface AgentsPropertyNotes {
  /** Shown muted after the value, each with its reason on hover. */
  idle?: readonly IdleAgentNote[];
  /** Why the value is empty, on hover of the empty value. */
  emptyReason?: string | null;
  /** Under the value in the item's property panel. */
  detailNote?: string | null;
  /** Next to the value in the item's property panel. */
  detailAction?: { label: string; onSelect(): void } | null;
}

/**
 * "Agents": several agents of the dictionary, drawn by their icons in a cell
 * and by icon and name in the property panel; options, filter and sort
 * follow the dictionary.
 */
export function defineAgentsCollectionProperty<Item>({
  agents,
  getAgents,
  getNotes,
}: {
  agents: AgentAdapterDictionary;
  getAgents(item: Item): readonly string[];
  getNotes?(item: Item): AgentsPropertyNotes;
}): CollectionPropertyDefinition<Item> {
  const notes = (item: Item) => getNotes?.(item) ?? {};
  return defineCommonCollectionProperty<Item>("agents", {
    display: {
      render: (_value, item) => (
        <AgentsCell agents={agents} ids={getAgents(item)} notes={notes(item)} />
      ),
      renderDetail: (_value, item) => (
        <AgentsDetail
          agents={agents}
          ids={getAgents(item)}
          notes={notes(item)}
        />
      ),
    },
    getValue: (item) => getAgents(item).map((agent) => agents.label(agent)),
    standard: { options: agents.options(), type: "multi_select" },
  });
}

/**
 * The agents' icons, then the muted icons of the idle agents; names and
 * reasons on hover. Without any agent the cell is empty and says why on
 * hover.
 */
function AgentsCell({
  agents,
  ids,
  notes,
}: {
  agents: AgentAdapterDictionary;
  ids: readonly string[];
  notes: AgentsPropertyNotes;
}) {
  const idle = notes.idle ?? [];
  if (ids.length === 0 && idle.length === 0) {
    if (!notes.emptyReason) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block h-5 w-full min-w-6" data-agent-property-empty>
            <span className="sr-only">{notes.emptyReason}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm break-words">
          {notes.emptyReason}
        </TooltipContent>
      </Tooltip>
    );
  }
  const lines = [
    ...(ids.length > 0 ? [agentNames(agents, ids)] : []),
    ...idle.map((entry) => entry.reason),
  ];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1"
          role="img"
          aria-label={lines.join("; ")}
          data-agent-property-agents
        >
          {ids.map((agent) => (
            <AgentIcon key={agent} agent={agent} />
          ))}
          {idle.map(({ agent }) => (
            <AgentIcon key={agent} agent={agent} muted />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex max-w-sm flex-col gap-0.5 break-words">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The agents with their names, then the idle agents, muted, with the reason
 * on hover; the Collection's action and note where it gives them.
 */
function AgentsDetail({
  agents,
  ids,
  notes,
}: {
  agents: AgentAdapterDictionary;
  ids: readonly string[];
  notes: AgentsPropertyNotes;
}) {
  const idle = notes.idle ?? [];
  const action = notes.detailAction ? (
    <Button
      size="xs"
      type="button"
      variant="outline"
      onClick={notes.detailAction.onSelect}
    >
      {notes.detailAction.label}
    </Button>
  ) : null;
  if (ids.length === 0 && idle.length === 0) {
    if (!notes.emptyReason && !action) return null;
    return (
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
        data-agent-property-empty-reason
      >
        {notes.emptyReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground">
                -<span className="sr-only">{notes.emptyReason}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm break-words">
              {notes.emptyReason}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {action}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
        data-agent-property-detail
      >
        {ids.map((agent) => (
          <span key={agent} className="inline-flex items-center gap-1.5">
            <AgentIcon agent={agent} />
            {agents.label(agent)}
          </span>
        ))}
        {idle.map((entry) => (
          <Tooltip key={entry.agent}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center gap-1.5 text-muted-foreground"
                data-agent-property-idle={entry.agent}
              >
                <AgentIcon agent={entry.agent} muted />
                {agents.label(entry.agent)}
                <span className="sr-only">{entry.reason}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm break-words">
              {entry.reason}
            </TooltipContent>
          </Tooltip>
        ))}
        {action}
      </div>
      {notes.detailNote ? (
        <span
          className="text-xs text-muted-foreground"
          data-agent-property-note
        >
          {notes.detailNote}
        </span>
      ) : null}
    </div>
  );
}

function agentNames(
  agents: AgentAdapterDictionary,
  ids: readonly string[],
): string {
  return ids.map((agent) => agents.label(agent)).join(", ");
}
