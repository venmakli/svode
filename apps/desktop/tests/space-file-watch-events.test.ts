import { expect, test } from "bun:test";
import type { WatchedSpaceEntry } from "../src/features/space/api/space-watch-actions";
import {
  applySpaceFileEvent,
  inferSpaceFileEventKind,
  shouldApplySpaceFileEvent,
  watchedEntryToTreeNode,
  type SpaceFileEventTreeStore,
} from "../src/features/space/lib/space-file-watch-events";

function entry(
  path: string,
  title: string,
  icon: string | null = null,
  description: string | null = null,
): WatchedSpaceEntry {
  return {
    path,
    body: "",
    meta: {
      title,
      icon,
      description,
      created: "",
      updated: "",
      extra: {},
    },
  };
}

function createStore() {
  const calls: Array<[string, ...unknown[]]> = [];
  const store: SpaceFileEventTreeStore = {
    applyReadmeMeta: (...args) => calls.push(["applyReadmeMeta", ...args]),
    removeReadmeMeta: (...args) => calls.push(["removeReadmeMeta", ...args]),
    removeTreePath: (...args) => calls.push(["removeTreePath", ...args]),
    updateNodeMeta: (...args) => calls.push(["updateNodeMeta", ...args]),
    updateNodeSchema: (...args) => calls.push(["updateNodeSchema", ...args]),
    upsertTreeNode: (...args) => calls.push(["upsertTreeNode", ...args]),
  };
  return { calls, store };
}

test("inferSpaceFileEventKind falls back from path and directory flags", () => {
  expect(inferSpaceFileEventKind({ path: "docs/schema.yaml" })).toBe("schema");
  expect(inferSpaceFileEventKind({ path: "docs/note.md" })).toBe("document");
  expect(inferSpaceFileEventKind({ path: "docs", isDir: true })).toBe("folder");
  expect(inferSpaceFileEventKind({ path: "image.png" })).toBe("unknown");
});

test("shouldApplySpaceFileEvent filters unrelated spaces and no-op payloads", () => {
  expect(shouldApplySpaceFileEvent({ path: "note.md" }, "/repo")).toBe(true);
  expect(
    shouldApplySpaceFileEvent({ path: "note.md", space: "/other" }, "/repo"),
  ).toBe(false);
  expect(
    shouldApplySpaceFileEvent(
      { path: "note.md", affectsTree: false, affectsMetadata: false },
      "/repo",
    ),
  ).toBe(false);
  expect(shouldApplySpaceFileEvent({ path: "image.png" }, "/repo")).toBe(false);
});

test("watchedEntryToTreeNode normalizes markdown metadata", () => {
  expect(
    watchedEntryToTreeNode("docs/note.md", entry("docs/note.md", "Note", "N")),
  ).toMatchObject({
    name: "note.md",
    path: "docs/note.md",
    title: "Note",
    icon: "N",
    parent: "docs",
    kind: "document",
  });
});

test("applySpaceFileEvent applies created nested readme as folder metadata", async () => {
  const { calls, store } = createStore();

  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "docs/README.md" },
    readEntry: async (path) => entry(path, "Docs", "D", "Guide"),
    repairTree: () => calls.push(["repairTree"]),
    spaceId: "space-1",
  });

  expect(calls).toEqual([
    ["applyReadmeMeta", "space-1", "docs/README.md", "Docs", "D", "Guide"],
  ]);
});

test("applySpaceFileEvent repairs changed folders by parent path", async () => {
  const { calls, store } = createStore();

  await applySpaceFileEvent({
    eventName: "file:changed",
    getStore: () => store,
    payload: { path: "docs/guides", kind: "folder", parentPath: "docs" },
    readEntry: async (path) => entry(path, path),
    repairTree: (parentPath) => calls.push(["repairTree", parentPath]),
    spaceId: "space-1",
  });

  expect(calls).toEqual([["repairTree", "docs"]]);
});

test("applySpaceFileEvent removes schema marker on deleted schema files", async () => {
  const { calls, store } = createStore();

  await applySpaceFileEvent({
    eventName: "file:deleted",
    getStore: () => store,
    payload: { path: "docs/schema.yaml" },
    readEntry: async (path) => entry(path, path),
    repairTree: () => calls.push(["repairTree"]),
    spaceId: "space-1",
  });

  expect(calls).toEqual([["updateNodeSchema", "space-1", "docs", false]]);
});
