import { normalizePage, type Page } from "@/features/page";
import { createCollection as createCollectionDto } from "@/platform/collections/collections-api";

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
  return normalizePage(
    await createCollectionDto({
      spacePath,
      parentPath,
      title,
      projectPath: projectPath ?? null,
    }),
  );
}
