import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  convertPageToFolder as convertPageToFolderApi,
  createPage as createPageApi,
  deletePage as deletePageApi,
  duplicatePage as duplicatePageApi,
} from "@/features/page/page-api";
import {
  publishPageFilenameWarnings,
  retargetPageFilenameWarnings,
  type Page,
} from "@/features/page";
import type { CollectionSchema } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { instantiateTemplate } from "../api";

function isMissingTemplateError(error: unknown) {
  const message = String(error).toLowerCase();
  return message.includes("not found") || message.includes("filenotfound");
}

export function useCollectionEntryActions({
  schema,
  spacePath,
  projectPath,
  collectionPath,
  spaceId,
  openPage,
}: {
  schema: CollectionSchema | null;
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  spaceId: string;
  openPage: (path: string, spaceId: string) => void;
}) {
  const { reloadTreeParent, reloadTreePathParent, removeTreePath } =
    useSpaceTreeSync();
  const [deleteEntry, setDeleteEntry] = useState<Page | null>(null);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const refreshEntries = useCallback(() => {
    setEntriesVersion((version) => version + 1);
  }, []);

  async function createEntry(
    asFolder = false,
    title?: string,
    openAfterCreate = true,
    contextualDefaults?: Record<string, unknown>,
  ) {
    const allocateUniqueTitle = title === undefined;
    const requestedTitle = title ?? String(m.editor_untitled());
    const defaultTemplateSlug = schema?.templates?.default ?? null;
    if (defaultTemplateSlug) {
      try {
        const created = await instantiateTemplate({
          spacePath,
          collectionPath,
          templateSlug: defaultTemplateSlug,
          parentDir: collectionPath,
          initialTitle: requestedTitle,
          allocateUniqueTitle,
          forceFolder: asFolder,
          contextualDefaults: contextualDefaults ?? null,
          projectPath,
        });
        publishPageFilenameWarnings(created.warnings);
        refreshEntries();
        await reloadTreeParent(spaceId, collectionPath);
        if (openAfterCreate) {
          openPage(created.path, spaceId);
        }
        return created;
      } catch (error) {
        if (!isMissingTemplateError(error)) throw error;
        toast.warning(m.collection_default_template_missing());
        console.warn("Failed to instantiate default template:", error);
      }
    }

    const created = await createPageApi({
      spacePath,
      parentPath: collectionPath,
      title: requestedTitle,
      allocateUniqueTitle,
      contextualDefaults: contextualDefaults ?? null,
      projectPath: projectPath ?? null,
    });
    let nextEntry = created;
    if (asFolder) {
      const converted = await convertPageToFolderApi({
        spacePath,
        filePath: created.path,
        projectPath: projectPath ?? null,
      });
      nextEntry = {
        ...converted,
        warnings: retargetPageFilenameWarnings(
          created.warnings,
          converted.path,
        ),
      };
    }
    publishPageFilenameWarnings(nextEntry.warnings);
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    if (openAfterCreate) {
      openPage(nextEntry.path, spaceId);
    }
    return nextEntry;
  }

  async function duplicateRow(entryToDuplicate: Page) {
    const duplicated = await duplicatePageApi({
      spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(duplicated.warnings);
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    openPage(duplicated.path, spaceId);
  }

  async function deleteRow(entryToDelete: Page) {
    await deletePageApi({
      spacePath,
      path: entryToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeleteEntry(null);
    refreshEntries();
    removeTreePath(spaceId, entryToDelete.path);
    await reloadTreePathParent(spaceId, entryToDelete.path);
  }

  async function duplicateDetailEntry(entryToDuplicate: Page) {
    const duplicated = await duplicatePageApi({
      spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(duplicated.warnings);
    await reloadTreePathParent(spaceId, duplicated.path);
    openPage(duplicated.path, spaceId);
  }

  return {
    deleteEntry,
    setDeleteEntry,
    entriesVersion,
    refreshEntries,
    createEntry,
    duplicateRow,
    deleteRow,
    duplicateDetailEntry,
  };
}
