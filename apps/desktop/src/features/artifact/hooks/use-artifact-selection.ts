import { useShallow } from "zustand/shallow";
import { useArtifactSelectionStore } from "../model/selection-store";
import type { ActiveContentSelectionSnapshot } from "../model/types";

export function useActiveContentSelection(): ActiveContentSelectionSnapshot {
  return useArtifactSelectionStore(
    useShallow(
      (state): ActiveContentSelectionSnapshot => ({
        selection: state.selection,
        activeRevealRequest: state.activeRevealRequest,
        activePathRetarget: state.activePathRetarget,
      }),
    ),
  );
}

export function useOpenArtifact() {
  return useArtifactSelectionStore((state) => state.openArtifact);
}

export function useOpenScopeOwner() {
  return useArtifactSelectionStore((state) => state.openScopeOwner);
}

export function useRetargetActiveContent() {
  return useArtifactSelectionStore((state) => state.retarget);
}

export function useCloseActiveContent() {
  return useArtifactSelectionStore((state) => state.close);
}
