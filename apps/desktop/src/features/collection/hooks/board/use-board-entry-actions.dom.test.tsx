import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { Column } from "@/features/properties";

if (process.env.SVODE_BOARD_ENTRY_ACTIONS_DOM !== "1") {
  test("Board card drop DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_BOARD_ENTRY_ACTIONS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  // The writes a drop makes: the grouping field and the manual order.
  const fieldSaves: [string, string, unknown][] = [];
  const orderSaves: [string, string[]][] = [];
  const saveField = async (entry: Page, column: Column, value: unknown) => {
    fieldSaves.push([entry.path, column.name, value]);
  };
  const commitField = async () => {};
  const saveOrder = async (orderKey: string, entries: Page[]) => {
    orderSaves.push([orderKey, entries.map((entry) => entry.path)]);
  };
  const reloadOrderParent = async () => {};
  mock.module("../use-collection-entry-field-save", () => ({
    useCollectionEntryFieldSave: () => ({ commitField, saveField }),
  }));
  mock.module("../use-collection-tree-order", () => ({
    useCollectionTreeOrder: () => ({ reloadOrderParent, saveOrder }),
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { useBoardEntryActions } = await import("./use-board-entry-actions");
  type MoveCard = ReturnType<typeof useBoardEntryActions>["moveCard"];

  const status: Column = { name: "Status", type: "status" };
  const page = (path: string, value: string): Page => ({
    path,
    body: "",
    meta: {
      title: path,
      icon: null,
      created: "",
      updated: "",
      extra: { Status: value },
    },
  });
  // Todo: A, C; Doing: B, D. The list comes from the backend in view order.
  const initial = [
    page("tasks/A.md", "Todo"),
    page("tasks/B.md", "Doing"),
    page("tasks/C.md", "Todo"),
    page("tasks/D.md", "Doing"),
  ];

  const root = createRoot(document.getElementById("app")!);
  let moveCard: MoveCard | null = null;

  function Harness({ hasSort }: { hasSort: boolean }) {
    const [entries, setEntries] = useState(initial);
    const [manualOrderEntries, setManualOrderEntries] = useState(initial);
    const actions = useBoardEntryActions({
      collectionPath: "tasks",
      spacePath: "/project/docs",
      projectPath: "/project",
      entries,
      manualOrderEntries,
      topLevelEntries: entries,
      groupColumn: status,
      hasSort,
      setEntries,
      setManualOrderEntries,
      loadEntries: async () => {},
      onCreatePage: async () => initial[0],
    });
    useEffect(() => {
      moveCard = actions.moveCard;
    });
    return null;
  }

  async function drop(
    hasSort: boolean,
    target: {
      active: string;
      group: string;
      over: string | null;
      placement?: "before" | "after";
    },
  ) {
    // A fresh board for every drop.
    await act(async () => root.render(<></>));
    await act(async () => root.render(<Harness hasSort={hasSort} />));
    await act(async () => {
      await moveCard!({
        activeEntryPath: target.active,
        targetGroupKey: target.group,
        overEntryPath: target.over,
        placement: target.placement ?? "before",
      });
    });
  }

  function resetWrites() {
    fieldSaves.length = 0;
    orderSaves.length = 0;
  }

  test("with a sort a drop on a card of another column saves only the group field", async () => {
    resetWrites();
    await drop(true, {
      active: "tasks/A.md",
      group: "Doing",
      over: "tasks/D.md",
    });
    expect(fieldSaves).toEqual([["tasks/A.md", "Status", "Doing"]]);
    expect(orderSaves).toEqual([]);
  });

  test("with a sort a drop on another column body saves only the group field", async () => {
    resetWrites();
    await drop(true, { active: "tasks/B.md", group: "Done", over: null });
    expect(fieldSaves).toEqual([["tasks/B.md", "Status", "Done"]]);
    expect(orderSaves).toEqual([]);
  });

  test("with a sort a drop inside the source column writes nothing", async () => {
    resetWrites();
    await drop(true, {
      active: "tasks/A.md",
      group: "Todo",
      over: "tasks/C.md",
    });
    await drop(true, {
      active: "tasks/C.md",
      group: "Todo",
      over: "tasks/A.md",
      placement: "after",
    });
    await drop(true, { active: "tasks/A.md", group: "Todo", over: null });
    expect(fieldSaves).toEqual([]);
    expect(orderSaves).toEqual([]);
  });

  test("without a sort a positional drop in another column saves the field and the order", async () => {
    resetWrites();
    await drop(false, {
      active: "tasks/A.md",
      group: "Doing",
      over: "tasks/D.md",
    });
    expect(fieldSaves).toEqual([["tasks/A.md", "Status", "Doing"]]);
    expect(orderSaves).toEqual([
      ["tasks", ["tasks/B.md", "tasks/C.md", "tasks/A.md", "tasks/D.md"]],
    ]);
  });

  test("without a sort a positional drop in the same column saves only the order", async () => {
    resetWrites();
    await drop(false, {
      active: "tasks/A.md",
      group: "Todo",
      over: "tasks/C.md",
      placement: "after",
    });
    expect(fieldSaves).toEqual([]);
    expect(orderSaves).toEqual([
      ["tasks", ["tasks/B.md", "tasks/C.md", "tasks/A.md", "tasks/D.md"]],
    ]);
  });

  test("without a sort a drop on another column body saves only the group field", async () => {
    resetWrites();
    await drop(false, { active: "tasks/B.md", group: "Todo", over: null });
    expect(fieldSaves).toEqual([["tasks/B.md", "Status", "Todo"]]);
    expect(orderSaves).toEqual([]);
  });
}
