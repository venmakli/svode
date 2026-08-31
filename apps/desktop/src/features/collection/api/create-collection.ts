import { retargetPageFilenameWarnings, type Page } from "@/features/page";
import { createPage } from "@/features/page/page-api";
import { convertToCollection } from "@/platform/collections/collections-api";

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
}: CreateCollectionArgs): Promise<Page> {
  const page = await createPage({
    spacePath,
    parentPath,
    title,
    allocateUniqueTitle: true,
    contextualDefaults: null,
    projectPath: projectPath ?? null,
  });

  const conversion = await convertToCollection({
    spacePath,
    path: page.path,
    projectPath: projectPath ?? null,
  });

  return {
    ...page,
    path: conversion.page.path,
    warnings: retargetPageFilenameWarnings(
      page.warnings,
      conversion.page.path,
    ),
  };
}
