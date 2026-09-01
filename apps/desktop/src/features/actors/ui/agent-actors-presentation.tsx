import { Bot } from "lucide-react";

import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareAgentActorsByDefault } from "../model/agent-actor-draft";
import type { AgentActorRow } from "../model/agent-actor-types";

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
  inheritedVisible,
  onActivate,
  state,
}: {
  actions: AgentActorsPresentationActions;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorRow>["onActivate"];
  state: CollectionPresentationState<AgentActorRow>;
}) {
  const rows = state.phase === "ready" ? state.rows : [];
  return defineCollectionPresentation({
    descriptor: createAgentActorsPresentationDescriptor({
      actions,
      inheritedVisible,
      onActivate,
      rows,
    }),
    state,
  });
}

export function createAgentActorsPresentationDescriptor({
  actions,
  inheritedVisible,
  onActivate,
  rows,
}: {
  actions: AgentActorsPresentationActions;
  inheritedVisible: boolean;
  onActivate?: CollectionPresentationDescriptor<AgentActorRow>["onActivate"];
  rows: readonly AgentActorRow[];
}): CollectionPresentationDescriptor<AgentActorRow> {
  const ownerOptions = [...new Set(rows.map((row) => row.ownerLabel))].map(
    (name) => ({ color: "neutral" as const, name }),
  );
  const properties: readonly CollectionPropertyDefinition<AgentActorRow>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) =>
        row.adapters.map((binding) => adapterLabel(binding.adapter)),
      key: "clients",
      label: m.agent_actors_field_clients(),
      standard: {
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "multi_select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) => adapterLabel(row.adapters[0]!.adapter),
      key: "primary",
      label: m.agent_actors_field_primary(),
      standard: {
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) => approvalLabel(row.approvalMode),
      key: "approval",
      label: m.agent_actors_field_approval(),
      standard: {
        options: [
          { color: "neutral", name: m.agent_actors_approval_ask() },
          { color: "yellow", name: m.agent_actors_approval_auto() },
          { color: "red", name: m.agent_actors_approval_full() },
        ],
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "actors",
      getValue: (row) => runtimeStatusLabel(row.runtimeStatus),
      key: "status",
      label: m.agent_actors_field_status(),
      standard: {
        options: [
          { color: "green", name: m.agent_actors_status_ready() },
          { color: "red", name: m.agent_actors_status_attention() },
          { color: "neutral", name: m.agent_actors_status_unchecked() },
        ],
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
      standard: { options: ownerOptions, type: "select" },
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
          : row.actorRef),
      getTitle: (row) => row.name,
      kind: "list",
      renderLeading: () => <Bot className="size-5 text-muted-foreground" />,
      visibleProperties: inheritedVisible
        ? ["primary", "status", "space"]
        : ["primary", "status"],
    },
    query: {
      defaultCompare: compareAgentActorsByDefault,
      getSearchText: (row) =>
        `${row.name} ${row.description ?? ""} ${row.ownerLabel} ${row.adapters
          .map((binding) => adapterLabel(binding.adapter))
          .join(" ")}`,
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

function adapterLabel(adapter: AgentActorRow["adapters"][number]["adapter"]) {
  return adapter === "codex" ? "Codex" : "Claude Code";
}

function approvalLabel(mode: AgentActorRow["approvalMode"]) {
  if (mode === "auto") return m.agent_actors_approval_auto();
  if (mode === "full") return m.agent_actors_approval_full();
  return m.agent_actors_approval_ask();
}

function runtimeStatusLabel(status: AgentActorRow["runtimeStatus"]) {
  if (status === "ready") return m.agent_actors_status_ready();
  if (status === "attention") return m.agent_actors_status_attention();
  return m.agent_actors_status_unchecked();
}
