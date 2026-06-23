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

import { hasUnresolvedConflicts } from "../conflict/parse-conflicts";
import { useEditorStore } from "../model";
import { useEditorSaveResultHandler } from "./use-editor-save-result-handler";
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
  const {
    applyAutoSaveResult,
    applySavedDocumentResult,
    clearCommittedMarkers,
  } = useEditorSaveResultHandler({
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
  });

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
          applyAutoSaveResult(result, path, cacheKey);
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
    applyAutoSaveResult,
    isDebouncePendingRef,
    performWrite,
    spacePath,
  ]);

  const handleSave = useCallback(async () => {
    if (!editor || !currentDocument || !spacePath) return;

    cancelDebounce();

    try {
      const result = await performWrite(false);
      if (!result) return;

      const committedPath = applySavedDocumentResult(result, currentDocument);
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
    applySavedDocumentResult,
    cancelDebounce,
    currentDocument,
    editor,
    performWrite,
    projectPath,
    clearCommittedMarkers,
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
      applySavedDocumentResult(result, currentDocument, {
        cacheCurrentDocument: false,
      });
      clearCommittedMarkers(
        await commitAllSpace(spacePath, projectPath ?? undefined),
      );
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    applySavedDocumentResult,
    cancelDebounce,
    clearCommittedMarkers,
    currentDocument,
    editor,
    performWrite,
    projectPath,
    spacePath,
  ]);

  return {
    handleSave,
    handleSaveAll,
    scheduleAutoSave,
  };
}
