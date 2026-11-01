import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import type { CollectionInstance } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { RoutineItem } from "../model/types";

// A Routine with problems in the DOM: "Has problems" in "Status" with the
// reasons on hover, and "Enabled" keeps its saved value with the switch off
// limits.
if (process.env.SVODE_ROUTINES_STATE_DOM !== "1") {
  test("Routines Status DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINES_STATE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const executors: AgentActorOptionsState = {
    ambiguous: [],
    error: null,
    incomplete: false,
    loading: false,
    options: [],
  };
  const broken: RoutineItem = {
    definition: {
      action: { executor: "agent:missing", type: "run_agent" },
      body: "Triage.",
      description: "",
      enabled: true,
      name: "Triage",
      trigger: { event: "collection.entry_created", type: "event" },
    },
    definitionPath: ".routines/triage.md",
    description: "",
    diagnostics: [
      {
        code: "routine_executor_unknown",
        field: "action.executor",
        message: "executor agent:missing is not in the catalog",
        path: ".routines/triage.md",
      },
      {
        code: "routine_event_filter_invalid",
        field: "trigger.filter",
        message: "the event filter names no collection",
        path: ".routines/triage.md",
      },
    ],
    filename: "triage.md",
    fingerprint: "fingerprint:triage",
    id: "routine:triage",
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name: "Triage",
    nextRunAt: null,
    routineId: "routine:triage",
    valid: false,
  };

  test("a Routine with problems says Has problems with its reasons on hover and keeps its switch on, off limits", async () => {
    const dom = await createTestDom();
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionHost, useCollectionState } =
      await import("@/features/collection");
    const { createRoutinesPresentation } =
      await import("./routines-presentation");
    const changes: boolean[] = [];
    const idle = { status: "idle" } as const;
    const instance: CollectionInstance = {
      defaultPresentationId: "all",
      instanceKey: "routines:state",
      presentations: [
        createRoutinesPresentation({
          ownership: { collection: null, space: "Project" },
          actions: {
            createState: idle,
            getDeleteState: () => idle,
            getEditState: () => idle,
            getEnabledState: (item) =>
              item.valid ? idle : { reason: "invalid", status: "disabled" },
            getRunState: () => idle,
            onAdd: () => undefined,
            onDelete: () => undefined,
            onEdit: () => undefined,
            onEnabledChange: async (_item, enabled) => {
              changes.push(enabled);
            },
            onRun: async () => undefined,
          },
          executors,
          onActivate: () => undefined,
          state: { phase: "ready", items: [broken] },
        }),
      ],
      stateScope: "lifecycle",
    };
    function Host() {
      const state = useCollectionState(instance);
      return state.phase === "ready" ? (
        <TooltipProvider delayDuration={0}>
          <CollectionHost instance={instance} state={state} />
        </TooltipProvider>
      ) : null;
    }
    try {
      await dom.render(<Host />);
      const row = dom.document.querySelector<HTMLElement>(
        '[data-collection-row="routine:triage"]',
      )!;
      const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
      expect([toggle.getAttribute("aria-checked"), toggle.disabled]).toEqual([
        "true",
        true,
      ]);
      await act(async () => {
        toggle.click();
      });
      expect(changes).toEqual([]);
      expect(row.textContent?.includes("Unavailable")).toBe(false);

      const state = row.querySelector<HTMLElement>(
        "[data-collection-state-problems]",
      )!;
      expect(state.textContent?.startsWith("Has problems")).toBe(true);
      await act(async () => {
        state.dispatchEvent(
          new state.ownerDocument.defaultView!.MouseEvent("pointermove", {
            bubbles: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      const tooltip = dom.document.querySelector(
        '[data-slot="tooltip-content"]',
      );
      expect(
        tooltip?.textContent?.startsWith(
          "executor agent:missing is not in the catalog · the event filter names no collection",
        ),
      ).toBe(true);
    } finally {
      await dom.dispose();
    }
  });
}
