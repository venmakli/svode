import { expect, test } from "bun:test";
import type { NavigationStateDto } from "../api/navigation";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
  type NavigationPinnedItem,
} from "./keys";
import {
  createNavigationStore,
  type NavigationStateApi,
} from "./navigation-store";

function sessionItem(sessionId: string): NavigationItem {
  return { key: { kind: "session", sessionId }, title: sessionId };
}

/** In-memory Desktop owner: every operation answers with the whole state. */
function fakeApi() {
  const files = new Map<string, NavigationPinnedItem[]>();
  const calls: string[] = [];
  const state = (projectPath: string): NavigationStateDto => ({
    pinned: [...(files.get(projectPath) ?? [])],
  });
  const api: NavigationStateApi & { calls: string[] } = {
    calls,
    read: async (projectPath) => {
      calls.push(`read:${projectPath}`);
      return state(projectPath);
    },
    pin: async (projectPath, item) => {
      calls.push(`pin:${projectPath}:${navigationKeyId(item.key)}`);
      const pinned = (files.get(projectPath) ?? []).filter(
        (current) => navigationKeyId(current.key) !== navigationKeyId(item.key),
      );
      files.set(projectPath, [...pinned, item]);
      return state(projectPath);
    },
    forget: async (projectPath, keys) => {
      const ids = new Set(keys.map(navigationKeyId));
      calls.push(`forget:${projectPath}:${[...ids].join(",")}`);
      files.set(
        projectPath,
        (files.get(projectPath) ?? []).filter(
          (item) => !ids.has(navigationKeyId(item.key)),
        ),
      );
      return state(projectPath);
    },
  };
  return { api, files };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test("pins follow pin order and are read back for the project", async () => {
  const { api, files } = fakeApi();
  files.set("/project", [sessionItem("codex:old")]);
  const store = createNavigationStore(api);

  store.getState().setProject("/project");
  await flush();
  expect(store.getState().loaded).toBe(true);

  await store.getState().pin(sessionItem("codex:a"));
  await store.getState().pin(sessionItem("claude-code:b"));
  await store.getState().unpin({ kind: "session", sessionId: "codex:old" });

  expect(store.getState().pinned.map((item) => item.title)).toEqual([
    "codex:a",
    "claude-code:b",
  ]);

  const reopened = createNavigationStore(api);
  reopened.getState().setProject("/project");
  await flush();
  expect(reopened.getState().pinned).toEqual(store.getState().pinned);
});

test("an answer from before a project switch is dropped", async () => {
  const { api, files } = fakeApi();
  files.set("/other", [sessionItem("codex:other")]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = api.read;
  api.read = async (projectPath) => {
    if (projectPath === "/old") await blocked;
    return read(projectPath);
  };
  files.set("/old", [sessionItem("codex:old")]);
  const store = createNavigationStore(api);

  store.getState().setProject("/old");
  store.getState().setProject("/other");
  await flush();
  release();
  await flush();

  expect(store.getState().projectPath).toBe("/other");
  expect(store.getState().pinned.map((item) => item.title)).toEqual([
    "codex:other",
  ]);
});

test("a late initial read does not undo a pin made while it was loading", async () => {
  const { api } = fakeApi();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = api.read;
  api.read = async (projectPath) => {
    const state = await read(projectPath);
    await blocked;
    return state;
  };
  const store = createNavigationStore(api);

  store.getState().setProject("/project");
  await store.getState().pin(sessionItem("codex:a"));
  release();
  await flush();

  expect(store.getState().pinned.map((item) => item.title)).toEqual([
    "codex:a",
  ]);
});

test("pending keys cover the pin in flight and a failed pin rejects", async () => {
  const { api } = fakeApi();
  let fail!: (error: Error) => void;
  api.pin = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  const key: NavigationKey = { kind: "session", sessionId: "codex:a" };
  const pinning = store.getState().pin(sessionItem("codex:a"));
  expect(store.getState().pendingKeyIds.has(navigationKeyId(key))).toBe(true);
  fail(new Error("disk full"));

  const error = await pinning.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect((error as Error | null)?.message).toBe("disk full");
  expect(store.getState().pendingKeyIds.size).toBe(0);
  expect(store.getState().pinned).toEqual([]);
});

test("forget drops only the given keys and ignores an empty request", async () => {
  const { api, files } = fakeApi();
  files.set("/project", [sessionItem("codex:a"), sessionItem("codex:b")]);
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  await store.getState().forget([]);
  await store.getState().forget([{ kind: "session", sessionId: "codex:a" }]);

  expect(api.calls.filter((call) => call.startsWith("forget")).length).toBe(1);
  expect(store.getState().pinned.map((item) => item.title)).toEqual([
    "codex:b",
  ]);
});

test("refresh shows what Desktop resolved since the last answer", async () => {
  const { api, files } = fakeApi();
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  files.set("/project", [{ ...sessionItem("codex:a"), available: false }]);
  await store.getState().refresh();

  expect(store.getState().pinned).toEqual([
    { ...sessionItem("codex:a"), available: false },
  ]);
});

test("unpin forgets the stored key of the same artifact in another form", async () => {
  const { api, files } = fakeApi();
  files.set("/project", [
    { key: { kind: "collection", spaceId: "s", path: "tasks" }, title: "T" },
  ]);
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  await store.getState().unpin({ kind: "page", spaceId: "s", path: "tasks" });

  expect(store.getState().pinned).toEqual([]);
});
