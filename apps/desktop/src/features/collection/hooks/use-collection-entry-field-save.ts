import { useCallback, type Dispatch, type SetStateAction } from "react";
import { propertyFieldSavePolicy, type Entry } from "@/features/entry";
import { useEntryFieldSave } from "@/features/entry/field-save";
import type { Column } from "@/features/properties";

export function useCollectionEntryFieldSave({
  spacePath,
  projectPath,
  setEntries,
  setManualOrderEntries,
  onCommitError,
}: {
  spacePath: string;
  projectPath?: string | null;
  setEntries: Dispatch<SetStateAction<Entry[]>>;
  setManualOrderEntries?: Dispatch<SetStateAction<Entry[]>>;
  onCommitError?: (error: unknown) => void;
}) {
  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
      setManualOrderEntries?.((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [setEntries, setManualOrderEntries],
  );
  const saveEntryField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
  });

  const saveField = useCallback(
    async (
      entry: Entry,
      column: Column,
      value: unknown,
      options?: { flush?: boolean },
    ) => {
      await saveEntryField(entry, column.name, value, {
        policy: propertyFieldSavePolicy(column),
        flush: options?.flush,
      });
    },
    [saveEntryField],
  );

  const commitField = useCallback(
    async (
      entry: Entry,
      column: Column,
      value: unknown,
      options?: { flush?: boolean },
    ) => {
      try {
        await saveField(entry, column, value, options);
      } catch (error) {
        onCommitError?.(error);
      }
    },
    [onCommitError, saveField],
  );

  return { commitField, saveField };
}
