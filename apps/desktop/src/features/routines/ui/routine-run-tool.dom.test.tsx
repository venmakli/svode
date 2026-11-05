import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";

import type { CollectionActionState } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { RoutineItem } from "../model/types";

// DF-309: a disabled "Run now" in the Routine's top bar says why on hover;
// "Run now" that can run, its pending start and "Open session" say nothing.
// The tooltip portal needs the DOM before Radix loads, so the cases run in
// an isolated process.
if (process.env.SVODE_ROUTINE_RUN_TOOL_DOM !== "1") {
  test("Routine Run now DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINE_RUN_TOOL_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const routine: RoutineItem = {
    definition: {
      action: { executor: "", type: "run_agent" },
      body: "Review changes.",
      description: "",
      enabled: null,
      name: "Team review",
      trigger: { type: "manual" },
    },
    definitionPath: ".routines/team-review.md",
    description: "",
    diagnostics: [],
    filename: "team-review.md",
    fingerprint: "fingerprint:1",
    id: "routine:review",
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name: "Team review",
    nextRunAt: null,
    routineId: "routine:review",
    valid: true,
  };
  const activeRun: RoutineItem = {
    ...routine,
    lastRun: {
      active: true,
      agentSessionId: "codex:launch:launch-one",
      launchId: "launch-one",
      refusal: null,
      routineRunId: "run-one",
      sourceSessionId: "session-one",
    },
    lastRunAt: "2026-11-05T10:00:00Z",
    lastRunOrigin: "local",
  };

  test("a disabled Run now shows why on hover and does not run", async () => {
    const m = await messages();
    const reason = m.routines_executor_required();
    await withTool(routine, { reason, status: "disabled" }, async (tool) => {
      const run = tool.button(m.routines_run_now());
      expect(run.disabled).toBe(true);
      expect(run.hasAttribute("title")).toBe(false);

      // The disabled button takes no pointer events: the wrapper is hovered.
      const wrapper = run.parentElement!;
      expect(wrapper.tagName).toBe("SPAN");
      expect(await tool.hover(wrapper)).toBe(reason);
      expect(run.disabled).toBe(true);

      await act(async () => {
        run.click();
      });
      expect(tool.runs).toEqual([]);
    });
  });

  test("Run now that can run, its pending start and Open session show no reason", async () => {
    const m = await messages();
    await withTool(routine, { status: "idle" }, async (tool) => {
      const run = tool.button(m.routines_run_now());
      expect(run.disabled).toBe(false);
      expect(run.parentElement?.hasAttribute("data-routine-run-tool")).toBe(
        true,
      );
      expect(await tool.hover(run)).toBe("");
      await act(async () => {
        run.click();
      });
      expect(tool.runs).toEqual([routine.id]);
    });

    await withTool(routine, { status: "pending" }, async (tool) => {
      const starting = tool.button(m.routines_starting());
      expect(starting.disabled).toBe(true);
      expect(
        starting.parentElement?.hasAttribute("data-routine-run-tool"),
      ).toBe(true);
      expect(await tool.hover(starting)).toBe("");
    });

    await withTool(
      activeRun,
      { reason: m.routines_executor_required(), status: "disabled" },
      async (tool) => {
        const open = tool.button(m.routines_open_session());
        expect(open.disabled).toBe(false);
        expect(await tool.hover(open)).toBe("");
        await act(async () => {
          open.click();
        });
        expect(tool.opened).toEqual([activeRun.id]);
      },
    );
  });

  async function messages() {
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    return import("@/paraglide/messages.js");
  }

  async function withTool(
    item: RoutineItem,
    runState: CollectionActionState,
    body: (tool: {
      button(label: string): HTMLButtonElement;
      hover(element: Element): Promise<string>;
      opened: string[];
      runs: string[];
    }) => Promise<void>,
  ) {
    const dom = await createTestDom();
    const { RoutineRunTool } = await import("./routine-run-tool");
    const opened: string[] = [];
    const runs: string[] = [];
    try {
      await dom.render(
        <RoutineRunTool
          item={item}
          runState={runState}
          onOpenSession={(target) => opened.push(target.id)}
          onRun={async (target) => {
            runs.push(target.id);
          }}
        />,
      );
      await body({
        button(label) {
          const found = [...dom.document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent === label,
          );
          if (!found) {
            throw new Error(
              `no button ${label}: ${dom.document.body.innerHTML}`,
            );
          }
          return found;
        },
        async hover(element) {
          await act(async () => {
            element.dispatchEvent(
              new element.ownerDocument.defaultView!.MouseEvent("pointermove", {
                bubbles: true,
              }),
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
          // The tooltip as assistive technology reads it.
          return (
            dom.document.querySelector('[role="tooltip"]')?.textContent ?? ""
          );
        },
        opened,
        runs,
      });
    } finally {
      await dom.dispose();
    }
  }
}
