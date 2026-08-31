import { useCallback, type Dispatch, type SetStateAction } from "react";
import { propertyFieldSavePolicy, type Page } from "@/features/page";
import { usePageFieldSave } from "@/features/page/field-save";
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
  setEntries: Dispatch<SetStateAction<Page[]>>;
  setManualOrderEntries?: Dispatch<SetStateAction<Page[]>>;
  onCommitError?: (error: unknown) => void;
}) {
  const applyPageUpdate = useCallback(
    (entryPath: string, update: (entry: Page) => Page) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
      setManualOrderEntries?.((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [setEntries, setManualOrderEntries],
  );
  const { save: saveEntryField } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
  });

  const saveField = useCallback(
    async (
      entry: Page,
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
      entry: Page,
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
