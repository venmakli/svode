import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("ready App actions explain every icon and show a tooltip on hover", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const [{ TooltipProvider }, { ReadyAppViewport }] = await Promise.all([
    import("@/components/ui/tooltip"),
    import("./ready-app-viewport"),
  ]);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <ReadyAppViewport
            session={{
              status: "ready",
              ownerDirectory: "/repo/process-app",
              runtimeType: "process",
              viewportUrl: "http://127.0.0.1:43000",
              process: {
                managed: true,
                hasSetup: true,
                logs: { stdout: "ready", stderr: "" },
              },
            }}
            onRestart={() => undefined}
            onStop={() => undefined}
            onRerunSetup={() => undefined}
            onShowFiles={() => undefined}
            onOpenBrowser={() => undefined}
          />
        </TooltipProvider>,
      );
      await nextTurn();
    });

    const iframe = dom.window.document.querySelector("iframe")!;
    await act(async () => {
      iframe.dispatchEvent(new dom.window.Event("load", { bubbles: true }));
      await nextTurn();
    });

    const actionLabels = [
      "Logs",
      "Show files",
      "Open in browser",
      "Reload page",
      "Stop process",
      "Restart process",
    ];
    expect(
      Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          "button[aria-label]",
        ),
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(actionLabels);
    for (const label of actionLabels) {
      const button = dom.window.document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
      expect(button === null).toBe(false);
      expect(button?.matches('[data-slot="tooltip-trigger"]')).toBe(true);
    }

    const reloadButton = dom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Reload page"]',
    )!;
    await act(async () => {
      reloadButton.dispatchEvent(
        new dom.window.MouseEvent("pointermove", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(reloadButton.getAttribute("aria-describedby") !== null).toBe(true);
    expect(
      dom.window.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Restart process"]',
      )?.dataset.variant,
    ).toBe("destructive");
  } finally {
    await act(async () => {
      root.unmount();
      await nextTurn();
    });
    restoreGlobals();
    dom.window.close();
  }
});

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
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
