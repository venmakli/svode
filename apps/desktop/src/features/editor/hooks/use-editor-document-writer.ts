import { useCallback } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import type { WriteResult } from "@/features/entry";
import { writeEntry } from "@/features/entry/entry-api";
import {
  commitAllSpace,
  commitFileAndMaybeSync,
  continueGitResolve,
  getGitSpaceStatus,
} from "@/features/git/editor";
import { getSpaceTreeSyncSnapshot } from "@/features/space";

import { hasUnresolvedConflicts } from "../conflict/parse-conflicts";
import { clearCommittedReviewMarkers } from "../file-tree-sync";
import { useEditorStore } from "../model";
import {
  deleteCachedDocumentValue,
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;

interface MutableRef<T> {
  current: T;
}

interface UseEditorDocumentWriterInput {
  activeRootId: string | null;
  activeWsId: string | null;
  bufferTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  cancelDebounce: () => void;
  clearUnsaved: (path: string) => void;
  currentCacheKeyRef: MutableRef<string | null>;
  currentDocument: string | null;
  currentPathRef: MutableRef<string | null>;
  debounceTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  descriptionRef: MutableRef<string>;
  editor: PlateEditor | null;
  iconRef: MutableRef<string | null>;
  isDebouncePendingRef: MutableRef<boolean>;
  ownNoncesRef: MutableRef<Set<string>>;
  patchEntryTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description: string | null,
  ) => void;
  projectPath: string | null;
  reloadTreePathParents: (spaceId: string, paths: string[]) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
  setCurrentDocument: (path: string) => void;
  spacePath: string;
  titleRef: MutableRef<string>;
}

interface UseEditorDocumentWriterResult {
  handleSave: () => Promise<void>;
  handleSaveAll: () => Promise<void>;
  scheduleAutoSave: () => void;
}

function clearCommittedMarkers(
  result: { committedPaths: string[] } | null | undefined,
): void {
  if (result?.committedPaths.length) {
    clearCommittedReviewMarkers(result.committedPaths);
  }
}

export function useEditorDocumentWriter({
  activeRootId,
  activeWsId,
  bufferTimerRef,
  cancelDebounce,
  clearUnsaved,
  currentCacheKeyRef,
  currentDocument,
  currentPathRef,
  debounceTimerRef,
  descriptionRef,
  editor,
  iconRef,
  isDebouncePendingRef,
  ownNoncesRef,
  patchEntryTreeMeta,
  projectPath,
  reloadTreePathParents,
  removeTreePath,
  setCurrentDocument,
  spacePath,
  titleRef,
}: UseEditorDocumentWriterInput): UseEditorDocumentWriterResult {
  const performWrite = useCallback(
    async (skipRename: boolean): Promise<WriteResult | null> => {
      if (!editor || !currentPathRef.current || !spacePath) return null;
      const path = currentPathRef.current;

      if (hasUnresolvedConflicts(editor.children)) {
        if (!skipRename) {
          toast.error(m.git_sync_conflict({ count: "1" }));
        }
        return null;
      }

      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      const result = await writeEntry({
        spacePath,
        path,
        content: markdown,
        skipRename,
        projectPath: projectPath ?? null,
      });

      if (result.writeNonce) {
        ownNoncesRef.current.add(result.writeNonce);
      }

      return result;
    },
    [currentPathRef, editor, ownNoncesRef, projectPath, spacePath],
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

  const scheduleAutoSave = useCallback(() => {
    if (!currentPathRef.current || !spacePath) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    isDebouncePendingRef.current = true;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const path = currentPathRef.current;
      const cacheKey = currentCacheKeyRef.current;
      void performWrite(true)
        .then((result) => {
          if (!result || !path || !cacheKey) return;
          if (editor) {
            setCachedDocumentValueByKey(cacheKey, editor.children);
          }
          patchCurrentTreeMeta(result.newPath ?? path);
        })
        .catch((err) => {
          console.error("Auto-save failed:", err);
        })
        .finally(() => {
          bufferTimerRef.current = setTimeout(() => {
            bufferTimerRef.current = null;
            isDebouncePendingRef.current = false;
          }, 500);
        });
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [
    bufferTimerRef,
    currentCacheKeyRef,
    currentPathRef,
    debounceTimerRef,
    editor,
    isDebouncePendingRef,
    patchCurrentTreeMeta,
    performWrite,
    spacePath,
  ]);

  const handleSave = useCallback(async () => {
    if (!editor || !currentDocument || !spacePath) return;

    cancelDebounce();

    try {
      const result = await performWrite(false);
      if (!result) return;

      clearUnsaved(currentDocument);

      if (result.newPath) {
        deleteCachedDocumentValue(currentDocument, spacePath);
        setCachedDocumentValue(spacePath, result.newPath, editor.children);
        setCurrentDocument(result.newPath);
        if (activeWsId) {
          removeTreePath(activeWsId, currentDocument);
          void reloadTreePathParents(activeWsId, [
            currentDocument,
            result.newPath,
          ]);
        }
      } else {
        setCachedDocumentValue(spacePath, currentDocument, editor.children);
        patchCurrentTreeMeta(currentDocument);
      }

      handleModifiedSources(result);

      const committedPath = result.newPath ?? currentDocument;
      const status = getGitSpaceStatus(spacePath);
      if (status?.hasConflicts) {
        try {
          await continueGitResolve(spacePath);
        } catch (err) {
          console.error("git merge resolution failed:", err);
          toast.error(m.git_sync_failed());
        }
      } else {
        clearCommittedMarkers(
          await commitFileAndMaybeSync(
            spacePath,
            committedPath,
            projectPath ?? undefined,
          ),
        );
      }
    } catch (err) {
      console.error("Failed to save document:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    activeWsId,
    cancelDebounce,
    clearUnsaved,
    currentDocument,
    editor,
    handleModifiedSources,
    patchCurrentTreeMeta,
    performWrite,
    projectPath,
    reloadTreePathParents,
    removeTreePath,
    setCurrentDocument,
    spacePath,
  ]);

  const handleSaveAll = useCallback(async () => {
    if (!spacePath) return;
    cancelDebounce();

    if (!editor || !currentDocument) {
      void commitAllSpace(spacePath, projectPath ?? undefined).then(
        clearCommittedMarkers,
      );
      return;
    }

    const isDirty = useEditorStore.getState().unsavedChanges[currentDocument];
    if (!isDirty) {
      void commitAllSpace(spacePath, projectPath ?? undefined).then(
        clearCommittedMarkers,
      );
      return;
    }

    try {
      const result = await performWrite(false);
      if (!result) return;
      clearUnsaved(currentDocument);
      if (result.newPath) {
        deleteCachedDocumentValue(currentDocument, spacePath);
        setCachedDocumentValue(spacePath, result.newPath, editor.children);
        setCurrentDocument(result.newPath);
        if (activeWsId) {
          removeTreePath(activeWsId, currentDocument);
          void reloadTreePathParents(activeWsId, [
            currentDocument,
            result.newPath,
          ]);
        }
      } else {
        patchCurrentTreeMeta(currentDocument);
      }
      handleModifiedSources(result);
      clearCommittedMarkers(
        await commitAllSpace(spacePath, projectPath ?? undefined),
      );
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    activeWsId,
    cancelDebounce,
    clearUnsaved,
    currentDocument,
    editor,
    handleModifiedSources,
    patchCurrentTreeMeta,
    performWrite,
    projectPath,
    reloadTreePathParents,
    removeTreePath,
    setCurrentDocument,
    spacePath,
  ]);

  return {
    handleSave,
    handleSaveAll,
    scheduleAutoSave,
  };
}
