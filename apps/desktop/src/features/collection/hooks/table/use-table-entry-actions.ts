import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Entry } from "@/features/entry";
import { entryParentDir, reorderVisibleEntries } from "../../lib/entry-tree";
import { useCollectionTreeOrder } from "../use-collection-tree-order";

interface UseTableEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  topLevelEntries: Entry[];
  filteredTopLevel: Entry[];
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  loadEntries: () => Promise<void>;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Entry>;
}

export function useTableEntryActions({
  collectionPath,
  spacePath,
  projectPath,
  topLevelEntries,
  filteredTopLevel,
  setEntries,
  loadEntries,
  onCreateEntry,
}: UseTableEntryActionsOptions) {
  const { reloadOrderParent, saveOrder } = useCollectionTreeOrder({
    spacePath,
    projectPath,
  });

  const createEntry = useCallback(
    async (
      title: string,
      asFolder: boolean,
      onCreated?: (entry: Entry) => void,
    ) => {
      const created = await onCreateEntry(title, asFolder);
      onCreated?.(created);
      await loadEntries();
      return created;
    },
    [loadEntries, onCreateEntry],
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
