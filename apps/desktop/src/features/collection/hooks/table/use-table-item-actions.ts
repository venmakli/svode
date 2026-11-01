import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import { itemParentDir, reorderVisibleItems } from "../../lib/item-tree";
import { notifyTreeOrderUnreadable } from "../error-feedback";
import { useCollectionTreeOrder } from "../use-collection-tree-order";

interface UseTableItemActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  topLevelItems: Page[];
  filteredTopLevel: Page[];
  setItems: Dispatch<SetStateAction<Page[]>>;
  loadItems: () => Promise<void>;
  onCreatePage: (title: string, asFolder: boolean) => Promise<Page>;
}

export function useTableItemActions({
  collectionPath,
  spacePath,
  projectPath,
  topLevelItems,
  filteredTopLevel,
  setItems,
  loadItems,
  onCreatePage,
}: UseTableItemActionsOptions) {
  const { reloadOrderParent, saveOrder } = useCollectionTreeOrder({
    spacePath,
    projectPath,
  });

  const createItem = useCallback(
    async (
      title: string,
      asFolder: boolean,
      onCreated?: (item: Page) => void,
    ) => {
      const created = await onCreatePage(title, asFolder);
      onCreated?.(created);
      await loadItems();
      return created;
    },
    [loadItems, onCreatePage],
  );

  const reorderItems = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = filteredTopLevel.findIndex(
        (item) => item.path === active.id,
      );
      const newIndex = filteredTopLevel.findIndex(
        (item) => item.path === over.id,
      );
      if (oldIndex < 0 || newIndex < 0) return;
      const fullOrder = reorderVisibleItems(
        topLevelItems,
        filteredTopLevel,
        String(active.id),
        newIndex,
      );
      try {
        await saveOrder(collectionPath, fullOrder);
      } catch (error) {
        if (!notifyTreeOrderUnreadable(error)) throw error;
        return;
      }
      setItems((current) => {
        const children = current.filter(
          (item) => itemParentDir(item.path) !== collectionPath,
        );
        return [...fullOrder, ...children];
      });
      await reloadOrderParent(collectionPath);
    },
    [
      collectionPath,
      filteredTopLevel,
      reloadOrderParent,
      saveOrder,
      setItems,
      topLevelItems,
    ],
  );

  return { createItem, reorderItems };
}
