import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  agentActorCandidates,
  agentActorReferenceLabel,
  resolveAgentActorReference,
  type AgentActorOptionsState,
} from "@/features/actors/agent-reference";
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
import type { RoutineCatalogState, RoutineItem } from "../model/types";
import { RoutineTriggerIcon } from "./routine-trigger-icon";

export interface RoutinePresentationActions {
  createState: CollectionActionState;
  getDeleteState(item: RoutineItem): CollectionActionState;
  getEditState(item: RoutineItem): CollectionActionState;
  getEnabledState(item: RoutineItem): CollectionActionState;
  getRunState(item: RoutineItem): CollectionActionState;
  onAdd(): void;
  onDelete(item: RoutineItem): void;
  onEdit(item: RoutineItem): void;
  onEnabledChange(item: RoutineItem, enabled: boolean): Promise<void>;
  onRun(item: RoutineItem): Promise<void>;
}

export function createRoutinesPresentation({
  actions,
  executors,
  onActivate,
  state,
}: {
  actions: RoutinePresentationActions;
  executors: AgentActorOptionsState;
  onActivate?: CollectionPresentationDescriptor<RoutineItem>["onActivate"];
  state: CollectionPresentationState<RoutineItem>;
}) {
  return defineCollectionPresentation({
    descriptor: createRoutinesPresentationDescriptor({
      actions,
      executors,
      onActivate,
      items: state.phase === "ready" ? state.items : [],
    }),
    state,
  });
}

export function createRoutinesPresentationDescriptor({
  actions,
  executors,
  onActivate,
  items,
}: {
  actions: RoutinePresentationActions;
  executors: AgentActorOptionsState;
  onActivate?: CollectionPresentationDescriptor<RoutineItem>["onActivate"];
  items: readonly RoutineItem[];
}): CollectionPresentationDescriptor<RoutineItem> {
  const getExecutor = (item: RoutineItem) =>
    item.definition?.action.type === "run_agent"
      ? item.definition.action.executor
      : null;
  const getExecutorLabel = (item: RoutineItem) => {
    const executor = getExecutor(item);
    return executor
      ? agentActorReferenceLabel(
          resolveAgentActorReference(executors, executor),
        )
      : null;
  };
  const properties: readonly CollectionPropertyDefinition<RoutineItem>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (item) => routineTriggerTypeLabel(item),
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
      getValue: (item) => routineActionTypeLabel(item),
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
    {
      ...defineOwnerDefinedCollectionProperty({
        capabilities: {
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        featureId: "routines",
        getValue: getExecutor,
        key: "executor",
        label: m.routines_field_executor(),
        standard: { type: "actor" },
      }),
      actorCandidates: agentActorCandidates(
        executors,
        items.flatMap((item) => getExecutor(item) ?? []),
      ),
    },
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getValue: (item) => item.lastRunAt,
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
      getValue: (item) => item.nextRunAt,
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
            update: (item, value) =>
              actions.onEnabledChange(item, value === true),
          },
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        featureId: "routines",
        getValue: (item) => item.definition?.enabled ?? false,
        key: "enabled",
        label: m.routines_field_enabled(),
        standard: { display: "switch", type: "boolean" },
      }),
      getAccessibilityLabel: (item) =>
        m.routines_enabled_accessibility({ name: item.name }),
      getApplicability: (item) => {
        if (!item.valid || !item.definition) {
          return {
            label: m.routines_unavailable(),
            status: "unavailable",
          };
        }
        if (item.definition.trigger.type === "manual") {
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
    getItemId: (item) => item.id,
    id: "all",
    label: m.routines_presentation_all(),
    layout: {
      density: "compact",
      getDescription: routineSecondaryDescription,
      getTitle: (item) => item.name,
      kind: "list",
      renderLeading: (item) => (
        <RoutineTriggerIcon
          item={item}
          className={
            item.valid
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
      getSearchText: (item) =>
        `${routineSearchText(item)} ${getExecutorLabel(item) ?? ""}`,
    },
    itemActions: [
      {
        getLabel: (item) =>
          item.lastRun?.active
            ? m.routines_open_session()
            : m.routines_run_now(),
        getState: actions.getRunState,
        id: "run-routine",
        isVisible: (item) =>
          item.definition?.trigger.type !== "event" || !item.definition,
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

function routineTriggerTypeLabel(item: RoutineItem) {
  const type = item.definition?.trigger.type;
  if (type === "manual") return m.routines_trigger_manual();
  if (type === "schedule") return m.routines_trigger_schedule();
  if (type === "event") return m.routines_trigger_event();
  return null;
}

function routineActionTypeLabel(item: RoutineItem) {
  const type = item.definition?.action.type;
  if (type === "run_agent") return m.routines_action_run_agent();
  if (type === "update_properties") {
    return m.routines_action_update_properties();
  }
  return null;
}

export function toRoutinePresentationState(
  state: RoutineCatalogState,
  onRetry: () => void,
): CollectionPresentationState<RoutineItem> {
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
    items: state.snapshot.items,
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

/** The icon of a Routine on its screen: its trigger, or a problem. */
export function routineScreenIcon(item: RoutineItem) {
  return (
    <RoutineTriggerIcon
      item={item}
      className={item.valid ? undefined : "text-destructive"}
    />
  );
}

/** The description under a Routine's name; its file without one. */
export function routineSecondaryDescription(item: RoutineItem) {
  if (!item.nameConflict) return item.description || item.filename;
  const description = item.description
    ? `${item.description} · ${item.definitionPath}`
    : item.definitionPath;
  return <span title={item.definitionPath}>{description}</span>;
}
