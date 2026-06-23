import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  convertEntryToFolder as convertEntryToFolderApi,
  createEntry as createEntryApi,
  deleteEntry as deleteEntryApi,
  duplicateEntry as duplicateEntryApi,
} from "@/features/entry/entry-api";
import type { Entry } from "@/features/entry";
import type { CollectionSchema } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { instantiateTemplate } from "../api";
import { useCollectionEntryEvents } from "./use-collection-entry-events";

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
  openDocument,
}: {
  schema: CollectionSchema | null;
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  spaceId: string;
  openDocument: (path: string, spaceId: string) => void;
}) {
  const {
    reloadTreeParent,
    reloadTreePathParent,
    removeTreePath,
  } = useSpaceTreeSync();
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const refreshEntries = useCallback(() => {
    setEntriesVersion((version) => version + 1);
  }, []);

  useCollectionEntryEvents(refreshEntries);

  async function createEntry(
    asFolder = false,
    title: string = String(m.editor_untitled()),
    openAfterCreate = true,
    contextualDefaults?: Record<string, unknown>,
  ) {
    const defaultTemplateSlug = schema?.templates?.default ?? null;
    if (defaultTemplateSlug) {
      try {
        const created = await instantiateTemplate({
          spacePath,
          collectionPath,
          templateSlug: defaultTemplateSlug,
          parentDir: collectionPath,
          initialTitle: title,
          forceFolder: asFolder,
          contextualDefaults: contextualDefaults ?? null,
          projectPath,
        });
        refreshEntries();
        await reloadTreeParent(spaceId, collectionPath);
        if (openAfterCreate) {
          openDocument(created.path, spaceId);
        }
        return created;
      } catch (error) {
        if (!isMissingTemplateError(error)) throw error;
        toast.warning(m.collection_default_template_missing());
        console.warn("Failed to instantiate default template:", error);
      }
    }

    const created = await createEntryApi({
      spacePath,
      parentPath: collectionPath,
      title,
      contextualDefaults: contextualDefaults ?? null,
      projectPath: projectPath ?? null,
    });
    let nextEntry = created;
    if (asFolder) {
      nextEntry = await convertEntryToFolderApi({
        spacePath,
        filePath: created.path,
        projectPath: projectPath ?? null,
      });
    }
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    if (openAfterCreate) {
      openDocument(nextEntry.path, spaceId);
    }
    return nextEntry;
  }

  async function duplicateRow(entryToDuplicate: Entry) {
    const duplicated = await duplicateEntryApi({
      spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    refreshEntries();
    await reloadTreeParent(spaceId, collectionPath);
    openDocument(duplicated.path, spaceId);
  }

  async function deleteRow(entryToDelete: Entry) {
    await deleteEntryApi({
      spacePath,
      path: entryToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeleteEntry(null);
    refreshEntries();
    removeTreePath(spaceId, entryToDelete.path);
    await reloadTreePathParent(spaceId, entryToDelete.path);
  }

  async function duplicateDetailEntry(entryToDuplicate: Entry) {
    const duplicated = await duplicateEntryApi({
      spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParent(spaceId, duplicated.path);
    openDocument(duplicated.path, spaceId);
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
