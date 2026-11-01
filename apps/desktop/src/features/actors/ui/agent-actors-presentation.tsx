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
import type { AgentActorRow } from "../model/agent-actor-types";
import {
  AGENT_ACTOR_READINESS,
  agentActorAgentLabel,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

export interface AgentActorsPresentationActions {
  createState: CollectionActionState;
  getDeleteState(row: AgentActorRow): CollectionActionState;
  getEditState(row: AgentActorRow): CollectionActionState;
  onAdd(): void;
  onDelete(row: AgentActorRow): void;
  onEdit(row: AgentActorRow): void;
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
  facts(row: AgentActorRow): AgentActorFacts;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorRow>["onActivate"];
  state: CollectionPresentationState<AgentActorRow>;
}) {
  const rows = state.phase === "ready" ? state.rows : [];
  return defineCollectionPresentation({
    descriptor: createAgentActorsPresentationDescriptor({
      actions,
      agents,
      facts,
      inheritedVisible,
      onActivate,
      rows,
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
  rows,
}: {
  actions: AgentActorsPresentationActions;
  agents: AgentAdapterDictionary;
  /** What the collection shows of an Agent on this device. */
  facts(row: AgentActorRow): AgentActorFacts;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorRow>["onActivate"];
  rows: readonly AgentActorRow[];
}): CollectionPresentationDescriptor<AgentActorRow> {
  const agentLabel = (row: AgentActorRow) =>
    agentActorAgentLabel(row.binding, facts(row), (agent) =>
      agents.label(agent),
    );
  const modeLabel = (row: AgentActorRow) => agentActorModeLabel(facts(row));
  const readinessLabel = (row: AgentActorRow) => {
    const readiness = facts(row).readiness;
    return readiness ? agentActorReadinessLabel(readiness) : null;
  };
  const options = (names: (string | null)[]) =>
    [...new Set(names.filter((name): name is string => name !== null))].map(
      (name) => ({ color: "neutral" as const, name }),
    );
  const properties: readonly CollectionPropertyDefinition<AgentActorRow>[] = [
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
        options: options(rows.map(agentLabel)),
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
        options: options(rows.map(modeLabel)),
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
      getValue: (row) => row.ownerLabel,
      key: "space",
      label: m.agent_actors_field_space(),
      standard: {
        options: options(rows.map((row) => row.ownerLabel)),
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
    getRowId: agentActorRowId,
    id: "agents",
    label: m.agent_actors_presentation(),
    layout: {
      density: "compact",
      getDescription: (row) =>
        row.description ||
        (row.inherited
          ? m.agent_actors_inherited({ owner: row.ownerLabel })
          : null),
      getTitle: (row) => row.name,
      kind: "list",
      renderLeading: () => <AgentAvatar shape="square" size="sm" />,
      visibleProperties: inheritedVisible
        ? ["agent", "status", "space"]
        : ["agent", "status"],
    },
    query: {
      defaultCompare: compareAgentActorsByDefault,
      getSearchText: (row) =>
        `${row.name} ${row.description ?? ""} ${row.ownerLabel} ${agentLabel(row)}`,
    },
    rowActions: [
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

export function agentActorRowId(row: AgentActorRow): string {
  return JSON.stringify([row.ownerPath, row.id]);
}
