import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
  type SystemCollectionDetailRequest,
} from "@/features/collection/system";

import type { RoutineRow } from "../model/types";
import {
  createRoutinesPresentation,
  type RoutinePresentationActions,
} from "./routines-presentation";

const scheduled: RoutineRow = {
  definition: {
    action: {
      executor: "agent:01arz3ndektsv4rrffq69g5fav",
      type: "run_agent",
    },
    body: "Review changes.",
    description: "Review the current owner.",
    enabled: false,
    name: "Daily summary",
    trigger: {
      cron: "0 9 * * *",
      missedRuns: "skip",
      timeBasis: { mode: "fixed", timezone: "Asia/Novosibirsk" },
      type: "schedule",
    },
  },
  definitionPath: ".routines/daily-summary.md",
  description: "Review the current owner.",
  diagnostics: [],
  filename: "daily-summary.md",
  fingerprint: "fingerprint:summary",
  id: "routine:summary",
  routineId: "routine:summary",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  nextRunAt: null,
  name: "Daily summary",
  valid: true,
};

test("routine enabled Switch is single-flight and does not open the row", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const detailRequests: SystemCollectionDetailRequest[] = [];
  const updates: Array<{ enabled: boolean; rowId: string }> = [];
  let rejectUpdate!: (reason: Error) => void;
  const updateResult = new Promise<void>((_resolve, reject) => {
    rejectUpdate = reject;
  });
  const actions: RoutinePresentationActions = {
    createState: { status: "idle" },
    getDeleteState: () => ({ status: "idle" }),
    getEditState: () => ({ status: "idle" }),
    getEnabledState: () => ({ status: "idle" }),
    getRunState: () => ({ status: "idle" }),
    onAdd: () => undefined,
    onDelete: () => undefined,
    onEdit: () => undefined,
    onEnabledChange: async (row, enabled) => {
      updates.push({ enabled, rowId: row.id });
      await updateResult;
    },
    onRun: async () => undefined,
  };
  const presentation = createRoutinesPresentation({
    actions,
    createDetailRequest: (row) => ({
      content: row.name,
      description: row.description,
      title: row.name,
    }),
    state: { phase: "ready", rows: [scheduled] },
  });

  try {
    await act(async () => {
      root.render(
        <SystemCollectionPresentationShell
          detailController={{
            close: async () => true,
            open: async (request) => {
              detailRequests.push(request);
              return true;
            },
            prepareForNavigation: async () => true,
          }}
          instanceKey="routines:space:root"
          presentation={presentation}
          query={EMPTY_SYSTEM_COLLECTION_QUERY}
          onQueryChange={() => undefined}
        />,
      );
    });

    const switchControl = dom.window.document.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Enabled: Daily summary"]',
    )!;
    const row = dom.window.document.querySelector<HTMLElement>(
      '[data-system-collection-row="routine:summary"]',
    )!;
    const title = Array.from(row.querySelectorAll("span")).find(
      (element) => element.textContent === "Daily summary",
    )!;

    expect(switchControl.getAttribute("data-size")).toBe("sm");
    expect(switchControl.getAttribute("aria-checked")).toBe("false");
    await act(async () => switchControl.focus());
    expect(dom.window.document.activeElement).toBe(switchControl);

    await act(async () => {
      switchControl.click();
      switchControl.click();
      await Promise.resolve();
    });

    expect(updates).toEqual([{ enabled: true, rowId: "routine:summary" }]);
    expect(detailRequests).toEqual([]);
    expect(switchControl.disabled).toBe(true);
    expect(switchControl.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      rejectUpdate(new Error("save failed"));
      await updateResult.catch(() => undefined);
      await Promise.resolve();
    });

    expect(switchControl.disabled).toBe(false);
    expect(switchControl.getAttribute("aria-checked")).toBe("false");
    expect(dom.window.document.body.textContent?.includes("save failed")).toBe(
      true,
    );

    await act(async () => {
      title.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(detailRequests.length).toBe(1);
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
