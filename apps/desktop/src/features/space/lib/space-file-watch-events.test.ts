import { expect, test } from "bun:test";
import {
  applySpaceFileEvent,
  inferSpaceFileEventKind,
  repairParentPathForSpaceFileEvent,
  type SpaceFileEventTreeStore,
} from "./space-file-watch-events";

test("Markdown watcher payloads use canonical Page kind", () => {
  expect(inferSpaceFileEventKind({ path: "docs/new.md" })).toBe("page");
  expect(inferSpaceFileEventKind({ path: "docs/new.md", kind: "page" })).toBe(
    "page",
  );
});

test("repair parent targets Page direct parent", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/new.md",
      kind: "page",
      parentPath: "docs",
    }),
  ).toBe("docs");
});

test("repair parent targets folder row parent for readme metadata", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/README.md",
      kind: "page",
      parentPath: "docs",
    }),
  ).toBe("");
});

test("repair parent targets collection row parent for schema marker", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/tasks/schema.yaml",
      kind: "schema",
      parentPath: "docs/tasks",
    }),
  ).toBe("docs");
});

test("repair parent targets deleted folder parent", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/archive",
      kind: "folder",
      isDir: true,
      parentPath: "docs",
    }),
  ).toBe("docs");
});

test("root schema events update the registered space capability projection", async () => {
  const rootUpdates: Array<[string, boolean]> = [];
  const nestedUpdates: Array<[string, string, boolean]> = [];
  const store = createEventStore(rootUpdates, nestedUpdates);

  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "schema.yaml", kind: "schema" },
    readPage: async () => {
      throw new Error("schema events do not read Pages");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:changed",
    getStore: () => store,
    payload: { path: "schema.yaml", kind: "schema" },
    readPage: async () => {
      throw new Error("schema events do not read Pages");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:deleted",
    getStore: () => store,
    payload: { path: "schema.yaml", kind: "schema" },
    readPage: async () => {
      throw new Error("schema events do not read Pages");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });

  expect(rootUpdates).toEqual([
    ["root", true],
    ["root", true],
    ["root", false],
  ]);
  expect(nestedUpdates).toEqual([]);
});

test("nested schema events keep using the tree-node projection", async () => {
  const rootUpdates: Array<[string, boolean]> = [];
  const nestedUpdates: Array<[string, string, boolean]> = [];
  const store = createEventStore(rootUpdates, nestedUpdates);

  await applySpaceFileEvent({
    eventName: "file:changed",
    getStore: () => store,
    payload: { path: "tasks/schema.yaml", kind: "schema" },
    readPage: async () => {
      throw new Error("schema events do not read Pages");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });

  expect(rootUpdates).toEqual([]);
  expect(nestedUpdates).toEqual([["root", "tasks", true]]);
});

test("App marker events update root and nested capability without reading Pages", async () => {
  const rootUpdates: Array<[string, boolean]> = [];
  const nestedUpdates: Array<[string, string, boolean]> = [];
  const store = createEventStore([], []);
  store.patchSpaceAppCapability = (spaceId, hasApp) =>
    rootUpdates.push([spaceId, hasApp]);
  store.updateNodeApp = (spaceId, ownerPath, hasApp) =>
    nestedUpdates.push([spaceId, ownerPath, hasApp]);
  const readPage = async () => {
    throw new Error("App marker events do not read Pages");
  };

  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "app.yaml", kind: "app" },
    readPage,
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:created",
    getStore: () => store,
    payload: { path: "tools/app.yaml", kind: "app" },
    readPage,
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:deleted",
    getStore: () => store,
    payload: { path: "tools/app.yaml", kind: "app" },
    readPage,
    repairTree: () => undefined,
    spaceId: "root",
  });

  expect(rootUpdates).toEqual([["root", true]]);
  expect(nestedUpdates).toEqual([
    ["root", "tools", true],
    ["root", "tools", false],
  ]);
  expect(
    repairParentPathForSpaceFileEvent({
      path: "tools/app.yaml",
      kind: "app",
    }),
  ).toBe("");
});

function createEventStore(
  rootUpdates: Array<[string, boolean]>,
  nestedUpdates: Array<[string, string, boolean]>,
): SpaceFileEventTreeStore {
  return {
    patchSpaceAppCapability: () => undefined,
    patchSpaceSchemaCapability: (spaceId, hasSchema) =>
      rootUpdates.push([spaceId, hasSchema]),
    updateNodeSchema: (spaceId, ownerPath, hasSchema) =>
      nestedUpdates.push([spaceId, ownerPath, hasSchema]),
    updateNodeApp: () => undefined,
    applyReadmeMeta: () => undefined,
    removeReadmeMeta: () => undefined,
    removeTreePath: () => undefined,
    updateNodeMeta: () => undefined,
    upsertTreeNode: () => undefined,
  };
}
