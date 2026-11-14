import * as bunTest from "bun:test";
import { afterAll, describe, expect, test } from "bun:test";
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
  const { mock } = bunTest;
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
    scopeKind?: string;
    spaceId?: string;
    spacePath?: string;
  }
  interface Key {
    kind: string;
    sessionId?: string;
    launchId?: string;
    spaceId?: string;
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
    pathNavigationKey: () => ({ kind: "page" }),
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
  /**
   * Closes of the display: `content` counts the closed object, whether it
   * gives way to nothing or, in a Space, to the main page of its Space.
   */
  const closes = { content: 0, chat: 0, guard: "ready" };
  /** The main pages of Spaces closing showed, with their open options. */
  const opened: [unknown, unknown][] = [];
  /** The sidebar as the Space store holds it, and its switches. */
  const sidebar = {
    activeRootId: "root",
    activeSpaceId: null as string | null,
    spaces: [
      { id: "s1", path: "/project/s1" },
      { id: "s2", path: "/project/s2" },
    ],
    switches: [] as (string | null)[],
  };
  let contentSurfaceOpens = 0;
  let mainObject: {
    kind: string;
    item: { key: Key; title: string };
    session?: Session;
    shown?: boolean;
  } | null = null;
  let shell = {
    mainSurface: "content",
    mainSessionDraft: null as { draftId: string } | null,
  };
  mock.module("@/features/artifact", () => ({
    closeActiveContent: () => {
      closes.content++;
    },
    openScopeOwner: (owner: unknown, options: unknown) => {
      closes.content++;
      opened.push([owner, options]);
    },
    prepareActiveContentDeactivation: async () => closes.guard,
  }));
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: { activeRootId: string }) => unknown) =>
      selector({ activeRootId: "root" }),
    getSpaceSnapshot: () => ({
      activeRootId: sidebar.activeRootId,
      activeSpaceId: sidebar.activeSpaceId,
      spaces: sidebar.spaces,
      openSpace: async (id: string) => {
        sidebar.switches.push(id);
        sidebar.activeSpaceId = id;
      },
      clearActiveSpace: () => {
        sidebar.switches.push(null);
        sidebar.activeSpaceId = null;
      },
    }),
  }));
  mock.module("./main-area-object", () => ({
    useMainAreaObject: () => mainObject,
  }));
  mock.module("./now-model", () => ({
    isSessionKey: (key: Key) => key.kind === "session",
    nowOrderRow: (row: { session: Session }) => ({ ids: [row.session.id] }),
  }));
  mock.module("./model", () => {
    const actions = {
      openContentSurface: () => {
        contentSurfaceOpens++;
      },
      closeGraphSurface: () => {},
    };
    const useShellStore = (select: (state: typeof actions) => unknown) =>
      select(actions);
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

  test("an edit in the main area keeps an expanded item once its screen shows it", async () => {
    kept.length = 0;
    const item = {
      key: { kind: "routine", sessionId: "daily" },
      title: "Daily",
    };
    const edit = async () =>
      act(async () => {
        for (const listener of editListeners) listener({ kind: "edit" });
      });
    mainObject = { kind: "item", item: { ...item, title: "" }, shown: false };
    await act(async () => root.render(<Host />));
    await edit();
    expect(kept).toEqual([]);
    mainObject = { kind: "item", item, shown: true };
    await act(async () => root.render(<Host />));
    await edit();
    expect(kept).toEqual([item]);
    mainObject = null;
    await act(async () => root.render(<Host />));
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

  describe("closing in a Space (DF-259)", () => {
    let actions: ReturnType<typeof useWorkingSetActions> | null = null;
    function Actions() {
      const current = useWorkingSetActions();
      useEffect(() => {
        actions = current;
      });
      return null;
    }
    const actionsRoot = createRoot(document.createElement("div"));
    const space = (spaceId: string) => ({ kind: "space", spaceId });
    const show = async (
      object: typeof mainObject,
      surface: "content" | "session" = "content",
    ) => {
      mainObject = object;
      shell = { mainSurface: surface, mainSessionDraft: null };
      await act(async () => actionsRoot.render(<Actions />));
    };
    const reset = (sidebarSpaceId: string | null) => {
      sidebar.activeSpaceId = sidebarSpaceId;
      sidebar.switches = [];
      opened.length = 0;
      unkept.length = 0;
      hidden.length = 0;
      kept.length = 0;
      pinned = [];
      closes.content = 0;
      closes.chat = 0;
      closes.guard = "ready";
      contentSurfaceOpens = 0;
    };

    test("the close button of a temporary Page opens the main page of its Space, in the sidebar too", async () => {
      reset(null);
      const page = {
        key: { kind: "page", sessionId: "brief", spaceId: "s1" },
        title: "Brief",
      };
      await show({ kind: "artifact", item: page });

      // A cancelled guard changes nothing.
      closes.guard = "blocked";
      await act(async () => actions!.closeItem(page.key as never));
      expect([opened, sidebar.switches, unkept]).toEqual([[], [], []]);

      closes.guard = "ready";
      await act(async () => actions!.closeItem(page.key as never));
      expect(opened).toEqual([[space("s1"), undefined]]);
      expect(sidebar.switches).toEqual(["s1"]);
      expect(closes.content).toBe(1);
    });

    test("the close button of a kept root Collection opens the main page of the root", async () => {
      reset("s1");
      const tasks = {
        key: { kind: "collection", sessionId: "tasks" },
        title: "Tasks",
      };
      kept.push(tasks);
      await show({ kind: "artifact", item: tasks });
      await act(async () => actions!.closeItem(tasks.key as never));
      expect(opened).toEqual([[space("root"), undefined]]);
      expect(sidebar.switches).toEqual([null]);
      expect(unkept).toEqual([[tasks.key]]);
    });

    test("the close button of an active session opens the main page of its scope", async () => {
      reset(null);
      const working = {
        id: "codex:w",
        title: "Work",
        source: "codex",
        scopeKind: "space",
        spaceId: "s2",
      };
      const key = { kind: "session", sessionId: "codex:w" };
      const row = {
        kind: "active" as const,
        session: working,
        kept: null,
        main: true,
      };
      await show(
        { kind: "session", item: { key, title: "Work" }, session: working },
        "session",
      );
      await act(async () => actions!.closeActiveSession(row as never));
      expect(contentSurfaceOpens).toBe(1);
      expect(opened).toEqual([[space("s2"), undefined]]);
      expect(sidebar.switches).toEqual(["s2"]);
      expect(hidden).toEqual([["/project", { ids: ["codex:w"] }]]);

      // A session of the project root opens the main page of the root; one
      // of a Space found by its path, that Space.
      reset("s1");
      const project = { ...working, scopeKind: "project", spaceId: undefined };
      await show(
        { kind: "session", item: { key, title: "Work" }, session: project },
        "session",
      );
      await act(async () => actions!.closeMainAreaObject());
      expect(opened).toEqual([[space("root"), undefined]]);
      expect(sidebar.switches).toEqual([null]);

      reset("s2");
      const byPath = {
        ...working,
        spaceId: undefined,
        spacePath: "/project/s1",
      };
      await show(
        { kind: "session", item: { key, title: "Work" }, session: byPath },
        "session",
      );
      await act(async () => actions!.closeMainAreaObject());
      expect(opened).toEqual([[space("s1"), undefined]]);
      expect(sidebar.switches).toEqual(["s1"]);
    });

    test("⌘W of a session the catalog does not list opens the main page of the sidebar's Space", async () => {
      reset("s2");
      await show(null, "session");
      await act(async () => actions!.closeMainAreaObject());
      expect(contentSurfaceOpens).toBe(1);
      expect(opened).toEqual([[space("s2"), undefined]]);
      expect(sidebar.switches).toEqual([]);

      reset(null);
      await show(null, "session");
      await act(async () => actions!.closeMainAreaObject());
      expect(opened).toEqual([[space("root"), undefined]]);
    });

    test("⌘W of an object of another Space switches the sidebar to it", async () => {
      reset("s2");
      const page = {
        key: { kind: "page", sessionId: "notes", spaceId: "s1" },
        title: "Notes",
      };
      await show({ kind: "artifact", item: page });
      closes.guard = "blocked";
      await act(async () => actions!.closeMainAreaObject());
      expect([opened, sidebar.switches]).toEqual([[], []]);
      closes.guard = "ready";
      await act(async () => actions!.closeMainAreaObject());
      expect(opened).toEqual([[space("s1"), undefined]]);
      expect(sidebar.switches).toEqual(["s1"]);
    });

    test("Close all opens the main page of the open object's Space", async () => {
      reset(null);
      const page = {
        key: { kind: "page", sessionId: "plan", spaceId: "s2" },
        title: "Plan",
      };
      await show({ kind: "artifact", item: page });
      await act(async () =>
        actions!.closeAll([{ kind: "temporary", item: page }] as never),
      );
      expect(opened).toEqual([[space("s2"), undefined]]);
      expect(sidebar.switches).toEqual(["s2"]);
    });

    test("closing the display of a Space's main page leaves it shown (R3)", async () => {
      reset("s1");
      const home = { key: { kind: "space", spaceId: "s1" }, title: "S1" };
      pinned = [home];
      await show({ kind: "space", item: home });
      await act(async () => actions!.closeMainAreaObject());
      // The same owner without an intent: the selection keeps the page.
      expect(opened).toEqual([[space("s1"), undefined]]);
      expect([sidebar.switches, unkept]).toEqual([[], []]);
    });

    test("an item expanded over its Space folds back into the main page", async () => {
      reset("s1");
      const routine = {
        key: { kind: "routine", sessionId: "daily", spaceId: "s1" },
        title: "Daily",
      };
      await show({ kind: "item", item: routine, shown: true });
      await act(async () => actions!.closeMainAreaObject());
      expect(opened).toEqual([
        [space("s1"), { scopeOpenIntent: { kind: "default" } }],
      ]);
    });

    afterAll(async () => {
      mainObject = null;
      shell = { mainSurface: "content", mainSessionDraft: null };
      pinned = [];
      await act(async () => actionsRoot.unmount());
    });
  });
}
