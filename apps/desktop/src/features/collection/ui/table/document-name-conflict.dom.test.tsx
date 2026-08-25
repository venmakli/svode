import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { TitleCell } from "./cells";

test("collection title cells show the current path only for external name conflicts", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TitleCell
          row={{
            entry: {
              meta: {
                title: "Shared",
                icon: null,
                created: "",
                updated: "",
                extra: {},
              },
              body: "",
              path: "collection/one.md",
              name_conflict: {
                parentPath: "collection",
                conflicts: [{ path: "collection/two.md", title: "shared" }],
              },
            },
            level: 0,
            child: false,
            nestedCollection: false,
          }}
          showIcon={false}
          expandable={false}
          expanded={false}
          nested={false}
          onToggle={() => undefined}
          onOpen={() => undefined}
          onOpenFullPage={() => undefined}
          onOpenNested={() => undefined}
        />,
      );
    });

    expect(
      dom.window.document.querySelector("[data-entry-name-conflict-path]")
        ?.textContent,
    ).toBe("collection/one.md");
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
