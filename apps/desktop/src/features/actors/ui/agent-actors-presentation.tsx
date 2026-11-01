import {
  agentPropertyLabel,
  defineAgentCollectionProperty,
  type AgentAdapterDictionary,
  type AgentPropertyValue,
} from "@/features/agent-adapters";
import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import { AgentAvatar } from "@/features/identity";
import type { SpaceNameResolver } from "@/features/space";
import {
  defineComputedCollectionProperty,
  defineSpaceCollectionProperty,
  defineTitleCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareAgentActorsByDefault } from "../model/agent-actor-draft";
import type { AgentActorFacts } from "../model/agent-actor-facts";
import type { AgentActorItem } from "../model/agent-actor-types";
import {
  AGENT_ACTOR_READINESS,
  agentActorAgentValue,
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
  spaceName,
  state,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  facts(item: AgentActorItem): AgentActorFacts;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorItem>["onActivate"];
  spaceName: SpaceNameResolver;
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
      spaceName,
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
  spaceName,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  /** What the collection shows of an Agent on this device. */
  facts(item: AgentActorItem): AgentActorFacts;
  /** Whether the set holds Agents inherited from the project root. */
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorItem>["onActivate"];
  items: readonly AgentActorItem[];
  spaceName: SpaceNameResolver;
}): CollectionPresentationDescriptor<AgentActorItem> {
  const agentValue = (item: AgentActorItem): AgentPropertyValue =>
    agentActorAgentValue(item.binding, facts(item));
  const agentLabel = (item: AgentActorItem) =>
    agentPropertyLabel(agents, agentValue(item));
  const modeLabel = (item: AgentActorItem) => agentActorModeLabel(facts(item));
  // The Space that owns the Agent: its own, or the project root it is
  // inherited from; named by the Space store, so a rename needs no write.
  const ownerSpaceName = (item: AgentActorItem) =>
    spaceName(item.ownerPath) ?? item.ownerLabel;
  const readinessLabel = (item: AgentActorItem) => {
    const readiness = facts(item).readiness;
    return readiness ? agentActorReadinessLabel(readiness) : null;
  };
  const options = (names: (string | null)[]) =>
    [...new Set(names.filter((name): name is string => name !== null))].map(
      (name) => ({ color: "neutral" as const, name }),
    );
  const properties: readonly CollectionPropertyDefinition<AgentActorItem>[] = [
    defineTitleCollectionProperty({ getValue: (item) => item.name }),
    defineSpaceCollectionProperty({ getValue: ownerSpaceName, items }),
    defineAgentCollectionProperty({ agents, getAgent: agentValue, items }),
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
      getDescription: (item) => item.description,
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
        `${item.name} ${item.description ?? ""} ${ownerSpaceName(item)} ${agentLabel(item)}`,
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
