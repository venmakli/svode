import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  addOption as addOptionApi,
  deleteOption as deleteOptionApi,
  renameOption as renameOptionApi,
  updateOption as updateOptionApi,
  updateSchemaColumn,
} from "../api/schema-api";
import type {
  CollectionSchema,
  Column,
  PropertyOption,
  StatusGroup,
} from "../model/types";
import { propertyErrorMessage } from "../lib/error-message";

interface UseOptionSettingsInput {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
}

export function useOptionSettings({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
}: UseOptionSettingsInput) {
  const options = useMemo(() => column.options ?? [], [column.options]);
  const [focusedOption, setFocusedOption] = useState<string | null>(null);

  const handleMutationError = useCallback((error: unknown) => {
    console.error(error);
    toast.error(propertyErrorMessage(error));
  }, []);

  const runOptionMutation = useCallback(
    (mutation: () => Promise<CollectionSchema>, onError?: () => void) => {
      void mutation()
        .then(onSchemaChange)
        .catch((error) => {
          onError?.();
          handleMutationError(error);
        });
    },
    [handleMutationError, onSchemaChange],
  );

  const patchOptions = useCallback(
    (nextOptions: PropertyOption[]) => {
      runOptionMutation(() =>
        updateSchemaColumn({
          spacePath,
          collectionPath,
          columnName: column.name,
          patch: { options: nextOptions },
          projectPath,
        }),
      );
    },
    [collectionPath, column.name, projectPath, runOptionMutation, spacePath],
  );

  const addOption = useCallback(
    (group?: StatusGroup) => {
      const name = uniqueOptionName(options, "Option");
      setFocusedOption(name);
      runOptionMutation(
        () =>
          addOptionApi({
            spacePath,
            collectionPath,
            columnName: column.name,
            option: { name, color: "neutral", group: group ?? null },
            projectPath,
          }),
        () => setFocusedOption(null),
      );
    },
    [
      collectionPath,
      column.name,
      options,
      projectPath,
      runOptionMutation,
      spacePath,
    ],
  );

  const updateOption = useCallback(
    (option: PropertyOption, patch: Record<string, unknown>) => {
      runOptionMutation(() =>
        updateOptionApi({
          spacePath,
          collectionPath,
          columnName: column.name,
          optionName: option.name,
          option: null,
          patch,
          projectPath,
        }),
      );
    },
    [collectionPath, column.name, projectPath, runOptionMutation, spacePath],
  );

  const renameOption = useCallback(
    (option: PropertyOption, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === option.name) return;
      runOptionMutation(() =>
        renameOptionApi({
          spacePath,
          collectionPath,
          columnName: column.name,
          oldOptionName: option.name,
          newOptionName: trimmed,
          projectPath,
        }),
      );
    },
    [collectionPath, column.name, projectPath, runOptionMutation, spacePath],
  );

  const removeOption = useCallback(
    (option: PropertyOption) => {
      runOptionMutation(() =>
        deleteOptionApi({
          spacePath,
          collectionPath,
          columnName: column.name,
          optionName: option.name,
          deleteValues: false,
          projectPath,
        }),
      );
    },
    [collectionPath, column.name, projectPath, runOptionMutation, spacePath],
  );

  return {
    options,
    focusedOption,
    clearFocusedOption: () => setFocusedOption(null),
    patchOptions,
    addOption,
    updateOption,
    renameOption,
    removeOption,
  };
}

function uniqueOptionName(options: PropertyOption[], baseName: string) {
  const names = new Set(options.map((option) => option.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}
