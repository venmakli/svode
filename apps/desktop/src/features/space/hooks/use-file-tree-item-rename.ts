import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { TreeNode } from "../model/types";
import {
  markEditorFilesStale,
  requestEditorFileRename,
  suppressEditorFileEvents,
} from "@/features/editor/file-tree-sync";
import {
  renameTreeEntryPath,
  updateTreeEntryTitle,
} from "../api/tree-entry-actions";
import type { SpaceInfo } from "../model";
import {
  documentNameConflictFromError,
  findDocumentNameConflictPath,
} from "@/features/entry/entry-api";

interface UseFileTreeItemRenameInput {
  node: TreeNode;
  spaceId: string;
  space: SpaceInfo | undefined;
  bareFolder: boolean;
  activeRootPath: string | null;
  activeDocument: string | null;
  activeDocumentSpaceId: string | null;
  reloadTreeParents: (
    spaceId: string,
    parentPaths: Array<string | null | undefined>,
  ) => Promise<void>;
  patchEntryTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description?: string | null,
  ) => void;
  removeTreePath: (spaceId: string, path: string) => void;
  siblingRows: readonly TreeNode[];
}

export function useFileTreeItemRename({
  node,
  spaceId,
  space,
  bareFolder,
  activeRootPath,
  activeDocument,
  activeDocumentSpaceId,
  reloadTreeParents,
  patchEntryTreeMeta,
  removeTreePath,
  siblingRows,
}: UseFileTreeItemRenameInput) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [renameConflictPath, setRenameConflictPath] = useState<string | null>(
    null,
  );
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  function handleStartRename() {
    setEditValue(node.title);
    setRenameConflictPath(null);
    setIsEditing(true);
  }

  async function handleRenameSubmit() {
    const newName = editValue;
    if (!space || !newName.trim() || newName === node.title) {
      setIsEditing(false);
      return;
    }

    if (!bareFolder) {
      const conflictPath = findDocumentNameConflictPath(
        newName,
        siblingRows,
        node.path,
      );
      if (conflictPath) {
        setRenameConflictPath(conflictPath);
        requestAnimationFrame(() => {
          editRef.current?.focus();
          editRef.current?.select();
        });
        return;
      }
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
          markEditorFilesStale(space.path, modifiedFiles);
          suppressEditorFileEvents(space.path, modifiedFiles);
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
        if (activeDocument === node.path && activeDocumentSpaceId === spaceId) {
          requestEditorFileRename(space.path, node.path, newName, null);
        }
        patchEntryTreeMeta(
          spaceId,
          node.path,
          newName,
          entry.meta.icon,
          entry.meta.description ?? null,
        );
        const parent = node.path.toLowerCase().endsWith("/readme.md")
          ? node.path.split("/").slice(0, -2).join("/")
          : node.path.split("/").slice(0, -1).join("/");
        await reloadTreeParents(spaceId, [parent]);
      }
    } catch (err) {
      const conflict = documentNameConflictFromError(err);
      if (conflict) {
        setRenameConflictPath(conflict.conflicts[0]?.path ?? null);
        requestAnimationFrame(() => {
          editRef.current?.focus();
          editRef.current?.select();
        });
        return;
      }
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

  return {
    editRef: editRef as RefObject<HTMLInputElement>,
    editValue,
    handleRenameKeyDown,
    handleRenameSubmit,
    handleStartRename,
    isEditing,
    renameConflictPath,
    setEditValue,
  };
}
