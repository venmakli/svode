import { useEffect } from "react";
import type { PlateEditor } from "platejs/react";

import {
  deleteCachedDocumentValue,
  setCachedDocumentValue,
} from "../model/plate-document-cache";

interface MutableRef<T> {
  current: T;
}

interface PendingRename {
  path: string;
  title: string;
  newPath: string | null;
}

interface UseEditorPendingRenameInput {
  pendingRename: PendingRename | null;
  currentDocument: string | null;
  editor: PlateEditor | null;
  spacePath: string;
  activeWsId: string | null;
  titleRef: MutableRef<string>;
  iconRef: MutableRef<string | null>;
  descriptionRef: MutableRef<string>;
  clearPendingRename: () => void;
  clearUnsaved: (path: string) => void;
  setCurrentDocument: (path: string) => void;
  patchEntryTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description: string | null,
  ) => void;
  setTitle: (title: string) => void;
}

export function useEditorPendingRename({
  pendingRename,
  currentDocument,
  editor,
  spacePath,
  activeWsId,
  titleRef,
  iconRef,
  descriptionRef,
  clearPendingRename,
  clearUnsaved,
  setCurrentDocument,
  patchEntryTreeMeta,
  setTitle,
}: UseEditorPendingRenameInput) {
  useEffect(() => {
    if (!pendingRename || pendingRename.path !== currentDocument || !editor) {
      return;
    }

    const { title: newTitle, newPath } = pendingRename;
    clearPendingRename();

    titleRef.current = newTitle;
    queueMicrotask(() => setTitle(newTitle));

    if (newPath) {
      if (spacePath) {
        setCachedDocumentValue(spacePath, newPath, editor.children);
        deleteCachedDocumentValue(pendingRename.path, spacePath);
      }
      clearUnsaved(pendingRename.path);
      setCurrentDocument(newPath);
      return;
    }

    if (currentDocument && activeWsId) {
      patchEntryTreeMeta(
        activeWsId,
        currentDocument,
        newTitle,
        iconRef.current,
        descriptionRef.current || null,
      );
    }
  }, [
    pendingRename,
    currentDocument,
    editor,
    spacePath,
    activeWsId,
    titleRef,
    iconRef,
    descriptionRef,
    clearPendingRename,
    clearUnsaved,
    setCurrentDocument,
    patchEntryTreeMeta,
    setTitle,
  ]);
}
