import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  addOption as addOptionApi,
  addSchemaColumn,
  assignPageUniqueId,
  clearFieldValues,
  clearOptionValues,
  getPageSchema,
  listPropertyActors,
  promoteOrphan as promoteOrphanApi,
} from "../api/schema-api";
import { notifyPropertyAddFailed } from "../lib/error-message";
import { normalizeSchema } from "../lib/utils";
import type {
  ActorCandidate,
  Column,
  PageSchemaResult,
  PropertyOption,
  PropertyType,
  RelationContext,
} from "../model/types";
import { newPropertyColumn } from "../ui/property-type-meta";
import * as m from "@/paraglide/messages.js";

interface UseCollectionSchemaPanelInput {
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  /** The item of the Collection whose properties the panel shows. */
  itemPath: string;
  schemaResult: PageSchemaResult;
  /** The item's saved values by property name. */
  values: Record<string, unknown>;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
  onSchemaChange?: (result: PageSchemaResult | null) => void;
}

/**
 * The schema extensions of the property panel for an item of a Collection
 * with a schema: the column menu at a label, "+ Add property", the state of
 * an invalid value with its repair, "Number repeats" of a `unique_id` and
 * the values the schema does not declare. See `CollectionPropertyPanel`.
 */
export type CollectionSchemaPanel = ReturnType<typeof useCollectionSchemaPanel>;

interface SchemaMutationContext {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export function useCollectionSchemaPanel({
  spacePath,
  projectPath,
  spaceId,
  itemPath: filePath,
  schemaResult,
  values,
  onOpenPath,
  onSchemaChange,
}: UseCollectionSchemaPanelInput) {
  const [schema, setSchema] = useState(() =>
    normalizeSchema(schemaResult.schema),
  );
  const [collectionRootPath, setCollectionRootPath] = useState(() =>
    schemaResultCollectionPath(schemaResult),
  );
  const [uniqueIdDuplicate, setUniqueIdDuplicate] = useState(
    () => schemaResult.uniqueIdDuplicate ?? null,
  );
  const [actors, setActors] = useState<ActorCandidate[]>([]);
  // The property whose column menu is open, such as one just added.
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  // The values a repair here changed, until the item reads them back.
  const [panelValues, setPanelValues] = useState(values);

  const handleSchemaError = useCallback((error: unknown) => {
    console.error("Schema operation failed:", error);
    toast.error(m.toast_error());
  }, []);

  const applySchemaResult = useCallback((result: PageSchemaResult | null) => {
    if (!result) return;
    setSchema(normalizeSchema(result.schema));
    setCollectionRootPath(schemaResultCollectionPath(result));
    setUniqueIdDuplicate(result.uniqueIdDuplicate ?? null);
  }, []);

  useEffect(() => {
    applySchemaResult(schemaResult);
  }, [applySchemaResult, schemaResult]);

  useEffect(() => {
    setPanelValues(values);
  }, [values]);

  const hasActor = useMemo(
    () => schema.columns.some((column) => column.type === "actor"),
    [schema.columns],
  );

  const loadActors = useCallback(
    async (allTime = false) => {
      if (!spacePath) return [];
      try {
        const list = await listPropertyActors(spacePath, allTime);
        setActors(list);
        return list;
      } catch (error) {
        console.warn("Failed to load actors:", error);
        return [];
      }
    },
    [spacePath],
  );

  useEffect(() => {
    if (hasActor) void loadActors();
  }, [hasActor, loadActors]);

  const refreshSchema = useCallback(async () => {
    const result = await getPageSchema({ spacePath, filePath });
    applySchemaResult(result);
    onSchemaChange?.(result);
    return result;
  }, [applySchemaResult, filePath, onSchemaChange, spacePath]);

  const applyCollectionSchema = useCallback(
    (nextSchema: typeof schema) => {
      const result: PageSchemaResult = {
        schema: normalizeSchema(nextSchema),
        collectionRootPath,
        uniqueIdDuplicate,
      };
      applySchemaResult(result);
      onSchemaChange?.(result);
    },
    [applySchemaResult, collectionRootPath, onSchemaChange, uniqueIdDuplicate],
  );

  const schemaMutationContext = useMemo<SchemaMutationContext>(
    () => ({
      spacePath,
      collectionPath: collectionRootPath,
      projectPath,
    }),
    [collectionRootPath, projectPath, spacePath],
  );

  const runSchemaMutation = useCallback(
    async (operation: () => Promise<void>) => {
      try {
        await operation();
        return true;
      } catch (error) {
        handleSchemaError(error);
        return false;
      }
    },
    [handleSchemaError],
  );

  const assignUniqueId = useCallback(
    () =>
      runSchemaMutation(async () => {
        const nextValues = await assignPageUniqueId({
          spacePath,
          filePath,
          projectPath,
        });
        setPanelValues(nextValues);
        await refreshSchema();
      }),
    [filePath, projectPath, refreshSchema, runSchemaMutation, spacePath],
  );

  /**
   * Adds a property named after its type and opens its column menu with the
   * name in focus; a refusal is reported and leaves the schema as it was.
   */
  const addProperty = useCallback(
    async (type: PropertyType) => {
      const column = newPropertyColumn({
        columns: schema.columns,
        type,
        collectionPath: collectionRootPath,
      });
      try {
        await addSchemaColumn({ ...schemaMutationContext, column });
      } catch (error) {
        notifyPropertyAddFailed(error);
        return null;
      }
      await runSchemaMutation(async () => {
        await refreshSchema();
      });
      setOpenColumn(column.name);
    },
    [
      collectionRootPath,
      refreshSchema,
      runSchemaMutation,
      schema.columns,
      schemaMutationContext,
    ],
  );

  const addOption = useCallback(
    (column: Column, option: PropertyOption) =>
      runSchemaMutation(async () => {
        await addOptionApi({
          ...schemaMutationContext,
          columnName: column.name,
          option,
        });
        await refreshSchema();
      }),
    [refreshSchema, runSchemaMutation, schemaMutationContext],
  );

  const promoteOrphan = useCallback(
    (field: string) =>
      runSchemaMutation(async () => {
        await promoteOrphanApi({
          ...schemaMutationContext,
          filePath,
          field,
        });
        await refreshSchema();
      }),
    [filePath, refreshSchema, runSchemaMutation, schemaMutationContext],
  );

  const clearOrphanValues = useCallback(
    (field: string) =>
      runSchemaMutation(async () => {
        await clearFieldValues({ ...schemaMutationContext, field });
        await refreshSchema();
        setPanelValues((current) => {
          const next = { ...current };
          delete next[field];
          return next;
        });
      }),
    [refreshSchema, runSchemaMutation, schemaMutationContext],
  );

  const clearInvalidOptionValues = useCallback(
    (column: Column, optionNames: string[]) =>
      runSchemaMutation(async () => {
        if (optionNames.length === 0) return;
        await clearOptionValues({
          ...schemaMutationContext,
          columnName: column.name,
          optionNames,
        });
        await refreshSchema();
        setPanelValues((current) => ({
          ...current,
          [column.name]: removeOptionValues(current[column.name], optionNames),
        }));
      }),
    [refreshSchema, runSchemaMutation, schemaMutationContext],
  );

  const columnNames = new Set(schema.columns.map((column) => column.name));
  const orphanEntries = Object.entries(panelValues).filter(
    ([key]) => !columnNames.has(key),
  );

  const relationContext = useMemo<RelationContext>(
    () => ({
      spacePath,
      projectPath,
      spaceId,
      currentFilePath: filePath,
      onOpenPath,
    }),
    [filePath, onOpenPath, projectPath, spaceId, spacePath],
  );

  return {
    spacePath,
    projectPath,
    schema,
    collectionRootPath,
    uniqueIdDuplicate,
    actors,
    openColumn,
    setOpenColumn,
    panelValues,
    orphanEntries,
    relationContext,
    loadActors,
    handleSchemaError,
    applyCollectionSchema,
    assignUniqueId,
    addProperty,
    addOption,
    promoteOrphan,
    clearOrphanValues,
    clearInvalidOptionValues,
  };
}

function schemaResultCollectionPath(result: PageSchemaResult) {
  return result.collectionRootPath ?? "";
}

function removeOptionValues(value: unknown, optionNames: string[]) {
  const names = new Set(optionNames);
  if (typeof value === "string") {
    return names.has(value) ? null : value;
  }
  if (Array.isArray(value)) {
    const next = value.filter(
      (item) => typeof item !== "string" || !names.has(item),
    );
    return next.length > 0 ? next : null;
  }
  return value;
}
