import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "@/features/entry";
import {
  convertTreeBareFolderToCollection,
  convertTreeDocumentToCollection,
  createTreeFolder,
  createTreePage,
  makeBareFolderDocument,
  resolveTreeChildTarget,
} from "../api/tree-entry-actions";
import type { SpaceInfo } from "../model";

interface UseFileTreeItemCreateInput {
  node: TreeNode;
  spaceId: string;
  space: SpaceInfo | undefined;
  bareFolder: boolean;
  activeRootPath: string | null;
  expandedPaths: Record<string, string[]>;
  openDocument: (path: string, spaceId: string) => void;
  reloadTreeParent: (
    spaceId: string,
    parentPath?: string | null,
  ) => Promise<void>;
  reloadTreePathParent: (spaceId: string, path: string) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
  toggleExpanded: (spaceId: string, path: string) => void;
}

export function useFileTreeItemCreate({
  node,
  spaceId,
  space,
  bareFolder,
  activeRootPath,
  expandedPaths,
  openDocument,
  reloadTreeParent,
  reloadTreePathParent,
  removeTreePath,
  toggleExpanded,
}: UseFileTreeItemCreateInput) {
  async function handleNewPage() {
    if (!space) return;
    try {
      const { parentPath, parentNodePath } = await resolveTreeChildTarget({
        spacePath: space.path,
        node,
        projectPath: activeRootPath,
      });
      const entry = await createTreePage({
        spacePath: space.path,
        parentPath,
        title: String(m.editor_untitled()),
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
      openDocument(entry.path, spaceId);
      toast.success(m.toast_page_created());
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakeDocument() {
    if (!space || !bareFolder) return;
    try {
      const readmePath = await makeBareFolderDocument({
        spacePath: space.path,
        folderPath: node.path,
        title: node.title,
        projectPath: activeRootPath,
      });
      await reloadTreePathParent(spaceId, node.path);
      await reloadTreeParent(spaceId, node.path);
      openDocument(readmePath, spaceId);
    } catch (err) {
      console.error("Failed to make document:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakeCollection() {
    if (!space || node.has_schema) return;
    try {
      if (bareFolder) {
        const entry = await convertTreeBareFolderToCollection({
          spacePath: space.path,
          folderPath: node.path,
          projectPath: activeRootPath,
        });
        await reloadTreePathParent(spaceId, node.path);
        await reloadTreeParent(spaceId, node.path);
        openDocument(entry.path, spaceId);
        return;
      }

      const readmeEntry = await convertTreeDocumentToCollection({
        spacePath: space.path,
        filePath: node.path,
        projectPath: activeRootPath,
      });
      await reloadTreePathParent(spaceId, node.path);
      await reloadTreeParent(
        spaceId,
        readmeEntry.path.replace(/\/readme\.md$/i, ""),
      );
      openDocument(readmeEntry.path, spaceId);
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
    handleMakeDocument,
    handleNewFolder,
    handleNewPage,
  };
}
