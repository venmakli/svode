import { expect, test } from "bun:test";
import {
  applySpaceFileEvent,
  repairParentPathForSpaceFileEvent,
  type SpaceFileEventTreeStore,
} from "./space-file-watch-events";

test("repair parent targets document direct parent", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/new.md",
      kind: "document",
      parentPath: "docs",
    }),
  ).toBe("docs");
});

test("repair parent targets folder row parent for readme metadata", () => {
  expect(
    repairParentPathForSpaceFileEvent({
      path: "docs/README.md",
      kind: "document",
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
    readEntry: async () => {
      throw new Error("schema events do not read entries");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:changed",
    getStore: () => store,
    payload: { path: "schema.yaml", kind: "schema" },
    readEntry: async () => {
      throw new Error("schema events do not read entries");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });
  await applySpaceFileEvent({
    eventName: "file:deleted",
    getStore: () => store,
    payload: { path: "schema.yaml", kind: "schema" },
    readEntry: async () => {
      throw new Error("schema events do not read entries");
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
    readEntry: async () => {
      throw new Error("schema events do not read entries");
    },
    repairTree: () => undefined,
    spaceId: "root",
  });

  expect(rootUpdates).toEqual([]);
  expect(nestedUpdates).toEqual([["root", "tasks", true]]);
});

function createEventStore(
  rootUpdates: Array<[string, boolean]>,
  nestedUpdates: Array<[string, string, boolean]>,
): SpaceFileEventTreeStore {
  return {
    patchSpaceSchemaCapability: (spaceId, hasSchema) =>
      rootUpdates.push([spaceId, hasSchema]),
    updateNodeSchema: (spaceId, ownerPath, hasSchema) =>
      nestedUpdates.push([spaceId, ownerPath, hasSchema]),
    applyReadmeMeta: () => undefined,
    removeReadmeMeta: () => undefined,
    removeTreePath: () => undefined,
    updateNodeMeta: () => undefined,
    upsertTreeNode: () => undefined,
  };
}
