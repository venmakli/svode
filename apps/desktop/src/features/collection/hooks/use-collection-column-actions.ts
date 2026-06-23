import type { CollectionSchema, PropertyType } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { addCollectionColumn, addCollectionDateColumn } from "../api";

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

  return { addColumn, addDateColumn };
}
