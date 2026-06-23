import {
  convertBareFolderToCollection,
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

  const entry = await convertBareFolderToCollection({
    spacePath,
    folderPath,
    projectPath: projectPath ?? null,
  });

  return { path: entry.path };
}
