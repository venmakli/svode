import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { SpaceInfo, TreeNode } from "../src/features/space/model";
import {
  clearNativeMocks,
  mockNativeIpc,
} from "../src/platform/native/testing";

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
  hasSchema: false,
  lastOpened: null,
  status: "ready",
  lfsState: "n/a",
};

const childSpaceAt = (path: string): SpaceInfo => ({
  id: "space-1",
  name: "Develop",
  icon: "D",
  description: "",
  path,
  hasSpaces: false,
  hasSchema: false,
  lastOpened: null,
  status: "ready",
  lfsState: "n/a",
});

// The store keeps the tree expansion of a Space path for its lifetime, so
// each test opens the Space at its own path.
let childSpaceCount = 0;
let childSpace = childSpaceAt("/project/develop-0");

type Ipc = { command: string; args: Record<string, unknown> };

let ipcCalls: Ipc[] = [];

function treeChildrenFor(parentPath: unknown): TreeNode[] {
  return parentPath === "docs" ? [newChildNode] : [readmeNode];
}

// The store reaches Desktop only through these commands; an unexpected one
// fails the test instead of passing silently.
function handleIpc(command: string, args: Record<string, unknown>) {
  ipcCalls.push({ command, args });
  switch (command) {
    case "list_tree_children":
      return treeChildrenFor(args.parentPath);
    case "navigation_expanded_paths":
      return [];
    case "move_content":
      return { newPath: "archive/old.md", convertedParents: [] };
    case "ensure_space_scaffold":
    case "ensure_assets_scope":
    case "mcp_set_active_context":
    case "mcp_clear_active_context":
    case "navigation_save_expanded_paths":
      return null;
    default:
      throw new Error(`Unexpected command: ${command}`);
  }
}

function callsOf(command: string) {
  return ipcCalls
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

const { useSpaceStore } =
  await import("../src/features/space/model/space-store");

async function flushBackgroundTasks() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

let restoreWindow: () => void = () => undefined;

beforeEach(() => {
  restoreWindow = installTestWindow();
  childSpace = childSpaceAt(`/project/develop-${++childSpaceCount}`);
  ipcCalls = [];
  mockNativeIpc((command, args) =>
    handleIpc(command, (args ?? {}) as Record<string, unknown>),
  );
  useSpaceStore.setState({
    rootSpaces: [rootSpace],
    rootsLoaded: true,
    activeRootId: rootSpace.id,
    activeRootName: rootSpace.name,
    activeRootIcon: rootSpace.icon,
    activeRootPath: rootSpace.path,
    spaces: [childSpace],
    activeSpaceId: null,
    treeLifetimes: {},
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

afterEach(() => {
  restoreWindow();
});

function installTestWindow() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
    writable: true,
  });
  return () => {
    clearNativeMocks();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  };
}

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
  expect(callsOf("list_tree_children")).toEqual([]);
});

test("missing tree loads in the background after active scope changes", async () => {
  await useSpaceStore.getState().openSpace(childSpace.id);

  expect(useSpaceStore.getState().activeSpaceId).toBe(childSpace.id);

  await flushBackgroundTasks();

  expect(callsOf("list_tree_children")).toEqual([
    { space: childSpace.path, parentPath: null },
  ]);
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

  expect(callsOf("list_content_tree")).toEqual([]);
  expect(callsOf("list_tree_children")).toEqual([
    { space: childSpace.path, parentPath: "docs" },
  ]);
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

  expect(callsOf("list_content_tree")).toEqual([]);
  expect(callsOf("list_tree_children")).toEqual([
    { space: childSpace.path, parentPath: "docs" },
  ]);
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

  expect(callsOf("list_content_tree")).toEqual([]);
  expect(callsOf("list_tree_children")).toEqual([
    { space: childSpace.path, parentPath: null },
  ]);
});

test("moveContentItem reloads old and new direct parents without full tree refresh", async () => {
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
    .moveContentItem(childSpace.id, "docs/old.md", "archive");

  expect(callsOf("list_content_tree")).toEqual([]);
  expect(callsOf("move_content")).toEqual([
    {
      space: childSpace.path,
      from: "docs/old.md",
      toParent: "archive",
      projectPath: rootSpace.path,
    },
  ]);
  expect(callsOf("list_tree_children")).toEqual([
    { space: childSpace.path, parentPath: "docs" },
    { space: childSpace.path, parentPath: "archive" },
  ]);
});
