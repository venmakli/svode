import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type {
  Workspace,
  WorkspaceConfig,
  TreeNode,
} from "@/types/workspace";

interface Entry {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

interface WorkspaceState {
  // Root workspaces (formerly "projects")
  rootWorkspaces: Workspace[];
  activeRootId: string | null;
  activeRootName: string | null;
  activeRootIcon: string | null;
  activeRootPath: string | null;

  // Spaces (formerly "children")
  spaces: Workspace[];
  activeSpaceId: string | null;

  // File trees & UI state
  fileTrees: Record<string, TreeNode[]>;
  isLoadingRoots: boolean;
  isLoadingSpaces: boolean;
  explicitHome: boolean;
  expandedPaths: Record<string, string[]>;

  // Root workspace methods
  loadRootWorkspaces: () => Promise<void>;
  openRoot: (id: string) => Promise<void>;
  createRoot: (
    name: string,
    icon: string,
    description: string | undefined,
    path: string,
  ) => Promise<Workspace>;
  openRootFolder: (path: string) => Promise<Workspace>;
  deleteRoot: (id: string, deleteFiles?: boolean) => Promise<void>;
  getLastActiveRootId: () => Promise<string | null>;

  // Space methods
  loadSpaces: (rootPath: string) => Promise<void>;
  openSpace: (id: string) => Promise<void>;
  createSpace: (
    parentPath: string,
    name: string,
    icon: string,
  ) => Promise<Workspace>;
  deleteSpace: (parentPath: string, spaceId: string, deleteFiles?: boolean) => Promise<void>;
  clearActiveSpace: () => void;

  // Document/tree methods
  createPage: (workspacePath: string, title: string) => Promise<Entry | null>;
  refreshTree: (workspaceId?: string) => Promise<void>;
  updateNodeMeta: (workspaceId: string, path: string, title: string, icon: string | null) => void;
  goHome: () => void;
  loadExpandedPaths: (workspaceId: string) => Promise<void>;
  toggleExpanded: (workspaceId: string, path: string) => void;
  moveEntry: (
    workspaceId: string,
    from: string,
    toParent: string,
  ) => Promise<string>;
  saveOrder: (
    workspaceId: string,
    order: Record<string, string[]>,
  ) => Promise<void>;
}

/** Find workspace path by id from either rootWorkspaces or spaces */
function findWorkspacePath(state: WorkspaceState, id: string): string | null {
  const root = state.rootWorkspaces.find((w) => w.id === id);
  if (root) return root.path;
  const space = state.spaces.find((w) => w.id === id);
  if (space) return space.path;
  return null;
}

/** Active workspace id: space if selected, otherwise root */
export function selectActiveWorkspaceId(state: WorkspaceState): string | null {
  return state.activeSpaceId ?? state.activeRootId;
}

/** Active workspace path: space if selected, otherwise root */
export function selectActiveWorkspacePath(state: WorkspaceState): string {
  if (state.activeSpaceId) {
    const space = state.spaces.find((w) => w.id === state.activeSpaceId);
    if (space) return space.path;
  }
  return state.activeRootPath ?? "";
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootWorkspaces: [],
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

  loadRootWorkspaces: async () => {
    set({ isLoadingRoots: true });
    try {
      const workspaces = await invoke<Workspace[]>("list_workspaces");
      set({ rootWorkspaces: workspaces });
    } catch (err) {
      console.error("Failed to load workspaces:", err);
      set({ rootWorkspaces: [] });
    } finally {
      set({ isLoadingRoots: false });
    }
  },

  openRoot: async (id: string) => {
    try {
      const config = await invoke<WorkspaceConfig>("open_workspace", { id });
      const ws = get().rootWorkspaces.find((w) => w.id === id);
      set({
        activeRootId: id,
        activeRootName: config.name,
        activeRootIcon: config.icon,
        activeRootPath: ws?.path ?? null,
        activeSpaceId: null,
        spaces: [],
        fileTrees: {},
        explicitHome: false,
      });
      // Load root file tree (project documents) and spaces
      if (ws?.path) {
        // Grant the webview access to this workspace's `.assets/` via the
        // Tauri asset protocol. Scope is per-app-session and the call is
        // idempotent — safe to repeat on every root open.
        invoke("ensure_assets_scope", { workspacePath: ws.path }).catch(
          (err) => console.warn("ensure_assets_scope failed:", err),
        );
        await get().refreshTree(id);
        await get().loadExpandedPaths(id);
        await get().loadSpaces(ws.path);
      }
    } catch (err) {
      console.error("Failed to open workspace:", err);
      toast.error(m.toast_error());
    }
  },

  createRoot: async (name, icon, description, path) => {
    const ws = await invoke<Workspace>("create_workspace", {
      name,
      icon,
      description,
      path,
    });
    set((s) => ({ rootWorkspaces: [...s.rootWorkspaces, ws] }));
    toast.success(m.toast_project_created());
    return ws;
  },

  openRootFolder: async (path: string) => {
    const ws = await invoke<Workspace>("open_workspace_folder", { path });
    set((s) => {
      const exists = s.rootWorkspaces.some((w) => w.id === ws.id);
      return exists ? {} : { rootWorkspaces: [...s.rootWorkspaces, ws] };
    });
    return ws;
  },

  deleteRoot: async (id, deleteFiles) => {
    await invoke("delete_workspace", { id, deleteFiles });
    const { activeRootId } = get();
    set((s) => ({
      rootWorkspaces: s.rootWorkspaces.filter((w) => w.id !== id),
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
    toast.success(m.toast_project_deleted());
  },

  getLastActiveRootId: async () => {
    try {
      return await invoke<string | null>("get_last_active_workspace");
    } catch {
      return null;
    }
  },

  loadSpaces: async (rootPath: string) => {
    set({ isLoadingSpaces: true });
    try {
      const spaces = await invoke<Workspace[]>("list_spaces", {
        workspacePath: rootPath,
      });
      set({ spaces });

      // Auto-select first space if none active
      if (spaces.length > 0 && !get().activeSpaceId) {
        await get().openSpace(spaces[0].id);
      }
    } catch (err) {
      console.error("Failed to load spaces:", err);
      set({ spaces: [] });
    } finally {
      set({ isLoadingSpaces: false });
    }
  },

  openSpace: async (id: string) => {
    set({ activeSpaceId: id });
    // Grant the webview access to this space's `.assets/` via
    // the Tauri asset protocol. Scope is per-app-session and idempotent
    // — safe to call every time the user activates a space.
    const space = get().spaces.find((w) => w.id === id);
    if (space?.path) {
      invoke("ensure_assets_scope", { workspacePath: space.path }).catch(
        (err) => console.warn("ensure_assets_scope failed:", err),
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
  },

  createSpace: async (parentPath, name, icon) => {
    const ws = await invoke<Workspace>("create_space", {
      parentPath,
      name,
      icon,
    });
    set((s) => ({ spaces: [...s.spaces, ws] }));
    await get().openSpace(ws.id);
    toast.success(m.toast_space_created());
    return ws;
  },

  deleteSpace: async (parentPath, spaceId, deleteFiles) => {
    await invoke("delete_space", { parentPath, spaceId, deleteFiles });
    const { activeSpaceId } = get();
    set((s) => ({
      spaces: s.spaces.filter((w) => w.id !== spaceId),
      ...(activeSpaceId === spaceId ? { activeSpaceId: null } : {}),
    }));
    toast.success(m.toast_space_deleted());
  },

  createPage: async (workspacePath: string, title: string) => {
    try {
      const entry = await invoke<Entry>("create_entry", {
        workspace: workspacePath,
        parentPath: null,
        title,
      });
      // Find workspace id by path and refresh its tree
      const state = get();
      const ws = [...state.rootWorkspaces, ...state.spaces].find(
        (w) => w.path === workspacePath,
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

  refreshTree: async (workspaceId?: string) => {
    const id = workspaceId ?? get().activeSpaceId ?? get().activeRootId;
    if (!id) return;

    const workspacePath = findWorkspacePath(get(), id);
    if (!workspacePath) return;

    try {
      const tree = await invoke<TreeNode[]>("list_entries", {
        workspace: workspacePath,
      });
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

  updateNodeMeta: (workspaceId: string, path: string, title: string, icon: string | null) => {
    const trees = get().fileTrees;
    const tree = trees[workspaceId];
    if (!tree) return;

    const update = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.path === path) {
          return { ...node, title, icon };
        }
        if (node.children.length > 0) {
          return { ...node, children: update(node.children) };
        }
        return node;
      });

    set({ fileTrees: { ...trees, [workspaceId]: update(tree) } });
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
  },

  loadExpandedPaths: async (workspaceId: string) => {
    const workspacePath = findWorkspacePath(get(), workspaceId);
    if (!workspacePath) return;
    try {
      const paths = await invoke<string[]>("get_expanded_paths", {
        workspace: workspacePath,
      });
      set((s) => ({
        expandedPaths: { ...s.expandedPaths, [workspaceId]: paths },
      }));
    } catch {
      // ignore — no persisted state
    }
  },

  toggleExpanded: (workspaceId: string, path: string) => {
    const current = get().expandedPaths[workspaceId] ?? [];
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    set((s) => ({
      expandedPaths: { ...s.expandedPaths, [workspaceId]: next },
    }));
    const workspacePath = findWorkspacePath(get(), workspaceId);
    if (workspacePath) {
      invoke("save_expanded_paths", {
        workspace: workspacePath,
        paths: next,
      }).catch(() => {});
    }
  },

  moveEntry: async (workspaceId: string, from: string, toParent: string) => {
    const workspacePath = findWorkspacePath(get(), workspaceId);
    if (!workspacePath) throw new Error("Workspace not found");
    const newPath = await invoke<string>("move_entry", {
      workspace: workspacePath,
      from,
      toParent,
    });
    await get().refreshTree(workspaceId);
    return newPath;
  },

  saveOrder: async (
    workspaceId: string,
    order: Record<string, string[]>,
  ) => {
    const workspacePath = findWorkspacePath(get(), workspaceId);
    if (!workspacePath) return;
    await invoke("save_tree_order", {
      workspace: workspacePath,
      order,
    });
  },
}));
