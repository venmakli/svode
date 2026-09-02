import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Page } from "@/features/page";
import { entryParentDir, reorderVisibleEntries } from "../../lib/entry-tree";
import { useCollectionTreeOrder } from "../use-collection-tree-order";

interface UseTableEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  topLevelEntries: Page[];
  filteredTopLevel: Page[];
  setEntries: Dispatch<SetStateAction<Page[]>>;
  loadEntries: () => Promise<void>;
  onCreatePage: (title: string, asFolder: boolean) => Promise<Page>;
}

export function useTableEntryActions({
  collectionPath,
  spacePath,
  projectPath,
  topLevelEntries,
  filteredTopLevel,
  setEntries,
  loadEntries,
  onCreatePage,
}: UseTableEntryActionsOptions) {
  const { reloadOrderParent, saveOrder } = useCollectionTreeOrder({
    spacePath,
    projectPath,
  });

  const createEntry = useCallback(
    async (
      title: string,
      asFolder: boolean,
      onCreated?: (entry: Page) => void,
    ) => {
      const created = await onCreatePage(title, asFolder);
      onCreated?.(created);
      await loadEntries();
      return created;
    },
    [loadEntries, onCreatePage],
  );

  const reorderEntries = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = filteredTopLevel.findIndex(
        (entry) => entry.path === active.id,
      );
      const newIndex = filteredTopLevel.findIndex(
        (entry) => entry.path === over.id,
      );
      if (oldIndex < 0 || newIndex < 0) return;
      const fullOrder = reorderVisibleEntries(
        topLevelEntries,
        filteredTopLevel,
        String(active.id),
        newIndex,
      );
      await saveOrder(collectionPath, fullOrder);
      setEntries((current) => {
        const children = current.filter(
          (entry) => entryParentDir(entry.path) !== collectionPath,
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
      setEntries,
      topLevelEntries,
    ],
  );

  return { createEntry, reorderEntries };
}
