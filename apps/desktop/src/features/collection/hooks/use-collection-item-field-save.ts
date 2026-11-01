import { useCallback, type Dispatch, type SetStateAction } from "react";
import { propertyFieldSavePolicy, type Page } from "@/features/page";
import { usePageFieldSave } from "@/features/page/field-save";
import type { Column } from "@/features/properties";
import { useSignalUserEdit } from "@/features/navigation";

export function useCollectionItemFieldSave({
  spacePath,
  projectPath,
  setItems,
  setManualOrderItems,
  onCommitError,
}: {
  spacePath: string;
  projectPath?: string | null;
  setItems: Dispatch<SetStateAction<Page[]>>;
  setManualOrderItems?: Dispatch<SetStateAction<Page[]>>;
  onCommitError?: (error: unknown) => void;
}) {
  const applyPageUpdate = useCallback(
    (itemPath: string, update: (item: Page) => Page) => {
      setItems((current) =>
        current.map((item) => (item.path === itemPath ? update(item) : item)),
      );
      setManualOrderItems?.((current) =>
        current.map((item) => (item.path === itemPath ? update(item) : item)),
      );
    },
    [setItems, setManualOrderItems],
  );
  const signalUserEdit = useSignalUserEdit();
  const { save: saveItemField } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    onSaved: signalUserEdit,
  });

  const saveField = useCallback(
    async (
      item: Page,
      column: Column,
      value: unknown,
      options?: { flush?: boolean },
    ) => {
      await saveItemField(item, column.name, value, {
        policy: propertyFieldSavePolicy(column),
        flush: options?.flush,
      });
    },
    [saveItemField],
  );

  const commitField = useCallback(
    async (
      item: Page,
      column: Column,
      value: unknown,
      options?: { flush?: boolean },
    ) => {
      try {
        await saveField(item, column, value, options);
      } catch (error) {
        onCommitError?.(error);
      }
    },
    [onCommitError, saveField],
  );

  return { commitField, saveField };
}
