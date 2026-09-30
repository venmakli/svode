import { expect, test } from "bun:test";
import type { NavigationStateDto } from "../api/navigation";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
  type NavigationResolvedItem,
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
  const files = new Map<string, NavigationResolvedItem[]>();
  const keptFiles = new Map<string, NavigationResolvedItem[]>();
  const calls: string[] = [];
  const state = (projectPath: string): NavigationStateDto => ({
    pinned: [...(files.get(projectPath) ?? [])],
    kept: [...(keptFiles.get(projectPath) ?? [])],
  });
  const without = (
    list: Map<string, NavigationResolvedItem[]>,
    projectPath: string,
    keys: NavigationKey[],
  ) => {
    const ids = new Set(keys.map(navigationKeyId));
    list.set(
      projectPath,
      (list.get(projectPath) ?? []).filter(
        (item) => !ids.has(navigationKeyId(item.key)),
      ),
    );
  };
  const listed = (
    list: Map<string, NavigationResolvedItem[]>,
    projectPath: string,
    item: NavigationItem,
  ) =>
    (list.get(projectPath) ?? []).some(
      (current) => navigationKeyId(current.key) === navigationKeyId(item.key),
    );
  const api: NavigationStateApi & { calls: string[] } = {
    calls,
    read: async (projectPath) => {
      calls.push(`read:${projectPath}`);
      return state(projectPath);
    },
    pin: async (projectPath, item) => {
      calls.push(`pin:${projectPath}:${navigationKeyId(item.key)}`);
      without(keptFiles, projectPath, [item.key]);
      without(files, projectPath, [item.key]);
      files.set(projectPath, [...(files.get(projectPath) ?? []), item]);
      return state(projectPath);
    },
    keep: async (projectPath, item) => {
      calls.push(`keep:${projectPath}:${navigationKeyId(item.key)}`);
      if (
        !listed(files, projectPath, item) &&
        !listed(keptFiles, projectPath, item)
      ) {
        keptFiles.set(projectPath, [
          ...(keptFiles.get(projectPath) ?? []),
          item,
        ]);
      }
      return state(projectPath);
    },
    unpin: async (projectPath, keys) => {
      calls.push(`unpin:${projectPath}:${keys.map(navigationKeyId).join(",")}`);
      without(files, projectPath, keys);
      return state(projectPath);
    },
    unkeep: async (projectPath, keys) => {
      calls.push(
        `unkeep:${projectPath}:${keys.map(navigationKeyId).join(",")}`,
      );
      without(keptFiles, projectPath, keys);
      return state(projectPath);
    },
    forget: async (projectPath, keys) => {
      const ids = new Set(keys.map(navigationKeyId));
      calls.push(`forget:${projectPath}:${[...ids].join(",")}`);
      without(files, projectPath, keys);
      without(keptFiles, projectPath, keys);
      return state(projectPath);
    },
    retitle: async (projectPath) => state(projectPath),
  };
  return { api, files, keptFiles };
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

test("kept objects follow keep order, move to pinned and close alone", async () => {
  const { api } = fakeApi();
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  await store.getState().keep(sessionItem("codex:a"));
  await store.getState().keep(sessionItem("codex:b"));
  await store.getState().keep(sessionItem("codex:c"));
  expect(store.getState().kept.map((item) => item.title)).toEqual([
    "codex:a",
    "codex:b",
    "codex:c",
  ]);

  // Pinning a kept object moves it; keeping a pinned one changes nothing.
  await store.getState().pin(sessionItem("codex:b"));
  await store.getState().keep(sessionItem("codex:b"));
  expect(store.getState().kept.map((item) => item.title)).toEqual([
    "codex:a",
    "codex:c",
  ]);
  expect(store.getState().pinned.map((item) => item.title)).toEqual([
    "codex:b",
  ]);

  await store.getState().unkeep([]);
  await store.getState().unkeep([
    { kind: "session", sessionId: "codex:a" },
    { kind: "session", sessionId: "codex:c" },
  ]);
  expect(store.getState().kept).toEqual([]);
  expect(api.calls.filter((call) => call.startsWith("unkeep")).length).toBe(1);

  // Unpin leaves Now alone.
  await store.getState().unpin({ kind: "session", sessionId: "codex:b" });
  expect(store.getState().pinned).toEqual([]);
  expect(store.getState().kept).toEqual([]);
});

test("forget drops a confirmed-missing target from pinned and kept", async () => {
  const { api, files, keptFiles } = fakeApi();
  files.set("/project", [sessionItem("codex:a")]);
  keptFiles.set("/project", [sessionItem("codex:b")]);
  const store = createNavigationStore(api);
  store.getState().setProject("/project");
  await flush();

  await store.getState().forget([
    { kind: "session", sessionId: "codex:a" },
    { kind: "session", sessionId: "codex:b" },
  ]);

  expect(store.getState().pinned).toEqual([]);
  expect(store.getState().kept).toEqual([]);
});
