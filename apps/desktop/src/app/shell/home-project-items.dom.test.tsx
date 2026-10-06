import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_HOME_PROJECT_ITEMS_DOM !== "1") {
  test("Home project items DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_HOME_PROJECT_ITEMS_DOM: "1" },
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

  type Item = { key: Record<string, string>; title: string };
  interface ProjectData {
    pinned: Item[];
    kept: Item[];
    sessions: unknown[];
  }
  const page = (path: string): Item => ({
    key: { kind: "page", path },
    title: path,
  });
  const running = (id: string, title: string) => ({
    id,
    source: "codex",
    sourceSessionId: id,
    title,
    titleSource: "cli-title",
    status: {
      state: "running",
      source: "native_status_reader",
      confidence: "approximate",
    },
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    lastActivityAt: "2026-10-06T10:00:00Z",
    capabilities: { canResume: false, canOpenInChat: true },
  });
  let data: Record<string, ProjectData> = {};
  let failReads = false;
  let failSessions = false;
  const commands: [string, Record<string, unknown>][] = [];
  const stateOf = (path: string) => ({
    pinned: data[path].pinned,
    kept: data[path].kept,
  });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        commands.push([command, args]);
        const path = args.projectPath as string;
        switch (command) {
          case "navigation_read":
            if (failReads) throw new Error("unreadable");
            return stateOf(path);
          case "navigation_unkeep":
            data[path].kept = data[path].kept.filter(
              (item) =>
                !(args.keys as Item["key"][]).some(
                  (key) => key.path === item.key.path,
                ),
            );
            return stateOf(path);
          case "navigation_pin": {
            const item = args.item as Item;
            data[path].kept = data[path].kept.filter(
              (kept) => kept.key.path !== item.key.path,
            );
            data[path].pinned = [...data[path].pinned, item];
            return stateOf(path);
          }
          case "agent_sessions_list_saved":
            if (failReads || failSessions) throw new Error("unreadable");
            return {
              status: "ok",
              generatedAt: "",
              projectPath: path,
              sessions: data[path].sessions,
              sources: [],
              summary: {},
              cache: { mode: "current" },
            };
          case "list_spaces":
            return [];
          default:
            return [];
        }
      },
      transformCallback: () => 0,
    },
  });

  const project = (id: string, status: "ready" | "missing" = "ready") => ({
    id,
    name: id.toUpperCase(),
    icon: "",
    description: "",
    path: `/projects/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status,
    lfsState: "n/a" as const,
  });
  const spaceState = {
    activeRootId: "active" as string | null,
    activeRootPath: "/projects/active" as string | null,
    activeSpaceId: null,
    spaces: [],
    openSpace: async () => {},
    clearActiveSpace() {},
  };
  let allow = true;
  let otherWindows: string[] = [];
  const calls = {
    guard: 0,
    activate: [] as [string, unknown][],
    opened: [] as string[],
    sessions: [] as string[],
  };
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (value: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
    getSpaceSnapshot: () => spaceState,
    useSpaceActions: () => ({
      activateHomeRoot: async (id: string, request: unknown) => {
        calls.activate.push([id, request]);
        if (otherWindows.includes(id)) return "otherWindow";
        return "opened";
      },
    }),
  }));
  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => {
      calls.guard++;
      return allow;
    },
  }));
  const items = { ...(await import("./navigation-sidebar-items")) };
  mock.module("./navigation-sidebar-items", () => ({
    ...items,
    useOpenNavigationArtifact:
      ({
        onBeforeNavigation,
      }: {
        onBeforeNavigation: () => Promise<boolean>;
      }) =>
      async (item: Item) => {
        if (await onBeforeNavigation()) calls.opened.push(item.title);
      },
  }));
  const peekHost = { ...(await import("./agent-session-peek-host")) };
  mock.module("./agent-session-peek-host", () => ({
    ...peekHost,
    useOpenSessionInMainArea:
      () =>
      async (
        target: { sessionId: string },
        _session: unknown,
        options: { guarded?: boolean },
      ) => {
        if (options.guarded) calls.sessions.push(target.sessionId);
        return true;
      },
  }));

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { HomeProjectItems } = await import("./home-project-items");
  const m = await import("@/paraglide/messages.js");
  const root = createRoot(document.getElementById("app")!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  type Availability = "available" | "otherWindow" | "missing" | "broken";
  async function render(
    id: string,
    availability: Availability = "available",
    status: "ready" | "missing" = "ready",
  ) {
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <TooltipProvider delayDuration={0}>
          <SidebarProvider>
            <ul>
              <HomeProjectItems
                project={project(id, status)}
                availability={availability}
                onActivateContent={() => {}}
                onBeforeNavigation={async () => true}
              />
            </ul>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await act(settle);
  }
  const rows = () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-sidebar=menu-button]",
      ),
    ].map((button) => button.textContent ?? "");
  const row = (title: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-sidebar=menu-button]",
      ),
    ].find((button) => button.textContent?.startsWith(title))!;
  const text = () => document.body.textContent ?? "";
  function reset(next: Record<string, ProjectData>) {
    data = next;
    failReads = false;
    failSessions = false;
    allow = true;
    otherWindows = [];
    calls.guard = 0;
    calls.activate = [];
    calls.opened = [];
    calls.sessions = [];
    commands.length = 0;
  }
  const notes = () => ({
    pinned: [page("roadmap.md")],
    kept: [
      page("plan.md"),
      { key: { kind: "session", sessionId: "codex:w" }, title: "Work" },
    ],
    sessions: [running("codex:w", "Work")],
  });

  test("an inactive project lists its pins, then active sessions and kept objects, each once", async () => {
    reset({ "/projects/notes": notes() });
    await render("notes");
    // A pinned row names its pin; the mark shows in the badge slot.
    expect(rows()).toEqual([
      `roadmap.md${m.navigation_pinned_item()}`,
      `Work${m.sessions_status_running()}`,
      "plan.md",
    ]);
    // The project is read apart from its runtime: no full catalog read.
    const names = commands.map(([command]) => command);
    expect(names.includes("navigation_read")).toBe(true);
    expect(names.includes("agent_sessions_list_saved")).toBe(true);
    expect(names.includes("agent_sessions_list")).toBe(false);
    expect(names.includes("agent_sessions_refresh")).toBe(false);
  });

  test("an object opens after the guard by activating its project", async () => {
    reset({ "/projects/notes": notes() });
    await render("notes");
    allow = false;
    await act(async () => row("plan.md").click());
    await act(settle);
    expect(calls.activate).toEqual([]);
    expect(calls.opened).toEqual([]);

    allow = true;
    await act(async () => row("plan.md").click());
    await act(settle);
    expect(calls.activate).toEqual([
      ["notes", { kind: "open", item: page("plan.md") }],
    ]);
    expect(calls.opened).toEqual(["plan.md"]);
    // The guard passed once: the opening does not ask again.
    expect(calls.guard).toBe(2);

    await act(async () => row("Work").click());
    await act(settle);
    expect(calls.sessions).toEqual(["codex:w"]);
  });

  test("an object of a project in another window opens there, past this guard", async () => {
    reset({ "/projects/notes": notes() });
    otherWindows = ["notes"];
    await render("notes", "otherWindow");
    await act(async () => row("plan.md").click());
    await act(settle);
    expect(calls.guard).toBe(0);
    expect(calls.activate).toEqual([
      ["notes", { kind: "open", item: page("plan.md") }],
    ]);
    expect(calls.opened).toEqual([]);
  });

  test("menu actions change the project's own navigation state", async () => {
    reset({ "/projects/notes": notes() });
    await render("notes");
    const close = document.querySelector<HTMLButtonElement>(
      `[aria-label='${m.navigation_close_item({ title: "plan.md" })}']`,
    )!;
    await act(async () => close.click());
    await act(settle);
    expect(rows().some((title) => title.startsWith("plan.md"))).toBe(false);
    expect(
      commands.find(([command]) => command === "navigation_unkeep")?.[1]
        .projectPath,
    ).toBe("/projects/notes");
  });

  test("an empty project says so in a muted row", async () => {
    reset({ "/projects/empty": { pinned: [], kept: [], sessions: [] } });
    await render("empty");
    expect(rows()).toEqual([]);
    expect(text().includes(m.home_project_items_empty())).toBe(true);
  });

  test("a failed read offers Retry", async () => {
    reset({ "/projects/notes": notes() });
    failReads = true;
    await render("notes");
    expect(text().includes(m.home_project_items_failed())).toBe(true);
    failReads = false;
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === m.app_retry(),
    )!;
    await act(async () => retry.click());
    await act(settle);
    expect(text().includes(m.home_project_items_failed())).toBe(false);
    expect(rows().length).toBe(3);
  });

  test("a failed session read offers Retry once the navigation is read", async () => {
    reset({ "/projects/notes": notes() });
    failSessions = true;
    await render("notes");
    expect(text().includes(m.home_project_items_failed())).toBe(true);
    failSessions = false;
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === m.app_retry(),
    )!;
    await act(async () => retry.click());
    await act(settle);
    expect(rows().length).toBe(3);
  });

  test("an unavailable project shows why and reads nothing", async () => {
    reset({});
    await render("gone", "missing", "missing");
    expect(text().includes(m.home_project_missing())).toBe(true);
    expect(commands).toEqual([]);
  });
}
