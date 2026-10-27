import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_NOW_SECTION_DOM !== "1") {
  test("Now sidebar section DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_NOW_SECTION_DOM: "1" },
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

  let terminals = { count: 0, agentsBusy: false };
  let closedSessions = 0;
  let nowRows: unknown[] = [];
  const closedRows: unknown[] = [];
  mock.module("@/features/agent-sessions", () => ({
    AgentSessionNavigationItem: (props: {
      fallbackTitle: string;
      onClose?: () => void;
      closeKeepsWorking?: boolean;
    }) => (
      <button
        type="button"
        data-row={props.fallbackTitle}
        data-closes={String(Boolean(props.onClose))}
        data-keeps-working={String(Boolean(props.closeKeepsWorking))}
        onClick={props.onClose}
      />
    ),
    CloseSessionTerminalsDialog: (props: {
      open: boolean;
      count: number;
      onConfirm: () => void;
    }) =>
      props.open ? (
        <div data-confirm={props.count}>
          <button type="button" onClick={props.onConfirm}>
            confirm
          </button>
        </div>
      ) : null,
    agentSessionNavigationKey: (session: { id: string }) => ({
      kind: "session",
      sessionId: session.id,
    }),
    agentSessionTargetFor: () => null,
    pinnableAgentSessionItem: () => null,
    useSessionTerminals: () => ({
      ...terminals,
      closeAll: async () => {
        closedSessions += 1;
      },
    }),
  }));
  mock.module("@/features/navigation", () => ({
    NavigationSidebarGroup: (props: {
      label: string;
      action: ReactNode;
      children: ReactNode;
    }) => (
      <section data-group={props.label}>
        {props.action}
        {props.children}
      </section>
    ),
    navigationKeyId: (key: { sessionId?: string } | null) =>
      key?.sessionId ?? "",
    useKeepInNow: () => ({ available: false, keep() {} }),
    useNavigationState: (selector: (state: unknown) => unknown) =>
      selector({ pinned: [], kept: [] }),
  }));
  mock.module("./agent-session-peek-host", () => ({
    useOpenSessionInMainArea: () => async () => true,
  }));
  mock.module("./now-rows", () => ({
    useActiveProjectNow: () => ({ rows: nowRows, mainObject: null }),
  }));
  mock.module("./now-model", () => ({ isSessionKey: () => false }));
  mock.module("./navigation-sidebar-items", () => ({
    NavigationArtifactItem: () => null,
    useOpenNavigationArtifact: () => async () => {},
  }));
  mock.module("./working-set", () => ({
    useWorkingSetActions: () => ({
      closeItem: async () => {},
      closeActiveSession: async (row: unknown) => {
        closedRows.push(row);
      },
      closeAll: async () => {},
    }),
  }));

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { NowSidebarSection } = await import("./now-sidebar-section");
  const root = createRoot(document.getElementById("app")!);
  const render = () =>
    act(async () =>
      root.render(
        <SidebarProvider>
          <NowSidebarSection
            onActivateContent={() => {}}
            onBeforeNavigation={async () => true}
          />
        </SidebarProvider>,
      ),
    );
  const openMenu = async () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      "[aria-label='Now actions']",
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      ),
    );
    return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  };

  test("an active session's row closes from Now and says it keeps working (DF-207 R1)", async () => {
    const row = {
      kind: "active",
      session: { id: "codex:w", title: "Work" },
      kept: null,
      main: false,
    };
    nowRows = [row];
    await render();
    const button =
      document.querySelector<HTMLButtonElement>("[data-row='Work']")!;
    expect(button.dataset.closes).toBe("true");
    expect(button.dataset.keepsWorking).toBe("true");
    await act(async () => button.click());
    expect(closedRows).toEqual([row]);
    nowRows = [];
  });

  test("without session terminals an empty Now is hidden", async () => {
    await render();
    expect(document.querySelector("[data-group]")).toBeNull();
  });

  test("open session terminals keep the Now menu and close without a confirm while agents rest", async () => {
    terminals = { count: 2, agentsBusy: false };
    await render();
    expect(document.querySelector("[data-group]") === null).toBe(false);
    const [closeAll, closeSessions] = await openMenu();
    expect(closeAll.getAttribute("aria-disabled")).toBe("true");
    expect(closeSessions.textContent).toBe("Close sessions (2)");
    expect(closeSessions.dataset.variant).toBe("destructive");
    await act(async () => closeSessions.click());
    expect(closedSessions).toBe(1);
    expect(document.querySelector("[data-confirm]")).toBeNull();
  });

  test("a working or waiting agent needs a confirm naming the count", async () => {
    terminals = { count: 3, agentsBusy: true };
    await render();
    const [, closeSessions] = await openMenu();
    await act(async () => closeSessions.click());
    expect(closedSessions).toBe(1);
    const confirm = document.querySelector<HTMLElement>("[data-confirm]")!;
    expect(confirm.dataset.confirm).toBe("3");
    await act(async () => confirm.querySelector("button")!.click());
    expect(closedSessions).toBe(2);
    root.unmount();
  });
}
