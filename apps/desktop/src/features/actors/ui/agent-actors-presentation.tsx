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
import type { ReactNode } from "react";

import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  defineSpaceCollectionProperty,
  defineTitleCollectionProperty,
  type CollectionPropertyActionState,
  type CollectionPropertyDefinition,
  type CollectionPropertyEdit,
  type CollectionPropertyOwnPopoverEditorInput,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import {
  agentActorBindingEdit,
  compareAgentActorsByDefault,
} from "../model/agent-actor-draft";
import type { AgentActorFacts } from "../model/agent-actor-facts";
import type {
  AgentActorBindingEdit,
  AgentActorItem,
} from "../model/agent-actor-types";
import {
  AGENT_ACTOR_READINESS,
  agentActorAgentValue,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

export interface AgentActorsPresentationActions {
  createState: CollectionActionState;
  getDeleteState(item: AgentActorItem): CollectionActionState;
  onAdd(): void;
  onDelete(item: AgentActorItem): void;
}

/**
 * The editing of an Agent's "Agent" and "Approval mode" (Stage 11 `04`,
 * 4.I): one popover of the binding, saved whole when it closes.
 */
export interface AgentActorsPresentationEditing {
  /** Whether the binding can change; a disabled reason shows at "Agent". */
  getState(item: AgentActorItem): CollectionPropertyActionState;
  update(item: AgentActorItem, edit: AgentActorBindingEdit): Promise<void>;
  renderPopover(
    input: CollectionPropertyOwnPopoverEditorInput<AgentActorItem>,
    opensOnMode: boolean,
  ): ReactNode;
}

export function createAgentActorsPresentation({
  actions,
  agents,
  editing,
  facts,
  inheritedVisible,
  onActivate,
  spaceName,
  state,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  editing?: AgentActorsPresentationEditing;
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
      editing,
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
  editing,
  facts,
  inheritedVisible,
  onActivate,
  items,
  spaceName,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  /** How the property panel edits an Agent; read-only without it. */
  editing?: AgentActorsPresentationEditing;
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
  const bindingEdit = (
    opensOnMode: boolean,
    getState: (item: AgentActorItem) => CollectionPropertyActionState,
  ): CollectionPropertyEdit<AgentActorItem> | undefined =>
    editing && {
      getState,
      // The reason an Agent cannot be edited shows once, at "Agent".
      showDisabledReason: !opensOnMode,
      update: (item, value) =>
        editing.update(item, value as AgentActorBindingEdit),
      popover: {
        getDraft: agentActorBindingEdit,
        renderPopover: (input) => editing.renderPopover(input, opensOnMode),
      },
    };
  const agentEdit = bindingEdit(false, (item) => editing!.getState(item));
  // Empty for the participant's agent and an agent without modes, where
  // "Approval mode" is read-only and the panel leaves it out.
  const modeEdit = bindingEdit(true, (item) =>
    facts(item).mode === null
      ? { reason: "", status: "disabled" }
      : editing!.getState(item),
  );
  const properties: readonly CollectionPropertyDefinition<AgentActorItem>[] = [
    defineTitleCollectionProperty({ getValue: (item) => item.name }),
    defineSpaceCollectionProperty({ getValue: ownerSpaceName, items }),
    defineAgentCollectionProperty({
      agents,
      edit: agentEdit,
      getAgent: agentValue,
      items,
    }),
    // The device mode an Agent keeps: the owner's own, editable property.
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        edit: modeEdit,
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
        getState: actions.getDeleteState,
        id: "delete-agent",
        label: m.agent_actors_delete(),
        run: actions.onDelete,
      },
    ],
  };
}

export function agentActorItemId(
  item: Pick<AgentActorItem, "id" | "ownerPath">,
): string {
  return JSON.stringify([item.ownerPath, item.id]);
}
