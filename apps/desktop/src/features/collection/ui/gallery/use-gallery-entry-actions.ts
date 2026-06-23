import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import type { Entry } from "@/features/entry";
import { useCollectionTreeOrder } from "../../hooks";
import {
  entryParentDir,
  reorderVisibleEntries,
} from "../table/utils";
import * as m from "@/paraglide/messages.js";

interface UseGalleryEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  entries: Entry[];
  topLevelEntries: Entry[];
  filteredEntries: Entry[];
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  loadEntries: () => Promise<void>;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Entry>;
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
  onCreateEntry,
}: UseGalleryEntryActionsOptions) {
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
      try {
        const created = await onCreateEntry(title, asFolder);
        setEntries((current) => [...current, created]);
        onCreated?.(created);
        await reloadOrderParent(collectionPath);
        await loadEntries();
        return created;
      } catch (error) {
        console.warn("Failed to create gallery entry:", error);
        toast.error(m.board_create_error());
        return null;
      }
    },
    [
      collectionPath,
      loadEntries,
      onCreateEntry,
      reloadOrderParent,
      setEntries,
    ],
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
