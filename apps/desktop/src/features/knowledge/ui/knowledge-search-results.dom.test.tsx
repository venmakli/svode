import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
import type { KnowledgeSearchItem } from "../model/types";
import { KnowledgeCommandResults } from "./knowledge-search-results";

const items: KnowledgeSearchItem[] = [
  {
    nodeId: "node-1",
    source: { kind: "document", path: "design.md", spaceId: null },
    spaceName: "Project",
    title: "Design",
    snippet: null,
    locationPath: "design.md",
    lineStart: null,
    lineEnd: null,
  },
  {
    nodeId: "node-2",
    source: { kind: "document", path: "review.md", spaceId: null },
    spaceName: "Project",
    title: "Review",
    snippet: null,
    locationPath: "review.md",
    lineStart: null,
    lineEnd: null,
  },
];

test("Command owns keyboard navigation and pointer-active result projection", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  try {
    await act(async () => {
      root.render(<ResultsHarness />);
      await nextTurn();
    });
    const input = dom.window.document.querySelector<HTMLInputElement>(
      '[data-slot="command-input"]',
    )!;
    input.focus();
    expect(textOf(dom, "[data-active-result]")).toBe("node-1");
    await pressKey(input, "ArrowDown", dom);
    expect(textOf(dom, "[data-active-result]")).toBe("node-2");
    await pressKey(input, "Enter", dom);
    expect(textOf(dom, "[data-opened-result]")).toBe("node-2");

    const secondItem = dom.window.document.querySelectorAll<HTMLElement>(
      '[data-slot="command-item"]',
    )[1];
    await act(async () => {
      secondItem.dispatchEvent(
        new dom.window.MouseEvent("pointermove", { bubbles: true }),
      );
      await nextTurn();
    });
    expect(textOf(dom, "[data-active-result]")).toBe("node-2");
  } finally {
    await act(async () => {
      root.unmount();
      await nextTurn();
    });
    restoreGlobals();
    dom.window.close();
  }
});

function ResultsHarness() {
  const [activeResult, setActiveResult] = useState("");
  const [openedResult, setOpenedResult] = useState("");
  return (
    <>
      <span data-active-result>{activeResult}</span>
      <span data-opened-result>{openedResult}</span>
      <Command
        shouldFilter={false}
        value={activeResult}
        onValueChange={setActiveResult}
        loop
      >
        <CommandInput aria-label="Search" />
        <CommandList>
          <KnowledgeCommandResults
            items={items}
            loading={false}
            onActiveChange={setActiveResult}
            onOpen={(item) => setOpenedResult(item.nodeId)}
          />
        </CommandList>
      </Command>
    </>
  );
}

async function pressKey(element: Element, key: string, dom: JSDOM) {
  await act(async () => {
    element.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }),
    );
    await nextTurn();
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
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
