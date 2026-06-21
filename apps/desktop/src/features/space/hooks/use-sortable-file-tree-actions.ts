import { useCallback } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import type { TreeNode } from "@/features/entry";
import type { Projection } from "../lib/tree-dnd-utilities";
import { commitFileTreeDrag } from "../model/file-tree-drag-command";

interface UseSortableFileTreeActionsInput {
  spaceId: string;
  tree: TreeNode[];
  resetState: () => void;
}

export function useSortableFileTreeActions({
  spaceId,
  tree,
  resetState,
}: UseSortableFileTreeActionsInput) {
  return useCallback(
    async (event: DragEndEvent, currentProjection: Projection | null) => {
      resetState();

      const { active, over } = event;
      if (!over || active.id === over.id || !currentProjection) return;

      try {
        await commitFileTreeDrag({
          spaceId,
          tree,
          fromPath: active.id as string,
          projection: currentProjection,
        });
      } catch (err) {
        console.error("Failed to move entry:", err);
        toast.error("Failed to move file");
      }
    },
    [tree, spaceId, resetState],
  );
}
