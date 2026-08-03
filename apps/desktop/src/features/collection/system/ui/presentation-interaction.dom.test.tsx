import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { ContextMenuItem } from "@/components/ui/context-menu";
import type { Entry } from "@/features/entry";

import { CollectionListRowContent } from "../../ui/list/list-row";
import { CollectionPresentationGalleryCard } from "../../ui/presentation-gallery-card";
import { EMPTY_SYSTEM_COLLECTION_QUERY } from "../model/query";
import { defineSystemCollectionPresentation } from "../model/runtime";
import type { SystemCollectionDetailRequest } from "../model/types";
import { SystemCollectionPresentationShell } from "./presentation-shell";

interface Row {
  id: string;
  name: string;
}

test("structured system rows open from the row and keyboard, preserve nested controls, and expose the context menu", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const restoreGlobals = installDomGlobals(dom);
  const requests: SystemCollectionDetailRequest[] = [];
  const presentation = defineSystemCollectionPresentation<Row>({
    descriptor: {
      createDetailRequest: (row) => ({
        content: <div>{row.name} detail</div>,
        description: row.id,
        headerActions: <button type="button">Owner action</button>,
        title: row.name,
      }),
      fields: [],
      getRowId: (row) => row.id,
      id: "people",
      label: "People",
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        renderLeading: () => <button type="button">Nested control</button>,
        visibleFields: [],
      },
      query: {},
      rowActions: [
        {
          getState: () => ({ status: "idle" }),
          id: "edit",
          label: "Edit row",
          run: () => undefined,
        },
      ],
    },
    state: { phase: "ready", rows: [{ id: "ada", name: "Ada" }] },
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <SystemCollectionPresentationShell
          detailController={{
            close: async () => true,
            open: async (request) => {
              requests.push(request);
              return true;
            },
            prepareForNavigation: async () => true,
          }}
          instanceKey="people:test"
          presentation={presentation}
          query={EMPTY_SYSTEM_COLLECTION_QUERY}
          onQueryChange={() => undefined}
        />,
      );
    });

    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-system-collection-row="ada"]',
    )!;
    const title = Array.from(row.querySelectorAll("span")).find(
      (element) => element.textContent === "Ada",
    )!;
    const nested = row.querySelector("button")!;

    expect(row.getAttribute("data-state")).toBe("closed");

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(requests.length).toBe(1);
    const headerActions = renderToStaticMarkup(
      <>{requests[0]?.headerActions}</>,
    );
    expect(headerActions.includes("Owner action")).toBe(true);
    expect(headerActions.includes('aria-label="Row actions"')).toBe(true);
    expect(row.querySelector('[aria-label="Row actions"]')).toBeNull();

    await act(async () => {
      nested.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(requests.length).toBe(1);

    for (const key of ["Enter", " "]) {
      await act(async () => {
        row.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, key }),
        );
      });
    }
    expect(requests.length).toBe(3);

    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 16,
          clientY: 16,
        }),
      );
      await Promise.resolve();
    });
    expect(row.getAttribute("data-state")).toBe("open");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("persisted List keeps entry, nested-control, keyboard, double-open, and context-menu contracts", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const restoreGlobals = installDomGlobals(dom);
  const entry: Entry = {
    body: "",
    meta: {
      created: "2026-08-01T00:00:00Z",
      extra: {},
      icon: null,
      title: "Roadmap",
      updated: "2026-08-01T00:00:00Z",
    },
    path: "plans/roadmap.md",
  };
  const opened: Array<{ nested: boolean; path: string }> = [];
  const moved: Array<{ offset: number; path: string }> = [];
  let nestedOpenCount = 0;
  let fullOpenCount = 0;
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <CollectionListRowContent
          actors={[]}
          cardFields={[]}
          density="compact"
          disabledReorder={false}
          dragAttributes={{}}
          focused={false}
          metaColumns={[]}
          projectPath="/project"
          row={{
            entry,
            expandable: true,
            expanded: false,
            level: 1,
            nestedCollection: true,
          }}
          spacePath="/project"
          onDelete={() => undefined}
          onDuplicate={() => undefined}
          onFocusRow={() => undefined}
          onKeyboardMove={(path, offset) => moved.push({ offset, path })}
          onOpen={(rowEntry, nested) =>
            opened.push({ nested, path: rowEntry.path })
          }
          onOpenFullPage={() => {
            fullOpenCount += 1;
          }}
          onOpenNestedCollection={() => {
            nestedOpenCount += 1;
          }}
          onOpenPath={() => undefined}
          onRequestActors={async () => []}
          onToggle={() => undefined}
          onUpdateField={() => undefined}
        />,
      );
    });

    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-list-row-path="plans/roadmap.md"]',
    )!;
    const title = Array.from(row.querySelectorAll("span")).find(
      (element) => element.textContent === "Roadmap",
    )!;
    const nestedButton = Array.from(
      row.querySelectorAll<HTMLElement>("[data-list-interactive]"),
    ).at(-1)!;

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(opened).toEqual([{ nested: true, path: "plans/roadmap.md" }]);

    await act(async () => {
      nestedButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(nestedOpenCount).toBe(1);
    expect(opened.length).toBe(1);

    await act(async () => {
      row.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
      row.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key: " " }),
      );
      row.dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
    });
    expect(moved).toEqual([{ offset: 1, path: "plans/roadmap.md" }]);
    expect(opened.length).toBe(2);
    expect(fullOpenCount).toBe(1);

    await act(async () => {
      row.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 12,
          clientY: 12,
        }),
      );
      await Promise.resolve();
    });
    expect(row.getAttribute("data-state")).toBe("open");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("shared Gallery card keeps open, nested-control, keyboard, double-open, and context-menu contracts", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const restoreGlobals = installDomGlobals(dom);
  const moved: string[] = [];
  let openCount = 0;
  let doubleOpenCount = 0;
  let nestedCount = 0;
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <CollectionPresentationGalleryCard
          data-gallery-card="shared"
          density="comfortable"
          tabIndex={0}
          title={<span>Shared card</span>}
          description="Structured description"
          leading={
            <button
              type="button"
              onClick={() => {
                nestedCount += 1;
              }}
            >
              Nested control
            </button>
          }
          properties={<span>Owner</span>}
          cover={<div data-gallery-cover />}
          overlays={<div data-gallery-overlay />}
          contextMenu={<ContextMenuItem>Inspect</ContextMenuItem>}
          onDoubleOpen={() => {
            doubleOpenCount += 1;
          }}
          onMoveFocus={(key) => moved.push(key)}
          onOpen={() => {
            openCount += 1;
          }}
        />,
      );
    });

    const card = dom.window.document.querySelector<HTMLElement>(
      '[data-gallery-card="shared"]',
    )!;
    const title = Array.from(card.querySelectorAll("span")).find(
      (element) => element.textContent === "Shared card",
    )!;
    const nested = Array.from(card.querySelectorAll("button")).find(
      (element) => element.textContent === "Nested control",
    )!;

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      nested.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      card.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Home",
        }),
      );
      card.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
      card.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key: " " }),
      );
      card.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
      card.dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
    });

    expect(openCount).toBe(3);
    expect(nestedCount).toBe(1);
    expect(doubleOpenCount).toBe(1);
    expect(moved).toEqual(["Home", "ArrowRight"]);
    expect(Boolean(card.querySelector("[data-gallery-cover]"))).toBe(true);
    expect(Boolean(card.querySelector("[data-gallery-overlay]"))).toBe(true);

    await act(async () => {
      card.dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 12,
          clientY: 12,
        }),
      );
      await Promise.resolve();
    });
    expect(card.getAttribute("data-state")).toBe("open");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
