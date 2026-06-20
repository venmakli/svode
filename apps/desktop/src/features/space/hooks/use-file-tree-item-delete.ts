import { useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "@/features/entry";
import {
  deleteTreeEntry,
  getTreeEntryBacklinks,
  type BacklinkInfo,
} from "../api/tree-entry-actions";
import type { SpaceInfo } from "../model";

export interface FileTreeDeleteDialogState {
  open: boolean;
  backlinks: BacklinkInfo[];
}

interface UseFileTreeItemDeleteInput {
  node: TreeNode;
  spaceId: string;
  space: SpaceInfo | undefined;
  activeRootPath: string | null;
  rootSpaces: SpaceInfo[];
  spaces: SpaceInfo[];
  reloadTreePathParent: (spaceId: string, path: string) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
}

export function useFileTreeItemDelete({
  node,
  spaceId,
  space,
  activeRootPath,
  rootSpaces,
  spaces,
  reloadTreePathParent,
  removeTreePath,
}: UseFileTreeItemDeleteInput) {
  const [deleteDialog, setDeleteDialog] = useState<FileTreeDeleteDialogState>({
    open: false,
    backlinks: [],
  });

  function backlinkLabel(backlink: BacklinkInfo): string {
    if (!backlink.sourceSpaceId) return backlink.sourcePath;
    const sourceSpace = [...rootSpaces, ...spaces].find(
      (item) => item.id === backlink.sourceSpaceId,
    );
    return sourceSpace
      ? `${sourceSpace.name} · ${backlink.sourcePath}`
      : backlink.sourcePath;
  }

  async function handleDeleteRequest() {
    if (!space) return;
    try {
      const backlinks = await getTreeEntryBacklinks({
        spacePath: space.path,
        targetPath: node.path,
        projectPath: activeRootPath ?? null,
      });
      setDeleteDialog({ open: true, backlinks });
    } catch {
      setDeleteDialog({ open: true, backlinks: [] });
    }
  }

  async function handleDeleteConfirm() {
    if (!space) return;
    setDeleteDialog({ open: false, backlinks: [] });
    try {
      await deleteTreeEntry({
        spacePath: space.path,
        path: node.path,
        projectPath: activeRootPath,
      });
      removeTreePath(spaceId, node.path);
      await reloadTreePathParent(spaceId, node.path);
    } catch (err) {
      console.error("Failed to delete entry:", err);
      toast.error(m.toast_error());
    }
  }

  function closeDeleteDialog() {
    setDeleteDialog({ open: false, backlinks: [] });
  }

  return {
    backlinkLabel,
    closeDeleteDialog,
    deleteDialog,
    handleDeleteConfirm,
    handleDeleteRequest,
  };
}
