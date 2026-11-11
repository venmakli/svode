import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useSpaceNames } from "@/features/space";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import {
  itemParentDir,
  replaceSiblings,
  reorderVisibleItems,
  siblingItems,
} from "../../lib/item-tree";
import { useCollectionTreeOrder } from "../use-collection-tree-order";
import { handleItemCreateError, handleItemMoveError } from "../error-feedback";

interface UseListItemActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  items: Page[];
  rows: Array<{ item: Page }>;
  setItems: Dispatch<SetStateAction<Page[]>>;
  loadItems: () => Promise<void>;
  onCreatePage: (title: string, asFolder: boolean) => Promise<Page>;
}

export function useListItemActions({
  collectionPath,
  spacePath,
  projectPath,
  items,
  rows,
  setItems,
  loadItems,
  onCreatePage,
}: UseListItemActionsOptions) {
  const spaceName = useSpaceNames();
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
        handleItemCreateError(error, spaceName(spacePath));
        return null;
      }
    },
    [
      collectionPath,
      loadItems,
      onCreatePage,
      reloadOrderParent,
      setItems,
      spaceName,
      spacePath,
    ],
  );

  const reorderItems = useCallback(
    async (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const activePath = String(event.active.id);
      const overPath = String(event.over.id);
      const activeItem = items.find((item) => item.path === activePath);
      const overItem = items.find((item) => item.path === overPath);
      if (!activeItem || !overItem) return;

      const parentPath = itemParentDir(activeItem.path);
      if (parentPath !== itemParentDir(overItem.path)) return;

      const siblings = siblingItems(items, parentPath);
      const visibleSiblings = rows
        .map((row) => row.item)
        .filter((item) => itemParentDir(item.path) === parentPath);
      const nextVisibleIndex = visibleSiblings.findIndex(
        (item) => item.path === overPath,
      );
      const nextSiblings = reorderVisibleItems(
        siblings,
        visibleSiblings,
        activePath,
        nextVisibleIndex,
      );
      const previousItems = items;
      setItems((current) => replaceSiblings(current, parentPath, nextSiblings));
      try {
        await saveOrder(parentPath, nextSiblings);
        await reloadOrderParent(parentPath);
        await loadItems();
      } catch (error) {
        console.warn("Failed to reorder list items:", error);
        setItems(previousItems);
        handleItemMoveError(error, spaceName(spacePath));
      }
    },
    [
      items,
      loadItems,
      reloadOrderParent,
      rows,
      saveOrder,
      setItems,
      spaceName,
      spacePath,
    ],
  );

  return { createItem, reorderItems };
}
