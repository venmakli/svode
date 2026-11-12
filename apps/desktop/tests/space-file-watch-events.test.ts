import { expect, test } from "bun:test";
import {
  applySpaceFileEvent,
  inferSpaceFileEventKind,
  shouldApplySpaceFileEvent,
  watchedPageToTreeNode,
  type SpaceFileEventTreeStore,
} from "../src/features/space/lib/space-file-watch-events";
import type { WatchedSpacePage } from "../src/features/space/model/space-watch-events";

function page(
  title: string,
  icon: string | null = null,
  description: string | null = null,
): WatchedSpacePage {
  return { meta: { title, icon, description } };
}

function createStore() {
  const calls: Array<[string, ...unknown[]]> = [];
  const store: SpaceFileEventTreeStore = {
    patchSpaceSchemaCapability: (...args) =>
      calls.push(["patchSpaceSchemaCapability", ...args]),
    patchSpaceAppCapability: (...args) =>
      calls.push(["patchSpaceAppCapability", ...args]),
    applyReadmeMeta: (...args) => calls.push(["applyReadmeMeta", ...args]),
    removeReadmeMeta: (...args) => calls.push(["removeReadmeMeta", ...args]),
    removeTreePath: (...args) => calls.push(["removeTreePath", ...args]),
    updateNodeMeta: (...args) => calls.push(["updateNodeMeta", ...args]),
    updateNodeSchema: (...args) => calls.push(["updateNodeSchema", ...args]),
    updateNodeApp: (...args) => calls.push(["updateNodeApp", ...args]),
    upsertTreeNode: (...args) => calls.push(["upsertTreeNode", ...args]),
  };
  return { calls, store };
}

test("inferSpaceFileEventKind falls back from path and directory flags", () => {
  expect(inferSpaceFileEventKind({ path: "docs/schema.yaml" })).toBe("schema");
  expect(inferSpaceFileEventKind({ path: "docs/note.md" })).toBe("page");
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

test("watchedPageToTreeNode normalizes markdown metadata", () => {
  expect(
    watchedPageToTreeNode("docs/note.md", page("Note", "N")),
  ).toMatchObject({
    name: "note.md",
    path: "docs/note.md",
    title: "Note",
    icon: "N",
    parent: "docs",
    kind: "page",
    source_shape: "file",
  });
});

test("applySpaceFileEvent applies created nested readme as folder metadata", async () => {
  const { calls, store } = createStore();

  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "docs/README.md" },
    readPage: async () => page("Docs", "D", "Guide"),
    repairTree: (parentPath) => calls.push(["repairTree", parentPath]),
    spaceId: "space-1",
  });

  expect(calls).toEqual([
    ["applyReadmeMeta", "space-1", "docs/README.md", "Docs", "D", "Guide"],
    ["repairTree", ""],
  ]);
});

test("applySpaceFileEvent repairs changed folders by parent path", async () => {
  const { calls, store } = createStore();

  await applySpaceFileEvent({
    eventName: "file:changed",
    getStore: () => store,
    payload: { path: "docs/guides", kind: "folder", parentPath: "docs" },
    readPage: async (path) => page(path),
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
    readPage: async (path) => page(path),
    repairTree: (parentPath) => calls.push(["repairTree", parentPath]),
    spaceId: "space-1",
  });

  expect(calls).toEqual([
    ["updateNodeSchema", "space-1", "docs", false],
    ["repairTree", ""],
  ]);
});

test("applySpaceFileEvent does not read a Page whose parent list is refreshed", async () => {
  const { calls, store } = createStore();
  const readPage = async (path: string) => {
    calls.push(["readPage", path]);
    return page(path);
  };

  for (const eventName of ["file:created", "file:changed"] as const) {
    await applySpaceFileEvent({
      eventName,
      getStore: () => store,
      payload: { path: "docs/note.md", kind: "page", parentPath: "docs" },
      readPage,
      repairTree: (parentPath) => calls.push(["repairTree", parentPath]),
      spaceId: "space-1",
      patchesParent: (parentPath) => parentPath !== "docs",
    });
  }
  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "docs/guides/README.md", kind: "page" },
    readPage,
    repairTree: (parentPath) => calls.push(["repairTree", parentPath]),
    spaceId: "space-1",
    patchesParent: (parentPath) => parentPath !== "docs",
  });

  expect(calls).toEqual([
    ["repairTree", "docs"],
    ["repairTree", "docs"],
    ["repairTree", "docs"],
  ]);
});
