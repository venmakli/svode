import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Descendant } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toast } from "sonner";

import {
  useActiveEntrySelection,
  useOpenEntryDocument,
} from "@/features/entry/selection";
import type { Entry, EntryMeta, WriteResult } from "@/features/entry";
import { readEntry, writeEntry } from "@/features/entry/entry-api";
import {
  commitAllSpace,
  commitFileAndMaybeSync,
  continueGitResolve,
  getGitSpaceStatus,
} from "@/features/git/editor";
import {
  getSpaceTreeSyncSnapshot,
  useSpace,
  useSpaceTreeSync,
} from "@/features/space";
import { logTiming, nowMs } from "@/shared/lib/performance";

import { deserializeEditorMarkdownInsertion } from "../model/markdown-io";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import {
  deserializeWithConflicts,
  hasUnresolvedConflicts,
} from "../conflict/parse-conflicts";
import { clearCommittedReviewMarkers } from "../file-tree-sync";
import { useEditorStore } from "../model";
import {
  deleteCachedDocumentValue,
  getCachedDocumentValue,
  getDocumentCacheKey,
  setCachedDocumentValue,
  setCachedDocumentValueByKey,
} from "../model/plate-document-cache";
import { useEditorLinkValidation } from "./use-editor-link-validation";
import { useEditorPendingRename } from "./use-editor-pending-rename";
import { useEditorSaveShortcuts } from "./use-editor-save-shortcuts";
import { useFileWatcher } from "./use-file-watcher";
import * as m from "@/paraglide/messages.js";

const AUTOSAVE_DEBOUNCE_MS = 1000;

interface UsePlateDocumentSessionInput {
  bodyOnly: boolean;
  bodyOnlyMeta: EntryMeta | null;
  documentPath: string | null;
  documentSpaceId: string | null;
  editor: PlateEditor | null;
  initialEntry: Entry | null;
  initialEntrySpacePath: string | null;
  onDocumentPathChange?: (path: string) => void;
  projectPath: string | null;
  spacePath: string | null;
}

interface UsePlateDocumentSessionResult {
  currentDocument: string | null;
  currentDocumentSpaceId: string | null;
  deserializeToolbarMarkdown: (text: string) => Descendant[];
  documentLoading: boolean;
  handleChange: (_: { value: Descendant[] }) => void;
  projectPath: string | null;
  spacePath: string;
}

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

export function usePlateDocumentSession({
  bodyOnly,
  bodyOnlyMeta,
  documentPath,
  documentSpaceId,
  editor,
  initialEntry,
  initialEntrySpacePath,
  onDocumentPathChange,
  projectPath: projectPathProp,
  spacePath: spacePathProp,
}: UsePlateDocumentSessionInput): UsePlateDocumentSessionResult {
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
  const currentDocumentSpaceId = documentSpaceId ?? activeDocumentSpaceId;
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
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    iconRef.current = icon;
  }, [icon]);

  useEffect(() => {
    descriptionRef.current = description;
  }, [description]);

  const loadEditorValue = useCallback(
    (value: Descendant[]) => {
      if (!editor) return value;
      return loadProgrammaticEditorValue(editor, value);
    },
    [editor],
  );

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

  const initialEntryMatchesCurrentDocument =
    Boolean(initialEntry && initialEntry.path === currentDocument) &&
    Boolean(spacePath) &&
    initialEntrySpacePath === spacePath;
  const initialEntryLoadKey =
    initialEntryMatchesCurrentDocument && initialEntry
      ? `${spacePath}\0${initialEntry.path}\0${initialEntry.body.length}`
      : null;

  useEffect(() => {
    if (!editor || !currentDocument || !spacePath) return;

    const sequence = loadSeqRef.current + 1;
    loadSeqRef.current = sequence;
    const startedAt = nowMs();
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
            (await readEntry({ spacePath, path: currentDocument }));
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

  const handleChange = useCallback(
    (_: { value: Descendant[] }) => {
      const currentPath = currentPathRef.current;
      if (!editor || isLoadingRef.current || !currentPath) return;

      const hasContentChange = editor.operations.some(
        (op) => op.type !== "set_selection",
      );
      if (hasContentChange) {
        markUnsaved(currentPath);
        scheduleAutoSave();
      }
    },
    [editor, markUnsaved, scheduleAutoSave],
  );

  const deserializeToolbarMarkdown = useCallback(
    (text: string) =>
      editor ? deserializeEditorMarkdownInsertion(editor, text) : [],
    [editor],
  );

  return {
    currentDocument,
    currentDocumentSpaceId,
    deserializeToolbarMarkdown,
    documentLoading,
    handleChange,
    projectPath,
    spacePath,
  };
}
