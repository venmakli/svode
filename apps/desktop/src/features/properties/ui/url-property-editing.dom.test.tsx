import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { JSDOM } from "jsdom";

// A link edited in the property panel (Stage 11 `04`, 4.F п. 2): leaving a
// changed field saves it, Escape in the field or in its popover puts the
// saved link back without saving.
if (process.env.SVODE_URL_PROPERTY_EDITING_DOM !== "1") {
  test("link property editing DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_URL_PROPERTY_EDITING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  // Radix picks its layout effect by the presence of `document` at import.
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { defineOwnerDefinedCollectionProperty } =
    await import("../model/collection-property");
  const { CollectionPropertyPanel } =
    await import("./collection-property-panel");
  const document = dom.window.document;

  interface Item {
    link: { href: string; title: string } | null;
  }
  const saved: Item = {
    link: { href: "https://svode.app", title: "Svode" },
  };

  async function mount() {
    const writes: unknown[] = [];
    function Harness() {
      const [item, setItem] = useState(saved);
      return (
        <CollectionPropertyPanel
          item={item}
          properties={[
            defineOwnerDefinedCollectionProperty<Item>({
              capabilities: {
                edit: {
                  getState: () => ({ status: "idle" }),
                  update: async (_item, value) => {
                    writes.push(value);
                    setItem({ link: value as Item["link"] });
                  },
                },
              },
              featureId: "test",
              getValue: (current) => current.link,
              key: "link",
              label: "Link",
              standard: { type: "url" },
            }),
          ]}
        />
      );
    }
    const root = createRoot(document.getElementById("app")!);
    await act(async () => root.render(<Harness />));
    return { root, writes };
  }

  const settle = () =>
    new Promise<void>((resolve) =>
      dom.window.setTimeout(
        () => dom.window.requestAnimationFrame(() => resolve()),
        0,
      ),
    );

  function inlineField() {
    return document.querySelector<HTMLInputElement>(
      '[data-collection-property-editor="link"] input',
    )!;
  }

  function popoverFields() {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[data-slot="popover-content"] input',
      ),
    );
  }

  async function type(target: HTMLInputElement, value: string) {
    await act(async () => {
      target.focus();
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await settle();
    });
  }

  async function key(target: Element, name: string) {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key: name }),
      );
      await settle();
    });
  }

  async function blur(target: HTMLInputElement) {
    await act(async () => {
      target.blur();
      await settle();
    });
  }

  test("Escape in the field puts the saved link back and leaving it then saves nothing", async () => {
    const { root, writes } = await mount();
    try {
      await type(inlineField(), "https://other.example");
      await key(inlineField(), "Escape");
      await blur(inlineField());
      expect(inlineField().value).toBe("https://svode.app");
      expect(writes).toEqual([]);

      // Leaving the field unchanged saves nothing either.
      await act(async () => {
        inlineField().focus();
        await settle();
      });
      await blur(inlineField());
      expect(writes).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("Escape in the popover drops the edited text; a changed link saves on leaving its field", async () => {
    const { root, writes } = await mount();
    try {
      await act(async () => {
        inlineField().parentElement!.click();
        await settle();
      });
      const [, text] = popoverFields();
      expect(text?.value).toBe("Svode");
      await type(text!, "Other title");
      await key(text!, "Escape");
      await blur(text!);
      expect(writes).toEqual([]);
      expect(inlineField().value).toBe("https://svode.app");

      await act(async () => {
        if (popoverFields().length === 0) inlineField().parentElement!.click();
        await settle();
      });
      const [, again] = popoverFields();
      expect(again?.value).toBe("Svode");
      await type(again!, "Svode site");
      await blur(again!);
      expect(writes).toEqual([
        { href: "https://svode.app", title: "Svode site" },
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
  ]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, method, {
      configurable: true,
      value: () => false,
    });
  }
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
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
