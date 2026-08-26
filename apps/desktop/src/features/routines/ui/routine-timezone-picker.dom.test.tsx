import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { JSDOM } from "jsdom";

import type { RoutineTimeBasis } from "../model/types";

const isolatedDomProcess =
  process.env.SVODE_ROUTINE_TIMEZONE_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("timezone combobox DOM scenario", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_ROUTINE_TIMEZONE_DOM_PROCESS: "1",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  test("input opens, filters, selects, and keeps focus after Escape", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.window.document.getElementById("app")!);
    const { RoutineTimezonePicker } = await import("./routine-timezone-picker");
    let selected: RoutineTimeBasis = { mode: "local" };

    function Harness() {
      const [value, setValue] = useState<RoutineTimeBasis>(selected);
      return (
        <RoutineTimezonePicker
          id="routine-timezone"
          invalid={false}
          value={value}
          onChange={(nextValue) => {
            selected = nextValue;
            setValue(nextValue);
          }}
        />
      );
    }

    try {
      await act(async () => {
        root.render(<Harness />);
        await nextTurn();
      });
      const input =
        dom.window.document.querySelector<HTMLInputElement>(
          "#routine-timezone",
        )!;
      expect(input.value).toBe("Local time");
      expect(input.getAttribute("role")).toBe("combobox");

      await act(async () => {
        input.focus();
        input.dispatchEvent(
          new dom.window.MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
          }),
        );
        await nextFrame(dom);
      });
      expect(input.getAttribute("aria-expanded")).toBe("true");

      await act(async () => {
        setNativeInputValue(input, "tokyo");
        input.dispatchEvent(
          new dom.window.InputEvent("input", {
            bubbles: true,
            cancelable: true,
            data: "tokyo",
            inputType: "insertText",
          }),
        );
        await nextFrame(dom);
      });
      const popup = dom.window.document.querySelector<HTMLElement>(
        '[data-slot="combobox-content"]',
      )!;
      expect(popup.textContent?.includes("Tokyo — GMT+09:00")).toBe(true);
      expect(popup.textContent?.includes("New York")).toBe(false);

      await act(async () => {
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
          }),
        );
        await nextFrame(dom);
      });
      expect(selected).toEqual({ mode: "fixed", timezone: "Asia/Tokyo" });
      expect(input.value).toBe("Tokyo — GMT+09:00");

      await act(async () => {
        input.dispatchEvent(
          new dom.window.MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
          }),
        );
        await nextFrame(dom);
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextFrame(dom);
      });
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(dom.window.document.activeElement).toBe(input);
    } finally {
      await act(async () => {
        root.unmount();
        await nextTurn();
      });
      restoreGlobals();
      dom.window.close();
    }
  });
}

function createDom() {
  return new JSDOM(
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function nextFrame(dom: JSDOM) {
  await nextTurn();
  await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input.ownerDocument.defaultView!.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => undefined,
      matches: false,
      removeEventListener: () => undefined,
    }),
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
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
