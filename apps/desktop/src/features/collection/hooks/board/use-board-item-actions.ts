import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Page } from "@/features/page";
import type { Column } from "@/features/properties";
import { itemParentDir } from "../../lib/item-tree";
import {
  groupKeyForValue,
  groupValue,
  groupValueForKey,
  noValueKey,
  reorderItemAround,
  updateItemGroupValue,
} from "../../lib/board-item";
import { useCollectionItemFieldSave, useCollectionTreeOrder } from "..";
import { handleItemCreateError, handleItemMoveError } from "../error-feedback";

interface MoveBoardCardArgs {
  activeItemPath: string;
  targetGroupKey: string | null;
  overItemPath: string | null;
  placement: "before" | "after";
}

interface UseBoardItemActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  items: Page[];
  manualOrderItems: Page[];
  topLevelItems: Page[];
  groupColumn: Column | null;
  hasSort: boolean;
  setItems: Dispatch<SetStateAction<Page[]>>;
  setManualOrderItems: Dispatch<SetStateAction<Page[]>>;
  loadItems: () => Promise<void>;
  onCreatePage: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Page>;
}

export function useBoardItemActions({
  collectionPath,
  spacePath,
  projectPath,
  items,
  manualOrderItems,
  topLevelItems,
  groupColumn,
  hasSort,
  setItems,
  setManualOrderItems,
  loadItems,
  onCreatePage,
}: UseBoardItemActionsOptions) {
  const { reloadOrderParent, saveOrder } = useCollectionTreeOrder({
    spacePath,
    projectPath,
  });

  const handleFieldCommitError = useCallback(
    (error: unknown) => {
      console.warn("Failed to update board field:", error);
      void loadItems();
    },
    [loadItems],
  );
  const { commitField, saveField } = useCollectionItemFieldSave({
    spacePath,
    projectPath,
    setItems,
    setManualOrderItems,
    onCommitError: handleFieldCommitError,
  });

  const moveCard = useCallback(
    async ({
      activeItemPath,
      targetGroupKey,
      overItemPath,
      placement,
    }: MoveBoardCardArgs) => {
      if (!groupColumn || !targetGroupKey) return;

      const activeItem = topLevelItems.find(
        (item) => item.path === activeItemPath,
      );
      if (!activeItem) return;

      const sourceGroupKey = groupKeyForValue(
        groupValue(activeItem, groupColumn),
      );
      const targetValue = groupValueForKey(targetGroupKey);
      const crossColumn = sourceGroupKey !== targetGroupKey;
      const positional = Boolean(overItemPath) && !hasSort;

      if (!crossColumn && (!positional || activeItemPath === overItemPath)) {
        return;
      }
      if (hasSort && !crossColumn) return;

      const previousItems = items;
      const previousManualOrderItems = manualOrderItems;
      const orderTopLevelItems = (
        manualOrderItems.length > 0 ? manualOrderItems : topLevelItems
      ).filter((item) => itemParentDir(item.path) === collectionPath);
      const withGroup = crossColumn
        ? topLevelItems.map((item) =>
            item.path === activeItemPath
              ? updateItemGroupValue(item, groupColumn, targetValue)
              : item,
          )
        : topLevelItems;
      const withGroupForOrder = crossColumn
        ? orderTopLevelItems.map((item) =>
            item.path === activeItemPath
              ? updateItemGroupValue(item, groupColumn, targetValue)
              : item,
          )
        : orderTopLevelItems;
      const nextTopLevel =
        positional && overItemPath
          ? reorderItemAround(
              withGroup,
              activeItemPath,
              overItemPath,
              placement,
            )
          : withGroup;
      const nextOrderTopLevel =
        positional && overItemPath
          ? reorderItemAround(
              withGroupForOrder,
              activeItemPath,
              overItemPath,
              placement,
            )
          : withGroupForOrder;
      setItems((current) =>
        positional
          ? [
              ...nextTopLevel,
              ...current.filter(
                (item) => itemParentDir(item.path) !== collectionPath,
              ),
            ]
          : current.map((item) =>
              item.path === activeItemPath
                ? updateItemGroupValue(item, groupColumn, targetValue)
                : item,
            ),
      );
      setManualOrderItems((current) =>
        positional
          ? [
              ...nextOrderTopLevel,
              ...current.filter(
                (item) => itemParentDir(item.path) !== collectionPath,
              ),
            ]
          : current.map((item) =>
              item.path === activeItemPath
                ? updateItemGroupValue(item, groupColumn, targetValue)
                : item,
            ),
      );

      try {
        if (crossColumn) {
          await saveField(activeItem, groupColumn, targetValue, {
            flush: true,
          });
        }
        if (positional) {
          await saveOrder(collectionPath, nextOrderTopLevel);
          await reloadOrderParent(collectionPath);
        }
        await loadItems();
      } catch (error) {
        console.warn("Failed to move board card:", error);
        if (crossColumn) {
          try {
            await saveField(
              activeItem,
              groupColumn,
              groupValueForKey(sourceGroupKey),
              { flush: true },
            );
          } catch (rollbackError) {
            console.warn("Failed to rollback board card move:", rollbackError);
          }
        }
        setItems(previousItems);
        setManualOrderItems(previousManualOrderItems);
        void loadItems();
        handleItemMoveError(error);
      }
    },
    [
      collectionPath,
      items,
      groupColumn,
      hasSort,
      loadItems,
      manualOrderItems,
      reloadOrderParent,
      saveField,
      saveOrder,
      setItems,
      setManualOrderItems,
      topLevelItems,
    ],
  );

  const createDraft = useCallback(
    async (
      title: string,
      groupKey: string,
      asFolder: boolean,
      onCreated?: (item: Page) => void,
    ) => {
      try {
        const defaults =
          groupKey === noValueKey() || !groupColumn
            ? undefined
            : { [groupColumn.name]: groupValueForKey(groupKey) };
        const created = await onCreatePage(title, asFolder, defaults);
        onCreated?.(created);
        setItems((current) => [...current, created]);
        setManualOrderItems((current) => [...current, created]);
        await loadItems();
        return created;
      } catch (error) {
        handleItemCreateError(error);
        return null;
      }
    },
    [groupColumn, loadItems, onCreatePage, setItems, setManualOrderItems],
  );

  return { commitField, createDraft, moveCard };
}
