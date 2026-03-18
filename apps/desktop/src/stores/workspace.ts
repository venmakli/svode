import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type {
  Project,
  ProjectConfig,
  Workspace,
  TreeNode,
} from "@/types/workspace";

interface Entry {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

interface WorkspaceState {
  projects: Project[];
  activeProjectId: string | null;
  activeProjectName: string | null;
  activeProjectIcon: string | null;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  fileTrees: Record<string, TreeNode[]>;
  isLoadingProjects: boolean;
  isLoadingWorkspaces: boolean;
  /** True when user explicitly navigated home — skip auto-open */
  explicitHome: boolean;

  loadProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  createProject: (
    name: string,
    icon: string,
    description?: string,
  ) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  loadWorkspaces: (projectId: string) => Promise<void>;
  openWorkspace: (id: string) => Promise<void>;
  createWorkspace: (
    projectId: string,
    name: string,
    path: string,
  ) => Promise<Workspace>;
  openFolderAsWorkspace: (
    projectId: string,
    path: string,
  ) => Promise<Workspace>;
  deleteWorkspace: (projectId: string, workspaceId: string) => Promise<void>;
  createPage: (workspaceId: string, title: string) => Promise<Entry | null>;
  refreshTree: (workspaceId?: string) => Promise<void>;
  updateNodeMeta: (path: string, title: string, icon: string | null) => void;
  getLastActiveProjectId: () => Promise<string | null>;
  goHome: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeProjectName: null,
  activeProjectIcon: null,
  workspaces: [],
  activeWorkspaceId: null,
  fileTrees: {},
  isLoadingProjects: false,
  isLoadingWorkspaces: false,
  explicitHome: false,

  loadProjects: async () => {
    set({ isLoadingProjects: true });
    try {
      const projects = await invoke<Project[]>("list_projects");
      set({ projects });
    } catch (err) {
      console.error("Failed to load projects:", err);
      set({ projects: [] });
    } finally {
      set({ isLoadingProjects: false });
    }
  },

  openProject: async (id: string) => {
    try {
      const config = await invoke<ProjectConfig>("open_project", { id });
      set({
        activeProjectId: id,
        activeProjectName: config.name,
        activeProjectIcon: config.icon,
        activeWorkspaceId: null,
        fileTrees: {},
        explicitHome: false,
      });
      await get().loadWorkspaces(id);
    } catch (err) {
      console.error("Failed to open project:", err);
      toast.error(m.toast_error());
    }
  },

  createProject: async (name: string, icon: string, description?: string) => {
    const project = await invoke<Project>("create_project", {
      name,
      icon,
      description,
    });
    set((s) => ({ projects: [...s.projects, project] }));
    toast.success(m.toast_project_created());
    return project;
  },

  deleteProject: async (id: string) => {
    await invoke("delete_project", { id });
    const { activeProjectId } = get();
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      ...(activeProjectId === id
        ? {
            activeProjectId: null,
            activeProjectName: null,
            activeProjectIcon: null,
            workspaces: [],
            activeWorkspaceId: null,
            fileTrees: {},
          }
        : {}),
    }));
    toast.success(m.toast_project_deleted());
  },

  loadWorkspaces: async (projectId: string) => {
    set({ isLoadingWorkspaces: true });
    try {
      const workspaces = await invoke<Workspace[]>("list_workspaces", {
        projectId,
      });
      set({ workspaces });

      // Check for missing workspaces and warn
      for (const ws of workspaces) {
        if (!ws.exists) {
          toast.error(m.workspace_not_found({ path: ws.path }));
        }
      }

      // Auto-select first workspace if none active
      if (workspaces.length > 0 && !get().activeWorkspaceId) {
        const firstExisting = workspaces.find((w) => w.exists);
        if (firstExisting) {
          await get().openWorkspace(firstExisting.id);
        }
      }
    } catch (err) {
      console.error("Failed to load workspaces:", err);
      set({ workspaces: [] });
    } finally {
      set({ isLoadingWorkspaces: false });
    }
  },

  openWorkspace: async (id: string) => {
    set({ activeWorkspaceId: id });
    // Load tree if not cached
    if (!get().fileTrees[id]) {
      await get().refreshTree(id);
    }
  },

  createWorkspace: async (
    projectId: string,
    name: string,
    path: string,
  ) => {
    const workspace = await invoke<Workspace>("create_workspace", {
      projectId,
      name,
      path,
    });
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    await get().openWorkspace(workspace.id);
    toast.success(m.toast_workspace_created());
    return workspace;
  },

  openFolderAsWorkspace: async (projectId: string, path: string) => {
    const workspace = await invoke<Workspace>("open_folder_as_workspace", {
      projectId,
      path,
    });
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    await get().openWorkspace(workspace.id);
    toast.success(m.toast_workspace_opened());
    return workspace;
  },

  deleteWorkspace: async (projectId: string, workspaceId: string) => {
    await invoke("delete_workspace", { projectId, workspaceId });
    const { activeWorkspaceId } = get();
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
      ...(activeWorkspaceId === workspaceId
        ? { activeWorkspaceId: null }
        : {}),
    }));
  },

  createPage: async (workspaceId: string, title: string) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;

    try {
      const entry = await invoke<Entry>("create_entry", {
        workspace: workspace.path,
        parentPath: null,
        title,
      });
      await get().refreshTree(workspaceId);
      toast.success(m.toast_page_created());
      return entry;
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
      return null;
    }
  },

  refreshTree: async (workspaceId?: string) => {
    const id = workspaceId ?? get().activeWorkspaceId;
    if (!id) return;

    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;

    try {
      const tree = await invoke<TreeNode[]>("list_entries", {
        workspace: workspace.path,
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

  updateNodeMeta: (path: string, title: string, icon: string | null) => {
    const id = get().activeWorkspaceId;
    if (!id) return;
    const trees = get().fileTrees;
    const tree = trees[id];
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

    set({ fileTrees: { ...trees, [id]: update(tree) } });
  },

  getLastActiveProjectId: async () => {
    try {
      return await invoke<string | null>("get_last_active_project");
    } catch {
      return null;
    }
  },

  goHome: () => {
    set({
      activeProjectId: null,
      activeProjectName: null,
      activeProjectIcon: null,
      workspaces: [],
      activeWorkspaceId: null,
      fileTrees: {},
      explicitHome: true,
    });
  },
}));
