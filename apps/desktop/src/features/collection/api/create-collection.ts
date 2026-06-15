import { invokeCommand as invoke } from "@/platform/native/invoke";

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
  const folderPath = await invoke<string>("create_folder", {
    space: spacePath,
    parentPath,
    name: title,
    projectPath,
  });

  return invoke<CollectionEntry>("convert_bare_folder_to_collection", {
    space: spacePath,
    folderPath,
    projectPath,
  });
}
