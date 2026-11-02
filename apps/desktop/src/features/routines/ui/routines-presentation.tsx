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
  defineSpaceCollectionProperty,
  defineStateCollectionProperty,
  defineTitleCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import {
  compareRoutinesByName,
  routineSearchText,
} from "../model/routine-values";
import {
  applyRoutineTriggerDraft,
  routineActionProblem,
  routineTriggerDraft,
  routineTriggerDraftChanges,
  routineTriggerProblem,
  type RoutineTriggerDraft,
  type RoutineTriggerProblem,
} from "../model/routine-property-drafts";
import type {
  RoutineAction,
  RoutineCatalogState,
  RoutineDefinition,
  RoutineItem,
  RoutineLaunchRecoveryActions,
  RoutineOwnership,
} from "../model/types";
import {
  RoutineActionEditor,
  routineActionChoosable,
} from "./routine-action-editor";
import {
  RoutineLastRunDetail,
  RoutineNextRunDetail,
  RoutineTriggerDetail,
} from "./routine-property-values";
import { routineNextRunCopy } from "./routine-schedule-copy";
import { RoutineTriggerEditor } from "./routine-trigger-editor";
import { RoutineTriggerIcon } from "./routine-trigger-icon";

export interface RoutinePresentationActions {
  createState: CollectionActionState;
  getDeleteState(item: RoutineItem): CollectionActionState;
  /** Whether the properties of the Routine's definition can be edited. */
  getDefinitionEditState(item: RoutineItem): CollectionActionState;
  getEnabledState(item: RoutineItem): CollectionActionState;
  getRunState(item: RoutineItem): CollectionActionState;
  /** Creates a Routine; rejects with the reason it was not created. */
  onAdd(): void | Promise<void>;
  onDelete(item: RoutineItem): void;
  onEnabledChange(item: RoutineItem, enabled: boolean): Promise<void>;
  onRun(item: RoutineItem): Promise<void>;
  /**
   * Saves one property: the definition whole with the one changed field;
   * rejects with the reason it was not saved.
   */
  writeDefinition(
    item: RoutineItem,
    change: (definition: RoutineDefinition) => RoutineDefinition,
  ): Promise<void>;
}

export function createRoutinesPresentation({
  actions,
  collectionOwner,
  executors,
  onActivate,
  ownership,
  recovery,
  state,
}: {
  actions: RoutinePresentationActions;
  /** The owner is a Collection, whose events a Routine may wait for. */
  collectionOwner?: boolean;
  executors: AgentActorOptionsState;
  onActivate?: CollectionPresentationDescriptor<RoutineItem>["onActivate"];
  ownership: RoutineOwnership;
  recovery?: RoutineLaunchRecoveryActions;
  state: CollectionPresentationState<RoutineItem>;
}) {
  return defineCollectionPresentation({
    descriptor: createRoutinesPresentationDescriptor({
      actions,
      collectionOwner,
      executors,
      onActivate,
      recovery,
      items: state.phase === "ready" ? state.items : [],
      ownership,
    }),
    state,
  });
}

export function createRoutinesPresentationDescriptor({
  actions,
  collectionOwner = false,
  executors,
  onActivate,
  recovery = {},
  items,
  ownership,
}: {
  actions: RoutinePresentationActions;
  /** The owner is a Collection, whose events a Routine may wait for. */
  collectionOwner?: boolean;
  executors: AgentActorOptionsState;
  onActivate?: CollectionPresentationDescriptor<RoutineItem>["onActivate"];
  /** Recovery of a refused last run on the Routine's screen. */
  recovery?: RoutineLaunchRecoveryActions;
  items: readonly RoutineItem[];
  /** The one owner of the set's Routines. */
  ownership: RoutineOwnership;
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
  const { collection, space } = ownership;
  const properties: readonly CollectionPropertyDefinition<RoutineItem>[] = [
    defineTitleCollectionProperty({ getValue: (item) => item.name }),
    defineSpaceCollectionProperty({ getValue: () => space, items }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "routines",
      getApplicability: () =>
        collection === null ? { status: "hidden" } : { status: "applicable" },
      getValue: () => collection,
      key: "collection",
      label: m.routines_field_collection(),
      standard: {
        options:
          collection === null ? [] : [{ color: "neutral", name: collection }],
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        edit: {
          getState: actions.getDefinitionEditState,
          popover: {
            getDraft: (item) =>
              item.definition ? routineTriggerDraft(item.definition) : null,
            render: ({ draft, item, onDraftChange }) =>
              item.definition && draft ? (
                <RoutineTriggerEditor
                  collectionOwner={collectionOwner}
                  draft={draft as RoutineTriggerDraft}
                  saved={item.definition}
                  onChange={onDraftChange}
                />
              ) : null,
          },
          showDisabledReason: false,
          update: async (item, value) => {
            const draft = value as RoutineTriggerDraft;
            if (
              !item.definition ||
              !routineTriggerDraftChanges(item.definition, draft)
            ) {
              return;
            }
            await actions.writeDefinition(item, (definition) => {
              const next = applyRoutineTriggerDraft(definition, draft);
              // The executor chosen meanwhile stays.
              return next.action.type === "run_agent" &&
                definition.action.type === "run_agent"
                ? { ...next, action: definition.action }
                : next;
            });
          },
          validate: (value, item) =>
            item.definition && value
              ? routineTriggerProblemMessage(
                  routineTriggerProblem(
                    item.definition,
                    value as RoutineTriggerDraft,
                  ),
                )
              : null,
        },
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      display: {
        renderDetail: (value, item) =>
          typeof value === "string" ? (
            <RoutineTriggerDetail item={item} label={value} />
          ) : null,
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
        edit: {
          // Only an event that leaves an item behind offers another action.
          getState: (item) =>
            item.definition && routineActionChoosable(item.definition)
              ? actions.getDefinitionEditState(item)
              : {
                  reason: m.routines_run_agent_only(),
                  status: "disabled",
                },
          popover: {
            getDraft: (item) => item.definition?.action ?? null,
            render: ({ draft, item, onDraftChange }) =>
              item.definition && draft ? (
                <RoutineActionEditor
                  action={draft as RoutineAction}
                  saved={item.definition}
                  onChange={onDraftChange}
                />
              ) : null,
          },
          showDisabledReason: false,
          update: async (item, value) => {
            const action = value as RoutineAction;
            await actions.writeDefinition(item, (definition) => ({
              ...definition,
              action:
                action.type === "run_agent"
                  ? {
                      executor:
                        definition.action.type === "run_agent"
                          ? definition.action.executor
                          : "",
                      type: "run_agent",
                    }
                  : action,
            }));
          },
          validate: (value, item) =>
            item.definition &&
            value &&
            routineActionProblem(item.definition, value as RoutineAction)
              ? m.routines_properties_set_required()
              : null,
        },
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
          edit: {
            getState: (item) =>
              executors.loading
                ? { status: "pending" }
                : executors.error
                  ? { reason: executors.error, status: "disabled" }
                  : actions.getDefinitionEditState(item),
            showDisabledReason: false,
            update: (item, value) =>
              actions.writeDefinition(item, (definition) =>
                definition.action.type === "run_agent"
                  ? {
                      ...definition,
                      action: {
                        executor: typeof value === "string" ? value : "",
                        type: "run_agent",
                      },
                    }
                  : definition,
              ),
            // The executor is an Agent Actor of the Routine's Space or root.
            validate: (value) =>
              typeof value === "string" &&
              value !== "" &&
              resolveAgentActorReference(executors, value).status !== "resolved"
                ? m.routines_executor_agent_only()
                : null,
          },
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
        items.flatMap((item) => getExecutor(item) || []),
      ),
      getApplicability: (item) =>
        item.definition?.action.type === "run_agent"
          ? { status: "applicable" }
          : { status: "hidden" },
    },
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
      // A Routine with problems keeps its saved value, and the switch is
      // off-limits: "Status" says why.
      getApplicability: (item) =>
        item.definition && item.definition.trigger.type !== "manual"
          ? { status: "applicable" }
          : { status: "hidden" },
    },
    defineStateCollectionProperty({ getProblems: routineProblems }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      display: {
        renderDetail: (_value, item) =>
          item.lastRunAt ? (
            <RoutineLastRunDetail item={item} recovery={recovery} />
          ) : null,
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
      display: {
        renderDetail: (_value, item) =>
          routineNextRunCopy(item) ? (
            <RoutineNextRunDetail item={item} />
          ) : null,
      },
      featureId: "routines",
      getValue: (item) => item.nextRunAt,
      key: "next-run",
      label: m.routines_field_next_run(),
      standard: { display: "medium", type: "date" },
    }),
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
      // One owner holds every Routine of the set, so "Space" and
      // "Collection" say the same of each and stay out of the columns; the
      // filter and the sort still offer them.
      visibleProperties: [
        "trigger",
        "action",
        "executor",
        "last-run",
        "next-run",
        "enabled",
        "state",
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
        getState: actions.getDeleteState,
        id: "delete-routine",
        label: m.routines_delete(),
        run: actions.onDelete,
      },
    ],
  };
}

/**
 * The problems of a Routine's definition: every invalid definition comes
 * with the diagnostics that make it so.
 */
function routineProblems(item: RoutineItem): readonly string[] {
  return [...new Set(item.diagnostics.map((diagnostic) => diagnostic.message))];
}

function routineTriggerProblemMessage(problem: RoutineTriggerProblem | null) {
  if (problem === "cron") return m.routines_cron_required();
  if (problem === "timezone") return m.routines_timezone_unknown();
  if (problem === "event_field") return m.routines_event_field_required();
  if (problem === "automatic_consent") {
    return m.routines_automatic_consent_required();
  }
  return null;
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
