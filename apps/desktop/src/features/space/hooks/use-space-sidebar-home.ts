import { useCallback } from "react";
import { useOpenEntryScopeHome } from "@/features/entry/selection";
import type { SpaceInfo } from "../model";
import {
  useSpaceScopeCollapse,
  type SpaceScopeCollapseState,
} from "./use-space-scope-collapse";

interface UseSpaceSidebarHomeInput {
  activeRootId: string | null;
  clearActiveSpace: () => void;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
  getScopeCollapseState: (scopeId: string | null) => SpaceScopeCollapseState;
  setScopeCollapseState: (
    scopeId: string,
    state: SpaceScopeCollapseState,
  ) => void;
  activeRootRevealKey: string | null;
  onActivateContent: () => void;
  openSpace: (id: string) => Promise<void>;
}

export function useSpaceSidebarHome({
  activeRootId,
  activeRootRevealKey,
  clearActiveSpace,
  ensureTreeLoaded,
  getScopeCollapseState,
  setScopeCollapseState,
  onActivateContent,
  openSpace,
}: UseSpaceSidebarHomeInput) {
  const openScopeHome = useOpenEntryScopeHome();
  const loadRootTree = useCallback(() => {
    if (activeRootId) void ensureTreeLoaded(activeRootId);
  }, [activeRootId, ensureTreeLoaded]);
  const { handleOpenChange: handleRootOpenChange, open: rootOpen } =
    useSpaceScopeCollapse({
      activeRevealKey: activeRootRevealKey,
      onOpen: loadRootTree,
      onScopeStateChange: (state) => {
        if (activeRootId) setScopeCollapseState(activeRootId, state);
      },
      scopeState: getScopeCollapseState(activeRootId),
    });

  const handleOpenRootHome = useCallback(() => {
    if (!activeRootId) return;

    onActivateContent();
    clearActiveSpace();
    openScopeHome(activeRootId);
  }, [
    activeRootId,
    clearActiveSpace,
    onActivateContent,
    openScopeHome,
  ]);

  const handleOpenSpaceHome = useCallback(
    async (space: SpaceInfo) => {
      onActivateContent();
      openScopeHome(space.id);
      void openSpace(space.id);
    },
    [onActivateContent, openScopeHome, openSpace],
  );

  return {
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRootOpenChange,
    rootOpen,
  };
}
