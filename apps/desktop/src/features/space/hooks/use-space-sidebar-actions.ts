import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "../model";
import { useMissingSpaceClone } from "./use-missing-space-clone";
import { useSpaceActions } from "./use-space-actions";
import { useSpaceLfsStateSync } from "./use-space-lfs-state-sync";
import { useSpaceScopeActions } from "./use-space-scope-actions";
import type { ScopeTarget } from "./use-space-scope-actions";
import { useSpaceSidebarDelete } from "./use-space-sidebar-delete";
import { useSpaceSidebarDialogState } from "./use-space-sidebar-dialog-state";
import type { DeleteSpaceTarget } from "./use-space-sidebar-dialog-state";
import { useSpaceSidebarHome } from "./use-space-sidebar-home";
import { useSpaceSidebarOrder } from "./use-space-sidebar-order";
import { useSpaceSidebarRename } from "./use-space-sidebar-rename";

export type { DeleteSpaceTarget, ScopeTarget };

interface UseSpaceSidebarActionsInput {
  onActivateContent: () => void;
}

export function useSpaceSidebarActions({
  onActivateContent,
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
  const { activeDocument, activeDocumentSpaceId } = useEntrySelectionStore();
  const {
    createDialogOpen,
    deleteFiles,
    deleteTarget,
    resetDeleteDialog,
    setCreateDialogOpen,
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
    clearActiveSpace,
    ensureTreeLoaded,
    fileTrees,
    onActivateContent,
    openSpace,
  });
  const { handleNewCollection, handleNewFolder, handleNewPage } =
    useSpaceScopeActions({
      activeRootPath,
      onActivateContent,
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
    activeDocumentSpaceId === activeRootId &&
    (!activeDocument || activeDocument.toLowerCase() === "readme.md");

  return {
    activeDocument,
    activeDocumentSpaceId,
    activeRootIcon,
    activeRootId,
    activeRootName,
    activeRootPath,
    createDialogOpen,
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
    handleSpaceDragEnd,
    loadTreeChildren,
    rootHomeActive,
    rootOpen,
    setCreateDialogOpen,
    setDeleteFiles,
    setDeleteTarget,
    setEditingSpaceId,
    setEditValue,
    spaces,
    treeLoading,
    treeRefreshing,
  };
}
