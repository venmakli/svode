import { create } from "zustand";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  createEntry as createEntryNative,
  getExpandedPaths,
  listEntries,
  listTreeChildren,
  moveEntry as moveEntryNative,
  saveExpandedPaths,
  saveTreeOrder,
  type EntryDto,
} from "@/platform/entries/entries-api";
import { clearMcpActiveContext, setMcpActiveContext } from "@/platform/mcp";
import {
  createProject,
  createSpace as createSpaceNative,
  deleteProject,
  deleteSpace as deleteSpaceNative,
  ensureAssetsScope,
  ensureSpaceScaffold,
  getLastActiveProject,
  listProjects,
  listSpaces,
  openProject,
  openProjectFolder,
  reorderSpaces as reorderSpacesNative,
} from "@/platform/space/space-api";
import { useEntrySelectionStore, type TreeNode } from "@/features/entry";
import { logTiming, nowMs } from "@/shared/lib/performance";
import {
  applyReadmeMeta as applyReadmeMetaPatch,
  isReadmePath,
  isSystemIgnoredTreePath,
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
import type { SpaceInfo, SpaceGitType } from "./types";

type RefreshTreeOptions = { continuePending?: boolean };
type LoadTreeChildrenOptions = { force?: boolean };

export interface SpaceState {
  // Root spaces (projects on the home page)
  rootSpaces: SpaceInfo[];
  rootsLoaded: boolean;
  activeRootId: string | null;
  activeRootName: string | null;
  activeRootIcon: string | null;
  activeRootPath: string | null;

  // Nested spaces inside the active project
  spaces: SpaceInfo[];
  activeSpaceId: string | null;

  // File trees & UI state
  fileTrees: Record<string, TreeNode[]>;
  childrenByParentPath: Record<string, ChildrenByParentPath>;
  treeCache: Record<string, { loadedAt: number; dirty: boolean }>;
  treeParentCache: Record<string, TreeParentCache>;
  treeLoading: Record<string, boolean>;
  treeParentLoading: Record<string, Record<string, boolean>>;
  treeRefreshing: Record<string, boolean>;
  isLoadingRoots: boolean;
  isLoadingSpaces: boolean;
  explicitHome: boolean;
  expandedPaths: Record<string, string[]>;

  // Root (project) methods
  loadRootSpaces: () => Promise<SpaceInfo[]>;
  openRoot: (id: string) => Promise<boolean>;
  openLastActiveRoot: () => Promise<boolean>;
  createRoot: (
    name: string,
    icon: string,
    description: string | undefined,
    path: string,
  ) => Promise<SpaceInfo>;
  openRootFolder: (path: string) => Promise<SpaceInfo>;
  deleteRoot: (id: string, deleteFiles?: boolean) => Promise<void>;
  getLastActiveRootId: () => Promise<string | null>;

  // Space methods
  loadSpaces: (rootPath: string) => Promise<void>;
  openSpace: (id: string) => Promise<void>;
  createSpace: (
    parentPath: string,
    name: string,
    icon: string,
    folderName: string,
    gitType: SpaceGitType,
  ) => Promise<SpaceInfo>;
  deleteSpace: (
    parentPath: string,
    spaceId: string,
    deleteFiles?: boolean,
  ) => Promise<void>;
  reorderSpaces: (orderedSpaceIds: string[]) => Promise<void>;
  clearActiveSpace: () => void;
  patchSpaceMetadata: (
    spacePath: string,
    updates: { name?: string; icon?: string; description?: string },
  ) => void;

  // Document/tree methods
  createEntry: (spacePath: string, title: string) => Promise<EntryDto | null>;
  createPage: (spacePath: string, title: string) => Promise<EntryDto | null>;
  // Full recursive repair fallback only. Ordinary UI mutations should use
  // parent-level reload/patch helpers below.
  refreshTree: (
    spaceId?: string,
    options?: RefreshTreeOptions,
  ) => Promise<void>;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
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
  goHome: () => void;
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

/** Find space path by id from either rootSpaces or spaces */
function findSpacePath(state: SpaceState, id: string): string | null {
  const root = state.rootSpaces.find((w) => w.id === id);
  if (root) return root.path;
  const space = state.spaces.find((w) => w.id === id);
  if (space) return space.path;
  return null;
}

/** Active space id: nested space if selected, otherwise root project */
export function selectActiveSpaceId(state: SpaceState): string | null {
  return state.activeSpaceId ?? state.activeRootId;
}

/** Active space path: nested space if selected, otherwise root project */
export function selectActiveSpacePath(state: SpaceState): string {
  if (state.activeSpaceId) {
    const space = state.spaces.find((w) => w.id === state.activeSpaceId);
    if (space) return space.path;
  }
  return state.activeRootPath ?? "";
}

function syncMcpContext(
  state: SpaceState,
  activeSpaceId = state.activeSpaceId,
) {
  if (!state.activeRootId || !state.activeRootPath || !state.activeRootName) {
    clearMcpActiveContext().catch((err) =>
      console.warn("mcp_clear_active_context failed:", err),
    );
    return;
  }

  setMcpActiveContext({
    projectPath: state.activeRootPath,
    activeSpaceId,
  }).catch((err) => console.warn("mcp_set_active_context failed:", err));
}

function hasScopeReadme(nodes: TreeNode[]): boolean {
  return nodes.some((node) => node.path.toLowerCase() === "readme.md");
}

function openScopeHomeSelection(spaceId: string, tree: TreeNode[]) {
  const selection = useEntrySelectionStore.getState();
  if (hasScopeReadme(tree)) {
    selection.openDocument("README.md", spaceId);
  } else {
    selection.openScopeHome(spaceId);
  }
}

function hasRecordKey<T>(record: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function withoutRecordKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

const TREE_CACHE_TTL_MS = 2 * 60 * 1000;
const EXPANDED_TREE_LOAD_CONCURRENCY = 4;

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

function shouldValidateTree(state: SpaceState, spaceId: string): boolean {
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
  state: SpaceState,
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
  state: SpaceState,
  spaceId: string,
  childrenByParentPath = state.childrenByParentPath[spaceId],
): TreeNode[] {
  return buildLoadedTree(childrenByParentPath, state.expandedPaths[spaceId]);
}

function treeActivityPatch(
  state: SpaceState,
  spaceId: string,
  hadCachedTree: boolean,
  active: boolean,
) {
  const key = hadCachedTree ? "treeRefreshing" : "treeLoading";
  return {
    [key]: active
      ? { ...state[key], [spaceId]: true }
      : withoutRecordKey(state[key], spaceId),
  };
}

function countTreeNodes(nodes: TreeNode[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countTreeNodes(node.children),
    0,
  );
}

export const useSpaceStore = create<SpaceState>((set, get) => ({
  rootSpaces: [],
  rootsLoaded: false,
  activeRootId: null,
  activeRootName: null,
  activeRootIcon: null,
  activeRootPath: null,
  spaces: [],
  activeSpaceId: null,
  fileTrees: {},
  childrenByParentPath: {},
  treeCache: {},
  treeParentCache: {},
  treeLoading: {},
  treeParentLoading: {},
  treeRefreshing: {},
  isLoadingRoots: false,
  isLoadingSpaces: false,
  explicitHome: false,
  expandedPaths: {},

  loadRootSpaces: async () => {
    set({ isLoadingRoots: true });
    try {
      const projects = await listProjects();
      set({ rootSpaces: projects, rootsLoaded: true });
      return projects;
    } catch (err) {
      console.error("Failed to load projects:", err);
      set({ rootSpaces: [], rootsLoaded: true });
      return [];
    } finally {
      set({ isLoadingRoots: false });
    }
  },

  openRoot: async (id: string) => {
    try {
      if (!get().rootsLoaded) {
        await get().loadRootSpaces();
      }

      const ws = get().rootSpaces.find((w) => w.id === id);
      if (!ws) {
        throw new Error("Project not found");
      }

      const config = await openProject(id);
      set({
        activeRootId: id,
        activeRootName: config.name,
        activeRootIcon: config.icon,
        activeRootPath: ws.path,
        activeSpaceId: null,
        spaces: [],
        fileTrees: {},
        childrenByParentPath: {},
        treeCache: {},
        treeParentCache: {},
        treeLoading: {},
        treeParentLoading: {},
        treeRefreshing: {},
        explicitHome: false,
      });
      syncMcpContext(get(), null);
      // Load root file tree (project documents) and spaces
      // Grant the webview access to this project's `.assets/` via the
      // Tauri asset protocol. Scope is per-app-session and the call is
      // idempotent — safe to repeat on every project open.
      ensureAssetsScope(ws.path).catch((err) =>
        console.warn("ensure_assets_scope failed:", err),
      );
      await get().loadTreeChildren(id, ROOT_TREE_PARENT);
      openScopeHomeSelection(id, get().fileTrees[id] ?? []);
      await get().loadExpandedPaths(id);
      await get().loadSpaces(ws.path);
      return true;
    } catch (err) {
      console.error("Failed to open project:", err);
      toast.error(m.toast_error());
      return false;
    }
  },

  openLastActiveRoot: async () => {
    const projects = get().rootsLoaded
      ? get().rootSpaces
      : await get().loadRootSpaces();
    const lastActiveId = await get().getLastActiveRootId();
    if (!lastActiveId) return false;
    if (!projects.some((w) => w.id === lastActiveId)) return false;
    return get().openRoot(lastActiveId);
  },

  createRoot: async (name, icon, description, path) => {
    const ws = await createProject({
      name,
      icon,
      description,
      path,
    });
    set((s) => ({ rootSpaces: [...s.rootSpaces, ws], rootsLoaded: true }));
    toast.success(m.toast_project_created());
    return ws;
  },

  openRootFolder: async (path: string) => {
    const ws = await openProjectFolder(path);
    set((s) => {
      const exists = s.rootSpaces.some((w) => w.id === ws.id);
      return exists
        ? { rootsLoaded: true }
        : { rootSpaces: [...s.rootSpaces, ws], rootsLoaded: true };
    });
    return ws;
  },

  deleteRoot: async (id, deleteFiles) => {
    await deleteProject(id, deleteFiles);
    const { activeRootId } = get();
    set((s) => ({
      rootSpaces: s.rootSpaces.filter((w) => w.id !== id),
      ...(activeRootId === id
        ? {
            activeRootId: null,
            activeRootName: null,
            activeRootIcon: null,
            activeRootPath: null,
            spaces: [],
            activeSpaceId: null,
            fileTrees: {},
            childrenByParentPath: {},
            treeCache: {},
            treeParentCache: {},
            treeLoading: {},
            treeParentLoading: {},
            treeRefreshing: {},
          }
        : {}),
    }));
    if (activeRootId === id) {
      clearMcpActiveContext().catch((err) =>
        console.warn("mcp_clear_active_context failed:", err),
      );
    }
    toast.success(m.toast_project_deleted());
  },

  getLastActiveRootId: async () => {
    try {
      return await getLastActiveProject();
    } catch {
      return null;
    }
  },

  loadSpaces: async (rootPath: string) => {
    set({ isLoadingSpaces: true });
    try {
      const spaces = await listSpaces(rootPath);
      set({ spaces });
      syncMcpContext(get(), get().activeSpaceId);
    } catch (err) {
      console.error("Failed to load spaces:", err);
      set({ spaces: [] });
    } finally {
      set({ isLoadingSpaces: false });
    }
  },

  openSpace: async (id: string) => {
    const startedAt = nowMs();
    const space = get().spaces.find((w) => w.id === id);
    const treeWasLoaded = hasRecordKey(get().fileTrees, id);

    if (!space || space.status !== "ready") {
      logTiming("space.open", startedAt, {
        spaceId: id,
        cachedTree: treeWasLoaded,
        ready: false,
        treeLoaded: treeWasLoaded,
      });
      return;
    }

    const activeRootPath = get().activeRootPath;
    const needsTreeValidation = shouldValidateTree(get(), id);
    set({ activeSpaceId: id });
    syncMcpContext(get(), id);

    if (needsTreeValidation) {
      set((state) => treeActivityPatch(state, id, treeWasLoaded, true));
    }

    const validateTree = () => {
      if (get().activeSpaceId !== id) return;
      if (needsTreeValidation || shouldValidateTree(get(), id)) {
        void get().ensureTreeLoaded(id);
      } else if (!hasRecordKey(get().expandedPaths, id)) {
        void get().loadExpandedPaths(id);
      }
    };

    if (space?.path && activeRootPath) {
      ensureSpaceScaffold(activeRootPath, space.path)
        .catch((err) => console.warn("ensure_space_scaffold failed:", err))
        .finally(validateTree);
    } else {
      validateTree();
    }

    if (space?.path) {
      ensureAssetsScope(space.path).catch((err) =>
        console.warn("ensure_assets_scope failed:", err),
      );
    }

    logTiming("space.open", startedAt, {
      spaceId: id,
      cachedTree: treeWasLoaded,
      ready: true,
      treeLoaded: hasRecordKey(get().fileTrees, id),
      backgroundValidation: needsTreeValidation,
    });
  },

  clearActiveSpace: () => {
    set({ activeSpaceId: null });
    syncMcpContext(get(), null);
  },

  createSpace: async (parentPath, name, icon, folderName, gitType) => {
    const ws = await createSpaceNative({
      parentPath,
      name,
      icon,
      folderName,
      gitType,
    });
    set((s) => ({ spaces: [...s.spaces, ws] }));
    await get().openSpace(ws.id);
    useEntrySelectionStore.getState().openDocument("README.md", ws.id);
    toast.success(m.toast_space_created());
    return ws;
  },

  deleteSpace: async (parentPath, spaceId, deleteFiles) => {
    await deleteSpaceNative(parentPath, spaceId, deleteFiles);
    const { activeSpaceId } = get();
    set((s) => ({
      spaces: s.spaces.filter((w) => w.id !== spaceId),
      ...(activeSpaceId === spaceId ? { activeSpaceId: null } : {}),
      fileTrees: withoutRecordKey(s.fileTrees, spaceId),
      childrenByParentPath: withoutRecordKey(s.childrenByParentPath, spaceId),
      treeCache: withoutRecordKey(s.treeCache, spaceId),
      treeParentCache: withoutRecordKey(s.treeParentCache, spaceId),
      treeLoading: withoutRecordKey(s.treeLoading, spaceId),
      treeParentLoading: withoutRecordKey(s.treeParentLoading, spaceId),
      treeRefreshing: withoutRecordKey(s.treeRefreshing, spaceId),
      expandedPaths: withoutRecordKey(s.expandedPaths, spaceId),
    }));
    if (activeSpaceId === spaceId) {
      syncMcpContext(get(), null);
    }
    toast.success(m.toast_space_deleted());
  },

  reorderSpaces: async (orderedSpaceIds) => {
    const { activeRootPath } = get();
    if (!activeRootPath) return;
    const spaces = await reorderSpacesNative(activeRootPath, orderedSpaceIds);
    set({ spaces });
  },

  patchSpaceMetadata: (spacePath, updates) => {
    set((state) => {
      const isRoot = spacePath === state.activeRootPath;
      return {
        ...(isRoot && updates.name !== undefined
          ? { activeRootName: updates.name }
          : {}),
        ...(isRoot && updates.icon !== undefined
          ? { activeRootIcon: updates.icon }
          : {}),
        rootSpaces: state.rootSpaces.map((space) =>
          space.path === spacePath ? { ...space, ...updates } : space,
        ),
        spaces: state.spaces.map((space) =>
          space.path === spacePath ? { ...space, ...updates } : space,
        ),
      };
    });
  },

  createEntry: async (spacePath: string, title: string) => {
    try {
      const entry = await createEntryNative({
        space: spacePath,
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
      toast.success(m.toast_page_created());
      return entry;
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
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
    const hadCachedTree = hasRecordKey(get().fileTrees, id);
    const alreadyPending = hadCachedTree
      ? get().treeRefreshing[id]
      : get().treeLoading[id];
    if (alreadyPending && !options?.continuePending) return;

    let status: "ok" | "error" = "ok";
    let nodeCount = 0;
    set((state) => treeActivityPatch(state, id, hadCachedTree, true));
    try {
      const tree = await listEntries(spacePath);
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

    if (!hasRecordKey(get().expandedPaths, spaceId)) {
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
    const hadCachedTree = hasRecordKey(get().fileTrees, spaceId);
    const startedAt = nowMs();
    let status: "ok" | "error" = "ok";
    let nodeCount = 0;

    set((state) => ({
      ...(isRootParent
        ? treeActivityPatch(state, spaceId, hadCachedTree, true)
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
      const children = await listTreeChildren(spacePath, parentKey || null);
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
            [spaceId]: rebuildVisibleTree(state, spaceId, nextChildrenByParent),
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

  goHome: () => {
    set({
      activeRootId: null,
      activeRootName: null,
      activeRootIcon: null,
      activeRootPath: null,
      spaces: [],
      activeSpaceId: null,
      fileTrees: {},
      childrenByParentPath: {},
      treeCache: {},
      treeParentCache: {},
      treeLoading: {},
      treeParentLoading: {},
      treeRefreshing: {},
      expandedPaths: {},
      explicitHome: true,
    });
    clearMcpActiveContext().catch((err) =>
      console.warn("mcp_clear_active_context failed:", err),
    );
  },

  loadExpandedPaths: async (spaceId: string) => {
    const spacePath = findSpacePath(get(), spaceId);
    if (!spacePath) return;
    try {
      const paths = await getExpandedPaths(spacePath);
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
      saveExpandedPaths(spacePath, next).catch(() => {});
    }
  },

  moveEntry: async (spaceId: string, from: string, toParent: string) => {
    const spacePath = findSpacePath(get(), spaceId);
    if (!spacePath) throw new Error("Space not found");
    const oldParent = treeRowParentPath(from);
    const newPath = await moveEntryNative({
      space: spacePath,
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
    await saveTreeOrder({
      space: spacePath,
      order,
      projectPath: get().activeRootPath,
    });
  },
}));
