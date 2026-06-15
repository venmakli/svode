import { create } from "zustand";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  createEntry as createEntryNative,
  getExpandedPaths,
  listEntries,
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
} from "@/platform/space/space-api";
import type {
  SpaceInfo,
  SpaceGitType,
  TreeNode,
} from "@/types/space";

interface SpaceState {
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
  clearActiveSpace: () => void;

  // Document/tree methods
  createPage: (spacePath: string, title: string) => Promise<EntryDto | null>;
  refreshTree: (spaceId?: string) => Promise<void>;
  updateNodeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
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
      await get().refreshTree(id);
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

      // Auto-select first ready space if none active
      const readySpace = spaces.find((s) => s.status === "ready");
      if (readySpace && !get().activeSpaceId) {
        await get().openSpace(readySpace.id);
      } else {
        syncMcpContext(get());
      }
    } catch (err) {
      console.error("Failed to load spaces:", err);
      set({ spaces: [] });
    } finally {
      set({ isLoadingSpaces: false });
    }
  },

  openSpace: async (id: string) => {
    const space = get().spaces.find((w) => w.id === id);
    if (space?.status && space.status !== "ready") return;
    const activeRootPath = get().activeRootPath;
    if (space?.path && activeRootPath) {
      try {
        await ensureSpaceScaffold(activeRootPath, space.path);
      } catch (err) {
        console.warn("ensure_space_scaffold failed:", err);
      }
    }
    set({ activeSpaceId: id });
    syncMcpContext(get(), id);
    if (space?.path) {
      ensureAssetsScope(space.path).catch((err) =>
        console.warn("ensure_assets_scope failed:", err),
      );
    }
    if (!get().fileTrees[id]) {
      await get().refreshTree(id);
    }
    if (!get().expandedPaths[id]) {
      await get().loadExpandedPaths(id);
    }
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
    toast.success(m.toast_space_created());
    return ws;
  },

  deleteSpace: async (parentPath, spaceId, deleteFiles) => {
    await deleteSpaceNative(parentPath, spaceId, deleteFiles);
    const { activeSpaceId } = get();
    set((s) => ({
      spaces: s.spaces.filter((w) => w.id !== spaceId),
      ...(activeSpaceId === spaceId ? { activeSpaceId: null } : {}),
    }));
    if (activeSpaceId === spaceId) {
      syncMcpContext(get(), null);
    }
    toast.success(m.toast_space_deleted());
  },

  createPage: async (spacePath: string, title: string) => {
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
        await get().refreshTree(ws.id);
      }
      toast.success(m.toast_page_created());
      return entry;
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
      return null;
    }
  },

  refreshTree: async (spaceId?: string) => {
    const id = spaceId ?? get().activeSpaceId ?? get().activeRootId;
    if (!id) return;

    const spacePath = findSpacePath(get(), id);
    if (!spacePath) return;

    try {
      const tree = await listEntries(spacePath);
      set((s) => ({
        fileTrees: { ...s.fileTrees, [id]: tree },
      }));
    } catch (err) {
      console.error("Failed to load file tree:", err);
      set((s) => ({
        fileTrees: { ...s.fileTrees, [id]: [] },
      }));
    }
  },

  updateNodeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => {
    const trees = get().fileTrees;
    const tree = trees[spaceId];
    if (!tree) return;

    const update = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.path === path) {
          return {
            ...node,
            title,
            icon,
            ...(description !== undefined ? { description } : {}),
          };
        }
        if (node.children.length > 0) {
          return { ...node, children: update(node.children) };
        }
        return node;
      });

    set({ fileTrees: { ...trees, [spaceId]: update(tree) } });
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
    }));
    const spacePath = findSpacePath(get(), spaceId);
    if (spacePath) {
      saveExpandedPaths(spacePath, next).catch(() => {});
    }
  },

  moveEntry: async (spaceId: string, from: string, toParent: string) => {
    const spacePath = findSpacePath(get(), spaceId);
    if (!spacePath) throw new Error("Space not found");
    const newPath = await moveEntryNative({
      space: spacePath,
      from,
      toParent,
      projectPath: get().activeRootPath,
    });
    await get().refreshTree(spaceId);
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
