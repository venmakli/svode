import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SettingsSelectOption } from "./settings-select";

const options: SettingsSelectOption[] = [
  { value: "system", label: "System", description: "Matches your system" },
  { value: "light", label: "Light" },
  {
    value: "dark",
    label: "Dark",
    description: "Unavailable here",
    disabled: true,
  },
  { value: "sepia", label: "Sepia" },
];

if (process.env.SVODE_SETTINGS_SELECT_DOM !== "1") {
  test("rich settings select DOM scenario", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SETTINGS_SELECT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 20000);
} else {
  test("rich select shows only the label in the trigger and descriptions in the list", async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><div id=app></div></body></html>",
      { pretendToBeVisual: true, url: "http://localhost" },
    );
    const restore = installDomGlobals(dom);
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    const { SettingsSelect } = await import("./settings-select");
    const document = dom.window.document;
    const root = createRoot(document.getElementById("app")!);
    const changes: string[] = [];
    const draw = async (pending = false) => {
      await act(async () => {
        root.render(
          <SettingsSelect
            id="theme"
            value="system"
            options={options}
            pending={pending}
            onValueChange={(value) => changes.push(value)}
          />,
        );
        await tick();
      });
    };
    const key = async (target: Element, value: string) => {
      await act(async () => {
        target.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
          }),
        );
        await tick();
      });
    };
    try {
      await draw();
      const trigger = document.querySelector<HTMLElement>('[role="combobox"]')!;
      expect(trigger.id).toBe("theme");
      expect(trigger.textContent).toBe("System");

      await act(async () => {
        trigger.focus();
        await tick();
      });
      await key(trigger, "ArrowDown");
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      expect(items.map((item) => item.textContent)).toEqual([
        "SystemMatches your system",
        "Light",
        "DarkUnavailable here",
        "Sepia",
      ]);
      const checked = document.querySelector(
        '[role="option"][data-state="checked"]',
      );
      expect(checked?.textContent?.startsWith("System")).toBe(true);
      expect(Boolean(checked?.querySelector("svg"))).toBe(true);
      expect(items[2].hasAttribute("data-disabled")).toBe(true);
      expect(trigger.textContent).toBe("System");

      await act(async () => {
        items[3].focus();
        await tick();
      });
      await key(items[3], "Enter");
      expect(changes).toEqual(["sepia"]);

      await draw(true);
      const pendingTrigger =
        document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      expect(pendingTrigger.disabled).toBe(false);
      expect(pendingTrigger.getAttribute("aria-disabled")).toBe("true");
      expect(pendingTrigger.getAttribute("aria-busy")).toBe("true");
      expect(Boolean(pendingTrigger.querySelector(".animate-spin"))).toBe(true);
      await act(async () => {
        pendingTrigger.focus();
        await tick();
      });
      await key(pendingTrigger, "ArrowDown");
      expect(document.querySelectorAll('[role="option"]').length).toBe(0);
      await key(pendingTrigger, "l");
      expect(changes).toEqual(["sepia"]);
      expect(document.activeElement).toBe(pendingTrigger);
    } finally {
      await act(async () => root.unmount());
      restore();
      dom.window.close();
    }
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}
