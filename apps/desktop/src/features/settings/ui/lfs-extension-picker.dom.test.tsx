import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

const isolatedDomProcess = process.env.SVODE_LFS_PICKER_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("LFS picker wheel ownership DOM scenario", () => {
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
  test("wheel scroll stays in the portaled LFS list", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const { createRoot } = await import("react-dom/client");
    const { LfsExtensionPicker } = await import("./lfs-extension-picker");
    const root = createRoot(dom.window.document.getElementById("app")!);

    try {
      await act(async () => {
        root.render(
          <LfsExtensionPicker
            value="png, jpg, jpeg, gif, webp, avif, heic, tif, tiff, psd, ai, sketch, mp3, wav, flac, m4a, ogg, mp4, mov, m4v, webm, avi, mkv, pdf, doc, docx, ppt, pptx, xls, xlsx, zip, 7z, rar"
            onChange={() => undefined}
            disabled={false}
            invalid={false}
          />,
        );
        await nextTurn();
      });
      const input = dom.window.document.querySelector<HTMLInputElement>(
        "#storage-lfs-extensions",
      )!;

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

      const list = dom.window.document.querySelector<HTMLDivElement>(
        '[data-slot="combobox-list"]',
      )!;
      let escapedWheelEvents = 0;
      const recordEscapedWheel = () => {
        escapedWheelEvents += 1;
      };
      dom.window.document.addEventListener("wheel", recordEscapedWheel);
      const wheel = new dom.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });

      list.dispatchEvent(wheel);

      expect(list.scrollTop).toBe(80);
      expect(wheel.defaultPrevented).toBe(true);
      expect(escapedWheelEvents).toBe(0);
      dom.window.document.removeEventListener("wheel", recordEscapedWheel);
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
    HTMLDivElement: dom.window.HTMLDivElement,
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
    WheelEvent: dom.window.WheelEvent,
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
