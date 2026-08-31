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
import { normalizeSchema } from "../lib/utils";
import type {
  ActorCandidate,
  Column,
  PageSchemaResult,
  PropertyOption,
  RelationContext,
} from "../model/types";
import * as m from "@/paraglide/messages.js";

interface UsePropertyPanelStateInput {
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  filePath: string;
  schemaResult: PageSchemaResult;
  values: Record<string, unknown>;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
  onSchemaChange?: (result: PageSchemaResult | null) => void;
}

interface SchemaMutationContext {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}

export function usePropertyPanelState({
  spacePath,
  projectPath,
  spaceId,
  filePath,
  schemaResult,
  values,
  onOpenPath,
  onSchemaChange,
}: UsePropertyPanelStateInput) {
  const [schema, setSchema] = useState(() =>
    normalizeSchema(schemaResult.schema),
  );
  const [collectionRootPath, setCollectionRootPath] = useState(() =>
    schemaResultCollectionPath(schemaResult),
  );
  const [actors, setActors] = useState<ActorCandidate[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [panelValues, setPanelValues] = useState(values);

  const handleSchemaError = useCallback((error: unknown) => {
    console.error("Schema operation failed:", error);
    toast.error(m.toast_error());
  }, []);

  const applySchemaResult = useCallback((result: PageSchemaResult | null) => {
    if (!result) return;
    setSchema(normalizeSchema(result.schema));
    setCollectionRootPath(schemaResultCollectionPath(result));
  }, []);

  useEffect(() => {
    applySchemaResult(schemaResult);
    setEditingField(null);
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
      };
      applySchemaResult(result);
      onSchemaChange?.(result);
    },
    [applySchemaResult, collectionRootPath, onSchemaChange],
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

  const addColumn = useCallback(
    (column: Column) =>
      runSchemaMutation(async () => {
        await addSchemaColumn({ ...schemaMutationContext, column });
        await refreshSchema();
      }),
    [refreshSchema, runSchemaMutation, schemaMutationContext],
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
    schema,
    collectionRootPath,
    actors,
    editingField,
    setEditingField,
    panelValues,
    orphanEntries,
    relationContext,
    loadActors,
    handleSchemaError,
    applyCollectionSchema,
    assignUniqueId,
    addColumn,
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
