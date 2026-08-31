import {
  selectedContentPath,
  selectedContentSpaceId,
  useArtifactSelectionStore,
} from "../model/selection-store";
import type {
  ActiveContentSelectionSnapshot,
  ArtifactOpenTarget,
  OpenArtifactOptions,
  OpenScopeOwnerOptions,
  ScopeOwnerTarget,
} from "../model/types";

export function getActiveContentSelection(): ActiveContentSelectionSnapshot {
  const {
    selection,
    activeRevealRequest,
    activePathRetarget,
    transitionPending,
  } = useArtifactSelectionStore.getState();
  return {
    selection,
    activeRevealRequest,
    activePathRetarget,
    transitionPending,
  };
}

export function getActiveContentPath(): string | null {
  return selectedContentPath(useArtifactSelectionStore.getState().selection);
}

export function getActiveContentSpaceId(): string | null {
  return selectedContentSpaceId(useArtifactSelectionStore.getState().selection);
}

export function openArtifact(
  target: Omit<ArtifactOpenTarget, "spaceId"> & { spaceId?: string | null },
  options?: OpenArtifactOptions,
) {
  useArtifactSelectionStore.getState().openArtifact(target, options);
}

export function openScopeOwner(
  owner: ScopeOwnerTarget,
  options?: OpenScopeOwnerOptions,
) {
  useArtifactSelectionStore.getState().openScopeOwner(owner, options);
}

export function retargetActiveContent(
  fromPath: string,
  path: string,
  spaceId?: string | null,
) {
  useArtifactSelectionStore.getState().retarget(fromPath, path, spaceId);
}

export function closeActiveContent() {
  useArtifactSelectionStore.getState().close();
}
