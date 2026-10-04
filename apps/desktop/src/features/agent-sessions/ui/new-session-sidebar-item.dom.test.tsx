import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_NEW_SESSION_ITEM_DOM !== "1") {
  test("new session sidebar item DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_NEW_SESSION_ITEM_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    DOMRect: dom.window.DOMRect,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  // React's input polyfill for old engines when jsdom lacks `oninput`.
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

  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: unknown) => unknown) =>
      selector({
        activeRootIcon: null,
        activeRootId: "root",
        activeRootName: "Project",
        activeRootPath: "/project",
        spaces: [
          {
            id: "docs",
            name: "Docs",
            icon: "📚",
            path: "/project/docs",
            status: "ready",
          },
          {
            id: "lost",
            name: "Lost",
            icon: "",
            path: "/project/lost",
            status: "missing",
          },
        ],
      }),
  }));

  const { SidebarMenu, SidebarProvider } =
    await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { NewSessionSidebarItem } = await import("./new-session-sidebar-item");

  const started: string[] = [];
  const root = createRoot(document.getElementById("app")!);
  const render = (spaceId: string | null) =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarMenu>
              <NewSessionSidebarItem
                space={{ spaceId }}
                onStart={(scope) => started.push(scope.path)}
              />
            </SidebarMenu>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
  const mainButton = () =>
    document.querySelector<HTMLButtonElement>("[data-sidebar=menu-button]")!;

  test("the row names its target Space and starts a session there", async () => {
    await render("docs");
    expect(mainButton().getAttribute("aria-label")).toBe(
      "New session in “Docs”",
    );
    expect(mainButton().getAttribute("aria-disabled")).toBeNull();
    // The Space chooser is the only action; the terminal toggle is gone.
    expect(
      document.querySelectorAll('[data-sidebar="menu-action"]').length,
    ).toBe(1);
    await act(async () => mainButton().click());
    expect(started).toEqual(["/project/docs"]);

    await render(null);
    expect(mainButton().getAttribute("aria-label")).toBe(
      "New session in “Project”",
    );
    started.length = 0;
  });

  test("an unavailable Space disables the row without a silent root fallback", async () => {
    await render("lost");
    expect(mainButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => mainButton().click());
    expect(started).toEqual([]);
    expect(document.querySelector(
        "[aria-label='Choose a Space for a new session']",
      ) === null).toBe(false);
  });

  test("the chooser lists the current Space first and starts in the chosen one", async () => {
    await render("docs");
    const chooser = document.querySelector<HTMLButtonElement>(
      "[aria-label='Choose a Space for a new session']",
    )!;
    await act(async () => chooser.click());
    const items = [
      ...document.querySelectorAll<HTMLElement>("[cmdk-item]"),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      "📚Docscurrent",
      "Project",
      "Lost",
    ]);
    expect(items[2].getAttribute("aria-disabled")).toBe("true");

    await act(async () => items[2].click());
    expect(started).toEqual([]);
    await act(async () => items[1].click());
    expect(started).toEqual(["/project"]);
    expect(document.querySelector("[cmdk-item]")).toBeNull();
    root.unmount();
  });
}
