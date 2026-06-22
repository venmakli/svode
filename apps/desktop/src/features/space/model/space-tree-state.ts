import type { TreeNode } from "@/features/entry";
import { logTiming, nowMs } from "@/shared/lib/performance";
import * as spaceActions from "../api/space-store-actions";
import type { SpaceEntryDto } from "../api/space-store-actions";
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
  upsertTreeNodeInParent,
} from "../lib/tree-cache";
import type { SpaceInfo } from "./types";

export type RefreshTreeOptions = { continuePending?: boolean };
export type LoadTreeChildrenOptions = { force?: boolean };

export interface SpaceTreeDataState {
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
  createEntry: (
    spacePath: string,
    title: string,
  ) => Promise<SpaceEntryDto | null>;
  createPage: (
    spacePath: string,
    title: string,
  ) => Promise<SpaceEntryDto | null>;
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
  patchEntryTreeMeta: (
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
  markTreeDirty: (spaceId: string) => void;
  markTreeParentDirty: (spaceId: string, parentPath?: string | null) => void;
  loadExpandedPaths: (spaceId: string) => Promise<void>;
  toggleExpanded: (spaceId: string, path: string) => void;
  moveEntry: (
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
  return {
    ...createEmptySpaceTreeState(),

    createEntry: async (spacePath: string, title: string) => {
      try {
        const entry = await spaceActions.createSpaceEntry({
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
        return entry;
      } catch (err) {
        console.error("Failed to create page:", err);
        return null;
      }
    },

    createPage: async (spacePath: string, title: string) =>
      get().createEntry(spacePath, title),

    // Full recursive repair fallback for manual/debug recovery paths. Do not
    // call from ordinary create/rename/delete/reorder flows.
    refreshTree: async (spaceId?: string, options?: RefreshTreeOptions) => {
      const id = spaceId ?? get().activeSpaceId ?? get().activeRootId;
      if (!id) return;

      const spacePath = findSpacePath(get(), id);
      if (!spacePath) return;

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
        const tree = await spaceActions.listSpaceTreeEntries(spacePath);
        nodeCount = countTreeNodes(tree);
        const loadedAt = Date.now();
        const childrenByParent = flattenChildrenByParentPath(tree);
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
        console.error("Failed to load file tree:", err);
        if (!hadCachedTree) {
          set((s) => ({
            fileTrees: { ...s.fileTrees, [id]: [] },
          }));
        }
      } finally {
        set((s) =>
          hadCachedTree
            ? { treeRefreshing: withoutRecordKey(s.treeRefreshing, id) }
            : { treeLoading: withoutRecordKey(s.treeLoading, id) },
        );
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

      if (!hasSpaceExpandedPaths(get(), spaceId)) {
        await get().loadExpandedPaths(spaceId);
      }

      if (findSpacePath(get(), spaceId) !== initialSpacePath) return;

      if (shouldValidateTreeParent(get(), spaceId, ROOT_TREE_PARENT)) {
        await get().loadTreeChildren(spaceId, ROOT_TREE_PARENT);
      }

      if (findSpacePath(get(), spaceId) !== initialSpacePath) return;

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
          if (findSpacePath(get(), spaceId) !== initialSpacePath) return;
          await get().loadTreeChildren(spaceId, path);
        },
      );
    },

    ensureTreePathVisible: async (spaceId: string, path: string) => {
      const initialSpacePath = findSpacePath(get(), spaceId);
      if (!initialSpacePath) return;

      const normalizedPath = normalizeTreePath(path);
      if (!normalizedPath || isSystemIgnoredTreePath(normalizedPath)) return;

      if (!hasSpaceExpandedPaths(get(), spaceId)) {
        await get().loadExpandedPaths(spaceId);
      }

      if (findSpacePath(get(), spaceId) !== initialSpacePath) return;

      await get().loadTreeChildren(spaceId, ROOT_TREE_PARENT);

      if (findSpacePath(get(), spaceId) !== initialSpacePath) return;

      const expanded = new Set(get().expandedPaths[spaceId] ?? []);
      let changed = false;

      for (const folderPath of ancestorFolderPathsForTreePath(normalizedPath)) {
        const parentPath = dirname(folderPath);
        const parentKey = treeParentKey(parentPath);

        if (shouldValidateTreeParent(get(), spaceId, parentKey)) {
          await get().loadTreeChildren(spaceId, parentKey);
        }

        if (findSpacePath(get(), spaceId) !== initialSpacePath) return;

        const nodePath = findNodePathForFolder(
          get().childrenByParentPath[spaceId]?.[parentKey],
          folderPath,
        );
        if (!nodePath) break;

        if (!expanded.has(nodePath)) {
          expanded.add(nodePath);
          changed = true;
        }

        await get().loadTreeChildren(spaceId, nodePath);

        if (findSpacePath(get(), spaceId) !== initialSpacePath) return;
      }

      if (!changed) return;

      const next = Array.from(expanded);
      set((state) => ({
        expandedPaths: { ...state.expandedPaths, [spaceId]: next },
        fileTrees: {
          ...state.fileTrees,
          [spaceId]: state.childrenByParentPath[spaceId]
            ? buildLoadedTree(state.childrenByParentPath[spaceId], next)
            : (state.fileTrees[spaceId] ?? []),
        },
      }));

      const spacePath = findSpacePath(get(), spaceId);
      if (spacePath) {
        spaceActions.saveSpaceExpandedPaths(spacePath, next).catch(() => {});
      }
    },

    loadTreeChildren: async (spaceId, parentPath, options) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) return;

      const parentKey = treeParentKey(parentPath);
      if (
        !options?.force &&
        !shouldValidateTreeParent(get(), spaceId, parentKey)
      ) {
        return;
      }
      if (get().treeParentLoading[spaceId]?.[parentKey]) return;

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
        const children = await spaceActions.listSpaceTreeChildren(
          spacePath,
          parentKey || null,
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
        console.error("Failed to load tree children:", err);
        if (isRootParent && !hadCachedTree) {
          set((s) => ({
            fileTrees: { ...s.fileTrees, [spaceId]: [] },
          }));
        }
      } finally {
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
                : { treeLoading: withoutRecordKey(state.treeLoading, spaceId) }
              : {}),
            treeParentLoading: {
              ...state.treeParentLoading,
              [spaceId]: nextParentLoading,
            },
          };
        });
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

    patchEntryTreeMeta: (spaceId, path, title, icon, description) => {
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

    markTreeDirty: (spaceId) => {
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

    loadExpandedPaths: async (spaceId: string) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) return;
      try {
        const paths = await spaceActions.getSpaceExpandedPaths(spacePath);
        set((s) => ({
          expandedPaths: { ...s.expandedPaths, [spaceId]: paths },
          fileTrees: s.childrenByParentPath[spaceId]
            ? {
                ...s.fileTrees,
                [spaceId]: buildLoadedTree(
                  s.childrenByParentPath[spaceId],
                  paths,
                ),
              }
            : s.fileTrees,
        }));
      } catch {
        // ignore — no persisted state
      }
    },

    toggleExpanded: (spaceId: string, path: string) => {
      const current = get().expandedPaths[spaceId] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      set((s) => ({
        expandedPaths: { ...s.expandedPaths, [spaceId]: next },
        fileTrees: {
          ...s.fileTrees,
          [spaceId]: s.childrenByParentPath[spaceId]
            ? buildLoadedTree(s.childrenByParentPath[spaceId], next)
            : (s.fileTrees[spaceId] ?? []),
        },
      }));
      const spacePath = findSpacePath(get(), spaceId);
      if (spacePath) {
        spaceActions.saveSpaceExpandedPaths(spacePath, next).catch(() => {});
      }
    },

    moveEntry: async (spaceId: string, from: string, toParent: string) => {
      const spacePath = findSpacePath(get(), spaceId);
      if (!spacePath) throw new Error("Space not found");
      const oldParent = treeRowParentPath(from);
      const newPath = await spaceActions.moveSpaceEntry({
        spacePath,
        from,
        toParent,
        projectPath: get().activeRootPath,
      });
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
