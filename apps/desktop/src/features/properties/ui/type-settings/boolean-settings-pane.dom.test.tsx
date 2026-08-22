import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { BooleanSettingsPane } from "./boolean-settings-pane";

test("boolean settings expose the localized display select and disable it while saving", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <BooleanSettingsPane
          column={{ name: "Published", type: "boolean", display: "switch" }}
          pending={false}
          onPatchColumn={async () => undefined}
        />,
      );
    });

    const trigger =
      dom.window.document.querySelector<HTMLElement>('[role="combobox"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(dom.window.document.body.textContent?.includes("Display")).toBe(
      true,
    );

    await act(async () => {
      root.render(
        <BooleanSettingsPane
          column={{ name: "Published", type: "boolean", display: "switch" }}
          pending
          onPatchColumn={async () => undefined}
        />,
      );
    });
    expect(
      dom.window.document
        .querySelector<HTMLElement>('[role="combobox"]')!
        .hasAttribute("disabled"),
    ).toBe(true);
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
