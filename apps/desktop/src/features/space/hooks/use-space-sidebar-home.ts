import { useCallback } from "react";
import {
  useOpenEntryDocument,
  useOpenEntryScopeHome,
} from "@/features/entry/selection";
import type { TreeNode } from "../model/types";
import type { SpaceInfo } from "../model";
import { useSpaceStore } from "../model";
import { hasRecordKey, hasScopeReadme } from "../lib/nav-space-tree";
import {
  useSpaceScopeCollapse,
  type SpaceScopeCollapseState,
} from "./use-space-scope-collapse";

interface UseSpaceSidebarHomeInput {
  activeRootId: string | null;
  clearActiveSpace: () => void;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
  fileTrees: Record<string, TreeNode[]>;
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
  fileTrees,
  getScopeCollapseState,
  setScopeCollapseState,
  onActivateContent,
  openSpace,
}: UseSpaceSidebarHomeInput) {
  const openDocument = useOpenEntryDocument();
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

  const openHomeForScope = useCallback(
    (spaceId: string, tree: TreeNode[] | null) => {
      if (!tree || hasScopeReadme(tree)) {
        openDocument("README.md", spaceId);
      } else {
        openScopeHome(spaceId);
      }
    },
    [openDocument, openScopeHome],
  );

  const handleOpenRootHome = useCallback(() => {
    if (!activeRootId) return;

    onActivateContent();
    clearActiveSpace();
    openHomeForScope(
      activeRootId,
      useSpaceStore.getState().fileTrees[activeRootId] ??
        fileTrees[activeRootId] ??
        [],
    );
  }, [
    activeRootId,
    clearActiveSpace,
    fileTrees,
    onActivateContent,
    openHomeForScope,
  ]);

  const handleOpenSpaceHome = useCallback(
    async (space: SpaceInfo) => {
      onActivateContent();
      const state = useSpaceStore.getState();
      const tree = hasRecordKey(state.fileTrees, space.id)
        ? state.fileTrees[space.id]
        : null;
      openHomeForScope(space.id, tree);
      void openSpace(space.id);
    },
    [onActivateContent, openHomeForScope, openSpace],
  );

  return {
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRootOpenChange,
    rootOpen,
  };
}
