import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { PropertyControl } from "./property-control";
import { PropertyValue } from "./property-value";

test("boolean controls render effective false and never coerce conflicts to checked", async () => {
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
          <PropertyControl
            column={{ name: "Missing", type: "boolean" }}
            value={undefined}
            onChange={(value) => {
              changes.push(value);
            }}
          />
          <PropertyControl
            column={{ name: "Invalid", type: "boolean" }}
            value="false"
            invalid
            onChange={(value) => {
              changes.push(value);
            }}
          />
          <PropertyControl
            column={{ name: "True", type: "boolean" }}
            value
            onChange={(value) => {
              changes.push(value);
            }}
          />
          <PropertyControl
            accessibilityLabel="Published: Task one"
            column={{ name: "Published", type: "boolean", display: "switch" }}
            density="compact"
            value={false}
            onChange={(value) => {
              changes.push(value);
            }}
          />
        </>,
      );
    });

    const missing = dom.window.document.querySelector<HTMLElement>(
      '[role="checkbox"][aria-label="Missing"]',
    )!;
    const invalid = dom.window.document.querySelector<HTMLElement>(
      '[role="checkbox"][aria-label="Invalid"]',
    )!;
    const truthy = dom.window.document.querySelector<HTMLElement>(
      '[role="checkbox"][aria-label="True"]',
    )!;
    const switchControl = dom.window.document.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Published: Task one"]',
    )!;

    expect(missing.getAttribute("aria-checked")).toBe("false");
    expect(invalid.getAttribute("aria-checked")).toBe("false");
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(truthy.getAttribute("aria-checked")).toBe("true");
    expect(switchControl.tagName).toBe("BUTTON");
    expect(switchControl.getAttribute("data-size")).toBe("sm");
    expect(switchControl.getAttribute("aria-checked")).toBe("false");

    switchControl.focus();
    expect(dom.window.document.activeElement).toBe(switchControl);

    await act(async () => missing.click());
    await act(async () => switchControl.click());
    expect(changes).toEqual([true, true]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("passive boolean values distinguish false from a visible type conflict", async () => {
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
          <PropertyValue
            column={{ name: "Missing", type: "boolean" }}
            value={undefined}
          />
          <PropertyValue
            column={{ name: "Invalid", type: "boolean" }}
            value="false"
          />
          <PropertyValue
            column={{ name: "Published", type: "boolean", display: "switch" }}
            value
          />
        </>,
      );
    });

    const indicator = dom.window.document.querySelector(
      '[data-property-boolean-value="false"]',
    )!;
    expect(indicator.getAttribute("role")).toBe("img");
    expect(Boolean(indicator.getAttribute("aria-label"))).toBe(true);
    expect(indicator.getAttribute("data-property-boolean-display")).toBe(
      "checkbox",
    );
    const passiveSwitch = dom.window.document.querySelector<HTMLElement>(
      '[data-property-boolean-display="switch"]',
    )!;
    expect(passiveSwitch.getAttribute("role")).toBe("img");
    expect(passiveSwitch.getAttribute("tabindex")).toBeNull();
    expect(Boolean(passiveSwitch.getAttribute("aria-label"))).toBe(true);
    expect(dom.window.document.body.textContent?.includes("false")).toBe(true);
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
