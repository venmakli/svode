import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { createCollection } from "@/features/collection";
import { useEntrySelectionStore } from "@/features/entry";
import { createTreeFolder } from "../api/tree-entry-actions";
import { useSpaceActions } from "./use-space-actions";
import { useSpaceStore } from "../model";

export function useRootDocumentActions() {
  const {
    activeRootId,
    activeRootPath,
    fileTrees,
    reloadTreeParent,
    loadTreeChildren,
  } = useSpaceStore();
  const { createEntry } = useSpaceActions();
  const { openDocument } = useEntrySelectionStore();
  const tree = activeRootId ? (fileTrees[activeRootId] ?? []) : [];

  const handleNewPage = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    try {
      const entry = await createEntry(activeRootPath, "Untitled");
      if (entry) {
        openDocument(entry.path, activeRootId);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }, [activeRootId, activeRootPath, createEntry, openDocument]);

  const handleNewFolder = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    try {
      await createTreeFolder({
        spacePath: activeRootPath,
        parentPath: null,
        name: m.space_new_folder(),
        projectPath: activeRootPath,
      });
      await reloadTreeParent(activeRootId, null);
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }, [activeRootId, activeRootPath, reloadTreeParent]);

  const handleNewCollection = useCallback(async () => {
    if (!activeRootId || !activeRootPath) return;
    try {
      const entry = await createCollection({
        spacePath: activeRootPath,
        title: m.editor_untitled(),
        projectPath: activeRootPath,
      });
      await reloadTreeParent(activeRootId, null);
      openDocument(entry.path, activeRootId);
    } catch (err) {
      console.error("Failed to create collection:", err);
      toast.error(m.toast_error());
    }
  }, [activeRootId, activeRootPath, openDocument, reloadTreeParent]);

  return {
    activeRootId,
    activeRootPath,
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
    loadTreeChildren,
    tree,
  };
}
