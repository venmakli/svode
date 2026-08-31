import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { createCollection } from "@/features/collection";
import { useOpenScopeOwner } from "@/features/artifact";
import { publishPageFilenameWarnings } from "@/features/page";
import { useOpenPage } from "@/features/page/navigation";
import { createTreeFolder } from "../api/content-tree-actions";
import { useSpaceActions } from "./use-space-actions";

export type ScopeTarget = { id: string; path: string };

interface UseSpaceScopeActionsInput {
  activeRootPath: string | null;
  onActivateContent: () => void;
  onBeforeNavigation?: () => Promise<boolean>;
  reloadTreeParent: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
}

export function useSpaceScopeActions({
  activeRootPath,
  onActivateContent,
  onBeforeNavigation,
  reloadTreeParent,
}: UseSpaceScopeActionsInput) {
  const { createPage } = useSpaceActions();
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();

  const handleNewPage = useCallback(
    async (scope: ScopeTarget) => {
      if (onBeforeNavigation && !(await onBeforeNavigation())) return;
      try {
        const page = await createPage(
          scope.path,
          String(m.editor_untitled()),
        );
        if (page) {
          publishPageFilenameWarnings(page.warnings);
          onActivateContent();
          openPage(page.path, scope.id);
        }
      } catch (err) {
        console.error("Failed to create page:", err);
        toast.error(m.toast_error());
      }
    },
    [createPage, onActivateContent, onBeforeNavigation, openPage],
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
      if (onBeforeNavigation && !(await onBeforeNavigation())) return;

      try {
        const page = await createCollection({
          spacePath: scope.path,
          title: m.editor_untitled(),
          projectPath: activeRootPath,
        });
        publishPageFilenameWarnings(page.warnings);
        await reloadTreeParent(scope.id, null);
        onActivateContent();
        openScopeOwner({
          kind: "collection",
          path: page.path,
          spaceId: scope.id,
        });
      } catch (err) {
        console.error("Failed to create collection:", err);
        toast.error(m.toast_error());
      }
    },
    [
      activeRootPath,
      onActivateContent,
      onBeforeNavigation,
      openScopeOwner,
      reloadTreeParent,
    ],
  );

  return {
    handleNewCollection,
    handleNewFolder,
    handleNewPage,
  };
}
