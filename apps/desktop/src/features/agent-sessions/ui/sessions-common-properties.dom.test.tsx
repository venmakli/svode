import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import type { CollectionInstance } from "@/features/collection";
import { createTestDom } from "@/shared/testing/dom";

import type { AgentSession } from "../model";
import { listedSession } from "../model/testing/catalog";

// The common properties "Agent" and "Modified" of Sessions in the DOM: the
// cell, the filter and the sort. The Agents and Attachments collections run
// the same scenario over the same values and expect the same result.
if (process.env.SVODE_SESSIONS_COMMON_PROPERTIES_DOM !== "1") {
  test("Sessions common properties DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SESSIONS_COMMON_PROPERTIES_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const sessions: AgentSession[] = [
    listedSession({
      id: "claude-code:a",
      source: "claude-code",
      title: "Alpha",
      lastActivityAt: "2026-09-28",
    }),
    listedSession({
      id: "codex:b",
      title: "Beta",
      lastActivityAt: "2026-09-29",
    }),
    listedSession({
      id: "codex:c",
      title: "Gamma",
      lastActivityAt: "2026-09-27",
    }),
  ];

  const names: Record<string, string> = Object.fromEntries(
    sessions.map((session) => [session.id, session.title]),
  );

  async function renderSessions() {
    const dom = await createTestDom();
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { createAgentAdapterDictionary } =
      await import("@/features/agent-adapters");
    const { CollectionHost, useCollectionState } =
      await import("@/features/collection");
    const { createAgentSessionsPresentation } =
      await import("./sessions-presentation");
    const agents = createAgentAdapterDictionary([
      { id: "codex", displayName: "Codex" },
      { id: "claude-code", displayName: "Claude Code" },
    ]);
    const instance: CollectionInstance = {
      defaultPresentationId: "all",
      instanceKey: "sessions:common-properties",
      presentations: [
        createAgentSessionsPresentation({
          actions: {
            createState: { status: "idle" },
            onCreate: async () => undefined,
            terminalOf: () => null,
            onCloseTerminal: () => undefined,
            onCopyResumeCommand: () => undefined,
            onOpenExternalTerminal: () => undefined,
            routineOf: () => null,
            onOpenRoutine: () => undefined,
            pinnedOf: () => null,
            pinPending: () => false,
            onTogglePin: () => undefined,
            keepable: () => false,
            onKeep: () => undefined,
          },
          agents,
          onActivate: () => undefined,
          state: { phase: "ready", items: sessions },
        }),
      ],
      stateScope: "lifecycle",
    };
    function Host() {
      const state = useCollectionState(instance);
      return state.phase === "ready" ? (
        <TooltipProvider>
          <CollectionHost instance={instance} state={state} />
        </TooltipProvider>
      ) : null;
    }
    await dom.render(<Host />);
    return dom;
  }

  /**
   * Filters and sorts by a property through the query editor of the
   * Collection, as a user does: the options its filter offers, the rows the
   * filter leaves and the rows the sort orders.
   */
  async function queryByProperty(
    document: Document,
    label: string,
    choose: (pane: HTMLElement) => Promise<void>,
  ) {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    const pane = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const rows = () =>
      [...document.querySelectorAll("[data-collection-row]")].map(
        (row) => names[row.getAttribute("data-collection-row")!],
      );
    await clickElement(buttonByText(document, "Filters"));
    await clickElement(buttonByText(pane(), "Add filter"));
    await clickElement(buttonByText(pane(), label));
    const filterOptions = [
      ...pane().querySelectorAll("label [data-slot='badge']"),
    ].map((badge) => badge.textContent);
    await choose(pane());
    await clickElement(buttonByText(pane(), "Apply filter"));
    const filtered = rows();
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Clear filter"));
    await clickElement(buttonByText(document, "Sort"));
    await clickElement(buttonByText(pane(), "Add sort"));
    await clickElement(buttonByText(pane(), label));
    await clickElement(buttonByText(pane(), "Apply sort"));
    return { filterOptions, filtered, sorted: rows() };
  }

  test("Agent: the cell, the filter and the sort follow the agent dictionary", async () => {
    const dom = await renderSessions();
    const { clickElement } = await import("@/shared/testing/dom-query");
    try {
      const cell = (id: string) =>
        dom.document.querySelector(
          `[data-collection-row="${id}"] [data-agent-property]`,
        );
      expect(
        ["claude-code:a", "codex:b", "codex:c"].map((id) => [
          cell(id)?.getAttribute("data-agent-property"),
          cell(id)?.textContent,
          Boolean(cell(id)?.querySelector("[aria-hidden]")),
        ]),
      ).toEqual([
        ["claude-code", "Claude Code", true],
        ["codex", "Codex", true],
        ["codex", "Codex", true],
      ]);
      expect(
        await queryByProperty(dom.document, "Agent", (pane) =>
          clickElement(
            [...pane.querySelectorAll("label")]
              .find((option) => option.textContent === "Codex")!
              .querySelector<HTMLElement>('[role="checkbox"]')!,
          ),
        ),
      ).toEqual({
        filterOptions: ["Codex", "Claude Code"],
        filtered: ["Beta", "Gamma"],
        sorted: ["Beta", "Gamma", "Alpha"],
      });
    } finally {
      await dom.dispose();
    }
  });

  test("Modified: the cell, the filter and the sort follow the time of the last activity", async () => {
    const dom = await renderSessions();
    const { typeIntoInput } = await import("@/shared/testing/dom-query");
    try {
      const rowText = (id: string) =>
        dom.document.querySelector(`[data-collection-row="${id}"]`)
          ?.textContent ?? "";
      expect(
        ["claude-code:a", "codex:b", "codex:c"].map((id) =>
          ["Sep 28, 2026", "Sep 29, 2026", "Sep 27, 2026"].find((date) =>
            rowText(id).includes(date),
          ),
        ),
      ).toEqual(["Sep 28, 2026", "Sep 29, 2026", "Sep 27, 2026"]);
      expect(
        await queryByProperty(dom.document, "Modified", (pane) =>
          typeIntoInput(
            pane.querySelector<HTMLInputElement>('input[type="date"]')!,
            "2026-09-29",
          ),
        ),
      ).toEqual({
        filterOptions: [],
        filtered: ["Beta"],
        sorted: ["Gamma", "Alpha", "Beta"],
      });
    } finally {
      await dom.dispose();
    }
  });
}
