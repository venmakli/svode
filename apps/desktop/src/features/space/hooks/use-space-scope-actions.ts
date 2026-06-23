import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { createCollection } from "@/features/collection";
import { useOpenEntryDocument } from "@/features/entry/selection";
import { createTreeFolder } from "../api/tree-entry-actions";
import { useSpaceActions } from "./use-space-actions";

export type ScopeTarget = { id: string; path: string };

interface UseSpaceScopeActionsInput {
  activeRootPath: string | null;
  onActivateContent: () => void;
  reloadTreeParent: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
}

export function useSpaceScopeActions({
  activeRootPath,
  onActivateContent,
  reloadTreeParent,
}: UseSpaceScopeActionsInput) {
  const { createEntry } = useSpaceActions();
  const openDocument = useOpenEntryDocument();

  const handleNewPage = useCallback(
    async (scope: ScopeTarget) => {
      try {
        const entry = await createEntry(scope.path, "Untitled");
        if (entry) {
          onActivateContent();
          openDocument(entry.path, scope.id);
        }
      } catch (err) {
        console.error("Failed to create page:", err);
        toast.error(m.toast_error());
      }
    },
    [createEntry, onActivateContent, openDocument],
  );

  const handleNewFolder = useCallback(
    async (scope: ScopeTarget) => {
      if (!activeRootPath) return;

      try {
        await createTreeFolder({
          spacePath: scope.path,
          parentPath: null,
          name: m.space_new_folder(),
          projectPath: activeRootPath,
        });
        await reloadTreeParent(scope.id, null);
      } catch (err) {
        console.error("Failed to create folder:", err);
        toast.error(m.toast_error());
      }
    },
    [activeRootPath, reloadTreeParent],
  );

  const handleNewCollection = useCallback(
    async (scope: ScopeTarget) => {
      if (!activeRootPath) return;

      try {
        const entry = await createCollection({
          spacePath: scope.path,
          title: m.editor_untitled(),
          projectPath: activeRootPath,
        });
        await reloadTreeParent(scope.id, null);
        onActivateContent();
        openDocument(entry.path, scope.id);
      } catch (err) {
        console.error("Failed to create collection:", err);
        toast.error(m.toast_error());
      }
    },
    [activeRootPath, onActivateContent, openDocument, reloadTreeParent],
  );

  return {
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
  };
}
