import {
  convertToCollection,
  createFolder,
} from "@/platform/collections/collections-api";

export interface CollectionEntry {
  path: string;
}

interface CreateCollectionArgs {
  spacePath: string;
  parentPath?: string | null;
  title: string;
  projectPath?: string | null;
}

export async function createCollection({
  spacePath,
  parentPath = null,
  title,
  projectPath,
}: CreateCollectionArgs): Promise<CollectionEntry> {
  const folderPath = await createFolder({
    spacePath,
    parentPath,
    name: title,
    projectPath: projectPath ?? null,
  });

  const conversion = await convertToCollection({
    spacePath,
    path: folderPath,
    projectPath: projectPath ?? null,
  });

  return { path: conversion.entry.path };
}
