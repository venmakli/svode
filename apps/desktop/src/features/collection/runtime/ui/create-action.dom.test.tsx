import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionStateController } from "../hooks/use-collection-state";
import type { CollectionCreateIntent } from "../model/types";

// The toast mock must not reach other test files of the process.
const isolated = process.env.SVODE_COLLECTION_CREATE_ACTION_DOM === "1";
if (!isolated) {
  test("collection create control DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_CREATE_ACTION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
}
const domTest = (isolated ? test : () => undefined) as typeof test;

const toastErrors: string[] = [];
const dom = new JSDOM("<!doctype html><div id='app'></div>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
if (isolated) {
  installDomGlobals(dom);
  const realSonner = await import("sonner");
  bunTest.mock.module("sonner", () => ({
    ...realSonner,
    toast: Object.assign(() => undefined, realSonner.toast, {
      error: (message: string) => {
        toastErrors.push(message);
      },
    }),
  }));
}

interface Item {
  id: string;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function renderHost(intents: CollectionCreateIntent[]) {
  const { CollectionHost } = await import("../../ui/collection-host");
  const { defineCollectionPresentation } = await import("../model/runtime");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const presentation = defineCollectionPresentation<Item>({
    descriptor: {
      create: { label: "Add", intents },
      getItemId: (item) => item.id,
      id: "all",
      label: "All",
      layout: {
        getTitle: (item) => item.id,
        kind: "list",
        visibleProperties: [],
      },
      properties: [],
      query: {},
    },
    state: { phase: "ready", items: [] },
  });
  const state: Extract<CollectionStateController, { phase: "ready" }> = {
    activePresentationId: "all",
    dismissResetWarning: () => undefined,
    phase: "ready",
    query: { filters: [], search: "", sort: [] },
    queryByPresentationId: {},
    resetWarning: false,
    setActivePresentationId: () => undefined,
    setQuery: () => undefined,
  };
  const container = document.getElementById("app")!;
  const root = createRoot(container);
  await act(async () => {
    // No onInteractionError: the control itself shows a refusal.
    root.render(
      <TooltipProvider>
        <CollectionHost
          instance={{
            defaultPresentationId: "all",
            instanceKey: "create:test",
            presentations: [presentation],
            stateScope: "session",
          }}
          state={state}
        />
      </TooltipProvider>,
    );
  });
  return root;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

function menuTrigger() {
  const trigger = document.querySelector<HTMLButtonElement>(
    "[data-collection-create-menu]",
  );
  if (!trigger) throw new Error("no create menu trigger");
  return trigger;
}

async function selectFromMenu(intentId: string) {
  const trigger = menuTrigger();
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    );
  });
  await settle();
  const item = document.querySelector<HTMLElement>(
    `[role="menuitem"][data-collection-create="${intentId}"]`,
  );
  if (!item) throw new Error(`no menu item ${intentId}`);
  await act(async () => {
    item.click();
  });
  await settle();
}

const idle = () => ({ status: "idle" as const });

domTest(
  "an intent chosen from the menu shows its progress on the trigger and its refusal as a toast",
  async () => {
    const run = deferred();
    const root = await renderHost([
      { getState: idle, id: "new-page", label: "New page", run: () => {} },
      {
        getState: idle,
        id: "import-file",
        label: "Add file…",
        run: () => run.promise,
      },
    ]);
    try {
      expect(menuTrigger().disabled).toBe(false);
      await selectFromMenu("import-file");

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(menuTrigger().disabled).toBe(true);
      expect(menuTrigger().getAttribute("aria-busy")).toBe("true");
      expect(menuTrigger().getAttribute("data-collection-create-state")).toBe(
        "pending",
      );
      expect(menuTrigger().querySelector(".animate-spin")).not.toBeNull();

      await act(async () => {
        run.reject(new Error("File not added: Git LFS is not ready"));
      });
      await settle();

      expect(toastErrors).toEqual(["File not added: Git LFS is not ready"]);
      expect(menuTrigger().disabled).toBe(false);
      expect(menuTrigger().getAttribute("data-collection-create-state")).toBe(
        "idle",
      );
      expect(menuTrigger().querySelector(".animate-spin")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      toastErrors.length = 0;
    }
  },
);

domTest(
  "a single intent refused by a host without onInteractionError is shown as a toast",
  async () => {
    const run = deferred();
    const root = await renderHost([
      {
        getState: idle,
        id: "add-routine",
        label: "Add",
        run: () => run.promise,
      },
    ]);
    const button = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-collection-create="add-routine"]',
      )!;
    try {
      await act(async () => {
        button().click();
      });
      expect(button().disabled).toBe(true);
      expect(button().getAttribute("data-collection-create-state")).toBe(
        "pending",
      );

      await act(async () => {
        run.reject("a refusal that is not an Error");
      });
      await settle();

      expect(toastErrors).toEqual(["The action failed."]);
      expect(button().disabled).toBe(false);
      expect(button().getAttribute("data-collection-create-state")).toBe(
        "idle",
      );
    } finally {
      await act(async () => root.unmount());
      toastErrors.length = 0;
    }
  },
);

domTest("a successful intent shows no toast", async () => {
  const root = await renderHost([
    { getState: idle, id: "new-page", label: "New page", run: () => {} },
    {
      getState: idle,
      id: "import-file",
      label: "Add file…",
      run: async () => {},
    },
  ]);
  try {
    await selectFromMenu("new-page");
    expect(toastErrors).toEqual([]);
    expect(menuTrigger().disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

function installDomGlobals(window: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: window.window.cancelAnimationFrame.bind(
      window.window,
    ),
    CustomEvent: window.window.CustomEvent,
    DocumentFragment: window.window.DocumentFragment,
    DOMRect: window.window.DOMRect,
    Element: window.window.Element,
    Event: window.window.Event,
    FocusEvent: window.window.FocusEvent,
    HTMLElement: window.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: window.window.KeyboardEvent,
    MouseEvent: window.window.MouseEvent,
    MutationObserver: window.window.MutationObserver,
    Node: window.window.Node,
    NodeFilter: window.window.NodeFilter,
    PointerEvent: window.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: window.window.document,
    getComputedStyle: window.window.getComputedStyle.bind(window.window),
    navigator: window.window.navigator,
    requestAnimationFrame: window.window.requestAnimationFrame.bind(
      window.window,
    ),
    window: window.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
