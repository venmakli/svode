import {
  addCollectionView as addCollectionViewDto,
  deleteCollectionView as deleteCollectionViewDto,
  duplicateCollectionView as duplicateCollectionViewDto,
  renameCollectionView as renameCollectionViewDto,
  reorderCollectionViews as reorderCollectionViewsDto,
  updateCollectionDocumentLabel as updateCollectionDocumentLabelDto,
  updateCollectionView as updateCollectionViewDto,
} from "@/platform/collections/collections-api";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import type { CollectionView } from "@/features/collection/query/model";

export function addCollectionView({
  spacePath,
  collectionPath,
  view,
  position,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  view: Record<string, unknown>;
  position?: number | null;
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return addCollectionViewDto({
    spacePath,
    collectionPath,
    view,
    position: position ?? null,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function updateCollectionView({
  spacePath,
  collectionPath,
  viewName,
  patch,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  patch: Record<string, unknown>;
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return updateCollectionViewDto({
    spacePath,
    collectionPath,
    viewName,
    patch,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function renameCollectionView({
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
  return renameCollectionViewDto({
    spacePath,
    collectionPath,
    oldName,
    newName,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function duplicateCollectionView({
  spacePath,
  collectionPath,
  viewName,
  newName,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  newName: string;
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return duplicateCollectionViewDto({
    spacePath,
    collectionPath,
    viewName,
    newName,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function deleteCollectionView({
  spacePath,
  collectionPath,
  viewName,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  viewName: string;
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return deleteCollectionViewDto({
    spacePath,
    collectionPath,
    viewName,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function reorderCollectionViews({
  spacePath,
  collectionPath,
  newOrder,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  newOrder: string[];
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return reorderCollectionViewsDto({
    spacePath,
    collectionPath,
    newOrder,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function updateCollectionDocumentLabel({
  spacePath,
  collectionPath,
  label,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  label: string | null;
  projectPath?: string | null;
}): Promise<CollectionSchema> {
  return updateCollectionDocumentLabelDto({
    spacePath,
    collectionPath,
    label,
    projectPath: projectPath ?? null,
  }).then(normalizeSchema);
}

export function lastCollectionView(schema: CollectionSchema) {
  return ((schema.views ?? []) as CollectionView[]).at(-1) ?? null;
}
