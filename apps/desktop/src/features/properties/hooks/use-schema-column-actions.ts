import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  addSchemaColumn,
  changeSchemaType,
  deleteSchemaColumn,
  renameSchemaColumn,
} from "../api/schema-api";
import { propertyErrorMessage } from "../lib/error-message";
import type {
  CollectionSchema,
  Column,
  PropertyType,
  SchemaMutationWarning,
} from "../model/types";
import * as m from "@/paraglide/messages.js";

type SchemaColumnAction = "rename" | "type" | "duplicate" | "delete";

interface UseSchemaColumnActionsInput {
  schema: CollectionSchema;
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  onRenameCommitted?: (
    oldName: string,
    newName: string,
    schema: CollectionSchema,
  ) => void | Promise<void>;
}

export function useSchemaColumnActions({
  schema,
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
  onRenameCommitted,
}: UseSchemaColumnActionsInput) {
  const identity = `${spacePath}\u0000${collectionPath}\u0000${column.name}`;
  const generationKey = `${identity}\u0000${JSON.stringify(schema)}`;
  const generationKeyRef = useRef(generationKey);
  const requestGenerationRef = useRef(0);
  const pendingRef = useRef(false);
  const [pendingRequest, setPendingRequest] = useState<{
    generationKey: string;
    action: SchemaColumnAction;
  } | null>(null);

  if (generationKeyRef.current !== generationKey) {
    generationKeyRef.current = generationKey;
    requestGenerationRef.current += 1;
    pendingRef.current = false;
  }

  const runMutation = useCallback(
    async (
      action: SchemaColumnAction,
      mutation: () => Promise<{
        schema: CollectionSchema;
        warnings?: SchemaMutationWarning[];
      }>,
      afterSuccess?: (schema: CollectionSchema) => void | Promise<void>,
    ) => {
      if (pendingRef.current) return false;
      const requestGenerationKey = generationKey;
      const requestGeneration = ++requestGenerationRef.current;
      pendingRef.current = true;
      setPendingRequest({ generationKey: requestGenerationKey, action });
      try {
        const result = await mutation();
        if (
          generationKeyRef.current !== requestGenerationKey ||
          requestGenerationRef.current !== requestGeneration
        ) {
          return false;
        }
        onSchemaChange(result.schema);
        showSchemaMutationWarnings(result.warnings ?? []);
        await afterSuccess?.(result.schema);
        return true;
      } catch (error) {
        if (
          generationKeyRef.current === requestGenerationKey &&
          requestGenerationRef.current === requestGeneration
        ) {
          console.error(error);
          toast.error(propertyErrorMessage(error));
        }
        return false;
      } finally {
        if (
          generationKeyRef.current === requestGenerationKey &&
          requestGenerationRef.current === requestGeneration
        ) {
          pendingRef.current = false;
          setPendingRequest(null);
        }
      }
    },
    [generationKey, onSchemaChange],
  );

  const renameColumn = useCallback(
    (newName: string) => {
      const oldName = column.name;
      return runMutation(
        "rename",
        async () => ({
          schema: await renameSchemaColumn({
            spacePath,
            collectionPath,
            projectPath,
            oldName,
            newName,
          }),
        }),
        (nextSchema) => onRenameCommitted?.(oldName, newName, nextSchema),
      );
    },
    [
      collectionPath,
      column.name,
      onRenameCommitted,
      projectPath,
      runMutation,
      spacePath,
    ],
  );

  const changeColumnType = useCallback(
    (newType: PropertyType, conversionStrategy?: Record<string, unknown>) =>
      runMutation("type", async () => {
        const result = await changeSchemaType({
          spacePath,
          collectionPath,
          projectPath,
          columnName: column.name,
          newType,
          conversionStrategy,
        });
        return result;
      }),
    [collectionPath, column.name, projectPath, runMutation, spacePath],
  );

  const duplicateColumn = useCallback(() => {
    const duplicate = {
      ...column,
      name: uniqueColumnName(
        schema,
        `${column.name} (${m.table_duplicate_column_suffix()})`,
      ),
    };
    return runMutation("duplicate", async () => ({
      schema: await addSchemaColumn({
        spacePath,
        collectionPath,
        projectPath,
        column: duplicate,
      }),
    }));
  }, [collectionPath, column, projectPath, runMutation, schema, spacePath]);

  const deleteColumn = useCallback(
    (deleteValues: boolean) =>
      runMutation("delete", async () => ({
        schema: await deleteSchemaColumn({
          spacePath,
          collectionPath,
          projectPath,
          columnName: column.name,
          deleteValues,
        }),
      })),
    [collectionPath, column.name, projectPath, runMutation, spacePath],
  );

  return {
    changeColumnType,
    deleteColumn,
    duplicateColumn,
    pendingAction:
      pendingRequest?.generationKey === generationKey
        ? pendingRequest.action
        : null,
    renameColumn,
  };
}

function uniqueColumnName(schema: CollectionSchema, baseName: string) {
  const names = new Set(schema.columns.map((item) => item.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

function showSchemaMutationWarnings(warnings: SchemaMutationWarning[]) {
  for (const warning of warnings) {
    if (warning.code === "relation_unconverted_values") {
      toast.warning(
        m.property_relation_convert_warning({
          count: String(warning.count),
          field: warning.field,
        }),
      );
    }
  }
}
