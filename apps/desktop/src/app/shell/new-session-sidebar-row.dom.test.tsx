import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_NEW_SESSION_ROW_DOM !== "1") {
  test("new session sidebar row DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_NEW_SESSION_ROW_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>");
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  type Scope = { kind: "project" | "space"; scopeId: string; path: string };
  type Selection =
    | {
        kind: "artifact";
        request: { intent: { target: { spaceId: string | null } } };
      }
    | { kind: "scope-owner"; request: { owner: { spaceId: string | null } } };

  let selection: Selection | null = null;
  let session: { spaceId: string | null } | null = null;
  let drawerAllows = true;
  let contentAllows = true;
  const started: string[] = [];
  const openedSpaces: (string | null)[] = [];
  let lastSpace: unknown;
  let onStart: ((scope: Scope) => void) | null = null;

  mock.module("@/features/agent-sessions", () => ({
    AgentSessionPeek: () => null,
    NewSessionSidebarItem: (props: {
      space: unknown;
      onStart: (scope: Scope) => void;
    }) => {
      lastSpace = props.space;
      onStart = props.onStart;
      return null;
    },
    useResolvedAgentSession: (target: unknown) => (target ? session : null),
    useAgentSessionSpace: (resolved: { spaceId: string | null } | null) =>
      resolved ? { spaceId: resolved.spaceId } : null,
    useStartAgentSession: () => async (spacePath: string) => {
      started.push(spacePath);
      return { sessionId: "pending:pty", launchId: null };
    },
  }));
  mock.module("@/features/artifact", () => ({
    getActiveContentPath: () => null,
    useActiveContentSelection: () => ({ selection }),
    prepareActiveContentDeactivation: async () =>
      contentAllows ? "ready" : "blocked",
  }));
  mock.module("@/features/collection/app-shell", () => ({
    useCollectionDetailController: () => ({
      prepareForNavigation: async () => drawerAllows,
    }),
    runCollectionNavigation: async () => {},
  }));
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: unknown) => unknown) =>
      selector({
        activeRootId: "root",
        openSpace: async (spaceId: string) => openedSpaces.push(spaceId),
        clearActiveSpace: () => openedSpaces.push(null),
      }),
  }));
  mock.module("@/features/terminal", () => ({
    TerminalSidebarAction: () => null,
  }));
  mock.module("./open-session-routine", () => ({
    useOpenSessionRoutine: () => () => {},
  }));

  const { useShellStore } = await import("./model");
  const { NewSessionSidebarRow } = await import("./new-session-sidebar-row");
  const root = createRoot(document.getElementById("app")!);
  const render = () => act(async () => root.render(<NewSessionSidebarRow />));
  const setShell = (patch: Partial<ReturnType<typeof useShellStore.getState>>) =>
    act(() => {
      useShellStore.setState(patch);
    });

  async function reset() {
    selection = null;
    session = null;
    drawerAllows = true;
    contentAllows = true;
    started.length = 0;
    openedSpaces.length = 0;
    await setShell({
      mainSurface: "content",
      mainSessionTarget: null,
      mainSessionFocusTerminal: false,
    });
  }

  test("the target follows the Space of the main area object", async () => {
    await reset();
    await render();
    expect(lastSpace).toEqual({ spaceId: null });

    selection = {
      kind: "artifact",
      request: { intent: { target: { spaceId: "docs" } } },
    };
    await render();
    expect(lastSpace).toEqual({ spaceId: "docs" });

    selection = { kind: "scope-owner", request: { owner: { spaceId: "root" } } };
    await render();
    expect(lastSpace).toEqual({ spaceId: null });

    selection = {
      kind: "artifact",
      request: { intent: { target: { spaceId: "docs" } } },
    };
    await setShell({ mainSurface: "graph" });
    await render();
    expect(lastSpace).toEqual({ spaceId: null });

    await setShell({
      mainSurface: "session",
      mainSessionTarget: { sessionId: "codex:1", launchId: null },
    });
    await render();
    expect(lastSpace).toBeNull();
    session = { spaceId: "notes" };
    await render();
    expect(lastSpace).toEqual({ spaceId: "notes" });
  });

  test("a cancelled guard starts no terminal", async () => {
    await reset();
    await render();
    drawerAllows = false;
    await act(async () =>
      onStart!({ kind: "space", scopeId: "docs", path: "/project/docs" }),
    );
    drawerAllows = true;
    contentAllows = false;
    await act(async () =>
      onStart!({ kind: "space", scopeId: "docs", path: "/project/docs" }),
    );
    expect(started).toEqual([]);
    expect(useShellStore.getState().mainSurface).toBe("content");
  });

  test("the new session opens in the main area with focus in its terminal", async () => {
    await reset();
    await render();
    await act(async () =>
      onStart!({ kind: "space", scopeId: "docs", path: "/project/docs" }),
    );
    expect(started).toEqual(["/project/docs"]);
    expect(openedSpaces).toEqual(["docs"]);
    const state = useShellStore.getState();
    expect(state.mainSurface).toBe("session");
    expect(state.mainSessionTarget).toEqual({
      sessionId: "pending:pty",
      launchId: null,
    });
    expect(state.mainSessionFocusTerminal).toBe(true);

    await act(async () =>
      onStart!({ kind: "project", scopeId: "root", path: "/project" }),
    );
    expect(started).toEqual(["/project/docs", "/project"]);
    expect(openedSpaces).toEqual(["docs", null]);
  });
}
