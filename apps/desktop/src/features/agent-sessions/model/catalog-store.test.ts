import { expect, test } from "bun:test";
import {
  createAgentSessionCatalogStore,
  sessionTerminalAgentsBusy,
  sessionTerminalPtyIds,
} from "./catalog-store";
import { agentSessionTerminalFollow } from "./terminal-follow";
import type { AgentSessionScopeGroup } from "./types";
import {
  fakeCatalogApi,
  flushPromises,
  listResult,
  listedSession,
} from "./testing/catalog";

const rootScope: AgentSessionScopeGroup = {
  id: "project:/project",
  kind: "project",
  scopeId: "root",
  name: "Project",
  icon: null,
  path: "/project",
  status: "ready",
};

test("catalog coalesces concurrent full-list loads of one project", async () => {
  const api = fakeCatalogApi();
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");

  await Promise.all([
    store.getState().load(),
    store.getState().load(),
    store.getState().load({ force: true }),
  ]);

  expect(api.calls).toEqual(["list:/project"]);
  expect(store.getState().listedAt === null).toBe(false);
});

test("catalog drops a list response that arrives after a project switch", async () => {
  const api = fakeCatalogApi();
  let releaseFirst!: () => void;
  const firstList = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  api.list = async (projectPath) => {
    api.calls.push(`list:${projectPath}`);
    if (projectPath === "/old") await firstList;
    return listResult([listedSession({ id: `codex:${projectPath}` })]);
  };
  const store = createAgentSessionCatalogStore(api);

  store.getState().setProject("/old");
  const stale = store.getState().load();
  store.getState().setProject("/project");
  await store.getState().load();
  releaseFirst();
  await stale;

  expect(store.getState().sessions.map((session) => session.id)).toEqual([
    "codex:/project",
  ]);
});

test("pending new-session terminal hands off to its CLI session", async () => {
  const api = fakeCatalogApi();
  const store = createAgentSessionCatalogStore(api, () =>
    Date.parse("2026-09-29T10:00:00Z"),
  );
  store.getState().setProject("/project");
  await store.getState().load();

  const pendingId = await store
    .getState()
    .openNewSessionTerminal(rootScope, "New session");
  await flushPromises();

  expect(pendingId).toBe("new-session:pty-1");
  expect(store.getState().sessions.map((session) => session.id)).toEqual([
    "new-session:pty-1",
  ]);

  api.listed = [
    listedSession({
      id: "codex:started",
      cwd: "/project",
      lastActivityAt: "2026-09-29T10:00:03Z",
    }),
  ];
  await store.getState().load();

  const state = store.getState();
  expect(api.calls.slice(-3)).toEqual([
    "list:/project",
    "register:pty-1:codex:started",
    "list:/project",
  ]);
  expect(state.pendingHandoffs).toEqual({
    "new-session:pty-1": "codex:started",
  });
  expect(state.pendingTerminals).toEqual([]);
  expect(state.sessions.map((session) => session.id)).toEqual([
    "codex:started",
  ]);
  expect(state.sessions[0]?.runtime).toEqual({ ptyId: "pty-1", live: true });
});

test("a recognized new-session terminal takes its runtime only from the read-model", async () => {
  const api = fakeCatalogApi();
  const store = createAgentSessionCatalogStore(api, () =>
    Date.parse("2026-09-29T10:00:00Z"),
  );
  store.getState().setProject("/project");
  await store.getState().openNewSessionTerminal(rootScope, "New session");
  await flushPromises();
  api.listed = [
    listedSession({
      id: "codex:started",
      cwd: "/project",
      lastActivityAt: "2026-09-29T10:00:03Z",
    }),
  ];
  await store.getState().load();
  expect(store.getState().sessions[0]?.runtime?.ptyId).toBe("pty-1");

  // A list without the terminal surface leaves the session without runtime.
  api.surfaces.clear();
  await store.getState().load();
  expect(store.getState().sessions[0]?.runtime).toBe(undefined);
  expect(api.calls.filter((call) => call.startsWith("register:"))).toEqual([
    "register:pty-1:codex:started",
  ]);
});

test("closing a recognized new-session terminal removes the session runtime", async () => {
  const api = fakeCatalogApi();
  const store = createAgentSessionCatalogStore(api, () =>
    Date.parse("2026-09-29T10:00:00Z"),
  );
  store.getState().setProject("/project");
  await store.getState().openNewSessionTerminal(rootScope, "New session");
  await flushPromises();
  api.listed = [
    listedSession({
      id: "codex:started",
      cwd: "/project",
      lastActivityAt: "2026-09-29T10:00:03Z",
    }),
  ];
  await store.getState().load();

  await store.getState().closeTerminal("codex:started", "pty-1");

  const state = store.getState();
  expect(api.calls.includes("close:pty-1")).toBe(true);
  expect(state.sessions.map((session) => session.id)).toEqual([
    "codex:started",
  ]);
  expect(state.sessions[0]?.runtime?.ptyId).toBe(undefined);
  expect(sessionTerminalPtyIds(state).size).toBe(0);
});

test("a new-session terminal stays pending while its registration fails", async () => {
  const api = fakeCatalogApi();
  api.registerTerminal = async ({ ptyId, agentSessionId }) => {
    api.calls.push(`register:${ptyId}:${agentSessionId}`);
    throw new Error("writer refused");
  };
  const store = createAgentSessionCatalogStore(api, () =>
    Date.parse("2026-09-29T10:00:00Z"),
  );
  store.getState().setProject("/project");
  await store.getState().openNewSessionTerminal(rootScope, "New session");
  await flushPromises();
  api.listed = [
    listedSession({
      id: "codex:started",
      cwd: "/project",
      lastActivityAt: "2026-09-29T10:00:03Z",
    }),
  ];
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await store.getState().load();
  } finally {
    console.warn = warn;
  }

  const state = store.getState();
  expect(api.calls.slice(-2)).toEqual([
    "list:/project",
    "register:pty-1:codex:started",
  ]);
  expect(state.pendingHandoffs).toEqual({});
  expect(state.sessions.map((session) => session.id)).toEqual([
    "codex:started",
    "new-session:pty-1",
  ]);
  expect(state.sessions[0]?.runtime).toBe(undefined);
  expect(state.sessions[1]?.runtime?.ptyId).toBe("pty-1");
});

test("a session another terminal runs is not recognized for a new-session terminal", async () => {
  const api = fakeCatalogApi();
  const store = createAgentSessionCatalogStore(api, () =>
    Date.parse("2026-09-29T10:00:00Z"),
  );
  store.getState().setProject("/project");
  await store.getState().openNewSessionTerminal(rootScope, "New session");
  await flushPromises();
  api.listed = [
    listedSession({
      id: "codex:elsewhere",
      cwd: "/project",
      lastActivityAt: "2026-09-29T10:00:03Z",
      runtime: { ptyId: "pty-other", live: true },
    }),
  ];
  await store.getState().load();

  expect(api.calls.some((call) => call.startsWith("register:"))).toBe(false);
  expect(store.getState().pendingTerminals.map((item) => item.ptyId)).toEqual([
    "pty-1",
  ]);
});

test("re-entry result and session terminal belong to the catalog, not a screen", async () => {
  const api = fakeCatalogApi();
  const session = listedSession({ id: "codex:history" });
  api.listed = [session];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();

  await store.getState().reenter(session);
  await flushPromises();

  const state = store.getState();
  expect(state.reentryResults["codex:history"]?.ptyId).toBe(
    "pty-resume-codex:history",
  );
  expect(state.reenteringSessionIds.has("codex:history")).toBe(false);
  expect(state.sessions[0]?.runtime?.ptyId).toBe("pty-resume-codex:history");
  expect(state.sessions[0]?.runtime?.live).toBe(true);

  await store.getState().closeAllTerminals();
  expect(api.calls.includes("close:pty-resume-codex:history")).toBe(true);
  expect(store.getState().reentryResults).toEqual({});
  expect(store.getState().sessions[0]?.runtime?.ptyId).toBe(undefined);
});

test("repeated open of one session joins its re-entry instead of a second resume", async () => {
  const api = fakeCatalogApi();
  const session = listedSession({ id: "codex:history" });
  api.listed = [session];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();

  await Promise.all([
    store.getState().reenter(session),
    store.getState().reenter(session),
  ]);

  expect(api.calls.filter((call) => call.startsWith("reenter:"))).toEqual([
    "reenter:codex:history",
  ]);
});

test("observed sessions and fast-refresh demand are reference counted", () => {
  const store = createAgentSessionCatalogStore(fakeCatalogApi());

  const releaseA = store.getState().observeSession("codex:a");
  const releaseB = store.getState().observeSession("codex:a");
  const releaseDemandA = store.getState().requestFastRefresh();
  const releaseDemandB = store.getState().requestFastRefresh();
  expect(store.getState().observedSessionIds).toEqual({ "codex:a": 2 });
  expect(store.getState().fastRefreshDemand).toBe(2);

  releaseA();
  releaseA();
  releaseDemandA();
  expect(store.getState().observedSessionIds).toEqual({ "codex:a": 1 });
  expect(store.getState().fastRefreshDemand).toBe(1);

  releaseB();
  releaseDemandB();
  expect(store.getState().observedSessionIds).toEqual({});
  expect(store.getState().fastRefreshDemand).toBe(0);
});

test("an exited session terminal stops being live for every consumer", async () => {
  const api = fakeCatalogApi();
  const listed = listedSession({
    id: "codex:live",
    runtime: { live: true, ptyId: "pty-listed" },
  });
  const history = listedSession({ id: "codex:history" });
  api.listed = [listed, history];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();
  await store.getState().reenter(history);
  const pendingId = await store
    .getState()
    .openNewSessionTerminal(rootScope, "New session");
  await flushPromises();

  api.listed = [{ ...listed, runtime: { live: false } }, history];
  api.surfaces.clear();
  store.getState().releaseTerminal("pty-listed");
  store.getState().releaseTerminal("pty-resume-codex:history");
  store.getState().releaseTerminal("pty-1");
  await flushPromises();

  const state = store.getState();
  expect(state.sessions.map((session) => session.id)).toEqual([
    "codex:live",
    "codex:history",
  ]);
  expect(state.sessions.every((session) => !session.runtime?.ptyId)).toBe(true);
  expect(state.reentryResults).toEqual({});
  expect(pendingId).toBe("new-session:pty-1");
  expect(api.calls.some((call) => call.startsWith("close:"))).toBe(false);
});

test("an unknown terminal exit leaves the catalog untouched", async () => {
  const api = fakeCatalogApi();
  api.listed = [listedSession({ id: "codex:a" })];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();
  const before = store.getState().sessions;

  store.getState().releaseTerminal("pty-shell");

  expect(store.getState().sessions).toBe(before);
  expect(api.calls).toEqual(["list:/project"]);
});

test("loading a target reads a list that started after the request", async () => {
  const api = fakeCatalogApi();
  let releaseFirst!: () => void;
  const firstList = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let lists = 0;
  api.list = async (projectPath) => {
    api.calls.push(`list:${projectPath}`);
    lists += 1;
    const listed = api.listed;
    if (lists === 1) await firstList;
    return listResult(listed);
  };
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  const polling = store.getState().load();

  // A routine launch dispatched while an older list is still running.
  api.listed = [listedSession({ id: "codex:launched", launchId: "launch-1" })];
  const opening = store
    .getState()
    .loadTarget({ sessionId: "codex:launched", launchId: "launch-1" });
  releaseFirst();
  await Promise.all([polling, opening]);

  expect(api.calls).toEqual(["list:/project", "list:/project"]);
  expect(store.getState().sessions.map((session) => session.id)).toEqual([
    "codex:launched",
  ]);
});

test("session terminals count each PTY once and leave shell tabs out", async () => {
  const api = fakeCatalogApi();
  const history = listedSession({ id: "codex:history" });
  // A terminal panel tab the read-model recognizes as an agent session.
  const panelTab = listedSession({
    id: "claude:panel",
    runtime: { ptyId: "pty-panel", live: true },
  });
  api.listed = [history, panelTab];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();
  await store.getState().reenter(history);
  await store.getState().openNewSessionTerminal(rootScope, "New session");
  await flushPromises();

  expect([...sessionTerminalPtyIds(store.getState())].sort()).toEqual([
    "pty-1",
    "pty-panel",
    "pty-resume-codex:history",
  ]);
  expect(sessionTerminalAgentsBusy(store.getState())).toBe(false);

  api.listed = [
    history,
    {
      ...panelTab,
      status: {
        state: "running",
        source: "native_status_reader",
        confidence: "approximate",
      },
    },
  ];
  await store.getState().load({ force: true });
  expect(sessionTerminalAgentsBusy(store.getState())).toBe(true);

  // A closed PTY is no longer reported as the runtime of its session.
  api.listed = [history, { ...panelTab, runtime: undefined }];
  await store.getState().closeAllTerminals();
  expect(sessionTerminalPtyIds(store.getState()).size).toBe(0);
  expect(api.calls.filter((call) => call.startsWith("close:")).sort()).toEqual([
    "close:pty-1",
    "close:pty-panel",
    "close:pty-resume-codex:history",
  ]);
});

test("a hot status that takes a terminal without naming its new session keeps it until the full list it starts", async () => {
  const api = fakeCatalogApi();
  const old = listedSession({ id: "claude:old", source: "claude" });
  api.listed = [old];
  api.surfaces.set("pty-1", "claude:old");
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();
  const followed: (string | undefined)[] = [];
  store.subscribe((state, previous) => {
    const follow = agentSessionTerminalFollow(previous, state);
    if (follow) {
      followed.push(follow({ sessionId: "claude:old", launchId: null })?.sessionId);
    }
  });

  // The agent in the terminal went on to a session the catalog has not read.
  api.listed = [old, listedSession({ id: "claude:new", source: "claude" })];
  api.surfaces.set("pty-1", "claude:new");
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const list = api.list;
  api.list = async (projectPath) => {
    await listGate;
    return list(projectPath);
  };
  await store.getState().loadHotStatus(["claude:old"]);
  const runtimeOf = (id: string) =>
    store.getState().sessions.find((session) => session.id === id)?.runtime;
  expect(runtimeOf("claude:old")?.ptyId).toBe("pty-1");

  releaseList();
  await flushPromises();
  expect(api.calls).toEqual(["list:/project", "hot:claude:old", "list:/project"]);
  expect(runtimeOf("claude:old")).toBe(undefined);
  expect(runtimeOf("claude:new")?.ptyId).toBe("pty-1");
  expect(followed).toEqual(["claude:new"]);
});

test("a re-entry terminal the read-model lists at another session leaves the resumed session", async () => {
  const api = fakeCatalogApi();
  const history = listedSession({ id: "claude:history", source: "claude" });
  api.listed = [history];
  const store = createAgentSessionCatalogStore(api);
  store.getState().setProject("/project");
  await store.getState().load();
  await store.getState().reenter(history);
  await flushPromises();
  const ptyId = "pty-resume-claude:history";
  expect(store.getState().reentryResults["claude:history"]?.ptyId).toBe(ptyId);

  api.listed = [
    history,
    listedSession({
      id: "claude:new",
      source: "claude",
      status: {
        state: "running",
        source: "native_status_reader",
        confidence: "exact",
      },
    }),
  ];
  api.surfaces.set(ptyId, "claude:new");
  await store.getState().load();

  const state = store.getState();
  expect(state.reentryResults).toEqual({});
  expect(
    state.sessions.map((session) => [session.id, session.runtime?.ptyId]),
  ).toEqual([
    ["claude:history", undefined],
    ["claude:new", ptyId],
  ]);
  expect([...sessionTerminalPtyIds(state)]).toEqual([ptyId]);
  expect(sessionTerminalAgentsBusy(state)).toBe(true);
});
