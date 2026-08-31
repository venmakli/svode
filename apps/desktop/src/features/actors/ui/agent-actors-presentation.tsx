import { Bot } from "lucide-react";

import {
  defineCollectionCorePresentation,
  type CollectionCoreActionState,
  type CollectionCorePresentationDescriptor,
  type CollectionCorePresentationState,
} from "@/features/collection/core";
import type {
  CollectionPropertyDefinition,
  CollectionPropertyOrigin,
  CollectionStandardPropertySemantics,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareAgentActorsByDefault } from "../model/agent-actor-draft";
import type { AgentActorRow } from "../model/agent-actor-types";

export interface AgentActorsPresentationActions {
  createState: CollectionCoreActionState;
  getDeleteState(row: AgentActorRow): CollectionCoreActionState;
  getEditState(row: AgentActorRow): CollectionCoreActionState;
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
  onActivate?: CollectionCorePresentationDescriptor<AgentActorRow>["onActivate"];
  state: CollectionCorePresentationState<AgentActorRow>;
}) {
  const rows = state.phase === "ready" ? state.rows : [];
  return defineCollectionCorePresentation({
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
  onActivate?: CollectionCorePresentationDescriptor<AgentActorRow>["onActivate"];
  rows: readonly AgentActorRow[];
}): CollectionCorePresentationDescriptor<AgentActorRow> {
  const ownerOptions = [...new Set(rows.map((row) => row.ownerLabel))].map(
    (name) => ({ color: "neutral" as const, name }),
  );
  const properties: readonly CollectionPropertyDefinition<AgentActorRow>[] = [
    propertyField(
      "clients",
      m.agent_actors_field_clients(),
      {
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "multi_select",
      },
      (row) => row.adapters.map((binding) => adapterLabel(binding.adapter)),
      "owner_defined",
    ),
    propertyField(
      "primary",
      m.agent_actors_field_primary(),
      {
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "select",
      },
      (row) => adapterLabel(row.adapters[0]!.adapter),
      "owner_defined",
    ),
    propertyField(
      "approval",
      m.agent_actors_field_approval(),
      {
        options: [
          { color: "neutral", name: m.agent_actors_approval_ask() },
          { color: "yellow", name: m.agent_actors_approval_auto() },
          { color: "red", name: m.agent_actors_approval_full() },
        ],
        type: "select",
      },
      (row) => approvalLabel(row.approvalMode),
      "owner_defined",
    ),
    propertyField(
      "status",
      m.agent_actors_field_status(),
      {
        options: [
          { color: "green", name: m.agent_actors_status_ready() },
          { color: "red", name: m.agent_actors_status_attention() },
          { color: "neutral", name: m.agent_actors_status_unchecked() },
        ],
        type: "select",
      },
      (row) => runtimeStatusLabel(row.runtimeStatus),
      "computed",
    ),
    propertyField(
      "space",
      m.agent_actors_field_space(),
      { options: ownerOptions, type: "select" },
      (row) => row.ownerLabel,
      "owner_defined",
    ),
  ];

  return {
    create: {
      getState: () => actions.createState,
      id: "add-agent",
      label: m.agent_actors_add(),
      run: actions.onAdd,
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

function propertyField(
  key: string,
  label: string,
  standard: CollectionStandardPropertySemantics,
  getValue: (row: AgentActorRow) => unknown,
  origin: Exclude<
    CollectionPropertyOrigin,
    "schema_backed" | "domain_specific"
  >,
): CollectionPropertyDefinition<AgentActorRow> {
  return {
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    getValue,
    key,
    label,
    origin,
    owner: { featureId: "actors", kind: "feature" },
    semantics: { kind: "standard", standard },
  };
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
