import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { createCollection } from "@/features/collection";
import { useEntrySelectionStore } from "@/features/entry";
import type { TreeNode } from "@/features/entry";
import { createTreeFolder } from "../api/tree-entry-actions";
import { renameSpace } from "../api/space-actions";
import { useSpaceLfsStateSync } from "./use-space-lfs-state-sync";
import { useMissingSpaceClone } from "./use-missing-space-clone";
import { useSpaceActions } from "./use-space-actions";
import { useSpaceStore } from "../model";
import type { SpaceInfo } from "../model";
import { hasRecordKey, hasScopeReadme } from "../lib/nav-space-tree";

export type ScopeTarget = { id: string; path: string };
export type DeleteSpaceTarget = { id: string; name: string };

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
  const { createEntry, deleteSpace } = useSpaceActions();
  const { activeDocument, activeDocumentSpaceId, openDocument, openScopeHome } =
    useEntrySelectionStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteSpaceTarget | null>(
    null,
  );
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [rootOpen, setRootOpen] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const { handleCloneMissing, handleRemoveBroken } = useMissingSpaceClone(
    activeRootPath,
    loadSpaces,
  );

  useSpaceLfsStateSync(activeRootPath);

  useEffect(() => {
    if (editingSpaceId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingSpaceId]);

  useEffect(() => {
    setRootOpen(false);
  }, [activeRootId]);

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
      setRootOpen(open);
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

  const handleRenameSpace = useCallback(async () => {
    if (!activeRootPath) {
      setEditingSpaceId(null);
      return;
    }

    const space = spaces.find((item) => item.id === editingSpaceId);
    const nextName = editValue.trim();
    if (!space || !nextName || nextName === space.name) {
      setEditingSpaceId(null);
      return;
    }

    try {
      await renameSpace({
        spacePath: space.path,
        name: nextName,
        projectPath: activeRootPath,
      });
      patchSpaceMetadata(space.path, { name: nextName });
    } catch (err) {
      console.error("Failed to rename space:", err);
      toast.error(m.toast_error());
    }
    setEditingSpaceId(null);
  }, [activeRootPath, editValue, editingSpaceId, patchSpaceMetadata, spaces]);

  const handleNewPage = useCallback(
    async (scope: ScopeTarget) => {
      try {
        const entry = await createEntry(scope.path, "Untitled");
        if (entry) {
          onActivateContent();
          openDocument(entry.path, scope.id);
        }
      } catch (err) {
        console.error("Failed to create page:", err);
        toast.error(m.toast_error());
      }
    },
    [createEntry, onActivateContent, openDocument],
  );

  const handleNewFolder = useCallback(
    async (scope: ScopeTarget) => {
      if (!activeRootPath) return;

      try {
        await createTreeFolder({
          spacePath: scope.path,
          parentPath: null,
          name: m.space_new_folder(),
          projectPath: activeRootPath,
        });
        await reloadTreeParent(scope.id, null);
      } catch (err) {
        console.error("Failed to create folder:", err);
        toast.error(m.toast_error());
      }
    },
    [activeRootPath, reloadTreeParent],
  );

  const handleNewCollection = useCallback(
    async (scope: ScopeTarget) => {
      if (!activeRootPath) return;

      try {
        const entry = await createCollection({
          spacePath: scope.path,
          title: m.editor_untitled(),
          projectPath: activeRootPath,
        });
        await reloadTreeParent(scope.id, null);
        onActivateContent();
        openDocument(entry.path, scope.id);
      } catch (err) {
        console.error("Failed to create collection:", err);
        toast.error(m.toast_error());
      }
    },
    [activeRootPath, onActivateContent, openDocument, reloadTreeParent],
  );

  const handleDeleteSpace = useCallback(
    async (spaceId: string) => {
      if (!activeRootPath) return;

      try {
        await deleteSpace(activeRootPath, spaceId, deleteFiles);
      } catch (err) {
        console.error("Failed to delete space:", err);
        toast.error(m.toast_error());
      }
      setDeleteTarget(null);
      setDeleteFiles(false);
    },
    [activeRootPath, deleteFiles, deleteSpace],
  );

  const handleSpaceDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = spaces.findIndex((space) => space.id === active.id);
      const newIndex = spaces.findIndex((space) => space.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const nextSpaces = arrayMove(spaces, oldIndex, newIndex);
      try {
        await reorderSpaces(nextSpaces.map((space) => space.id));
      } catch (err) {
        console.error("Failed to reorder spaces:", err);
        toast.error(m.toast_error());
      }
    },
    [reorderSpaces, spaces],
  );

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
