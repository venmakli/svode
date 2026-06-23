import { toast } from "sonner";
import type {
  CollectionSchema,
  Column,
  PropertyType,
  SchemaMutationWarning,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import {
  changeSchemaType,
  deleteSchemaColumn,
} from "@/features/properties/api";
import {
  addCollectionColumn,
  addCollectionDateColumn,
  renameCollectionColumn,
  updateCollectionSystemFieldLabel,
} from "../api";
import * as m from "@/paraglide/messages.js";

export function useCollectionColumnActions({
  schema,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
}: {
  schema: CollectionSchema;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  function uniqueColumnName(baseName: string) {
    const names = new Set(schema.columns.map((column) => column.name));
    if (!names.has(baseName)) return baseName;
    let index = 2;
    while (names.has(`${baseName} ${index}`)) index += 1;
    return `${baseName} ${index}`;
  }

  async function runColumnMutation(
    mutation: () => Promise<CollectionSchema>,
  ): Promise<boolean> {
    try {
      const next = await mutation();
      onSchemaChange(normalizeSchema(next));
      return true;
    } catch (error) {
      console.error(error);
      toast.error(errorMessage(error));
      return false;
    }
  }

  async function addColumn({
    type,
    baseName,
    relation,
  }: {
    type: PropertyType;
    baseName: string;
    relation?: string;
  }) {
    const name = uniqueColumnName(baseName);
    const next = await addCollectionColumn({
      spacePath,
      collectionPath,
      column: {
        name,
        type,
        relation,
      },
      projectPath,
    });
    const normalized = normalizeSchema(next);
    onSchemaChange(normalized);
    return { name, schema: normalized };
  }

  async function addDateColumn({ baseName }: { baseName: string }) {
    const name = uniqueColumnName(baseName);
    const next = await addCollectionDateColumn({
      spacePath,
      collectionPath,
      column: { name, type: "date" },
      projectPath,
    });
    const normalized = normalizeSchema(next);
    onSchemaChange(normalized);
    return { name, schema: normalized };
  }

  function updateSystemFieldLabel({
    field,
    label,
  }: {
    field: string;
    label: string | null;
  }) {
    return runColumnMutation(() =>
      updateCollectionSystemFieldLabel({
        spacePath,
        collectionPath,
        field,
        label,
        projectPath,
      }),
    );
  }

  function renameColumn({
    oldName,
    newName,
    visibleFields,
    onUpdateViewPatch,
  }: {
    oldName: string;
    newName: string;
    visibleFields: string[];
    onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
  }) {
    return (async () => {
      try {
        const next = await renameCollectionColumn({
          spacePath,
          collectionPath,
          oldName,
          newName,
          projectPath,
        });
        onSchemaChange(normalizeSchema(next));
        await onUpdateViewPatch({
          visible_fields: visibleFields.map((visible) =>
            visible === oldName ? newName : visible,
          ),
        });
        return true;
      } catch (error) {
        console.error(error);
        toast.error(errorMessage(error));
        return false;
      }
    })();
  }

  function duplicateColumn(column: Column, baseName: string) {
    const duplicate = { ...column, name: uniqueColumnName(baseName) };
    return runColumnMutation(() =>
      addCollectionColumn({
        spacePath,
        collectionPath,
        column: duplicate,
        projectPath,
      }),
    );
  }

  async function changeColumnType({
    columnName,
    newType,
  }: {
    columnName: string;
    newType: PropertyType;
  }) {
    try {
      const result = await changeSchemaType({
        spacePath,
        collectionPath,
        columnName,
        newType,
        conversionStrategy:
          newType === "relation"
            ? { relation: collectionPath || "." }
            : undefined,
        projectPath,
      });
      onSchemaChange(result.schema);
      showSchemaMutationWarnings(result.warnings);
      return true;
    } catch (error) {
      console.error(error);
      toast.error(errorMessage(error));
      return false;
    }
  }

  function deleteColumn({
    columnName,
    deleteValues,
  }: {
    columnName: string;
    deleteValues: boolean;
  }) {
    return runColumnMutation(() =>
      deleteSchemaColumn({
        spacePath,
        collectionPath,
        columnName,
        deleteValues,
        projectPath,
      }),
    );
  }

  return {
    addColumn,
    addDateColumn,
    changeColumnType,
    deleteColumn,
    duplicateColumn,
    renameColumn,
    updateSystemFieldLabel,
  };
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

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return m.toast_error();
}
