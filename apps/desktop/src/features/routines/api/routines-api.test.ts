import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { createRoutine } from "./routines-api";

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
              title: "Review",
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
            filename: "review-01arz3ndektsv4rrffq69g5fav.md",
            fingerprint: "row-1",
            lastRunAt: null,
            nextRunAt: null,
            path: ".routines/review-01arz3ndektsv4rrffq69g5fav.md",
            routineId: "routine:created",
            title: "Review",
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
        title: "Review",
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
      title: "Review",
      trigger: {
        cron: "0 9 * * 1-5",
        missedRuns: "skip",
        timezone: "UTC",
        type: "schedule",
      },
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
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
