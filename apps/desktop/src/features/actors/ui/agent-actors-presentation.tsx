import type { AgentAdapterDictionary } from "@/features/agent-adapters";
import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import { AgentAvatar } from "@/features/identity";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareAgentActorsByDefault } from "../model/agent-actor-draft";
import type { AgentActorFacts } from "../model/agent-actor-facts";
import type { AgentActorItem } from "../model/agent-actor-types";
import {
  AGENT_ACTOR_READINESS,
  agentActorAgentLabel,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

export interface AgentActorsPresentationActions {
  createState: CollectionActionState;
  getDeleteState(item: AgentActorItem): CollectionActionState;
  getEditState(item: AgentActorItem): CollectionActionState;
  onAdd(): void;
  onDelete(item: AgentActorItem): void;
  onEdit(item: AgentActorItem): void;
}

export function createAgentActorsPresentation({
  actions,
  agents,
  facts,
  inheritedVisible,
  onActivate,
  state,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  facts(item: AgentActorItem): AgentActorFacts;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorItem>["onActivate"];
  state: CollectionPresentationState<AgentActorItem>;
}) {
  const items = state.phase === "ready" ? state.items : [];
  return defineCollectionPresentation({
    descriptor: createAgentActorsPresentationDescriptor({
      actions,
      agents,
      facts,
      inheritedVisible,
      onActivate,
      items,
    }),
    state,
  });
}

export function createAgentActorsPresentationDescriptor({
  actions,
  agents,
  facts,
  inheritedVisible,
  onActivate,
  items,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  /** What the collection shows of an Agent on this device. */
  facts(item: AgentActorItem): AgentActorFacts;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorItem>["onActivate"];
  items: readonly AgentActorItem[];
}): CollectionPresentationDescriptor<AgentActorItem> {
  const agentLabel = (item: AgentActorItem) =>
    agentActorAgentLabel(item.binding, facts(item), (agent) =>
      agents.label(agent),
    );
  const modeLabel = (item: AgentActorItem) => agentActorModeLabel(facts(item));
  const readinessLabel = (item: AgentActorItem) => {
    const readiness = facts(item).readiness;
    return readiness ? agentActorReadinessLabel(readiness) : null;
  };
  const options = (names: (string | null)[]) =>
    [...new Set(names.filter((name): name is string => name !== null))].map(
      (name) => ({ color: "neutral" as const, name }),
    );
  const properties: readonly CollectionPropertyDefinition<AgentActorItem>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: agentLabel,
      key: "agent",
      label: m.agent_actors_agent_label(),
      standard: {
        options: options(items.map(agentLabel)),
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: modeLabel,
      key: "approval",
      label: m.agent_actors_field_approval(),
      standard: {
        options: options(items.map(modeLabel)),
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: readinessLabel,
      key: "status",
      label: m.agent_actors_field_status(),
      standard: {
        options: AGENT_ACTOR_READINESS.map((readiness) => ({
          color: readiness === "ready" ? ("green" as const) : ("red" as const),
          name: agentActorReadinessLabel(readiness),
        })),
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (item) => item.ownerLabel,
      key: "space",
      label: m.agent_actors_field_space(),
      standard: {
        options: options(items.map((item) => item.ownerLabel)),
        type: "select",
      },
    }),
  ];

  return {
    create: {
      label: m.agent_actors_add(),
      intents: [
        {
          getState: () => actions.createState,
          id: "add-agent",
          label: m.agent_actors_add(),
          run: actions.onAdd,
        },
      ],
    },
    onActivate,
    properties,
    getItemId: agentActorItemId,
    id: "agents",
    label: m.agent_actors_presentation(),
    layout: {
      density: "compact",
      getDescription: (item) =>
        item.description ||
        (item.inherited
          ? m.agent_actors_inherited({ owner: item.ownerLabel })
          : null),
      getTitle: (item) => item.name,
      kind: "list",
      renderLeading: () => <AgentAvatar shape="square" size="sm" />,
      visibleProperties: inheritedVisible
        ? ["agent", "status", "space"]
        : ["agent", "status"],
    },
    query: {
      defaultCompare: compareAgentActorsByDefault,
      getSearchText: (item) =>
        `${item.name} ${item.description ?? ""} ${item.ownerLabel} ${agentLabel(item)}`,
    },
    itemActions: [
      {
        getState: actions.getEditState,
        id: "edit-agent",
        label: m.agent_actors_edit(),
        run: actions.onEdit,
      },
      {
        getState: actions.getDeleteState,
        id: "delete-agent",
        label: m.agent_actors_delete(),
        run: actions.onDelete,
      },
    ],
  };
}

export function agentActorItemId(item: AgentActorItem): string {
  return JSON.stringify([item.ownerPath, item.id]);
}
