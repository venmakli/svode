import { useEntrySelectionStore } from "@/features/entry/selection";
import type { TreeNode } from "@/features/entry";
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
}

function isBareFolder(node: TreeNode): boolean {
  return !node.path.endsWith(".md");
}

export function useFileTreeItemActions({
  node,
  spaceId,
  loadTreeChildren,
  onActivateContent,
}: UseFileTreeItemActionsInput) {
  const { openDocument, activeDocument, activeDocumentSpaceId } =
    useEntrySelectionStore();
  const isUnsaved = useEditorFilePendingWrite(node.path);
  const {
    expandedPaths,
    treeParentLoading,
    toggleExpanded,
    reloadTreeParent,
    reloadTreeParents,
    reloadTreePathParent,
    patchEntryTreeMeta,
    removeTreePath,
    spaces,
    rootSpaces,
    activeSpaceId,
    activeRootId,
    activeRootPath,
  } = useSpaceStore();

  const bareFolder = isBareFolder(node);
  const knownChildren = treeNodeHasChildren(node);
  const expandable = bareFolder || knownChildren;
  const childParentKey = treeParentKeyForNode(node);
  const childLoading = childParentKey
    ? (treeParentLoading[spaceId]?.[childParentKey] ?? false)
    : false;
  const isActive =
    !bareFolder &&
    activeDocument === node.path &&
    activeDocumentSpaceId === spaceId;
  const space =
    spaces.find((item) => item.id === spaceId) ??
    rootSpaces.find((item) => item.id === spaceId);
  const expanded = expandedPaths[spaceId]?.includes(node.path) ?? false;

  const rename = useFileTreeItemRename({
    node,
    spaceId,
    space,
    bareFolder,
    activeRootPath,
    activeDocument,
    reloadTreeParents,
    patchEntryTreeMeta,
    removeTreePath,
  });

  const creation = useFileTreeItemCreate({
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
    openDocument,
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
    handleDocumentClick: navigation.handleDocumentClick,
    handleMakeCollection: creation.handleMakeCollection,
    handleMakeDocument: creation.handleMakeDocument,
    handleNewFolder: creation.handleNewFolder,
    handleNewPage: creation.handleNewPage,
    handleNodeOpenChange: navigation.handleNodeOpenChange,
    handleRenameKeyDown: rename.handleRenameKeyDown,
    handleRenameSubmit: rename.handleRenameSubmit,
    handleStartRename: rename.handleStartRename,
    isActive,
    isEditing: rename.isEditing,
    isUnsaved,
    knownChildren,
    setEditValue: rename.setEditValue,
    space,
  };
}
