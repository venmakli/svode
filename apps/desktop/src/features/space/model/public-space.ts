import { useSpaceStore, type SpaceState } from "./space-store";
import type { SpaceInfo } from "./types";

export type SpacePublicState = Pick<
  SpaceState,
  | "rootSpaces"
  | "rootsLoaded"
  | "activeRootId"
  | "activeRootName"
  | "activeRootIcon"
  | "activeRootPath"
  | "spaces"
  | "activeSpaceId"
  | "fileTrees"
  | "isLoadingRoots"
  | "explicitHome"
  | "loadRootSpaces"
  | "openRoot"
  | "openLastActiveRoot"
  | "createRoot"
  | "openRootFolder"
  | "deleteRoot"
  | "loadSpaces"
  | "openSpace"
  | "clearActiveSpace"
  | "patchSpaceMetadata"
  | "goHome"
>;

export type SpaceTreeSyncState = Pick<
  SpaceState,
  | "fileTrees"
  | "childrenByParentPath"
  | "loadTreeChildren"
  | "reloadTreeParent"
  | "reloadTreePathParent"
  | "reloadTreePathParents"
  | "patchEntryTreeMeta"
  | "removeTreePath"
>;

function selectPublicState(state: SpaceState): SpacePublicState {
  return {
    rootSpaces: state.rootSpaces,
    rootsLoaded: state.rootsLoaded,
    activeRootId: state.activeRootId,
    activeRootName: state.activeRootName,
    activeRootIcon: state.activeRootIcon,
    activeRootPath: state.activeRootPath,
    spaces: state.spaces,
    activeSpaceId: state.activeSpaceId,
    fileTrees: state.fileTrees,
    isLoadingRoots: state.isLoadingRoots,
    explicitHome: state.explicitHome,
    loadRootSpaces: state.loadRootSpaces,
    openRoot: state.openRoot,
    openLastActiveRoot: state.openLastActiveRoot,
    createRoot: state.createRoot,
    openRootFolder: state.openRootFolder,
    deleteRoot: state.deleteRoot,
    loadSpaces: state.loadSpaces,
    openSpace: state.openSpace,
    clearActiveSpace: state.clearActiveSpace,
    patchSpaceMetadata: state.patchSpaceMetadata,
    goHome: state.goHome,
  };
}

function selectTreeSyncState(state: SpaceState): SpaceTreeSyncState {
  return {
    fileTrees: state.fileTrees,
    childrenByParentPath: state.childrenByParentPath,
    loadTreeChildren: state.loadTreeChildren,
    reloadTreeParent: state.reloadTreeParent,
    reloadTreePathParent: state.reloadTreePathParent,
    reloadTreePathParents: state.reloadTreePathParents,
    patchEntryTreeMeta: state.patchEntryTreeMeta,
    removeTreePath: state.removeTreePath,
  };
}

export function useSpace(): SpacePublicState;
export function useSpace<T>(selector: (state: SpacePublicState) => T): T;
export function useSpace<T>(
  selector?: (state: SpacePublicState) => T,
): SpacePublicState | T {
  if (selector) {
    return useSpaceStore((state) => selector(state));
  }
  return useSpaceStore(selectPublicState);
}

export function getSpaceSnapshot(): SpacePublicState {
  return selectPublicState(useSpaceStore.getState());
}

export function useSpaceTreeSync(): SpaceTreeSyncState;
export function useSpaceTreeSync<T>(
  selector: (state: SpaceTreeSyncState) => T,
): T;
export function useSpaceTreeSync<T>(
  selector?: (state: SpaceTreeSyncState) => T,
): SpaceTreeSyncState | T {
  if (selector) {
    return useSpaceStore((state) => selector(selectTreeSyncState(state)));
  }
  return useSpaceStore(selectTreeSyncState);
}

export function getSpaceTreeSyncSnapshot(): SpaceTreeSyncState {
  return selectTreeSyncState(useSpaceStore.getState());
}

export function registerRootSpace(space: SpaceInfo): void {
  useSpaceStore.setState((state) => {
    const exists = state.rootSpaces.some((item) => item.id === space.id);
    return {
      rootSpaces: exists
        ? state.rootSpaces.map((item) => (item.id === space.id ? space : item))
        : [...state.rootSpaces, space],
      rootsLoaded: true,
    };
  });
}

export function selectActiveSpaceId(
  state: SpacePublicState,
): string | null {
  return state.activeSpaceId ?? state.activeRootId;
}

export function selectActiveSpacePath(state: SpacePublicState): string {
  if (state.activeSpaceId) {
    const space = state.spaces.find((item) => item.id === state.activeSpaceId);
    if (space) return space.path;
  }
  return state.activeRootPath ?? "";
}
