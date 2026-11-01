import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import { itemParentDir, reorderVisibleItems } from "../../lib/item-tree";
import { useCollectionTreeOrder } from "../use-collection-tree-order";
import { handleItemCreateError, handleItemMoveError } from "../error-feedback";

interface UseGalleryItemActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  items: Page[];
  topLevelItems: Page[];
  filteredItems: Page[];
  setItems: Dispatch<SetStateAction<Page[]>>;
  loadItems: () => Promise<void>;
  onCreatePage: (title: string, asFolder: boolean) => Promise<Page>;
}

export function useGalleryItemActions({
  collectionPath,
  spacePath,
  projectPath,
  items,
  topLevelItems,
  filteredItems,
  setItems,
  loadItems,
  onCreatePage,
}: UseGalleryItemActionsOptions) {
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
      try {
        const created = await onCreatePage(title, asFolder);
        setItems((current) => [...current, created]);
        onCreated?.(created);
        await reloadOrderParent(collectionPath);
        await loadItems();
        return created;
      } catch (error) {
        handleItemCreateError(error);
        return null;
      }
    },
    [collectionPath, loadItems, onCreatePage, reloadOrderParent, setItems],
  );

  const reorderItems = useCallback(
    async (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const activePath = String(event.active.id);
      const overPath = String(event.over.id);
      const nextVisibleIndex = filteredItems.findIndex(
        (item) => item.path === overPath,
      );
      const nextItems = reorderVisibleItems(
        topLevelItems,
        filteredItems,
        activePath,
        nextVisibleIndex,
      );
      const previousItems = items;
      setItems((current) => [
        ...nextItems,
        ...current.filter(
          (item) => itemParentDir(item.path) !== collectionPath,
        ),
      ]);
      try {
        await saveOrder(collectionPath, nextItems);
        await reloadOrderParent(collectionPath);
        await loadItems();
      } catch (error) {
        console.warn("Failed to reorder gallery items:", error);
        setItems(previousItems);
        handleItemMoveError(error);
      }
    },
    [
      collectionPath,
      items,
      filteredItems,
      loadItems,
      reloadOrderParent,
      saveOrder,
      setItems,
      topLevelItems,
    ],
  );

  return { createItem, reorderItems };
}
