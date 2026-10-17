import { useSpaceTreeSync } from "@/features/space";
import {
  convertPageToFolder,
  convertPageToLeaf,
  convertPageToNestedCollection,
  createPage,
  createPageFolder,
} from "../api/page-api";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import { normalizePagePath } from "../lib/path";
import type { Page } from "../model";
import * as m from "@/paraglide/messages.js";

function readmeFolderPath(path: string): string {
  return normalizePagePath(path).replace(/\/readme\.md$/i, "");
}

function isFolderPage(path: string): boolean {
  return normalizePagePath(path).toLowerCase().endsWith("/readme.md");
}

/**
 * The structural operations of a Page's action menu, wherever the menu is
 * open, with the content tree reloaded around what they change. A leaf Page
 * first becomes a folder Page to take children.
 */
export function usePageContentOperations({
  spacePath,
  projectPath,
  spaceId,
}: {
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
}) {
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );

  /** The folder children go in; `folderPage` is set when a leaf became one. */
  async function childFolder(page: Page) {
    if (isFolderPage(page.path)) {
      return { folderPage: null, folderPath: readmeFolderPath(page.path) };
    }
    const folderPage = await convertPageToFolder({
      spacePath,
      filePath: page.path,
      projectPath,
    });
    await reloadTreePathParents(spaceId, [page.path, folderPage.path]);
    return { folderPage, folderPath: readmeFolderPath(folderPage.path) };
  }

  async function nestPage(page: Page) {
    const { folderPage, folderPath } = await childFolder(page);
    const childPage = await createPage({
      spacePath,
      parentPath: folderPath,
      title: String(m.editor_untitled()),
      allocateUniqueTitle: true,
      contextualDefaults: null,
      projectPath,
    });
    publishPageFilenameWarnings(childPage.warnings);
    await reloadTreeParent(spaceId, folderPath);
    return { childPage, folderPage };
  }

  async function newFolder(page: Page) {
    const { folderPage, folderPath } = await childFolder(page);
    await createPageFolder({
      spacePath,
      parentPath: folderPath,
      name: m.space_new_folder(),
      projectPath,
    });
    await reloadTreeParent(spaceId, folderPath);
    return { folderPage };
  }

  async function makeLeaf(page: Page) {
    const leaf = await convertPageToLeaf({
      spacePath,
      filePath: page.path,
      projectPath,
    });
    await reloadTreePathParents(spaceId, [page.path, leaf.path]);
    return leaf;
  }

  async function makeCollection(page: Page) {
    const next = await convertPageToNestedCollection({
      spacePath,
      filePath: page.path,
      projectPath,
    });
    await reloadTreePathParents(spaceId, [page.path, next.path]);
    return next;
  }

  return { nestPage, newFolder, makeLeaf, makeCollection };
}
