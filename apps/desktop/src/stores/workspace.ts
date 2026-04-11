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

  // Children (formerly "workspaces")
  children: Workspace[];
  activeChildId: string | null;

  // File trees & UI state
  fileTrees: Record<string, TreeNode[]>;
  isLoadingRoots: boolean;
  isLoadingChildren: boolean;
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

  // Children methods
  loadChildren: (rootPath: string) => Promise<void>;
  openChild: (id: string) => Promise<void>;
  createChild: (
    parentPath: string,
    name: string,
    icon: string,
  ) => Promise<Workspace>;
  deleteChild: (parentPath: string, childId: string, deleteFiles?: boolean) => Promise<void>;
  clearActiveChild: () => void;

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

/** Find workspace path by id from either rootWorkspaces or children */
function findWorkspacePath(state: WorkspaceState, id: string): string | null {
  const root = state.rootWorkspaces.find((w) => w.id === id);
  if (root) return root.path;
  const child = state.children.find((w) => w.id === id);
  if (child) return child.path;
  return null;
}

/** Active workspace id: child if selected, otherwise root */
export function selectActiveWorkspaceId(state: WorkspaceState): string | null {
  return state.activeChildId ?? state.activeRootId;
}

/** Active workspace path: child if selected, otherwise root */
export function selectActiveWorkspacePath(state: WorkspaceState): string {
  if (state.activeChildId) {
    const child = state.children.find((w) => w.id === state.activeChildId);
    if (child) return child.path;
  }
  return state.activeRootPath ?? "";
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootWorkspaces: [],
  activeRootId: null,
  activeRootName: null,
  activeRootIcon: null,
  activeRootPath: null,
  children: [],
  activeChildId: null,
  fileTrees: {},
  isLoadingRoots: false,
  isLoadingChildren: false,
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
        activeChildId: null,
        children: [],
        fileTrees: {},
        explicitHome: false,
      });
      // Load root file tree (project documents) and children
      if (ws?.path) {
        // Grant the webview access to this workspace's `.assets/` via the
        // Tauri asset protocol. Scope is per-app-session and the call is
        // idempotent — safe to repeat on every root open.
        invoke("ensure_assets_scope", { workspacePath: ws.path }).catch(
          (err) => console.warn("ensure_assets_scope failed:", err),
        );
        await get().refreshTree(id);
        await get().loadExpandedPaths(id);
        await get().loadChildren(ws.path);
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
            children: [],
            activeChildId: null,
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

  loadChildren: async (rootPath: string) => {
    set({ isLoadingChildren: true });
    try {
      const children = await invoke<Workspace[]>("list_children", {
        workspacePath: rootPath,
      });
      set({ children });

      // Auto-select first child if none active
      if (children.length > 0 && !get().activeChildId) {
        await get().openChild(children[0].id);
      }
    } catch (err) {
      console.error("Failed to load children:", err);
      set({ children: [] });
    } finally {
      set({ isLoadingChildren: false });
    }
  },

  openChild: async (id: string) => {
    set({ activeChildId: id });
    // Grant the webview access to this child workspace's `.assets/` via
    // the Tauri asset protocol. Scope is per-app-session and idempotent
    // — safe to call every time the user activates a child.
    const child = get().children.find((w) => w.id === id);
    if (child?.path) {
      invoke("ensure_assets_scope", { workspacePath: child.path }).catch(
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

  clearActiveChild: () => {
    set({ activeChildId: null });
  },

  createChild: async (parentPath, name, icon) => {
    const ws = await invoke<Workspace>("create_child", {
      parentPath,
      name,
      icon,
    });
    set((s) => ({ children: [...s.children, ws] }));
    await get().openChild(ws.id);
    toast.success(m.toast_workspace_created());
    return ws;
  },

  deleteChild: async (parentPath, childId, deleteFiles) => {
    await invoke("delete_child", { parentPath, childId, deleteFiles });
    const { activeChildId } = get();
    set((s) => ({
      children: s.children.filter((w) => w.id !== childId),
      ...(activeChildId === childId ? { activeChildId: null } : {}),
    }));
    toast.success(m.toast_workspace_deleted());
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
      const ws = [...state.rootWorkspaces, ...state.children].find(
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
    const id = workspaceId ?? get().activeChildId ?? get().activeRootId;
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
      children: [],
      activeChildId: null,
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
