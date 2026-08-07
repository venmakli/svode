import type { ReactNode } from "react";

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

import {
  compareRoutinesByTitle,
  routineSearchText,
} from "../model/routine-values";
import type { RoutineCatalogState, RoutineRow } from "../model/types";
import { RoutineTriggerIcon } from "./routine-trigger-icon";

export interface RoutinePresentationActions {
  createState: SystemCollectionActionState;
  getDeleteState(row: RoutineRow): SystemCollectionActionState;
  getEditState(row: RoutineRow): SystemCollectionActionState;
  getEnabledState(row: RoutineRow): SystemCollectionActionState;
  onAdd(): void;
  onDelete(row: RoutineRow): void;
  onEdit(row: RoutineRow): void;
  onEnabledChange(row: RoutineRow, enabled: boolean): Promise<void>;
}

export function createRoutinesPresentation({
  actions,
  createDetailRequest,
  getExecutorLabel,
  onRefresh,
  refreshing,
  state,
}: {
  actions: RoutinePresentationActions;
  createDetailRequest(
    row: RoutineRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  getExecutorLabel?(row: RoutineRow): string | null;
  onRefresh(): void | Promise<void>;
  refreshing: boolean;
  state: SystemCollectionPresentationState<RoutineRow>;
}) {
  return defineSystemCollectionPresentation({
    descriptor: createRoutinesPresentationDescriptor({
      actions,
      createDetailRequest,
      getExecutorLabel,
      onRefresh,
      refreshing,
    }),
    state,
  });
}

export function createRoutinesPresentationDescriptor({
  actions,
  createDetailRequest,
  getExecutorLabel = (row) =>
    row.definition?.action.type === "run_agent"
      ? row.definition.action.executor
      : null,
  onRefresh,
  refreshing,
}: {
  actions: RoutinePresentationActions;
  createDetailRequest(
    row: RoutineRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  onRefresh(): void | Promise<void>;
  getExecutorLabel?(row: RoutineRow): string | null;
  refreshing: boolean;
}): SystemCollectionPresentationDescriptor<RoutineRow> {
  const fields: readonly SystemCollectionFieldDescriptor<RoutineRow>[] = [
    propertyField(
      "enabled",
      m.routines_field_enabled(),
      { name: "enabled", type: "checkbox" },
      (row) => row.definition?.enabled ?? false,
      {
        getState: actions.getEnabledState,
        showDisabledReason: false,
        update: (row, value) => actions.onEnabledChange(row, value === true),
      },
    ),
    propertyField(
      "trigger",
      m.routines_field_trigger(),
      {
        name: "trigger",
        options: [
          { color: "neutral", name: m.routines_trigger_manual() },
          { color: "blue", name: m.routines_trigger_schedule() },
          { color: "purple", name: m.routines_trigger_event() },
        ],
        type: "select",
      },
      (row) => routineTriggerTypeLabel(row),
    ),
    propertyField(
      "action",
      m.routines_field_action(),
      {
        name: "action",
        options: [
          { color: "blue", name: m.routines_action_run_agent() },
          {
            color: "orange",
            name: m.routines_action_update_properties(),
          },
        ],
        type: "select",
      },
      (row) => routineActionTypeLabel(row),
    ),
    propertyField(
      "executor",
      m.routines_field_executor(),
      { name: "executor", type: "text" },
      getExecutorLabel,
    ),
    propertyField(
      "last-run",
      m.routines_field_last_run(),
      { display: "medium", name: "last-run", type: "date" },
      (row) => row.lastRunAt,
    ),
    propertyField(
      "next-run",
      m.routines_field_next_run(),
      { display: "medium", name: "next-run", type: "date" },
      (row) => row.nextRunAt,
    ),
  ];

  return {
    create: {
      getState: () => actions.createState,
      id: "add-routine",
      label: m.routines_add(),
      run: actions.onAdd,
    },
    createDetailRequest,
    fields,
    getRowId: (row) => row.id,
    id: "all",
    label: m.routines_presentation_all(),
    layout: {
      density: "compact",
      getDescription: (row) => row.description || row.filename,
      getTitle: (row) => row.title,
      kind: "list",
      renderLeading: (row) => (
        <RoutineTriggerIcon
          row={row}
          className={
            row.valid
              ? "size-5 text-muted-foreground"
              : "size-5 text-destructive"
          }
        />
      ),
      visibleFields: [
        "enabled",
        "trigger",
        "action",
        "executor",
        "last-run",
        "next-run",
      ],
    },
    query: {
      defaultCompare: compareRoutinesByTitle,
      getSearchText: (row) =>
        `${routineSearchText(row)} ${getExecutorLabel(row) ?? ""}`,
    },
    refresh: {
      getState: () => (refreshing ? { status: "pending" } : { status: "idle" }),
      id: "refresh-routines",
      label: m.routines_refresh(),
      run: onRefresh,
    },
    rowActions: [
      {
        getState: actions.getEditState,
        id: "edit-routine",
        label: m.routines_edit(),
        run: actions.onEdit,
      },
      {
        getState: actions.getDeleteState,
        id: "delete-routine",
        label: m.routines_delete(),
        run: actions.onDelete,
      },
    ],
  };
}

function propertyField(
  key: string,
  label: string,
  column: Column,
  getValue: (row: RoutineRow) => unknown,
  edit?: SystemCollectionFieldDescriptor<RoutineRow>["edit"],
): SystemCollectionFieldDescriptor<RoutineRow> {
  return {
    edit,
    filter: { kind: "property" },
    getValue,
    key,
    label,
    sort: { kind: "property" },
    valueSemantics: { column, kind: "property" },
  };
}

function routineTriggerTypeLabel(row: RoutineRow) {
  const type = row.definition?.trigger.type;
  if (type === "manual") return m.routines_trigger_manual();
  if (type === "schedule") return m.routines_trigger_schedule();
  if (type === "event") return m.routines_trigger_event();
  return null;
}

function routineActionTypeLabel(row: RoutineRow) {
  const type = row.definition?.action.type;
  if (type === "run_agent") return m.routines_action_run_agent();
  if (type === "update_properties") {
    return m.routines_action_update_properties();
  }
  return null;
}

export function toRoutinePresentationState(
  state: RoutineCatalogState,
): SystemCollectionPresentationState<RoutineRow> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: (
        <span className="flex flex-col gap-1">
          <strong>{m.routines_load_error_title()}</strong>
          <span>{state.error}</span>
        </span>
      ),
      phase: "blocking_error",
    };
  }
  const diagnostics: ReactNode[] = state.snapshot.diagnostics.map(
    (diagnostic, index) => (
      <span key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}>
        {diagnostic.message}
      </span>
    ),
  );
  if (state.refreshError) {
    diagnostics.push(<span key="refresh">{state.refreshError}</span>);
  }
  return {
    diagnostics,
    phase: "ready",
    refreshing: state.refreshing,
    rows: state.snapshot.rows,
  };
}

export function routineDetailTitle(row: RoutineRow) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <RoutineTriggerIcon
        row={row}
        className={
          row.valid ? "size-6 text-muted-foreground" : "size-6 text-destructive"
        }
      />
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate">{row.title}</span>
        <span className="truncate text-sm font-normal text-muted-foreground">
          {row.description || row.filename}
        </span>
      </span>
    </span>
  );
}
