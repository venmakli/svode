import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useIdentityStore } from "../model";
import { useIdentityCheck } from "./use-identity-check";

test("reconciles global identity on window invalidation and foreground, then cleans up", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  resetIdentityStore();
  let canonical = identity("Alice", "alice@example.test", "v1");
  let readCount = 0;
  mockNativeIpc(
    (command) => {
      if (command !== "get_git_identity") {
        throw new Error(`Unexpected command: ${command}`);
      }
      readCount += 1;
      return canonical;
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<IdentityOwnerHarness />);
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-identity]")).toBe("Alice");

    canonical = identity("Bob", "bob@example.test", "v2");
    await act(async () => {
      await emitNativeEvent("git-identity:global-changed");
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-identity]")).toBe("Bob");

    canonical = identity("Carol", "carol@example.test", "v3");
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-identity]")).toBe("Carol");

    await act(async () => {
      root.unmount();
      await nextTurn();
    });
    const readsBeforeCleanupCheck = readCount;
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await nextTurn();
    expect(readCount).toBe(readsBeforeCleanupCheck);
  } finally {
    clearNativeMocks();
    resetIdentityStore();
    restoreGlobals();
    dom.window.close();
  }
});

function IdentityOwnerHarness() {
  useIdentityCheck();
  const global = useIdentityStore((state) => state.global);
  return <span data-identity>{global?.name ?? "missing"}</span>;
}

function identity(name: string, email: string, fingerprint: string) {
  return {
    global: { name, email },
    source: "global" as const,
    fingerprint,
  };
}

function resetIdentityStore() {
  useIdentityStore.setState({
    global: null,
    source: "missing",
    fingerprint: "",
    loaded: false,
    loading: false,
    loadError: null,
    requestGeneration: 0,
    refreshVersion: 0,
  });
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
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

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
