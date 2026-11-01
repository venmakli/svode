import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import {
  applyCollectionQuery,
  EMPTY_COLLECTION_QUERY,
  CollectionHost,
  validateCollectionQuery,
  type CollectionInstance,
  type CollectionStateController,
} from "@/features/collection";

import { resolveStandardPropertyColumn } from "@/features/properties";
import { PropertyValue } from "@/features/properties/display";

import type { RoutineItem } from "../model/types";
import { RoutineAutomaticConsent } from "./routine-automatic-consent";
import { RoutineCreateReview } from "./routine-create-review";
import { RoutineDetailView } from "./routine-detail-view";
import {
  routineScheduleSummary,
  routineTimeBasisLabel,
} from "./routine-schedule-copy";
import {
  createRoutinesPresentation,
  createRoutinesPresentationDescriptor,
  toRoutinePresentationState,
  type RoutinePresentationActions,
} from "./routines-presentation";

const executors: AgentActorOptionsState = {
  ambiguous: [],
  error: null,
  incomplete: false,
  loading: false,
  options: [
    {
      description: null,
      label: "Documentation Agent",
      ownerLabel: "Project",
      value: "agent:01arz3ndektsv4rrffq69g5fav",
    },
  ],
};
const review: RoutineItem = {
  definition: {
    action: {
      executor: "agent:01arz3ndektsv4rrffq69g5fav",
      type: "run_agent",
    },
    body: "Review changes.",
    description: "Review the current owner.",
    enabled: null,
    name: "Review",
    trigger: { type: "manual" },
  },
  definitionPath: ".routines/review.md",
  description: "Review the current owner.",
  diagnostics: [],
  filename: "review.md",
  fingerprint: "fingerprint:review",
  id: "routine:review",
  routineId: "routine:review",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  nextRunAt: null,
  name: "Review",
  valid: true,
};

const scheduled: RoutineItem = {
  ...review,
  definition: {
    ...review.definition!,
    enabled: false,
    name: "Daily summary",
    trigger: {
      cron: "0 9 * * *",
      missedRuns: "skip",
      timeBasis: { mode: "fixed", timezone: "Asia/Novosibirsk" },
      type: "schedule",
    },
  },
  definitionPath: ".routines/daily-summary.md",
  filename: "daily-summary.md",
  fingerprint: "fingerprint:summary",
  id: "routine:summary",
  name: "Daily summary",
};

const invalid: RoutineItem = {
  ...review,
  definition: null,
  definitionPath: ".routines/broken.md",
  diagnostics: [
    {
      code: "routine_trigger_invalid",
      field: "trigger",
      message: "trigger is invalid",
      path: ".routines/broken.md",
    },
  ],
  filename: "broken.md",
  fingerprint: "fingerprint:broken",
  id: "invalid:.routines/broken.md",
  name: "Broken routine",
  routineId: null,
  valid: false,
};

const eventRoutine: RoutineItem = {
  ...scheduled,
  definition: {
    ...scheduled.definition!,
    enabled: true,
    name: "Triage new items",
    trigger: {
      event: "collection.entry_created",
      type: "event",
    },
  },
  definitionPath: ".routines/triage-new-items.md",
  filename: "triage-new-items.md",
  fingerprint: "fingerprint:triage",
  id: "routine:triage",
  name: "Triage new items",
};

const withProblems: RoutineItem = {
  ...eventRoutine,
  definition: {
    ...eventRoutine.definition!,
    action: { executor: "agent:missing", type: "run_agent" },
    name: "Broken executor",
  },
  definitionPath: ".routines/broken-executor.md",
  diagnostics: [
    {
      code: "routine_executor_unknown",
      field: "action.executor",
      message: "executor agent:missing is not in the catalog",
      path: ".routines/broken-executor.md",
    },
  ],
  filename: "broken-executor.md",
  fingerprint: "fingerprint:problems",
  id: "routine:problems",
  name: "Broken executor",
  valid: false,
};

function actions(calls: string[]): RoutinePresentationActions {
  return {
    createState: { status: "idle" },
    getDeleteState: () => ({ status: "idle" }),
    getEditState: () => ({ status: "idle" }),
    getEnabledState: () => ({ status: "idle" }),
    getRunState: () => ({ status: "idle" }),
    onAdd: () => calls.push("add"),
    onDelete: (item) => calls.push(`delete:${item.id}`),
    onEdit: (item) => calls.push(`edit:${item.id}`),
    onEnabledChange: async (item, enabled) => {
      calls.push(`enabled:${item.id}:${enabled}`);
    },
    onRun: async (item) => {
      calls.push(`run:${item.id}`);
    },
  };
}

test("routines expose one fixed All list with the complete fixed schema", () => {
  const descriptor = createRoutinesPresentationDescriptor({
    executors,
    actions: actions([]),
    onActivate: () => undefined,
    items: [],
  });

  expect(descriptor.id).toBe("all");
  expect(descriptor.layout.kind).toBe("list");
  expect(descriptor.properties.map((property) => property.key)).toEqual([
    "title",
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
    "enabled",
    "state",
  ]);
  expect(
    descriptor.properties.find((property) => property.key === "executor")
      ?.label,
  ).toBe("Executor");
  expect(
    descriptor.properties.flatMap((property) => property.common ?? []),
  ).toEqual(["title", "state"]);
  expect(descriptor.layout.visibleProperties).toEqual([
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
    "enabled",
    "state",
  ]);
  for (const key of ["trigger", "next-run"]) {
    const semantics = descriptor.properties.find(
      (property) => property.key === key,
    )?.semantics;
    expect(semantics?.kind).toBe("standard");
    expect(semantics && "render" in semantics).toBe(false);
  }
  const enabledField = descriptor.properties.find(
    (property) => property.key === "enabled",
  )!;
  expect(enabledField.semantics).toEqual({
    kind: "standard",
    standard: { display: "switch", type: "boolean" },
  });
  expect(enabledField.getApplicability?.(scheduled)).toEqual({
    status: "applicable",
  });
  expect(enabledField.getApplicability?.(review)).toEqual({
    status: "hidden",
  });
  // Without a readable definition there is no saved value to show.
  expect(enabledField.getApplicability?.(invalid)).toEqual({
    status: "hidden",
  });
  // A definition with problems keeps its saved value.
  expect(enabledField.getApplicability?.(withProblems)).toEqual({
    status: "applicable",
  });
  expect(enabledField.getAccessibilityLabel?.(scheduled)).toBe(
    "Enabled: Daily summary",
  );
  expect(descriptor.create?.intents[0]?.id).toBe("add-routine");
  expect("refresh" in descriptor).toBe(false);
  expect(descriptor.itemActions?.map((action) => action.id)).toEqual([
    "run-routine",
    "edit-routine",
    "delete-routine",
  ]);
  const runAction = descriptor.itemActions?.[0];
  expect(runAction?.getLabel?.(review)).toBe("Run now");
  expect(runAction?.isVisible?.(review)).toBe(true);
  expect(runAction?.isVisible?.(scheduled)).toBe(true);
  expect(
    runAction?.getLabel?.({
      ...review,
      lastRun: {
        active: true,
        agentSessionId: "codex:launch:launch-one",
        launchId: "launch-one",
        refusal: null,
        routineRunId: "run-one",
        sourceSessionId: null,
      },
    }),
  ).toBe("Open session");
});

test("routine detail hides technical paths when valid and preserves exact recovery paths when invalid", () => {
  const valid = renderToStaticMarkup(
    <RoutineDetailView executors={executors} item={review} />,
  );
  expect(valid.includes(review.definitionPath)).toBe(false);

  const invalidPath = ".routines/broken.md";
  const invalid = renderToStaticMarkup(
    <RoutineDetailView
      executors={executors}
      item={{
        ...review,
        definitionPath: invalidPath,
        diagnostics: [
          {
            code: "routine_id_invalid",
            field: "id",
            message: "id must be a lowercase ULID",
            path: invalidPath,
          },
        ],
        id: `invalid:${invalidPath}`,
        routineId: null,
        valid: false,
      }}
    />,
  );
  expect(invalid.includes(invalidPath)).toBe(true);
  expect(invalid.includes("id must be a lowercase ULID")).toBe(true);
});

test("schedule properties and detail stay compact without time-basis annotations", () => {
  const trigger = scheduled.definition!.trigger as Extract<
    NonNullable<RoutineItem["definition"]>["trigger"],
    { type: "schedule" }
  >;
  expect(routineScheduleSummary(trigger)).toBe("Schedule · 0 9 * * *");
  expect(routineTimeBasisLabel(trigger.timeBasis)).toBe(
    "Novosibirsk — GMT+07:00",
  );

  const fixed = renderToStaticMarkup(
    <RoutineDetailView
      executors={executors}
      item={{ ...scheduled, nextRunAt: "2026-08-27T02:00:00Z" }}
    />,
  );
  expect(fixed.includes("Fixed timezone")).toBe(false);
  expect(fixed.includes("Asia/Novosibirsk")).toBe(false);

  const local = renderToStaticMarkup(
    <RoutineDetailView
      executors={executors}
      item={{
        ...scheduled,
        definition: {
          ...scheduled.definition!,
          trigger: {
            ...scheduled.definition!.trigger,
            timeBasis: { mode: "local" },
          } as Extract<
            NonNullable<RoutineItem["definition"]>["trigger"],
            { type: "schedule" }
          >,
        },
        nextRunAt: "2026-08-27T02:00:00Z",
      }}
    />,
  );
  expect(local.includes("Local time")).toBe(false);
  expect(local.includes("first eligible device")).toBe(false);
});

test("duplicate-name items conditionally expose their current path and remain usable", () => {
  const conflictItem: RoutineItem = {
    ...review,
    nameConflict: {
      conflictingPaths: [".routines/existing.md"],
    },
  };
  const descriptor = createRoutinesPresentationDescriptor({
    executors,
    actions: actions([]),
    onActivate: () => undefined,
    items: [],
  });
  const normalDescription =
    descriptor.layout.kind === "list"
      ? descriptor.layout.getDescription?.(review)
      : null;
  const conflictDescription =
    descriptor.layout.kind === "list"
      ? descriptor.layout.getDescription?.(conflictItem)
      : null;
  const normalMarkup = renderToStaticMarkup(<>{normalDescription}</>);
  const conflictMarkup = renderToStaticMarkup(<>{conflictDescription}</>);
  const detailMarkup = renderToStaticMarkup(
    <RoutineDetailView executors={executors} item={conflictItem} />,
  );

  expect(normalMarkup.includes(review.definitionPath)).toBe(false);
  expect(conflictMarkup.includes(review.definitionPath)).toBe(true);
  expect(detailMarkup.includes("Duplicate routine name")).toBe(true);
  expect(detailMarkup.includes(review.definitionPath)).toBe(true);
  expect(descriptor.itemActions?.[0]?.isVisible?.(conflictItem)).toBe(true);
});

test("routines query searches definitions and defaults to name ordering", () => {
  const descriptor = createRoutinesPresentationDescriptor({
    executors,
    actions: actions([]),
    onActivate: () => undefined,
    items: [],
  });
  const ordered = applyCollectionQuery({
    descriptor,
    query: EMPTY_COLLECTION_QUERY,
    items: [review, scheduled],
  });
  const searched = applyCollectionQuery({
    descriptor,
    query: { filters: [], search: "0 9 * * *", sort: [] },
    items: [review, scheduled],
  });

  expect(ordered.items.map((item) => item.id)).toEqual([
    "routine:summary",
    "routine:review",
  ]);
  expect(searched.items.map((item) => item.id)).toEqual(["routine:summary"]);

  const enabledScheduled: RoutineItem = {
    ...scheduled,
    definition: { ...scheduled.definition!, enabled: true },
    id: "routine:enabled-summary",
    name: "Enabled summary",
  };
  const disabledItems = applyCollectionQuery({
    descriptor,
    query: {
      filters: [{ propertyKey: "enabled", operator: "eq", value: false }],
      search: "",
      sort: [],
    },
    items: [review, scheduled, enabledScheduled],
  });
  expect(disabledItems.items.map((item) => item.id)).toEqual([
    "routine:summary",
    "routine:review",
  ]);
});

test("routines delegate create, item actions, and inline enabled edits", async () => {
  const calls: string[] = [];
  const descriptor = createRoutinesPresentationDescriptor({
    executors,
    actions: actions(calls),
    onActivate: () => undefined,
    items: [],
  });

  await descriptor.create?.intents[0]?.run();
  for (const action of descriptor.itemActions ?? []) {
    if (action.isVisible?.(review) === false) continue;
    await action.run(review);
  }
  await descriptor.properties
    .find((property) => property.key === "enabled")
    ?.capabilities?.edit?.update(scheduled, true);

  expect(calls).toEqual([
    "add",
    "run:routine:review",
    "edit:routine:review",
    "delete:routine:review",
    "enabled:routine:summary:true",
  ]);
});

test("routines render the common toolbar and a single fixed All list", () => {
  const presentation = createRoutinesPresentation({
    executors,
    actions: actions([]),
    onActivate: () => undefined,
    state: { phase: "ready", items: [scheduled] },
  });
  const instance: CollectionInstance = {
    defaultPresentationId: "all",
    instanceKey: "routines:space:root",
    presentations: [presentation],
    stateScope: "session",
  };
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: "all",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionHost
        contextualActions={
          <RoutineAutomaticConsent
            enabled={false}
            error={null}
            loading={false}
            ownerKind="project"
            pending={false}
            onChange={() => undefined}
          />
        }
        instance={instance}
        state={state}
      />
    </TooltipProvider>,
  );

  const queryPosition = markup.indexOf('data-slot="input-group"');
  const authorityPosition = markup.indexOf(
    'data-routine-automatic-authority="project"',
  );
  const createPosition = markup.indexOf('data-collection-create="add-routine"');

  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes('role="listitem"')).toBe(true);
  expect(markup.includes('data-collection-presentation="all"')).toBe(true);
  expect(markup.includes('data-collection-create="add-routine"')).toBe(true);
  expect(markup.includes("data-collection-refresh")).toBe(false);
  expect(markup.includes("Daily summary")).toBe(true);
  expect(markup.includes("Active")).toBe(false);
  expect(markup.includes("Runs")).toBe(false);
  expect(queryPosition > -1).toBe(true);
  expect(authorityPosition > queryPosition).toBe(true);
  expect(createPosition > authorityPosition).toBe(true);
  expect(markup.includes('data-orientation="vertical"')).toBe(false);
  expect(markup.includes("Add routine")).toBe(false);
  expect(markup.includes(">Add<")).toBe(true);
  expect(markup.includes('data-collection-property="enabled"')).toBe(true);
  expect(markup.includes('role="switch"')).toBe(true);
  expect(markup.includes('data-size="sm"')).toBe(true);
  expect(markup.includes('aria-label="Enabled: Daily summary"')).toBe(true);
  expect(markup.includes('role="checkbox"')).toBe(false);
});

test("manual routines omit enabled; a routine with problems keeps its saved switch, off-limits, and says Has problems", () => {
  const routineActions = actions([]);
  routineActions.getEnabledState = (item) =>
    item.valid ? { status: "idle" } : { reason: "invalid", status: "disabled" };
  const presentation = createRoutinesPresentation({
    executors,
    actions: routineActions,
    onActivate: () => undefined,
    state: {
      phase: "ready",
      items: [scheduled, eventRoutine, review, invalid, withProblems],
    },
  });
  const instance: CollectionInstance = {
    defaultPresentationId: "all",
    instanceKey: "routines:space:manual",
    presentations: [presentation],
    stateScope: "session",
  };
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: "all",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionHost instance={instance} state={state} />
    </TooltipProvider>,
  );

  expect(markup.match(/role="switch"/g)?.length).toBe(3);
  expect(markup.includes('role="checkbox"')).toBe(false);
  expect(markup.includes("Not applicable")).toBe(false);
  expect(markup.includes("data-collection-property-applicability")).toBe(false);
  expect(markup.includes("Unavailable")).toBe(false);
  const problemsRow = markup.slice(
    markup.indexOf('data-collection-row="routine:problems"'),
  );
  expect(
    /role="switch"[^>]*aria-checked="true"[^>]*disabled=""/.test(problemsRow) ||
      /disabled=""[^>]*role="switch"[^>]*aria-checked="true"/.test(problemsRow),
  ).toBe(true);
  expect(markup.match(/data-collection-state-problems/g)?.length).toBe(2);
  expect(markup.includes("Has problems")).toBe(true);
  expect(markup.includes("executor agent:missing is not in the catalog")).toBe(
    true,
  );
  expect(markup.includes("flex-wrap")).toBe(true);
});

test("retry is contextual to blocking and background catalog failures", () => {
  const blocking = toRoutinePresentationState(
    {
      error: "load failed",
      phase: "blocking_error",
      retrying: false,
    },
    () => undefined,
  );
  const ready = toRoutinePresentationState(
    {
      phase: "ready",
      refreshError: null,
      refreshing: false,
      snapshot: {
        catalogFingerprint: "catalog:one",
        diagnostics: [],
        ownerPath: ".",
        refreshedAt: "2026-08-19T00:00:00.000Z",
        resolvedOwnerKind: "project",
        items: [review],
        spaceId: "root",
      },
    },
    () => undefined,
  );
  const failedReady = toRoutinePresentationState(
    {
      ...readySnapshotState(),
      refreshError: "refresh failed",
    },
    () => undefined,
  );

  expect(
    renderToStaticMarkup(
      <>{blocking.phase === "blocking_error" ? blocking.error : null}</>,
    ).includes("Retry"),
  ).toBe(true);
  expect(
    renderToStaticMarkup(
      <>{ready.phase === "ready" ? ready.diagnostics : null}</>,
    ).includes("Retry"),
  ).toBe(false);
  expect(
    renderToStaticMarkup(
      <>{failedReady.phase === "ready" ? failedReady.diagnostics : null}</>,
    ).includes("Retry"),
  ).toBe(true);
});

function readySnapshotState() {
  return {
    phase: "ready" as const,
    refreshError: null,
    refreshing: false,
    snapshot: {
      catalogFingerprint: "catalog:one",
      diagnostics: [],
      ownerPath: ".",
      refreshedAt: "2026-08-19T00:00:00.000Z",
      resolvedOwnerKind: "project" as const,
      items: [review],
      spaceId: "root",
    },
  };
}

test("executor surfaces show the agent name and never a raw id while resolved or loading", () => {
  const ref = "agent:01arz3ndektsv4rrffq69g5fav";
  const descriptor = (state: AgentActorOptionsState) =>
    createRoutinesPresentationDescriptor({
      actions: actions([]),
      executors: state,
      items: [review],
    });
  const executorCell = (state: AgentActorOptionsState) => {
    const property = descriptor(state).properties.find(
      (candidate) => candidate.key === "executor",
    )!;
    return renderToStaticMarkup(
      <PropertyValue
        actors={property.actorCandidates}
        column={resolveStandardPropertyColumn(property)!}
        value={property.getValue(review)}
      />,
    );
  };
  const detail = (state: AgentActorOptionsState) =>
    renderToStaticMarkup(<RoutineDetailView executors={state} item={review} />);
  const empty: AgentActorOptionsState = { ...executors, options: [] };

  const resolvedCell = executorCell(executors);
  expect(resolvedCell.includes("Documentation Agent")).toBe(true);
  expect(resolvedCell.includes('data-agent-avatar="neutral"')).toBe(true);
  expect(resolvedCell.includes(ref)).toBe(false);
  const resolved = detail(executors);
  expect(String(resolved).includes("Documentation Agent")).toBe(true);
  expect(String(resolved).includes('data-agent-avatar="neutral"')).toBe(true);
  expect(String(resolved).includes(ref)).toBe(false);
  const review_ = renderToStaticMarkup(
    <RoutineCreateReview
      automaticAuthority={null}
      definition={review.definition!}
      executors={executors}
      ownerLabel="Project"
      onEdit={() => undefined}
    />,
  );
  expect(String(review_).includes("Documentation Agent")).toBe(true);
  expect(String(review_).includes(ref)).toBe(false);

  const renamed: AgentActorOptionsState = {
    ...executors,
    options: [{ ...executors.options[0]!, label: "Docs Writer" }],
  };
  expect(executorCell(renamed).includes("Docs Writer")).toBe(true);
  expect(String(detail(renamed)).includes("Docs Writer")).toBe(true);

  const loading: AgentActorOptionsState = { ...empty, loading: true };
  const loadingCell = executorCell(loading);
  expect(loadingCell.includes("Loading agent…")).toBe(true);
  expect(loadingCell.includes('data-slot="skeleton"')).toBe(true);
  expect(loadingCell.includes(ref)).toBe(false);
  expect(
    String(detail(loading)).includes('data-agent-actor-reference="loading"'),
  ).toBe(true);
  expect(String(detail(loading)).includes(ref)).toBe(false);

  const missingCell = executorCell(empty);
  expect(missingCell.includes("Agent not found")).toBe(true);
  expect(missingCell.includes(ref)).toBe(false);
  const missing = detail(empty);
  expect(String(missing).includes('data-agent-actor-reference="missing"')).toBe(
    true,
  );
  expect(String(missing).includes(ref)).toBe(true);

  const ambiguousState: AgentActorOptionsState = { ...empty, ambiguous: [ref] };
  const ambiguousCell = executorCell(ambiguousState);
  expect(
    ambiguousCell.includes(
      "Agent is defined in both this space and the project",
    ),
  ).toBe(true);
  expect(ambiguousCell.includes('data-agent-avatar="destructive"')).toBe(true);
  const ambiguous = detail(ambiguousState);
  expect(
    String(ambiguous).includes('data-agent-actor-reference="ambiguous"'),
  ).toBe(true);
  expect(String(ambiguous).includes('data-agent-avatar="destructive"')).toBe(
    true,
  );
  expect(String(ambiguous).includes(ref)).toBe(true);

  const failed = detail({ ...empty, error: "catalog failed" });
  expect(String(failed).includes("Couldn’t load agent")).toBe(true);
  expect(String(failed).includes(ref)).toBe(false);
  expect(
    executorCell({ ...empty, error: "catalog failed" }).includes(
      "Couldn’t load agent",
    ),
  ).toBe(true);
  expect(
    String(descriptor(renamed).query?.getSearchText?.(review)).includes(
      "Docs Writer",
    ),
  ).toBe(true);
});

test("routine detail presents an unavailable executor in its value instead of a definition alert", () => {
  const ref = "agent:01arz3ndektsv4rrffq69g5fav";
  const message = `executor ${ref} is not available in the effective Agent Actors catalog`;
  const unavailable: RoutineItem = {
    ...review,
    diagnostics: [
      {
        code: "routine_executor_unavailable",
        field: "action.executor",
        message,
        path: review.definitionPath,
      },
    ],
    valid: false,
  };
  const empty: AgentActorOptionsState = { ...executors, options: [] };

  const missing = renderToStaticMarkup(
    <RoutineDetailView executors={empty} item={unavailable} />,
  );
  expect(missing.includes('data-agent-actor-reference="missing"')).toBe(true);
  expect(missing.includes(ref)).toBe(true);
  expect(missing.includes(message)).toBe(false);
  expect(missing.includes("This definition needs attention")).toBe(false);

  const ambiguous = renderToStaticMarkup(
    <RoutineDetailView
      executors={{ ...empty, ambiguous: [ref] }}
      item={unavailable}
    />,
  );
  expect(ambiguous.includes('data-agent-actor-reference="ambiguous"')).toBe(
    true,
  );
  expect(ambiguous.includes(message)).toBe(false);

  const broken = renderToStaticMarkup(
    <RoutineDetailView
      executors={empty}
      item={{
        ...unavailable,
        diagnostics: [
          ...unavailable.diagnostics,
          {
            code: "routine_trigger_invalid",
            field: "trigger",
            message: "trigger is invalid",
            path: review.definitionPath,
          },
        ],
      }}
    />,
  );
  expect(broken.includes("This definition needs attention")).toBe(true);
  expect(broken.includes("trigger is invalid")).toBe(true);
});

test("executor column is an agent actor filtered by reference and sorted by name", () => {
  const writerRef = "agent:01arz3ndektsv4rrffq69g5fav";
  const analystRef = "agent:01bx5zzkbkactav9wevgemmvrz";
  const analysis: RoutineItem = {
    ...review,
    definition: {
      ...review.definition!,
      action: { executor: analystRef, type: "run_agent" },
    },
    id: "routine:analysis",
    name: "Analysis",
  };
  const items = [review, analysis];
  const withAgents = (writer: string): AgentActorOptionsState => ({
    ...executors,
    options: [
      { ...executors.options[0]!, label: writer },
      {
        description: null,
        label: "Analyst",
        ownerLabel: "Space",
        value: analystRef,
      },
    ],
  });
  const descriptor = (state: AgentActorOptionsState) =>
    createRoutinesPresentationDescriptor({
      actions: actions([]),
      executors: state,
      items,
    });
  const executor = descriptor(withAgents("Writer")).properties.find(
    (property) => property.key === "executor",
  )!;

  expect(resolveStandardPropertyColumn(executor)?.type).toBe("actor");
  expect(executor.getValue(review)).toBe(writerRef);
  expect(
    executor.actorCandidates?.map((candidate) => [
      candidate.kind,
      candidate.kind === "agent" ? candidate.reference : null,
      candidate.name,
    ]),
  ).toEqual([
    ["agent", writerRef, "Writer"],
    ["agent", analystRef, "Analyst"],
  ]);

  const byWriter = {
    filters: [{ operator: "eq", propertyKey: "executor", value: writerRef }],
    search: "",
    sort: [],
  };
  for (const name of ["Writer", "Zeta Writer"]) {
    const result = applyCollectionQuery({
      descriptor: descriptor(withAgents(name)),
      query: byWriter,
      items,
    });
    expect(result.items.map((item) => item.id)).toEqual(["routine:review"]);
  }

  const byName = (writer: string) =>
    applyCollectionQuery({
      descriptor: descriptor(withAgents(writer)),
      query: {
        filters: [],
        search: "",
        sort: [{ direction: "asc", propertyKey: "executor" }],
      },
      items,
    }).items.map((item) => item.id);
  expect(byName("Writer")).toEqual(["routine:analysis", "routine:review"]);
  expect(byName("Aardvark")).toEqual(["routine:review", "routine:analysis"]);

  const searched = applyCollectionQuery({
    descriptor: descriptor(withAgents("Writer")),
    query: { filters: [], search: "analyst", sort: [] },
    items,
  });
  expect(searched.items.map((item) => item.id)).toEqual(["routine:analysis"]);
});

test("a text query saved for the executor column resets instead of filtering wrongly", () => {
  const descriptor = createRoutinesPresentationDescriptor({
    actions: actions([]),
    executors,
    items: [review],
  });
  for (const rule of [
    { operator: "contains", value: "Documentation" },
    { operator: "eq", value: "Documentation Agent" },
  ]) {
    const result = validateCollectionQuery(descriptor, {
      filters: [{ propertyKey: "executor", ...rule }],
      search: "",
      sort: [],
    });
    expect(result.reset).toBe(true);
    expect(result.query.filters).toEqual([]);
  }
  const kept = validateCollectionQuery(descriptor, {
    filters: [
      {
        operator: "in",
        propertyKey: "executor",
        values: ["agent:01arz3ndektsv4rrffq69g5fav"],
      },
    ],
    search: "",
    sort: [],
  });
  expect(kept.reset).toBe(false);
  expect(kept.query.filters.length).toBe(1);
});
