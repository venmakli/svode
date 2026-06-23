import { useEffect, useCallback, useRef, useState } from "react";
import type { Descendant } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { toast } from "sonner";
import { EditorKit } from "./editor-kit";
import { useFileWatcher } from "../hooks/use-file-watcher";
import {
  useActiveEntrySelection,
  useOpenEntryDocument,
} from "@/features/entry/selection";
import {
  getSpaceTreeSyncSnapshot,
  useSpace,
  useSpaceTreeSync,
} from "@/features/space";
import { useEditorStore } from "../model";
import { cn } from "@/shared/lib/utils";
import {
  commitAllSpace,
  commitFileAndMaybeSync,
  continueGitResolve,
  getGitSpaceStatus,
} from "@/features/git/editor";
import { clearCommittedReviewMarkers } from "../file-tree-sync";
import {
  deserializeWithConflicts,
  hasUnresolvedConflicts,
} from "../conflict/parse-conflicts";
import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-buttons";
import { Skeleton } from "@/components/ui/skeleton";
import { detailPageBodyClassName } from "@/shared/ui/page-layout";
import { logTiming, nowMs } from "@/shared/lib/performance";
import { TocSidebar } from "../ui/toc-sidebar";
import { EditorMediaAdapterProvider } from "../ui/editor-media-adapter-provider";
import type { Entry, EntryMeta, WriteResult } from "@/features/entry";
import { readEntry, writeEntry } from "@/features/entry/entry-api";
import {
  deleteCachedDocumentValue,
  getCachedDocumentValue,
  getDocumentCacheKey,
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import { useEditorLinkValidation } from "../hooks/use-editor-link-validation";
import { useEditorPendingRename } from "../hooks/use-editor-pending-rename";
import { useEditorSaveShortcuts } from "../hooks/use-editor-save-shortcuts";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;
const ENABLE_FIXED_FORMATTING_TOOLBAR = false;

function clearCommittedMarkers(
  result: { committedPaths: string[] } | null | undefined,
): void {
  if (result?.committedPaths.length) {
    clearCommittedReviewMarkers(result.committedPaths);
  }
}

function waitForNextFrame(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function showEntryWarnings(entry: { warnings?: { kind: string }[] }) {
  if (
    entry.warnings?.some((warning) => warning.kind === "malformed_frontmatter")
  ) {
    toast.warning(m.editor_frontmatter_malformed_warning());
  }
}

interface PlateDocumentEditorProps {
  bodyOnly: true;
  pageScroll?: boolean;
  documentPath?: string | null;
  documentSpaceId?: string | null;
  spacePath?: string | null;
  projectPath?: string | null;
  bodyOnlyMeta?: EntryMeta | null;
  initialEntry?: Entry | null;
  initialEntrySpacePath?: string | null;
  onDocumentPathChange?: (path: string) => void;
}

export function PlateDocumentEditor({
  bodyOnly,
  pageScroll = false,
  documentPath = null,
  documentSpaceId = null,
  spacePath: spacePathProp = null,
  projectPath: projectPathProp = null,
  bodyOnlyMeta = null,
  initialEntry = null,
  initialEntrySpacePath = null,
  onDocumentPathChange,
}: PlateDocumentEditorProps) {
  const { activeDocument, activeDocumentSpaceId } = useActiveEntrySelection();
  const openDocument = useOpenEntryDocument();
  const {
    rootSpaces,
    spaces: childWorkspaces,
    activeRootPath,
    activeRootId,
  } = useSpace();
  const { patchEntryTreeMeta, reloadTreePathParents, removeTreePath } =
    useSpaceTreeSync();
  const {
    markUnsaved,
    clearUnsaved,
    pendingRename,
    clearPendingRename,
    setBrokenLinks,
  } = useEditorStore();

  const currentDocument = documentPath ?? activeDocument;
  const usePageScroll = bodyOnly && pageScroll;
  const currentDocumentSpaceId = documentSpaceId ?? activeDocumentSpaceId;

  // Resolve workspace path from the document's workspace id
  const docWs = currentDocumentSpaceId
    ? [...rootSpaces, ...childWorkspaces].find(
        (w) => w.id === currentDocumentSpaceId,
      )
    : null;
  const spacePath = spacePathProp ?? docWs?.path ?? "";
  const activeWsId = currentDocumentSpaceId;
  const projectPath = projectPathProp ?? activeRootPath;
  const setCurrentDocument = useCallback(
    (path: string) => {
      onDocumentPathChange?.(path);
      if (!documentPath) openDocument(path);
    },
    [documentPath, onDocumentPathChange, openDocument],
  );

  const isLoadingRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const currentCacheKeyRef = useRef<string | null>(null);
  const initialEntryRef = useRef<Entry | null>(initialEntry);
  const initialEntrySpacePathRef = useRef<string | null>(initialEntrySpacePath);
  const bodyOnlyMetaRef = useRef<EntryMeta | null>(bodyOnlyMeta);
  const loadSeqRef = useRef(0);
  const titleRef = useRef("");
  const iconRef = useRef<string | null>(null);
  const descriptionRef = useRef("");

  // Debounce auto-save refs
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Buffer timer kept after IPC resolves so the delayed watcher echo
  // (200 ms watcher debounce + Tauri delivery) still sees pending=true and
  // is dropped by use-file-watcher's local-wins guard. Without this the
  // backend's nonce/path echo-guard is the only line of defence and it
  // races on macOS when canonicalize() rewrites the path before notify
  // delivers the FSEvent (cursor jumps to top-left, slash menu closes).
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDebouncePendingRef = useRef(false);
  const ownNoncesRef = useRef<Set<string>>(new Set());

  const [, setMeta] = useState<EntryMeta | null>(null);
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [loadedDocumentKey, setLoadedDocumentKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    initialEntryRef.current = initialEntry;
    initialEntrySpacePathRef.current = initialEntrySpacePath;
    bodyOnlyMetaRef.current = bodyOnlyMeta;
  }, [bodyOnlyMeta, initialEntry, initialEntrySpacePath]);

  // Keep refs in sync with state for stable callback access
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);
  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);

  const editor = usePlateEditor({
    plugins: EditorKit,
  });

  const loadEditorValue = useCallback(
    (value: Descendant[]) => loadProgrammaticEditorValue(editor, value),
    [editor],
  );

  // Cancel any pending debounced auto-save. Used on document switch / unmount
  // and before ⌘S materialize.
  const cancelDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    isDebouncePendingRef.current = false;
  }, []);

  // Serialize the editor + current meta refs and write the entry. Tracks
  // the returned write-nonce so the watcher can drop our own file:changed
  // echo. `skipRename=true` = auto-save (body+frontmatter only). false = ⌘S
  // materialize (rename + update_links + structural schedule on backend).
  const performWrite = useCallback(
    async (skipRename: boolean): Promise<WriteResult | null> => {
      if (!editor || !currentPathRef.current || !spacePath) return null;
      const path = currentPathRef.current;

      if (hasUnresolvedConflicts(editor.children)) {
        // Skip silently during auto-save; surface the error on explicit save.
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
    [editor, spacePath, projectPath],
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
    [activeWsId, patchEntryTreeMeta],
  );

  // Schedule a debounced auto-save of the active document. Resets the timer
  // on every call, so continuous typing never triggers mid-stream writes.
  // pending stays true through the IPC + a 500 ms post-write buffer so the
  // own-write `file:changed` echo (watcher debounces 200 ms + Tauri delivery)
  // is dropped by the local-wins branch before it can reload the editor.
  // Don't clear unsavedChanges here — the file is on disk but still
  // uncommitted in git, indicator should stay grey until ⌘S commit.
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
  }, [performWrite, editor, spacePath, patchCurrentTreeMeta]);

  // `initialEntry` is a perf shortcut; require its source space so identical
  // paths like root/child `README.md` cannot cross-load between scopes.
  const initialEntryMatchesCurrentDocument =
    Boolean(initialEntry && initialEntry.path === currentDocument) &&
    Boolean(spacePath) &&
    initialEntrySpacePath === spacePath;
  const initialEntryLoadKey =
    initialEntryMatchesCurrentDocument && initialEntry
      ? `${spacePath}\0${initialEntry.path}\0${initialEntry.body.length}`
      : null;

  // Load document when the target document changes
  useEffect(() => {
    if (!editor || !currentDocument || !spacePath) return;

    const sequence = loadSeqRef.current + 1;
    loadSeqRef.current = sequence;
    const startedAt = nowMs();

    // Cache current editor state before switching. Cancel any debounce for
    // the previous doc — any in-memory edits not yet written are discarded
    // at switch time (v1 — acceptable loss ≤1s of edits).
    const currentCacheKey = getDocumentCacheKey(spacePath, currentDocument);
    const prevPath = currentPathRef.current;
    const prevCacheKey = currentCacheKeyRef.current;
    if (prevPath && prevCacheKey && prevCacheKey !== currentCacheKey) {
      setCachedDocumentValueByKey(prevCacheKey, editor.children);
    }
    cancelDebounce();

    currentPathRef.current = currentDocument;
    currentCacheKeyRef.current = currentCacheKey;
    isLoadingRef.current = true;
    setBrokenLinks(new Set());
    queueMicrotask(() => {
      if (sequence === loadSeqRef.current) {
        setLoadedDocumentKey(null);
      }
    });

    // Use cached Plate value if available and file wasn't modified externally
    // or invalidated by a prior backlinks update (staleCache).
    const cached = getCachedDocumentValue(spacePath, currentDocument);
    const editorState = useEditorStore.getState();
    const wasExternallyModified =
      editorState.aiModified[currentDocument] ||
      editorState.staleCache[currentDocument];
    const cachedBody = cached && !wasExternallyModified ? cached : null;
    const initialEntrySpacePathForDocument = initialEntrySpacePathRef.current;
    const initialForDocument =
      initialEntryRef.current?.path === currentDocument &&
      initialEntrySpacePathForDocument === spacePath
        ? initialEntryRef.current
        : null;
    const bodyOnlyMetaForDocument =
      initialEntrySpacePathForDocument === spacePath
        ? bodyOnlyMetaRef.current
        : null;
    const metaForCachedBody =
      initialForDocument?.meta ?? bodyOnlyMetaForDocument;

    const nextDocumentLoading = !cachedBody;
    queueMicrotask(() => {
      if (sequence === loadSeqRef.current) {
        setDocumentLoading(nextDocumentLoading);
      }
    });

    const applyMeta = (entryMeta: EntryMeta) => {
      setMeta(entryMeta);
      setTitle(entryMeta.title);
      setIcon(entryMeta.icon);
      setDescription(entryMeta.description ?? "");
    };

    const finish = (
      status: "ok" | "error",
      usedCachedBody: boolean,
      source: "cache" | "cache-meta-read" | "initial-entry" | "read-entry",
    ) => {
      if (sequence !== loadSeqRef.current) return;
      isLoadingRef.current = false;
      setDocumentLoading(false);
      if (status === "ok") setLoadedDocumentKey(currentCacheKey);
      logTiming("doc.open.editor", startedAt, {
        spaceId: currentDocumentSpaceId ?? null,
        cachedBody: usedCachedBody,
        source,
        status,
      });
    };

    if (cachedBody) {
      void (async () => {
        try {
          const entryMeta =
            metaForCachedBody ??
            await readEntry({ spacePath, path: currentDocument });
          if (sequence !== loadSeqRef.current) return;
          if ("meta" in entryMeta) {
            showEntryWarnings(entryMeta);
            applyMeta(entryMeta.meta as EntryMeta);
          } else {
            applyMeta(entryMeta);
          }
          const loadedValue = loadEditorValue(cachedBody);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(currentDocument);
          finish("ok", true, metaForCachedBody ? "cache" : "cache-meta-read");
        } catch (err) {
          if (sequence !== loadSeqRef.current) return;
          console.error("Failed to load document meta:", err);
          toast.error(m.editor_error_load());
          finish(
            "error",
            true,
            metaForCachedBody ? "cache" : "cache-meta-read",
          );
        }
      })();
    } else {
      deleteCachedDocumentValue(currentDocument, spacePath);
      useEditorStore.getState().clearStale(currentDocument);
      void (async () => {
        const source = initialForDocument ? "initial-entry" : "read-entry";
        try {
          await waitForNextFrame();
          const entry =
            initialForDocument ??
            (await readEntry({ spacePath, path: currentDocument }));
          if (sequence !== loadSeqRef.current) return;
          showEntryWarnings(entry);
          applyMeta(entry.meta as EntryMeta);
          const value = deserializeWithConflicts(editor, entry.body);
          const loadedValue = loadEditorValue(value);
          setCachedDocumentValue(spacePath, currentDocument, loadedValue);
          clearUnsaved(currentDocument);
          finish("ok", false, source);
        } catch (err) {
          if (sequence !== loadSeqRef.current) return;
          console.error("Failed to load document:", err);
          toast.error(m.editor_error_load());
          finish("error", false, source);
        }
      })();
    }
  }, [
    editor,
    currentDocument,
    currentDocumentSpaceId,
    spacePath,
    initialEntryLoadKey,
    loadEditorValue,
    cancelDebounce,
    clearUnsaved,
    setBrokenLinks,
  ]);

  const linkValidationDocumentKey =
    loadedDocumentKey &&
    currentDocument &&
    spacePath &&
    loadedDocumentKey === getDocumentCacheKey(spacePath, currentDocument)
      ? loadedDocumentKey
      : null;
  useEditorLinkValidation({
    loadedDocumentKey: linkValidationDocumentKey,
    currentDocument,
    spacePath,
    projectPath: projectPath ?? null,
    setBrokenLinks,
  });

  useEffect(() => {
    bodyOnlyMetaRef.current = bodyOnlyMeta;
    if (!bodyOnly || !bodyOnlyMeta) return;
    if (initialEntrySpacePath !== spacePath) {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMeta(bodyOnlyMeta);
      setTitle(bodyOnlyMeta.title);
      setIcon(bodyOnlyMeta.icon);
      setDescription(bodyOnlyMeta.description ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [bodyOnly, bodyOnlyMeta, initialEntrySpacePath, spacePath]);

  // Cancel debounce on unmount
  useEffect(() => cancelDebounce, [cancelDebounce]);

  useEditorPendingRename({
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
  });

  // ⌘S — cancel debounce, materialize rename/backlink writes, then stage
  // directly related pending paths into this explicit save commit.
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

      // Backlinks files: invalidate cache so next open re-reads from disk,
      // and suppress watcher reload handling for Svode-initiated rewrites.
      handleModifiedSources(result);

      // Auto-commit the saved file. During mid-merge, ask the Git feature to
      // continue merge resolution instead.
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
    editor,
    currentDocument,
    spacePath,
    activeWsId,
    projectPath,
    cancelDebounce,
    performWrite,
    clearUnsaved,
    handleModifiedSources,
    patchCurrentTreeMeta,
    reloadTreePathParents,
    removeTreePath,
    setCurrentDocument,
  ]);

  // ⌘⇧S — flush the active document (if dirty) with materialize, then
  // `git add . && git commit` via commitAllSpace — catches every other
  // on-disk change too (externally-modified files, AI writes, backlink updates).
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
      // See handleSave: same backlinks suppress + cache-invalidate.
      handleModifiedSources(result);
      clearCommittedMarkers(
        await commitAllSpace(spacePath, projectPath ?? undefined),
      );
    } catch (err) {
      console.error("Save-all failed:", err);
      toast.error(m.editor_error_save());
    }
  }, [
    editor,
    currentDocument,
    spacePath,
    activeWsId,
    projectPath,
    cancelDebounce,
    performWrite,
    clearUnsaved,
    handleModifiedSources,
    patchCurrentTreeMeta,
    reloadTreePathParents,
    removeTreePath,
    setCurrentDocument,
  ]);

  useEditorSaveShortcuts({ onSave: handleSave, onSaveAll: handleSaveAll });

  const handleWatcherEntryReloaded = useCallback(
    (entry: Awaited<ReturnType<typeof readEntry>>) => {
      const nextMeta = entry.meta as EntryMeta;
      showEntryWarnings(entry);
      setMeta(nextMeta);
      setTitle(nextMeta.title);
      setIcon(nextMeta.icon);
      setDescription(nextMeta.description ?? "");

      const cacheKey = currentCacheKeyRef.current;
      if (cacheKey) {
        setLoadedDocumentKey(null);
        window.setTimeout(() => {
          if (currentCacheKeyRef.current === cacheKey) {
            setLoadedDocumentKey(cacheKey);
          }
        }, 0);
      }
    },
    [],
  );

  const handleEditorValueReload = useCallback(
    (_path: string, value: Descendant[]) => loadEditorValue(value),
    [loadEditorValue],
  );

  useFileWatcher({
    editor,
    spacePath,
    activeDocument: currentDocument,
    ownNoncesRef,
    isDebouncePendingRef,
    isLoadingRef,
    onEditorValueReload: handleEditorValueReload,
    onEntryReloaded: handleWatcherEntryReloaded,
  });

  // onChange — mark unsaved + schedule auto-save on actual content changes
  // (skip selection-only changes like clicking or focusing)
  const handleChange = useCallback(
    (_: { value: Descendant[] }) => {
      const currentPath = currentPathRef.current;
      if (!isLoadingRef.current && currentPath) {
        const hasContentChange = editor.operations.some(
          (op) => op.type !== "set_selection",
        );
        if (hasContentChange) {
          markUnsaved(currentPath);
          scheduleAutoSave();
        }
      }
    },
    [editor, markUnsaved, scheduleAutoSave],
  );
  const deserializeToolbarMarkdown = useCallback(
    (text: string) => deserializeEditorMarkdownInsertion(editor, text),
    [editor],
  );

  return (
    <EditorMediaAdapterProvider
      documentPath={currentDocument}
      projectPath={projectPath ?? null}
      spacePath={spacePath || null}
    >
      <Plate editor={editor} onChange={handleChange}>
        <div
          className={cn(
            "flex w-full flex-col",
            usePageScroll ? "min-h-0" : "h-full",
          )}
        >
          {ENABLE_FIXED_FORMATTING_TOOLBAR ? (
            <FixedToolbar>
              <FixedToolbarButtons
                deserializeMarkdown={deserializeToolbarMarkdown}
              />
            </FixedToolbar>
          ) : null}

          <div
            className={cn(
              "relative",
              usePageScroll ? "overflow-visible" : "flex-1 overflow-hidden",
            )}
          >
            <TocSidebar />
            {documentLoading ? (
              <EditorBodyLoadingState pageScroll={usePageScroll} />
            ) : null}
            <EditorContainer
              className={cn(
                usePageScroll
                  ? "h-auto overflow-visible overflow-y-visible"
                  : "h-full",
                documentLoading && "hidden",
              )}
            >
              <Editor
                variant={usePageScroll ? "none" : "default"}
                className={cn(usePageScroll && detailPageBodyClassName)}
                placeholder={m.editor_placeholder_body()}
              />
            </EditorContainer>
          </div>
        </div>
      </Plate>
    </EditorMediaAdapterProvider>
  );
}

function EditorBodyLoadingState({ pageScroll }: { pageScroll: boolean }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-8",
        !pageScroll && "h-full",
      )}
    >
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-4 h-40 w-full" />
    </div>
  );
}
