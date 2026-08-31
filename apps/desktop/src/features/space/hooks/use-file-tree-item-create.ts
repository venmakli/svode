import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { publishPageFilenameWarnings } from "@/features/page";
import type { TreeNode } from "../model/types";
import {
  convertTreeBareFolderToCollection,
  convertTreePageToCollection,
  createTreeFolder,
  createTreePage,
  createBareFolderPage,
  resolveTreeChildTarget,
} from "../api/content-tree-actions";
import type { SpaceInfo } from "../model";

interface UseFileTreeItemCreateInput {
  node: TreeNode;
  spaceId: string;
  space: SpaceInfo | undefined;
  bareFolder: boolean;
  activeRootPath: string | null;
  expandedPaths: Record<string, string[]>;
  openPage: (path: string, spaceId: string) => void;
  openCollectionOwner: (path: string, spaceId: string) => void;
  reloadTreeParent: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  reloadTreePathParent: (spaceId: string, path: string) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
  toggleExpanded: (spaceId: string, path: string) => void;
  onBeforeNavigation?: () => Promise<boolean>;
}

export function useFileTreeItemCreate({
  node,
  spaceId,
  space,
  bareFolder,
  activeRootPath,
  expandedPaths,
  openPage,
  openCollectionOwner,
  reloadTreeParent,
  reloadTreePathParent,
  removeTreePath,
  toggleExpanded,
  onBeforeNavigation,
}: UseFileTreeItemCreateInput) {
  async function handleNewPage() {
    if (!space) return;
    if (onBeforeNavigation && !(await onBeforeNavigation())) return;
    try {
      const { parentPath, parentNodePath } = await resolveTreeChildTarget({
        spacePath: space.path,
        node,
        projectPath: activeRootPath,
      });
      const page = await createTreePage({
        spacePath: space.path,
        parentPath,
        title: String(m.editor_untitled()),
        projectPath: activeRootPath,
      });
      publishPageFilenameWarnings(page.warnings);
      if (parentNodePath !== node.path) {
        removeTreePath(spaceId, node.path);
        await reloadTreePathParent(spaceId, node.path);
      }
      await reloadTreeParent(spaceId, parentPath);
      if (!expandedPaths[spaceId]?.includes(parentNodePath)) {
        toggleExpanded(spaceId, parentNodePath);
      }
      openPage(page.path, spaceId);
      toast.success(m.toast_page_created());
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakePage() {
    if (!space || !bareFolder) return;
    if (onBeforeNavigation && !(await onBeforeNavigation())) return;
    try {
      const readmePath = await createBareFolderPage({
        spacePath: space.path,
        folderPath: node.path,
        title: node.title,
        projectPath: activeRootPath,
      });
      await reloadTreePathParent(spaceId, node.path);
      await reloadTreeParent(spaceId, node.path);
      openPage(readmePath, spaceId);
    } catch (err) {
      console.error("Failed to make page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakeCollection() {
    if (!space || node.has_schema) return;
    if (onBeforeNavigation && !(await onBeforeNavigation())) return;
    try {
      if (bareFolder) {
        const ownerPage = await convertTreeBareFolderToCollection({
          spacePath: space.path,
          folderPath: node.path,
          projectPath: activeRootPath,
        });
        await reloadTreePathParent(spaceId, node.path);
        await reloadTreeParent(spaceId, node.path);
        openCollectionOwner(ownerPage.path, spaceId);
        return;
      }

      const readmePage = await convertTreePageToCollection({
        spacePath: space.path,
        filePath: node.path,
        projectPath: activeRootPath,
      });
      await reloadTreePathParent(spaceId, node.path);
      await reloadTreeParent(
        spaceId,
        readmePage.path.replace(/\/readme\.md$/i, ""),
      );
      openCollectionOwner(readmePage.path, spaceId);
    } catch (err) {
      console.error("Failed to make collection:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewFolder() {
    if (!space) return;
    try {
      const { parentPath, parentNodePath } = await resolveTreeChildTarget({
        spacePath: space.path,
        node,
        projectPath: activeRootPath,
      });
      await createTreeFolder({
        spacePath: space.path,
        parentPath,
        name: m.space_new_folder(),
        projectPath: activeRootPath,
      });
      if (parentNodePath !== node.path) {
        removeTreePath(spaceId, node.path);
        await reloadTreePathParent(spaceId, node.path);
      }
      await reloadTreeParent(spaceId, parentPath);
      if (!expandedPaths[spaceId]?.includes(parentNodePath)) {
        toggleExpanded(spaceId, parentNodePath);
      }
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  return {
    handleMakeCollection,
    handleMakePage,
    handleNewFolder,
    handleNewPage,
  };
}
