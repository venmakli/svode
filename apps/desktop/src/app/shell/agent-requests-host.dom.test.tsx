import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_AGENT_REQUESTS_DOM !== "1") {
  test("agent requests host DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_REQUESTS_DOM: "1" },
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

  let chatAvailable = true;
  let contentAllows = true;
  const put: { place: string; text: string; mark: string }[] = [];
  const openedSpaces: (string | null)[] = [];
  const spaceState = {
    activeRootPath: "/project",
    spaces: [
      { id: "docs", path: "/project/docs", status: "ready" },
      { id: "broken", path: "/project/broken", status: "broken" },
    ],
    openSpace: async (spaceId: string) => openedSpaces.push(spaceId),
    clearActiveSpace: () => openedSpaces.push(null),
  };

  mock.module("@/features/agent-sessions", () => ({
    AgentSessionPeek: () => null,
    requestComposerFocus: () => ({ opener: null }),
    useOpenNewSession: () => async () => null,
    canOpenChatSession: async () => chatAvailable,
    putSessionRequest: (sessionId: string, text: string, mark: string) =>
      put.push({ place: `session:${sessionId}`, text, mark }),
    putNewSessionRequest: (spacePath: string, text: string, mark: string) =>
      put.push({ place: `new:${spacePath}`, text, mark }),
  }));
  mock.module("@/features/artifact", () => ({
    prepareActiveContentDeactivation: async () =>
      contentAllows ? "ready" : "blocked",
  }));
  mock.module("@/features/space", () => ({
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector: (state: unknown) => unknown) => selector(spaceState),
  }));
  mock.module("./open-session-routine", () => ({
    useOpenSessionRoutine: () => () => {},
  }));
  type Requests = import("@/features/git").AgentRequests;
  let registered: Requests | null = null;
  mock.module("@/features/git/app-shell", () => ({
    registerAgentRequests: (next: Requests) => {
      registered = next;
      return () => {
        if (registered === next) registered = null;
      };
    },
  }));
  const agentRequests = () => registered;

  const { useShellStore } = await import("./model");
  const { AgentRequestsHost } = await import("./agent-requests-host");
  const root = createRoot(document.getElementById("app")!);

  async function reset() {
    chatAvailable = true;
    contentAllows = true;
    put.length = 0;
    openedSpaces.length = 0;
    await act(async () => {
      useShellStore.setState({
        mainSurface: "content",
        mainSessionTarget: null,
        mainSessionDraft: null,
      });
      root.render(<AgentRequestsHost />);
    });
  }

  const request = (place: {
    spacePath: string;
    sessionId?: string | null;
  }) => ({
    ...place,
    text: "Commit the changes",
    mark: "agent_commits" as const,
  });

  test("outside a session window the request opens a new chat session draft of the Space in the main area", async () => {
    await reset();
    const requests = agentRequests()!;
    expect(await requests.available({ spacePath: "/project/docs" })).toBe(true);
    let submitted = false;
    await act(async () => {
      submitted = await requests.submit(
        request({ spacePath: "/project/docs" }),
      );
    });
    expect(submitted).toBe(true);
    expect(put).toEqual([
      {
        place: "new:/project/docs",
        text: "Commit the changes",
        mark: "agent_commits",
      },
    ]);
    expect(openedSpaces).toEqual(["docs"]);
    const state = useShellStore.getState();
    expect(state.mainSurface).toBe("session");
    expect(state.mainSessionDraft?.spacePath).toBe("/project/docs");

    // The draft of that Space already in the main area takes the next one.
    const draft = state.mainSessionDraft;
    await act(async () => {
      await requests.submit(request({ spacePath: "/project/docs" }));
    });
    expect(put.length).toBe(2);
    expect(useShellStore.getState().mainSessionDraft).toBe(draft);
    expect(openedSpaces).toEqual(["docs"]);
  });

  test("in a session window the request goes to that session's composer", async () => {
    await reset();
    const requests = agentRequests()!;
    chatAvailable = false;
    const place = { spacePath: "/project", sessionId: "codex:s1" };
    expect(await requests.available(place)).toBe(true);
    await act(async () => {
      await requests.submit(request(place));
    });
    expect(put).toEqual([
      {
        place: "session:codex:s1",
        text: "Commit the changes",
        mark: "agent_commits",
      },
    ]);
    expect(useShellStore.getState().mainSurface).toBe("content");
  });

  test("without a chat agent, a ready Space or a passed guard nothing opens", async () => {
    await reset();
    const requests = agentRequests()!;
    chatAvailable = false;
    expect(await requests.available({ spacePath: "/project" })).toBe(false);
    expect(await requests.submit(request({ spacePath: "/project" }))).toBe(
      false,
    );

    chatAvailable = true;
    expect(await requests.available({ spacePath: "/project/broken" })).toBe(
      false,
    );
    expect(
      await requests.submit(request({ spacePath: "/project/broken" })),
    ).toBe(false);

    contentAllows = false;
    let submitted = true;
    await act(async () => {
      submitted = await requests.submit(request({ spacePath: "/project" }));
    });
    expect(submitted).toBe(false);
    expect(put).toEqual([]);
    expect(useShellStore.getState().mainSurface).toBe("content");
  });
}
