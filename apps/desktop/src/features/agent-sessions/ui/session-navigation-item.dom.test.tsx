import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentSession } from "../model";

if (process.env.SVODE_SESSION_NAVIGATION_ITEM_DOM !== "1") {
  test("session navigation item DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SESSION_NAVIGATION_ITEM_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest;
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
    Element: dom.window.Element,
    Node: dom.window.Node,
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

  const spaceState = {
    activeRootName: "Personal",
    activeRootPath: "/project",
    rootSpaces: [],
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command) => {
    if (command === "agent_adapters_list_identities") {
      return [{ id: "hermes", displayName: "Hermes" }];
    }
    if (command.startsWith("plugin:event|")) return 1;
    return null;
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime.js");
  await setLocale("en", { reload: false });
  const { SidebarMenu, SidebarProvider } =
    await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AgentSessionNavigationItem } =
    await import("./session-navigation-item");

  const NOW = Date.parse("2026-11-06T12:00:00Z");
  const realNow = Date.now;
  const before = (ms: number) => new Date(NOW - ms).toISOString();
  const MINUTE = 60_000;

  function session(overrides: Partial<AgentSession> = {}): AgentSession {
    return {
      id: "hermes:a",
      source: "hermes",
      sourceSessionId: "a",
      title: "Friendly greeting",
      titleSource: "session-id",
      status: {
        state: "idle",
        stopReason: "end_turn",
        source: "svode_runtime",
        confidence: "exact",
      },
      scopeKind: "project",
      scopeStatus: "ready",
      scopeConfidence: "exact",
      projectPath: "/project",
      lastActivityAt: before(3 * MINUTE),
      capabilities: { canResume: true, canOpenInChat: true },
      ...overrides,
    };
  }

  let root: Root | null = null;
  async function render(sessions: AgentSession[]) {
    if (root) {
      const previous = root;
      await act(async () => previous.unmount());
    }
    document.body.innerHTML = "<div id='app'></div>";
    root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root!.render(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarMenu>
              <AgentSessionNavigationItem
                navigationKey={{ kind: "session", sessionId: "hermes:a" }}
                fallbackTitle="Friendly greeting"
                mainTarget={null}
                onOpen={() => undefined}
                stepItem={null}
                project={{ sessions, spaceName: () => "Personal" }}
              />
            </SidebarMenu>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
  }
  const button = () =>
    document.querySelector<HTMLButtonElement>("[data-sidebar=menu-button]")!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  /** The tooltip's lines once the row is focused, which opens it. */
  async function openTooltip(): Promise<string[]> {
    await act(async () => button().focus());
    await act(settle);
    const tooltip = document.querySelector("[data-slot=tooltip-content]");
    expect(tooltip === null).toBe(false);
    return (
      [...tooltip!.children]
        // Not the arrow nor the hidden copy the tooltip names itself by.
        .filter(
          (child) =>
            child.tagName === "SPAN" &&
            !child.id &&
            !child.querySelector("svg"),
        )
        .map((child) => child.textContent ?? "")
    );
  }

  async function withNow<T>(now: number, run: () => Promise<T>): Promise<T> {
    Date.now = () => now;
    try {
      return await run();
    } finally {
      Date.now = realNow;
    }
  }

  test("a done session's status line shows the time of its last activity", async () => {
    await withNow(NOW, async () => {
      await render([session()]);
      expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
      // The row's screen reader status names the status without the time.
      expect(button().textContent).toBe(
        `Friendly greeting${m.sessions_status_done()}`,
      );
      const lines = await openTooltip();
      expect(lines[0]).toBe("Friendly greeting");
      expect(lines[1]).toBe(`${m.sessions_status_done()} · 3m`);
      expect(lines.slice(2).join("\n").includes("3m")).toBe(false);
      expect(lines.includes("Hermes · Personal")).toBe(true);
    });
  });

  test("a waiting session counts from when it started waiting", async () => {
    await withNow(NOW, async () => {
      await render([
        session({
          status: {
            state: "requires_action",
            request: "permission",
            source: "svode_runtime",
            confidence: "exact",
          },
          lastActivityAt: before(MINUTE),
          waitingSince: before(10 * MINUTE),
        }),
      ]);
      const lines = await openTooltip();
      expect(lines[1]).toBe(`${m.sessions_status_requires_action()} · 10m`);
    });
  });

  test("an open terminal's status line carries the time", async () => {
    await withNow(NOW, async () => {
      await render([
        session({
          lastActivityAt: before(2 * 60 * MINUTE),
          runtime: { live: true, ptyId: "pty-1" },
        }),
      ]);
      const lines = await openTooltip();
      expect(lines[1]).toBe(`${m.sessions_status_terminal_open()} · 2h`);
    });
  });

  test("an unreadable time leaves the status without a separator", async () => {
    await withNow(NOW, async () => {
      await render([session({ lastActivityAt: "not a time" })]);
      const lines = await openTooltip();
      expect(lines[1]).toBe(m.sessions_status_done());
    });
  });

  test("a session the list does not have shows no time", async () => {
    await withNow(NOW, async () => {
      await render([]);
      const lines = await openTooltip();
      expect(lines).toEqual(["Friendly greeting", m.navigation_unavailable()]);
    });
  });

  test("the time is the one at the moment the tooltip opens", async () => {
    await withNow(NOW, () => render([session()]));
    const lines = await withNow(NOW + 2 * MINUTE, openTooltip);
    expect(lines[1]).toBe(`${m.sessions_status_done()} · 5m`);
  });
}
