import { useCallback } from "react";
import type { PlateEditor } from "platejs/react";

import type { WritePageResult } from "@/features/page";
import * as m from "@/paraglide/messages.js";

import { clearCommittedReviewMarkers } from "../file-tree-sync";
import {
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";

interface MutableRef<T> {
  current: T;
}

interface UseEditorSaveResultHandlerInput {
  activeWsId: string | null;
  clearUnsaved: (scopePath: string | null | undefined, path: string) => void;
  descriptionRef: MutableRef<string>;
  editor: PlateEditor | null;
  iconRef: MutableRef<string | null>;
  patchPageTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description: string | null,
  ) => void;
  spacePath: string;
  titleRef: MutableRef<string>;
}

export function useEditorSaveResultHandler({
  activeWsId,
  clearUnsaved,
  descriptionRef,
  editor,
  iconRef,
  patchPageTreeMeta,
  spacePath,
  titleRef,
}: UseEditorSaveResultHandlerInput) {
  const clearCommittedMarkers = useCallback(
    (result: { committedPaths: string[] } | null | undefined): void => {
      if (result?.committedPaths.length) {
        clearCommittedReviewMarkers(spacePath, result.committedPaths);
      }
    },
    [spacePath],
  );

  const patchCurrentTreeMeta = useCallback(
    (path: string) => {
      if (!activeWsId) return;
      patchPageTreeMeta(
        activeWsId,
        path,
        titleRef.current || m.editor_untitled(),
        iconRef.current,
        descriptionRef.current || null,
      );
    },
    [activeWsId, descriptionRef, iconRef, patchPageTreeMeta, titleRef],
  );

  const applyAutoSaveResult = useCallback(
    (
      result: WritePageResult | null,
      path: string | null,
      cacheKey: string | null,
    ) => {
      if (!result || !path || !cacheKey) return;
      if (editor) {
        setCachedDocumentValueByKey(cacheKey, editor.children);
      }
      clearUnsaved(spacePath, path);
      patchCurrentTreeMeta(path);
    },
    [clearUnsaved, editor, patchCurrentTreeMeta, spacePath],
  );

  const applySavedDocumentResult = useCallback(
    (
      currentDocument: string,
      options: { cacheCurrentDocument?: boolean } = {},
    ): void => {
      const { cacheCurrentDocument = true } = options;
      clearUnsaved(spacePath, currentDocument);
      if (editor && cacheCurrentDocument) {
        setCachedDocumentValue(spacePath, currentDocument, editor.children);
      }
      patchCurrentTreeMeta(currentDocument);
    },
    [clearUnsaved, editor, patchCurrentTreeMeta, spacePath],
  );

  return {
    applyAutoSaveResult,
    applySavedDocumentResult,
    clearCommittedMarkers,
  };
}
