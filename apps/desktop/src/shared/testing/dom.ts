import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";

export async function createTestDom() {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const values: Record<string, unknown> = { IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "NodeFilter",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "MutationObserver",
  ] as const) {
    values[key] = dom.window[key];
  }
  values.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  values.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
    dom.window,
  );
  values.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
    dom.window,
  );
  values.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("app")!);
  return {
    document: dom.window.document,
    async render(node: ReactNode) {
      await act(async () => {
        root.render(node);
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}
