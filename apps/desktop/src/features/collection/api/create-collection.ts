import { retargetEntryFilenameWarnings, type Entry } from "@/features/entry";
import { createEntry } from "@/features/entry/entry-api";
import { convertToCollection } from "@/platform/collections/collections-api";

export type CollectionEntry = Entry;

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
  const entry = await createEntry({
    spacePath,
    parentPath,
    title,
    allocateUniqueTitle: true,
    contextualDefaults: null,
    projectPath: projectPath ?? null,
  });

  const conversion = await convertToCollection({
    spacePath,
    path: entry.path,
    projectPath: projectPath ?? null,
  });

  return {
    ...entry,
    path: conversion.entry.path,
    warnings: retargetEntryFilenameWarnings(
      entry.warnings,
      conversion.entry.path,
    ),
  };
}
