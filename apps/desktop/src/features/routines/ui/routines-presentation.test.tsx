import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applySystemCollectionQuery,
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationCore,
  type SystemCollectionInstance,
  type SystemCollectionStateController,
} from "@/features/collection/system";

import type { RoutineRow } from "../model/types";
import { RoutineAutomaticConsent } from "./routine-automatic-consent";
import {
  createRoutinesPresentation,
  createRoutinesPresentationDescriptor,
  toRoutinePresentationState,
  type RoutinePresentationActions,
} from "./routines-presentation";

const review: RoutineRow = {
  definition: {
    action: {
      executor: "agent:01arz3ndektsv4rrffq69g5fav",
      type: "run_agent",
    },
    body: "Review changes.",
    description: "Review the current owner.",
    enabled: null,
    title: "Review",
    trigger: { type: "manual" },
  },
  definitionPath: ".routines/review.md",
  description: "Review the current owner.",
  diagnostics: [],
  filename: "review.md",
  fingerprint: "fingerprint:review",
  id: "routine:review",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  nextRunAt: null,
  title: "Review",
  valid: true,
};

const scheduled: RoutineRow = {
  ...review,
  definition: {
    ...review.definition!,
    enabled: false,
    title: "Daily summary",
    trigger: {
      cron: "0 9 * * *",
      missedRuns: "skip",
      timezone: "Asia/Novosibirsk",
      type: "schedule",
    },
  },
  definitionPath: ".routines/daily-summary.md",
  filename: "daily-summary.md",
  fingerprint: "fingerprint:summary",
  id: "routine:summary",
  title: "Daily summary",
};

function actions(calls: string[]): RoutinePresentationActions {
  return {
    createState: { status: "idle" },
    getDeleteState: () => ({ status: "idle" }),
    getEditState: () => ({ status: "idle" }),
    getEnabledState: () => ({ status: "idle" }),
    getRunState: () => ({ status: "idle" }),
    onAdd: () => calls.push("add"),
    onDelete: (row) => calls.push(`delete:${row.id}`),
    onEdit: (row) => calls.push(`edit:${row.id}`),
    onEnabledChange: async (row, enabled) => {
      calls.push(`enabled:${row.id}:${enabled}`);
    },
    onRun: async (row) => {
      calls.push(`run:${row.id}`);
    },
  };
}

test("routines expose one fixed All list with the complete fixed schema", () => {
  const descriptor = createRoutinesPresentationDescriptor({
    actions: actions([]),
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
  });

  expect(descriptor.id).toBe("all");
  expect(descriptor.layout.kind).toBe("list");
  expect(descriptor.fields.map((field) => field.key)).toEqual([
    "enabled",
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
  ]);
  expect(descriptor.layout.visibleFields).toEqual([
    "enabled",
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
  ]);
  expect(descriptor.create?.id).toBe("add-routine");
  expect("refresh" in descriptor).toBe(false);
  expect(descriptor.rowActions?.map((action) => action.id)).toEqual([
    "run-routine",
    "edit-routine",
    "delete-routine",
  ]);
  const runAction = descriptor.rowActions?.[0];
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
        ptyId: "pty-one",
        routineRunId: "run-one",
        sourceSessionId: null,
      },
    }),
  ).toBe("Open session");
});

test("routines query searches definitions and defaults to title ordering", () => {
  const descriptor = createRoutinesPresentationDescriptor({
    actions: actions([]),
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
  });
  const ordered = applySystemCollectionQuery({
    descriptor,
    query: EMPTY_SYSTEM_COLLECTION_QUERY,
    rows: [review, scheduled],
  });
  const searched = applySystemCollectionQuery({
    descriptor,
    query: { filters: [], search: "0 9 * * *", sort: [] },
    rows: [review, scheduled],
  });

  expect(ordered.rows.map((row) => row.id)).toEqual([
    "routine:summary",
    "routine:review",
  ]);
  expect(searched.rows.map((row) => row.id)).toEqual(["routine:summary"]);
});

test("routines delegate create, row actions, and inline enabled edits", async () => {
  const calls: string[] = [];
  const descriptor = createRoutinesPresentationDescriptor({
    actions: actions(calls),
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
  });

  await descriptor.create?.run();
  for (const action of descriptor.rowActions ?? []) {
    if (action.isVisible?.(review) === false) continue;
    await action.run(review);
  }
  await descriptor.fields
    .find((field) => field.key === "enabled")
    ?.edit?.update(scheduled, true);

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
    actions: actions([]),
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
    state: { phase: "ready", rows: [scheduled] },
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "all",
    instanceKey: "routines:space:root",
    presentations: [presentation],
    stateScope: "session",
  };
  const state: Extract<SystemCollectionStateController, { phase: "ready" }> = {
    activePresentationId: "all",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_SYSTEM_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationCore
        trailingActions={
          <RoutineAutomaticConsent
            enabled={false}
            error={null}
            loading={false}
            ownerKind="project"
            pending={false}
            onChange={() => undefined}
            onRetry={() => undefined}
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
  const createPosition = markup.indexOf(
    'data-system-collection-create="add-routine"',
  );

  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes('role="listitem"')).toBe(true);
  expect(markup.includes('data-system-collection-presentation="all"')).toBe(
    true,
  );
  expect(markup.includes('data-system-collection-create="add-routine"')).toBe(
    true,
  );
  expect(markup.includes("data-system-collection-refresh")).toBe(false);
  expect(markup.includes("Daily summary")).toBe(true);
  expect(markup.includes("Active")).toBe(false);
  expect(markup.includes("Runs")).toBe(false);
  expect(queryPosition > -1).toBe(true);
  expect(createPosition > queryPosition).toBe(true);
  expect(authorityPosition > createPosition).toBe(true);
  expect(markup.includes('data-orientation="vertical"')).toBe(false);
  expect(markup.includes("Add routine")).toBe(false);
  expect(markup.includes(">Add<")).toBe(true);
  expect(markup.includes('data-system-collection-field="enabled"')).toBe(true);
});

test("manual enabled controls keep their disabled reason tooltip-only", () => {
  const routineActions = actions([]);
  routineActions.getEnabledState = () => ({
    reason: "tooltip-only-manual-reason",
    status: "disabled",
  });
  const presentation = createRoutinesPresentation({
    actions: routineActions,
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
    state: { phase: "ready", rows: [review] },
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "all",
    instanceKey: "routines:space:manual",
    presentations: [presentation],
    stateScope: "session",
  };
  const state: Extract<SystemCollectionStateController, { phase: "ready" }> = {
    activePresentationId: "all",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: EMPTY_SYSTEM_COLLECTION_QUERY,
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationCore instance={instance} state={state} />
    </TooltipProvider>,
  );

  expect(markup.includes('title="tooltip-only-manual-reason"')).toBe(true);
  expect(markup.includes(">tooltip-only-manual-reason<")).toBe(false);
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
        rows: [review],
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
      rows: [review],
      spaceId: "root",
    },
  };
}
