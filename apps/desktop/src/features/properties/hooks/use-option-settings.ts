import { useCallback, useMemo, useState } from "react";
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

  const patchOptions = useCallback(
    (nextOptions: PropertyOption[]) => {
      void updateSchemaColumn({
        spacePath,
        collectionPath,
        columnName: column.name,
        patch: { options: nextOptions },
        projectPath,
      }).then(onSchemaChange);
    },
    [collectionPath, column.name, onSchemaChange, projectPath, spacePath],
  );

  const addOption = useCallback(
    (group?: StatusGroup) => {
      const name = uniqueOptionName(options, "Option");
      setFocusedOption(name);
      void addOptionApi({
        spacePath,
        collectionPath,
        columnName: column.name,
        option: { name, color: "neutral", group: group ?? null },
        projectPath,
      }).then(onSchemaChange);
    },
    [
      collectionPath,
      column.name,
      onSchemaChange,
      options,
      projectPath,
      spacePath,
    ],
  );

  const updateOption = useCallback(
    (option: PropertyOption, patch: Record<string, unknown>) => {
      void updateOptionApi({
        spacePath,
        collectionPath,
        columnName: column.name,
        optionName: option.name,
        option: null,
        patch,
        projectPath,
      }).then(onSchemaChange);
    },
    [collectionPath, column.name, onSchemaChange, projectPath, spacePath],
  );

  const renameOption = useCallback(
    (option: PropertyOption, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === option.name) return;
      void renameOptionApi({
        spacePath,
        collectionPath,
        columnName: column.name,
        oldOptionName: option.name,
        newOptionName: trimmed,
        projectPath,
      }).then(onSchemaChange);
    },
    [collectionPath, column.name, onSchemaChange, projectPath, spacePath],
  );

  const removeOption = useCallback(
    (option: PropertyOption) => {
      void deleteOptionApi({
        spacePath,
        collectionPath,
        columnName: column.name,
        optionName: option.name,
        deleteValues: false,
        projectPath,
      }).then(onSchemaChange);
    },
    [collectionPath, column.name, onSchemaChange, projectPath, spacePath],
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
