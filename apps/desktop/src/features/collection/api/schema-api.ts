import {
  addCollectionColumn as addCollectionColumnDto,
  getCollectionSchema as getCollectionSchemaDto,
  renameCollectionColumn as renameCollectionColumnDto,
  updateCollectionSystemFieldLabel as updateCollectionSystemFieldLabelDto,
} from "@/platform/collections/collections-api";
import {
  normalizeSchema,
  type CollectionSchema,
  type Column,
} from "@/features/properties";

export function getCollectionSchema({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}): Promise<CollectionSchema> {
  return getCollectionSchemaDto({ spacePath, collectionPath }).then(
    normalizeSchema,
  );
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
}): Promise<CollectionSchema> {
  return addCollectionColumnDto({
    spacePath,
    collectionPath,
    column,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
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
}): Promise<CollectionSchema> {
  return renameCollectionColumnDto({
    spacePath,
    collectionPath,
    oldName,
    newName,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
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
}): Promise<CollectionSchema> {
  return updateCollectionSystemFieldLabelDto({
    spacePath,
    collectionPath,
    field,
    label,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}
