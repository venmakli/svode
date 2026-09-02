import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { JSDOM } from "jsdom";

const isolatedDomProcess = process.env.SVODE_LFS_PICKER_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("LFS picker selection DOM scenario", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_LFS_PICKER_DOM_PROCESS: "1",
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
  test("group, item, and custom selections update the visible value", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { createRoot } = await import("react-dom/client");
    const { LfsExtensionPicker } = await import("./lfs-extension-picker");
    const root = createRoot(dom.window.document.getElementById("app")!);

    function Harness() {
      const [value, setValue] = useState("png, blend");
      return (
        <>
          <output id="selection-value">{value}</output>
          <LfsExtensionPicker
            value={value}
            onChange={setValue}
            disabled={false}
            invalid={false}
          />
        </>
      );
    }

    try {
      await act(async () => {
        root.render(<Harness />);
        await nextTurn();
      });

      const imageGroup = getButton(dom, "storage-lfs-group-images");
      expect(imageGroup.dataset.state).toBe("indeterminate");

      await click(dom, imageGroup);
      expect(selectedValues(dom)).toEqual([
        "avif",
        "blend",
        "gif",
        "heic",
        "jpeg",
        "jpg",
        "png",
        "tif",
        "tiff",
        "webp",
      ]);
      expect(imageGroup.dataset.state).toBe("checked");

      await click(dom, getButton(dom, "storage-lfs-group-images-toggle"));
      const png = getButton(dom, "storage-lfs-extension-png");
      expect(png.dataset.state).toBe("checked");

      await click(dom, png);
      expect(selectedValues(dom).includes("png")).toBe(false);
      expect(imageGroup.dataset.state).toBe("indeterminate");

      await click(dom, getButton(dom, "storage-lfs-custom-blend"));
      expect(selectedValues(dom).includes("blend")).toBe(false);
      expect(
        dom.window.document.querySelector("#storage-lfs-custom-blend"),
      ).toBe(null);
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

function getButton(dom: JSDOM, id: string): HTMLButtonElement {
  const button = dom.window.document.querySelector<HTMLButtonElement>(`#${id}`);
  if (!button) throw new Error(`Button #${id} was not rendered`);
  return button;
}

async function click(dom: JSDOM, button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await nextTurn();
  });
}

function selectedValues(dom: JSDOM): string[] {
  return (
    dom.window.document.querySelector("#selection-value")?.textContent ?? ""
  )
    .split(", ")
    .filter(Boolean);
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

function installDomGlobals(dom: JSDOM) {
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
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
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
