import { useCallback } from "react";
import type { PlateEditor } from "platejs/react";

import type { WriteResult } from "@/features/entry";
import { getSpaceTreeSyncSnapshot } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import { clearCommittedReviewMarkers } from "../file-tree-sync";
import { useEditorStore } from "../model";
import {
  deleteCachedDocumentValue,
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";

interface MutableRef<T> {
  current: T;
}

interface UseEditorSaveResultHandlerInput {
  activeRootId: string | null;
  activeWsId: string | null;
  clearUnsaved: (path: string) => void;
  descriptionRef: MutableRef<string>;
  editor: PlateEditor | null;
  iconRef: MutableRef<string | null>;
  patchEntryTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description: string | null,
  ) => void;
  reloadTreePathParents: (spaceId: string, paths: string[]) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
  setCurrentDocument: (path: string) => void;
  spacePath: string;
  titleRef: MutableRef<string>;
}

export function useEditorSaveResultHandler({
  activeRootId,
  activeWsId,
  clearUnsaved,
  descriptionRef,
  editor,
  iconRef,
  patchEntryTreeMeta,
  reloadTreePathParents,
  removeTreePath,
  setCurrentDocument,
  spacePath,
  titleRef,
}: UseEditorSaveResultHandlerInput) {
  const clearCommittedMarkers = useCallback(
    (result: { committedPaths: string[] } | null | undefined): void => {
      if (result?.committedPaths.length) {
        clearCommittedReviewMarkers(result.committedPaths);
      }
    },
    [],
  );

  const handleModifiedSources = useCallback(
    (result: WriteResult) => {
      const sources =
        result.modifiedSources && result.modifiedSources.length > 0
          ? result.modifiedSources
          : result.modifiedFiles.map((path) => ({
              spaceId: activeWsId ?? null,
              path,
            }));
      if (sources.length === 0) return;

      const paths = sources.map((source) => source.path);
      for (const path of paths) {
        deleteCachedDocumentValue(path);
      }
      useEditorStore.getState().suppressPaths(paths);

      const pathsByTreeId = new Map<string, string[]>();
      for (const source of sources) {
        const treeId = source.spaceId ?? activeRootId;
        if (!treeId) continue;
        pathsByTreeId.set(treeId, [
          ...(pathsByTreeId.get(treeId) ?? []),
          source.path,
        ]);
      }

      const store = getSpaceTreeSyncSnapshot();
      for (const [id, sourcePaths] of pathsByTreeId) {
        void store.reloadTreePathParents(id, sourcePaths);
      }
    },
    [activeRootId, activeWsId],
  );

  const patchCurrentTreeMeta = useCallback(
    (path: string) => {
      if (!activeWsId) return;
      patchEntryTreeMeta(
        activeWsId,
        path,
        titleRef.current || m.editor_untitled(),
        iconRef.current,
        descriptionRef.current || null,
      );
    },
    [activeWsId, descriptionRef, iconRef, patchEntryTreeMeta, titleRef],
  );

  const applyAutoSaveResult = useCallback(
    (
      result: WriteResult | null,
      path: string | null,
      cacheKey: string | null,
    ) => {
      if (!result || !path || !cacheKey) return;
      if (editor) {
        setCachedDocumentValueByKey(cacheKey, editor.children);
      }
      patchCurrentTreeMeta(result.newPath ?? path);
    },
    [editor, patchCurrentTreeMeta],
  );

  const applySavedDocumentResult = useCallback(
    (
      result: WriteResult,
      currentDocument: string,
      options: { cacheCurrentDocument?: boolean } = {},
    ): string => {
      const { cacheCurrentDocument = true } = options;
      clearUnsaved(currentDocument);

      if (result.newPath) {
        deleteCachedDocumentValue(currentDocument, spacePath);
        if (editor) {
          setCachedDocumentValue(spacePath, result.newPath, editor.children);
        }
        setCurrentDocument(result.newPath);
        if (activeWsId) {
          removeTreePath(activeWsId, currentDocument);
          void reloadTreePathParents(activeWsId, [
            currentDocument,
            result.newPath,
          ]);
        }
      } else if (editor) {
        if (cacheCurrentDocument) {
          setCachedDocumentValue(spacePath, currentDocument, editor.children);
        }
        patchCurrentTreeMeta(currentDocument);
      } else {
        patchCurrentTreeMeta(currentDocument);
      }

      handleModifiedSources(result);
      return result.newPath ?? currentDocument;
    },
    [
      activeWsId,
      clearUnsaved,
      editor,
      handleModifiedSources,
      patchCurrentTreeMeta,
      reloadTreePathParents,
      removeTreePath,
      setCurrentDocument,
      spacePath,
    ],
  );

  return {
    applyAutoSaveResult,
    applySavedDocumentResult,
    clearCommittedMarkers,
  };
}
