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

const review: RoutineRow = {
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

const scheduled: RoutineRow = {
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

const invalid: RoutineRow = {
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

const eventRoutine: RoutineRow = {
  ...scheduled,
  definition: {
    ...scheduled.definition!,
    enabled: true,
    name: "Triage new entries",
    trigger: {
      event: "collection.entry_created",
      type: "event",
    },
  },
  definitionPath: ".routines/triage-new-entries.md",
  filename: "triage-new-entries.md",
  fingerprint: "fingerprint:triage",
  id: "routine:triage",
  name: "Triage new entries",
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
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
    "enabled",
  ]);
  expect(descriptor.layout.visibleFields).toEqual([
    "trigger",
    "action",
    "executor",
    "last-run",
    "next-run",
    "enabled",
  ]);
  for (const key of ["trigger", "next-run"]) {
    const semantics = descriptor.fields.find(
      (field) => field.key === key,
    )?.valueSemantics;
    expect(semantics?.kind).toBe("property");
    expect(semantics && "render" in semantics).toBe(false);
  }
  const enabledField = descriptor.fields.at(-1)!;
  expect(enabledField.valueSemantics).toEqual({
    column: { display: "switch", name: "enabled", type: "boolean" },
    kind: "property",
  });
  expect(enabledField.getApplicability?.(scheduled)).toEqual({
    status: "applicable",
  });
  expect(enabledField.getApplicability?.(review)).toEqual({
    status: "hidden",
  });
  expect(enabledField.getApplicability?.(invalid)).toEqual({
    label: "Unavailable",
    status: "unavailable",
  });
  expect(enabledField.getAccessibilityLabel?.(scheduled)).toBe(
    "Enabled: Daily summary",
  );
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

test("routine detail hides technical paths when valid and preserves exact recovery paths when invalid", () => {
  const valid = renderToStaticMarkup(<RoutineDetailView row={review} />);
  expect(valid.includes(review.definitionPath)).toBe(false);

  const invalidPath = ".routines/broken.md";
  const invalid = renderToStaticMarkup(
    <RoutineDetailView
      row={{
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
    NonNullable<RoutineRow["definition"]>["trigger"],
    { type: "schedule" }
  >;
  expect(routineScheduleSummary(trigger)).toBe("Schedule · 0 9 * * *");
  expect(routineTimeBasisLabel(trigger.timeBasis)).toBe(
    "Novosibirsk — GMT+07:00",
  );

  const fixed = renderToStaticMarkup(
    <RoutineDetailView
      row={{ ...scheduled, nextRunAt: "2026-08-27T02:00:00Z" }}
    />,
  );
  expect(fixed.includes("Fixed timezone")).toBe(false);
  expect(fixed.includes("Asia/Novosibirsk")).toBe(false);

  const local = renderToStaticMarkup(
    <RoutineDetailView
      row={{
        ...scheduled,
        definition: {
          ...scheduled.definition!,
          trigger: {
            ...scheduled.definition!.trigger,
            timeBasis: { mode: "local" },
          } as Extract<
            NonNullable<RoutineRow["definition"]>["trigger"],
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

test("duplicate-name rows conditionally expose their current path and remain usable", () => {
  const conflictRow: RoutineRow = {
    ...review,
    nameConflict: {
      conflictingPaths: [".routines/existing.md"],
    },
  };
  const descriptor = createRoutinesPresentationDescriptor({
    actions: actions([]),
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
  });
  const normalDescription =
    descriptor.layout.kind === "list"
      ? descriptor.layout.getDescription?.(review)
      : null;
  const conflictDescription =
    descriptor.layout.kind === "list"
      ? descriptor.layout.getDescription?.(conflictRow)
      : null;
  const normalMarkup = renderToStaticMarkup(<>{normalDescription}</>);
  const conflictMarkup = renderToStaticMarkup(<>{conflictDescription}</>);
  const detailMarkup = renderToStaticMarkup(
    <RoutineDetailView row={conflictRow} />,
  );

  expect(normalMarkup.includes(review.definitionPath)).toBe(false);
  expect(conflictMarkup.includes(review.definitionPath)).toBe(true);
  expect(detailMarkup.includes("Duplicate routine name")).toBe(true);
  expect(detailMarkup.includes(review.definitionPath)).toBe(true);
  expect(descriptor.rowActions?.[0]?.isVisible?.(conflictRow)).toBe(true);
});

test("routines query searches definitions and defaults to name ordering", () => {
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

  const enabledScheduled: RoutineRow = {
    ...scheduled,
    definition: { ...scheduled.definition!, enabled: true },
    id: "routine:enabled-summary",
    name: "Enabled summary",
  };
  const disabledRows = applySystemCollectionQuery({
    descriptor,
    query: {
      filters: [{ fieldKey: "enabled", operator: "eq", value: false }],
      search: "",
      sort: [],
    },
    rows: [review, scheduled, enabledScheduled],
  });
  expect(disabledRows.rows.map((row) => row.id)).toEqual([
    "routine:summary",
    "routine:review",
  ]);
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
  expect(markup.includes('role="switch"')).toBe(true);
  expect(markup.includes('data-size="sm"')).toBe(true);
  expect(markup.includes('aria-label="Enabled: Daily summary"')).toBe(true);
  expect(markup.includes('role="checkbox"')).toBe(false);
});

test("manual routines omit enabled while invalid routines render a passive marker", () => {
  const routineActions = actions([]);
  routineActions.getEnabledState = (row) => {
    if (row.id !== scheduled.id) {
      throw new Error("passive rows must not read control state");
    }
    return { status: "idle" };
  };
  const presentation = createRoutinesPresentation({
    actions: routineActions,
    createDetailRequest: () => ({
      content: null,
      description: null,
      title: null,
    }),
    state: {
      phase: "ready",
      rows: [scheduled, eventRoutine, review, invalid],
    },
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

  expect(markup.match(/role="switch"/g)?.length).toBe(2);
  expect(markup.includes('role="checkbox"')).toBe(false);
  expect(markup.includes("Not applicable")).toBe(false);
  expect(
    markup.includes('data-system-collection-field-applicability="unavailable"'),
  ).toBe(true);
  expect(markup.includes("Unavailable")).toBe(true);
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
