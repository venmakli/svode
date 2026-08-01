import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
  type SystemCollectionDetailRequest,
} from "@/features/collection/system";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { ActorCatalogRow } from "../model/types";
import { ActorActivityHeatmap } from "./actor-activity-heatmap";
import { createActorsPresentation } from "./actors-presentation";

const actor: ActorCatalogRow = {
  aliases: [],
  canonicalEmail: "ada@example.test",
  commitCount: 4,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: "2026-07-31",
  lastCommitAt: 20,
  sources: [
    {
      email: "ada@example.test",
      kind: "history",
      line: null,
      name: "Ada Lovelace",
    },
  ],
};

test("actors rows open in the real DOM and use shared row and Drawer action seams", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const requests: SystemCollectionDetailRequest[] = [];
  const presentation = createActorsPresentation({
    spacePath: "/repo",
    state: { phase: "ready", rows: [actor] },
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
          instanceKey="actors:space:root"
          presentation={presentation}
          query={EMPTY_SYSTEM_COLLECTION_QUERY}
          onQueryChange={() => undefined}
        />,
      );
    });

    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-system-collection-row="ada@example.test"]',
    )!;
    const title = Array.from(row.querySelectorAll("span")).find(
      (element) => element.textContent === "Ada Lovelace",
    )!;

    expect(row === null).toBe(false);
    expect(row.querySelector('[aria-label="Row actions"]')).toBeNull();

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(requests.length).toBe(1);

    const drawerActions = renderToStaticMarkup(
      <>{requests[0]?.headerActions}</>,
    );
    expect(drawerActions.includes('aria-label="Row actions"')).toBe(true);

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

test("actor detail loads the calendar heatmap lazily and keeps exact zero-day tooltips", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const calls: Array<{ args: unknown; command: string }> = [];
  mockNativeIpc((command, args) => {
    calls.push({ args: args ?? {}, command });
    if (command !== "actors_get_activity") {
      throw new Error(`Unexpected command: ${command}`);
    }
    return {
      canonicalEmail: "ada@example.test",
      days: [{ commitCount: 4, date: "2026-08-01" }],
      generation: 2,
      rangeEndExclusive: "2026-08-02",
        rangeStart: "2025-08-01",
      repositoryId: "actor-repo-test",
    };
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    expect(calls.length).toBe(0);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorActivityHeatmap
            canonicalEmail="ada@example.test"
            spacePath="/repo"
          />
        </TooltipProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(calls).toEqual([
      {
        args: {
          canonicalEmail: "ada@example.test",
          spacePath: "/repo",
        },
        command: "actors_get_activity",
      },
    ]);
    expect(
      dom.window.document.querySelector(
        '[data-activity-date="2026-08-01"][data-activity-count="4"]',
      ) === null,
    ).toBe(false);
    const heatmap = dom.window.document.querySelector(
      "[data-actor-activity-heatmap]",
    ) as HTMLElement | null;
    expect(heatmap?.dataset.activityWeeks).toBe("53");
    expect(heatmap?.style.gridTemplateColumns).toBe(
      "repeat(53, minmax(0, 1fr))",
    );
    expect(
      dom.window.document
        .querySelector('[data-activity-date="2026-07-30"]')
        ?.getAttribute("data-slot"),
    ).toBe("tooltip-trigger");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
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
