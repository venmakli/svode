import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { RoutineRow } from "../model/types";
import { createRoutine, updateRoutine } from "./routines-api";

test("desktop create sends one full definition mutation and preserves applied warnings", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  mockNativeIpc((command, args) => {
    calls.push({ command, args: args as Record<string, unknown> });
    return {
      changedPaths: [".routines/review.md"],
      routineId: "routine:created",
      snapshot: {
        catalogFingerprint: "catalog-1",
        diagnostics: [],
        owner: { kind: "project", ownerPath: ".", spaceId: "root" },
        refreshedAt: "2026-08-21T00:00:00Z",
        routines: [
          {
            actionSummary: "run_agent",
            actionType: "run_agent",
            definition: {
              action: {
                executor: "agent:01arz3ndektsv4rrffq69g5fav",
                type: "run_agent",
              },
              body: "Review changes.",
              description: null,
              enabled: false,
              name: "Review",
              trigger: {
                cron: "0 9 * * 1-5",
                missedRuns: "skip",
                timezone: "UTC",
                type: "schedule",
              },
            },
            description: null,
            diagnostics: [],
            enabled: false,
            executor: "agent:01arz3ndektsv4rrffq69g5fav",
            executionFingerprint: "execution-1",
            filename: "review.md",
            fingerprint: "row-1",
            lastRunAt: null,
            nextRunAt: null,
            path: ".routines/review.md",
            routineId: "routine:created",
            name: "Review",
            triggerSummary: "schedule",
            triggerType: "schedule",
          },
        ],
      },
      status: "applied",
      warnings: [
        {
          code: "routine_projection_refresh_failed",
          message: "projection warning",
        },
      ],
    };
  });

  try {
    const result = await createRoutine(
      {
        ownerKind: "registered_space",
        ownerPath: ".",
        projectPath: "/project",
        spaceId: "root",
        spacePath: "/project",
      },
      {
        action: {
          executor: "agent:01arz3ndektsv4rrffq69g5fav",
          type: "run_agent",
        },
        body: "Review changes.",
        description: "",
        enabled: false,
        name: "Review",
        trigger: {
          cron: "0 9 * * 1-5",
          missedRuns: "skip",
          timezone: "UTC",
          type: "schedule",
        },
      },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe("routines_create");
    expect(calls[0]?.args.definition).toEqual({
      action: {
        executor: "agent:01arz3ndektsv4rrffq69g5fav",
        type: "run_agent",
      },
      body: "Review changes.",
      description: null,
      enabled: false,
      name: "Review",
      trigger: {
        cron: "0 9 * * 1-5",
        missedRuns: "skip",
        timezone: "UTC",
        type: "schedule",
      },
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.changedPaths).toEqual([".routines/review.md"]);
      expect(result.warnings[0]?.code).toBe(
        "routine_projection_refresh_failed",
      );
    }
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});

test("desktop update forwards filename materialization intent", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  mockNativeIpc((command, args) => {
    calls.push({ command, args: args as Record<string, unknown> });
    return { message: "blocked for test", status: "blocked" };
  });
  const row: RoutineRow = {
    definition: {
      action: {
        executor: "agent:01arz3ndektsv4rrffq69g5fav",
        type: "run_agent",
      },
      body: "Review changes.",
      description: "",
      enabled: false,
      name: "Review",
      trigger: {
        cron: "0 9 * * 1-5",
        missedRuns: "skip",
        timezone: "UTC",
        type: "schedule",
      },
    },
    definitionPath: ".routines/review.md",
    description: "",
    diagnostics: [],
    filename: "review.md",
    fingerprint: "row-1",
    id: "routine:review",
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name: "Review",
    nextRunAt: null,
    routineId: "routine:review",
    valid: true,
  };

  try {
    await updateRoutine(
      {
        ownerKind: "registered_space",
        ownerPath: ".",
        projectPath: "/project",
        spaceId: "root",
        spacePath: "/project",
      },
      row,
      row.definition!,
      { materializeFilename: false },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe("routines_update");
    expect(calls[0]?.args.materializeFilename).toBe(false);
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});

test("desktop create preserves structured name-conflict evidence", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  mockNativeIpc(() => ({
    conflict: {
      conflicts: [
        {
          filename: "existing.md",
          name: "Existing",
          path: ".routines/existing.md",
          routineId: "routine:existing",
        },
      ],
      owner: { kind: "project", ownerPath: ".", spaceId: "root" },
    },
    status: "name_conflict",
  }));

  try {
    const result = await createRoutine(
      {
        ownerKind: "registered_space",
        ownerPath: ".",
        projectPath: "/project",
        spaceId: "root",
        spacePath: "/project",
      },
      {
        action: {
          executor: "agent:01arz3ndektsv4rrffq69g5fav",
          type: "run_agent",
        },
        body: "Review changes.",
        description: "",
        enabled: null,
        name: " existing ",
        trigger: { type: "manual" },
      },
    );

    expect(result).toEqual({
      conflict: {
        conflicts: [
          {
            filename: "existing.md",
            name: "Existing",
            path: ".routines/existing.md",
            routineId: "routine:existing",
          },
        ],
        ownerPath: ".",
        resolvedOwnerKind: "project",
        spaceId: "root",
      },
      status: "name_conflict",
    });
  } finally {
    clearNativeMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    dom.window.close();
  }
});
