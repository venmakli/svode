import { create } from "zustand";
import { logTiming, nowMs } from "@/shared/lib/performance";
import * as spaceActions from "../api/space-store-actions";
import {
  createEmptyLoadedSpaceTreeState,
  createSpaceTreeState,
  createTreeActivityPatch,
  hasSpaceExpandedPaths,
  isSpaceTreeLoaded,
  removeSpaceTreeState,
  shouldValidateSpaceTree,
  type SpaceTreeState,
} from "./space-tree-state";
import type {
  ProjectWindowRequest,
  RootEntry,
  SpaceGitType,
  SpaceInfo,
  WindowOpenIntent,
} from "./types";

export interface SpaceState extends SpaceTreeState {
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

  isLoadingRoots: boolean;
  isLoadingSpaces: boolean;
  explicitHome: boolean;

  // Root (project) methods
  loadRootSpaces: () => Promise<SpaceInfo[]>;
  /** Opens the project's Space in this window; its active project only records the opening. */
  openRoot: (id: string) => Promise<RootEntry>;
  /** Makes the project the active project of Home; `request` goes to its other window. */
  activateHomeRoot: (
    id: string,
    request: ProjectWindowRequest,
  ) => Promise<RootEntry>;
  openRootWindow: (id: string) => Promise<void>;
  createRoot: (
    name: string,
    icon: string,
    description: string | undefined,
    path: string,
  ) => Promise<SpaceInfo>;
  openRootFolder: (path: string) => Promise<SpaceInfo>;
  deleteRoot: (id: string, deleteFiles?: boolean) => Promise<void>;
  getWindowOpenIntent: () => Promise<WindowOpenIntent | null>;
  goHome: () => void;

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
  patchSpaceSchemaCapability: (spaceId: string, hasSchema: boolean) => void;
  patchSpaceAppCapability: (spaceId: string, hasApp: boolean) => void;
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

export function upsertSpaceSnapshot(
  spaces: readonly SpaceInfo[],
  snapshot: SpaceInfo,
): SpaceInfo[] {
  const index = spaces.findIndex((space) => space.id === snapshot.id);
  if (index === -1) return [...spaces, snapshot];
  return spaces.map((space, currentIndex) =>
    currentIndex === index ? snapshot : space,
  );
}

function syncMcpContext(
  state: SpaceState,
  activeSpaceId = state.activeSpaceId,
) {
  if (!state.activeRootId || !state.activeRootPath || !state.activeRootName) {
    spaceActions
      .clearActiveMcpContext()
      .catch((err) => console.warn("mcp_clear_active_context failed:", err));
    return;
  }

  spaceActions
    .setActiveMcpContext({
      projectPath: state.activeRootPath,
      activeSpaceId,
    })
    .catch((err) => console.warn("mcp_set_active_context failed:", err));
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
  isLoadingRoots: false,
  isLoadingSpaces: false,
  explicitHome: false,
  ...createSpaceTreeState<SpaceState>(set, get),

  loadRootSpaces: async () => {
    set({ isLoadingRoots: true });
    try {
      const projects = await spaceActions.listRootSpaces();
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

  openRoot: (id) =>
    enterRoot(id, () => spaceActions.openRootProject(id), { records: true }),

  activateHomeRoot: (id, request) =>
    get().activeRootId === id
      ? Promise.resolve("opened")
      : enterRoot(id, () => spaceActions.activateHomeRootProject(id, request), {
          records: false,
        }),

  openRootWindow: async (id: string) => {
    await spaceActions.openRootProjectWindow(id);
  },

  createRoot: async (name, icon, description, path) => {
    const ws = await spaceActions.createRootSpace({
      name,
      icon,
      description,
      path,
    });
    set((s) => ({ rootSpaces: [...s.rootSpaces, ws], rootsLoaded: true }));
    return ws;
  },

  openRootFolder: async (path: string) => {
    const ws = await spaceActions.openRootFolderSpace(path);
    set((state) => ({
      rootSpaces: upsertSpaceSnapshot(state.rootSpaces, ws),
      rootsLoaded: true,
    }));
    return ws;
  },

  deleteRoot: async (id, deleteFiles) => {
    await spaceActions.deleteRootSpace(id, deleteFiles);
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
            ...createEmptyLoadedSpaceTreeState(),
          }
        : {}),
    }));
    if (activeRootId === id) {
      spaceActions
        .clearActiveMcpContext()
        .catch((err) => console.warn("mcp_clear_active_context failed:", err));
    }
  },

  getWindowOpenIntent: async () => {
    try {
      return await spaceActions.getCurrentWindowOpenIntent();
    } catch {
      return null;
    }
  },

  // The active project stays active on Home without a restart.
  goHome: () => {
    set({ explicitHome: true });
    spaceActions
      .showHomeInCurrentRootProjectWindow()
      .catch((err) => console.warn("show_home_in_current_window failed:", err));
  },

  loadSpaces: async (rootPath: string) => {
    set({ isLoadingSpaces: true });
    try {
      const spaces = await spaceActions.listChildSpaces(rootPath);
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
    const treeWasLoaded = isSpaceTreeLoaded(get(), id);

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
    const needsTreeValidation = shouldValidateSpaceTree(get(), id);
    set({ activeSpaceId: id });
    syncMcpContext(get(), id);

    if (needsTreeValidation) {
      set((state) => createTreeActivityPatch(state, id, treeWasLoaded, true));
    }

    const validateTree = () => {
      if (get().activeSpaceId !== id) return;
      if (needsTreeValidation || shouldValidateSpaceTree(get(), id)) {
        void get().ensureTreeLoaded(id);
      } else if (!hasSpaceExpandedPaths(get(), id)) {
        void get().loadExpandedPaths(id);
      }
    };

    if (space?.path && activeRootPath) {
      spaceActions
        .ensureChildSpaceScaffold(activeRootPath, space.path)
        .catch((err) => console.warn("ensure_space_scaffold failed:", err))
        .finally(validateTree);
    } else {
      validateTree();
    }

    if (space?.path) {
      spaceActions
        .ensureSpaceAssetsScope(space.path)
        .catch((err) => console.warn("ensure_assets_scope failed:", err));
    }

    logTiming("space.open", startedAt, {
      spaceId: id,
      cachedTree: treeWasLoaded,
      ready: true,
      treeLoaded: isSpaceTreeLoaded(get(), id),
      backgroundValidation: needsTreeValidation,
    });
  },

  clearActiveSpace: () => {
    set({ activeSpaceId: null });
    syncMcpContext(get(), null);
  },

  createSpace: async (parentPath, name, icon, folderName, gitType) => {
    const ws = await spaceActions.createChildSpace({
      parentPath,
      name,
      icon,
      folderName,
      gitType,
    });
    set((s) => ({ spaces: [...s.spaces, ws] }));
    await get().openSpace(ws.id);
    return ws;
  },

  deleteSpace: async (parentPath, spaceId, deleteFiles) => {
    await spaceActions.deleteChildSpace(parentPath, spaceId, deleteFiles);
    const { activeSpaceId } = get();
    set((s) => ({
      spaces: s.spaces.filter((w) => w.id !== spaceId),
      ...(activeSpaceId === spaceId ? { activeSpaceId: null } : {}),
      ...removeSpaceTreeState(s, spaceId),
    }));
    if (activeSpaceId === spaceId) {
      syncMcpContext(get(), null);
    }
  },

  reorderSpaces: async (orderedSpaceIds) => {
    const { activeRootPath } = get();
    if (!activeRootPath) return;
    const spaces = await spaceActions.reorderChildSpaces(
      activeRootPath,
      orderedSpaceIds,
    );
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

  patchSpaceSchemaCapability: (spaceId, hasSchema) => {
    set((state) => ({
      rootSpaces: state.rootSpaces.map((space) =>
        space.id === spaceId ? { ...space, hasSchema } : space,
      ),
      spaces: state.spaces.map((space) =>
        space.id === spaceId ? { ...space, hasSchema } : space,
      ),
    }));
  },

  patchSpaceAppCapability: (spaceId, hasApp) => {
    set((state) => ({
      rootSpaces: state.rootSpaces.map((space) =>
        space.id === spaceId ? { ...space, hasApp } : space,
      ),
      spaces: state.spaces.map((space) =>
        space.id === spaceId ? { ...space, hasApp } : space,
      ),
    }));
  },
}));

/**
 * The window enters the project: a project of another window stays there,
 * the active project keeps its tree and content, another one replaces it.
 * Only an opening leaves Home.
 */
async function enterRoot(
  id: string,
  enter: () => ReturnType<typeof spaceActions.openRootProject>,
  { records }: { records: boolean },
): Promise<RootEntry> {
  const store = useSpaceStore;
  try {
    const result = await enter();
    if (result.kind === "otherWindow") return "otherWindow";
    const { config, project } = result;
    const projects = store.getState().rootsLoaded
      ? store.getState().rootSpaces
      : await store.getState().loadRootSpaces();
    const leaveHome = records ? { explicitHome: false } : {};
    if (store.getState().activeRootId === id) {
      store.setState({
        rootSpaces: upsertSpaceSnapshot(projects, project),
        rootsLoaded: true,
        ...leaveHome,
      });
      return "opened";
    }
    store.setState({
      rootSpaces: upsertSpaceSnapshot(projects, project),
      rootsLoaded: true,
      activeRootId: id,
      activeRootName: config.name,
      activeRootIcon: config.icon,
      activeRootPath: project.path,
      activeSpaceId: null,
      spaces: [],
      ...createEmptyLoadedSpaceTreeState(),
      ...leaveHome,
    });
    syncMcpContext(store.getState(), null);
    // Load the root content tree and spaces.
    // Grant the webview access to this project's `.assets/` via the
    // Tauri asset protocol. Scope is per-app-session and the call is
    // idempotent — safe to repeat on every project open.
    spaceActions
      .ensureSpaceAssetsScope(project.path)
      .catch((err) => console.warn("ensure_assets_scope failed:", err));
    await store.getState().loadTreeChildren(id);
    await store.getState().loadExpandedPaths(id);
    await store.getState().loadSpaces(project.path);
    return "opened";
  } catch (err) {
    console.error("Failed to open project:", err);
    return "failed";
  }
}
