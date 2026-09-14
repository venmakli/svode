import { beforeEach, expect, mock, test } from "bun:test";
import type { SpaceInfo, TreeNode } from "../src/features/space/model/types";
let persisted: Record<string, string[]>;
let read: (scope: string) => Promise<string[]>;
let list: (scope: string, parent: string | null) => Promise<TreeNode[]>;
let move: (input: { from: string; toParent: string }) => Promise<string>;
mock.module("../src/features/space/api/space-store-actions", () => ({
  getSpaceExpandedPaths: (scope: string) => read(scope),
  saveSpaceExpandedPaths: async (scope: string, paths: string[]) => {
    persisted[scope] = paths;
  },
  listSpaceTreeChildren: (scope: string, parent: string | null) =>
    list(scope, parent),
  listSpaceContentTree: (scope: string) => list(scope, null),
  moveSpaceTreeItem: (input: { from: string; toParent: string }) => move(input),
}));
const { createSpaceTreeState, createEmptyLoadedSpaceTreeState } =
  await import("../src/features/space/model/space-tree-state");
import type { SpaceTreeState } from "../src/features/space/model/space-tree-state";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function node(path: string): TreeNode {
  return {
    path,
    name: path,
    title: path,
    icon: null,
    has_schema: false,
    has_changes: false,
    hasChildren: true,
    children: [],
  };
}
function fixture(paths?: string[]) {
  const host = {
    rootSpaces: [{ id: "root", path: "/root" }] as SpaceInfo[],
    spaces: [{ id: "child", path: "/child" }] as SpaceInfo[],
    activeRootId: "root",
    activeSpaceId: null,
    activeRootPath: "/root",
  };
  let state: SpaceTreeState & typeof host;
  const get = () => state;
  const set = (
    patch:
      | Partial<typeof state>
      | ((value: typeof state) => Partial<typeof state>),
  ) => {
    state = {
      ...state,
      ...(typeof patch === "function" ? patch(state) : patch),
    };
  };
  state = { ...host, ...createSpaceTreeState(set, get) };
  if (paths) state.expandedPaths.root = paths;
  return { get, set };
}
beforeEach(() => {
  persisted = {};
  read = async (scope) => persisted[scope] ?? [];
  list = async () => [];
  move = async ({ from, toParent }) => `${toParent}/${from.split("/").pop()}`;
});
test("handoff remaps unloaded descendants, READMEs and cache; duplicate/no-op safe", async () => {
  const { get, set } = fixture([
    "a",
    "a/README.md",
    "a/b/README.md",
    "a/b/lazy",
    "ab",
  ]);
  set({
    childrenByParentPath: {
      root: {
        "": [node("a/README.md"), node("ab")],
        a: [node("a/b/README.md")],
      },
    },
    expandedPaths: { ...get().expandedPaths, child: ["a"] },
  });
  get().handoffTreePath("/root", "a/b/README.md", "a/Дочь/README.md");
  get().handoffTreePath("/root", "a/README.md", "Родитель/README.md");
  get().handoffTreePath("/root", "a/README.md", "Родитель/README.md");
  get().handoffTreePath("/root", "Родитель/README.md", "Родитель/README.md");
  await get().loadExpandedPaths("root");
  expect(get().expandedPaths.root).toEqual([
    "Родитель/README.md",
    "Родитель/Дочь/README.md",
    "Родитель/Дочь/lazy",
    "ab",
  ]);
  expect(get().expandedPaths.child).toEqual(["a"]);
  expect(get().childrenByParentPath.root.a).toBeUndefined();
  expect(get().fileTrees.root[0].children[0].path).toBe(
    "Родитель/Дочь/README.md",
  );
  expect(persisted["/root"]).toEqual(get().expandedPaths.root);
});
test("late old request cannot restore cache or clear newer loading flag", async () => {
  const { get } = fixture(["a", "a/b"]);
  const old = deferred<TreeNode[]>();
  const current = deferred<TreeNode[]>();
  list = (_scope, parent) => (parent === "a" ? old.promise : current.promise);
  const pending = get().loadTreeChildren("root", "a");
  get().handoffTreePath("/root", "a", "new");
  const next = get().loadTreeChildren("root", "new");
  old.resolve([node("a/stale")]);
  await pending;
  expect(get().childrenByParentPath.root.a).toBeUndefined();
  expect(get().treeParentLoading.root.new).toBe(true);
  current.resolve([node("new/current")]);
  await next;
  expect(get().childrenByParentPath.root.new[0].path).toBe("new/current");
});
test("project switch and return rejects old root listing and repair", async () => {
  for (const repair of [false, true]) {
    const { get, set } = fixture([]);
    const old = deferred<TreeNode[]>();
    const fresh = deferred<TreeNode[]>();
    list = () => old.promise;
    const pending = repair
      ? get().refreshTree("root")
      : get().loadTreeChildren("root");
    set({ activeRootPath: "/other", ...createEmptyLoadedSpaceTreeState() });
    set({ activeRootPath: "/root", ...createEmptyLoadedSpaceTreeState() });
    list = () => fresh.promise;
    const next = get().loadTreeChildren("root");
    old.resolve([node("stale")]);
    await pending;
    expect(get().treeParentLoading.root[""]).toBe(true);
    expect(get().fileTrees.root).toBeUndefined();
    fresh.resolve([node("fresh")]);
    await next;
    expect(get().fileTrees.root[0].path).toBe("fresh");
  }
});
test("move transfers subtree; failed move leaves intent", async () => {
  const { get, set } = fixture(["a", "a/b", "ab"]);
  set({
    childrenByParentPath: {
      root: { "": [node("a"), node("dest")], a: [node("a/b")], dest: [] },
    },
  });
  await get().moveContentItem("root", "a", "dest");
  expect(get().expandedPaths.root).toEqual(["dest/a", "dest/a/b", "ab"]);
  await get().loadExpandedPaths("root");
  expect(persisted["/root"]).toEqual(get().expandedPaths.root);
  move = async () => {
    throw new Error("denied");
  };
  await expect(
    get().moveContentItem("root", "dest/a", "other"),
  ).rejects.toThrow("denied");
  expect(get().expandedPaths.root).toEqual(["dest/a", "dest/a/b", "ab"]);
});
test("hydrate canonicalizes directory aliases durably and preserves Unicode", async () => {
  const { get } = fixture();
  persisted["/root"] = ["Родитель", "Родитель/README.md", "Родитель/потомок"];
  list = async () => [node("Родитель/README.md")];
  await get().loadTreeChildren("root");
  await get().loadExpandedPaths("root");
  expect(get().expandedPaths.root).toEqual([
    "Родитель/README.md",
    "Родитель/потомок",
  ]);
  expect(persisted["/root"]).toEqual(get().expandedPaths.root);
  get().toggleExpanded("root", "Родитель");
  await get().loadExpandedPaths("root");
  expect(persisted["/root"]).toEqual(["Родитель/потомок"]);
});
test("reveal cannot overwrite collapse during delayed child loading", async () => {
  const { get, set } = fixture([]);
  set({
    childrenByParentPath: { root: { "": [node("a")], a: [node("a/b")] } },
    treeParentCache: { root: { "": { loadedAt: Date.now(), dirty: false } } },
  });
  const children = deferred<TreeNode[]>();
  list = () => children.promise;
  const reveal = get().ensureTreePathVisible("root", "a/b/file.md");
  await new Promise((resolve) => setTimeout(resolve, 0));
  get().applySidebarTreeExpansion(["root"], "collapse");
  children.resolve([node("a/b")]);
  await reveal;
  expect(get().expandedPaths.root).toEqual([]);
});

test("queued ensure work and delayed hydrate cannot revive old prefixes after handoff", async () => {
  const { get } = fixture();
  const hydrate = deferred<string[]>();
  read = () => hydrate.promise;
  const requested: Array<string | null> = [];
  list = async (_scope, parent) => {
    requested.push(parent);
    return [];
  };
  const ensure = get().ensureTreeLoaded("root");
  get().handoffTreePath("/root", "a", "new");
  hydrate.resolve(["a", "a/b", "a/c", "a/d", "a/e", "a/f"]);
  await ensure;
  await get().ensureTreeLoaded("root");
  expect(requested.some((path) => path === "a" || path?.startsWith("a/"))).toBe(
    false,
  );
  await get().loadExpandedPaths("root");
  expect(persisted["/root"]).toEqual([
    "new",
    "new/b",
    "new/c",
    "new/d",
    "new/e",
    "new/f",
  ]);
});

test("root listing projection during reveal does not cancel its own intent", async () => {
  const { get } = fixture(["a"]);
  list = async (_scope, parent) =>
    parent === null
      ? [node("a/README.md")]
      : parent === "a"
        ? [node("a/b/README.md")]
        : [];
  await get().ensureTreePathVisible("root", "a/b/note.md");
  expect(get().expandedPaths.root).toEqual(["a/README.md", "a/b/README.md"]);
});
