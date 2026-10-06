import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_HOME_WORKSPACE_DOM !== "1") {
  test("Home workspace DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_HOME_WORKSPACE_DOM: "1" },
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
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const project = (
    id: string,
    lastOpened: string,
    status: "ready" | "missing" = "ready",
  ) => ({
    id,
    name: id.toUpperCase(),
    icon: "",
    description: "",
    path: `/projects/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened,
    status,
    lfsState: "n/a" as const,
  });
  type Project = ReturnType<typeof project>;
  const state = {
    rootSpaces: [] as Project[],
    activeRootId: null as string | null,
    activeRootPath: null as string | null,
    clearActiveSpace() {},
  };
  let otherWindows: string[] = [];
  let allow = true;
  const calls = {
    guard: 0,
    activate: [] as [string, string][],
  };
  let requestHandler: ((request: { kind: string }) => void) | null = null;

  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
    getSpaceSnapshot: () => state,
    useSpaceActions: () => ({
      activateHomeRoot: async (id: string, request: { kind: string }) => {
        calls.activate.push([id, request.kind]);
        if (otherWindows.includes(id)) return "otherWindow";
        state.activeRootId = id;
        state.activeRootPath = `/projects/${id}`;
        return "opened";
      },
    }),
  }));
  mock.module("@/features/home/api/home-project-actions", () => ({
    revealHomeProjectFolder: async () => {},
    copyHomeProjectPath: async () => {},
    listHomeProjectsInOtherWindows: async () => otherWindows,
    listenHomeProjectWindowsChanged: async () => () => {},
  }));
  const spaceApi = { ...(await import("@/platform/space/space-api")) };
  mock.module("@/platform/space/space-api", () => ({
    ...spaceApi,
    listenProjectWindowRequest: async (
      handler: (request: { kind: string }) => void,
    ) => {
      requestHandler = handler;
      return () => {};
    },
  }));
  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => {
      calls.guard++;
      return allow;
    },
  }));

  const { useShellStore } = await import("./model");
  const {
    HomeEntry,
    HomeMainPlaceholder,
    useHomeDraftSpaceChoices,
    useProjectWindowRequests,
    useStartHomeChat,
  } = await import("./home-workspace");
  const m = await import("@/paraglide/messages.js");
  const root = createRoot(document.getElementById("app")!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const draftPath = () => useShellStore.getState().mainSessionDraft?.spacePath;
  let startChat: ReturnType<typeof useStartHomeChat> | null = null;
  let choices: ReturnType<typeof useHomeDraftSpaceChoices> | null = null;

  function Probe() {
    const start = useStartHomeChat();
    const draftChoices = useHomeDraftSpaceChoices();
    useProjectWindowRequests();
    useEffect(() => {
      startChat = start;
      choices = draftChoices;
    }, [start, draftChoices]);
    return null;
  }
  async function render(projects: Project[]) {
    state.rootSpaces = projects;
    await act(async () => root.render(null));
    useShellStore.getState().openContentSurface();
    await act(async () =>
      root.render(
        <>
          <HomeEntry />
          <Probe />
          <HomeMainPlaceholder />
        </>,
      ),
    );
    await act(settle);
  }
  function reset(active: string | null) {
    state.activeRootId = active;
    state.activeRootPath = active ? `/projects/${active}` : null;
    calls.activate = [];
    calls.guard = 0;
    allow = true;
  }
  const projects = [
    project("a", "2026-10-06T00:00:00Z"),
    project("b", "2026-10-05T00:00:00Z", "missing"),
    project("c", "2026-10-04T00:00:00Z"),
    project("d", "2026-10-01T00:00:00Z"),
  ];

  test("without an active project Home takes the first available one with a new chat", async () => {
    reset(null);
    otherWindows = ["a"];
    await render(projects);
    expect(calls.activate).toEqual([["c", "focus"]]);
    expect(draftPath()).toBe("/projects/c");
    expect(calls.guard).toBe(0);
  });

  test("entering Home with an active project opens a new chat with it", async () => {
    reset("d");
    otherWindows = [];
    await render(projects);
    expect(calls.activate).toEqual([]);
    expect(draftPath()).toBe("/projects/d");
  });

  test("Start chat passes the guard, activates the project and opens its chat", async () => {
    reset("d");
    otherWindows = ["a"];
    await render(projects);
    allow = false;
    await act(async () => startChat!(projects[2]));
    expect(calls.activate).toEqual([]);
    expect(draftPath()).toBe("/projects/d");
    allow = true;
    await act(async () => startChat!(projects[2]));
    expect(calls.activate).toEqual([["c", "newChat"]]);
    expect(draftPath()).toBe("/projects/c");
    // A project of another window takes the chat there, past this guard.
    const guard = calls.guard;
    await act(async () => startChat!(projects[0]));
    expect(calls.guard).toBe(guard);
    expect(calls.activate.at(-1)).toEqual(["a", "newChat"]);
    expect(draftPath()).toBe("/projects/c");
  });

  test("the composer lists only the projects, inactive ones with their reason", async () => {
    reset("d");
    otherWindows = ["a"];
    await render(projects);
    expect(
      choices!.choices.map((choice) => [choice.name, choice.unavailable]),
    ).toEqual([
      ["A", m.home_project_other_window()],
      ["B", m.home_project_missing()],
      ["C", null],
      ["D", null],
    ]);
    expect(choices!.choices.every((choice) => choice.kind === "project")).toBe(
      true,
    );
    let moved = false;
    await act(async () => {
      moved = await choices!.choose("/projects/d");
    });
    expect(moved).toBe(true);
    expect(calls.guard).toBe(0);
    allow = false;
    await act(async () => {
      moved = await choices!.choose("/projects/c");
    });
    expect(moved).toBe(false);
    expect(calls.activate).toEqual([]);
    allow = true;
    await act(async () => {
      moved = await choices!.choose("/projects/c");
    });
    expect(moved).toBe(true);
    expect(calls.activate).toEqual([["c", "newChat"]]);
  });

  test("without an available project the main area tells why", async () => {
    reset(null);
    otherWindows = ["a", "c", "d"];
    await render(projects);
    expect(calls.activate).toEqual([]);
    expect(
      (document.body.textContent ?? "").includes(
        m.home_chat_no_project_title(),
      ),
    ).toBe(true);
    expect(
      (document.body.textContent ?? "").includes(
        m.home_chat_no_project_mixed(),
      ),
    ).toBe(true);
    await render([projects[0], projects[2]]);
    expect(
      (document.body.textContent ?? "").includes(
        m.home_chat_no_project_other_windows(),
      ),
    ).toBe(true);
  });

  test("a chat another window hands over opens after this window's guard", async () => {
    reset("d");
    otherWindows = [];
    await render(projects);
    useShellStore.getState().openContentSurface();
    allow = false;
    await act(async () => {
      requestHandler!({ kind: "newChat" });
      await settle();
    });
    expect(draftPath()).toBe(undefined);
    allow = true;
    await act(async () => {
      requestHandler!({ kind: "newChat" });
      await settle();
    });
    expect(draftPath()).toBe("/projects/d");
  });
}
