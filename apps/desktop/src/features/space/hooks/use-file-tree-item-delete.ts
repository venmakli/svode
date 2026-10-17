import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "../model/types";
import { deleteTreeItem } from "../api/content-tree-actions";
import { treeNodeContentObject } from "../lib/tree-node-content-object";
import type { SpaceInfo } from "../model";
import { useContentDeleteConfirmation } from "./use-content-delete-confirmation";

interface UseFileTreeItemDeleteInput {
  node: TreeNode;
  spaceId: string;
  space: SpaceInfo | undefined;
  activeRootPath: string | null;
  reloadTreePathParent: (spaceId: string, path: string) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
}

export function useFileTreeItemDelete({
  node,
  spaceId,
  space,
  activeRootPath,
  reloadTreePathParent,
  removeTreePath,
}: UseFileTreeItemDeleteInput) {
  const { confirmation, requestDelete, cancelDelete } =
    useContentDeleteConfirmation<string>();

  async function handleDeleteRequest() {
    if (!space) return;
    await requestDelete({
      object: treeNodeContentObject(node),
      name: node.title,
      spacePath: space.path,
      path: node.path,
      projectPath: activeRootPath ?? null,
      value: node.path,
    });
  }

  async function handleDeleteConfirm(path: string) {
    if (!space) return;
    try {
      await deleteTreeItem({
        spacePath: space.path,
        path,
        projectPath: activeRootPath,
      });
      removeTreePath(spaceId, path);
      await reloadTreePathParent(spaceId, path);
    } catch (err) {
      console.error("Failed to delete content item:", err);
      toast.error(m.toast_error());
    }
  }

  return {
    cancelDelete,
    deleteConfirmation: confirmation,
    handleDeleteConfirm,
    handleDeleteRequest,
  };
}
