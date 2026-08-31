import {
  useActiveContentPath,
  useActiveContentSpaceId,
  useOpenScopeOwner,
} from "@/features/artifact";
import { useOpenPage } from "@/features/page/navigation";
import type { TreeNode } from "../model/types";
import { useEditorFilePendingWrite } from "@/features/editor/file-tree-sync";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";
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
  loadTreeChildren: LoadTreeChildren;
  onActivateContent?: () => void;
  onBeforeNavigation?: () => Promise<boolean>;
}

function isBareFolder(node: TreeNode): boolean {
  return !node.path.endsWith(".md");
}

export function useFileTreeItemActions({
  node,
  spaceId,
  loadTreeChildren,
  onActivateContent,
  onBeforeNavigation,
}: UseFileTreeItemActionsInput) {
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const openCollectionOwner = (path: string, targetSpaceId: string) =>
    openScopeOwner({
      kind: "collection",
      path,
      spaceId: targetSpaceId,
    });
  const activeContentPath = useActiveContentPath();
  const activeContentSpaceId = useActiveContentSpaceId();
  const {
    expandedPaths,
    treeParentLoading,
    toggleExpanded,
    reloadTreeParent,
    reloadTreeParents,
    reloadTreePathParent,
    patchPageTreeMeta,
    removeTreePath,
    spaces,
    rootSpaces,
    activeSpaceId,
    activeRootId,
    activeRootPath,
    childrenByParentPath,
  } = useSpaceStore();

  const space =
    spaces.find((item) => item.id === spaceId) ??
    rootSpaces.find((item) => item.id === spaceId);
  const spacePath =
    space?.path ?? (spaceId === activeRootId ? activeRootPath : null);
  const bareFolder = isBareFolder(node);
  const knownChildren = treeNodeHasChildren(node);
  const expandable = bareFolder || knownChildren;
  const childParentKey = treeParentKeyForNode(node);
  const childLoading = childParentKey
    ? (treeParentLoading[spaceId]?.[childParentKey] ?? false)
    : false;
  const isUnsaved = useEditorFilePendingWrite(spacePath, node.path);
  const isActive =
    !bareFolder &&
    activeContentPath === node.path &&
    activeContentSpaceId === spaceId;
  const expanded = expandedPaths[spaceId]?.includes(node.path) ?? false;

  const rename = useFileTreeItemRename({
    node,
    spaceId,
    space,
    bareFolder,
    activeRootPath,
    reloadTreeParents,
    patchPageTreeMeta,
    removeTreePath,
    siblingRows:
      childrenByParentPath[spaceId]?.[
        node.path.toLowerCase().endsWith("/readme.md")
          ? node.path.split("/").slice(0, -2).join("/")
          : node.path.split("/").slice(0, -1).join("/")
      ] ?? [],
  });

  const creation = useFileTreeItemCreate({
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
  });

  const deletion = useFileTreeItemDelete({
    node,
    spaceId,
    space,
    activeRootPath,
    rootSpaces,
    spaces,
    reloadTreePathParent,
    removeTreePath,
  });

  const navigation = useFileTreeItemNavigation({
    node,
    spaceId,
    bareFolder,
    expanded,
    activeRootId,
    activeSpaceId,
    loadTreeChildren,
    onActivateContent,
    onBeforeNavigation,
    openPage,
    openCollectionOwner,
    toggleExpanded,
  });

  return {
    bareFolder,
    backlinkLabel: deletion.backlinkLabel,
    childLoading,
    closeDeleteDialog: deletion.closeDeleteDialog,
    deleteDialog: deletion.deleteDialog,
    editRef: rename.editRef,
    editValue: rename.editValue,
    expandable,
    expanded,
    handleDeleteConfirm: deletion.handleDeleteConfirm,
    handleDeleteRequest: deletion.handleDeleteRequest,
    handlePageClick: navigation.handlePageClick,
    handleMakeCollection: creation.handleMakeCollection,
    handleMakePage: creation.handleMakePage,
    handleNewFolder: creation.handleNewFolder,
    handleNewPage: creation.handleNewPage,
    handleNodeOpenChange: navigation.handleNodeOpenChange,
    handleRenameKeyDown: rename.handleRenameKeyDown,
    handleRenameSubmit: rename.handleRenameSubmit,
    handleStartRename: rename.handleStartRename,
    isActive,
    isEditing: rename.isEditing,
    renameConflictPath: rename.renameConflictPath,
    isUnsaved,
    knownChildren,
    setEditValue: rename.setEditValue,
    space,
  };
}
