import { useCallback } from "react";
import { toast } from "sonner";
import {
  normalizeUniqueIdCounter,
  updateSchemaColumn,
} from "../api/schema-api";
import { propertyErrorMessage } from "../lib/error-message";
import type { CollectionSchema, Column, ColumnPatch } from "../model/types";

interface UseColumnTypeSettingsInput {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
}

export function useColumnTypeSettings({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
}: UseColumnTypeSettingsInput) {
  const handleError = useCallback((error: unknown) => {
    console.error(error);
    toast.error(propertyErrorMessage(error));
  }, []);

  const patchColumn = useCallback(
    async (patch: ColumnPatch) => {
      try {
        const next = await updateSchemaColumn({
          spacePath,
          collectionPath,
          columnName: column.name,
          patch,
          projectPath,
        });
        onSchemaChange(next);
      } catch (error) {
        handleError(error);
      }
    },
    [
      collectionPath,
      column.name,
      handleError,
      onSchemaChange,
      projectPath,
      spacePath,
    ],
  );

  const normalizeCounter = useCallback(() => {
    void normalizeUniqueIdCounter({
      spacePath,
      collectionPath,
      projectPath,
    })
      .then(onSchemaChange)
      .catch(handleError);
  }, [collectionPath, handleError, onSchemaChange, projectPath, spacePath]);

  return { patchColumn, normalizeCounter };
}
