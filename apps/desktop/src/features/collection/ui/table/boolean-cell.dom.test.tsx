import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { PropertyCell } from "./cells";

test("table boolean cell renders missing and conflicts as unchecked without truthy coercion", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <>
          <PropertyCell
            actors={[]}
            pageLabel="Task one"
            column={{ name: "Missing", type: "boolean" }}
            editing={false}
            value={undefined}
            onCancel={() => undefined}
            onCommit={() => undefined}
            onEdit={() => undefined}
            onRequestActors={async () => []}
          />
          <PropertyCell
            readOnly
            actors={[]}
            pageLabel="Task three"
            column={{ name: "Archived", type: "boolean" }}
            editing={false}
            value
            onCancel={() => undefined}
            onCommit={() => undefined}
            onEdit={() => undefined}
            onRequestActors={async () => []}
          />
          <PropertyCell
            actors={[]}
            pageLabel="Task one"
            column={{ name: "Invalid", type: "boolean" }}
            editing={false}
            value="true"
            onCancel={() => undefined}
            onCommit={() => undefined}
            onEdit={() => undefined}
            onRequestActors={async () => []}
          />
          <PropertyCell
            actors={[]}
            pageLabel="Task two"
            column={{ name: "Published", type: "boolean", display: "switch" }}
            editing={false}
            value
            onCancel={() => undefined}
            onCommit={() => undefined}
            onEdit={() => undefined}
            onRequestActors={async () => []}
          />
        </>,
      );
    });

    const missing = dom.window.document.querySelector(
      '[role="checkbox"][aria-label="Missing: Task one"]',
    )!;
    const invalid = dom.window.document.querySelector(
      '[role="checkbox"][aria-label="Invalid: Task one"]',
    )!;
    const switchControl = dom.window.document.querySelector(
      '[role="switch"][aria-label="Published: Task two"]',
    )!;
    expect(missing.getAttribute("aria-checked")).toBe("false");
    expect(missing.getAttribute("aria-invalid")).toBeNull();
    expect(invalid.getAttribute("aria-checked")).toBe("false");
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(switchControl.getAttribute("aria-checked")).toBe("true");
    expect(switchControl.getAttribute("data-size")).toBe("sm");
    expect(
      dom.window.document.querySelector(
        '[role="checkbox"][aria-label="Archived: Task three"]',
      ),
    ).toBeNull();
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
