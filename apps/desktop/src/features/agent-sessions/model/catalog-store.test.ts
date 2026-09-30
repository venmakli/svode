import { expect, test } from "bun:test";
import {
  createAgentSessionCatalogStore,
  sessionTerminalAgentsBusy,
  sessionTerminalPtyIds,
} from "./catalog-store";
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
  expect(state.pendingHandoffs).toEqual({
    "new-session:pty-1": "codex:started",
  });
  expect(state.pendingTerminals).toEqual([]);
  expect(state.terminals["codex:started"]?.ptyId).toBe("pty-1");
  expect(state.sessions.map((session) => session.id)).toEqual([
    "codex:started",
  ]);
  expect(state.sessions[0]?.runtime?.ptyId).toBe("pty-1");
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
  expect(state.terminals["codex:history"]?.ptyId).toBe(
    "pty-resume-codex:history",
  );
  expect(state.reenteringSessionIds.has("codex:history")).toBe(false);
  expect(state.sessions[0]?.runtime?.ptyId).toBe("pty-resume-codex:history");
  expect(state.sessions[0]?.runtime?.live).toBe(true);

  await store.getState().closeAllTerminals();
  expect(api.calls.includes("close:pty-resume-codex:history")).toBe(true);
  expect(store.getState().terminals).toEqual({});
  expect(store.getState().reentryResults).toEqual({});
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
  expect(state.terminals).toEqual({});
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
