import {
  createTreeExpansionCoordinator,
  projectExpansionPaths,
  remapTreePath,
} from "./tree-expansion-state";
import type { TreeNode } from "./types";
import { logTiming, nowMs } from "@/shared/lib/performance";
import * as spaceActions from "../api/space-store-actions";
import type { SpacePageDto } from "../api/space-store-actions";
import {
  applyReadmeMeta as applyReadmeMetaPatch,
  dirname,
  folderPathForNode,
  isReadmePath,
  isSystemIgnoredTreePath,
  normalizeTreePath,
  removeReadmeMeta as removeReadmeMetaPatch,
  removeTreePath as removeTreePathPatch,
  treeRowParentPath,
  updateTreeFolderSchema,
  updateTreeFolderApp,
  updateTreeNodeMeta,
  upsertTreeNode as upsertTreeNodePatch,
} from "../lib/tree-patches";
import {
  ROOT_TREE_PARENT,
  applyReadmeMetaToParents,
  buildLoadedTree,
  flattenChildrenByParentPath,
  loadedParentCache,
  removeReadmeMetaFromParents,
  removeTreePathFromParents,
  treeParentKey,
  type ChildrenByParentPath,
  type TreeParentCache,
  updateTreeNodeMetaInParents,
  updateTreeSchemaInParents,
  updateTreeAppInParents,
  upsertTreeNodeInParent,
} from "../lib/tree-cache";
import {
  sidebarTreeExpansionPaths,
  type SidebarTreeExpansionAction,
} from "../lib/sidebar-tree-expansion";
import type { SpaceInfo } from "./types";

export type RefreshTreeOptions = { continuePending?: boolean };
export type LoadTreeChildrenOptions = { force?: boolean };

export interface SpaceTreeDataState {
  treeLifetimes: Record<string, object>;
  fileTrees: Record<string, TreeNode[]>;
  childrenByParentPath: Record<string, ChildrenByParentPath>;
  treeCache: Record<string, { loadedAt: number; dirty: boolean }>;
  treeParentCache: Record<string, TreeParentCache>;
  treeLoading: Record<string, boolean>;
  treeParentLoading: Record<string, Record<string, boolean>>;
  treeRefreshing: Record<string, boolean>;
  expandedPaths: Record<string, string[]>;
}

export interface SpaceTreeState extends SpaceTreeDataState {
  createPage: (
    spacePath: string,
    title: string,
  ) => Promise<SpacePageDto | null>;
  // Full recursive repair fallback only. Ordinary UI mutations should use
  // parent-level reload/patch helpers below.
  refreshTree: (
    spaceId?: string,
    options?: RefreshTreeOptions,
  ) => Promise<void>;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
  ensureTreePathVisible: (spaceId: string, path: string) => Promise<void>;
  loadTreeChildren: (
    spaceId: string,
    parentPath?: string | null,
    options?: LoadTreeChildrenOptions,
  ) => Promise<void>;
  reloadTreeParent: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  reloadTreeParents: (
    spaceId: string,
    parentPaths: Array<string | null | undefined>,
  ) => Promise<void>;
  reloadTreePathParent: (spaceId: string, path: string) => Promise<void>;
  reloadTreePathParents: (spaceId: string, paths: string[]) => Promise<void>;
  patchPageTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  updateNodeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  upsertTreeNode: (spaceId: string, parentPath: string, node: TreeNode) => void;
  removeTreePath: (spaceId: string, path: string) => void;
  applyReadmeMeta: (
    spaceId: string,
    readmePath: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  removeReadmeMeta: (spaceId: string, readmePath: string) => void;
  updateNodeSchema: (
    spaceId: string,
    folderPath: string,
    hasSchema: boolean,
  ) => void;
  updateNodeApp: (spaceId: string, folderPath: string, hasApp: boolean) => void;
  markTreeDirty: (spaceId: string) => void;
  markTreeParentDirty: (spaceId: string, parentPath?: string | null) => void;
  beginTreePathMutation: (spacePath: string) => () => void;
  handoffTreePath: (spacePath: string, from: string, to: string) => void;
  loadExpandedPaths: (spaceId: string) => Promise<void>;
  applySidebarTreeExpansion: (
    spaceIds: string[],
    action: SidebarTreeExpansionAction,
  ) => void;
  toggleExpanded: (spaceId: string, path: string) => void;
  moveContentItem: (
    spaceId: string,
    from: string,
    toParent: string,
  ) => Promise<string>;
  saveOrder: (
    spaceId: string,
    order: Record<string, string[]>,
  ) => Promise<void>;
}

interface SpaceTreeHostState {
  rootSpaces: SpaceInfo[];
  spaces: SpaceInfo[];
  activeRootId: string | null;
  activeSpaceId: string | null;
  activeRootPath: string | null;
}

type SpaceTreeStoreState = SpaceTreeHostState & SpaceTreeState;
type SpaceTreeSet<T extends SpaceTreeStoreState> = (
  partial:
    | Partial<T>
    | Partial<SpaceTreeState>
    | ((state: T) => Partial<T> | Partial<SpaceTreeState>),
) => void;
type SpaceTreeGet<T extends SpaceTreeStoreState> = () => T;

const TREE_CACHE_TTL_MS = 2 * 60 * 1000;
const EXPANDED_TREE_LOAD_CONCURRENCY = 4;

/** Find space path by id from either rootSpaces or spaces */
function findSpacePath(state: SpaceTreeHostState, id: string): string | null {
  const root = state.rootSpaces.find((w) => w.id === id);
  if (root) return root.path;
  const space = state.spaces.find((w) => w.id === id);
  if (space) return space.path;
  return null;
}

function hasRecordKey<T>(record: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function withoutRecordKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

async function runLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) return;
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

export function createEmptySpaceTreeState(): SpaceTreeDataState {
  return {
    treeLifetimes: {},
    fileTrees: {},
    childrenByParentPath: {},
    treeCache: {},
    treeParentCache: {},
    treeLoading: {},
    treeParentLoading: {},
    treeRefreshing: {},
    expandedPaths: {},
  };
}

export function createEmptyLoadedSpaceTreeState(): Omit<
  SpaceTreeDataState,
  "expandedPaths"
> {
  return {
    treeLifetimes: {},
    fileTrees: {},
    childrenByParentPath: {},
    treeCache: {},
    treeParentCache: {},
    treeLoading: {},
    treeParentLoading: {},
    treeRefreshing: {},
  };
}

export function removeSpaceTreeState(
  state: SpaceTreeDataState,
  spaceId: string,
): SpaceTreeDataState {
  return {
    treeLifetimes: withoutRecordKey(state.treeLifetimes, spaceId),
    fileTrees: withoutRecordKey(state.fileTrees, spaceId),
    childrenByParentPath: withoutRecordKey(state.childrenByParentPath, spaceId),
    treeCache: withoutRecordKey(state.treeCache, spaceId),
    treeParentCache: withoutRecordKey(state.treeParentCache, spaceId),
    treeLoading: withoutRecordKey(state.treeLoading, spaceId),
    treeParentLoading: withoutRecordKey(state.treeParentLoading, spaceId),
    treeRefreshing: withoutRecordKey(state.treeRefreshing, spaceId),
    expandedPaths: withoutRecordKey(state.expandedPaths, spaceId),
  };
}

export function isSpaceTreeLoaded(
  state: SpaceTreeDataState,
  spaceId: string,
): boolean {
  return hasRecordKey(state.fileTrees, spaceId);
}

export function hasSpaceExpandedPaths(
  state: SpaceTreeDataState,
  spaceId: string,
): boolean {
  return hasRecordKey(state.expandedPaths, spaceId);
}

export function shouldValidateSpaceTree(
  state: SpaceTreeDataState,
  spaceId: string,
): boolean {
  if (
    !hasRecordKey(state.fileTrees, spaceId) &&
    !hasRecordKey(state.childrenByParentPath[spaceId] ?? {}, ROOT_TREE_PARENT)
  ) {
    return true;
  }
  const cache = state.treeCache[spaceId];
  if (!cache) return true;
  if (cache.dirty) return true;
  return Date.now() - cache.loadedAt > TREE_CACHE_TTL_MS;
}

function shouldValidateTreeParent(
  state: SpaceTreeDataState,
  spaceId: string,
  parentPath?: string | null,
): boolean {
  const parentKey = treeParentKey(parentPath);
  if (!hasRecordKey(state.childrenByParentPath[spaceId] ?? {}, parentKey)) {
    return true;
  }
  const cache = state.treeParentCache[spaceId]?.[parentKey];
  if (!cache) return true;
  if (cache.dirty) return true;
  return Date.now() - cache.loadedAt > TREE_CACHE_TTL_MS;
}

function rebuildVisibleTree(
  state: SpaceTreeDataState,
  spaceId: string,
  childrenByParentPath = state.childrenByParentPath[spaceId],
): TreeNode[] {
  return buildLoadedTree(childrenByParentPath, state.expandedPaths[spaceId]);
}

function ancestorFolderPathsForTreePath(path: string): string[] {
  const normalized = normalizeTreePath(path);
  if (!normalized || isSystemIgnoredTreePath(normalized)) return [];

  const rowPath = isReadmePath(normalized) ? dirname(normalized) : normalized;
  const parentPath = dirname(rowPath);
  if (!parentPath) return [];

  const parts = parentPath.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function findNodePathForFolder(
  nodes: TreeNode[] | undefined,
  folderPath: string,
): string | null {
  const normalizedFolder = normalizeTreePath(folderPath);
  const node = nodes?.find(
    (item) => folderPathForNode(item) === normalizedFolder,
  );
  return node ? normalizeTreePath(node.path) : null;
}

export function createTreeActivityPatch(
  state: SpaceTreeDataState,
  spaceId: string,
  hadCachedTree: boolean,
  active: boolean,
):
  | Pick<SpaceTreeDataState, "treeRefreshing">
  | Pick<SpaceTreeDataState, "treeLoading"> {
  if (hadCachedTree) {
    return {
      treeRefreshing: active
        ? { ...state.treeRefreshing, [spaceId]: true }
        : withoutRecordKey(state.treeRefreshing, spaceId),
    };
  }

  return {
    treeLoading: active
      ? { ...state.treeLoading, [spaceId]: true }
      : withoutRecordKey(state.treeLoading, spaceId),
  };
}

function countTreeNodes(nodes: TreeNode[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countTreeNodes(node.children),
    0,
  );
}

export function createSpaceTreeState<T extends SpaceTreeStoreState>(
  set: SpaceTreeSet<T>,
  get: SpaceTreeGet<T>,
): SpaceTreeState {
  function scopeId(scope: string) {
    return [...get().rootSpaces, ...get().spaces].find(
      (space) => space.path === scope,
    )?.id;
  }
  const expansion = createTreeExpansionCoordinator({
    read: spaceActions.getSpaceExpandedPaths,
    write: spaceActions.saveSpaceExpandedPaths,
    project: (scope, paths) =>
      projectExpansionPaths(
        paths,
        get().childrenByParentPath[scopeId(scope) ?? ""],
      ),
    publish: (scope, paths) => {
      const id = scopeId(scope);
      if (
        !id ||
        (scope !== get().activeRootPath &&
          !get().spaces.some((space) => space.path === scope))
      )
        return;
      const next = projectExpansionPaths(paths, get().childrenByParentPath[id]);
      set((state) => ({
        expandedPaths: { ...state.expandedPaths, [id]: next },
        fileTrees: state.childrenByParentPath[id]
          ? {
              ...state.fileTrees,
              [id]: buildLoadedTree(state.childrenByParentPath[id], next),
            }
          : state.fileTrees,
      }));
    },
  });
  const expansionIntents = new Map<string, number>();
  function editExpansion(
    id: string,
    edit: (paths: string[]) => string[],
    userIntent = true,
  ) {
    if (userIntent)
      expansionIntents.set(id, (expansionIntents.get(id) ?? 0) + 1);
    const scope = findSpacePath(get(), id);
    if (!scope) return;
    expansion.update(
      scope,
      (paths) =>
        projectExpansionPaths(edit(paths), get().childrenByParentPath[id]),
      get().expandedPaths[id],
    );
  }
  function lifetime(id: string) {
    if (!get().treeLifetimes[id]) {
      set((state) => ({ treeLifetimes: { ...state.treeLifetimes, [id]: {} } }));
    }
    const token = get().treeLifetimes[id];
    const scope = findSpacePath(get(), id);
    const root = get().activeRootPath;
    return () =>
      get().treeLifetimes[id] === token &&
      findSpacePath(get(), id) === scope &&
      get().activeRootPath === root;
  }
  const mutations = new Map<string, number>();
  const requests = new Map<string, object>();
  const suppressed = new Map<
    string,
    { path: string; current: () => boolean }[]
  >();
  const under = (path: string, branch: string) =>
    path === branch || path.startsWith(`${branch}/`);
  const requestKey = (id: string, path: string) => JSON.stringify([id, path]);
  function blocked(id: string, path: string) {
    return (suppressed.get(id) ?? []).some(
      (item) => item.current() && under(path, item.path),
    );
  }
  function invalidateLoads(id: string) {
    suppressed.delete(id);
    set((state) => ({
      treeLifetimes: { ...state.treeLifetimes, [id]: {} },
      treeParentLoading: { ...state.treeParentLoading, [id]: {} },
      treeLoading: withoutRecordKey(state.treeLoading, id),
      treeRefreshing: withoutRecordKey(state.treeRefreshing, id),
      treeParentCache: { ...state.treeParentCache, [id]: {} },
    }));
  }
  function excludeBranch(id: string, path: string, missing: boolean) {
    suppressed.set(id, [
      ...(suppressed.get(id) ?? []).filter((item) => item.current()),
      { path, current: lifetime(id) },
    ]);
    const affected = (parent: string) =>
      parent === ROOT_TREE_PARENT || under(parent, path) || under(path, parent);
    for (const parent of Object.keys(get().treeParentLoading[id] ?? {})) {
      if (affected(parent)) requests.delete(requestKey(id, parent));
    }
    get().removeTreePath(id, path);
    set((state) => ({
      treeLoading: withoutRecordKey(state.treeLoading, id),
      treeRefreshing: withoutRecordKey(state.treeRefreshing, id),
      treeParentLoading: {
        ...state.treeParentLoading,
        [id]: Object.fromEntries(
          Object.entries(state.treeParentLoading[id] ?? {}).filter(
            ([parent]) => !affected(parent),
          ),
        ),
      },
      treeParentCache: {
        ...state.treeParentCache,
        [id]: Object.fromEntries(
          Object.entries(state.treeParentCache[id] ?? {}).filter(
            ([parent]) => !affected(parent),
          ),
        ),
      },
    }));
    if (missing)
      editExpansion(
        id,
        (paths) => paths.filter((key) => !under(treeParentKey(key), path)),
        false,
      );
  }
  function projectExpansion(id: string) {
    const paths = get().expandedPaths[id];
    if (!paths) return;
    const next = projectExpansionPaths(paths, get().childrenByParentPath[id]);
    if (JSON.stringify(paths) !== JSON.stringify(next))
      editExpansion(id, (current) => current, false);
  }
  return {
    ...createEmptySpaceTreeState(),

    createPage: async (spacePath: string, title: string) => {
      try {
        const page = await spaceActions.createSpacePage({
          spacePath,
          parentPath: null,
          title,
          projectPath: get().activeRootPath,
        });
        // Find space id by path and refresh its tree
        const state = get();
        const ws = [...state.rootSpaces, ...state.spaces].find(
          (w) => w.path === spacePath,
        );
        if (ws) {
          await get().reloadTreeParent(ws.id, ROOT_TREE_PARENT);
        }
        return page;
      } catch (err) {
        console.error("Failed to create page:", err);
        return null;
      }
    },

    // Full recursive repair fallback for manual/debug recovery paths. Do not
    // call from ordinary create/rename/delete/reorder flows.
    refreshTree: async (spaceId?: string, options?: RefreshTreeOptions) => {
      const id = spaceId ?? get().activeSpaceId ?? get().activeRootId;
      if (!id) return;

      const spacePath = findSpacePath(get(), id);
      if (!spacePath) return;

      const isCurrent = lifetime(id);
      const startedAt = nowMs();
      const hadCachedTree = isSpaceTreeLoaded(get(), id);
      const alreadyPending = hadCachedTree
        ? get().treeRefreshing[id]
        : get().treeLoading[id];
      if (alreadyPending && !options?.continuePending) return;

      let status: "ok" | "error" = "ok";
      let nodeCount = 0;
      set((state) => createTreeActivityPatch(state, id, hadCachedTree, true));
      try {
        const tree = await spaceActions.listSpaceContentTree(spacePath);
        if (!isCurrent()) return;
        nodeCount = countTreeNodes(tree);
        const loadedAt = Date.now();
        const childrenByParent = Object.fromEntries(
          Object.entries(flattenChildrenByParentPath(tree))
            .filter(([parent]) => !blocked(id, parent))
            .map(([parent, nodes]) => [
              parent,
              nodes.filter((node) => !blocked(id, treeParentKey(node.path))),
            ]),
        );
        set((s) => ({
          childrenByParentPath: {
            ...s.childrenByParentPath,
            [id]: childrenByParent,
          },
          treeParentCache: {
            ...s.treeParentCache,
            [id]: loadedParentCache(childrenByParent, loadedAt),
          },
          fileTrees: {
            ...s.fileTrees,
            [id]: buildLoadedTree(childrenByParent, s.expandedPaths[id]),
          },
          treeCache: {
            ...s.treeCache,
            [id]: { loadedAt, dirty: false },
          },
        }));
      } catch (err) {
        status = "error";
        if (!isCurrent()) return;
        console.error("Failed to load file tree:", err);
        if (!hadCachedTree) {
          set((s) => ({
            fileTrees: { ...s.fileTrees, [id]: [] },
          }));
        }
      } finally {
        if (isCurrent()) {
          projectExpansion(id);
          set((s) =>
            hadCachedTree
              ? { treeRefreshing: withoutRecordKey(s.treeRefreshing, id) }
              : { treeLoading: withoutRecordKey(s.treeLoading, id) },
          );
        }
        if (isCurrent() && status === "ok") await get().ensureTreeLoaded(id);
        logTiming("tree.refresh.repair", startedAt, {
          spaceId: id,
          status,
          nodeCount,
        });
      }
    },

    ensureTreeLoaded: async (spaceId: string) => {
      const initialSpacePath = findSpacePath(get(), spaceId);
      if (!initialSpacePath) return;
      const isCurrent = lifetime(spaceId);

      await get().loadExpandedPaths(spaceId);

      if (!isCurrent()) return;

      if (shouldValidateTreeParent(get(), spaceId, ROOT_TREE_PARENT)) {
        await get().loadTreeChildren(spaceId, ROOT_TREE_PARENT);
      }

      if (!isCurrent()) return;

      const expanded = get().expandedPaths[spaceId] ?? [];
      const parentsToLoad = expanded.filter(
        (path) =>
          !isSystemIgnoredTreePath(path) &&
          shouldValidateTreeParent(get(), spaceId, path),
      );
      await runLimited(
        parentsToLoad,
        EXPANDED_TREE_LOAD_CONCURRENCY,
        async (path) => {
          if (!isCurrent()) return;
          if (
            !(get().expandedPaths[spaceId] ?? []).some(
              (current) => treeParentKey(current) === treeParentKey(path),
            )
          )
            return;
          await get().loadTreeChildren(spaceId, path);
        },
      );
    },

    ensureTreePathVisible: async (spaceId: string, path: string) => {
      const initialSpacePath = findSpacePath(get(), spaceId);
      if (!initialSpacePath) return;
      const isCurrent = lifetime(spaceId);

      let expectedIntent = expansionIntents.get(spaceId) ?? 0;
      const normalizedPath = normalizeTreePath(path);
      if (!normalizedPath || isSystemIgnoredTreePath(normalizedPath)) return;

      if (!hasSpaceExpandedPaths(get(), spaceId)) {
        await get().loadExpandedPaths(spaceId);
      }

      if (!isCurrent()) return;

      await get().loadTreeChildren(spaceId, ROOT_TREE_PARENT);

      if (
        !isCurrent() ||
        (expansionIntents.get(spaceId) ?? 0) !== expectedIntent
      )
        return;

      for (const folderPath of ancestorFolderPathsForTreePath(normalizedPath)) {
        const parentPath = dirname(folderPath);
        const parentKey = treeParentKey(parentPath);

        if (shouldValidateTreeParent(get(), spaceId, parentKey)) {
          await get().loadTreeChildren(spaceId, parentKey);
        }

        if (!isCurrent()) return;

        const nodePath = findNodePathForFolder(
          get().childrenByParentPath[spaceId]?.[parentKey],
          folderPath,
        );
        if (!nodePath) break;

        if ((expansionIntents.get(spaceId) ?? 0) !== expectedIntent) return;
        editExpansion(spaceId, (paths) => [...paths, nodePath]);
        expectedIntent = expansionIntents.get(spaceId) ?? 0;

        await get().loadTreeChildren(spaceId, nodePath);

        if (!isCurrent()) return;
      }
    },

    loadTreeChildren: async (spaceId, parentPath, options) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) return;

      const currentLifetime = lifetime(spaceId);
      const parentKey = treeParentKey(parentPath);
      if (blocked(spaceId, parentKey)) return;
      if (
        !options?.force &&
        !shouldValidateTreeParent(get(), spaceId, parentKey)
      ) {
        return;
      }
      if (get().treeParentLoading[spaceId]?.[parentKey]) return;

      const intent = expansionIntents.get(spaceId) ?? 0;
      const key = requestKey(spaceId, parentKey);
      const token = {};
      requests.set(key, token);
      const isCurrent = () => currentLifetime() && requests.get(key) === token;
      const isRootParent = parentKey === ROOT_TREE_PARENT;
      const hadCachedTree = isSpaceTreeLoaded(get(), spaceId);
      const startedAt = nowMs();
      let status: "ok" | "error" = "ok";
      let nodeCount = 0;

      set((state) => ({
        ...(isRootParent
          ? createTreeActivityPatch(state, spaceId, hadCachedTree, true)
          : {}),
        treeParentLoading: {
          ...state.treeParentLoading,
          [spaceId]: {
            ...(state.treeParentLoading[spaceId] ?? {}),
            [parentKey]: true,
          },
        },
      }));

      try {
        const loadedChildren = await spaceActions.listSpaceTreeChildren(
          spacePath,
          parentKey || null,
        );
        if (!isCurrent()) return;
        const children = loadedChildren.filter(
          (node) => !blocked(spaceId, treeParentKey(node.path)),
        );
        nodeCount = children.length;
        const loadedAt = Date.now();
        set((state) => {
          const nextChildrenByParent = {
            ...(state.childrenByParentPath[spaceId] ?? {}),
            [parentKey]: children.map((node) => ({ ...node, children: [] })),
          };
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildrenByParent,
            },
            treeParentCache: {
              ...state.treeParentCache,
              [spaceId]: {
                ...(state.treeParentCache[spaceId] ?? {}),
                [parentKey]: { loadedAt, dirty: false },
              },
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(
                state,
                spaceId,
                nextChildrenByParent,
              ),
            },
            treeCache: isRootParent
              ? {
                  ...state.treeCache,
                  [spaceId]: { loadedAt, dirty: false },
                }
              : state.treeCache,
          };
        });
      } catch (err) {
        status = "error";
        if (!isCurrent()) return;
        const failure = spaceActions.treeLoadTargetFailure(err);
        const branch = failure ? treeParentKey(failure.path) : "";
        if (failure && branch && under(parentKey, branch)) {
          if (
            !(mutations.get(spacePath) ?? 0) &&
            (expansionIntents.get(spaceId) ?? 0) === intent
          ) {
            excludeBranch(spaceId, branch, failure.kind === "missing");
          }
          return;
        }
        console.error("Failed to load tree children:", err);
        if (isRootParent && !hadCachedTree) {
          set((s) => ({
            fileTrees: { ...s.fileTrees, [spaceId]: [] },
          }));
        }
      } finally {
        if (isCurrent()) {
          projectExpansion(spaceId);
          set((state) => {
            const nextParentLoading = {
              ...(state.treeParentLoading[spaceId] ?? {}),
            };
            delete nextParentLoading[parentKey];
            return {
              ...(isRootParent
                ? hadCachedTree
                  ? {
                      treeRefreshing: withoutRecordKey(
                        state.treeRefreshing,
                        spaceId,
                      ),
                    }
                  : {
                      treeLoading: withoutRecordKey(state.treeLoading, spaceId),
                    }
                : {}),
              treeParentLoading: {
                ...state.treeParentLoading,
                [spaceId]: nextParentLoading,
              },
            };
          });
        }
        logTiming("tree.children", startedAt, {
          spaceId,
          parentScope: parentKey ? "child" : "root",
          status,
          nodeCount,
        });
      }
    },

    reloadTreeParent: async (spaceId, parentPath) => {
      const parentKey = treeParentKey(parentPath);
      get().markTreeParentDirty(spaceId, parentKey);
      await get().loadTreeChildren(spaceId, parentKey, { force: true });
    },

    reloadTreeParents: async (spaceId, parentPaths) => {
      const seen = new Set<string>();
      for (const parentPath of parentPaths) {
        if (parentPath === undefined) continue;
        const parentKey = treeParentKey(parentPath);
        if (seen.has(parentKey)) continue;
        seen.add(parentKey);
        await get().reloadTreeParent(spaceId, parentKey);
      }
    },

    reloadTreePathParent: async (spaceId, path) => {
      const parentPath = treeRowParentPath(path);
      if (parentPath === null) return;
      await get().reloadTreeParent(spaceId, parentPath);
    },

    reloadTreePathParents: async (spaceId, paths) => {
      await get().reloadTreeParents(
        spaceId,
        paths
          .map((path) => treeRowParentPath(path))
          .filter((path): path is string => path !== null),
      );
    },

    patchPageTreeMeta: (spaceId, path, title, icon, description) => {
      if (isReadmePath(path)) {
        get().applyReadmeMeta(spaceId, path, title, icon, description);
      } else {
        get().updateNodeMeta(spaceId, path, title, icon, description);
      }
    },

    updateNodeMeta: (
      spaceId: string,
      path: string,
      title: string,
      icon: string | null,
      description?: string | null,
    ) => {
      set((state) => {
        const nextChildren = updateTreeNodeMetaInParents(
          state.childrenByParentPath[spaceId],
          path,
          { title, icon, description },
        );
        if (
          !nextChildren ||
          nextChildren === state.childrenByParentPath[spaceId]
        ) {
          const tree = state.fileTrees[spaceId];
          if (!tree) return {};
          const next = updateTreeNodeMeta(tree, path, {
            title,
            icon,
            description,
          });
          if (next === tree) return {};
          return { fileTrees: { ...state.fileTrees, [spaceId]: next } };
        }
        return {
          childrenByParentPath: {
            ...state.childrenByParentPath,
            [spaceId]: nextChildren,
          },
          fileTrees: {
            ...state.fileTrees,
            [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
          },
        };
      });
    },

    upsertTreeNode: (spaceId, parentPath, node) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = upsertTreeNodeInParent(
            currentChildren,
            parentPath,
            node,
          );
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = upsertTreeNodePatch(tree, parentPath, node);
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    removeTreePath: (spaceId, path) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = removeTreePathFromParents(currentChildren, path);
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = removeTreePathPatch(tree, path);
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    applyReadmeMeta: (spaceId, readmePath, title, icon, description) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = applyReadmeMetaToParents(
            currentChildren,
            readmePath,
            { title, icon, description },
          );
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = applyReadmeMetaPatch(tree, readmePath, {
          title,
          icon,
          description,
        });
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    removeReadmeMeta: (spaceId, readmePath) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = removeReadmeMetaFromParents(
            currentChildren,
            readmePath,
          );
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = removeReadmeMetaPatch(tree, readmePath);
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    updateNodeSchema: (spaceId, folderPath, hasSchema) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = updateTreeSchemaInParents(
            currentChildren,
            folderPath,
            hasSchema,
          );
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = updateTreeFolderSchema(tree, folderPath, hasSchema);
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    updateNodeApp: (spaceId, folderPath, hasApp) => {
      set((state) => {
        const currentChildren = state.childrenByParentPath[spaceId];
        if (currentChildren) {
          const nextChildren = updateTreeAppInParents(
            currentChildren,
            folderPath,
            hasApp,
          );
          if (!nextChildren || nextChildren === currentChildren) return {};
          return {
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [spaceId]: nextChildren,
            },
            fileTrees: {
              ...state.fileTrees,
              [spaceId]: rebuildVisibleTree(state, spaceId, nextChildren),
            },
            treeCache: {
              ...state.treeCache,
              [spaceId]: { loadedAt: Date.now(), dirty: false },
            },
          };
        }

        const tree = state.fileTrees[spaceId];
        if (!tree) return {};
        const next = updateTreeFolderApp(tree, folderPath, hasApp);
        if (next === tree) return {};
        return {
          fileTrees: { ...state.fileTrees, [spaceId]: next },
          treeCache: {
            ...state.treeCache,
            [spaceId]: { loadedAt: Date.now(), dirty: false },
          },
        };
      });
    },

    markTreeDirty: (spaceId) => {
      suppressed.delete(spaceId);
      set((s) => ({
        treeCache: {
          ...s.treeCache,
          [spaceId]: {
            loadedAt: s.treeCache[spaceId]?.loadedAt ?? 0,
            dirty: true,
          },
        },
        treeParentCache: {
          ...s.treeParentCache,
          [spaceId]: Object.fromEntries(
            Object.entries(s.treeParentCache[spaceId] ?? {}).map(
              ([parent, cache]) => [parent, { ...cache, dirty: true }],
            ),
          ),
        },
      }));
    },

    markTreeParentDirty: (spaceId, parentPath) => {
      const parentKey = treeParentKey(parentPath);
      suppressed.set(
        spaceId,
        (suppressed.get(spaceId) ?? []).filter(
          (item) =>
            item.current() &&
            parentKey !== ROOT_TREE_PARENT &&
            !under(item.path, parentKey) &&
            !under(parentKey, item.path),
        ),
      );
      set((s) => ({
        treeCache: {
          ...s.treeCache,
          [spaceId]: {
            loadedAt: s.treeCache[spaceId]?.loadedAt ?? 0,
            dirty:
              parentKey === ROOT_TREE_PARENT
                ? true
                : (s.treeCache[spaceId]?.dirty ?? false),
          },
        },
        treeParentCache: {
          ...s.treeParentCache,
          [spaceId]: {
            ...(s.treeParentCache[spaceId] ?? {}),
            [parentKey]: {
              loadedAt: s.treeParentCache[spaceId]?.[parentKey]?.loadedAt ?? 0,
              dirty: true,
            },
          },
        },
      }));
    },

    beginTreePathMutation: (scope) => {
      mutations.set(scope, (mutations.get(scope) ?? 0) + 1);
      const id = scopeId(scope);
      if (id) invalidateLoads(id);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        mutations.set(scope, (mutations.get(scope) ?? 1) - 1);
        if (id && findSpacePath(get(), id) === scope) invalidateLoads(id);
      };
    },

    handoffTreePath: (scope, previous, canonical) => {
      const from = treeParentKey(previous);
      const to = treeParentKey(canonical);
      if (!from || !to || from === to) return;
      const id = scopeId(scope);
      if (
        id &&
        (scope === get().activeRootPath ||
          get().spaces.some((space) => space.path === scope))
      ) {
        set((state) => {
          const children = Object.fromEntries(
            Object.entries(state.childrenByParentPath[id] ?? {}).map(
              ([parent, nodes]) => [
                remapTreePath(parent, from, to),
                nodes.map((node) => ({
                  ...node,
                  path: remapTreePath(node.path, from, to),
                })),
              ],
            ),
          );
          const oldParent = treeRowParentPath(previous);
          const newParent = treeRowParentPath(canonical);
          if (
            oldParent !== null &&
            newParent !== null &&
            oldParent !== newParent
          ) {
            const moved =
              children[oldParent]?.filter(
                (node) => treeParentKey(node.path) === to,
              ) ?? [];
            if (children[oldParent])
              children[oldParent] = children[oldParent].filter(
                (node) => treeParentKey(node.path) !== to,
              );
            if (children[newParent])
              children[newParent] = [...children[newParent], ...moved];
          }
          return {
            treeLifetimes: { ...state.treeLifetimes, [id]: {} },
            childrenByParentPath: {
              ...state.childrenByParentPath,
              [id]: children,
            },
            treeParentCache: { ...state.treeParentCache, [id]: {} },
            treeCache: {
              ...state.treeCache,
              [id]: { loadedAt: 0, dirty: true },
            },
            treeParentLoading: { ...state.treeParentLoading, [id]: {} },
            treeLoading: withoutRecordKey(state.treeLoading, id),
            treeRefreshing: withoutRecordKey(state.treeRefreshing, id),
          };
        });
      }
      expansion.update(
        scope,
        (paths) =>
          projectExpansionPaths(
            paths.map((path) => remapTreePath(path, from, to)),
            id ? get().childrenByParentPath[id] : undefined,
          ),
        id ? get().expandedPaths[id] : undefined,
      );
    },

    loadExpandedPaths: async (spaceId: string) => {
      const isCurrent = lifetime(spaceId);
      const scope = findSpacePath(get(), spaceId);
      if (scope) await expansion.load(scope, get().expandedPaths[spaceId]);
      if (isCurrent()) projectExpansion(spaceId);
    },

    applySidebarTreeExpansion: (spaceIds, action) => {
      for (const id of new Set(spaceIds)) {
        const next = sidebarTreeExpansionPaths(
          action,
          get().childrenByParentPath[id],
        );
        editExpansion(id, () => next);
      }
    },

    toggleExpanded: (spaceId: string, path: string) => {
      const identity = treeParentKey(path);
      const expanded = (get().expandedPaths[spaceId] ?? []).some(
        (current) => treeParentKey(current) === identity,
      );
      editExpansion(spaceId, (paths) =>
        expanded
          ? paths.filter((current) => treeParentKey(current) !== identity)
          : [...paths, path],
      );
    },

    moveContentItem: async (
      spaceId: string,
      from: string,
      toParent: string,
    ) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) throw new Error("Space not found");
      const finish = get().beginTreePathMutation(spacePath);
      const isCurrent = lifetime(spaceId);
      const oldParent = treeRowParentPath(from);
      let newPath: string;
      let current: boolean;
      try {
        newPath = await spaceActions.moveSpaceTreeItem({
          spacePath,
          from,
          toParent,
          projectPath: get().activeRootPath,
        });
        current = isCurrent();
        get().handoffTreePath(spacePath, from, newPath);
      } finally {
        finish();
      }
      if (!current) return newPath;
      const newParent = treeRowParentPath(newPath);
      get().removeTreePath(spaceId, from);
      await get().reloadTreeParents(spaceId, [oldParent, newParent, toParent]);
      return newPath;
    },

    saveOrder: async (spaceId: string, order: Record<string, string[]>) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) return;
      await spaceActions.saveSpaceTreeOrder({
        spacePath,
        order,
        projectPath: get().activeRootPath,
      });
    },
  };
}
