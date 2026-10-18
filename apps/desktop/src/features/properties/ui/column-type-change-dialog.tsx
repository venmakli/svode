import { useSchemaColumnActions } from "../hooks/use-schema-column-actions";
import type { CollectionSchema, Column, PropertyType } from "../model/types";
import { ChangeTypeDialog } from "./schema-dialogs";

/** The change type confirmation for a type picked outside the column menu. */
export function ColumnTypeChangeDialog({
  column,
  requestedType,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  onClose,
  onSchemaChange,
}: {
  column: Column;
  requestedType: PropertyType | null;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onClose: () => void;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  const { changeColumnType } = useSchemaColumnActions({
    schema,
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });

  return (
    <ChangeTypeDialog
      open={requestedType !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      column={column}
      initialType={requestedType}
      collectionPath={collectionPath}
      onSubmit={async (newType, conversionStrategy) => {
        if (await changeColumnType(newType, conversionStrategy)) onClose();
      }}
    />
  );
}
