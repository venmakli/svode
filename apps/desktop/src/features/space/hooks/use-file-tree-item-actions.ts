import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useEntrySelectionStore, type TreeNode } from "@/features/entry";
import { useEditorStore } from "@/features/editor";
import {
  convertTreeBareFolderToCollection,
  convertTreeDocumentToCollection,
  createTreeFolder,
  createTreePage,
  deleteTreeEntry,
  getTreeEntryBacklinks,
  makeBareFolderDocument,
  renameTreeEntryPath,
  resolveTreeChildTarget,
  updateTreeEntryTitle,
  type BacklinkInfo,
} from "../api/tree-entry-actions";
import { treeNodeHasChildren, treeParentKeyForNode } from "../lib/tree-cache";
import { useSpaceStore } from "../model";

type LoadTreeChildren = (
  spaceId: string,
  parentPath?: string | null,
) => Promise<void>;

interface UseFileTreeItemActionsInput {
  node: TreeNode;
  spaceId: string;
  loadTreeChildren: LoadTreeChildren;
}

export interface FileTreeDeleteDialogState {
  open: boolean;
  backlinks: BacklinkInfo[];
}

function isBareFolder(node: TreeNode): boolean {
  return !node.path.endsWith(".md");
}

export function useFileTreeItemActions({
  node,
  spaceId,
  loadTreeChildren,
}: UseFileTreeItemActionsInput) {
  const { openDocument, activeDocument } = useEntrySelectionStore();
  const { unsavedChanges } = useEditorStore();
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
  const isActive = !bareFolder && activeDocument === node.path;
  const isUnsaved = !!unsavedChanges[node.path];
  const space =
    spaces.find((item) => item.id === spaceId) ??
    rootSpaces.find((item) => item.id === spaceId);
  const expanded = expandedPaths[spaceId]?.includes(node.path) ?? false;

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const [deleteDialog, setDeleteDialog] = useState<FileTreeDeleteDialogState>({
    open: false,
    backlinks: [],
  });

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  function backlinkLabel(backlink: BacklinkInfo): string {
    if (!backlink.sourceSpaceId) return backlink.sourcePath;
    const sourceSpace = [...rootSpaces, ...spaces].find(
      (item) => item.id === backlink.sourceSpaceId,
    );
    return sourceSpace
      ? `${sourceSpace.name} · ${backlink.sourcePath}`
      : backlink.sourcePath;
  }

  function handleStartRename() {
    setEditValue(node.title);
    setIsEditing(true);
  }

  async function handleRenameSubmit() {
    const newName = editValue.trim();
    if (!space || !newName || newName === node.title) {
      setIsEditing(false);
      return;
    }

    try {
      if (bareFolder) {
        const parent = node.path.includes("/")
          ? node.path.substring(0, node.path.lastIndexOf("/"))
          : "";
        const newPath = parent ? `${parent}/${newName}` : newName;
        const modifiedFiles = await renameTreeEntryPath({
          spacePath: space.path,
          from: node.path,
          to: newPath,
          projectPath: activeRootPath,
        });
        if (modifiedFiles.length > 0) {
          const editor = useEditorStore.getState();
          for (const file of modifiedFiles) editor.markStale(file);
          editor.suppressPaths(modifiedFiles);
        }
        removeTreePath(spaceId, node.path);
        await reloadTreeParents(spaceId, [parent]);
      } else {
        const entry = await updateTreeEntryTitle({
          spacePath: space.path,
          filePath: node.path,
          title: newName,
          projectPath: activeRootPath,
        });
        if (activeDocument === node.path) {
          useEditorStore.getState().requestRename(node.path, newName, null);
        }
        patchEntryTreeMeta(
          spaceId,
          node.path,
          newName,
          entry.meta.icon,
          entry.meta.description ?? null,
        );
      }
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(m.toast_error());
    }
    setIsEditing(false);
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleRenameSubmit();
    } else if (event.key === "Escape") {
      setIsEditing(false);
    }
  }

  function activateDocumentNode() {
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

  async function handleDeleteRequest() {
    if (!space) return;
    try {
      const backlinks = await getTreeEntryBacklinks({
        spacePath: space.path,
        targetPath: node.path,
        projectPath: activeRootPath ?? null,
      });
      setDeleteDialog({ open: true, backlinks });
    } catch {
      setDeleteDialog({ open: true, backlinks: [] });
    }
  }

  async function handleDeleteConfirm() {
    if (!space) return;
    setDeleteDialog({ open: false, backlinks: [] });
    try {
      await deleteTreeEntry({
        spacePath: space.path,
        path: node.path,
        projectPath: activeRootPath,
      });
      removeTreePath(spaceId, node.path);
      await reloadTreePathParent(spaceId, node.path);
    } catch (err) {
      console.error("Failed to delete entry:", err);
      toast.error(m.toast_error());
    }
  }

  function closeDeleteDialog() {
    setDeleteDialog({ open: false, backlinks: [] });
  }

  return {
    bareFolder,
    backlinkLabel,
    childLoading,
    closeDeleteDialog,
    deleteDialog,
    editRef: editRef as RefObject<HTMLInputElement>,
    editValue,
    expandable,
    expanded,
    handleDeleteConfirm,
    handleDeleteRequest,
    handleDocumentClick,
    handleMakeCollection,
    handleMakeDocument,
    handleNewFolder,
    handleNewPage,
    handleNodeOpenChange,
    handleRenameKeyDown,
    handleRenameSubmit,
    handleStartRename,
    isActive,
    isEditing,
    isUnsaved,
    knownChildren,
    setEditValue,
    space,
  };
}
