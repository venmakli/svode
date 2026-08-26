import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
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
  compareRoutinesByName,
  routineSearchText,
} from "../model/routine-values";
import type { RoutineCatalogState, RoutineRow } from "../model/types";
import { RoutineTriggerIcon } from "./routine-trigger-icon";

export interface RoutinePresentationActions {
  createState: SystemCollectionActionState;
  getDeleteState(row: RoutineRow): SystemCollectionActionState;
  getEditState(row: RoutineRow): SystemCollectionActionState;
  getEnabledState(row: RoutineRow): SystemCollectionActionState;
  getRunState(row: RoutineRow): SystemCollectionActionState;
  onAdd(): void;
  onDelete(row: RoutineRow): void;
  onEdit(row: RoutineRow): void;
  onEnabledChange(row: RoutineRow, enabled: boolean): Promise<void>;
  onRun(row: RoutineRow): Promise<void>;
}

export function createRoutinesPresentation({
  actions,
  createDetailRequest,
  getExecutorLabel,
  state,
}: {
  actions: RoutinePresentationActions;
  createDetailRequest(
    row: RoutineRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  getExecutorLabel?(row: RoutineRow): string | null;
  state: SystemCollectionPresentationState<RoutineRow>;
}) {
  return defineSystemCollectionPresentation({
    descriptor: createRoutinesPresentationDescriptor({
      actions,
      createDetailRequest,
      getExecutorLabel,
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
}: {
  actions: RoutinePresentationActions;
  createDetailRequest(
    row: RoutineRow,
  ): Omit<SystemCollectionDetailRequest, "selection">;
  getExecutorLabel?(row: RoutineRow): string | null;
}): SystemCollectionPresentationDescriptor<RoutineRow> {
  const fields: readonly SystemCollectionFieldDescriptor<RoutineRow>[] = [
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
    {
      ...propertyField(
        "enabled",
        m.routines_field_enabled(),
        { display: "switch", name: "enabled", type: "boolean" },
        (row) => row.definition?.enabled ?? false,
        {
          getState: actions.getEnabledState,
          showDisabledReason: false,
          update: (row, value) => actions.onEnabledChange(row, value === true),
        },
      ),
      getAccessibilityLabel: (row) =>
        m.routines_enabled_accessibility({ name: row.name }),
      getApplicability: (row) => {
        if (!row.valid || !row.definition) {
          return {
            label: m.routines_unavailable(),
            status: "unavailable",
          };
        }
        if (row.definition.trigger.type === "manual") {
          return { status: "hidden" };
        }
        return { status: "applicable" };
      },
    },
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
      getDescription: routineSecondaryDescription,
      getTitle: (row) => row.name,
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
        "trigger",
        "action",
        "executor",
        "last-run",
        "next-run",
        "enabled",
      ],
    },
    query: {
      defaultCompare: compareRoutinesByName,
      getSearchText: (row) =>
        `${routineSearchText(row)} ${getExecutorLabel(row) ?? ""}`,
    },
    rowActions: [
      {
        getLabel: (row) =>
          row.lastRun?.active
            ? m.routines_open_session()
            : m.routines_run_now(),
        getState: actions.getRunState,
        id: "run-routine",
        isVisible: (row) =>
          row.definition?.trigger.type !== "event" || !row.definition,
        label: m.routines_run_now(),
        run: actions.onRun,
      },
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
  onRetry: () => void,
): SystemCollectionPresentationState<RoutineRow> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return {
      error: (
        <div className="flex flex-col items-start gap-2">
          <span className="flex flex-col gap-1">
            <strong>{m.routines_load_error_title()}</strong>
            <span>{state.error}</span>
          </span>
          <RoutineRetryButton disabled={state.retrying} onRetry={onRetry} />
        </div>
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
    diagnostics.push(
      <div key="refresh" className="flex flex-col items-start gap-2">
        <span>{state.refreshError}</span>
        <RoutineRetryButton disabled={state.refreshing} onRetry={onRetry} />
      </div>,
    );
  }
  return {
    diagnostics,
    phase: "ready",
    rows: state.snapshot.rows,
  };
}

function RoutineRetryButton({
  disabled,
  onRetry,
}: {
  disabled: boolean;
  onRetry(): void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onRetry}
    >
      {m.routines_retry()}
    </Button>
  );
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
        <span className="truncate">{row.name}</span>
        <span className="truncate text-sm font-normal text-muted-foreground">
          {routineSecondaryDescription(row)}
        </span>
      </span>
    </span>
  );
}

function routineSecondaryDescription(row: RoutineRow) {
  if (!row.nameConflict) return row.description || row.filename;
  const description = row.description
    ? `${row.description} · ${row.definitionPath}`
    : row.definitionPath;
  return <span title={row.definitionPath}>{description}</span>;
}
