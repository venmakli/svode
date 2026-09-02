import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import type { Page } from "@/features/page";
import { entryParentDir, reorderVisibleEntries } from "../../lib/entry-tree";
import { useCollectionTreeOrder } from "../use-collection-tree-order";
import { handleEntryCreateError } from "../error-feedback";
import * as m from "@/paraglide/messages.js";

interface UseGalleryEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  entries: Page[];
  topLevelEntries: Page[];
  filteredEntries: Page[];
  setEntries: Dispatch<SetStateAction<Page[]>>;
  loadEntries: () => Promise<void>;
  onCreatePage: (title: string, asFolder: boolean) => Promise<Page>;
}

export function useGalleryEntryActions({
  collectionPath,
  spacePath,
  projectPath,
  entries,
  topLevelEntries,
  filteredEntries,
  setEntries,
  loadEntries,
  onCreatePage,
}: UseGalleryEntryActionsOptions) {
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
      try {
        const created = await onCreatePage(title, asFolder);
        setEntries((current) => [...current, created]);
        onCreated?.(created);
        await reloadOrderParent(collectionPath);
        await loadEntries();
        return created;
      } catch (error) {
        handleEntryCreateError(error);
        return null;
      }
    },
    [collectionPath, loadEntries, onCreatePage, reloadOrderParent, setEntries],
  );

  const reorderEntries = useCallback(
    async (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const activePath = String(event.active.id);
      const overPath = String(event.over.id);
      const nextVisibleIndex = filteredEntries.findIndex(
        (entry) => entry.path === overPath,
      );
      const nextEntries = reorderVisibleEntries(
        topLevelEntries,
        filteredEntries,
        activePath,
        nextVisibleIndex,
      );
      const previousEntries = entries;
      setEntries((current) => [
        ...nextEntries,
        ...current.filter(
          (entry) => entryParentDir(entry.path) !== collectionPath,
        ),
      ]);
      try {
        await saveOrder(collectionPath, nextEntries);
        await reloadOrderParent(collectionPath);
        await loadEntries();
      } catch (error) {
        console.warn("Failed to reorder gallery entries:", error);
        setEntries(previousEntries);
        toast.error(m.board_move_error());
      }
    },
    [
      collectionPath,
      entries,
      filteredEntries,
      loadEntries,
      reloadOrderParent,
      saveOrder,
      setEntries,
      topLevelEntries,
    ],
  );

  return { createEntry, reorderEntries };
}
