import { toast } from "sonner";
import type { CollectionSchema, PropertyType } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
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
