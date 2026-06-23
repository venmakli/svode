import { useCallback, useState } from "react";
import {
  useOpenEntryDocument,
  useOpenEntryScopeHome,
} from "@/features/entry/selection";
import type { TreeNode } from "@/features/entry";
import type { SpaceInfo } from "../model";
import { useSpaceStore } from "../model";
import { hasRecordKey, hasScopeReadme } from "../lib/nav-space-tree";

interface UseSpaceSidebarHomeInput {
  activeRootId: string | null;
  clearActiveSpace: () => void;
  ensureTreeLoaded: (spaceId: string) => Promise<void>;
  fileTrees: Record<string, TreeNode[]>;
  forceRootOpen: boolean;
  onActivateContent: () => void;
  openSpace: (id: string) => Promise<void>;
}

export function useSpaceSidebarHome({
  activeRootId,
  clearActiveSpace,
  ensureTreeLoaded,
  fileTrees,
  forceRootOpen,
  onActivateContent,
  openSpace,
}: UseSpaceSidebarHomeInput) {
  const openDocument = useOpenEntryDocument();
  const openScopeHome = useOpenEntryScopeHome();
  const [rootOpenState, setRootOpenState] = useState<{
    open: boolean;
    rootId: string | null;
  }>({ open: false, rootId: null });
  const rootOpen =
    forceRootOpen || (rootOpenState.rootId === activeRootId && rootOpenState.open);

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

  const handleRootOpenChange = useCallback(
    (open: boolean) => {
      setRootOpenState({ open, rootId: activeRootId });
      if (open && activeRootId) void ensureTreeLoaded(activeRootId);
    },
    [activeRootId, ensureTreeLoaded],
  );

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
