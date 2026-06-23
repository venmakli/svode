import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { CollectionSchema, Column } from "@/features/properties";

export function getCollectionSchema({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}) {
  return invoke<CollectionSchema>("get_collection_schema", {
    space: spacePath,
    collectionPath,
  });
}

export function addCollectionColumn({
  spacePath,
  collectionPath,
  column,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  column: Column;
  projectPath?: string | null;
}) {
  return invoke<CollectionSchema>("add_schema_column", {
    space: spacePath,
    collectionPath,
    column,
    projectPath: projectPath ?? null,
  });
}

export function renameCollectionColumn({
  spacePath,
  collectionPath,
  oldName,
  newName,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  oldName: string;
  newName: string;
  projectPath?: string | null;
}) {
  return invoke<CollectionSchema>("rename_schema_column", {
    space: spacePath,
    collectionPath,
    oldName,
    newName,
    projectPath: projectPath ?? null,
  });
}

export function updateCollectionSystemFieldLabel({
  spacePath,
  collectionPath,
  field,
  label,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  field: string;
  label: string | null;
  projectPath?: string | null;
}) {
  return invoke<CollectionSchema>("update_system_field_label", {
    space: spacePath,
    collectionPath,
    field,
    label,
    projectPath: projectPath ?? null,
  });
}
