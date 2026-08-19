import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useRoutineCatalog } from "./use-routine-catalog";

const owner = {
  ownerKind: "registered_space" as const,
  ownerPath: "/repo",
  projectPath: "/project",
  spaceId: "root",
  spacePath: "/repo",
};

test("routine invalidation matches the resolved owner before refreshing", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  mockNativeIpc(
    (command) => {
      calls.push(command);
      if (command === "routines_list") return snapshot("one");
      if (command === "routines_refresh") return snapshot("two");
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness />);
      await nextTurn();
      await nextTurn();
    });
    expect(
      dom.window.document.querySelector("[data-fingerprint]")?.textContent,
    ).toBe("one");

    await act(async () => {
      await emitNativeEvent("routines:invalidated", {
        ownerKind: "project",
        ownerPath: "/other",
        projectPath: "/project",
        spacePath: "/repo",
      });
      await emitNativeEvent("agent-actors:invalidated", {
        ownerPath: "/project",
      });
      await waitForDebounce();
    });
    expect(
      calls.filter((command) => command === "routines_refresh").length,
    ).toBe(0);

    await act(async () => {
      await emitNativeEvent("routines:invalidated", {
        ownerKind: "project",
        ownerPath: "/project",
        projectPath: "/project",
        spacePath: "/repo",
      });
      await waitForDebounce();
    });
    expect(
      calls.filter((command) => command === "routines_refresh").length,
    ).toBe(1);
    expect(
      dom.window.document.querySelector("[data-fingerprint]")?.textContent,
    ).toBe("two");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function Harness() {
  const { state } = useRoutineCatalog(owner);
  return (
    <span data-fingerprint>
      {state.phase === "ready"
        ? state.snapshot.catalogFingerprint
        : state.phase}
    </span>
  );
}

function snapshot(catalogFingerprint: string) {
  return {
    catalogFingerprint,
    diagnostics: [],
    owner: { kind: "project", ownerPath: "/project", spaceId: "root" },
    refreshedAt: "2026-08-19T00:00:00.000Z",
    routines: [],
  };
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 160));
}

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
