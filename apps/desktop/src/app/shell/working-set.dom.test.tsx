import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_WORKING_SET_DOM !== "1") {
  test("working set DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_WORKING_SET_DOM: "1" },
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
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  interface Session {
    id: string;
    title: string;
    source: string;
    launchId?: string;
  }
  interface Key {
    kind: string;
    sessionId?: string;
    launchId?: string;
  }
  interface Item {
    key: Key;
    title: string;
    routine?: { ownerKind: string; ownerPath: string; routineId: string };
  }

  /** The catalogue as the read-model lists it. */
  let listed: Session[] = [];
  const catalogListeners = new Set<() => void>();
  function setListed(next: Session[]) {
    listed = next;
    for (const listener of catalogListeners) listener();
  }
  mock.module("@/features/agent-sessions", () => ({
    agentSessionForNavigationKey: (key: Key, sessions: Session[]) =>
      sessions.find((session) => session.id === key.sessionId) ?? null,
    agentSessionHasId: (session: Session, id: string) => session.id === id,
    agentSessionNavigationIndex: (items: Item[], session: Session) =>
      items.findIndex(
        ({ key }) =>
          key.sessionId === session.id ||
          (key.launchId !== undefined && key.launchId === session.launchId),
      ),
    agentSessionNavigationKey: (session: Session) => ({
      kind: "session",
      sessionId: session.id,
    }),
    pinnableAgentSessionItem: (session: Session | null) =>
      session
        ? {
            key: { kind: "session", sessionId: session.id },
            title: session.title,
          }
        : null,
    useActiveAgentSessions: () => [],
    useListedAgentSessions: () =>
      useSyncExternalStore(
        (listener) => {
          catalogListeners.add(listener);
          return () => catalogListeners.delete(listener);
        },
        () => listed,
      ),
  }));

  const kept: Item[] = [];
  let pinned: Item[] = [];
  /** Every keep, as Desktop gets it. */
  const keeps: Item[] = [];
  const editListeners = new Set<(edit: unknown) => void>();
  const keyId = (key: Key) =>
    JSON.stringify([key.kind, key.sessionId ?? key.launchId]);
  mock.module("@/features/navigation", () => ({
    artifactNavigationKey: () => ({ kind: "page" }),
    getNavigationState: () => ({
      projectPath: "/project",
      pinned,
      kept,
      pendingKeyIds: new Set<string>(),
      // A kept item is kept again in place, as Desktop does.
      keep: async (item: Item) => {
        keeps.push(item);
        const at = kept.findIndex(
          (current) => keyId(current.key) === keyId(item.key),
        );
        if (at < 0) kept.push(item);
        else kept[at] = item;
      },
      unkeep: async (keys: Key[]) => {
        unkept.push(keys);
      },
    }),
    hideNowRow: (projectPath: string, row: unknown) => {
      hidden.push([projectPath, row]);
    },
    navigationKeyId: keyId,
    subscribeUserEdits: (listener: (edit: unknown) => void) => {
      editListeners.add(listener);
      return () => editListeners.delete(listener);
    },
  }));
  const unkept: Key[][] = [];
  const hidden: [string, unknown][] = [];
  const closes = { content: 0, chat: 0, guard: "ready" };
  let mainObject: {
    kind: string;
    item: { key: Key; title: string };
    session?: Session;
  } | null = null;
  let shell = {
    mainSurface: "content",
    mainSessionDraft: null as { draftId: string } | null,
  };
  mock.module("@/features/artifact", () => ({
    closeActiveContent: () => {
      closes.content++;
    },
    prepareActiveContentDeactivation: async () => closes.guard,
  }));
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: { activeRootId: string }) => unknown) =>
      selector({ activeRootId: "root" }),
  }));
  mock.module("./main-area-object", () => ({
    useMainAreaObject: () => mainObject,
  }));
  mock.module("./now-model", () => ({
    isSessionKey: (key: Key) => key.kind === "session",
    nowOrderRow: (row: { session: Session }) => ({ ids: [row.session.id] }),
  }));
  mock.module("./model", () => {
    const useShellStore = () => () => {};
    useShellStore.getState = () => shell;
    return { useShellStore };
  });
  mock.module("./show-project-chat", () => ({
    useShowProjectChat: () => () => {
      closes.chat++;
    },
  }));

  const { useKeepEditedObjects, useWorkingSetActions } =
    await import("./working-set");
  const { ShellViewContext } = await import("./shell-view");
  function Host() {
    useKeepEditedObjects();
    return null;
  }
  const root = createRoot(document.getElementById("app")!);
  await act(async () => root.render(<Host />));

  const message = async (sessionId: string) => {
    await act(async () => {
      for (const listener of editListeners)
        listener({ kind: "message", sessionId });
    });
  };
  const keptIds = () => kept.map((item) => item.key.sessionId);

  test("an accepted message keeps a listed session in Now", async () => {
    await act(async () =>
      setListed([{ id: "codex:a", title: "A", source: "codex" }]),
    );
    await message("codex:a");
    expect(keptIds()).toEqual(["codex:a"]);
    expect(kept[0].title).toBe("A");
  });

  test("a new session is kept once the catalogue lists it", async () => {
    kept.length = 0;
    await message("codex:new");
    expect(keptIds()).toEqual([]);
    await act(async () =>
      setListed([
        ...listed,
        { id: "codex:new", title: "New", source: "codex" },
      ]),
    );
    expect(keptIds()).toEqual(["codex:new"]);
    await act(async () => setListed([...listed]));
    expect(keptIds()).toEqual(["codex:new"]);
  });

  test("a pinned or kept session does not change", async () => {
    kept.length = 0;
    pinned = [{ key: { kind: "session", sessionId: "codex:a" }, title: "A" }];
    await message("codex:a");
    expect(keptIds()).toEqual([]);
    pinned = [];
    kept.push({ key: { kind: "session", sessionId: "codex:a" }, title: "A" });
    await message("codex:a");
    expect(keptIds()).toEqual(["codex:a"]);
  });

  test("a message forgets the Routine of a row its launch kept, in place (DF-210 R5)", async () => {
    kept.length = 0;
    keeps.length = 0;
    await act(async () =>
      setListed([
        ...listed,
        { id: "codex:r", title: "Daily now", source: "codex", launchId: "l1" },
      ]),
    );
    kept.push(
      { key: { kind: "session", sessionId: "codex:b" }, title: "B" },
      {
        key: { kind: "sessionLaunch", launchId: "l1" },
        title: "Daily",
        routine: { ownerKind: "project", ownerPath: ".", routineId: "daily" },
      },
    );
    await message("codex:r");
    expect(keeps).toEqual([
      { key: { kind: "sessionLaunch", launchId: "l1" }, title: "Daily now" },
    ]);
    expect(kept.map((item) => item.routine)).toEqual([undefined, undefined]);
    // Kept without the Routine, it does not change by a message any more,
    // whichever key it is kept by.
    await message("codex:r");
    expect(keeps.length).toBe(1);
    expect(kept.length).toBe(2);
  });

  test("an edit without a main area artifact keeps nothing", async () => {
    kept.length = 0;
    await act(async () => {
      for (const listener of editListeners) listener({ kind: "edit" });
    });
    expect(keptIds()).toEqual([]);
  });

  test("⌘W on Home closes the object for a new chat with its project", async () => {
    let actions: ReturnType<typeof useWorkingSetActions> | null = null;
    function Actions() {
      const current = useWorkingSetActions();
      useEffect(() => {
        actions = current;
      });
      return null;
    }
    const page = { key: { kind: "page", sessionId: "plan" }, title: "Plan" };
    kept.length = 0;
    kept.push(page);
    mainObject = { kind: "artifact", item: page };
    const actionsRoot = createRoot(document.createElement("div"));
    await act(async () =>
      actionsRoot.render(
        <ShellViewContext.Provider value="home">
          <Actions />
        </ShellViewContext.Provider>,
      ),
    );

    closes.guard = "blocked";
    await act(async () => actions!.closeMainAreaObject());
    expect([closes.content, closes.chat, unkept.length]).toEqual([0, 0, 0]);

    closes.guard = "ready";
    await act(async () => actions!.closeMainAreaObject());
    expect([closes.content, closes.chat]).toEqual([1, 1]);
    expect(unkept).toEqual([[page.key]]);

    // The new chat of Home is what closing would show: nothing closes.
    mainObject = null;
    shell = { mainSurface: "session", mainSessionDraft: { draftId: "d" } };
    await act(async () =>
      actionsRoot.render(
        <ShellViewContext.Provider value="home">
          <Actions />
        </ShellViewContext.Provider>,
      ),
    );
    await act(async () => actions!.closeMainAreaObject());
    expect([closes.content, closes.chat]).toEqual([1, 1]);
    await act(async () => actionsRoot.unmount());
  });

  test("closing an active session's row hides it, unkept, after the guards of its display (DF-207 R2, R3)", async () => {
    let actions: ReturnType<typeof useWorkingSetActions> | null = null;
    function Actions() {
      const current = useWorkingSetActions();
      useEffect(() => {
        actions = current;
      });
      return null;
    }
    const working = { id: "codex:w", title: "Work", source: "codex" };
    const key = { kind: "session", sessionId: "codex:w" };
    const row = {
      kind: "active" as const,
      session: working,
      kept: { key, title: "Work" },
      main: true,
    };
    mainObject = {
      kind: "session",
      item: { key, title: "Work" },
      session: working,
    };
    shell = { mainSurface: "session", mainSessionDraft: null };
    unkept.length = 0;
    closes.content = 0;
    const actionsRoot = createRoot(document.createElement("div"));
    await act(async () => actionsRoot.render(<Actions />));
    const close = (target: typeof row) =>
      actions!.closeActiveSession(target as never);

    // A cancelled guard changes nothing.
    closes.guard = "blocked";
    await act(async () => close(row));
    expect([closes.content, hidden.length, unkept.length]).toEqual([0, 0, 0]);

    closes.guard = "ready";
    await act(async () => close(row));
    expect(closes.content).toBe(1);
    expect(hidden).toEqual([["/project", { ids: ["codex:w"] }]]);
    expect(unkept).toEqual([[key]]);

    // A row not shown in the main area closes without a guard.
    mainObject = null;
    await act(async () => actionsRoot.render(<Actions />));
    await act(async () => close({ ...row, kept: null as never, main: false }));
    expect(closes.content).toBe(1);
    expect(hidden.length).toBe(2);
    expect(unkept.length).toBe(1);
    await act(async () => actionsRoot.unmount());
  });

  test("Close all hides every active session and unkeeps every kept object after one guard (DF-207 R5)", async () => {
    let actions: ReturnType<typeof useWorkingSetActions> | null = null;
    function Actions() {
      const current = useWorkingSetActions();
      useEffect(() => {
        actions = current;
      });
      return null;
    }
    const page = { key: { kind: "page", sessionId: "plan" }, title: "Plan" };
    const workKey = { kind: "session", sessionId: "codex:w" };
    const work = { id: "codex:w", title: "Work", source: "codex" };
    const free = { id: "codex:f", title: "Free", source: "codex" };
    const pinnedKey = { kind: "session", sessionId: "codex:p" };
    pinned = [{ key: pinnedKey, title: "Pinned" }];
    kept.length = 0;
    kept.push(page, { key: workKey, title: "Work" });
    const rows = [
      { kind: "kept" as const, item: page },
      {
        kind: "active" as const,
        session: work,
        kept: { key: workKey, title: "Work" },
        main: false,
      },
      { kind: "active" as const, session: free, kept: null, main: false },
    ];
    mainObject = { kind: "artifact", item: page };
    shell = { mainSurface: "content", mainSessionDraft: null };
    hidden.length = 0;
    unkept.length = 0;
    closes.content = 0;
    const actionsRoot = createRoot(document.createElement("div"));
    await act(async () => actionsRoot.render(<Actions />));

    // The open kept page needs the guard; a cancelled one changes nothing.
    closes.guard = "blocked";
    await act(async () => actions!.closeAll(rows as never));
    expect([closes.content, hidden.length, unkept.length]).toEqual([0, 0, 0]);

    closes.guard = "ready";
    await act(async () => actions!.closeAll(rows as never));
    expect(closes.content).toBe(1);
    expect(hidden).toEqual([
      ["/project", { ids: ["codex:w"] }],
      ["/project", { ids: ["codex:f"] }],
    ]);
    // Every kept object, and not the pinned session.
    expect(unkept).toEqual([[page.key, workKey]]);

    // Without an open row, nothing passes the guard.
    mainObject = null;
    await act(async () => actionsRoot.render(<Actions />));
    await act(async () => actions!.closeAll(rows.slice(1) as never));
    expect(closes.content).toBe(1);
    pinned = [];
    await act(async () => actionsRoot.unmount());
  });
}
