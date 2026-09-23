import { getSpaceTreeSyncSnapshot } from "@/features/space";
import { useCallback, useEffect, useRef } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import {
  pageSourceErrorKind,
  publishPageFilenameWarnings,
  type Page,
  type PageSourceConflict,
  type WritePageResult,
} from "@/features/page";
import { readPage, writePage } from "@/features/page/page-api";
import {
  commitFileAndMaybeSync,
  commitSaveScopeAndMaybeSync,
  continueGitResolve,
  dirtyPathsForGitSaveScope,
  gitSaveShortcutLabel,
  gitStatusHasDirtyPath,
  getGitSpaceStatus,
  refreshGitSpaceStatus,
  resolveGitSaveAllScope,
  selfPathsForGitSaveScope,
  type GitSaveScope,
  type GitSaveScopeLabel,
  type GitSaveScopeTreeNode,
} from "@/features/git/editor";

import {
  deserializeWithConflicts,
  hasUnresolvedConflicts,
} from "../conflict/parse-conflicts";
import { useEditorStore } from "../model";
import {
  deleteDocumentBaseline,
  getDocumentBaseline,
  getDocumentCacheKey,
  setCachedDocumentValue,
  setDocumentBaseline,
} from "../model/plate-document-cache";
import { retryWhileSourceBusy } from "../model/source-sync";
import { useEditorSaveResultHandler } from "./use-editor-save-result-handler";
import { useEditorSourceSync } from "./use-editor-source-sync";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;
/** Body-preserving source changes adopted before a stale write becomes a conflict. */
const STALE_REBASE_ATTEMPTS = 2;

interface MutableRef<T> {
  current: T;
}

interface UseEditorDocumentWriterInput {
  activeRootId: string | null;
  activeWsId: string | null;
  bufferTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  cancelDebounce: () => void;
  clearUnsaved: (scopePath: string | null | undefined, path: string) => void;
  currentCacheKeyRef: MutableRef<string | null>;
  currentDocument: string | null;
  currentPathRef: MutableRef<string | null>;
  debounceTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  descriptionRef: MutableRef<string>;
  editor: PlateEditor | null;
  iconRef: MutableRef<string | null>;
  isDebouncePendingRef: MutableRef<boolean>;
  isLoadingRef: MutableRef<boolean>;
  loadEditorValue: (value: Descendant[]) => Descendant[];
  onSourcePageLoaded: (page: Page) => void;
  onSourceMetadata: (page: Page) => void;
  onSourceConflict?: (conflict: PageSourceConflict | null) => void;
  ownNoncesRef: MutableRef<Set<string>>;
  patchPageTreeMeta: (
    spaceId: string,
    path: string,
    title: string,
    icon: string | null,
    description: string | null,
  ) => void;
  projectPath: string | null;
  reloadTreePathParents: (spaceId: string, paths: string[]) => Promise<void>;
  removeTreePath: (spaceId: string, path: string) => void;
  saveScopeTree: readonly GitSaveScopeTreeNode[];
  setCurrentDocument: (path: string) => void;
  spacePath: string;
  titleRef: MutableRef<string>;
  readOnly: boolean;
  onWriteAccessError?: (
    error: unknown,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
}

interface UseEditorDocumentWriterResult {
  handleSave: () => Promise<void>;
  handleSaveAll: () => Promise<void>;
  scheduleAutoSave: () => void;
  flushPendingSource: () => Promise<void>;
  /** Brings the editor in line with a source another writer changed. */
  reconcileExternalChange: (path: string) => Promise<void>;
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
  isLoadingRef,
  loadEditorValue,
  onSourcePageLoaded,
  onSourceMetadata,
  onSourceConflict,
  ownNoncesRef,
  patchPageTreeMeta,
  projectPath,
  reloadTreePathParents,
  removeTreePath,
  saveScopeTree,
  setCurrentDocument,
  spacePath,
  titleRef,
  readOnly,
  onWriteAccessError,
}: UseEditorDocumentWriterInput): UseEditorDocumentWriterResult {
  const sourceWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const autoSavePausedRef = useRef(false);
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
    patchPageTreeMeta,
    reloadTreePathParents,
    removeTreePath,
    setCurrentDocument,
    spacePath,
    titleRef,
  });

  const baselineKey = useCallback(
    (path: string) => getDocumentCacheKey(spacePath, path),
    [spacePath],
  );

  /** Writes the editor text as the body of `path` edited from `sourceVersion`. */
  const writeSource = useCallback(
    async (
      skipRename: boolean,
      path: string,
      sourceVersion: string,
    ): Promise<WritePageResult | null> => {
      const write = async () => {
        if (!editor || !spacePath) return null;

        if (hasUnresolvedConflicts(editor.children)) {
          if (!skipRename) {
            toast.error(m.git_sync_conflict({ count: "1" }));
          }
          return null;
        }

        const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
        const tree = getSpaceTreeSyncSnapshot();
        const finishTreeMutation = skipRename
          ? undefined
          : tree.beginTreePathMutation(spacePath);
        let result: WritePageResult;
        try {
          result = await retryWhileSourceBusy(() =>
            writePage({
              spacePath,
              path,
              content: markdown,
              skipRename,
              projectPath: projectPath ?? null,
              sourceVersion,
            }),
          );

          if (result.newPath)
            tree.handoffTreePath(spacePath, path, result.newPath);
        } finally {
          finishTreeMutation?.();
        }

        if (result.writeNonce) {
          ownNoncesRef.current.add(result.writeNonce);
        }
        if (result.sourceVersion) {
          setDocumentBaseline(baselineKey(result.newPath ?? path), {
            version: result.sourceVersion,
            body: markdown,
          });
          // The path handoff of this rename must not carry the old baseline.
          if (result.newPath) deleteDocumentBaseline(baselineKey(path));
        }
        if (!skipRename) {
          publishPageFilenameWarnings(result.warnings);
        }

        return result;
      };
      const result = sourceWriteChainRef.current.then(write, write);
      sourceWriteChainRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [baselineKey, editor, ownNoncesRef, projectPath, spacePath],
  );

  const setAutoSavePaused = useCallback(
    (paused: boolean) => {
      autoSavePausedRef.current = paused;
      if (paused) cancelDebounce();
    },
    [cancelDebounce],
  );

  const sourceSync = useEditorSourceSync({
    baseline: (path) => getDocumentBaseline(baselineKey(path)),
    setBaseline: (path, baseline) =>
      setDocumentBaseline(baselineKey(path), baseline),
    hasDraft: (path) =>
      debounceTimerRef.current !== null ||
      useEditorStore.getState().hasUnsaved(spacePath, path),
    whenWritesSettled: () => sourceWriteChainRef.current,
    readSource: (path) => readPage({ spacePath, path }),
    loadSource: (path, page) => {
      if (!editor) return;
      isLoadingRef.current = true;
      try {
        const loadedValue = loadEditorValue(
          deserializeWithConflicts(editor, page.body),
        );
        setCachedDocumentValue(spacePath, path, loadedValue);
        if (page.source_version) {
          setDocumentBaseline(baselineKey(path), {
            version: page.source_version,
            body: page.body,
          });
        }
        clearUnsaved(spacePath, path);
        onSourcePageLoaded(page);
      } finally {
        isLoadingRef.current = false;
      }
    },
    adoptMetadata: onSourceMetadata,
    writeDraft: async (path, sourceVersion) => {
      const cacheKey = currentCacheKeyRef.current;
      const result = await writeSource(true, path, sourceVersion);
      applyAutoSaveResult(result, path, cacheKey);
      if (result) void refreshGitSpaceStatus(spacePath);
      return result;
    },
    setAutoSavePaused,
    report: (conflict) => onSourceConflict?.(conflict),
    onResolved: (choice) => {
      if (choice === "loaded") toast.info(m.page_source_conflict_loaded());
      // The resolved choice removes the focused recovery action.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) editor?.tf.focus();
      });
    },
  });

  const performWrite = useCallback(
    async (
      skipRename: boolean,
      targetPath?: string,
    ): Promise<WritePageResult | null> => {
      const path = targetPath ?? currentPathRef.current;
      if (!editor || !path || !spacePath) return null;
      for (let attempt = 0; ; attempt += 1) {
        if (sourceSync.isOpen()) return null;
        const baseline = getDocumentBaseline(baselineKey(path));
        if (baseline) {
          try {
            return await writeSource(skipRename, path, baseline.version);
          } catch (error) {
            if (pageSourceErrorKind(error) !== "source_stale") throw error;
          }
        }
        const outcome = await sourceSync.reconcile(path, "stale", {
          rebase: attempt < STALE_REBASE_ATTEMPTS,
        });
        if (outcome !== "rebased") return null;
      }
    },
    [baselineKey, currentPathRef, editor, sourceSync, spacePath, writeSource],
  );

  const reconcileExternalChange = useCallback(
    async (path: string) => {
      try {
        await sourceSync.reconcile(path, "external");
      } catch (error) {
        console.error("Failed to reload document:", error);
      }
    },
    [sourceSync],
  );

  const persistLatestSource = useCallback(async () => {
    const path = currentPathRef.current;
    const cacheKey = currentCacheKeyRef.current;
    const write = async () => {
      const result = await performWrite(true);
      applyAutoSaveResult(result, path, cacheKey);
      if (result) void refreshGitSpaceStatus(spacePath);
    };
    // A write that opened a source conflict keeps autosave paused for it.
    const resume = () => {
      if (!sourceSync.isOpen()) autoSavePausedRef.current = false;
    };
    try {
      await write();
      resume();
    } catch (error) {
      if (
        onWriteAccessError &&
        (await onWriteAccessError(error, async () => {
          await write();
          resume();
        }))
      ) {
        autoSavePausedRef.current = true;
        return;
      }
      throw error;
    }
  }, [
    applyAutoSaveResult,
    currentCacheKeyRef,
    currentPathRef,
    onWriteAccessError,
    performWrite,
    sourceSync,
    spacePath,
  ]);

  useEffect(() => {
    if (!readOnly && !sourceSync.isOpen()) autoSavePausedRef.current = false;
  }, [readOnly, sourceSync]);

  const scheduleAutoSave = useCallback(() => {
    if (
      readOnly ||
      autoSavePausedRef.current ||
      !currentPathRef.current ||
      !spacePath
    ) {
      return;
    }
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
      void persistLatestSource()
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
    currentPathRef,
    debounceTimerRef,
    isDebouncePendingRef,
    persistLatestSource,
    readOnly,
    spacePath,
  ]);

  const flushPendingSource = useCallback(async () => {
    const hasPendingDebounce = Boolean(debounceTimerRef.current);
    cancelDebounce();
    await sourceWriteChainRef.current;
    if (autoSavePausedRef.current) return;
    const path = currentPathRef.current;
    const hasUnsaved = Boolean(
      path && useEditorStore.getState().hasUnsaved(spacePath, path),
    );
    if (hasPendingDebounce || hasUnsaved) await persistLatestSource();
    await sourceWriteChainRef.current;
  }, [
    cancelDebounce,
    currentPathRef,
    debounceTimerRef,
    persistLatestSource,
    spacePath,
  ]);

  const saveCurrentSurface = useCallback(async () => {
    if (!currentDocument) return;
    const result = await performWrite(false);
    if (!result) return;

    const committedPath = applySavedDocumentResult(result, currentDocument);
    const status = getGitSpaceStatus(spacePath);
    if (status?.hasConflicts) {
      try {
        await continueGitResolve(spacePath);
      } catch (error) {
        console.error("git merge resolution failed:", error);
        toast.error(m.git_sync_failed());
      }
      return;
    }
    clearCommittedMarkers(
      await commitFileAndMaybeSync(
        spacePath,
        committedPath,
        projectPath ?? undefined,
      ),
    );
  }, [
    applySavedDocumentResult,
    clearCommittedMarkers,
    currentDocument,
    performWrite,
    projectPath,
    spacePath,
  ]);

  const handleSave = useCallback(async () => {
    if (!editor || !currentDocument || !spacePath) return;

    const status = getGitSpaceStatus(spacePath);
    const currentSurfaceDirty =
      useEditorStore.getState().hasUnsaved(spacePath, currentDocument) ||
      gitStatusHasDirtyPath(status, currentDocument);
    if (!currentSurfaceDirty) {
      showCurrentSurfaceCleanFeedback(
        status,
        resolveGitSaveAllScope({
          activePath: currentDocument,
          tree: saveScopeTree,
        }),
        currentDocument,
      );
      return;
    }

    cancelDebounce();
    try {
      await saveCurrentSurface();
    } catch (error) {
      if (
        onWriteAccessError &&
        (await onWriteAccessError(error, saveCurrentSurface))
      ) {
        throw error;
      }
      console.error("Failed to save document:", error);
      toast.error(m.editor_error_save());
      throw error;
    }
  }, [
    cancelDebounce,
    currentDocument,
    editor,
    onWriteAccessError,
    saveCurrentSurface,
    saveScopeTree,
    spacePath,
  ]);

  const handleSaveAll = useCallback(
    async (explicitScope?: GitSaveScope) => {
      if (!spacePath) return;
      cancelDebounce();
      const saveAllScope =
        explicitScope ??
        resolveGitSaveAllScope({
          activePath: currentDocument,
          tree: saveScopeTree,
        });

      if (!editor || !currentDocument) {
        await commitSaveScopeAndMaybeSync(
          spacePath,
          saveAllScope,
          [],
          projectPath ?? undefined,
        ).then(clearCommittedMarkers);
        return;
      }

      const isDirty = useEditorStore
        .getState()
        .hasUnsaved(spacePath, currentDocument);
      if (!isDirty) {
        await commitSaveScopeAndMaybeSync(
          spacePath,
          saveAllScope,
          [],
          projectPath ?? undefined,
        ).then(clearCommittedMarkers);
        return;
      }

      const saveAll = async () => {
        const result = await performWrite(false);
        if (!result) return;
        applySavedDocumentResult(result, currentDocument, {
          cacheCurrentDocument: false,
        });
        clearCommittedMarkers(
          await commitSaveScopeAndMaybeSync(
            spacePath,
            saveAllScope,
            [result.newPath ?? currentDocument],
            projectPath ?? undefined,
          ),
        );
      };
      try {
        await saveAll();
      } catch (err) {
        if (onWriteAccessError && (await onWriteAccessError(err, saveAll))) {
          throw err;
        }
        console.error("Save-all failed:", err);
        toast.error(m.editor_error_save());
        throw err;
      }
    },
    [
      applySavedDocumentResult,
      cancelDebounce,
      clearCommittedMarkers,
      currentDocument,
      editor,
      onWriteAccessError,
      performWrite,
      projectPath,
      saveScopeTree,
      spacePath,
    ],
  );

  return {
    flushPendingSource,
    handleSave,
    handleSaveAll,
    reconcileExternalChange,
    scheduleAutoSave,
  };
}

function showCurrentSurfaceCleanFeedback(
  status: ReturnType<typeof getGitSpaceStatus>,
  saveAllScope: GitSaveScope,
  currentDocument: string,
) {
  const selfPaths = new Set([
    ...selfPathsForGitSaveScope(saveAllScope),
    currentDocument,
  ]);
  const descendantDirtyCount = dirtyPathsForGitSaveScope(
    status,
    saveAllScope,
  ).filter((path) => !selfPaths.has(path)).length;

  if (descendantDirtyCount > 0) {
    toast.info(
      m.git_save_current_clean_scope({
        count: String(descendantDirtyCount),
        scope: gitSaveScopeLabel(saveAllScope.label),
        shortcut: gitSaveShortcutLabel("descendants"),
      }),
    );
    return;
  }

  toast.info(m.git_save_current_clean());
}

function gitSaveScopeLabel(label: GitSaveScopeLabel): string {
  switch (label) {
    case "collection":
      return m.git_save_scope_collection();
    case "folder":
      return m.git_save_scope_folder();
    case "page":
      return m.git_save_scope_page();
    case "space":
      return m.git_save_scope_space();
  }
}
