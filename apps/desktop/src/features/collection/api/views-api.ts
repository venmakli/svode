import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { CollectionSchema } from "@/features/properties";
import type { CollectionView } from "@/features/collection/query";

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
}) {
  return invoke<CollectionSchema>("add_view", {
    space: spacePath,
    collectionPath,
    view,
    position: position ?? null,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("update_view", {
    space: spacePath,
    collectionPath,
    viewName,
    patch,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("rename_view", {
    space: spacePath,
    collectionPath,
    oldName,
    newName,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("duplicate_view", {
    space: spacePath,
    collectionPath,
    viewName,
    newName,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("delete_view", {
    space: spacePath,
    collectionPath,
    viewName,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("reorder_views", {
    space: spacePath,
    collectionPath,
    newOrder,
    projectPath: projectPath ?? null,
  });
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
}) {
  return invoke<CollectionSchema>("update_document_label", {
    space: spacePath,
    collectionPath,
    label,
    projectPath: projectPath ?? null,
  });
}

export function lastCollectionView(schema: CollectionSchema) {
  return ((schema.views ?? []) as CollectionView[]).at(-1) ?? null;
}
