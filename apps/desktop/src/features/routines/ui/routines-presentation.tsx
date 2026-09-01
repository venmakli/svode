import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
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

import {
  compareRoutinesByName,
  routineSearchText,
} from "../model/routine-values";
import type { RoutineCatalogState, RoutineRow } from "../model/types";
import { RoutineTriggerIcon } from "./routine-trigger-icon";

export interface RoutinePresentationActions {
  createState: CollectionActionState;
  getDeleteState(row: RoutineRow): CollectionActionState;
  getEditState(row: RoutineRow): CollectionActionState;
  getEnabledState(row: RoutineRow): CollectionActionState;
  getRunState(row: RoutineRow): CollectionActionState;
  onAdd(): void;
  onDelete(row: RoutineRow): void;
  onEdit(row: RoutineRow): void;
  onEnabledChange(row: RoutineRow, enabled: boolean): Promise<void>;
  onRun(row: RoutineRow): Promise<void>;
}

export function createRoutinesPresentation({
  actions,
  onActivate,
  getExecutorLabel,
  state,
}: {
  actions: RoutinePresentationActions;
  onActivate?: CollectionPresentationDescriptor<RoutineRow>["onActivate"];
  getExecutorLabel?(row: RoutineRow): string | null;
  state: CollectionPresentationState<RoutineRow>;
}) {
  return defineCollectionPresentation({
    descriptor: createRoutinesPresentationDescriptor({
      actions,
      onActivate,
      getExecutorLabel,
    }),
    state,
  });
}

export function createRoutinesPresentationDescriptor({
  actions,
  onActivate,
  getExecutorLabel = (row) =>
    row.definition?.action.type === "run_agent"
      ? row.definition.action.executor
      : null,
}: {
  actions: RoutinePresentationActions;
  onActivate?: CollectionPresentationDescriptor<RoutineRow>["onActivate"];
  getExecutorLabel?(row: RoutineRow): string | null;
}): CollectionPresentationDescriptor<RoutineRow> {
  const properties: readonly CollectionPropertyDefinition<RoutineRow>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (row) => routineTriggerTypeLabel(row),
      key: "trigger",
      label: m.routines_field_trigger(),
      standard: {
        options: [
          { color: "neutral", name: m.routines_trigger_manual() },
          { color: "blue", name: m.routines_trigger_schedule() },
          { color: "purple", name: m.routines_trigger_event() },
        ],
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (row) => routineActionTypeLabel(row),
      key: "action",
      label: m.routines_field_action(),
      standard: {
        options: [
          { color: "blue", name: m.routines_action_run_agent() },
          {
            color: "orange",
            name: m.routines_action_update_properties(),
          },
        ],
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: getExecutorLabel,
      key: "executor",
      label: m.routines_field_executor(),
      standard: { type: "text" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (row) => row.lastRunAt,
      key: "last-run",
      label: m.routines_field_last_run(),
      standard: { display: "medium", type: "date" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (row) => row.nextRunAt,
      key: "next-run",
      label: m.routines_field_next_run(),
      standard: { display: "medium", type: "date" },
    }),
    {
      ...defineOwnerDefinedCollectionProperty({
        capabilities: {
          edit: {
            getState: actions.getEnabledState,
            showDisabledReason: false,
            update: (row, value) =>
              actions.onEnabledChange(row, value === true),
          },
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        featureId: "routines",
        getValue: (row) => row.definition?.enabled ?? false,
        key: "enabled",
        label: m.routines_field_enabled(),
        standard: { display: "switch", type: "boolean" },
      }),
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
      label: m.routines_add(),
      intents: [
        {
          getState: () => actions.createState,
          id: "add-routine",
          label: m.routines_add(),
          run: actions.onAdd,
        },
      ],
    },
    onActivate,
    properties,
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
      visibleProperties: [
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
): CollectionPresentationState<RoutineRow> {
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
