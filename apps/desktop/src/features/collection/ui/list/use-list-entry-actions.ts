import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import type { Entry } from "@/features/entry";
import { useCollectionTreeOrder } from "../../hooks";
import { entryParentDir, reorderVisibleEntries } from "../table/utils";
import type { ListRowModel } from "./types";
import { replaceSiblings, siblingEntries } from "./utils";
import * as m from "@/paraglide/messages.js";

interface UseListEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  entries: Entry[];
  rows: ListRowModel[];
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  loadEntries: () => Promise<void>;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Entry>;
}

export function useListEntryActions({
  collectionPath,
  spacePath,
  projectPath,
  entries,
  rows,
  setEntries,
  loadEntries,
  onCreateEntry,
}: UseListEntryActionsOptions) {
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
        console.warn("Failed to create list entry:", error);
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
      const activeEntry = entries.find((entry) => entry.path === activePath);
      const overEntry = entries.find((entry) => entry.path === overPath);
      if (!activeEntry || !overEntry) return;

      const parentPath = entryParentDir(activeEntry.path);
      if (parentPath !== entryParentDir(overEntry.path)) return;

      const siblings = siblingEntries(entries, parentPath);
      const visibleSiblings = rows
        .map((row) => row.entry)
        .filter((entry) => entryParentDir(entry.path) === parentPath);
      const nextVisibleIndex = visibleSiblings.findIndex(
        (entry) => entry.path === overPath,
      );
      const nextSiblings = reorderVisibleEntries(
        siblings,
        visibleSiblings,
        activePath,
        nextVisibleIndex,
      );
      const previousEntries = entries;
      setEntries((current) =>
        replaceSiblings(current, parentPath, nextSiblings),
      );
      try {
        await saveOrder(parentPath, nextSiblings);
        await reloadOrderParent(parentPath);
        await loadEntries();
      } catch (error) {
        console.warn("Failed to reorder list entries:", error);
        setEntries(previousEntries);
        toast.error(m.board_move_error());
      }
    },
    [
      entries,
      loadEntries,
      reloadOrderParent,
      rows,
      saveOrder,
      setEntries,
    ],
  );

  return { createEntry, reorderEntries };
}
