import { beforeEach, expect, mock, test } from "bun:test";
import type { TreeNode } from "../src/features/entry";
import type { SpaceInfo } from "../src/features/space/model";

const readmeNode: TreeNode = {
  name: "README.md",
  path: "README.md",
  title: "Home",
  icon: null,
  has_changes: false,
  has_schema: false,
  children: [],
};

const docsNode: TreeNode = {
  name: "docs",
  path: "docs",
  title: "docs",
  icon: null,
  has_changes: false,
  has_schema: false,
  hasChildren: true,
  children: [],
};

const oldChildNode: TreeNode = {
  name: "old.md",
  path: "docs/old.md",
  title: "old",
  icon: null,
  has_changes: false,
  has_schema: false,
  children: [],
};

const newChildNode: TreeNode = {
  name: "new.md",
  path: "docs/new.md",
  title: "new",
  icon: null,
  has_changes: false,
  has_schema: false,
  children: [],
};

const rootSpace: SpaceInfo = {
  id: "root",
  name: "Project",
  icon: "P",
  description: "",
  path: "/project",
  hasSpaces: true,
  lastOpened: null,
  status: "ready",
  lfsState: "n/a",
};

const childSpace: SpaceInfo = {
  id: "space-1",
  name: "Develop",
  icon: "D",
  description: "",
  path: "/project/develop",
  hasSpaces: false,
  lastOpened: null,
  status: "ready",
  lfsState: "n/a",
};

const listEntries = mock(async () => [readmeNode]);
const listTreeChildren = mock(
  async (_space: string, parentPath: string | null) =>
    parentPath === "docs" ? [newChildNode] : [readmeNode],
);
const getExpandedPaths = mock(async () => [] as string[]);
const moveEntry = mock(async () => "README.md");

mock.module("sonner", () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module("@/platform/mcp", () => ({
  clearMcpActiveContext: mock(async () => undefined),
  setMcpActiveContext: mock(async () => undefined),
}));

mock.module("@/platform/entries/entries-api", () => ({
  createEntry: mock(async () => null),
  getExpandedPaths,
  listEntries,
  listTreeChildren,
  moveEntry,
  saveExpandedPaths: mock(async () => undefined),
  saveTreeOrder: mock(async () => undefined),
}));

mock.module("@/platform/space/space-api", () => ({
  createProject: mock(async () => rootSpace),
  createSpace: mock(async () => childSpace),
  deleteProject: mock(async () => undefined),
  deleteSpace: mock(async () => undefined),
  ensureAssetsScope: mock(async () => undefined),
  ensureSpaceScaffold: mock(async () => undefined),
  getLastActiveProject: mock(async () => null),
  listProjects: mock(async () => [rootSpace]),
  listSpaces: mock(async () => [childSpace]),
  openProject: mock(async () => ({
    name: rootSpace.name,
    description: rootSpace.description,
    icon: rootSpace.icon,
    spaces: [],
  })),
  openProjectFolder: mock(async () => rootSpace),
  reorderSpaces: mock(async () => [childSpace]),
}));

const { useSpaceStore } =
  await import("../src/features/space/model/space-store");

async function flushBackgroundTasks() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  mock.clearAllMocks();
  useSpaceStore.setState({
    rootSpaces: [rootSpace],
    rootsLoaded: true,
    activeRootId: rootSpace.id,
    activeRootName: rootSpace.name,
    activeRootIcon: rootSpace.icon,
    activeRootPath: rootSpace.path,
    spaces: [childSpace],
    activeSpaceId: null,
    fileTrees: {},
    childrenByParentPath: {},
    treeCache: {},
    treeParentCache: {},
    treeLoading: {},
    treeParentLoading: {},
    treeRefreshing: {},
    expandedPaths: {},
    isLoadingRoots: false,
    isLoadingSpaces: false,
    explicitHome: false,
  });
});

test("cached openSpace return does not force a tree refresh", async () => {
  useSpaceStore.setState({
    fileTrees: { [childSpace.id]: [readmeNode] },
    treeCache: {
      [childSpace.id]: { loadedAt: Date.now(), dirty: false },
    },
    expandedPaths: { [childSpace.id]: [] },
  });

  await useSpaceStore.getState().openSpace(childSpace.id);
  await flushBackgroundTasks();

  expect(useSpaceStore.getState().activeSpaceId).toBe(childSpace.id);
  expect(listTreeChildren).not.toHaveBeenCalled();
});

test("missing tree loads in the background after active scope changes", async () => {
  await useSpaceStore.getState().openSpace(childSpace.id);

  expect(useSpaceStore.getState().activeSpaceId).toBe(childSpace.id);

  await flushBackgroundTasks();

  expect(listTreeChildren).toHaveBeenCalledTimes(1);
  expect(useSpaceStore.getState().fileTrees[childSpace.id]).toEqual([
    readmeNode,
  ]);
});

test("dirty expanded parent reloads direct children without full tree refresh", async () => {
  useSpaceStore.setState({
    fileTrees: {
      [childSpace.id]: [{ ...docsNode, children: [oldChildNode] }],
    },
    childrenByParentPath: {
      [childSpace.id]: {
        "": [docsNode],
        docs: [oldChildNode],
      },
    },
    treeCache: {
      [childSpace.id]: { loadedAt: Date.now(), dirty: false },
    },
    treeParentCache: {
      [childSpace.id]: {
        "": { loadedAt: Date.now(), dirty: false },
        docs: { loadedAt: Date.now(), dirty: true },
      },
    },
    expandedPaths: { [childSpace.id]: ["docs"] },
  });

  await useSpaceStore.getState().ensureTreeLoaded(childSpace.id);

  expect(listEntries).not.toHaveBeenCalled();
  expect(listTreeChildren).toHaveBeenCalledTimes(1);
  expect(listTreeChildren).toHaveBeenCalledWith(childSpace.path, "docs");
  expect(useSpaceStore.getState().fileTrees[childSpace.id]?.[0]).toMatchObject({
    path: "docs",
    children: [newChildNode],
  });
});

test("reloadTreePathParents reloads only affected direct parents", async () => {
  useSpaceStore.setState({
    fileTrees: {
      [childSpace.id]: [{ ...docsNode, children: [oldChildNode] }],
    },
    childrenByParentPath: {
      [childSpace.id]: {
        "": [docsNode],
        docs: [oldChildNode],
      },
    },
    treeCache: {
      [childSpace.id]: { loadedAt: Date.now(), dirty: false },
    },
    treeParentCache: {
      [childSpace.id]: {
        "": { loadedAt: Date.now(), dirty: false },
        docs: { loadedAt: Date.now(), dirty: false },
      },
    },
    expandedPaths: { [childSpace.id]: ["docs"] },
  });

  await useSpaceStore
    .getState()
    .reloadTreePathParents(childSpace.id, ["docs/new.md"]);

  expect(listEntries).not.toHaveBeenCalled();
  expect(listTreeChildren).toHaveBeenCalledTimes(1);
  expect(listTreeChildren).toHaveBeenCalledWith(childSpace.path, "docs");
});

test("reloadTreeParents treats null as root parent", async () => {
  useSpaceStore.setState({
    fileTrees: {
      [childSpace.id]: [docsNode],
    },
    childrenByParentPath: {
      [childSpace.id]: {
        "": [docsNode],
      },
    },
    treeCache: {
      [childSpace.id]: { loadedAt: Date.now(), dirty: false },
    },
    treeParentCache: {
      [childSpace.id]: {
        "": { loadedAt: Date.now(), dirty: false },
      },
    },
    expandedPaths: { [childSpace.id]: [] },
  });

  await useSpaceStore.getState().reloadTreeParents(childSpace.id, [null, ""]);

  expect(listEntries).not.toHaveBeenCalled();
  expect(listTreeChildren).toHaveBeenCalledTimes(1);
  expect(listTreeChildren).toHaveBeenCalledWith(childSpace.path, null);
});

test("moveEntry reloads old and new direct parents without full tree refresh", async () => {
  moveEntry.mockImplementationOnce(async () => "archive/old.md");
  useSpaceStore.setState({
    fileTrees: {
      [childSpace.id]: [{ ...docsNode, children: [oldChildNode] }],
    },
    childrenByParentPath: {
      [childSpace.id]: {
        "": [docsNode],
        docs: [oldChildNode],
        archive: [],
      },
    },
    treeCache: {
      [childSpace.id]: { loadedAt: Date.now(), dirty: false },
    },
    treeParentCache: {
      [childSpace.id]: {
        "": { loadedAt: Date.now(), dirty: false },
        docs: { loadedAt: Date.now(), dirty: false },
        archive: { loadedAt: Date.now(), dirty: false },
      },
    },
    expandedPaths: { [childSpace.id]: ["docs", "archive"] },
  });

  await useSpaceStore
    .getState()
    .moveEntry(childSpace.id, "docs/old.md", "archive");

  expect(listEntries).not.toHaveBeenCalled();
  expect(moveEntry).toHaveBeenCalledWith({
    space: childSpace.path,
    from: "docs/old.md",
    toParent: "archive",
    projectPath: rootSpace.path,
  });
  expect(listTreeChildren).toHaveBeenCalledTimes(2);
  expect(listTreeChildren).toHaveBeenNthCalledWith(1, childSpace.path, "docs");
  expect(listTreeChildren).toHaveBeenNthCalledWith(
    2,
    childSpace.path,
    "archive",
  );
});
