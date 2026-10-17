import { pageNavigationItem, type Page } from "@/features/page";
import { usePageContentOperations } from "@/features/page/detail";
import { useSpace } from "@/features/space";
import type { CollectionEntryMenu } from "../model";
import { handleError } from "./error-feedback";

/**
 * The actions of the Collection rows' context menu: the operations the Peek
 * of the same item runs, followed by a refresh of the rows. Nesting a page
 * shows the new page in peek, and rename opens the item's peek on its title.
 */
export function useCollectionEntryMenu({
  readOnly,
  spacePath,
  projectPath,
  spaceId,
  refreshEntries,
  openPeek,
  duplicateRow,
  requestRowDelete,
}: {
  readOnly: boolean;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  refreshEntries: () => void;
  openPeek: (page: Page, options?: { focusTitle?: boolean }) => void;
  duplicateRow: (page: Page) => Promise<void>;
  requestRowDelete: (page: Page) => void;
}): CollectionEntryMenu {
  const activeRootId = useSpace((state) => state.activeRootId);
  const operations = usePageContentOperations({
    spacePath,
    projectPath: projectPath ?? null,
    spaceId,
  });

  const mutate = (operation: () => Promise<void>) => () => {
    if (readOnly) return;
    void operation().then(refreshEntries).catch(handleError);
  };

  /** A nested Collection takes its new item the same way. */
  const nestPage = (entry: Page) =>
    mutate(async () => {
      const { childPage } = await operations.nestPage(entry);
      openPeek(childPage);
    });

  return {
    readOnly,
    spacePath,
    pinItem: (entry) => pageNavigationItem(entry, spaceId, activeRootId),
    handlers: (entry) => ({
      "nest-page": nestPage(entry),
      "new-item": nestPage(entry),
      "new-folder": mutate(async () => {
        await operations.newFolder(entry);
      }),
      "make-collection": mutate(async () => {
        await operations.makeCollection(entry);
      }),
      "make-leaf": mutate(async () => {
        await operations.makeLeaf(entry);
      }),
      rename: () => {
        if (!readOnly) openPeek(entry, { focusTitle: true });
      },
      duplicate: () => {
        if (!readOnly) void duplicateRow(entry).catch(handleError);
      },
      delete: () => requestRowDelete(entry),
    }),
  };
}
