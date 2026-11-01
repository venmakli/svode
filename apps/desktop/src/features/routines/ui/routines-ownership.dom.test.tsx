import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import type { CollectionInstance } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { RoutineItem, RoutineOwnership } from "../model/types";

// "Space" and "Collection" of a tab of Routines in the DOM: one owner holds
// every Routine, so both columns stay hidden while the filter offers them,
// and a rename of the owner changes their value without a write.
if (process.env.SVODE_ROUTINES_OWNERSHIP_DOM !== "1") {
  test("Routines ownership DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINES_OWNERSHIP_DOM: "1" },
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
  const routine = (id: string, name: string): RoutineItem => ({
    definition: {
      action: { executor: "agent:writer", type: "run_agent" },
      body: "Review.",
      description: "",
      enabled: null,
      name,
      trigger: { type: "manual" },
    },
    definitionPath: `.routines/${id}.md`,
    description: "",
    diagnostics: [],
    filename: `${id}.md`,
    fingerprint: `fingerprint:${id}`,
    id: `routine:${id}`,
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name,
    nextRunAt: null,
    routineId: `routine:${id}`,
    valid: true,
  });
  const items = [routine("review", "Review"), routine("triage", "Triage")];

  async function renderRoutines(ownership: RoutineOwnership) {
    const dom = await createTestDom();
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionHost, useCollectionState } =
      await import("@/features/collection");
    const { createRoutinesPresentation } =
      await import("./routines-presentation");
    const writes: string[] = [];
    const idle = { status: "idle" } as const;
    // Like the controller, the presentation is built on every render from
    // the names the owner has at that moment.
    function Host({ ownership }: { ownership: RoutineOwnership }) {
      const instance: CollectionInstance = {
        defaultPresentationId: "all",
        instanceKey: "routines:ownership",
        presentations: [
          createRoutinesPresentation({
            actions: {
              createState: idle,
              getDeleteState: () => idle,
              getEditState: () => idle,
              getEnabledState: () => idle,
              getRunState: () => idle,
              onAdd: () => writes.push("add"),
              onDelete: (item) => writes.push(`delete:${item.id}`),
              onEdit: (item) => writes.push(`edit:${item.id}`),
              onEnabledChange: async (item) => {
                writes.push(`enabled:${item.id}`);
              },
              onRun: async (item) => {
                writes.push(`run:${item.id}`);
              },
            },
            executors,
            onActivate: () => undefined,
            ownership,
            state: { phase: "ready", items },
          }),
        ],
        stateScope: "lifecycle",
      };
      const state = useCollectionState(instance);
      return state.phase === "ready" ? (
        <TooltipProvider>
          <CollectionHost instance={instance} state={state} />
        </TooltipProvider>
      ) : null;
    }
    await dom.render(<Host ownership={ownership} />);
    return {
      dom,
      rename: (next: RoutineOwnership) => dom.render(<Host ownership={next} />),
      writes,
    };
  }

  /** The values the filter of a property offers, through the query editor. */
  async function filterOptions(document: Document, label: string) {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    const pane = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    await clickElement(buttonByText(document, "Filters"));
    await clickElement(buttonByText(pane(), "Add filter"));
    await clickElement(buttonByText(pane(), label));
    const options = [
      ...pane().querySelectorAll("label [data-slot='badge']"),
    ].map((badge) => badge.textContent);
    return options;
  }

  const rowsText = (document: Document) =>
    [...document.querySelectorAll("[data-collection-row]")]
      .map((row) => row.textContent)
      .join(" ");

  test("the Routines of a Collection hide Space and Collection, which the filter still offers by name", async () => {
    const { dom, writes } = await renderRoutines({
      collection: "Tasks",
      space: "Documentation",
    });
    try {
      expect(
        ["Documentation", "Tasks"].filter((name) =>
          rowsText(dom.document).includes(name),
        ),
      ).toEqual([]);
      expect(await filterOptions(dom.document, "Space")).toEqual([
        "Documentation",
      ]);
      expect(writes).toEqual([]);
    } finally {
      await dom.dispose();
    }
  });

  test("a rename of the owner changes Space and Collection without a write", async () => {
    const { dom, rename, writes } = await renderRoutines({
      collection: "Tasks",
      space: "Documentation",
    });
    try {
      await rename({ collection: "Backlog", space: "Guides" });
      expect(await filterOptions(dom.document, "Collection")).toEqual([
        "Backlog",
      ]);
      expect(writes).toEqual([]);
    } finally {
      await dom.dispose();
    }
  });
}
