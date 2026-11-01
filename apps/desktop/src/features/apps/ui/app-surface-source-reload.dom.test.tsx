import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { APP_SOURCE_RELOAD_DELAY_MS } from "../hooks/use-app-source-reload";

test("a series of changes in the static App source reloads its iframe once without loading", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const commands: string[] = [];
  mockNativeIpc(
    (command, args) => {
      commands.push(command);
      if (command === "app_manifest_inspect") {
        return {
          status: "ready",
          ownerDirectory: "/repo/space/graph",
          runtimeType: "static",
          viewportUrl: "http://127.0.0.1:42001/graph.html",
          capabilityToken: "token-graph",
        };
      }
      if (command === "app_source_revoke") {
        expect((args as { capabilityToken: string }).capabilityToken).toBe(
          "token-graph",
        );
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const [{ TooltipProvider }, { AppSurface }] = await Promise.all([
    import("@/components/ui/tooltip"),
    import("./app-surface"),
  ]);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const document = dom.window.document;
  const sourceChanged = (capabilityToken: string) =>
    act(async () => {
      await emitNativeEvent("app:source-changed", { capabilityToken });
      await nextTurn();
    });

  try {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <AppSurface
            owner={{
              projectPath: "/repo",
              spaceId: null,
              spacePath: "/repo/space",
              ownerPath: "graph",
            }}
            onOpenVariables={() => undefined}
          />
        </TooltipProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    const firstFrame = document.querySelector("iframe")!;
    expect(firstFrame.getAttribute("src")).toBe(
      "http://127.0.0.1:42001/graph.html",
    );
    await act(async () => {
      firstFrame.dispatchEvent(new dom.window.Event("load"));
      await nextTurn();
    });
    expect(document.querySelector('[aria-label="Loading App"]')).toBeNull();

    // Another App source and a series still in progress keep the frame.
    await sourceChanged("token-other");
    await wait(APP_SOURCE_RELOAD_DELAY_MS + 50);
    expect(document.querySelector("iframe")).toBe(firstFrame);
    for (let index = 0; index < 3; index += 1) {
      await sourceChanged("token-graph");
      await wait(APP_SOURCE_RELOAD_DELAY_MS / 2);
      expect(document.querySelector("iframe")).toBe(firstFrame);
    }

    await act(() => wait(APP_SOURCE_RELOAD_DELAY_MS));
    const secondFrame = document.querySelector("iframe")!;
    expect(secondFrame === firstFrame).toBe(false);
    expect(secondFrame.getAttribute("src")).toBe(
      "http://127.0.0.1:42001/graph.html",
    );
    // Only the iframe is recreated: no loading state over it, the owner
    // session is not inspected again and its actions stay.
    expect(document.querySelector('[aria-label="Loading App"]')).toBeNull();
    expect(
      document.querySelector('button[aria-label="Reload page"]') === null,
    ).toBe(false);
    expect(
      commands.filter((command) => command === "app_manifest_inspect").length,
    ).toBe(1);

    await act(() => wait(APP_SOURCE_RELOAD_DELAY_MS * 2));
    expect(document.querySelector("iframe")).toBe(secondFrame);
  } finally {
    await act(async () => {
      root.unmount();
      await nextTurn();
    });
    expect(commands.includes("app_source_revoke")).toBe(true);
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextTurn() {
  return wait(0);
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
