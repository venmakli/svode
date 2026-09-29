import { expect, test } from "bun:test";
import {
  AGENT_SESSION_CATALOG_REFRESH_INTERVALS as INTERVALS,
  startAgentSessionCatalogRefresh,
  type AgentSessionCatalogRefreshEnvironment,
} from "./catalog-refresh";
import { createAgentSessionCatalogStore } from "./catalog-store";
import {
  fakeCatalogApi,
  flushPromises,
  listedSession,
  type FakeCatalogApi,
} from "./testing/catalog";

interface FakeEnvironment extends AgentSessionCatalogRefreshEnvironment {
  advance: (ms: number) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  focus: () => Promise<void>;
  activeIntervals: () => number[];
}

function fakeEnvironment(): FakeEnvironment {
  let time = 0;
  let visible = true;
  let nextId = 0;
  const intervals = new Map<
    number,
    { callback: () => void; delayMs: number; dueAt: number }
  >();
  const listeners = new Set<() => void>();

  const env: FakeEnvironment = {
    isVisible: () => visible,
    onForegroundChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInterval: (callback, delayMs) => {
      nextId += 1;
      intervals.set(nextId, { callback, delayMs, dueAt: time + delayMs });
      return nextId;
    },
    clearInterval: (intervalId) => {
      intervals.delete(intervalId);
    },
    now: () => time,
    advance: async (ms) => {
      const end = time + ms;
      for (;;) {
        const due = [...intervals.entries()]
          .filter(([, interval]) => interval.dueAt <= end)
          .sort(([, left], [, right]) => left.dueAt - right.dueAt)[0];
        if (!due) break;
        const [id, interval] = due;
        time = interval.dueAt;
        intervals.set(id, { ...interval, dueAt: time + interval.delayMs });
        interval.callback();
        await flushPromises();
      }
      time = end;
    },
    setVisible: async (next) => {
      visible = next;
      listeners.forEach((listener) => listener());
      await flushPromises();
    },
    focus: async () => {
      listeners.forEach((listener) => listener());
      await flushPromises();
    },
    activeIntervals: () =>
      [...intervals.values()]
        .map((interval) => interval.delayMs)
        .sort((left, right) => left - right),
  };
  return env;
}

function count(api: FakeCatalogApi, prefix: string) {
  return api.calls.filter((call) => call.startsWith(prefix)).length;
}

async function startCatalog(api = fakeCatalogApi()) {
  const env = fakeEnvironment();
  const store = createAgentSessionCatalogStore(api, env.now);
  store.getState().setProject("/project");
  const stop = startAgentSessionCatalogRefresh(store, env);
  await flushPromises();
  return { api, env, store, stop };
}

test("one refresh lifecycle lists on start and polls the list while visible", async () => {
  const { api, env, stop } = await startCatalog();

  expect(count(api, "list:")).toBe(1);
  expect(env.activeIntervals()).toEqual([INTERVALS.listMs]);

  await env.advance(INTERVALS.listMs * 2);
  expect(count(api, "list:")).toBe(3);

  stop();
  expect(env.activeIntervals()).toEqual([]);
});

test("a hidden window refreshes only hot status of known live sessions", async () => {
  const api = fakeCatalogApi();
  api.listed = [
    listedSession({ id: "codex:done" }),
    listedSession({ id: "codex:working", status: "active" }),
  ];
  const { env, stop } = await startCatalog(api);
  const listsBeforeHidden = count(api, "list:");

  await env.setVisible(false);
  expect(env.activeIntervals()).toEqual([INTERVALS.hiddenHotMs]);

  const hotBefore = count(api, "hot:");
  await env.advance(INTERVALS.listMs * 2);
  expect(count(api, "list:")).toBe(listsBeforeHidden);
  expect(count(api, "hot:") > hotBefore).toBe(true);
  expect(api.calls.includes("hot:codex:done")).toBe(false);

  await env.setVisible(true);
  expect(count(api, "list:")).toBe(listsBeforeHidden + 1);
  expect(env.activeIntervals()).toEqual([INTERVALS.hotMs, INTERVALS.listMs]);
  stop();
});

test("pending and provisional records and explicit demand accelerate the list", async () => {
  const { api, env, store, stop } = await startCatalog();

  const release = store.getState().requestFastRefresh();
  await flushPromises();
  expect(count(api, "list:")).toBe(2);
  expect(env.activeIntervals()).toEqual([INTERVALS.fastListMs]);

  const secondRelease = store.getState().requestFastRefresh();
  await flushPromises();
  expect(count(api, "list:")).toBe(2);
  expect(env.activeIntervals()).toEqual([INTERVALS.fastListMs]);

  release();
  secondRelease();
  expect(env.activeIntervals()).toEqual([INTERVALS.listMs]);

  api.listed = [
    listedSession({
      id: "codex:launch:1",
      launchId: "1",
      runtime: { live: true, provisional: true, ptyId: "pty-routine" },
    }),
  ];
  await store.getState().load();
  expect(env.activeIntervals()).toEqual([
    INTERVALS.hotMs,
    INTERVALS.fastListMs,
  ]);
  stop();
});

test("returning to the foreground reloads the list after the minimal gap", async () => {
  const { api, env, stop } = await startCatalog();

  await env.focus();
  expect(count(api, "list:")).toBe(1);

  await env.advance(INTERVALS.foregroundMinGapMs);
  await env.focus();
  expect(count(api, "list:")).toBe(2);
  stop();
});
