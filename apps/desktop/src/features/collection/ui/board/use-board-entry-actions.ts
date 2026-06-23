import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Entry } from "@/features/entry";
import type { Column } from "@/features/properties";
import {
  useCollectionEntryFieldSave,
  useCollectionTreeOrder,
} from "../../hooks";
import { entryParentDir } from "../table/utils";
import {
  groupKeyForValue,
  groupValue,
  groupValueForKey,
  noValueKey,
  reorderEntryAround,
  updateEntryGroupValue,
} from "./utils";
import * as m from "@/paraglide/messages.js";

interface MoveBoardCardArgs {
  activeEntryPath: string;
  targetGroupKey: string | null;
  overEntryPath: string | null;
  placement: "before" | "after";
}

interface UseBoardEntryActionsOptions {
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  entries: Entry[];
  manualOrderEntries: Entry[];
  topLevelEntries: Entry[];
  groupColumn: Column | null;
  hasSort: boolean;
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  setManualOrderEntries: Dispatch<SetStateAction<Entry[]>>;
  loadEntries: () => Promise<void>;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Entry>;
}

export function useBoardEntryActions({
  collectionPath,
  spacePath,
  projectPath,
  entries,
  manualOrderEntries,
  topLevelEntries,
  groupColumn,
  hasSort,
  setEntries,
  setManualOrderEntries,
  loadEntries,
  onCreateEntry,
}: UseBoardEntryActionsOptions) {
  const { reloadOrderParent, saveOrder } = useCollectionTreeOrder({
    spacePath,
    projectPath,
  });

  const handleFieldCommitError = useCallback(
    (error: unknown) => {
      console.warn("Failed to update board field:", error);
      void loadEntries();
    },
    [loadEntries],
  );
  const { commitField, saveField } = useCollectionEntryFieldSave({
    spacePath,
    projectPath,
    setEntries,
    setManualOrderEntries,
    onCommitError: handleFieldCommitError,
  });

  const moveCard = useCallback(
    async ({
      activeEntryPath,
      targetGroupKey,
      overEntryPath,
      placement,
    }: MoveBoardCardArgs) => {
      if (!groupColumn || !targetGroupKey) return;

      const activeEntry = topLevelEntries.find(
        (entry) => entry.path === activeEntryPath,
      );
      if (!activeEntry) return;

      const sourceGroupKey = groupKeyForValue(
        groupValue(activeEntry, groupColumn),
      );
      const targetValue = groupValueForKey(targetGroupKey);
      const crossColumn = sourceGroupKey !== targetGroupKey;
      const positional = Boolean(overEntryPath) && !hasSort;

      if (!crossColumn && (!positional || activeEntryPath === overEntryPath)) {
        return;
      }
      if (hasSort && !crossColumn) return;

      const previousEntries = entries;
      const previousManualOrderEntries = manualOrderEntries;
      const orderTopLevelEntries = (
        manualOrderEntries.length > 0 ? manualOrderEntries : topLevelEntries
      ).filter((entry) => entryParentDir(entry.path) === collectionPath);
      const withGroup = crossColumn
        ? topLevelEntries.map((entry) =>
            entry.path === activeEntryPath
              ? updateEntryGroupValue(entry, groupColumn, targetValue)
              : entry,
          )
        : topLevelEntries;
      const withGroupForOrder = crossColumn
        ? orderTopLevelEntries.map((entry) =>
            entry.path === activeEntryPath
              ? updateEntryGroupValue(entry, groupColumn, targetValue)
              : entry,
          )
        : orderTopLevelEntries;
      const nextTopLevel =
        positional && overEntryPath
          ? reorderEntryAround(
              withGroup,
              activeEntryPath,
              overEntryPath,
              placement,
            )
          : withGroup;
      const nextOrderTopLevel =
        positional && overEntryPath
          ? reorderEntryAround(
              withGroupForOrder,
              activeEntryPath,
              overEntryPath,
              placement,
            )
          : withGroupForOrder;
      setEntries((current) =>
        positional
          ? [
              ...nextTopLevel,
              ...current.filter(
                (entry) => entryParentDir(entry.path) !== collectionPath,
              ),
            ]
          : current.map((entry) =>
              entry.path === activeEntryPath
                ? updateEntryGroupValue(entry, groupColumn, targetValue)
                : entry,
            ),
      );
      setManualOrderEntries((current) =>
        positional
          ? [
              ...nextOrderTopLevel,
              ...current.filter(
                (entry) => entryParentDir(entry.path) !== collectionPath,
              ),
            ]
          : current.map((entry) =>
              entry.path === activeEntryPath
                ? updateEntryGroupValue(entry, groupColumn, targetValue)
                : entry,
            ),
      );

      try {
        if (crossColumn) {
          await saveField(activeEntry, groupColumn, targetValue, {
            flush: true,
          });
        }
        if (positional) {
          await saveOrder(collectionPath, nextOrderTopLevel);
          await reloadOrderParent(collectionPath);
        }
        await loadEntries();
      } catch (error) {
        console.warn("Failed to move board card:", error);
        if (crossColumn) {
          try {
            await saveField(
              activeEntry,
              groupColumn,
              groupValueForKey(sourceGroupKey),
              { flush: true },
            );
          } catch (rollbackError) {
            console.warn("Failed to rollback board card move:", rollbackError);
          }
        }
        setEntries(previousEntries);
        setManualOrderEntries(previousManualOrderEntries);
        void loadEntries();
        toast.error(m.board_move_error());
      }
    },
    [
      collectionPath,
      entries,
      groupColumn,
      hasSort,
      loadEntries,
      manualOrderEntries,
      reloadOrderParent,
      saveField,
      saveOrder,
      setEntries,
      setManualOrderEntries,
      topLevelEntries,
    ],
  );

  const createDraft = useCallback(
    async (
      title: string,
      groupKey: string,
      asFolder: boolean,
      onCreated?: (entry: Entry) => void,
    ) => {
      try {
        const defaults =
          groupKey === noValueKey() || !groupColumn
            ? undefined
            : { [groupColumn.name]: groupValueForKey(groupKey) };
        const created = await onCreateEntry(title, asFolder, defaults);
        onCreated?.(created);
        setEntries((current) => [...current, created]);
        setManualOrderEntries((current) => [...current, created]);
        await loadEntries();
        return created;
      } catch (error) {
        console.warn("Failed to create board entry:", error);
        toast.error(m.board_create_error());
        return null;
      }
    },
    [groupColumn, loadEntries, onCreateEntry, setEntries, setManualOrderEntries],
  );

  return { commitField, createDraft, moveCard };
}
