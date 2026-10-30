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

/**
 * Moves an open Page inside the folder `fromFolder` to the same place inside
 * `toFolder`. The README of the folder stands for the folder itself and moves
 * with its own rename or move; other content stays.
 */
export function retargetActiveContentInside(
  fromFolder: string,
  toFolder: string,
  spaceId?: string | null,
) {
  const { selection, retarget } = useArtifactSelectionStore.getState();
  if (
    selection?.kind !== "artifact" ||
    selection.request.intent.target.semanticHint?.kind !== "page"
  )
    return;
  const path = selection.request.intent.target.path;
  if (!path.startsWith(`${fromFolder}/`)) return;
  const inside = path.slice(fromFolder.length + 1);
  if (/^readme\.md$/i.test(inside)) return;
  retarget(path, `${toFolder}/${inside}`, spaceId);
}

/** Whether the main area shows the selection, which is then highlighted. */
export function setActiveContentShown(shown: boolean) {
  useArtifactSelectionStore.getState().setContentShown(shown);
}

export function closeActiveContent() {
  useArtifactSelectionStore.getState().close();
}
