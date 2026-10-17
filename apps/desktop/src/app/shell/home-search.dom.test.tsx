import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_HOME_SEARCH_DOM !== "1") {
  test("Home Search DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_HOME_SEARCH_DOM: "1" },
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
  const dom = new JSDOM(
    "<!doctype html><button id='trigger' type='button'>Search</button><div id='app'></div>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
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
    CSS: { escape: (value: string) => value },
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

  const project = (id: string, status: "ready" | "missing" = "ready") => ({
    id,
    name: id.toUpperCase(),
    icon: "",
    description: "",
    path: `/projects/${id}`,
    hasSpaces: true,
    hasSchema: false,
    lastOpened: "2026-10-01T00:00:00Z",
    status,
    lfsState: "n/a" as const,
  });
  const childSpace = (projectId: string, id: string) => ({
    ...project(id),
    path: `/projects/${projectId}/${id}`,
  });
  type Project = ReturnType<typeof project>;
  const projectSpaces: Record<string, Project[]> = {
    "/projects/a": [childSpace("a", "a-docs")],
    "/projects/b": [childSpace("b", "b-docs")],
  };
  const state = {
    rootSpaces: [
      project("a"),
      project("b"),
      project("c"),
      project("d", "missing"),
    ],
    activeRootId: "a" as string | null,
    activeRootPath: "/projects/a" as string | null,
    activeRootName: "A" as string | null,
    activeSpaceId: null as string | null,
    spaces: projectSpaces["/projects/a"],
    openSpace: async (id: string) => calls.spaceOpened.push(id),
    clearActiveSpace() {},
  };
  const calls = {
    guard: 0,
    activate: [] as [string, string][],
    spacesRead: [] as string[],
    snapshots: new Set<string>(),
    sent: [] as [string, string][],
    opened: [] as string[],
    pages: [] as string[],
    toasts: [] as string[],
    spaceOpened: [] as string[],
    graph: 0,
  };
  let allow = true;
  let handOff = true;
  let elsewhereNow = new Set<string>();

  mock.module("sonner", () => ({
    toast: { error: (message: string) => calls.toasts.push(message) },
  }));
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
    getSpaceSnapshot: () => state,
    readProjectSpaces: async (path: string) => {
      calls.spacesRead.push(path);
      return projectSpaces[path] ?? [];
    },
    useSpaceActions: () => ({
      activateHomeRoot: async (id: string, request: { kind: string }) => {
        calls.activate.push([id, request.kind]);
        if (elsewhereNow.has(id)) return "otherWindow";
        state.activeRootId = id;
        state.activeRootPath = `/projects/${id}`;
        state.spaces = projectSpaces[`/projects/${id}`] ?? [];
        return "opened";
      },
    }),
  }));
  mock.module("@/features/home/api/home-project-actions", () => ({
    revealHomeProjectFolder: async () => {},
    copyHomeProjectPath: async () => {},
    listHomeProjectsInOtherWindows: async () => ["c"],
    listenHomeProjectWindowsChanged: async () => () => {},
  }));
  const spaceApi = { ...(await import("@/platform/space/space-api")) };
  mock.module("@/platform/space/space-api", () => ({
    ...spaceApi,
    sendProjectWindowRequest: async (id: string, request: { kind: string }) => {
      calls.sent.push([id, request.kind]);
      return handOff;
    },
  }));
  const pathApi = { ...(await import("@/platform/filesystem/path-api")) };
  mock.module("@/platform/filesystem/path-api", () => ({
    ...pathApi,
    pathExists: async (path: string) => !path.endsWith("/gone.md"),
  }));
  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => {
      calls.guard++;
      return allow;
    },
  }));
  const sidebarItems = { ...(await import("./navigation-sidebar-items")) };
  mock.module("./navigation-sidebar-items", () => ({
    ...sidebarItems,
    useOpenNavigationArtifact:
      () => async (item: { key: { spaceId?: string }; openPath?: string }) => {
        calls.opened.push(
          `${state.activeRootId}:${item.key.spaceId ?? "root"}:${item.openPath}`,
        );
      },
  }));
  const peekHost = { ...(await import("./agent-session-peek-host")) };
  mock.module("./agent-session-peek-host", () => ({
    ...peekHost,
    useOpenSessionInMainArea: () => async () => true,
  }));
  const pageNavigation = { ...(await import("@/features/page/navigation")) };
  mock.module("@/features/page/navigation", () => ({
    ...pageNavigation,
    useOpenPage:
      () =>
      (
        path: string,
        spaceId: string | undefined,
        options?: { reveal?: boolean },
      ) =>
        calls.pages.push(`${spaceId}:${path}:${options?.reveal === true}`),
  }));
  const item = (
    nodeId: string,
    spaceId: string | null,
    path: string,
    title: string,
  ) => ({
    nodeId,
    source: { spaceId, path, kind: "page" as const },
    spaceName: spaceId ?? "root",
    title,
    snippet: null,
    locationPath: null,
    lineStart: null,
    lineEnd: null,
  });
  const snapshot = (projectPath: string) => ({
    status: "complete" as const,
    nodes: [],
    edges: [],
    searchItems:
      projectPath === "/projects/b"
        ? [
            item("plan", null, "plan.md", "Plan"),
            item("guide", "b-docs", "guide.md", "Guide"),
            item("stale-space", "b-old", "old.md", "Old"),
            item("gone", null, "gone.md", "Gone"),
          ]
        : [item("notes", "a-docs", "notes.md", "Notes")],
    freshness: [],
    diagnostics: [],
    readablePools: 1,
    totalPools: 1,
    truncated: false,
    totalNodeCount: 0,
    totalEdgeCount: 0,
    omittedNodeCount: 0,
    omittedEdgeCount: 0,
    nextNodeOffset: null,
    nextEdgeOffset: null,
    hasMoreNodes: false,
    hasMoreEdges: false,
  });
  const snapshots = new Map<string, ReturnType<typeof snapshot>>();
  const knowledge = { ...(await import("@/features/knowledge")) };
  mock.module("@/features/knowledge", () => ({
    ...knowledge,
    useKnowledgeSnapshot: (projectPath: string) => {
      calls.snapshots.add(projectPath);
      if (!snapshots.has(projectPath))
        snapshots.set(projectPath, snapshot(projectPath));
      return {
        snapshot: snapshots.get(projectPath)!,
        loading: false,
        error: null,
        mode: "compact",
        projectionKey: projectPath,
        retry() {},
        repair: async () => {},
        repairing: false,
        repairError: null,
      };
    },
    useKnowledgeNeighbors: () => ({ edges: [], loading: false, error: null }),
    KnowledgeGraphView: () => null,
    KnowledgeStatus: () => null,
  }));

  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useProjectWindowsLifecycle } = await import("@/features/home");
  const { SpaceCommandPalette, useToggleCommandPalette } =
    await import("@/features/search/app-shell");
  const { HomeSearch, useOpenHomeProjectSearch } =
    await import("./home-search");
  const m = await import("@/paraglide/messages.js");
  const root = createRoot(document.getElementById("app")!);
  const trigger = document.getElementById("trigger") as HTMLButtonElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  let openSearch: ReturnType<typeof useOpenHomeProjectSearch> | null = null;
  let toggle: (() => void) | null = null;

  function Probe() {
    useProjectWindowsLifecycle();
    const open = useOpenHomeProjectSearch();
    const toggleSearch = useToggleCommandPalette();
    useEffect(() => {
      openSearch = open;
      toggle = toggleSearch;
    }, [open, toggleSearch]);
    return null;
  }
  const dialog = () => document.querySelector("[data-slot=dialog-content]");
  const result = (title: string) =>
    [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((node) =>
      node.textContent?.includes(title),
    )!;
  const hasOpenGraph = () =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === m.knowledge_graph_open(),
    );
  const reset = () => {
    state.activeRootId = "a";
    state.activeRootPath = "/projects/a";
    state.spaces = projectSpaces["/projects/a"];
    allow = true;
    handOff = true;
    elsewhereNow = new Set();
    calls.guard = 0;
    calls.activate = [];
    calls.spacesRead = [];
    calls.snapshots.clear();
    calls.sent = [];
    calls.opened = [];
    calls.pages = [];
    calls.toasts = [];
    calls.graph = 0;
  };
  const renderHome = async () => {
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Probe />
          <HomeSearch onActivateContent={() => {}} />
        </TooltipProvider>,
      ),
    );
    await act(settle);
  };
  const openFromTrigger = async (projectIndex: number) => {
    trigger.onclick = () => void openSearch!(state.rootSpaces[projectIndex]);
    trigger.focus();
    await act(async () => {
      trigger.click();
      await settle();
    });
  };
  const escape = () =>
    act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  const choose = (title: string) =>
    act(async () => {
      result(title).click();
      await settle();
    });

  test("a row opens Search of its inactive project; opening and closing change nothing", async () => {
    reset();
    await renderHome();
    expect(dialog()).toBeNull();
    await openFromTrigger(1);
    expect(dialog() === null).toBe(false);
    expect([...calls.snapshots]).toEqual(["/projects/b"]);
    expect(calls.spacesRead).toEqual(["/projects/b"]);
    expect(
      document.activeElement?.getAttribute("data-slot") === "command-input",
    ).toBe(true);
    // No full-screen Graph on Home.
    expect(hasOpenGraph()).toBe(false);
    await escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(state.activeRootId).toBe("a");
    expect(calls.activate).toEqual([]);
    expect(calls.guard).toBe(0);
    expect(calls.sent).toEqual([]);
  });

  test("⌘K searches the active project; without one nothing opens", async () => {
    reset();
    await renderHome();
    await act(async () => {
      toggle!();
      await settle();
    });
    expect([...calls.snapshots]).toEqual(["/projects/a"]);
    expect(calls.spacesRead).toEqual([]);
    await act(async () => {
      toggle!();
      await settle();
    });
    expect(dialog()).toBeNull();
    state.activeRootId = null;
    state.activeRootPath = null;
    await renderHome();
    await act(async () => {
      toggle!();
      await settle();
    });
    expect(dialog()).toBeNull();
    await act(async () => {
      toggle!();
      await settle();
    });
    expect(calls.guard).toBe(0);
    expect(calls.activate).toEqual([]);
  });

  test("a result passes the guards, a cancel keeps Search; then its project becomes active and the object opens", async () => {
    reset();
    await renderHome();
    await openFromTrigger(1);
    allow = false;
    await choose("Guide");
    expect(calls.guard).toBe(1);
    expect(calls.activate).toEqual([]);
    expect(dialog() === null).toBe(false);
    expect(state.activeRootId).toBe("a");
    allow = true;
    await choose("Guide");
    expect(calls.guard).toBe(2);
    expect(calls.activate).toEqual([["b", "open"]]);
    expect(state.activeRootId).toBe("b");
    expect(calls.opened).toEqual(["b:b-docs:guide.md"]);
    expect(dialog()).toBeNull();
    expect(calls.pages).toEqual([]);
  });

  test("a stale result shows its toast and changes nothing", async () => {
    reset();
    await renderHome();
    await openFromTrigger(1);
    await choose("Old");
    await choose("Gone");
    expect(calls.toasts).toEqual([
      m.search_space_unavailable({ name: "b-old" }),
      m.search_result_unavailable({ title: "Gone" }),
    ]);
    expect(calls.guard).toBe(0);
    expect(calls.activate).toEqual([]);
    expect(calls.opened).toEqual([]);
    expect(dialog() === null).toBe(false);
  });

  test("a project that went to another window opens the result there", async () => {
    reset();
    await renderHome();
    await openFromTrigger(1);
    elsewhereNow = new Set(["b"]);
    await choose("Plan");
    expect(calls.activate).toEqual([["b", "open"]]);
    expect(calls.opened).toEqual([]);
    expect(state.activeRootId).toBe("a");
    expect(dialog()).toBeNull();
  });

  test("a project of another window gets Search in its window; Home stays as it was", async () => {
    reset();
    await renderHome();
    await openFromTrigger(2);
    expect(calls.sent).toEqual([["c", "search"]]);
    expect(dialog()).toBeNull();
    expect(calls.activate).toEqual([]);
    expect(calls.guard).toBe(0);
    // Its window has closed meanwhile: Search opens here, the project inactive.
    handOff = false;
    await openFromTrigger(2);
    expect(dialog() === null).toBe(false);
    expect([...calls.snapshots]).toEqual(["/projects/c"]);
    expect(state.activeRootId).toBe("a");
    await escape();
  });

  test("Search in a Space keeps its result selection and Open graph", async () => {
    reset();
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Probe />
          <SpaceCommandPalette
            onBeforeNavigation={async () => {
              calls.guard++;
              return allow;
            }}
            onAfterNavigation={() => {}}
            onOpenGraph={() => calls.graph++}
          />
        </TooltipProvider>,
      ),
    );
    await act(async () => {
      toggle!();
      await settle();
    });
    expect([...calls.snapshots]).toEqual(["/projects/a"]);
    expect(hasOpenGraph()).toBe(true);
    await choose("Notes");
    expect(calls.pages).toEqual(["a-docs:notes.md:true"]);
    expect(calls.spaceOpened.at(-1)).toBe("a-docs");
    expect(calls.activate).toEqual([]);
    expect(dialog()).toBeNull();
    await act(async () => {
      toggle!();
      await settle();
    });
    const openGraph = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === m.knowledge_graph_open(),
    )!;
    await act(async () => {
      openGraph.click();
      await settle();
    });
    expect(calls.graph).toBe(1);
    expect(dialog()).toBeNull();
    await act(async () => root.unmount());
  });
}
