import { useShallow } from "zustand/shallow";
import { useOpenScopeOwner } from "@/features/artifact";
import { pathNavigationKey, type NavigationItem } from "@/features/navigation";
import { useOpenPage } from "@/features/page/navigation";
import type { TreeNode } from "../model/types";
import { useEditorFilePendingWrite } from "@/features/editor/file-tree-sync";
import { treeNodeHasChildren } from "../lib/tree-cache";
import { isBareFolderNode } from "../lib/file-tree-rows";
import { useSpaceStore } from "../model";
import { useFileTreeItemCreate } from "./use-file-tree-item-create";
import { useFileTreeItemDelete } from "./use-file-tree-item-delete";
import { useFileTreeItemNavigation } from "./use-file-tree-item-navigation";
import { useFileTreeItemRename } from "./use-file-tree-item-rename";

type LoadTreeChildren = (
  spaceId: string,
  parentPath?: string | null,
) => Promise<void>;

interface UseFileTreeItemActionsInput {
  node: TreeNode;
  spaceId: string;
  expanded: boolean;
  loadTreeChildren: LoadTreeChildren;
  onActivateContent?: () => void;
  onBeforeNavigation?: () => Promise<boolean>;
}

/** How a tree node is pinned; a bare folder is not a pinnable object. */
function treeNodeNavigationItem(
  node: TreeNode,
  spaceId: string,
  rootSpaceId: string | null,
): NavigationItem | null {
  const kind = node.has_schema
    ? "collection"
    : node.kind === "app" || node.has_app
      ? "app"
      : isBareFolderNode(node)
        ? null
        : "page";
  if (!kind) return null;
  return {
    key: pathNavigationKey(kind, node.path, spaceId, rootSpaceId),
    title: node.title,
    ...(node.icon ? { icon: node.icon } : {}),
  };
}

export function useFileTreeItemActions({
  node,
  spaceId,
  expanded,
  loadTreeChildren,
  onActivateContent,
  onBeforeNavigation,
}: UseFileTreeItemActionsInput) {
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const openCollectionOwner = (path: string, targetSpaceId: string) =>
    openScopeOwner(
      { kind: "collection", path, spaceId: targetSpaceId },
      { fromSidebar: true },
    );
  const openAppOwner = (path: string, targetSpaceId: string) =>
    openScopeOwner(
      { kind: "app-directory", path, spaceId: targetSpaceId },
      { fromSidebar: true },
    );
  const openTreePage = (path: string, targetSpaceId: string) =>
    openPage(path, targetSpaceId, { fromSidebar: true });
  // A row reads only what it shows; the rest of the store is read when an
  // action runs, so unrelated store updates do not render the row.
  const {
    toggleExpanded,
    reloadTreeParent,
    reloadTreeParents,
    reloadTreePathParent,
    reloadTreePathParents,
    patchPageTreeMeta,
    removeTreePath,
    activeRootId,
    activeRootPath,
  } = useSpaceStore(
    useShallow((state) => ({
      toggleExpanded: state.toggleExpanded,
      reloadTreeParent: state.reloadTreeParent,
      reloadTreeParents: state.reloadTreeParents,
      reloadTreePathParent: state.reloadTreePathParent,
      reloadTreePathParents: state.reloadTreePathParents,
      patchPageTreeMeta: state.patchPageTreeMeta,
      removeTreePath: state.removeTreePath,
      activeRootId: state.activeRootId,
      activeRootPath: state.activeRootPath,
    })),
  );
  const space = useSpaceStore(
    (state) =>
      state.spaces.find((item) => item.id === spaceId) ??
      state.rootSpaces.find((item) => item.id === spaceId),
  );

  const spacePath =
    space?.path ?? (spaceId === activeRootId ? activeRootPath : null);
  const bareFolder = isBareFolderNode(node);
  const knownChildren = treeNodeHasChildren(node);
  const isUnsaved = useEditorFilePendingWrite(spacePath, node.path);

  const rename = useFileTreeItemRename({
    node,
    spaceId,
    space,
    bareFolder,
    activeRootPath,
    reloadTreeParents,
    patchPageTreeMeta,
    removeTreePath,
  });

  const creation = useFileTreeItemCreate({
    node,
    spaceId,
    space,
    bareFolder,
    activeRootPath,
    openPage,
    openCollectionOwner,
    reloadTreeParent,
    reloadTreePathParent,
    reloadTreePathParents,
    removeTreePath,
    toggleExpanded,
    onBeforeNavigation,
  });

  const deletion = useFileTreeItemDelete({
    node,
    spaceId,
    space,
    activeRootPath,
    reloadTreePathParent,
    removeTreePath,
  });

  const navigation = useFileTreeItemNavigation({
    node,
    spaceId,
    bareFolder,
    expanded,
    loadTreeChildren,
    onActivateContent,
    onBeforeNavigation,
    openPage: openTreePage,
    openCollectionOwner,
    openAppOwner,
    toggleExpanded,
  });

  return {
    bareFolder,
    pinItem: treeNodeNavigationItem(node, spaceId, activeRootId),
    cancelDelete: deletion.cancelDelete,
    deleteConfirmation: deletion.deleteConfirmation,
    editRef: rename.editRef,
    editValue: rename.editValue,
    handleDeleteConfirm: deletion.handleDeleteConfirm,
    handleDeleteRequest: deletion.handleDeleteRequest,
    handleDuplicate: creation.handleDuplicate,
    handlePageClick: navigation.handlePageClick,
    handleMakeCollection: creation.handleMakeCollection,
    handleMakeLeaf: creation.handleMakeLeaf,
    handleMakePage: creation.handleMakePage,
    handleNewFolder: creation.handleNewFolder,
    handleNewPage: creation.handleNewPage,
    handleNodeOpenChange: navigation.handleNodeOpenChange,
    handleRenameKeyDown: rename.handleRenameKeyDown,
    handleRenameSubmit: rename.handleRenameSubmit,
    handleStartRename: rename.handleStartRename,
    isEditing: rename.isEditing,
    renameConflictPath: rename.renameConflictPath,
    isUnsaved,
    knownChildren,
    setEditValue: rename.setEditValue,
    space,
  };
}
