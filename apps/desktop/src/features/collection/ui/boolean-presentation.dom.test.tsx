import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Page } from "@/features/page";
import type { Column } from "@/features/properties";
import { BoardPropertyFlow } from "./board/board-property-flow";
import { CardPropertyFlow } from "./card-property-flow";

const entry: Page = {
  body: "",
  meta: {
    created: "2026-08-22T00:00:00Z",
    extra: { Published: false },
    icon: null,
    title: "Task one",
    updated: "2026-08-22T00:00:00Z",
  },
  path: "tasks/task-one.md",
};

const column: Column = {
  name: "Published",
  type: "boolean",
  display: "switch",
};

test("card and board share switch presentation while preserving editability ownership", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const changes: unknown[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <>
          <CardPropertyFlow
            actors={[]}
            columns={[column]}
            entry={entry}
            onRequestActors={async () => []}
            onUpdateField={(_entry, _column, value) => changes.push(value)}
          />
          <BoardPropertyFlow
            actors={[]}
            columns={[column]}
            entry={entry}
            onRequestActors={async () => []}
            onUpdateField={(_entry, _column, value) => changes.push(value)}
          />
        </>,
      );
    });

    const editable = dom.window.document.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Published: Task one"]',
    )!;
    const passive = dom.window.document.querySelector<HTMLElement>(
      '[data-property-boolean-display="switch"][role="img"]',
    )!;

    expect(editable.getAttribute("aria-checked")).toBe("false");
    expect(passive.getAttribute("data-property-boolean-value")).toBe("false");
    expect(passive.getAttribute("tabindex")).toBeNull();

    await act(async () => editable.click());
    expect(changes).toEqual([true]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
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
