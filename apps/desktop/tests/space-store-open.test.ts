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
const getExpandedPaths = mock(async () => [] as string[]);

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
  moveEntry: mock(async () => "README.md"),
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

const { useSpaceStore } = await import(
  "../src/features/space/model/space-store"
);

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
    treeCache: {},
    treeLoading: {},
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
  expect(listEntries).not.toHaveBeenCalled();
});

test("missing tree loads in the background after active scope changes", async () => {
  await useSpaceStore.getState().openSpace(childSpace.id);

  expect(useSpaceStore.getState().activeSpaceId).toBe(childSpace.id);

  await flushBackgroundTasks();

  expect(listEntries).toHaveBeenCalledTimes(1);
  expect(useSpaceStore.getState().fileTrees[childSpace.id]).toEqual([
    readmeNode,
  ]);
});
