import { Bot } from "lucide-react";

import {
  defineSystemCollectionPresentation,
  type SystemCollectionActionState,
  type SystemCollectionDetailRequest,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionPresentationDescriptor,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import type { Column } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { compareAgentActorsByDefault } from "../model/agent-actor-draft";
import type { AgentActorRow } from "../model/agent-actor-types";

export interface AgentActorsPresentationActions {
  createState: SystemCollectionActionState;
  getDeleteState(row: AgentActorRow): SystemCollectionActionState;
  getEditState(row: AgentActorRow): SystemCollectionActionState;
  onAdd(): void;
  onDelete(row: AgentActorRow): void;
  onEdit(row: AgentActorRow): void;
}

export function createAgentActorsPresentation({
  actions,
  inheritedVisible,
  onRefresh,
  refreshing,
  renderDetail,
  state,
}: {
  actions: AgentActorsPresentationActions;
  inheritedVisible: boolean;
  onRefresh(): void | Promise<void>;
  refreshing: boolean;
  renderDetail(
    row: AgentActorRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  state: SystemCollectionPresentationState<AgentActorRow>;
}) {
  const rows = state.phase === "ready" ? state.rows : [];
  return defineSystemCollectionPresentation({
    descriptor: createAgentActorsPresentationDescriptor({
      actions,
      inheritedVisible,
      onRefresh,
      refreshing,
      renderDetail,
      rows,
    }),
    state,
  });
}

export function createAgentActorsPresentationDescriptor({
  actions,
  inheritedVisible,
  onRefresh,
  refreshing,
  renderDetail,
  rows,
}: {
  actions: AgentActorsPresentationActions;
  inheritedVisible: boolean;
  onRefresh(): void | Promise<void>;
  refreshing: boolean;
  renderDetail(
    row: AgentActorRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  rows: readonly AgentActorRow[];
}): SystemCollectionPresentationDescriptor<AgentActorRow> {
  const ownerOptions = [...new Set(rows.map((row) => row.ownerLabel))].map(
    (name) => ({ color: "neutral" as const, name }),
  );
  const fields: readonly SystemCollectionFieldDescriptor<AgentActorRow>[] = [
    propertyField(
      "clients",
      m.agent_actors_field_clients(),
      {
        name: "clients",
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "multi_select",
      },
      (row) => row.adapters.map((binding) => adapterLabel(binding.adapter)),
    ),
    propertyField(
      "primary",
      m.agent_actors_field_primary(),
      {
        name: "primary",
        options: [
          { color: "blue", name: "Codex" },
          { color: "orange", name: "Claude Code" },
        ],
        type: "select",
      },
      (row) => adapterLabel(row.adapters[0]!.adapter),
    ),
    propertyField(
      "approval",
      m.agent_actors_field_approval(),
      {
        name: "approval",
        options: [
          { color: "neutral", name: m.agent_actors_approval_ask() },
          { color: "yellow", name: m.agent_actors_approval_auto() },
          { color: "red", name: m.agent_actors_approval_full() },
        ],
        type: "select",
      },
      (row) => approvalLabel(row.approvalMode),
    ),
    propertyField(
      "status",
      m.agent_actors_field_status(),
      {
        name: "status",
        options: [
          { color: "green", name: m.agent_actors_status_ready() },
          { color: "red", name: m.agent_actors_status_attention() },
          { color: "neutral", name: m.agent_actors_status_unchecked() },
        ],
        type: "select",
      },
      (row) => runtimeStatusLabel(row.runtimeStatus),
    ),
    propertyField(
      "space",
      m.agent_actors_field_space(),
      { name: "space", options: ownerOptions, type: "select" },
      (row) => row.ownerLabel,
    ),
  ];

  return {
    create: {
      getState: () => actions.createState,
      id: "add-agent",
      label: m.agent_actors_add(),
      run: actions.onAdd,
    },
    createDetailRequest: renderDetail,
    fields,
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
      visibleFields: inheritedVisible
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
    refresh: {
      getState: () => (refreshing ? { status: "pending" } : { status: "idle" }),
      id: "refresh-agent-actors",
      label: m.agent_actors_refresh(),
      run: onRefresh,
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
  column: Column,
  getValue: (row: AgentActorRow) => unknown,
): SystemCollectionFieldDescriptor<AgentActorRow> {
  return {
    filter: { kind: "property" },
    getValue,
    key,
    label,
    sort: { kind: "property" },
    valueSemantics: { column, kind: "property" },
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
