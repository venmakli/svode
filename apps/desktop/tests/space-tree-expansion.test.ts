import { beforeEach, expect, mock, test } from "bun:test";
import { treeLoadTargetFailure } from "../src/platform/space/content-tree-api";
import type { SpaceInfo, TreeNode } from "../src/features/space/model/types";
let persisted: Record<string, string[]>;
let save: (scope: string, paths: string[]) => Promise<void>;
let read: (scope: string) => Promise<string[]>;
let list: (scope: string, parent: string | null) => Promise<TreeNode[]>;
let move: (input: { from: string; toParent: string }) => Promise<string>;
mock.module("../src/features/space/api/space-store-actions", () => ({
  treeLoadTargetFailure,
  getSpaceExpandedPaths: (scope: string) => read(scope),
  saveSpaceExpandedPaths: (scope: string, paths: string[]) =>
    save(scope, paths),
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  save = async (scope, paths) => {
    persisted[scope] = paths;
  };
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

test("mixed historical paths are cleaned durably without repeated requests or recursive scanning", async () => {
  persisted["/root"] = [
    "old",
    "old/README.md",
    "old/nested",
    "current",
    "current/README.md",
    "oldish",
  ];
  const calls: (string | null)[] = [];
  list = async (_scope, parent) => {
    calls.push(parent);
    if (parent === "old" || parent?.startsWith("old/"))
      throw { kind: "missing", path: "old" };
    return parent === null
      ? [node("current/README.md"), node("oldish"), node("collapsed")]
      : [];
  };
  const { get } = fixture();
  await get().ensureTreeLoaded("root");
  await get().loadExpandedPaths("root");
  expect(persisted["/root"]).toEqual(["current/README.md", "oldish"]);
  const oldCount = calls.filter(
    (path) => path?.startsWith("old/") || path === "old",
  ).length;
  await get().ensureTreeLoaded("root");
  await get().loadTreeChildren("root", "old");
  await fixture().get().ensureTreeLoaded("root");
  expect(
    calls.filter((path) => path?.startsWith("old/") || path === "old"),
  ).toHaveLength(oldCount);
  expect(calls).not.toContain("collapsed");
});

test("policy suppresses subtree until invalidation while access and transport failures retain retry", async () => {
  const { get } = fixture(["hidden", "hidden/child", "valid"]);
  const calls: (string | null)[] = [];
  let hidden = true;
  list = async (_scope, parent) => {
    calls.push(parent);
    if (hidden && parent?.startsWith("hidden"))
      throw { kind: "hidden", path: "hidden" };
    return [];
  };
  await get().ensureTreeLoaded("root");
  const hiddenCalls = () => calls.filter((path) => path?.startsWith("hidden"));
  const count = hiddenCalls().length;
  await get().ensureTreeLoaded("root");
  expect(hiddenCalls()).toHaveLength(count);
  expect(get().expandedPaths.root).toEqual(["hidden", "hidden/child", "valid"]);
  hidden = false;
  get().markTreeDirty("root");
  await get().ensureTreeLoaded("root");
  expect(get().childrenByParentPath.root.hidden).toEqual([]);
  for (const error of [
    { kind: "unavailable", message: "denied" },
    new Error("transport"),
    "File not found",
  ]) {
    list = async () => {
      throw error;
    };
    get().markTreeDirty("root");
    await get().ensureTreeLoaded("root");
    expect(get().expandedPaths.root).toEqual([
      "hidden",
      "hidden/child",
      "valid",
    ]);
  }
});

test("missing completion cannot beat managed mutation handoff or revive an excluded child", async () => {
  const { get } = fixture(["a", "a/child", "ab"]);
  const missing = deferred<TreeNode[]>();
  list = () => missing.promise;
  const pending = get().loadTreeChildren("root", "a");
  const finish = get().beginTreePathMutation("/root");
  missing.reject({ kind: "missing", path: "a" });
  await pending;
  expect(get().expandedPaths.root).toEqual(["a", "a/child", "ab"]);
  list = async () => {
    throw { kind: "missing", path: "a" };
  };
  await get().loadTreeChildren("root", "a");
  expect(get().expandedPaths.root).toContain("a");
  get().handoffTreePath("/root", "a", "новый");
  finish();
  await get().loadExpandedPaths("root");
  expect(persisted["/root"]).toEqual(["новый", "новый/child", "ab"]);

  const child = deferred<TreeNode[]>();
  list = async (_scope, parent) => {
    if (parent === "новый/child") return child.promise;
    throw { kind: "missing", path: "новый" };
  };
  const late = get().loadTreeChildren("root", "новый/child");
  await get().loadTreeChildren("root", "новый");
  child.resolve([node("новый/child/stale")]);
  await late;
  expect(get().childrenByParentPath.root?.["новый/child"]).toBeUndefined();
  expect(get().expandedPaths.root).toEqual(["ab"]);
});

test("late missing respects newer expansion intent and project lifetime", async () => {
  for (const switchProject of [false, true]) {
    const { get, set } = fixture(["a", "ab"]);
    const pending = deferred<TreeNode[]>();
    list = () => pending.promise;
    const loading = get().loadTreeChildren("root", "a");
    if (switchProject) {
      set({ activeRootPath: "/other", ...createEmptyLoadedSpaceTreeState() });
      set({ activeRootPath: "/root", ...createEmptyLoadedSpaceTreeState() });
    } else {
      get().toggleExpanded("root", "a");
      get().toggleExpanded("root", "a");
    }
    pending.reject({ kind: "missing", path: "a" });
    await loading;
    expect(get().expandedPaths.root).toContain("a");
  }
});

test("failed cleanup persistence stays dirty and next ensure saves latest state", async () => {
  persisted["/root"] = ["gone", "current"];
  let attempts = 0;
  save = async (scope, paths) => {
    attempts++;
    if (attempts === 1) throw new Error("fixture save unavailable");
    persisted[scope] = paths;
  };
  list = async (_scope, parent) => {
    if (parent === "gone") throw { kind: "missing", path: "gone" };
    return [];
  };
  const { get } = fixture();
  await get().ensureTreeLoaded("root");
  expect(get().expandedPaths.root).toEqual(["current"]);
  expect(persisted["/root"]).toEqual(["gone", "current"]);
  expect(attempts).toBe(1);
  await get().ensureTreeLoaded("root");
  expect(attempts).toBe(2);
  expect(persisted["/root"]).toEqual(["current"]);
});

test("late parent listing cannot restore a removed branch after subsequent invalidation", async () => {
  const { get } = fixture(["gone", "valid"]);
  const root = deferred<TreeNode[]>();
  list = async (_scope, parent) => {
    if (parent === null) return root.promise;
    throw { kind: "missing", path: "gone" };
  };
  const loading = get().loadTreeChildren("root");
  await get().loadTreeChildren("root", "gone");
  get().markTreeDirty("root");
  list = async () => [node("valid")];
  await get().loadTreeChildren("root");
  root.resolve([node("gone"), node("valid")]);
  await loading;
  expect(get().fileTrees.root.map((item) => item.path)).toEqual(["valid"]);
  expect(get().expandedPaths.root).toEqual(["valid"]);
});
