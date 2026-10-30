import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TemplateInfo } from "../model";

const isolatedProcess = process.env.SVODE_TEMPLATES_MENU_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("templates menu DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TEMPLATES_MENU_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // Radix picks its layout effect by the presence of `document` at import.
  installDomGlobals(createDom());
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;
  mock.module("sonner", () => ({
    toast: {
      error: () => undefined,
      success: () => undefined,
      warning: () => undefined,
    },
  }));

  const { TemplatesSplitButton } = await import("./templates-menu");
  const m = await import("@/paraglide/messages.js");

  test("empty template list and its loading line are icon-free menu rows", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const root = createRoot(dom.window.document.getElementById("app")!);
    let resolveTemplates: (templates: TemplateInfo[]) => void = () => {};
    const noop = async () => undefined;

    try {
      await act(async () => {
        root.render(
          <TemplatesSplitButton
            schema={{ columns: [] }}
            onPrimaryCreate={() => undefined}
            onLoadTemplates={() =>
              new Promise<TemplateInfo[]>((resolve) => {
                resolveTemplates = resolve;
              })
            }
            onCreateTemplate={noop}
            onInstantiateTemplate={noop}
            onEditTemplate={noop}
            onSetDefaultTemplate={noop}
            onDuplicateTemplate={noop}
            onDeleteTemplate={noop}
            onReorderTemplates={noop}
          />,
        );
        await nextFrame(dom);
      });
      const document = dom.window.document;
      await act(async () => {
        document
          .querySelector<HTMLElement>(
            `button[aria-label="${m.collection_templates()}"]`,
          )!
          .click();
        await nextFrame(dom);
      });

      const popover = () =>
        document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
      const lineWithText = (text: string) =>
        Array.from(popover().querySelectorAll<HTMLElement>("div")).find(
          (element) => element.textContent === text,
        )!;
      const newTemplateRow = Array.from(
        popover().querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === m.collection_new_template())!;
      const textSize = (element: HTMLElement) =>
        element.className
          .split(/\s+/)
          .filter((name) => name.startsWith("text-["));

      const loading = lineWithText(m.collection_templates_loading());
      expect(loading.querySelector("svg")).toBeNull();
      expect(textSize(loading)).toEqual(textSize(newTemplateRow));
      expect(loading.tabIndex).toBe(-1);

      await act(async () => {
        resolveTemplates([]);
        await nextFrame(dom);
      });

      const empty = lineWithText(m.collection_templates_empty());
      expect(empty.querySelector("svg")).toBeNull();
      expect(textSize(empty)).toEqual(textSize(newTemplateRow));
      expect(empty.tabIndex).toBe(-1);
      expect(empty.className).toBe(loading.className);
    } finally {
      await act(async () => {
        root.unmount();
        await nextFrame(dom);
      });
      restoreGlobals();
      dom.window.close();
    }
  });
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function nextFrame(dom: JSDOM) {
  return new Promise<void>((resolve) => {
    dom.window.setTimeout(
      () => dom.window.requestAnimationFrame(() => resolve()),
      0,
    );
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    localStorage: dom.window.localStorage,
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
