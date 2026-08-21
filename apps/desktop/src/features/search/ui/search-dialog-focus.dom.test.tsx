import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const isolatedDomProcess = process.env.SVODE_SEARCH_FOCUS_DOM_PROCESS === "1";

if (!isolatedDomProcess) {
  test("Search dialog focus DOM scenario", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_SEARCH_FOCUS_DOM_PROCESS: "1",
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
  test("focus enters Search and returns to its trigger after Escape", async () => {
    const dom = createDom();
    const restoreGlobals = installDomGlobals(dom);
    const trigger =
      dom.window.document.querySelector<HTMLButtonElement>("#trigger")!;
    trigger.focus();
    const root = createRoot(dom.window.document.getElementById("app")!);
    const { CommandInput, CommandList } =
      await import("@/components/ui/command");
    const { SearchDialog } = await import("./search-dialog");
    const { SearchDialogShell } = await import("./search-dialog-shell");
    const FocusHarness = () => {
      const [open, setOpen] = useState(true);
      return (
        <SearchDialog
          open={open}
          onOpenChange={setOpen}
          title="Search"
          description="Search project knowledge"
        >
          <SearchDialogShell
            sidebarLabel="Search navigation"
            commandValue=""
            onCommandValueChange={() => undefined}
            searchInput={<CommandInput autoFocus aria-label="Search" />}
            scopeControls={<button type="button">Entire project</button>}
            readingContent={<CommandList />}
            status={<div>Fresh</div>}
            breadcrumb={<div>Entire project / Graph</div>}
            openGraphAction={<button type="button">Open Graph</button>}
            graph={<div>Graph</div>}
            resetAction={<button type="button">Reset graph</button>}
          />
        </SearchDialog>
      );
    };
    try {
      await act(async () => {
        root.render(<FocusHarness />);
        await nextTurn();
        await new Promise((resolve) =>
          dom.window.requestAnimationFrame(resolve),
        );
      });
      const input = dom.window.document.querySelector<HTMLInputElement>(
        '[data-slot="command-input"]',
      )!;
      const dialog = dom.window.document.querySelector<HTMLElement>(
        '[data-slot="dialog-content"]',
      )!;
      expect(dom.window.document.activeElement).toBe(input);
      expect(dialog.className.includes("lg:max-w-[800px]")).toBe(true);
      expect(dialog.className.includes("md:max-w-[700px]")).toBe(true);
      expect(dialog.className.includes("h-[min(480px,calc(100vh-2rem))]")).toBe(
        true,
      );
      expect(dialog.className.includes("w-[calc(100vw-2rem)]")).toBe(true);
      expect(dialog.className.includes("overflow-hidden")).toBe(true);

      await act(async () => {
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
        await nextTurn();
        await new Promise((resolve) =>
          dom.window.requestAnimationFrame(resolve),
        );
      });
      expect(
        dom.window.document.querySelector('[data-slot="dialog-content"]'),
      ).toBeNull();
      expect(dom.window.document.activeElement).toBe(trigger);
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
    '<!doctype html><html><body><button id="trigger" type="button">Search</button><div id="app"></div></body></html>',
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
