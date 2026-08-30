import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { useCollectionKeyboardShortcuts } from "./use-collection-keyboard-shortcuts";

test("read-only collection shortcuts keep navigation and block mutations", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness calls={calls} />);
    });

    dispatchShortcut(dom, "ArrowRight");
    dispatchShortcut(dom, "ArrowRight", true);
    dispatchShortcut(dom, "n");
    dispatchShortcut(dom, "n", true);

    expect(calls).toEqual(["select:second"]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({ calls }: { calls: string[] }) {
  useCollectionKeyboardShortcuts({
    activeTab: "first",
    views: [
      { name: "first", type: "table" },
      { name: "second", type: "table" },
    ],
    selectTab: (next) => calls.push(`select:${next}`),
    moveActive: async (offset) => {
      calls.push(`move:${offset}`);
    },
    focusActiveViewCreate: (asFolder) => {
      calls.push(`focus-create:${asFolder}`);
      return false;
    },
    createEntry: async (asFolder) => {
      calls.push(`create:${Boolean(asFolder)}`);
      return {
        body: "",
        meta: {
          created: "",
          extra: {},
          icon: null,
          title: "New",
          updated: "",
        },
        path: "new.md",
      };
    },
    readOnly: true,
  });
  return null;
}

function dispatchShortcut(dom: JSDOM, key: string, shiftKey = false) {
  act(() => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key,
        shiftKey,
      }),
    );
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
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
