import { useEffect, useMemo } from "react";
import {
  useActiveContentPath,
  useActiveContentSelection,
  useActiveContentSpaceId,
} from "@/features/artifact";
import { useSpaceStore } from "../model";
import { useMissingSpaceClone } from "./use-missing-space-clone";
import { useSpaceActions } from "./use-space-actions";
import { useSidebarTreeExpansionControl } from "./use-sidebar-tree-expansion-control";
import { useSpaceLfsStateSync } from "./use-space-lfs-state-sync";
import { useSpaceScopeActions } from "./use-space-scope-actions";
import type { ScopeTarget } from "./use-space-scope-actions";
import { useSpaceSidebarDelete } from "./use-space-sidebar-delete";
import { useSpaceSidebarDialogState } from "./use-space-sidebar-dialog-state";
import type { DeleteSpaceTarget } from "./use-space-sidebar-dialog-state";
import { getSpaceScopeActiveRevealKey } from "./use-space-scope-collapse";
import { useSpaceSidebarHome } from "./use-space-sidebar-home";
import { useSpaceSidebarOrder } from "./use-space-sidebar-order";
import { useSpaceSidebarRename } from "./use-space-sidebar-rename";

export type { DeleteSpaceTarget, ScopeTarget };

interface UseSpaceSidebarActionsInput {
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
}

export function useSpaceSidebarActions({
  onActivateContent,
  onBeforeNavigation,
}: UseSpaceSidebarActionsInput) {
  const {
    activeRootId,
    activeRootName,
    activeRootIcon,
    activeRootPath,
    spaces,
    fileTrees,
    treeLoading,
    treeRefreshing,
    ensureTreePathVisible,
    openSpace,
    clearActiveSpace,
    reloadTreeParent,
    ensureTreeLoaded,
    loadTreeChildren,
    loadSpaces,
    reorderSpaces,
    patchSpaceMetadata,
  } = useSpaceStore();
  const { deleteSpace } = useSpaceActions();
  const { activeRevealRequest } = useActiveContentSelection();
  const activeContentPath = useActiveContentPath();
  const activeContentSpaceId = useActiveContentSpaceId();
  const {
    deleteFiles,
    deleteTarget,
    resetDeleteDialog,
    setDeleteFiles,
    setDeleteTarget,
  } = useSpaceSidebarDialogState();
  const {
    editRef,
    editingSpaceId,
    editValue,
    handleRenameSpace,
    setEditingSpaceId,
    setEditValue,
  } = useSpaceSidebarRename({
    activeRootPath,
    patchSpaceMetadata,
    spaces,
  });
  const activeRootRevealKey = getSpaceScopeActiveRevealKey({
    activeContentPath,
    activeContentSpaceId,
    activeRevealRequest,
    scopeId: activeRootId,
  });
  const activeRevealKeysByScopeId = useMemo(() => {
    const keys: Record<string, string | null> = {};
    if (activeRootId) {
      keys[activeRootId] = activeRootRevealKey;
    }
    for (const space of spaces) {
      keys[space.id] = getSpaceScopeActiveRevealKey({
        activeContentPath,
        activeContentSpaceId,
        activeRevealRequest,
        scopeId: space.id,
      });
    }
    return keys;
  }, [
    activeContentPath,
    activeContentSpaceId,
    activeRevealRequest,
    activeRootId,
    activeRootRevealKey,
    spaces,
  ]);
  const sidebarTreeExpansion = useSidebarTreeExpansionControl({
    activeRootId,
    activeRevealKeysByScopeId,
    spaces,
  });
  const { handleCloneMissing, handleRemoveBroken } = useMissingSpaceClone(
    activeRootPath,
    loadSpaces,
  );
  const {
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRootOpenChange,
    rootOpen,
  } = useSpaceSidebarHome({
    activeRootId,
    activeRootRevealKey,
    clearActiveSpace,
    ensureTreeLoaded,
    getScopeCollapseState: sidebarTreeExpansion.getScopeCollapseState,
    onActivateContent,
    onBeforeNavigation,
    openSpace,
    setScopeCollapseState: sidebarTreeExpansion.setScopeCollapseState,
  });

  useEffect(() => {
    if (!activeContentPath || !activeContentSpaceId) return;
    void ensureTreePathVisible(activeContentSpaceId, activeContentPath);
  }, [
    activeContentPath,
    activeContentSpaceId,
    activeRevealRequest,
    ensureTreePathVisible,
  ]);

  const { handleNewCollection, handleNewFolder, handleNewPage } =
    useSpaceScopeActions({
      activeRootPath,
      onActivateContent,
      onBeforeNavigation,
      reloadTreeParent,
    });
  const handleDeleteSpace = useSpaceSidebarDelete({
    activeRootPath,
    deleteFiles,
    deleteSpace,
    resetDeleteDialog,
  });
  const handleSpaceDragEnd = useSpaceSidebarOrder({
    reorderSpaces,
    spaces,
  });

  useSpaceLfsStateSync(activeRootPath);

  const rootHomeActive =
    activeContentSpaceId === activeRootId &&
    (!activeContentPath || activeContentPath.toLowerCase() === "readme.md");

  return {
    activeContentPath,
    activeContentSpaceId,
    activeRevealRequest,
    activeRootIcon,
    activeRootId,
    activeRootName,
    activeRootPath,
    deleteFiles,
    deleteTarget,
    editRef,
    editingSpaceId,
    editValue,
    ensureTreeLoaded,
    fileTrees,
    handleCloneMissing,
    handleDeleteSpace,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    handleOpenRootHome,
    handleOpenSpaceHome,
    handleRemoveBroken,
    handleRenameSpace,
    handleRootOpenChange,
    handleSidebarTreeExpansionToggle:
      sidebarTreeExpansion.handleToggleExpansion,
    handleSpaceDragEnd,
    loadTreeChildren,
    rootHomeActive,
    rootOpen,
    sidebarTreeExpansionAction: sidebarTreeExpansion.action,
    sidebarTreeExpansionLabel: sidebarTreeExpansion.label,
    getSidebarScopeCollapseState: sidebarTreeExpansion.getScopeCollapseState,
    setSidebarScopeCollapseState: sidebarTreeExpansion.setScopeCollapseState,
    setDeleteFiles,
    setDeleteTarget,
    setEditingSpaceId,
    setEditValue,
    spaces,
    treeLoading,
    treeRefreshing,
  };
}
