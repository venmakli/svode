import { toast } from "sonner";
import type { CollectionSchema, PropertyType } from "@/features/properties";
import {
  newPropertyColumn,
  normalizeSchema,
  uniquePropertyName,
} from "@/features/properties";
import {
  addCollectionColumn,
  addCollectionDateColumn,
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

  async function addColumn(type: PropertyType) {
    const column = newPropertyColumn({
      columns: schema.columns,
      type,
      collectionPath,
    });
    const next = await addCollectionColumn({
      spacePath,
      collectionPath,
      column,
      projectPath,
    });
    const normalized = normalizeSchema(next);
    onSchemaChange(normalized);
    return { name: column.name, schema: normalized };
  }

  async function addDateColumn({ baseName }: { baseName: string }) {
    const name = uniquePropertyName(schema.columns, baseName);
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

  return {
    addColumn,
    addDateColumn,
    updateSystemFieldLabel,
  };
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
