import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

test("Page chooses a local default without verification and keeps blocked edit recoverable", async () => {
  const local = await renderPage("local");
  try {
    expect(textOf(local.dom, "[data-mode]")).toBe("edit");
    expect(textOf(local.dom, "[data-read-only]")).toBe("editable");
    expect(local.calls.includes("repository_access_verify")).toBe(false);
    await act(async () => {
      local.dom.window.document
        .querySelector<HTMLButtonElement>("[data-run-mutation]")!
        .click();
      await nextTurn();
    });
    expect(local.events).toEqual(["body", "metadata", "mutation"]);
  } finally {
    await local.cleanup();
  }

  const blocked = await renderPage("read_only");
  try {
    expect(textOf(blocked.dom, "[data-mode]")).toBe("view");
    await act(async () => {
      activateMode(blocked.dom, "Edit");
      await nextTurn();
      await nextTurn();
    });

    expect(textOf(blocked.dom, "[data-mode]")).toBe("view");
    expect(textOf(blocked.dom, "[data-read-only]")).toBe("read-only");
    expect(
      Boolean(
        blocked.dom.window.document.querySelector(
          "[data-repository-access-inline-recovery]",
        ),
      ),
    ).toBe(true);
    expect(blocked.calls.includes("repository_access_verify")).toBe(false);
  } finally {
    await blocked.cleanup();
  }
});

async function renderPage(status: "local" | "read_only") {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const calls: string[] = [];
  const events: string[] = [];
  const spacePath = `/page-mode-${status}-${Date.now()}`;
  mockNativeIpc(
    (command) => {
      calls.push(command);
      if (command === "repository_access_get") {
        return snapshot(`repo-${status}-${Date.now()}`, status);
      }
      if (command === "repository_access_verify") {
        return snapshot(`repo-${status}-${Date.now()}`, "local");
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { PageSurfaceSessionProvider, usePageSurfaceSession } =
    await import("./page-surface-context");
  const { PageModeControl } = await import("../ui/page-mode-control");
  const { PageAccessRecovery } = await import("../ui/page-access-recovery");

  function Probe() {
    const session = usePageSurfaceSession();
    const registerPersistence = session.registerPersistence;
    useEffect(() => {
      const unregisterBody = registerPersistence("body", async () => {
        events.push("body");
      });
      const unregisterMetadata = registerPersistence("metadata", async () => {
        events.push("metadata");
      });
      return () => {
        unregisterBody();
        unregisterMetadata();
      };
    }, [registerPersistence]);
    return (
      <>
        <PageModeControl />
        <PageAccessRecovery />
        <span data-mode>{session.currentMode}</span>
        <span data-read-only>
          {session.readOnly ? "read-only" : "editable"}
        </span>
        <button
          data-run-mutation
          onClick={() =>
            void session.runMutation(async () => {
              events.push("mutation");
            })
          }
        />
      </>
    );
  }

  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(
      <PageSurfaceSessionProvider
        displayName="Page"
        displayPath="page.md"
        spacePath={spacePath}
        targetKey={spacePath}
      >
        <Probe />
      </PageSurfaceSessionProvider>,
    );
    await nextTurn();
  });
  return {
    calls,
    events,
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
  };
}

function snapshot(repositoryId: string, status: "local" | "read_only") {
  return {
    checkedAt: null,
    expiresAt: null,
    generation: 1,
    lastKnownStatus: null,
    reason: status === "read_only" ? "policy_blocked" : null,
    repositoryId,
    status,
  };
}

function activateMode(dom: JSDOM, label: string) {
  const tab = Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>(
      "[data-page-mode-control] button",
    ),
  ).find((button) => button.textContent === label)!;
  tab.click();
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
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
