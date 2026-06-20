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
  | "childrenByParentPath"
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
  | "loadTreeChildren"
  | "reloadTreeParent"
  | "reloadTreePathParent"
  | "reloadTreePathParents"
  | "patchEntryTreeMeta"
  | "removeTreePath"
>;

function selectPublicState(state: SpaceState): SpacePublicState {
  return state;
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
  return useSpaceStore.getState();
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
