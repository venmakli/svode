import { useCallback, useEffect, useRef } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import {
  composeDecidedPage,
  getPageMergeState,
  pageMergeDecided,
  pageSourceErrorKind,
  setPageMerge,
  setPageMergeWrite,
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
  explicitCommitRefusal,
  gitSaveShortcutLabel,
  gitPathInConflict,
  gitStatusHasDirtyPath,
  getGitSpaceStatus,
  notifyGitSaveFailure,
  refreshGitSpaceStatus,
  resolveGitSaveAllScope,
  selfPathsForGitSaveScope,
  type GitCommitRefusal,
  type GitCommitResult,
  type GitSaveScope,
  type GitSaveScopeLabel,
  type GitSaveScopeTreeNode,
} from "@/features/git/editor";

import { readPageConflicts } from "../api/conflict-marker-api";
import {
  deserializeWithConflicts,
  hasUnresolvedConflicts,
} from "../conflict/parse-conflicts";
import { useEditorStore } from "../model";
import { bodyWithSourceLeadingBlankLines } from "../model/markdown-io";
import {
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

/**
 * Who presents a commit refused after the save wrote the Page: the save
 * shortcut of the surface in a notification, or the caller it is thrown to
 * ("Changes"). Either way the written Page counts as saved.
 */
export type CommitFailurePresentation = "notify" | "throw";

/** A commit that failed after the write went through. */
interface CommitFailure {
  error: unknown;
}

interface UseEditorDocumentWriterInput {
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
  saveScopeTree: readonly GitSaveScopeTreeNode[];
  spacePath: string;
  titleRef: MutableRef<string>;
  readOnly: boolean;
  onWriteAccessError?: (
    error: unknown,
    retry: () => Promise<void>,
  ) => Promise<boolean>;
  /** The host already shows that saving is blocked. */
  saveFailureShown?: () => boolean;
}

interface UseEditorDocumentWriterResult {
  /**
   * An explicit commit of the Page; a refusal is returned before any write.
   * A failed write blocks saving and throws; a failed commit is presented as
   * `commitFailure` says (thrown by default).
   */
  handleSave: (
    commitFailure?: CommitFailurePresentation,
  ) => Promise<GitCommitRefusal | null>;
  handleSaveAll: (
    scope?: GitSaveScope,
    commitFailure?: CommitFailurePresentation,
  ) => Promise<GitCommitRefusal | null>;
  /** True while a draft waits for the user's choice in a source conflict. */
  hasSourceConflict: () => boolean;
  scheduleAutoSave: () => void;
  flushPendingSource: () => Promise<void>;
  /** Drops the unsaved body and loads the saved source, writing nothing. */
  discardPendingSource: () => Promise<void>;
  /** Brings the editor in line with a source another writer changed. */
  reconcileExternalChange: (path: string) => Promise<void>;
}

export function useEditorDocumentWriter({
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
  saveScopeTree,
  spacePath,
  titleRef,
  readOnly,
  onWriteAccessError,
  saveFailureShown,
}: UseEditorDocumentWriterInput): UseEditorDocumentWriterResult {
  const sourceWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const resolutionChainRef = useRef<Promise<void>>(Promise.resolve());
  const autoSavePausedRef = useRef(false);
  const {
    applyAutoSaveResult,
    applySavedDocumentResult,
    clearCommittedMarkers,
  } = useEditorSaveResultHandler({
    activeWsId,
    clearUnsaved,
    descriptionRef,
    editor,
    iconRef,
    patchPageTreeMeta,
    spacePath,
    titleRef,
  });

  const baselineKey = useCallback(
    (path: string) => getDocumentCacheKey(spacePath, path),
    [spacePath],
  );

  /**
   * Writes the editor text as the body of `path` edited from `sourceVersion`.
   * A body write never renames the Page; its title changes as a Page field.
   */
  const writeSource = useCallback(
    async (
      explicitSave: boolean,
      path: string,
      sourceVersion: string,
    ): Promise<WritePageResult | null> => {
      const write = async () => {
        if (!editor || !spacePath) return null;

        // A Page with its frontmatter in conflict is written once every
        // disputed property and text block is decided, in one write of the
        // properties the decisions give and the text (DF-292 R4).
        const merge = getPageMergeState(spacePath, path);
        if (merge && !pageMergeDecided(merge)) {
          if (explicitSave) {
            toast.error(m.page_merge_save_blocked());
          }
          return null;
        }

        if (hasUnresolvedConflicts(editor.children)) {
          if (explicitSave) {
            toast.error(m.page_conflict_save_blocked());
          }
          return null;
        }

        const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
        const body = bodyWithSourceLeadingBlankLines(
          merge?.merge.type === "merged"
            ? merge.merge.body
            : (getDocumentBaseline(baselineKey(path))?.body ?? ""),
          markdown,
        );
        let content = body;
        if (merge) {
          setPageMergeWrite(spacePath, path, { status: "writing" });
          try {
            const composed = await composeDecidedPage(
              spacePath,
              path,
              merge,
              body,
            );
            if (composed.type === "unresolved") {
              setPageMergeWrite(spacePath, path, {
                status: "refused",
                finding: composed.finding,
              });
              return null;
            }
            content = composed.content;
          } catch (error) {
            setPageMergeWrite(spacePath, path, {
              status: "failed",
              message: String(error),
            });
            return null;
          }
        }
        let result: WritePageResult;
        try {
          result = await retryWhileSourceBusy(() =>
            writePage({
              spacePath,
              path,
              content,
              projectPath: projectPath ?? null,
              sourceVersion,
            }),
          );
        } catch (error) {
          if (merge) setPageMergeWrite(spacePath, path, { status: "idle" });
          throw error;
        }

        if (result.writeNonce) {
          ownNoncesRef.current.add(result.writeNonce);
        }
        if (result.sourceVersion) {
          setDocumentBaseline(baselineKey(path), {
            version: result.sourceVersion,
            body,
          });
        }
        // The Page reads again: its properties leave the conflict mode.
        if (merge) setPageMerge(spacePath, path, null);

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

  /**
   * After a write of `path`: while Git holds it unresolved, in a merge or
   * without an operation, the write resolves it, an autosave as much as ⌘S;
   * `always` continues the merge for any Page, as ⌘S in a merge does. The
   * backend refuses a file with marker lines left (1.F п. 3). One resolution
   * at a time, outside the write chain; a refusal is named, never thrown.
   */
  const resolveWrittenPage = useCallback(
    (path: string, always = false): Promise<void> => {
      const resolve = async () => {
        if (!always && !gitPathInConflict(spacePath, path)) return;
        await continueGitResolve(spacePath, path, titleRef.current || path);
      };
      const run = resolutionChainRef.current.then(resolve);
      resolutionChainRef.current = run;
      return run;
    },
    [spacePath, titleRef],
  );

  const setAutoSavePaused = useCallback(
    (paused: boolean) => {
      autoSavePausedRef.current = paused;
      if (paused) cancelDebounce();
    },
    [cancelDebounce],
  );

  const loadSource = useCallback(
    async (path: string, page: Page) => {
      if (!editor) return;
      const { markerSize, merge, text, bases } = await readPageConflicts(
        spacePath,
        path,
        page,
      );
      isLoadingRef.current = true;
      try {
        setPageMerge(spacePath, path, merge);
        const loadedValue = loadEditorValue(
          deserializeWithConflicts(editor, text, markerSize, bases),
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
    [
      baselineKey,
      clearUnsaved,
      editor,
      isLoadingRef,
      loadEditorValue,
      onSourcePageLoaded,
      spacePath,
    ],
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
    loadSource,
    adoptMetadata: onSourceMetadata,
    writeDraft: async (path, sourceVersion) => {
      const cacheKey = currentCacheKeyRef.current;
      const result = await writeSource(false, path, sourceVersion);
      applyAutoSaveResult(result, path, cacheKey);
      if (result) {
        void refreshGitSpaceStatus(spacePath);
        void resolveWrittenPage(path);
      }
      return result;
    },
    setAutoSavePaused,
    report: (conflict) => onSourceConflict?.(conflict),
    onResolved: (choice) => {
      if (choice === "loaded") toast.info(m.page_source_conflict_loaded());
      // Back from the recovery actions at the kept caret; a plain DOM focus
      // of the editable would put it at the start of the document.
      editor?.tf.focus();
    },
  });

  const performWrite = useCallback(
    async (
      explicitSave: boolean,
      targetPath?: string,
    ): Promise<WritePageResult | null> => {
      const path = targetPath ?? currentPathRef.current;
      if (!editor || !path || !spacePath) return null;
      for (let attempt = 0; ; attempt += 1) {
        if (sourceSync.isOpen()) return null;
        const baseline = getDocumentBaseline(baselineKey(path));
        if (baseline) {
          try {
            return await writeSource(explicitSave, path, baseline.version);
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

  // Any write of the source that went through ends a pause of autosave, also
  // a retried explicit save; one that opened a source conflict keeps it.
  const resumeAutoSave = useCallback(() => {
    if (!sourceSync.isOpen()) autoSavePausedRef.current = false;
  }, [sourceSync]);

  const persistLatestSource = useCallback(async () => {
    const path = currentPathRef.current;
    const cacheKey = currentCacheKeyRef.current;
    const write = async () => {
      const result = await performWrite(false);
      applyAutoSaveResult(result, path, cacheKey);
      if (result) {
        void refreshGitSpaceStatus(spacePath);
        if (path) void resolveWrittenPage(path);
      }
    };
    try {
      await write();
      resumeAutoSave();
    } catch (error) {
      if (
        onWriteAccessError &&
        (await onWriteAccessError(error, async () => {
          await write();
          resumeAutoSave();
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
    resolveWrittenPage,
    resumeAutoSave,
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

  const discardPendingSource = useCallback(async () => {
    cancelDebounce();
    await sourceWriteChainRef.current;
    const path = currentPathRef.current;
    if (path && editor && spacePath)
      await loadSource(path, await readPage({ spacePath, path }));
    // Closes an open source conflict: its draft is what is discarded.
    sourceSync.dispose();
    autoSavePausedRef.current = false;
  }, [
    cancelDebounce,
    currentPathRef,
    editor,
    loadSource,
    sourceSync,
    spacePath,
  ]);

  /** The commit after a write: its failure is returned, not thrown. */
  const commitWritten = useCallback(
    async (
      commit: () => Promise<GitCommitResult | null>,
    ): Promise<CommitFailure | null> => {
      let committed: GitCommitResult | null;
      try {
        committed = await commit();
      } catch (error) {
        return { error };
      }
      clearCommittedMarkers(committed);
      return null;
    },
    [clearCommittedMarkers],
  );

  /** Writes the Page, then commits it; only a failed write throws. */
  const saveCurrentSurface =
    useCallback(async (): Promise<CommitFailure | null> => {
      if (!currentDocument) return null;
      const result = await performWrite(true);
      if (!result) return null;
      resumeAutoSave();

      applySavedDocumentResult(currentDocument);
      const status = getGitSpaceStatus(spacePath);
      if (status?.hasConflicts) {
        await resolveWrittenPage(currentDocument, true);
        return null;
      }
      return commitWritten(() =>
        commitFileAndMaybeSync(
          spacePath,
          currentDocument,
          projectPath ?? undefined,
        ),
      );
    }, [
      applySavedDocumentResult,
      commitWritten,
      currentDocument,
      performWrite,
      projectPath,
      resolveWrittenPage,
      resumeAutoSave,
      spacePath,
    ]);

  const handleSave = useCallback(
    async (commitFailure: CommitFailurePresentation = "throw") => {
      if (!editor || !currentDocument || !spacePath) return null;

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
        return null;
      }
      const refusal = explicitCommitRefusal(spacePath, {
        kind: "file",
        path: currentDocument,
        label: "page",
      });
      if (refusal) return refusal;

      cancelDebounce();
      let failure: CommitFailure | null;
      try {
        failure = await saveCurrentSurface();
      } catch (error) {
        if (
          onWriteAccessError &&
          (await onWriteAccessError(error, async () =>
            notifyCommitFailure(await saveCurrentSurface()),
          ))
        ) {
          throw error;
        }
        console.error("Failed to save document:", error);
        if (!saveFailureShown?.()) toast.error(m.editor_error_save());
        throw error;
      }
      presentCommitFailure(failure, commitFailure);
      return null;
    },
    [
      cancelDebounce,
      currentDocument,
      editor,
      onWriteAccessError,
      saveCurrentSurface,
      saveFailureShown,
      saveScopeTree,
      spacePath,
    ],
  );

  const handleSaveAll = useCallback(
    async (
      explicitScope?: GitSaveScope,
      commitFailure: CommitFailurePresentation = "throw",
    ) => {
      if (!spacePath) return null;
      const saveAllScope =
        explicitScope ??
        resolveGitSaveAllScope({
          activePath: currentDocument,
          tree: saveScopeTree,
        });
      const refusal = explicitCommitRefusal(spacePath, saveAllScope);
      if (refusal) return refusal;
      cancelDebounce();

      const commitScope = (extraPaths: string[]) => () =>
        commitSaveScopeAndMaybeSync(
          spacePath,
          saveAllScope,
          extraPaths,
          projectPath ?? undefined,
        );

      if (
        !editor ||
        !currentDocument ||
        !useEditorStore.getState().hasUnsaved(spacePath, currentDocument)
      ) {
        presentCommitFailure(
          await commitWritten(commitScope([])),
          commitFailure,
        );
        return null;
      }

      const saveAll = async (): Promise<CommitFailure | null> => {
        const result = await performWrite(true);
        if (!result) return null;
        resumeAutoSave();
        applySavedDocumentResult(currentDocument, {
          cacheCurrentDocument: false,
        });
        await resolveWrittenPage(currentDocument);
        return commitWritten(commitScope([currentDocument]));
      };
      let failure: CommitFailure | null;
      try {
        failure = await saveAll();
      } catch (err) {
        if (
          onWriteAccessError &&
          (await onWriteAccessError(err, async () =>
            notifyCommitFailure(await saveAll()),
          ))
        ) {
          throw err;
        }
        console.error("Save-all failed:", err);
        toast.error(m.editor_error_save());
        throw err;
      }
      presentCommitFailure(failure, commitFailure);
      return null;
    },
    [
      applySavedDocumentResult,
      cancelDebounce,
      commitWritten,
      currentDocument,
      editor,
      onWriteAccessError,
      performWrite,
      projectPath,
      resolveWrittenPage,
      resumeAutoSave,
      saveScopeTree,
      spacePath,
    ],
  );

  return {
    discardPendingSource,
    flushPendingSource,
    handleSave,
    handleSaveAll,
    hasSourceConflict: sourceSync.isOpen,
    reconcileExternalChange,
    scheduleAutoSave,
  };
}

/** A retry the Page runs after a failed write has no caller to throw to. */
function notifyCommitFailure(failure: CommitFailure | null) {
  if (failure) notifyGitSaveFailure(failure.error);
}

function presentCommitFailure(
  failure: CommitFailure | null,
  presentation: CommitFailurePresentation,
) {
  if (!failure) return;
  if (presentation === "throw") throw failure.error;
  notifyGitSaveFailure(failure.error);
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
