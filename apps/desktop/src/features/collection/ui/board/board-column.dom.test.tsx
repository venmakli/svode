import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { Column } from "@/features/properties";

if (process.env.SVODE_BOARD_COLUMN_DOM !== "1") {
  test("Board column drag DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_BOARD_COLUMN_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { DndContext } = await import("@dnd-kit/core");
  const { BoardColumn } = await import("./board-column");

  const status: Column = { name: "Status", type: "status" };
  const page = (path: string): Page => ({
    path,
    body: "",
    meta: {
      title: path,
      icon: null,
      created: "",
      updated: "",
      extra: { Status: "Todo" },
    },
  });
  const cards = [page("tasks/A.md"), page("tasks/B.md")].map((entry) => ({
    entry,
    groupKey: "Todo",
  }));

  const root = createRoot(document.getElementById("app")!);

  async function render({
    readOnly = false,
    hasSort,
    activeEntryPath = null,
    overGroupKey = null,
  }: {
    readOnly?: boolean;
    hasSort: boolean;
    activeEntryPath?: string | null;
    overGroupKey?: string | null;
  }) {
    await act(async () =>
      root.render(
        <DndContext>
          <BoardColumn
            group={{ key: "Todo", value: "Todo", label: "Todo" }}
            cards={cards}
            count={cards.length}
            activeEntryPath={activeEntryPath}
            overGroupKey={overGroupKey}
            hasSort={hasSort}
            draftOpen={false}
            draftAsFolder={false}
            readOnly={readOnly}
            onPointerEnter={() => {}}
            onOpenDraft={() => {}}
            onCancelDraft={() => {}}
            onCreateDraft={() => {}}
            cardProps={{
              readOnly,
              groupColumn: status,
              cardFields: ["title"],
              customColumns: [],
              nestedCollectionPaths: new Set(),
              spacePath: "/project/docs",
              projectPath: "/project",
              actors: [],
              onRequestActors: async () => [],
              onOpen: () => {},
              onOpenNestedPeek: () => {},
              onOpenNestedCollection: () => {},
              onOpenFullPage: () => {},
              onOpenPath: () => {},
            }}
          />
        </DndContext>,
      ),
    );
  }

  // dnd-kit marks a card it will not let the pointer pick up.
  const draggableStates = () =>
    [...document.querySelectorAll("[aria-roledescription='sortable']")].map(
      (card) => card.getAttribute("aria-disabled"),
    );
  const dropPlaceholder = () =>
    document.querySelector("section .border-dashed.border-primary\\/40");

  test("a card stays draggable with a sort and is locked read-only", async () => {
    await render({ hasSort: true });
    expect(draggableStates()).toEqual(["false", "false"]);
    await render({ hasSort: false });
    expect(draggableStates()).toEqual(["false", "false"]);
    await render({ hasSort: true, readOnly: true });
    expect(draggableStates()).toEqual(["true", "true"]);
  });

  test("with a sort the source column of the dragged card shows no drop target", async () => {
    await render({
      hasSort: true,
      activeEntryPath: "tasks/A.md",
      overGroupKey: "Todo",
    });
    expect(dropPlaceholder()).toBeNull();
  });

  test("with a sort another column under the card shows the drop target", async () => {
    await render({
      hasSort: true,
      activeEntryPath: "tasks/Other.md",
      overGroupKey: "Todo",
    });
    expect(dropPlaceholder() !== null).toBe(true);
  });

  test("without a sort the source column keeps its drop target", async () => {
    await render({
      hasSort: false,
      activeEntryPath: "tasks/A.md",
      overGroupKey: "Todo",
    });
    expect(dropPlaceholder() !== null).toBe(true);
  });
}
