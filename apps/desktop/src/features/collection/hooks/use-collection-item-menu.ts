import { pageNavigationItem, type Page } from "@/features/page";
import {
  handleStructuralError,
  usePageContentOperations,
} from "@/features/page/detail";
import { useSpace, useSpaceNames } from "@/features/space";
import type { CollectionItemMenu } from "../model";

/**
 * The actions of the Collection items' context menu: the operations the Peek
 * of the same item runs, followed by a refresh of the items. Nesting a page
 * shows the new page in peek, and rename opens the item's peek on its title.
 */
export function useCollectionItemMenu({
  readOnly,
  spacePath,
  projectPath,
  spaceId,
  refreshItems,
  openPeek,
  duplicateItem,
  requestItemDelete,
}: {
  readOnly: boolean;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  refreshItems: () => void;
  openPeek: (page: Page, options?: { focusTitle?: boolean }) => void;
  duplicateItem: (page: Page) => Promise<void>;
  requestItemDelete: (page: Page) => void;
}): CollectionItemMenu {
  const activeRootId = useSpace((state) => state.activeRootId);
  const spaceName = useSpaceNames();
  const handleError = (error: unknown) =>
    handleStructuralError(error, spaceName(spacePath));
  const operations = usePageContentOperations({
    spacePath,
    projectPath: projectPath ?? null,
    spaceId,
  });

  const mutate = (operation: () => Promise<void>) => () => {
    if (readOnly) return;
    void operation().then(refreshItems).catch(handleError);
  };

  /** A nested Collection takes its new item the same way. */
  const nestPage = (item: Page) =>
    mutate(async () => {
      const { childPage } = await operations.nestPage(item);
      openPeek(childPage);
    });

  return {
    readOnly,
    spacePath,
    pinItem: (item) => pageNavigationItem(item, spaceId, activeRootId),
    handlers: (item) => ({
      "nest-page": nestPage(item),
      "new-item": nestPage(item),
      "new-folder": mutate(async () => {
        await operations.newFolder(item);
      }),
      "make-collection": mutate(async () => {
        await operations.makeCollection(item);
      }),
      "make-leaf": mutate(async () => {
        await operations.makeLeaf(item);
      }),
      rename: () => {
        if (!readOnly) openPeek(item, { focusTitle: true });
      },
      duplicate: () => {
        if (!readOnly) void duplicateItem(item).catch(handleError);
      },
      delete: () => requestItemDelete(item),
    }),
  };
}
