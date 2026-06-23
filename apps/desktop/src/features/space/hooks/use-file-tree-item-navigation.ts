import type { TreeNode } from "../model/types";
import { useSpaceStore } from "../model";

type LoadTreeChildren = (
  spaceId: string,
  parentPath?: string | null,
) => Promise<void>;

interface UseFileTreeItemNavigationInput {
  node: TreeNode;
  spaceId: string;
  bareFolder: boolean;
  expanded: boolean;
  activeRootId: string | null;
  activeSpaceId: string | null;
  loadTreeChildren: LoadTreeChildren;
  onActivateContent?: () => void;
  openDocument: (path: string, spaceId: string) => void;
  toggleExpanded: (spaceId: string, path: string) => void;
}

export function useFileTreeItemNavigation({
  node,
  spaceId,
  bareFolder,
  expanded,
  activeRootId,
  activeSpaceId,
  loadTreeChildren,
  onActivateContent,
  openDocument,
  toggleExpanded,
}: UseFileTreeItemNavigationInput) {
  function activateDocumentNode() {
    onActivateContent?.();
    const isRootWorkspace = spaceId === activeRootId;
    if (isRootWorkspace && activeSpaceId) {
      useSpaceStore.getState().clearActiveSpace();
    } else if (!isRootWorkspace && activeSpaceId !== spaceId) {
      void useSpaceStore.getState().openSpace(spaceId);
    }
    openDocument(node.path, spaceId);
  }

  function handleDocumentClick() {
    if (node.has_schema) {
      activateDocumentNode();
      return;
    }
    if (bareFolder) {
      if (!expanded) void loadTreeChildren(spaceId, node.path);
      toggleExpanded(spaceId, node.path);
      return;
    }
    activateDocumentNode();
  }

  function handleNodeOpenChange(open: boolean) {
    if (open) void loadTreeChildren(spaceId, node.path);
    toggleExpanded(spaceId, node.path);
  }

  return {
    handleDocumentClick,
    handleNodeOpenChange,
  };
}
