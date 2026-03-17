import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  ProjectConfig,
  Workspace,
  TreeNode,
} from "@/types/workspace";

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
  refreshTree: (workspaceId?: string) => Promise<void>;
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
      });
      await get().loadWorkspaces(id);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  },

  createProject: async (name: string, icon: string, description?: string) => {
    const project = await invoke<Project>("create_project", {
      name,
      icon,
      description,
    });
    set((s) => ({ projects: [...s.projects, project] }));
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
  },

  loadWorkspaces: async (projectId: string) => {
    set({ isLoadingWorkspaces: true });
    try {
      const workspaces = await invoke<Workspace[]>("list_workspaces", {
        projectId,
      });
      set({ workspaces });
      // Auto-select first workspace if none active
      if (workspaces.length > 0 && !get().activeWorkspaceId) {
        await get().openWorkspace(workspaces[0].id);
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
    return workspace;
  },

  openFolderAsWorkspace: async (projectId: string, path: string) => {
    const workspace = await invoke<Workspace>("open_folder_as_workspace", {
      projectId,
      path,
    });
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    await get().openWorkspace(workspace.id);
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

  goHome: () => {
    set({
      activeProjectId: null,
      activeProjectName: null,
      activeProjectIcon: null,
      workspaces: [],
      activeWorkspaceId: null,
      fileTrees: {},
    });
  },
}));
